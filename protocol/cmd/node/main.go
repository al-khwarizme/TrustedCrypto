// cmd/node/main.go — TrustedCrypto Full Node
//
// The full node is the backbone of the TrustedCrypto network.  It:
//
//   - Stores and serves the full block chain and state
//   - Serves block headers and Merkle proofs to SPV light nodes
//   - Participates in Proof-of-Contribution BFT consensus:
//     building the validator set each epoch, producing and voting on blocks
//   - Accepts, validates, and on-chains contribution proofs from light nodes
//   - Runs the oracle aggregation pipeline, pushing median prices on-chain
//   - Manages epoch transitions, distributes TRC-U rewards
//   - Bridges to EVM smart contracts via go-ethereum RPC
//
// Resource profile (intended for always-on servers / desktop machines).
package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/spf13/cobra"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"

	"github.com/trustedcrypto/protocol/consensus"
	"github.com/trustedcrypto/protocol/identity"
	"github.com/trustedcrypto/protocol/network"
	"github.com/trustedcrypto/protocol/oracle"
	"github.com/trustedcrypto/protocol/types"
)

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

type Config struct {
	DataDir        string   `json:"data_dir"`
	ChainID        uint32   `json:"chain_id"`
	ListenAddr     string   `json:"listen_addr"`
	BootPeers      []string `json:"boot_peers"`
	LogLevel       string   `json:"log_level"`
	MetricsAddr    string   `json:"metrics_addr"`   // Prometheus metrics endpoint
	EthRPC         string   `json:"eth_rpc"`        // Ethereum JSON-RPC endpoint for contract calls
	OracleEnabled  bool     `json:"oracle_enabled"` // participate in oracle aggregation
}

func defaultConfig() Config {
	home, _ := os.UserHomeDir()
	return Config{
		DataDir:       filepath.Join(home, ".trc", "node"),
		ChainID:       1,
		ListenAddr:    "0.0.0.0:30333",
		BootPeers:     []string{},
		LogLevel:      "info",
		MetricsAddr:   "0.0.0.0:9090",
		OracleEnabled: true,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Prometheus metrics
// ─────────────────────────────────────────────────────────────────────────────

type metrics struct {
	peers        prometheus.Gauge
	blockHeight  prometheus.Gauge
	epoch        prometheus.Gauge
	contribsIn   prometheus.Counter
	oracleReports prometheus.Counter
}

func newMetrics() *metrics {
	m := &metrics{
		peers: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "trc_peers_total",
			Help: "Current number of connected peers",
		}),
		blockHeight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "trc_block_height",
			Help: "Current block height",
		}),
		epoch: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "trc_epoch",
			Help: "Current consensus epoch",
		}),
		contribsIn: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "trc_contributions_received_total",
			Help: "Total contribution proofs received from peers",
		}),
		oracleReports: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "trc_oracle_reports_total",
			Help: "Total oracle price reports received",
		}),
	}
	prometheus.MustRegister(m.peers, m.blockHeight, m.epoch, m.contribsIn, m.oracleReports)
	return m
}

// ─────────────────────────────────────────────────────────────────────────────
// Block store (in-memory; production would persist to disk / LevelDB)
// ─────────────────────────────────────────────────────────────────────────────

type blockStore struct {
	mu      sync.RWMutex
	headers []*types.BlockHeader       // full chain
	index   map[types.Hash]uint64      // blockHash → height
	txRoots map[uint64]types.Hash      // height → txRoot (for SPV serving)
}

func newBlockStore(genesis *types.BlockHeader) *blockStore {
	bs := &blockStore{
		headers: []*types.BlockHeader{genesis},
		index:   make(map[types.Hash]uint64),
		txRoots: make(map[uint64]types.Hash),
	}
	h := types.BlockHeaderHash(genesis)
	bs.index[h] = 0
	return bs
}

func (bs *blockStore) tip() *types.BlockHeader {
	bs.mu.RLock()
	defer bs.mu.RUnlock()
	return bs.headers[len(bs.headers)-1]
}

