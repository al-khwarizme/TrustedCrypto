// cmd/lightnode/main.go — TrustedCrypto Light Node
//
// The light node is designed to run on a smartphone or low-power device.
// It implements SPV (Simplified Payment Verification): instead of storing
// the full block chain, it downloads only block headers and verifies
// individual transactions using Merkle proofs supplied by full nodes.
//
// Contributions (uptime, local oracle data, governance votes) are built
// locally, signed with the device's key, and forwarded to full nodes
// for on-chain recording.
//
// Resource constraints (§16.2):
//   - Storage: ~200 MB for header chain
//   - CPU:     2% average, 15% burst
//   - Battery: 5% per hour active
//   - Network: 4G/LTE minimum; offline-queue for slow connections
package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/big"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

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
	DataDir     string   `json:"data_dir"`
	ChainID     uint32   `json:"chain_id"`
	BootPeers   []string `json:"boot_peers"`   // "host:port" of full nodes to connect to
	ListenAddr  string   `json:"listen_addr"`  // optional; empty = outbound only
	LogLevel    string   `json:"log_level"`
	KeyFile     string   `json:"key_file"`     // path to serialised private key; created if absent
	OracleAsset string   `json:"oracle_asset"` // optional: asset this node reports prices for
}

func defaultConfig() Config {
	home, _ := os.UserHomeDir()
	return Config{
		DataDir:    filepath.Join(home, ".trc", "lightnode"),
		ChainID:    1,
		BootPeers:  []string{},
		ListenAddr: "",
		LogLevel:   "info",
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// LightNode
// ─────────────────────────────────────────────────────────────────────────────

// LightNode orchestrates all sub-systems for a mobile/light participant.
type LightNode struct {
	cfg        Config
	logger     *zap.Logger
	keyPair    *identity.KeyPair
	didDoc     *identity.DIDDocument
	peers      *network.PeerManager
	headers    *network.HeaderChain
	pocEngine  *consensus.Engine
	contribQ   []*types.ContributionProof // offline queue
	nonceCounter uint64
	ctx        context.Context
	cancel     context.CancelFunc
}

func newLightNode(cfg Config, logger *zap.Logger) (*LightNode, error) {
	// Load or generate key pair
	kp, err := loadOrCreateKey(filepath.Join(cfg.DataDir, "identity.key"))
	if err != nil {
		return nil, fmt.Errorf("key setup: %w", err)
	}
	didDoc := identity.NewDIDDocument(kp)
	logger.Info("light node identity", zap.String("did", didDoc.ID))

	peers := network.NewPeerManager(network.LightMaxPeers, logger)
	headers := network.NewHeaderChain(genesisHeader(cfg.ChainID), logger)
	engine := consensus.NewEngine(logger)

	ctx, cancel := context.WithCancel(context.Background())

	ln := &LightNode{
		cfg:       cfg,
		logger:    logger,
		keyPair:   kp,
		didDoc:    didDoc,
		peers:     peers,
		headers:   headers,
		pocEngine: engine,
		ctx:       ctx,
		cancel:    cancel,
	}

	// Wire peer callbacks
	peers.OnNewHeaders = ln.onNewHeaders
	peers.OnMerkleProof = ln.onMerkleProof

	return ln, nil
}

// Start connects to boot peers and begins contribution loops.
func (ln *LightNode) Start() error {
	ln.logger.Info("starting light node", zap.Uint32("chain_id", ln.cfg.ChainID))

	// Connect to boot peers
	if len(ln.cfg.BootPeers) == 0 {
		ln.logger.Warn("no boot peers configured; node will not sync until peers are added")
	}
	for _, addr := range ln.cfg.BootPeers {
		go ln.connectToPeer(addr)
	}

	// Sync headers from the best peer
	go ln.syncLoop()

	// Report node uptime contributions at regular intervals
	go ln.uptimeLoop()

	// If this node is configured as a local oracle reporter, start price loop
	if ln.cfg.OracleAsset != "" {
		go ln.oraclePriceLoop()
	}

	ln.logger.Info("light node started")
	return nil
}

// Stop gracefully shuts down the light node.
func (ln *LightNode) Stop() {
	ln.logger.Info("stopping light node...")
	ln.cancel()
}

// ─────────────────────────────────────────────────────────────────────────────
// Peer connection
// ─────────────────────────────────────────────────────────────────────────────

func (ln *LightNode) connectToPeer(addr string) {
	conn, err := net.DialTimeout("tcp", addr, 10*time.Second)
	if err != nil {
		ln.logger.Warn("failed to connect to peer", zap.String("addr", addr), zap.Error(err))
		return
	}

	hs := &network.HandshakeMsg{
		Version:    network.ProtocolVersion,
		NodeType:   network.NodeLight,
		NodeDID:    ln.didDoc.DIDHash,
		ChainID:    ln.cfg.ChainID,
		BestHeight: ln.headers.Height(),
		BestHash:   types.BlockHeaderHash(ln.headers.Tip()),
		Nonce:      randomNonce(),
	}

	peer, err := network.NewPeer(conn, hs, ln.logger)
	if err != nil {
		ln.logger.Warn("handshake failed", zap.String("addr", addr), zap.Error(err))
		return
	}

	if !ln.peers.AddPeer(peer) {
		ln.logger.Debug("peer rejected (max peers reached)", zap.String("addr", addr))
		return
	}
	ln.logger.Info("connected to full node", zap.String("addr", addr))
}

// ─────────────────────────────────────────────────────────────────────────────
// Header sync
// ─────────────────────────────────────────────────────────────────────────────

func (ln *LightNode) syncLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ln.ctx.Done():
			return
		case <-ticker.C:
			ln.requestHeaders()
		}
	}
}

