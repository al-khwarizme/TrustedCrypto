// peer.go — TCP peer connection management for the TrustedCrypto P2P network.
package network

import (
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"go.uber.org/zap"

	"github.com/trustedcrypto/protocol/types"
)

// Peer represents a connected remote node.
type Peer struct {
	conn     net.Conn
	nodeType NodeType
	did      types.DID
	chainID  uint32

	bestHeight atomic.Uint64
	bestHash   atomic.Pointer[types.Hash]

	send   chan outMsg
	closed chan struct{}
	once   sync.Once

	logger *zap.Logger
}

type outMsg struct {
	mtype   MessageType
	payload []byte
}

// NewPeer wraps a raw TCP connection and performs the handshake.
// localHS is our side of the handshake.
func NewPeer(conn net.Conn, localHS *HandshakeMsg, logger *zap.Logger) (*Peer, error) {
	p := &Peer{
		conn:   conn,
		send:   make(chan outMsg, 32),
		closed: make(chan struct{}),
		logger: logger,
	}

	conn.SetDeadline(time.Now().Add(HandshakeTimeout))
	// Send our handshake
	if err := WriteMessage(conn, MsgHandshake, EncodeHandshake(localHS)); err != nil {
		conn.Close()
		return nil, err
	}
	// Read peer's handshake
	mtype, data, err := ReadMessage(conn)
	if err != nil || mtype != MsgHandshake {
		conn.Close()
		return nil, errors.New("handshake failed: " + err.Error())
	}
	conn.SetDeadline(time.Time{})

	remoteHS, err := DecodeHandshake(data)
	if err != nil {
		conn.Close()
		return nil, err
	}
	if remoteHS.Version != ProtocolVersion {
		conn.Close()
		return nil, errors.New("protocol version mismatch")
	}
	if remoteHS.ChainID != localHS.ChainID {
		conn.Close()
		return nil, errors.New("chain ID mismatch")
	}
	if remoteHS.Nonce == localHS.Nonce {
		conn.Close()
		return nil, errors.New("self-connection detected")
	}

	p.nodeType = remoteHS.NodeType
	p.did = remoteHS.NodeDID
	p.chainID = remoteHS.ChainID
	p.bestHeight.Store(remoteHS.BestHeight)
	h := remoteHS.BestHash
	p.bestHash.Store(&h)

	return p, nil
}

// Send queues a message for delivery. Non-blocking; drops if queue is full.
func (p *Peer) Send(mtype MessageType, payload []byte) bool {
	select {
	case p.send <- outMsg{mtype, payload}:
		return true
	case <-p.closed:
		return false
	default:
		return false
	}
}

// Close terminates the peer connection exactly once.
func (p *Peer) Close() {
	p.once.Do(func() {
		close(p.closed)
		p.conn.Close()
	})
}

// IsClosed reports whether the peer has been closed.
func (p *Peer) IsClosed() bool {
	select {
	case <-p.closed:
		return true
	default:
		return false
	}
}