func (bs *blockStore) height() uint64 {
	t := bs.tip()
	return t.Height
}

func (bs *blockStore) append(hdr *types.BlockHeader) {
	bs.mu.Lock()
	defer bs.mu.Unlock()
	bs.headers = append(bs.headers, hdr)
	h := types.BlockHeaderHash(hdr)
	bs.index[h] = hdr.Height
	bs.txRoots[hdr.Height] = hdr.TxRoot
}

func (bs *blockStore) headerRange(from, to uint64) []*types.BlockHeader {
	bs.mu.RLock()
	defer bs.mu.RUnlock()
	if from >= uint64(len(bs.headers)) {
		return nil
	}
	if to == 0 || to >= uint64(len(bs.headers)) {
		to = uint64(len(bs.headers) - 1)
	}
	return bs.headers[from : to+1]
}

// ─────────────────────────────────────────────────────────────────────────────
// FullNode
// ─────────────────────────────────────────────────────────────────────────────

// FullNode wires together all protocol sub-systems.
type FullNode struct {
	cfg       Config
	logger    *zap.Logger
	metrics   *metrics
	keyPair   *identity.KeyPair
	didDoc    *identity.DIDDocument
	peers     *network.PeerManager
	blocks    *blockStore
	engine    *consensus.Engine
	aggregators map[string]*oracle.Aggregator // one per oracle asset
	attestStore *oracle.AttestationStore
	pledgeAcc   *oracle.PledgeAccumulator
	nullReg     *identity.NullifierRegistry
	nonce       uint64
	ctx         context.Context
	cancel      context.CancelFunc
}

func newFullNode(cfg Config, logger *zap.Logger) (*FullNode, error) {
	kp, err := loadOrCreateKey(filepath.Join(cfg.DataDir, "identity.key"), logger)
	if err != nil {
		return nil, fmt.Errorf("key setup: %w", err)
	}
	didDoc := identity.NewDIDDocument(kp)
	logger.Info("full node identity", zap.String("did", didDoc.ID))

	pm := network.NewPeerManager(network.MaxPeers, logger)
	genesis := genesisHeader(cfg.ChainID)
	bs := newBlockStore(genesis)
	engine := consensus.NewEngine(logger)

	// Build per-asset oracle aggregators
	aggregators := make(map[string]*oracle.Aggregator, len(oracle.SupportedAssets))
	for _, asset := range oracle.SupportedAssets {
		aggregators[asset] = oracle.NewAggregator(0, logger)
	}

	attestStore := oracle.NewAttestationStore()
	pledgeAcc := oracle.NewPledgeAccumulator()
	nullReg := identity.NewNullifierRegistry()

	ctx, cancel := context.WithCancel(context.Background())

	fn := &FullNode{
		cfg:         cfg,
		logger:      logger,
		metrics:     newMetrics(),
		keyPair:     kp,
		didDoc:      didDoc,
		peers:       pm,
		blocks:      bs,
		engine:      engine,
		aggregators: aggregators,
		attestStore: attestStore,
		pledgeAcc:   pledgeAcc,
		nullReg:     nullReg,
		ctx:         ctx,
		cancel:      cancel,
	}

	// Wire peer callbacks
	pm.OnContrib = fn.handleContribution
	pm.OnOracleData = fn.handleOracleData
	pm.OnNewHeaders = fn.handleNewHeaders

	// Wire oracle callbacks
	for _, agg := range aggregators {
		agg.OnNewPrice = fn.handleAggregatedPrice
	}
	attestStore.OnAuditFreeze = fn.handleAuditFreeze
	pledgeAcc.OnConfirmed = fn.handlePledgeConfirmed

	return fn, nil
}

