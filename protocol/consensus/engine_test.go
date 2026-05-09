package consensus_test

import (
	"crypto/sha256"
	"encoding/binary"
	"math/big"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/trustedcrypto/protocol/consensus"
	"github.com/trustedcrypto/protocol/types"
)

func newEngine() *consensus.Engine {
	logger, _ := zap.NewDevelopment()
	return consensus.NewEngine(logger)
}

func makeProof(did types.DID, ct types.ContributionType, pts uint32, nonce uint64) *types.ContributionProof {
	// Derive a unique ProofHash from nonce so replay protection doesn't reject
	// different proofs that have empty ProofData.
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], nonce)
	proofHash := sha256.Sum256(buf[:])
	return &types.ContributionProof{
		DID:       did,
		CType:     ct,
		Points:    pts,
		Timestamp: time.Now().UTC(),
		Nonce:     nonce,
		ProofHash: proofHash,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// SubmitContribution
// ─────────────────────────────────────────────────────────────────────────────

// submitBalanced submits one proof per contribution type so no type exceeds
// the 30% rolling cap and the score is predictable.
func submitBalanced(t *testing.T, e *consensus.Engine, did types.DID, pts uint32, nonceBase uint64) {
	t.Helper()
	types_ := []types.ContributionType{
		types.ContribNodeUptime,
		types.ContribOracleData,
		types.ContribGovernanceVote,
		types.ContribPhysicalVerification,
		types.ContribTransactionActivity,
	}
	for i, ct := range types_ {
		p := makeProof(did, ct, pts, nonceBase+uint64(i))
		if err := e.SubmitContribution(p); err != nil {
			t.Fatalf("SubmitContribution type %d: %v", ct, err)
		}
	}
}

func TestSubmitContribution_Basic(t *testing.T) {
	e := newEngine()
	did := types.NewDID("did:trc:0xabc1")

	submitBalanced(t, e, did, 10, 1)
	if score := e.GetScore(did); score == 0 {
		t.Fatal("expected non-zero score after balanced contributions")
	}
}

func TestSubmitContribution_ZeroPoints(t *testing.T) {
	e := newEngine()
	did := types.NewDID("did:trc:0xabc2")
	proof := makeProof(did, types.ContribNodeUptime, 0, 1)
	if err := e.SubmitContribution(proof); err == nil {
		t.Fatal("expected error for zero-points contribution")
	}
}

func TestSubmitContribution_ReplayRejected(t *testing.T) {
	e := newEngine()
	did := types.NewDID("did:trc:0xabc3")
	proof := makeProof(did, types.ContribNodeUptime, 10, 2)

	if err := e.SubmitContribution(proof); err != nil {
		t.Fatalf("first submission: %v", err)
	}
	// Resubmit the exact same proof (same ProofHash after first submission sets it)
	if err := e.SubmitContribution(proof); err == nil {
		t.Fatal("expected replay rejection on second identical proof")
	}
}

func TestSubmitContribution_MultipleDIDs(t *testing.T) {
	e := newEngine()
	d1 := types.NewDID("did:trc:0xd1")
	d2 := types.NewDID("did:trc:0xd2")

	submitBalanced(t, e, d1, 10, 10) // 50 total
	submitBalanced(t, e, d2, 5, 20)  // 25 total

	s1 := e.GetScore(d1)
	s2 := e.GetScore(d2)
	if s1 == 0 {
		t.Fatal("d1: expected non-zero score")
	}
	if s2 == 0 {
		t.Fatal("d2: expected non-zero score")
	}
	if s1 <= s2 {
		t.Fatalf("d1 (higher input) should have higher score than d2: %d vs %d", s1, s2)
	}
}

func TestSubmitContribution_UnknownType(t *testing.T) {
	e := newEngine()
	did := types.NewDID("did:trc:0xunk")
	proof := &types.ContributionProof{
		DID:       did,
		CType:     types.ContributionType(99),
		Points:    1,
		Timestamp: time.Now().UTC(),
		Nonce:     1,
	}
	if err := e.SubmitContribution(proof); err == nil {
		t.Fatal("expected error for unknown contribution type")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// GetScore
// ─────────────────────────────────────────────────────────────────────────────

func TestGetScore_UnknownDID(t *testing.T) {
	e := newEngine()
	did := types.NewDID("did:trc:0xnobody")
	if s := e.GetScore(did); s != 0 {
		t.Fatalf("unknown DID should have score 0, got %d", s)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// BuildValidatorSet
// ─────────────────────────────────────────────────────────────────────────────

func TestBuildValidatorSet_NoEligible(t *testing.T) {
	e := newEngine()
	// No DIDs registered — engine should error (no scored DIDs)
	_, err := e.BuildValidatorSet(1, nil)
	if err == nil {
		t.Fatal("expected error when no validators are registered")
	}
}

func TestBuildValidatorSet_ReturnsBestAvailable(t *testing.T) {
	e := newEngine()
	// Register 5 DIDs (fewer than MinValidatorSet=300); engine returns all available
	for i := 0; i < 5; i++ {
		did := types.NewDID("did:trc:0xval" + string(rune('0'+i)))
		submitBalanced(t, e, did, 10, uint64(i*10+1))
	}
	set, err := e.BuildValidatorSet(1, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(set) == 0 {
		t.Fatal("expected at least one validator")
	}
	if len(set) > 5 {
		t.Fatalf("cannot return more validators than registered: got %d", len(set))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Merkle proof
// ─────────────────────────────────────────────────────────────────────────────

func hashOf(s string) types.Hash { return types.Hash(types.NewDID(s)) }

func TestMerkleProof_ValidInclusion(t *testing.T) {
	leaves := []types.Hash{
		hashOf("leaf-0"),
		hashOf("leaf-1"),
		hashOf("leaf-2"),
		hashOf("leaf-3"),
	}
	proof, err := consensus.MerkleProof(leaves, 2)
	if err != nil {
		t.Fatalf("MerkleProof: %v", err)
	}
	if len(proof) == 0 {
		t.Fatal("expected non-empty merkle proof for leaf at index 2")
	}
}

func TestMerkleProof_SingleLeaf(t *testing.T) {
	leaves := []types.Hash{hashOf("only-leaf")}
	proof, err := consensus.MerkleProof(leaves, 0)
	if err != nil {
		t.Fatalf("MerkleProof: %v", err)
	}
	// Single-leaf tree — proof is empty (root = leaf)
	_ = proof
}

// ─────────────────────────────────────────────────────────────────────────────
// ComputeEpochRewards
// ─────────────────────────────────────────────────────────────────────────────

func TestComputeEpochRewards_ProportionalDistribution(t *testing.T) {
	v1 := types.NewDID("v1")
	v2 := types.NewDID("v2")
	validators := []types.ValidatorScore{
		{DID: v1, Score: 100},
		{DID: v2, Score: 100},
	}
	pool := big.NewInt(200)
	rewards := consensus.ComputeEpochRewards(validators, pool)

	if len(rewards) != 2 {
		t.Fatalf("expected 2 reward entries, got %d", len(rewards))
	}
	// Equal scores → equal rewards
	r1, r2 := rewards[v1], rewards[v2]
	if r1 == nil || r2 == nil {
		t.Fatal("nil reward for a validator")
	}
	if r1.Cmp(r2) != 0 {
		t.Fatalf("equal scores must yield equal rewards: %v vs %v", r1, r2)
	}
	// Total rewards must not exceed pool
	total := new(big.Int)
	for _, r := range rewards {
		total.Add(total, r)
	}
	if total.Cmp(pool) > 0 {
		t.Fatalf("total rewards %v exceed pool %v", total, pool)
	}
}

func TestComputeEpochRewards_EmptyValidators(t *testing.T) {
	rewards := consensus.ComputeEpochRewards(nil, big.NewInt(1000))
	if len(rewards) != 0 {
		t.Fatalf("expected empty rewards for nil validators, got %d", len(rewards))
	}
}

