package types_test

import (
	"testing"
	"time"

	"github.com/trustedcrypto/protocol/types"
)

func TestNewDID_Deterministic(t *testing.T) {
	s := "did:trc:0xdeadbeef"
	a := types.NewDID(s)
	b := types.NewDID(s)
	if a != b {
		t.Fatalf("NewDID not deterministic: %v != %v", a, b)
	}
	if a.IsZero() {
		t.Fatal("expected non-zero DID")
	}
}

func TestNewDID_Uniqueness(t *testing.T) {
	a := types.NewDID("did:trc:0xaaa")
	b := types.NewDID("did:trc:0xbbb")
	if a == b {
		t.Fatal("distinct DID strings must produce distinct hashes")
	}
}

func TestDID_Hex(t *testing.T) {
	d := types.NewDID("did:trc:0xtest")
	hex := d.Hex()
	if len(hex) != 66 { // "0x" + 64 hex chars
		t.Fatalf("unexpected hex length %d", len(hex))
	}
	if hex[:2] != "0x" {
		t.Fatal("Hex must start with 0x")
	}
}

func TestBlockHeaderHash_Deterministic(t *testing.T) {
	hdr := &types.BlockHeader{
		Height:    1,
		Epoch:     0,
		Timestamp: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	}
	h1 := types.BlockHeaderHash(hdr)
	h2 := types.BlockHeaderHash(hdr)
	if h1 != h2 {
		t.Fatal("BlockHeaderHash must be deterministic")
	}
	if h1.IsZero() {
		t.Fatal("hash should not be zero")
	}
}

func TestBlockHeaderHash_ChangesWithHeight(t *testing.T) {
	ts := time.Now().UTC()
	h1 := types.BlockHeaderHash(&types.BlockHeader{Height: 1, Timestamp: ts})
	h2 := types.BlockHeaderHash(&types.BlockHeader{Height: 2, Timestamp: ts})
	if h1 == h2 {
		t.Fatal("different block heights must produce different hashes")
	}
}