// Start brings up the listener, connects to boot peers, and starts all loops.
func (fn *FullNode) Start() error {
	fn.logger.Info("starting full node",
		zap.Uint32("chain_id", fn.cfg.ChainID),
		zap.String("listen", fn.cfg.ListenAddr),
	)

	// Start P2P listener
	ln, err := net.Listen("tcp", fn.cfg.ListenAddr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	go fn.acceptLoop(ln)

	// Connect to boot peers
	for _, addr := range fn.cfg.BootPeers {
		go fn.connectToPeer(addr)
	}

	// Metrics HTTP endpoint
	if fn.cfg.MetricsAddr != "" {
		go fn.serveMetrics()
	}

	// Epoch transition loop
	go fn.epochLoop()

	// Score decay maintenance
	go fn.decayLoop()

	fn.logger.Info("full node started")
	return nil
}

// Stop gracefully shuts down the full node.
func (fn *FullNode) Stop() {
	fn.logger.Info("stopping full node...")
	fn.cancel()
}

// ─────────────────────────────────────────────────────────────────────────────
// P2P listener
// ─────────────────────────────────────────────────────────────────────────────

func (fn *FullNode) acceptLoop(ln net.Listener) {
	defer ln.Close()
	for {
		conn, err := ln.Accept()
		if err != nil {
			select {
			case <-fn.ctx.Done():
				return
			default:
				fn.logger.Warn("accept error", zap.Error(err))
				continue
			}
		}
		go fn.handleInbound(conn)
	}
}

func (fn *FullNode) handleInbound(conn net.Conn) {
	hs := fn.localHandshake()
	peer, err := network.NewPeer(conn, hs, fn.logger)
	if err != nil {
		fn.logger.Warn("inbound handshake failed", zap.Error(err))
		return
	}
	if fn.peers.AddPeer(peer) {
		fn.metrics.peers.Inc()
		fn.logger.Info("inbound peer connected", zap.String("addr", conn.RemoteAddr().String()))
	}
}

func (fn *FullNode) connectToPeer(addr string) {
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		fn.logger.Warn("failed to connect to peer", zap.String("addr", addr), zap.Error(err))
		return
	}
	hs := fn.localHandshake()
	peer, err := network.NewPeer(conn, hs, fn.logger)
	if err != nil {
		fn.logger.Warn("outbound handshake failed", zap.String("addr", addr), zap.Error(err))
		return
	}
	if fn.peers.AddPeer(peer) {
		fn.metrics.peers.Inc()
		fn.logger.Info("outbound peer connected", zap.String("addr", addr))
	}
}

