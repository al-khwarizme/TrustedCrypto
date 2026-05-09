package oracle_test

import (
	"math/big"
	"testing"
	"time"

	"go.uber.org/zap"

	"github.com/trustedcrypto/protocol/oracle"
	"github.com/trustedcrypto/protocol/types"
)

func newLogger() *zap.Logger {
	l, _ := zap.NewDevelopment()
	return l
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregator
// ─────────────────────────────────────────────────────────────────────────────

func TestAggregator_Submit_ValidReport(t *testing.T) {
	agg := oracle.NewAggregator(1, newLogger())
	report := &types.PriceReport{
		Asset:    oracle.AssetGoldUSD,
		Price:    big.NewInt(192300_000000), // 1923.00 with 6 decimals
		Reporter: types.NewDID("did:trc:0xoracle1"),
		Timestamp: time.Now().UTC(),
	}
	if err := agg.Submit(report); err != nil {
		t.Fatalf("Submit: %v", err)
	}
}

func TestAggregator_Submit_InvalidPrice(t *testing.T) {
	agg := oracle.NewAggregator(1, newLogger())
	report := &types.PriceReport{
		Asset:    oracle.AssetGoldUSD,
		Price:    big.NewInt(0),
		Reporter: types.NewDID("did:trc:0xoracle2"),
		Timestamp: time.Now().UTC(),
	}
	if err := agg.Submit(report); err == nil {
		t.Fatal("expected error for zero price")
	}
}

func TestAggregator_Submit_UnsupportedAsset(t *testing.T) {
	agg := oracle.NewAggregator(1, newLogger())
	report := &types.PriceReport{
		Asset:    "FAKE/USD",
		Price:    big.NewInt(100),
		Reporter: types.NewDID("did:trc:0xoracle3"),
		Timestamp: time.Now().UTC(),
	}
	if err := agg.Submit(report); err == nil {
		t.Fatal("expected error for unsupported asset")
	}
}

func TestAggregator_LastPrice_BeforeFlush(t *testing.T) {
	agg := oracle.NewAggregator(1, newLogger())
	// Before any flush, LastPrice should return nil
	price := agg.LastPrice(oracle.AssetGoldUSD)
	if price != nil {
		t.Fatal("expected nil before first flush")
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// BuildCommitment
// ─────────────────────────────────────────────────────────────────────────────

func nonce(v byte) [32]byte { var n [32]byte; n[0] = v; return n }

func TestBuildCommitment_Deterministic(t *testing.T) {
	ts := time.Unix(1_700_000_000, 0)
	c1 := oracle.BuildCommitment("vault-001", big.NewInt(100), ts, nonce(42))
	c2 := oracle.BuildCommitment("vault-001", big.NewInt(100), ts, nonce(42))
	if c1 != c2 {
		t.Fatal("BuildCommitment must be deterministic")
	}
}

func TestBuildCommitment_UniqueWithDifferentNonce(t *testing.T) {
	ts := time.Unix(1_700_000_000, 0)
	c1 := oracle.BuildCommitment("vault-002", big.NewInt(100), ts, nonce(1))
	c2 := oracle.BuildCommitment("vault-002", big.NewInt(100), ts, nonce(2))
	if c1 == c2 {
		t.Fatal("different nonce must produce different commitment")
	}
}