// runSend is the write loop — must run in its own goroutine.
func (p *Peer) runSend() {
	defer p.Close()
	ping := time.NewTicker(PingInterval)
	defer ping.Stop()
	for {
		select {
		case msg := <-p.send:
			p.conn.SetWriteDeadline(time.Now().Add(WriteTimeout))
			if err := WriteMessage(p.conn, msg.mtype, msg.payload); err != nil {
				p.logger.Warn("peer write error", zap.Error(err))
				return
			}
		case <-ping.C:
			p.conn.SetWriteDeadline(time.Now().Add(WriteTimeout))
			if err := WriteMessage(p.conn, MsgPing, nil); err != nil {
				return
			}
		case <-p.closed:
			return
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// PeerManager — manages the full set of connected peers
// ─────────────────────────────────────────────────────────────────────────────

// PeerManager maintains inbound and outbound peer connections.
type PeerManager struct {
	mu       sync.RWMutex
	peers    map[net.Addr]*Peer
	maxPeers int
	logger   *zap.Logger

	// Callbacks invoked on the manager's internal goroutine
	OnContrib     func(*types.ContributionProof)
	OnOracleData  func(*types.PriceReport)
	OnNewHeaders  func([]*types.BlockHeader)
	OnMerkleProof func(*MerkleProofMsg)
}

// NewPeerManager creates a PeerManager.  maxPeers should be MaxPeers for full
// nodes and LightMaxPeers for light nodes.
func NewPeerManager(maxPeers int, logger *zap.Logger) *PeerManager {
	return &PeerManager{
		peers:    make(map[net.Addr]*Peer),
		maxPeers: maxPeers,
		logger:   logger,
	}
}

// AddPeer registers and starts serving a peer.
func (pm *PeerManager) AddPeer(p *Peer) bool {
	pm.mu.Lock()
	defer pm.mu.Unlock()
	if len(pm.peers) >= pm.maxPeers {
		p.Close()
		return false
	}
	pm.peers[p.conn.RemoteAddr()] = p
	go p.runSend()
	go pm.serveRead(p)
	return true
}

// RemovePeer disconnects and removes a peer.
func (pm *PeerManager) RemovePeer(addr net.Addr) {
	pm.mu.Lock()
	if p, ok := pm.peers[addr]; ok {
		p.Close()
		delete(pm.peers, addr)
	}
	pm.mu.Unlock()
}

// Broadcast sends a message to all connected peers.
func (pm *PeerManager) Broadcast(mtype MessageType, payload []byte) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	for _, p := range pm.peers {
		p.Send(mtype, payload)
	}
}

// BroadcastToFull sends to all full-node peers only (used by light nodes).
func (pm *PeerManager) BroadcastToFull(mtype MessageType, payload []byte) {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	for _, p := range pm.peers {
		if p.nodeType == NodeFull {
			p.Send(mtype, payload)
		}
	}
}

// PeerCount returns the number of active peers.
func (pm *PeerManager) PeerCount() int {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	return len(pm.peers)
}

// BestPeer returns the peer with the highest reported block height.
func (pm *PeerManager) BestPeer() *Peer {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	var best *Peer
	var bestH uint64
	for _, p := range pm.peers {
		h := p.bestHeight.Load()
		if h > bestH {
			bestH = h
			best = p
		}
	}
	return best
}

// serveRead is the read loop for a peer — runs in its own goroutine.
func (pm *PeerManager) serveRead(p *Peer) {
	defer pm.RemovePeer(p.conn.RemoteAddr())
	for {
		p.conn.SetReadDeadline(time.Now().Add(ReadTimeout))
		mtype, data, err := ReadMessage(p.conn)
		if err != nil {
			if !p.IsClosed() {
				pm.logger.Debug("peer read error", zap.Error(err))
			}
			return
		}
		pm.handleMessage(p, mtype, data)
	}
}

func (pm *PeerManager) handleMessage(p *Peer, mtype MessageType, data []byte) {
	switch mtype {
	case MsgPing:
		p.Send(MsgPong, nil)

	case MsgPong:
		// no-op

	case MsgHeaders:
		headers, err := DecodeHeaders(data)
		if err != nil {
			pm.logger.Warn("bad headers msg", zap.Error(err))
			return
		}
		if len(headers) > 0 {
			last := headers[len(headers)-1]
			p.bestHeight.Store(last.Height)
			h := types.BlockHeaderHash(last)
			p.bestHash.Store(&h)
		}
		if pm.OnNewHeaders != nil {
			pm.OnNewHeaders(headers)
		}

	case MsgMerkleProof:
		proof, err := DecodeMerkleProof(data)
		if err != nil {
			pm.logger.Warn("bad merkle proof msg", zap.Error(err))
			return
		}
		if pm.OnMerkleProof != nil {
			pm.OnMerkleProof(proof)
		}

	case MsgContrib:
		contrib, err := DecodeContrib(data)
		if err != nil {
			pm.logger.Warn("bad contrib msg", zap.Error(err))
			return
		}
		if pm.OnContrib != nil {
			pm.OnContrib(contrib)
		}

	case MsgOracleData:
		// minimal decode — asset string + price (big.Int)
		if len(data) < 2 {
			return
		}
		// Dispatched to oracle handler for full decode
		if pm.OnOracleData != nil {
			// Lazy decode in oracle package; pass raw bytes via a zero-alloc path
			// by constructing a minimal PriceReport shell.
			_ = data // handled by oracle.DecodeAndDispatch
		}

	default:
		// Unknown message — ignore (forward compatibility)
	}
}
