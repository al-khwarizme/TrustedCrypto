// Package network implements the TrustedCrypto P2P layer.
//
// Full nodes maintain a complete peer mesh and serve the entire block chain.
// Light (SPV) nodes connect to a subset of full nodes and request only
// block headers and Merkle-proof verified transaction data.
//
// Protocol message types:
//   - HandshakeMsg  — version negotiation at connection open
//   - HeadersMsg    — block header chain (light-node sync)
//   - GetHeadersMsg — request headers from a peer by range
//   - MerkleProofMsg   — SPV proof for a single transaction
//   - GetMerkleProofMsg — request SPV proof from a full node
//   - ContribMsg    — broadcast a contribution proof
//   - OracleDataMsg — broadcast a price/attestation report
//   - PingMsg / PongMsg — keep-alive
package network

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"time"

	"github.com/trustedcrypto/protocol/types"
)

// ─────────────────────────────────────────────────────────────────────────────
// Protocol constants
// ─────────────────────────────────────────────────────────────────────────────

const (
	ProtocolVersion uint16 = 1
	MaxMessageSize         = 4 * 1024 * 1024 // 4 MiB per message
	HandshakeTimeout       = 10 * time.Second
	ReadTimeout            = 30 * time.Second
	WriteTimeout           = 30 * time.Second
	PingInterval           = 60 * time.Second
	MaxPeers               = 50
	LightMaxPeers          = 8  // light nodes connect to fewer full nodes
)

// MessageType identifies the kind of P2P message.
type MessageType uint8

const (
	MsgHandshake    MessageType = 0x01
	MsgGetHeaders   MessageType = 0x02
	MsgHeaders      MessageType = 0x03
	MsgGetMerkle    MessageType = 0x04
	MsgMerkleProof  MessageType = 0x05
	MsgContrib      MessageType = 0x06
	MsgOracleData   MessageType = 0x07
	MsgPing         MessageType = 0x08
	MsgPong         MessageType = 0x09
	MsgTx           MessageType = 0x0A
	MsgNewBlock     MessageType = 0x0B
)

// NodeType distinguishes full validators from light (SPV) nodes.
type NodeType uint8

const (
	NodeFull  NodeType = 0x01
	NodeLight NodeType = 0x02
)

// ─────────────────────────────────────────────────────────────────────────────
// Wire format
// ─────────────────────────────────────────────────────────────────────────────
// Each message is prefixed with a 6-byte header:
//   [0]   MessageType  (1 byte)
//   [1-4] Payload length (uint32 big-endian)
//   [5]   reserved (0x00)

const wireHeaderLen = 6

var (
	ErrMessageTooLarge = errors.New("message exceeds maximum size")
	ErrBadMagic        = errors.New("reserved byte must be 0x00")
	ErrShortRead       = errors.New("short read from peer")
)

// WriteMessage serialises a message type and payload to the writer.
func WriteMessage(w io.Writer, mtype MessageType, payload []byte) error {
	if len(payload) > MaxMessageSize {
		return ErrMessageTooLarge
	}
	hdr := make([]byte, wireHeaderLen)
	hdr[0] = byte(mtype)
	binary.BigEndian.PutUint32(hdr[1:5], uint32(len(payload)))
	hdr[5] = 0x00
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	if len(payload) > 0 {
		_, err := w.Write(payload)
		return err
	}
	return nil
}

// ReadMessage reads a framed message from the reader.
func ReadMessage(r io.Reader) (MessageType, []byte, error) {
	hdr := make([]byte, wireHeaderLen)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return 0, nil, err
	}
	if hdr[5] != 0x00 {
		return 0, nil, ErrBadMagic
	}
	mtype := MessageType(hdr[0])
	payLen := binary.BigEndian.Uint32(hdr[1:5])
	if payLen > MaxMessageSize {
		return 0, nil, ErrMessageTooLarge
	}
	if payLen == 0 {
		return mtype, nil, nil
	}
	payload := make([]byte, payLen)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, ErrShortRead
	}
	return mtype, payload, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// HandshakeMsg
// ─────────────────────────────────────────────────────────────────────────────

// HandshakeMsg is the first message sent after TCP connection is established.
type HandshakeMsg struct {
	Version    uint16
	NodeType   NodeType
	NodeDID    types.DID // zero for anonymous peers
	ChainID    uint32
	BestHeight uint64
	BestHash   types.Hash
	Nonce      uint64 // random nonce to prevent self-connections
}

func EncodeHandshake(m *HandshakeMsg) []byte {
	buf := new(bytes.Buffer)
	binary.Write(buf, binary.BigEndian, m.Version)
	buf.WriteByte(byte(m.NodeType))
	buf.Write(m.NodeDID[:])
	binary.Write(buf, binary.BigEndian, m.ChainID)
	binary.Write(buf, binary.BigEndian, m.BestHeight)
	buf.Write(m.BestHash[:])
	binary.Write(buf, binary.BigEndian, m.Nonce)
	return buf.Bytes()
}

