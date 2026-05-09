// Package consensus implements TrustedCrypto's Proof-of-Contribution (PoC)
// consensus engine.
//
// Key responsibilities:
//   - Maintain per-DID rolling contribution scores (30-day window)
//   - Apply weekly 10% score decay for dormant participants
//   - Select validator sets for each 6-hour epoch from the top-scored tier
//   - Distribute epoch TRC-U rewards proportionally by score
//   - Build and verify Merkle trees of contribution proofs
package consensus

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math/big"
	"sort"
	"sync"
	"time"

	"go.uber.org/zap"

	"github.com/trustedcrypto/protocol/types"
)

// ─────────────────────────────────────────────────────────────────────────────
// Constants matching PoCRewards.sol
// ─────────────────────────────────────────────────────────────────────────────

const (
	rollingWindowDays = 30
	weeklyDecayBps    = 1000 // 10 % per week
	typeCapBps        = 3000 // 30 % max from one type
	decayInterval     = 7 * 24 * time.Hour
)

// ─────────────────────────────────────────────────────────────────────────────
// Score store
// ─────────────────────────────────────────────────────────────────────────────

// scoreBucket holds the rolling state for a single DID.
type scoreBucket struct {
	rollingScore uint64
	typePoints   [5]uint64 // indexed by ContributionType
	dailyCounts  [5]uint64
	dailyResetAt time.Time
	lastDecayAt  time.Time
	usedProofs   map[types.Hash]struct{} // replay-protection
}

func newBucket() *scoreBucket {
	return &scoreBucket{
		lastDecayAt: time.Now().UTC(),
		usedProofs:  make(map[types.Hash]struct{}),
	}
}

// Engine is the PoC consensus engine.  It is safe for concurrent use.
type Engine struct {
	mu     sync.RWMutex
	scores map[types.DID]*scoreBucket

	// epoch state
	currentEpoch   uint64
	epochStartTime time.Time
	activeValidators []types.DID

	logger *zap.Logger
}

