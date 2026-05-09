// spv.go — Simplified Payment Verification (SPV) header chain for light nodes.
//
// A light node does not store full blocks.  It downloads and validates only
// block headers, then uses Merkle proofs supplied by full nodes to verify
// individual transactions.
package network

import (
	"crypto/sha256"
	"errors"
	"sync"

	"go.uber.org/zap"

	"github.com/trustedcrypto/protocol/types"
)

var (
	ErrHeaderChainEmpty    = errors.New("header chain is empty")
	ErrDisconnectedChain   = errors.New("header does not connect to known chain tip")
	ErrInvalidVoteCount    = errors.New("header has insufficient validator signatures")
	ErrInvalidMerkleProof  = errors.New("merkle proof verification failed")
	ErrStaleHeader         = errors.New("header height is not greater than current tip")
)

// HeaderChain is the in-memory header chain stored by SPV (light) nodes.
// It keeps all headers in memory; a production implementation would persist
// to a local key-value store (e.g. LevelDB) and keep only a sliding window
// in RAM.
type HeaderChain struct {
	mu      sync.RWMutex
	headers []*types.BlockHeader  // index 0 = genesis
	index   map[types.Hash]uint64 // hash → height
	logger  *zap.Logger
}

// NewHeaderChain creates an empty header chain.
func NewHeaderChain(genesis *types.BlockHeader, logger *zap.Logger) *HeaderChain {
	hc := &HeaderChain{
		headers: make([]*types.BlockHeader, 0, 1024),
		index:   make(map[types.Hash]uint64),
		logger:  logger,
	}
	if genesis != nil {
		h := types.BlockHeaderHash(genesis)
		hc.headers = append(hc.headers, genesis)
		hc.index[h] = 0
	}
	return hc
}

// Tip returns the highest block header in the chain.
func (hc *HeaderChain) Tip() *types.BlockHeader {
	hc.mu.RLock()
	defer hc.mu.RUnlock()
	if len(hc.headers) == 0 {
		return nil
	}
	return hc.headers[len(hc.headers)-1]
}

// Height returns the current chain height (number of headers - 1).
func (hc *HeaderChain) Height() uint64 {
	hc.mu.RLock()
	defer hc.mu.RUnlock()
	if len(hc.headers) == 0 {
		return 0
	}
	return hc.headers[len(hc.headers)-1].Height
}

// GetByHeight returns the header at a specific height, or nil.
func (hc *HeaderChain) GetByHeight(h uint64) *types.BlockHeader {
	hc.mu.RLock()
	defer hc.mu.RUnlock()
	if h < uint64(len(hc.headers)) {
		return hc.headers[h]
	}
	return nil
}

// GetByHash returns the header with the given hash, or nil.
func (hc *HeaderChain) GetByHash(h types.Hash) *types.BlockHeader {
	hc.mu.RLock()
	defer hc.mu.RUnlock()
	if height, ok := hc.index[h]; ok {
		return hc.headers[height]
	}
	return nil
}

// AppendHeaders validates and appends a batch of headers received from a full
// node.  Headers must arrive in ascending height order and each must connect
// to the previous header hash.
//
// minVotes is the minimum number of validator signatures required to accept a
// header (typically 2/3 of the active validator set, but the light node uses a
// conservative floor value configured at startup).
func (hc *HeaderChain) AppendHeaders(batch []*types.BlockHeader, minVotes uint32) error {
	if len(batch) == 0 {
		return nil
	}

	hc.mu.Lock()
	defer hc.mu.Unlock()

	tipHash := types.Hash{}
	var tipHeight uint64
	if len(hc.headers) > 0 {
		tip := hc.headers[len(hc.headers)-1]
		tipHash = types.BlockHeaderHash(tip)
		tipHeight = tip.Height
	}

	for _, hdr := range batch {
		if hdr.Height <= tipHeight && len(hc.headers) > 0 {
			return ErrStaleHeader
		}
		// Connectivity check — genesis exempt
		if len(hc.headers) > 0 && hdr.PrevHash != tipHash {
			return ErrDisconnectedChain
		}
		// Vote threshold check
		if hdr.VoteCount < minVotes {
			return ErrInvalidVoteCount
		}

		h := types.BlockHeaderHash(hdr)
		hc.headers = append(hc.headers, hdr)
		hc.index[h] = hdr.Height
		tipHash = h
		tipHeight = hdr.Height
	}

	hc.logger.Debug("headers appended",
		zap.Uint64("from", batch[0].Height),
		zap.Uint64("to", batch[len(batch)-1].Height),
		zap.Int("count", len(batch)),
	)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// SPV transaction verification
// ─────────────────────────────────────────────────────────────────────────────

// VerifyTransaction uses an SPV Merkle proof to confirm a transaction is
// included in a known block without downloading the full block.
//
// The light node:
//  1. Looks up the block header at blockHeight in its local header chain.
//  2. Uses the header's TxRoot as the Merkle tree root.
//  3. Walks the provided proof from the leaf (txHash) to the root.
//  4. Confirms the computed root matches TxRoot.
func (hc *HeaderChain) VerifyTransaction(proof *MerkleProofMsg) error {
	hdr := hc.GetByHeight(proof.BlockHeight)
	if hdr == nil {
		return ErrHeaderChainEmpty
	}

	// The proof's TxRoot should match what we have in our header chain
	if hdr.TxRoot != proof.TxRoot {
		return ErrInvalidMerkleProof
	}

	// Walk the Merkle proof
	current := proof.TxHash
	index := int(proof.LeafIndex)
	for _, sibling := range proof.Proof {
		if index%2 == 0 {
			current = sha256Pair(current, sibling)
		} else {
			current = sha256Pair(sibling, current)
		}
		index /= 2
	}

	if current != proof.TxRoot {
		return ErrInvalidMerkleProof
	}
	return nil
}

// sha256Pair hashes two 32-byte values together into a types.Hash.
func sha256Pair(a, b types.Hash) types.Hash {
	var combined [64]byte
	copy(combined[:32], a[:])
	copy(combined[32:], b[:])
	return sha256.Sum256(combined[:])
}