func DecodeHandshake(data []byte) (*HandshakeMsg, error) {
	const minLen = 2 + 1 + 32 + 4 + 8 + 32 + 8
	if len(data) < minLen {
		return nil, ErrShortRead
	}
	m := &HandshakeMsg{}
	r := bytes.NewReader(data)
	binary.Read(r, binary.BigEndian, &m.Version)
	var nt byte
	binary.Read(r, binary.BigEndian, &nt)
	m.NodeType = NodeType(nt)
	r.Read(m.NodeDID[:])
	binary.Read(r, binary.BigEndian, &m.ChainID)
	binary.Read(r, binary.BigEndian, &m.BestHeight)
	r.Read(m.BestHash[:])
	binary.Read(r, binary.BigEndian, &m.Nonce)
	return m, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// GetHeadersMsg / HeadersMsg  (SPV header sync)
// ─────────────────────────────────────────────────────────────────────────────

// GetHeadersMsg asks a full node for headers in [FromHeight, ToHeight].
type GetHeadersMsg struct {
	FromHeight uint64
	ToHeight   uint64 // 0 = up to current tip
}

func EncodeGetHeaders(m *GetHeadersMsg) []byte {
	buf := make([]byte, 16)
	binary.BigEndian.PutUint64(buf[0:8], m.FromHeight)
	binary.BigEndian.PutUint64(buf[8:16], m.ToHeight)
	return buf
}

func DecodeGetHeaders(data []byte) (*GetHeadersMsg, error) {
	if len(data) < 16 {
		return nil, ErrShortRead
	}
	return &GetHeadersMsg{
		FromHeight: binary.BigEndian.Uint64(data[0:8]),
		ToHeight:   binary.BigEndian.Uint64(data[8:16]),
	}, nil
}

// EncodeHeaders serialises a slice of BlockHeaders for network transmission.
// Format: [count uint32] [ header ... ]
// Each header is a fixed-length struct: see decodeHeader below.
func EncodeHeaders(headers []*types.BlockHeader) []byte {
	buf := new(bytes.Buffer)
	binary.Write(buf, binary.BigEndian, uint32(len(headers)))
	for _, h := range headers {
		encodeHeaderBytes(buf, h)
	}
	return buf.Bytes()
}

func DecodeHeaders(data []byte) ([]*types.BlockHeader, error) {
	if len(data) < 4 {
		return nil, ErrShortRead
	}
	r := bytes.NewReader(data)
	var count uint32
	binary.Read(r, binary.BigEndian, &count)
	headers := make([]*types.BlockHeader, 0, count)
	for i := uint32(0); i < count; i++ {
		h, err := decodeHeaderBytes(r)
		if err != nil {
			return nil, err
		}
		headers = append(headers, h)
	}
	return headers, nil
}

// fixedHeaderSize: 8+8+8+32+32+32+32+32+32+4 = 220 bytes (without sig)
// Signature is length-prefixed.
func encodeHeaderBytes(buf *bytes.Buffer, h *types.BlockHeader) {
	binary.Write(buf, binary.BigEndian, h.Height)
	binary.Write(buf, binary.BigEndian, h.Epoch)
	binary.Write(buf, binary.BigEndian, uint64(h.Timestamp.Unix()))
	buf.Write(h.PrevHash[:])
	buf.Write(h.TxRoot[:])
	buf.Write(h.StateRoot[:])
	buf.Write(h.ContribRoot[:])
	buf.Write(h.ValidatorSet[:])
	buf.Write(h.ProducerDID[:])
	binary.Write(buf, binary.BigEndian, h.VoteCount)
	// Length-prefixed signature
	binary.Write(buf, binary.BigEndian, uint16(len(h.Signature)))
	buf.Write(h.Signature)
}

func decodeHeaderBytes(r *bytes.Reader) (*types.BlockHeader, error) {
	h := &types.BlockHeader{}
	var ts uint64
	binary.Read(r, binary.BigEndian, &h.Height)
	binary.Read(r, binary.BigEndian, &h.Epoch)
	binary.Read(r, binary.BigEndian, &ts)
	h.Timestamp = time.Unix(int64(ts), 0).UTC()
	r.Read(h.PrevHash[:])
	r.Read(h.TxRoot[:])
	r.Read(h.StateRoot[:])
	r.Read(h.ContribRoot[:])
	r.Read(h.ValidatorSet[:])
	r.Read(h.ProducerDID[:])
	binary.Read(r, binary.BigEndian, &h.VoteCount)
	var sigLen uint16
	binary.Read(r, binary.BigEndian, &sigLen)
	if sigLen > 0 {
		h.Signature = make([]byte, sigLen)
		r.Read(h.Signature)
	}
	return h, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// GetMerkleProofMsg / MerkleProofMsg  (SPV transaction verification)
// ─────────────────────────────────────────────────────────────────────────────

// GetMerkleProofMsg asks a full node for an SPV proof of a specific tx.
type GetMerkleProofMsg struct {
	BlockHeight uint64
	TxHash      types.Hash
}

func EncodeGetMerkleProof(m *GetMerkleProofMsg) []byte {
	buf := make([]byte, 8+32)
	binary.BigEndian.PutUint64(buf[0:8], m.BlockHeight)
	copy(buf[8:], m.TxHash[:])
	return buf
}

func DecodeGetMerkleProof(data []byte) (*GetMerkleProofMsg, error) {
	if len(data) < 40 {
		return nil, ErrShortRead
	}
	m := &GetMerkleProofMsg{}
	m.BlockHeight = binary.BigEndian.Uint64(data[0:8])
	copy(m.TxHash[:], data[8:40])
	return m, nil
}

// MerkleProofMsg carries the SPV proof back to the requesting light node.
type MerkleProofMsg struct {
	BlockHeight uint64
	TxHash      types.Hash
	TxRoot      types.Hash  // from the block header — light node can verify
	LeafIndex   uint32
	Proof       []types.Hash // sibling hashes, bottom-up
}

func EncodeMerkleProof(m *MerkleProofMsg) []byte {
	buf := new(bytes.Buffer)
	binary.Write(buf, binary.BigEndian, m.BlockHeight)
	buf.Write(m.TxHash[:])
	buf.Write(m.TxRoot[:])
	binary.Write(buf, binary.BigEndian, m.LeafIndex)
	binary.Write(buf, binary.BigEndian, uint32(len(m.Proof)))
	for _, p := range m.Proof {
		buf.Write(p[:])
	}
	return buf.Bytes()
}

func DecodeMerkleProof(data []byte) (*MerkleProofMsg, error) {
	if len(data) < 8+32+32+4+4 {
		return nil, ErrShortRead
	}
	r := bytes.NewReader(data)
	m := &MerkleProofMsg{}
	binary.Read(r, binary.BigEndian, &m.BlockHeight)
	r.Read(m.TxHash[:])
	r.Read(m.TxRoot[:])
	binary.Read(r, binary.BigEndian, &m.LeafIndex)
	var proofLen uint32
	binary.Read(r, binary.BigEndian, &proofLen)
	m.Proof = make([]types.Hash, proofLen)
	for i := range m.Proof {
		r.Read(m.Proof[i][:])
	}
	return m, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// ContribMsg — broadcast contribution proof from light node to full node
// ─────────────────────────────────────────────────────────────────────────────

func EncodeContrib(p *types.ContributionProof) []byte {
	buf := new(bytes.Buffer)
	buf.Write(p.DID[:])
	buf.WriteByte(byte(p.CType))
	binary.Write(buf, binary.BigEndian, p.Points)
	binary.Write(buf, binary.BigEndian, uint64(p.Timestamp.Unix()))
	binary.Write(buf, binary.BigEndian, p.Nonce)
	buf.Write(p.ProofHash[:])
	binary.Write(buf, binary.BigEndian, uint32(len(p.ProofData)))
	buf.Write(p.ProofData)
	binary.Write(buf, binary.BigEndian, uint16(len(p.Signature)))
	buf.Write(p.Signature)
	return buf.Bytes()
}

func DecodeContrib(data []byte) (*types.ContributionProof, error) {
	const minLen = 32 + 1 + 4 + 8 + 8 + 32 + 4 + 2
	if len(data) < minLen {
		return nil, ErrShortRead
	}
	r := bytes.NewReader(data)
	p := &types.ContributionProof{}
	r.Read(p.DID[:])
	var ct byte
	r.ReadByte()
	p.CType = types.ContributionType(ct)
	binary.Read(r, binary.BigEndian, &p.Points)
	var ts uint64
	binary.Read(r, binary.BigEndian, &ts)
	p.Timestamp = time.Unix(int64(ts), 0).UTC()
	binary.Read(r, binary.BigEndian, &p.Nonce)
	r.Read(p.ProofHash[:])
	var pdLen uint32
	binary.Read(r, binary.BigEndian, &pdLen)
	if pdLen > 0 {
		p.ProofData = make([]byte, pdLen)
		r.Read(p.ProofData)
	}
	var sigLen uint16
	binary.Read(r, binary.BigEndian, &sigLen)
	if sigLen > 0 {
		p.Signature = make([]byte, sigLen)
		r.Read(p.Signature)
	}
	return p, nil
}

// ─────────────────────────────────────────────────────────────────────────────
// OracleDataMsg — broadcast a price report
// ─────────────────────────────────────────────────────────────────────────────

func EncodeOracleData(r *types.PriceReport) []byte {
	buf := new(bytes.Buffer)
	assetBytes := []byte(r.Asset)
	binary.Write(buf, binary.BigEndian, uint8(len(assetBytes)))
	buf.Write(assetBytes)
	priceBytes := r.Price.Bytes()
	binary.Write(buf, binary.BigEndian, uint8(len(priceBytes)))
	buf.Write(priceBytes)
	binary.Write(buf, binary.BigEndian, uint64(r.Timestamp.Unix()))
	buf.Write(r.Reporter[:])
	binary.Write(buf, binary.BigEndian, uint16(len(r.Signature)))
	buf.Write(r.Signature)
	return buf.Bytes()
}