// NewEngine creates an Engine with an optional structured logger.
func NewEngine(logger *zap.Logger) *Engine {
	if logger == nil {
		logger, _ = zap.NewProduction()
	}
	return &Engine{
		scores: make(map[types.DID]*scoreBucket),
		logger: logger,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Contribution submission
// ─────────────────────────────────────────────────────────────────────────────

var (
	ErrReplayedProof   = errors.New("contribution proof already submitted")
	ErrDailyCapReached = errors.New("daily point cap reached for this contribution type")
	ErrZeroPoints      = errors.New("contribution points must be greater than zero")
	ErrUnknownType     = errors.New("unknown contribution type")
)

// SubmitContribution records a verified contribution proof for a DID.
// This mirrors the PoCRewards.submitContribution() on-chain function but runs
// locally in the validator node before the oracle submits to the chain.
func (e *Engine) SubmitContribution(proof *types.ContributionProof) error {
	if proof.Points == 0 {
		return ErrZeroPoints
	}
	ct := int(proof.CType)
	if ct > 4 {
		return ErrUnknownType
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	bucket := e.getOrCreateBucket(proof.DID)

	// Replay protection
	if _, exists := bucket.usedProofs[proof.ProofHash]; exists {
		return ErrReplayedProof
	}
	bucket.usedProofs[proof.ProofHash] = struct{}{}

	// Apply decay before recording new points
	e.applyDecay(bucket)

	// Reset daily counters if a new UTC day has started
	e.resetDailyIfNeeded(bucket)

	// Enforce daily per-type cap
	cap := uint64(types.DailyTypeCaps[proof.CType])
	if bucket.dailyCounts[ct]+uint64(proof.Points) > cap {
		return ErrDailyCapReached
	}

	bucket.dailyCounts[ct] += uint64(proof.Points)
	bucket.typePoints[ct] += uint64(proof.Points)
	bucket.rollingScore += uint64(proof.Points)

	// Enforce 30% type cap: if any type exceeds 30% of total score, trim it
	e.enforceTypeCap(bucket)

	e.logger.Debug("contribution recorded",
		zap.String("did", proof.DID.Hex()),
		zap.Uint8("type", uint8(proof.CType)),
		zap.Uint32("points", proof.Points),
		zap.Uint64("rolling", bucket.rollingScore),
	)
	return nil
}

// GetScore returns the current decay-adjusted rolling score for a DID.
func (e *Engine) GetScore(did types.DID) uint64 {
	e.mu.RLock()
	defer e.mu.RUnlock()

	bucket, ok := e.scores[did]
	if !ok {
		return 0
	}
	return e.computeDecayedScore(bucket)
}

// ─────────────────────────────────────────────────────────────────────────────
// Epoch management
// ─────────────────────────────────────────────────────────────────────────────

// BuildValidatorSet selects the validator set for the next epoch.
//
// Algorithm (whitepaper §16.2):
//  1. Collect all DIDs with score > 0.
//  2. Sort descending by score.
//  3. Identify the "top tier" (all DIDs within 20% of the highest score).
//  4. If top tier >= MinValidatorSet, randomly sample MinValidatorSet from it.
//     Otherwise, take as many top-tier nodes as available and fill from lower tiers.
//  5. No DID selected for the previous 3 consecutive epochs is eligible.
func (e *Engine) BuildValidatorSet(epochID uint64, bannedRecent []types.DID) ([]types.DID, error) {
	e.mu.RLock()
	scoredDIDs := make([]types.ValidatorScore, 0, len(e.scores))
	for did, bucket := range e.scores {
		s := e.computeDecayedScore(bucket)
		if s == 0 {
			continue
		}
		scoredDIDs = append(scoredDIDs, types.ValidatorScore{DID: did, Score: s})
	}
	e.mu.RUnlock()

	if len(scoredDIDs) == 0 {
		return nil, errors.New("no scored DIDs available for validator selection")
	}

	// Build banned set for fast lookup
	banned := make(map[types.DID]struct{}, len(bannedRecent))
	for _, d := range bannedRecent {
		banned[d] = struct{}{}
	}

	// Filter banned
	eligible := scoredDIDs[:0]
	for _, vs := range scoredDIDs {
		if _, ok := banned[vs.DID]; !ok {
			eligible = append(eligible, vs)
		}
	}

	// Sort descending by score
	sort.Slice(eligible, func(i, j int) bool {
		return eligible[i].Score > eligible[j].Score
	})

	// Top-tier: within 80% of the highest score
	topScore := eligible[0].Score
	threshold := topScore * 8 / 10
	var topTier []types.DID
	for _, vs := range eligible {
		if vs.Score >= threshold {
			topTier = append(topTier, vs.DID)
		}
	}

	target := types.MinValidatorSet
	var selected []types.DID
	if len(topTier) >= target {
		selected = randomSample(topTier, target)
	} else {
		selected = topTier
		remaining := target - len(selected)
		// Fill from lower tiers
		for _, vs := range eligible[len(topTier):] {
			if remaining == 0 {
				break
			}
			selected = append(selected, vs.DID)
			remaining--
		}
	}

	e.mu.Lock()
	e.currentEpoch = epochID
	e.epochStartTime = time.Now().UTC()
	e.activeValidators = selected
	e.mu.Unlock()

	e.logger.Info("validator set built",
		zap.Uint64("epoch", epochID),
		zap.Int("count", len(selected)),
		zap.Int("eligible", len(eligible)),
	)
	return selected, nil
}

// ComputeEpochRewards returns the distribution of TRC-U rewards for the given
// validator set.  rewardPool is in wei-equivalent units (18 decimal places).
func ComputeEpochRewards(validators []types.ValidatorScore, rewardPool *big.Int) map[types.DID]*big.Int {
	if len(validators) == 0 || rewardPool.Sign() == 0 {
		return nil
	}

	totalScore := new(big.Int)
	for _, vs := range validators {
		totalScore.Add(totalScore, new(big.Int).SetUint64(vs.Score))
	}
	if totalScore.Sign() == 0 {
		return nil
	}

	dist := make(map[types.DID]*big.Int, len(validators))
	distributed := new(big.Int)
	for i, vs := range validators {
		if vs.Score == 0 {
			continue
		}
		share := new(big.Int).Mul(rewardPool, new(big.Int).SetUint64(vs.Score))
		share.Div(share, totalScore)
		dist[vs.DID] = share
		distributed.Add(distributed, share)
		// Last validator gets any rounding remainder
		if i == len(validators)-1 {
			remainder := new(big.Int).Sub(rewardPool, distributed)
			if remainder.Sign() > 0 {
				share.Add(share, remainder)
			}
		}
	}
	return dist
}

// ─────────────────────────────────────────────────────────────────────────────
// Merkle tree for contribution proofs
// ─────────────────────────────────────────────────────────────────────────────

// BuildContribMerkleRoot computes the Merkle root of a list of contribution
// proof hashes.  Used to populate BlockHeader.ContribRoot.
func BuildContribMerkleRoot(proofHashes []types.Hash) types.Hash {
	if len(proofHashes) == 0 {
		return types.Hash{}
	}
	leaves := make([][]byte, len(proofHashes))
	for i, h := range proofHashes {
		leaves[i] = h[:]
	}
	return types.Hash(merkleRoot(leaves))
}

// MerkleProof returns the sibling hashes needed to prove that leafIndex is
// included in the tree whose leaves are proofHashes.
func MerkleProof(proofHashes []types.Hash, leafIndex int) ([]types.Hash, error) {
	if leafIndex < 0 || leafIndex >= len(proofHashes) {
		return nil, errors.New("leaf index out of range")
	}
	leaves := make([][]byte, len(proofHashes))
	for i, h := range proofHashes {
		leaves[i] = h[:]
	}
	rawProof := merkleProof(leaves, leafIndex)
	proof := make([]types.Hash, len(rawProof))
	for i, p := range rawProof {
		copy(proof[i][:], p)
	}
	return proof, nil
}

// VerifyMerkleProof verifies that leaf is part of the tree with the given root.
func VerifyMerkleProof(root types.Hash, leaf types.Hash, proof []types.Hash, index int) bool {
	current := leaf[:]
	for _, sibling := range proof {
		if index%2 == 0 {
			current = hashPair(current, sibling[:])
		} else {
			current = hashPair(sibling[:], current)
		}
		index /= 2
	}
	var result types.Hash
	copy(result[:], current)
	return result == root
}

// ─────────────────────────────────────────────────────────────────────────────
// Score decay
// ─────────────────────────────────────────────────────────────────────────────

// DecayAllScores triggers a weekly decay pass over all tracked DIDs.
// Call this once per week via a scheduled goroutine.
func (e *Engine) DecayAllScores() {
	e.mu.Lock()
	defer e.mu.Unlock()
	for _, bucket := range e.scores {
		e.applyDecay(bucket)
	}
}

// applyDecay reduces the rolling score by 10% for each full week elapsed
// since the last decay.  Must be called with the write lock held.
func (e *Engine) applyDecay(bucket *scoreBucket) {
	if bucket.rollingScore == 0 {
		return
	}
	now := time.Now().UTC()
	if bucket.lastDecayAt.IsZero() {
		bucket.lastDecayAt = now
		return
	}
	weeks := uint64(now.Sub(bucket.lastDecayAt) / decayInterval)
	if weeks == 0 {
		return
	}
	score := bucket.rollingScore
	for i := uint64(0); i < weeks && score > 0; i++ {
		// 10% decay: score = score * (10000 - 1000) / 10000
		score = score * (10000 - weeklyDecayBps) / 10000
	}
	bucket.rollingScore = score
	bucket.lastDecayAt = bucket.lastDecayAt.Add(time.Duration(weeks) * decayInterval)
}

func (e *Engine) computeDecayedScore(bucket *scoreBucket) uint64 {
	if bucket.rollingScore == 0 {
		return 0
	}
	now := time.Now().UTC()
	if bucket.lastDecayAt.IsZero() {
		return bucket.rollingScore
	}
	weeks := uint64(now.Sub(bucket.lastDecayAt) / decayInterval)
	if weeks == 0 {
		return bucket.rollingScore
	}
	score := bucket.rollingScore
	for i := uint64(0); i < weeks && score > 0; i++ {
		score = score * (10000 - weeklyDecayBps) / 10000
	}
	return score
}

// enforceTypeCap ensures no single type contributes more than 30% of total.
// If violated, excess points are removed from the offending type and the
// rolling total is adjusted.
func (e *Engine) enforceTypeCap(bucket *scoreBucket) {
	if bucket.rollingScore == 0 {
		return
	}
	maxForType := bucket.rollingScore * typeCapBps / 10000
	for i := range bucket.typePoints {
		if bucket.typePoints[i] > maxForType {
			excess := bucket.typePoints[i] - maxForType
			bucket.typePoints[i] = maxForType
			if bucket.rollingScore > excess {
				bucket.rollingScore -= excess
			} else {
				bucket.rollingScore = 0
			}
		}
	}
}

func (e *Engine) resetDailyIfNeeded(bucket *scoreBucket) {
	now := time.Now().UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	if bucket.dailyResetAt.Before(today) {
		bucket.dailyCounts = [5]uint64{}
		bucket.dailyResetAt = today
	}
}

func (e *Engine) getOrCreateBucket(did types.DID) *scoreBucket {
	if b, ok := e.scores[did]; ok {
		return b
	}
	b := newBucket()
	e.scores[did] = b
	return b
}

// ─────────────────────────────────────────────────────────────────────────────
// Block finality (BFT threshold check)
// ─────────────────────────────────────────────────────────────────────────────

// IsFinal returns true if voteCount constitutes a 2/3+1 supermajority of
// the active validator set (BFT finality rule).
func (e *Engine) IsFinal(voteCount uint32) bool {
	e.mu.RLock()
	total := uint32(len(e.activeValidators))
	e.mu.RUnlock()
	if total == 0 {
		return false
	}
	return voteCount*3 > total*2
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal Merkle helpers
// ─────────────────────────────────────────────────────────────────────────────

func hashPair(a, b []byte) []byte {
	h := sha256.New()
	h.Write(a)
	h.Write(b)
	return h.Sum(nil)
}

func merkleRoot(leaves [][]byte) []byte {
	if len(leaves) == 0 {
		return make([]byte, 32)
	}
	layer := make([][]byte, len(leaves))
	for i, l := range leaves {
		h := sha256.Sum256(l)
		layer[i] = h[:]
	}
	for len(layer) > 1 {
		if len(layer)%2 != 0 {
			layer = append(layer, layer[len(layer)-1]) // duplicate last
		}
		next := make([][]byte, len(layer)/2)
		for i := 0; i < len(layer); i += 2 {
			next[i/2] = hashPair(layer[i], layer[i+1])
		}
		layer = next
	}
	return layer[0]
}

func merkleProof(leaves [][]byte, index int) [][]byte {
	if len(leaves) == 1 {
		return nil
	}
	var proof [][]byte
	layer := make([][]byte, len(leaves))
	for i, l := range leaves {
		h := sha256.Sum256(l)
		layer[i] = h[:]
	}
	for len(layer) > 1 {
		if len(layer)%2 != 0 {
			layer = append(layer, layer[len(layer)-1])
		}
		sibling := index ^ 1
		if sibling < len(layer) {
			proof = append(proof, layer[sibling])
		}
		index /= 2
		next := make([][]byte, len(layer)/2)
		for i := 0; i < len(layer); i += 2 {
			next[i/2] = hashPair(layer[i], layer[i+1])
		}
		layer = next
	}
	return proof
}

// randomSample draws k distinct elements from slice s using crypto/rand.
func randomSample(s []types.DID, k int) []types.DID {
	if k >= len(s) {
		out := make([]types.DID, len(s))
		copy(out, s)
		return out
	}
	work := make([]types.DID, len(s))
	copy(work, s)
	for i := len(work) - 1; i > 0; i-- {
		j := cryptoRandInt(i + 1)
		work[i], work[j] = work[j], work[i]
	}
	return work[:k]
}

func cryptoRandInt(n int) int {
	if n <= 1 {
		return 0
	}
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		// Fallback: use timestamp-based seeding — acceptable only if rand.Read fails
		binary.LittleEndian.PutUint64(buf, uint64(time.Now().UnixNano()))
	}
	v := binary.LittleEndian.Uint64(buf)
	return int(v % uint64(n))
}