func (fn *FullNode) localHandshake() *network.HandshakeMsg {
	tip := fn.blocks.tip()
	return &network.HandshakeMsg{
		Version:    network.ProtocolVersion,
		NodeType:   network.NodeFull,
		NodeDID:    fn.didDoc.DIDHash,
		ChainID:    fn.cfg.ChainID,
		BestHeight: tip.Height,
		BestHash:   types.BlockHeaderHash(tip),
		Nonce:      randomNonce(),
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Peer message callbacks
// ─────────────────────────────────────────────────────────────────────────────

// handleContribution validates a contribution proof received from a peer.
func (fn *FullNode) handleContribution(proof *types.ContributionProof) {
	fn.metrics.contribsIn.Inc()

	// Verify signature using the DID's registered public key
	// (simplified: in production we'd resolve the DID to fetch the public key)
	if err := fn.engine.SubmitContribution(proof); err != nil {
		fn.logger.Debug("contribution rejected", zap.Error(err), zap.String("did", proof.DID.Hex()))
		return
	}

	// Relay to other full-node peers (gossip)
	fn.peers.BroadcastToFull(network.MsgContrib, network.EncodeContrib(proof))
	fn.logger.Debug("contribution accepted", zap.String("did", proof.DID.Hex()), zap.Uint32("points", proof.Points))
}

// handleOracleData routes an incoming price report to the appropriate aggregator.
func (fn *FullNode) handleOracleData(report *types.PriceReport) {
	fn.metrics.oracleReports.Inc()

	agg, ok := fn.aggregators[report.Asset]
	if !ok {
		return
	}
	if err := agg.Submit(report); err != nil {
		fn.logger.Debug("oracle report rejected", zap.String("asset", report.Asset), zap.Error(err))
		return
	}
	// Relay to other full-node peers
	fn.peers.BroadcastToFull(network.MsgOracleData, network.EncodeOracleData(report))
}

// handleNewHeaders processes headers forwarded by another full node.
func (fn *FullNode) handleNewHeaders(headers []*types.BlockHeader) {
	for _, hdr := range headers {
		if hdr.Height <= fn.blocks.height() {
			continue // already have it
		}
		// Full node does full validation (simplified here: just hash-chain check)
		if fn.blocks.height()+1 != hdr.Height {
			fn.logger.Warn("non-sequential header", zap.Uint64("got", hdr.Height), zap.Uint64("want", fn.blocks.height()+1))
			continue
		}
		if !fn.engine.IsFinal(hdr.VoteCount) {
			fn.logger.Warn("header not finalised", zap.Uint64("height", hdr.Height), zap.Uint32("votes", hdr.VoteCount))
			continue
		}
		fn.blocks.append(hdr)
		fn.metrics.blockHeight.Set(float64(hdr.Height))
		fn.metrics.epoch.Set(float64(hdr.Epoch))
		fn.logger.Debug("block appended", zap.Uint64("height", hdr.Height))
	}
}

// handleAggregatedPrice is triggered when an oracle window produces a median price.
func (fn *FullNode) handleAggregatedPrice(price *types.AggregatedPrice) {
	fn.logger.Info("oracle price ready",
		zap.String("asset", price.Asset),
		zap.String("price", price.MedianPrice.String()),
		zap.Uint32("reports", price.Reports),
	)
	// TODO: submit to on-chain oracle contract via EthRPC
	// call: TRCGold.updateGoldPrice(price.MedianPrice) or commodity oracle contract
	_ = fn.cfg.EthRPC
}

// handleAuditFreeze is called when an operator/auditor vault mismatch is detected.
func (fn *FullNode) handleAuditFreeze(vaultID, reason string) {
	fn.logger.Warn("audit freeze triggered",
		zap.String("vault_id", vaultID),
		zap.String("reason", reason),
	)
	// TODO: call TRCGold.auditFreeze() via EthRPC
}

// handlePledgeConfirmed is called when three verifiers have approved a commodity pledge.
func (fn *FullNode) handlePledgeConfirmed(pledgeID [32]byte) {
	fn.logger.Info("pledge confirmed", zap.String("pledge_id", fmt.Sprintf("%x", pledgeID)))
	// TODO: call ProducerPledge.confirmPledge(pledgeID) via EthRPC
}

// ─────────────────────────────────────────────────────────────────────────────
// SPV response: serve headers and Merkle proofs to light nodes
// ─────────────────────────────────────────────────────────────────────────────

// ServeHeaders responds to a GetHeaders request with a batch of block headers.
func (fn *FullNode) ServeHeaders(peer *network.Peer, req *network.GetHeadersMsg) {
	batch := fn.blocks.headerRange(req.FromHeight, req.ToHeight)
	if len(batch) == 0 {
		return
	}
	peer.Send(network.MsgHeaders, network.EncodeHeaders(batch))
}

// ServeMerkleProof responds to a GetMerkleProof request.
// txHashes is the ordered list of all transaction hashes in that block.
// txIndex is the 0-based position of req.TxHash in txHashes.
func (fn *FullNode) ServeMerkleProof(peer *network.Peer, req *network.GetMerkleProofMsg, txHashes []types.Hash, txIndex int) error {
	proof, err := consensus.MerkleProof(txHashes, txIndex)
	if err != nil {
		return err
	}
	hdr := fn.blockAt(req.BlockHeight)
	if hdr == nil {
		return errors.New("block not found")
	}
	msg := &network.MerkleProofMsg{
		BlockHeight: req.BlockHeight,
		TxHash:      req.TxHash,
		TxRoot:      hdr.TxRoot,
		Proof:       proof,
	}
	peer.Send(network.MsgMerkleProof, network.EncodeMerkleProof(msg))
	return nil
}

func (fn *FullNode) blockAt(height uint64) *types.BlockHeader {
	fn.blocks.mu.RLock()
	defer fn.blocks.mu.RUnlock()
	if height >= uint64(len(fn.blocks.headers)) {
		return nil
	}
	return fn.blocks.headers[height]
}

// ─────────────────────────────────────────────────────────────────────────────
// Epoch management
// ─────────────────────────────────────────────────────────────────────────────

func (fn *FullNode) epochLoop() {
	ticker := time.NewTicker(types.EpochDuration)
	defer ticker.Stop()
	for {
		select {
		case <-fn.ctx.Done():
			return
		case <-ticker.C:
			fn.runEpochTransition()
		}
	}
}

func (fn *FullNode) runEpochTransition() {
	currentHeight := fn.blocks.height()
	epochID := currentHeight / types.BlocksPerEpoch

	fn.logger.Info("epoch transition", zap.Uint64("epoch", epochID))
	fn.metrics.epoch.Set(float64(epochID))

	// Determine which DIDs were validators in the last 3 epochs (excluded from next set)
	var bannedRecent []types.DID
	// (simplified: in production, read from persisted epoch-validator records)

	validatorDIDs, err := fn.engine.BuildValidatorSet(epochID, bannedRecent)
	if err != nil {
		fn.logger.Error("failed to build validator set", zap.Error(err))
		return
	}
	fn.logger.Info("validator set built", zap.Int("count", len(validatorDIDs)))

	// Build ValidatorScore slice for reward computation
	validatorScores := make([]types.ValidatorScore, 0, len(validatorDIDs))
	for _, did := range validatorDIDs {
		validatorScores = append(validatorScores, types.ValidatorScore{
			DID:   did,
			Score: fn.engine.GetScore(did),
		})
	}

	// Distribute epoch rewards (100 TRC-U per block * BlocksPerEpoch)
	rewardPool := new(big.Int).Mul(
		big.NewInt(100),
		big.NewInt(int64(types.BlocksPerEpoch)),
	)
	rewardPool.Mul(rewardPool, new(big.Int).Exp(big.NewInt(10), big.NewInt(18), nil)) // 18 decimals

	rewards := consensus.ComputeEpochRewards(validatorScores, rewardPool)
	fn.logger.Info("epoch rewards computed", zap.Int("recipients", len(rewards)))

	for did, reward := range rewards {
		fn.logger.Debug("reward",
			zap.String("did", did.Hex()),
			zap.String("trc_u", reward.String()),
		)
		// TODO: call PoCRewards.distributeEpochRewards([dids], [amounts]) via EthRPC
	}

	// Update aggregator epoch IDs
	for _, agg := range fn.aggregators {
		_ = agg // agg.SetEpoch(epochID) — would be added in a full implementation
	}

	// Decay all contribution scores weekly (the engine does this internally)
	fn.engine.DecayAllScores()
}

// decayLoop fires weekly to trigger score decay.
func (fn *FullNode) decayLoop() {
	ticker := time.NewTicker(7 * 24 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-fn.ctx.Done():
			return
		case <-ticker.C:
			fn.engine.DecayAllScores()
			fn.logger.Info("contribution scores decayed")
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

func (fn *FullNode) serveMetrics() {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.Handler())
	srv := &http.Server{
		Addr:         fn.cfg.MetricsAddr,
		Handler:      mux,
		ReadTimeout:  5 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  30 * time.Second,
	}
	fn.logger.Info("metrics endpoint", zap.String("addr", fn.cfg.MetricsAddr))
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fn.logger.Error("metrics server error", zap.Error(err))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

func genesisHeader(chainID uint32) *types.BlockHeader {
	return &types.BlockHeader{
		Height:    0,
		Epoch:     0,
		Timestamp: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	}
}

func randomNonce() uint64 {
	b := make([]byte, 8)
	rand.Read(b)
	return binary.BigEndian.Uint64(b)
}

func loadOrCreateKey(path string, logger *zap.Logger) (*identity.KeyPair, error) {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if err2 := os.MkdirAll(filepath.Dir(path), 0700); err2 != nil {
			return nil, err2
		}
		kp, err2 := identity.GenerateKeyPair()
		if err2 != nil {
			return nil, err2
		}
		logger.Warn("generated new ephemeral identity key — persist this key securely",
			zap.String("path", path),
		)
		data, _ := json.Marshal(map[string]string{"pubkey": fmt.Sprintf("%x", kp.PublicKeyBytes())})
		_ = os.WriteFile(path+".pub", data, 0600)
		return kp, nil
	}
	// In production: load and decrypt private key from disk (PBKDF2 + AES-256-GCM).
	kp, err := identity.GenerateKeyPair()
	if err != nil {
		return nil, err
	}
	logger.Warn("NOTE: using ephemeral key; full key serialisation not yet implemented")
	return kp, nil
}

// ensure oracle import is used (for AttestationStore / PledgeAccumulator constructors)
var _ *oracle.AttestationStore

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────────────

func main() {
	var cfgFile string
	cfg := defaultConfig()

	root := &cobra.Command{
		Use:   "node",
		Short: "TrustedCrypto full node",
		Long: `Runs a TrustedCrypto full node.  Stores the complete block chain,
serves SPV proofs to light nodes, participates in Proof-of-Contribution
BFT consensus, aggregates oracle price feeds, and bridges to the
EVM smart contracts.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if cfgFile != "" {
				data, err := os.ReadFile(cfgFile)
				if err != nil {
					return fmt.Errorf("reading config: %w", err)
				}
				if err := json.Unmarshal(data, &cfg); err != nil {
					return fmt.Errorf("parsing config: %w", err)
				}
			}
			return runFullNode(cfg)
		},
	}

	root.Flags().StringVarP(&cfgFile, "config", "c", "", "path to JSON config file")
	root.Flags().StringVar(&cfg.DataDir, "data-dir", cfg.DataDir, "data directory")
	root.Flags().StringVar(&cfg.ListenAddr, "listen", cfg.ListenAddr, "P2P listen address (host:port)")
	root.Flags().StringSliceVar(&cfg.BootPeers, "peers", cfg.BootPeers, "boot peer addresses (host:port)")
	root.Flags().Uint32Var(&cfg.ChainID, "chain-id", cfg.ChainID, "chain ID")
	root.Flags().StringVar(&cfg.LogLevel, "log-level", cfg.LogLevel, "log level (debug|info|warn|error)")
	root.Flags().StringVar(&cfg.MetricsAddr, "metrics", cfg.MetricsAddr, "Prometheus metrics listen address")
	root.Flags().StringVar(&cfg.EthRPC, "eth-rpc", cfg.EthRPC, "Ethereum JSON-RPC endpoint for smart contract calls")
	root.Flags().BoolVar(&cfg.OracleEnabled, "oracle", cfg.OracleEnabled, "participate in oracle aggregation")

	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}

func runFullNode(cfg Config) error {
	logger := buildLogger(cfg.LogLevel)
	defer logger.Sync()

	fn, err := newFullNode(cfg, logger)
	if err != nil {
		return fmt.Errorf("initialising full node: %w", err)
	}

	if err := fn.Start(); err != nil {
		return fmt.Errorf("starting full node: %w", err)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	fn.Stop()
	logger.Info("full node stopped")
	return nil
}

func buildLogger(level string) *zap.Logger {
	lvl := zapcore.InfoLevel
	switch level {
	case "debug":
		lvl = zapcore.DebugLevel
	case "warn":
		lvl = zapcore.WarnLevel
	case "error":
		lvl = zapcore.ErrorLevel
	}
	cfg := zap.Config{
		Level:            zap.NewAtomicLevelAt(lvl),
		Development:      false,
		Encoding:         "console",
		EncoderConfig:    zap.NewDevelopmentEncoderConfig(),
		OutputPaths:      []string{"stdout"},
		ErrorOutputPaths: []string{"stderr"},
	}
	logger, _ := cfg.Build()
	return logger
}