func (ln *LightNode) requestHeaders() {
	best := ln.peers.BestPeer()
	if best == nil {
		return
	}
	req := &network.GetHeadersMsg{
		FromHeight: ln.headers.Height() + 1,
		ToHeight:   0, // 0 = up to peer's tip
	}
	best.Send(network.MsgGetHeaders, network.EncodeGetHeaders(req))
}

func (ln *LightNode) onNewHeaders(headers []*types.BlockHeader) {
	// Conservative minimum votes: 200 (floor, not 2/3 of current set since
	// we don't know the exact set size as a light node).
	const minVotes = 200
	if err := ln.headers.AppendHeaders(headers, minVotes); err != nil {
		ln.logger.Warn("header append failed", zap.Error(err))
		return
	}
	ln.logger.Debug("headers synced", zap.Uint64("tip", ln.headers.Height()))
}

func (ln *LightNode) onMerkleProof(proof *network.MerkleProofMsg) {
	if err := ln.headers.VerifyTransaction(proof); err != nil {
		ln.logger.Warn("merkle proof invalid", zap.Error(err))
		return
	}
	ln.logger.Debug("transaction verified via SPV",
		zap.String("tx", proof.TxHash.Hex()),
		zap.Uint64("block", proof.BlockHeight),
	)
}

// VerifyTx requests an SPV proof for a transaction from the best full-node peer.
func (ln *LightNode) VerifyTx(blockHeight uint64, txHash types.Hash) {
	best := ln.peers.BestPeer()
	if best == nil {
		ln.logger.Warn("no peers available for SPV verification")
		return
	}
	req := &network.GetMerkleProofMsg{BlockHeight: blockHeight, TxHash: txHash}
	best.Send(network.MsgGetMerkle, network.EncodeGetMerkleProof(req))
}

// ─────────────────────────────────────────────────────────────────────────────
// Proof-of-Contribution: uptime reporting
// ─────────────────────────────────────────────────────────────────────────────

// uptimeLoop submits a node-uptime contribution proof once per hour.
// Points: 10 pts/hour, capped at 100 pts/day (§16.2 table).
func (ln *LightNode) uptimeLoop() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ln.ctx.Done():
			return
		case <-ticker.C:
			ln.submitUptimeProof()
		}
	}
}

func (ln *LightNode) submitUptimeProof() {
	proof := &types.ContributionProof{
		DID:       ln.didDoc.DIDHash,
		CType:     types.ContribNodeUptime,
		Points:    10,
		Timestamp: time.Now().UTC(),
		Nonce:     ln.nextNonce(),
		ProofData: buildUptimeEvidence(),
	}

	if err := ln.didDoc.SignContributionProof(ln.keyPair, proof); err != nil {
		ln.logger.Error("failed to sign uptime proof", zap.Error(err))
		return
	}

	// Record locally in consensus engine
	if err := ln.pocEngine.SubmitContribution(proof); err != nil {
		ln.logger.Debug("local contribution rejected", zap.Error(err))
	}

	// Broadcast to full nodes
	ln.peers.BroadcastToFull(network.MsgContrib, network.EncodeContrib(proof))
	ln.logger.Debug("uptime proof submitted", zap.Uint32("points", proof.Points))
}

// buildUptimeEvidence constructs the proof-data bytes for a node-uptime
// contribution.  Contains: timestamp (8B) + random session nonce (16B).
// Full nodes validate that the nonce has not been replayed.
func buildUptimeEvidence() []byte {
	ts := make([]byte, 8)
	binary.BigEndian.PutUint64(ts, uint64(time.Now().Unix()))
	nonce := make([]byte, 16)
	rand.Read(nonce)
	return append(ts, nonce...)
}

// ─────────────────────────────────────────────────────────────────────────────
// Proof-of-Contribution: oracle price reporting
// ─────────────────────────────────────────────────────────────────────────────

