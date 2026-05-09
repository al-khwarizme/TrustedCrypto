package identity_test

import (
	"testing"
	"time"

	"github.com/trustedcrypto/protocol/identity"
	"github.com/trustedcrypto/protocol/types"
)

func TestGenerateKeyPair(t *testing.T) {
	kp, err := identity.GenerateKeyPair()
	if err != nil {
		t.Fatalf("GenerateKeyPair: %v", err)
	}
	if kp == nil {
		t.Fatal("nil key pair")
	}
	pub := kp.PublicKeyBytes()
	if len(pub) != 33 {
		t.Fatalf("expected 33-byte compressed pubkey, got %d", len(pub))
	}
}

func TestKeyPair_Address(t *testing.T) {
	kp, _ := identity.GenerateKeyPair()
	addr := kp.Address()
	var zero [20]byte
	if addr == zero {
		t.Fatal("address must not be zero")
	}
	// Two different keys must yield different addresses
	kp2, _ := identity.GenerateKeyPair()
	if kp.Address() == kp2.Address() {
		t.Fatal("distinct keys must produce distinct addresses (birthday probability ~0)")
	}
}

func TestKeyPair_SignVerify(t *testing.T) {
	kp, _ := identity.GenerateKeyPair()
	var msg [32]byte
	copy(msg[:], "test message for signing 123456789")
	sig, err := kp.Sign(msg)
	if err != nil {
		t.Fatalf("Sign: %v", err)
	}
	if len(sig) == 0 {
		t.Fatal("empty signature")
	}
	if !identity.Verify(kp.PublicKeyBytes(), msg, sig) {
		t.Fatal("Verify returned false for valid signature")
	}
}

func TestVerify_WrongKey(t *testing.T) {
	kp1, _ := identity.GenerateKeyPair()
	kp2, _ := identity.GenerateKeyPair()
	var msg [32]byte
	copy(msg[:], "test payload")
	sig, _ := kp1.Sign(msg)
	if identity.Verify(kp2.PublicKeyBytes(), msg, sig) {
		t.Fatal("Verify must fail when verifying with wrong public key")
	}
}

func TestVerify_TamperedMessage(t *testing.T) {
	kp, _ := identity.GenerateKeyPair()
	var msg [32]byte
	copy(msg[:], "original message 1234567890abcdef")
	sig, _ := kp.Sign(msg)

	msg[0] ^= 0xFF // tamper
	if identity.Verify(kp.PublicKeyBytes(), msg, sig) {
		t.Fatal("Verify must fail on tampered message")
	}
}

func TestNewDIDDocument(t *testing.T) {
	kp, _ := identity.GenerateKeyPair()
	doc := identity.NewDIDDocument(kp)

	if doc.ID == "" {
		t.Fatal("DID ID must not be empty")
	}
	if len(doc.ID) < 10 {
		t.Fatalf("DID ID too short: %s", doc.ID)
	}
	if doc.DIDHash.IsZero() {
		t.Fatal("DIDHash must not be zero")
	}
	if len(doc.PublicKey) != 33 {
		t.Fatalf("expected 33-byte pubkey, got %d", len(doc.PublicKey))
	}
	if len(doc.WalletAddresses) != 1 {
		t.Fatalf("expected 1 wallet address, got %d", len(doc.WalletAddresses))
	}
}

func TestSignContributionProof(t *testing.T) {
	kp, _ := identity.GenerateKeyPair()
	doc := identity.NewDIDDocument(kp)

	proof := &types.ContributionProof{
		DID:       doc.DIDHash,
		CType:     types.ContribNodeUptime,
		Points:    10,
		Timestamp: time.Now().UTC(),
		Nonce:     1,
	}

	if err := doc.SignContributionProof(kp, proof); err != nil {
		t.Fatalf("SignContributionProof: %v", err)
	}
	if proof.ProofHash.IsZero() {
		t.Fatal("ProofHash must be set")
	}
	if len(proof.Signature) == 0 {
		t.Fatal("Signature must not be empty")
	}
}

func TestNullifierRegistry_RejectsReuse(t *testing.T) {
	kp, _ := identity.GenerateKeyPair()
	kp2, _ := identity.GenerateKeyPair()

	doc1 := identity.NewDIDDocument(kp)
	doc2 := identity.NewDIDDocument(kp2)

	reg := identity.NewNullifierRegistry()

	// Issue two credentials with the same salt+idBytes (same nullifier) but different DIDs
	cred1, err := identity.IssuePoHCredential(kp, doc1.DIDHash, []byte("govID456"), []byte("salt123"))
	if err != nil {
		t.Fatalf("IssuePoHCredential cred1: %v", err)
	}
	// Build a credential with same nullifier bytes but signed for doc2's DID
	cred2, err := identity.IssuePoHCredential(kp2, doc2.DIDHash, []byte("govID456"), []byte("salt123"))
	if err != nil {
		t.Fatalf("IssuePoHCredential cred2: %v", err)
	}

	if err := reg.Register(cred1); err != nil {
		t.Fatalf("first Register: %v", err)
	}
	// Same nullifier, different DID — must be rejected
	if err := reg.Register(cred2); err == nil {
		t.Fatal("expected error on duplicate nullifier with different DID")
	}
}
