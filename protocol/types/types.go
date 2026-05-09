// Package types defines shared data structures used across all TrustedCrypto
// protocol packages.
package types

import (
	"crypto/sha256"
	"encoding/hex"
	"math/big"
	"time"
)

// ─────────────────────────────────────────────────────────────────────────────
// Identity primitives
// ─────────────────────────────────────────────────────────────────────────────

// DID is a 32-byte Keccak-256 hash of the W3C-style DID string
// (e.g. "did:trc:0x...").  Stored as [32]byte to match the bytes32 Solidity
// type used in WalletCap and PoCRewards.
type DID [32]byte

func (d DID) Hex() string { return "0x" + hex.EncodeToString(d[:]) }
func (d DID) IsZero() bool {
	var zero DID
	return d == zero
}

// NewDID hashes a canonical DID string into its 32-byte representation.
func NewDID(didString string) DID {
	return sha256.Sum256([]byte(didString))
}

// ─────────────────────────────────────────────────────────────────────────────
// Block primitives
// ─────────────────────────────────────────────────────────────────────────────

// BlockHeader is stored by both full nodes and light (SPV) nodes.
// Light nodes store only headers; full nodes store headers + full body.
type BlockHeader struct {
	Height        uint64    // Block height (0 = genesis)
	Epoch         uint64    // Epoch this block belongs to (epoch = height / BlocksPerEpoch)
	Timestamp     time.Time // UTC block creation time
	PrevHash      Hash      // Previous block header hash
	TxRoot        Hash      // Merkle root of all transactions in this block
	StateRoot     Hash      // Merkle root of the current state trie
	ContribRoot   Hash      // Merkle root of contribution proofs included this block
	ValidatorSet  Hash      // Hash of the active validator DID set
	ProducerDID   DID       // DID of the block producer
	Signature     []byte    // BLS/ECDSA aggregate signature from 2/3 of validator set
	VoteCount     uint32    // Number of validator signatures included
}

// Hash is a 32-byte SHA-256 / Keccak-256 digest.
type Hash [32]byte

func (h Hash) Hex() string  { return "0x" + hex.EncodeToString(h[:]) }
func (h Hash) IsZero() bool { var z Hash; return h == z }

// BlockHeaderHash returns the canonical hash of a BlockHeader (double-SHA256).
func BlockHeaderHash(hdr *BlockHeader) Hash {
	data := encodeHeader(hdr)
	first := sha256.Sum256(data)
	return sha256.Sum256(first[:])
}

func encodeHeader(hdr *BlockHeader) []byte {
	var buf []byte
	// Height + Epoch
	buf = appendUint64(buf, hdr.Height)
	buf = appendUint64(buf, hdr.Epoch)
	// Timestamp as unix nanoseconds
	buf = appendInt64(buf, hdr.Timestamp.UnixNano())
	buf = append(buf, hdr.PrevHash[:]...)
	buf = append(buf, hdr.TxRoot[:]...)
	buf = append(buf, hdr.StateRoot[:]...)
	buf = append(buf, hdr.ContribRoot[:]...)
	buf = append(buf, hdr.ValidatorSet[:]...)
	buf = append(buf, hdr.ProducerDID[:]...)
	return buf
}

func appendUint64(b []byte, v uint64) []byte {
	return append(b, byte(v>>56), byte(v>>48), byte(v>>40), byte(v>>32),
		byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
}
func appendInt64(b []byte, v int64) []byte { return appendUint64(b, uint64(v)) }

// ─────────────────────────────────────────────────────────────────────────────
// Transaction primitives
// ─────────────────────────────────────────────────────────────────────────────

// TxType distinguishes on-chain operation categories.
type TxType uint8

const (
	TxTransfer      TxType = iota // Token transfer
	TxMint                        // Reserve minting event
	TxBurn                        // Redemption burn
	TxContribution                // PoC contribution record
	TxGovernance                  // Governance vote / proposal
	TxPledge                      // Producer pledge submission
	TxOracleData                  // Oracle price / attestation submission
)

// Transaction represents a single network transaction.
type Transaction struct {
	Type      TxType
	SenderDID DID
	Nonce     uint64
	Amount    *big.Int // nil for non-transfer types
	Payload   []byte   // type-specific encoded payload
	Signature []byte   // ECDSA/secp256k1 signature over the canonical hash
	Hash      Hash     // populated after signing; canonical tx hash
}

// ─────────────────────────────────────────────────────────────────────────────
// Contribution primitives (PoC)
// ─────────────────────────────────────────────────────────────────────────────

// ContributionType mirrors the Solidity enum in PoCRewards.sol
type ContributionType uint8

const (
	ContribNodeUptime           ContributionType = iota // 0
	ContribOracleData                                   // 1
	ContribGovernanceVote                               // 2
	ContribPhysicalVerification                         // 3
	ContribTransactionActivity                          // 4
)

// MaxDailyPoints is the per-type daily cap in raw points, matching the contract.
const MaxDailyPoints = 1000

// DailyTypeCaps maps each ContributionType to its maximum daily point award,
// matching the base-point schedule in the whitepaper Section 16.2.
var DailyTypeCaps = map[ContributionType]uint32{
	ContribNodeUptime:           100,
	ContribOracleData:           200,
	ContribGovernanceVote:       100,
	ContribPhysicalVerification: 500,
	ContribTransactionActivity:  100,
}

// ContributionProof is the off-chain record that light nodes build locally
// and submit to full nodes for on-chain recording.
type ContributionProof struct {
	DID        DID
	CType      ContributionType
	Points     uint32
	Timestamp  time.Time
	Nonce      uint64  // monotonic, per-DID — prevents replay
	ProofData  []byte  // type-specific evidence (GPS bytes, oracle hash, etc.)
	Signature  []byte  // signed by the contributor's key
	ProofHash  Hash    // sha256(ProofData) — stored on-chain
}

// ─────────────────────────────────────────────────────────────────────────────
// Epoch primitives
// ─────────────────────────────────────────────────────────────────────────────

const (
	BlocksPerEpoch  = 10800         // ~6 hours at 2 s/block
	EpochDuration   = 6 * time.Hour // nominal; actual is block-count based
	BlockTime       = 2 * time.Second
	MinValidatorSet = 300
)

// EpochInfo describes a completed or active consensus epoch.
type EpochInfo struct {
	EpochID       uint64
	StartHeight   uint64
	EndHeight     uint64
	StartTime     time.Time
	ValidatorDIDs []DID     // selected validators for this epoch
	TotalReward   *big.Int  // TRC-U pool to distribute
}

// ValidatorScore pairs a DID with its rolling contribution score for
// use in epoch reward distribution.
type ValidatorScore struct {
	DID   DID
	Score uint64
}

// ─────────────────────────────────────────────────────────────────────────────
// Oracle primitives
// ─────────────────────────────────────────────────────────────────────────────

// PriceReport is a single price submission from an oracle reporter.
type PriceReport struct {
	Asset     string    // e.g. "XAU/USD", "WHEAT_KG_USD"
	Price     *big.Int  // price in micro-units (18 decimals, same as token)
	Timestamp time.Time
	Reporter  DID
	Signature []byte
}

// AggregatedPrice is the final on-chain price after outlier rejection.
type AggregatedPrice struct {
	Asset       string
	MedianPrice *big.Int
	Reports     uint32 // number of reports included in median
	Timestamp   time.Time
	EpochID     uint64
}