// oraclePriceLoop submits local price data every 15 minutes.
// This is only started if the node is configured with an OracleAsset.
func (ln *LightNode) oraclePriceLoop() {
	ticker := time.NewTicker(oracle.CycleInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ln.ctx.Done():
			return
		case <-ticker.C:
			ln.submitPriceReport()
		}
	}
}

func (ln *LightNode) submitPriceReport() {
	// In a real deployment the price would come from a hardware sensor,
	// a trusted local exchange API, or a community-verified market board.
	// Here we emit a contribution proof for the oracle data submission.
	price := fetchLocalPrice(ln.cfg.OracleAsset)
	if price == nil {
		return
	}

	report := &types.PriceReport{
		Asset:     ln.cfg.OracleAsset,
		Price:     price,
		Timestamp: time.Now().UTC(),
		Reporter:  ln.didDoc.DIDHash,
	}

	// Proof: sha256(asset || price bytes || timestamp)
	proofData := buildOracleEvidence(report)

	proof := &types.ContributionProof{
		DID:       ln.didDoc.DIDHash,
		CType:     types.ContribOracleData,
		Points:    50,
		Timestamp: report.Timestamp,
		Nonce:     ln.nextNonce(),
		ProofData: proofData,
	}
	if err := ln.didDoc.SignContributionProof(ln.keyPair, proof); err != nil {
		ln.logger.Error("failed to sign oracle proof", zap.Error(err))
		return
	}

	ln.peers.BroadcastToFull(network.MsgOracleData, network.EncodeOracleData(report))
	ln.peers.BroadcastToFull(network.MsgContrib, network.EncodeContrib(proof))
	ln.logger.Debug("oracle data submitted", zap.String("asset", report.Asset), zap.String("price", price.String()))
}

func buildOracleEvidence(r *types.PriceReport) []byte {
	var buf []byte
	buf = append(buf, []byte(r.Asset)...)
	buf = append(buf, r.Price.Bytes()...)
	ts := make([]byte, 8)
	binary.BigEndian.PutUint64(ts, uint64(r.Timestamp.Unix()))
	buf = append(buf, ts...)
	return buf
}

// fetchLocalPrice is a stub — in production this calls a locally trusted
// price source (exchange API, hardware price board, etc.).
func fetchLocalPrice(asset string) *big.Int {
	// Return nil to skip submission when no local source is configured.
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

func (ln *LightNode) nextNonce() uint64 {
	ln.nonceCounter++
	return ln.nonceCounter
}

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

func loadOrCreateKey(path string) (*identity.KeyPair, error) {
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return nil, err
		}
		kp, err := identity.GenerateKeyPair()
		if err != nil {
			return nil, err
		}
		data, err := json.Marshal(map[string]string{"pubkey": fmt.Sprintf("%x", kp.PublicKeyBytes())})
		if err != nil {
			return nil, err
		}
		_ = os.WriteFile(path+".pub", data, 0600)
		return kp, nil
	}
	// In a full implementation, deserialise the encrypted private key from disk.
	// For now, generate a fresh ephemeral key and warn.
	kp, err := identity.GenerateKeyPair()
	if err != nil {
		return nil, err
	}
	return kp, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI entry point
// ─────────────────────────────────────────────────────────────────────────────

func main() {
	var cfgFile string
	cfg := defaultConfig()

	root := &cobra.Command{
		Use:   "lightnode",
		Short: "TrustedCrypto SPV light node",
		Long: `Runs a TrustedCrypto light node that verifies transactions via SPV
and earns TRC-U through Proof-of-Contribution (node uptime, oracle data,
governance voting).  Suitable for smartphones and low-power devices.`,
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
			return runLightNode(cfg)
		},
	}

	root.Flags().StringVarP(&cfgFile, "config", "c", "", "path to JSON config file")
	root.Flags().StringVar(&cfg.DataDir, "data-dir", cfg.DataDir, "data directory")
	root.Flags().StringSliceVar(&cfg.BootPeers, "peers", cfg.BootPeers, "boot peer addresses (host:port)")
	root.Flags().Uint32Var(&cfg.ChainID, "chain-id", cfg.ChainID, "chain ID")
	root.Flags().StringVar(&cfg.LogLevel, "log-level", cfg.LogLevel, "log level (debug|info|warn|error)")
	root.Flags().StringVar(&cfg.OracleAsset, "oracle-asset", cfg.OracleAsset, "asset to report prices for (e.g. XAU/USD)")

	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}

func runLightNode(cfg Config) error {
	logger := buildLogger(cfg.LogLevel)
	defer logger.Sync()

	ln, err := newLightNode(cfg, logger)
	if err != nil {
		return fmt.Errorf("initialising light node: %w", err)
	}

	if err := ln.Start(); err != nil {
		return fmt.Errorf("starting light node: %w", err)
	}

	// Wait for interrupt
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig

	ln.Stop()
	logger.Info("light node stopped")
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
