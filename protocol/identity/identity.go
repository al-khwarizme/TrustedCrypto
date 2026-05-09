// Package identity implements TrustedCrypto's Decentralized Identity (DID)
// system including key management, DID document generation, and the stub
// interface for zero-knowledge Proof-of-Humanity (zkPoH).
//
// Design (§16.4):
//   - Each user has a W3C-compatible DID anchored to the TRC chain.
//   - The DID contains no personal information — only a cryptographic commitment.
//   - A one-time zkPoH links a government ID to the DID without storing PII.
//   - One government ID → one zkPoH → one DID → one wallet-cap allowance.
//   - A DID may be linked to multiple wallet addresses (privacy-preserving).
package identity

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/btcsuite/btcd/btcec/v2"
	btcecdsa "github.com/btcsuite/btcd/btcec/v2/ecdsa"
	"golang.org/x/crypto/sha3"

	"github.com/trustedcrypto/protocol/types"
)

// ─────────────────────────────────────────────────────────────────────────────
// Key management
// ─────────────────────────────────────────────────────────────────────────────

// KeyPair is a secp256k1 key pair used for DID signing and transaction signing.
type KeyPair struct {
	priv *btcec.PrivateKey
	pub  *btcec.PublicKey
}

// GenerateKeyPair creates a new random secp256k1 key pair.
func GenerateKeyPair() (*KeyPair, error) {
	priv, err := btcec.NewPrivateKey()
	if err != nil {
		return nil, err
	}
	return &KeyPair{priv: priv, pub: priv.PubKey()}, nil
}

// PublicKeyBytes returns the 33-byte compressed public key.
func (kp *KeyPair) PublicKeyBytes() []byte {
	return kp.pub.SerializeCompressed()
}

// Address returns the Ethereum-compatible address derived from this key.
// This is the last 20 bytes of Keccak-256(uncompressed public key[1:]).
func (kp *KeyPair) Address() [20]byte {
	uncompressed := kp.pub.SerializeUncompressed() // 65 bytes, prefix 0x04
	hash := keccak256(uncompressed[1:])             // Keccak of 64 bytes
	var addr [20]byte
	copy(addr[:], hash[12:])
	return addr
}

// Sign signs a 32-byte message hash using the private key (ECDSA/secp256k1).
// Returns a 64-byte compact signature (r || s).
func (kp *KeyPair) Sign(msgHash [32]byte) ([]byte, error) {
	sig, err := btcecdsa.SignCompact(kp.priv, msgHash[:], false)
	if err != nil {
		return nil, err
	}
	return sig, nil
}

// Verify checks that sig is a valid signature of msgHash for the public key.
func Verify(pubKeyBytes []byte, msgHash [32]byte, sig []byte) bool {
	pub, err := btcec.ParsePubKey(pubKeyBytes)
	if err != nil {
		return false
	}
	// btcecdsa.SignCompact returns a 65-byte sig including recovery bit at [0]
	recovered, _, err := btcecdsa.RecoverCompact(sig, msgHash[:])
	if err != nil {
		return false
	}
	return recovered.IsEqual(pub)
}

// ─────────────────────────────────────────────────────────────────────────────
// DID document
// ─────────────────────────────────────────────────────────────────────────────

// DIDDocument is the public representation of an identity on the TRC chain.
// It maps to a W3C DID document but is trimmed for on-chain efficiency.
type DIDDocument struct {
	// DID string: "did:trc:<hex-address>"
	ID        string
	DIDHash   types.DID // keccak-derived 32-byte identifier stored on-chain
	PublicKey []byte    // 33-byte compressed secp256k1 public key
	CreatedAt time.Time
	// PoHNullifier is the zero-knowledge nullifier committed on-chain.
	// It proves uniqueness without revealing the underlying ID.
	PoHNullifier []byte
	// WalletAddresses are the Ethereum-style addresses linked to this DID.
	WalletAddresses [][20]byte
}

// NewDIDDocument creates a DIDDocument from a key pair.
// didString format: "did:trc:0x<20-byte-hex-address>"
func NewDIDDocument(kp *KeyPair) *DIDDocument {
	addr := kp.Address()
	didString := fmt.Sprintf("did:trc:0x%s", hex.EncodeToString(addr[:]))
	didHash := types.NewDID(didString)
	return &DIDDocument{
		ID:              didString,
		DIDHash:         didHash,
		PublicKey:       kp.PublicKeyBytes(),
		CreatedAt:       time.Now().UTC(),
		WalletAddresses: [][20]byte{addr},
	}
}

// SignContributionProof signs a ContributionProof, setting the Signature field.
// The proof hash is computed over all fields except Signature.
func (doc *DIDDocument) SignContributionProof(kp *KeyPair, proof *types.ContributionProof) error {
	if kp == nil {
		return errors.New("nil key pair")
	}
	// Compute proof hash: sha256 of type-stamped proof data
	raw := buildProofPreimage(proof)
	proof.ProofHash = sha256.Sum256(raw)
	msgHash := sha256.Sum256(append(proof.ProofHash[:], proof.DID[:]...))
	sig, err := kp.Sign(msgHash)
	if err != nil {
		return err
	}
	proof.Signature = sig
	return nil
}

func buildProofPreimage(proof *types.ContributionProof) []byte {
	var buf []byte
	buf = append(buf, proof.DID[:]...)
	buf = append(buf, byte(proof.CType))
	buf = append(buf, byte(proof.Points>>24), byte(proof.Points>>16), byte(proof.Points>>8), byte(proof.Points))
	ts := uint64(proof.Timestamp.Unix())
	buf = append(buf, byte(ts>>56), byte(ts>>48), byte(ts>>40), byte(ts>>32),
		byte(ts>>24), byte(ts>>16), byte(ts>>8), byte(ts))
	buf = append(buf, byte(proof.Nonce>>56), byte(proof.Nonce>>48),
		byte(proof.Nonce>>40), byte(proof.Nonce>>32), byte(proof.Nonce>>24),
		byte(proof.Nonce>>16), byte(proof.Nonce>>8), byte(proof.Nonce))
	buf = append(buf, proof.ProofData...)
	return buf
}

// ─────────────────────────────────────────────────────────────────────────────
// Zero-knowledge Proof of Humanity (zkPoH) — stub implementation
// ─────────────────────────────────────────────────────────────────────────────
//
// A full zkPoH implementation requires a ZK circuit (e.g., Circom/Groth16)
// that proves "the hash of this government ID has not been seen before" without
// revealing the ID.  This stub simulates the interface:
//
//   1. The verification partner receives the physical ID.
//   2. They hash it with a secret salt (never stored on-chain).
//   3. They check the nullifier registry to prevent duplicate registration.
//   4. If new, they sign a zkPoH credential committing the nullifier.
//   5. The credential is committed on-chain; the underlying ID is discarded.
//
// In production, step 4 is replaced by a real ZK circuit proof.

// PoHCredential is the credential issued by a verification partner.
type PoHCredential struct {
	DIDHash   types.DID // the account being verified
	Nullifier []byte    // hash(salt || governmentID) — unique per human
	IssuedAt  time.Time
	// Signature of the partner over sha256(DIDHash || Nullifier || IssuedAt)
	PartnerSig []byte
	PartnerPub []byte // partner's public key for on-chain verification
}

// IssuePoHCredential is called by a verification partner to attest uniqueness.
// idBytes is the raw government ID document (never stored after this call).
// salt should be a partner-specific secret that prevents cross-partner linkage.
func IssuePoHCredential(partnerKP *KeyPair, did types.DID, idBytes, salt []byte) (*PoHCredential, error) {
	// Compute nullifier: sha256(salt || idBytes)
	combined := append(salt, idBytes...)
	nullifier := sha256.Sum256(combined)

	now := time.Now().UTC()
	msgHash := credentialHash(did, nullifier[:], now)
	sig, err := partnerKP.Sign(msgHash)
	if err != nil {
		return nil, err
	}

	return &PoHCredential{
		DIDHash:    did,
		Nullifier:  nullifier[:],
		IssuedAt:   now,
		PartnerSig: sig,
		PartnerPub: partnerKP.PublicKeyBytes(),
	}, nil
}

// VerifyPoHCredential checks that a PoHCredential was signed by the claimed partner.
func VerifyPoHCredential(cred *PoHCredential) bool {
	msgHash := credentialHash(cred.DIDHash, cred.Nullifier, cred.IssuedAt)
	return Verify(cred.PartnerPub, msgHash, cred.PartnerSig)
}

func credentialHash(did types.DID, nullifier []byte, t time.Time) [32]byte {
	var buf []byte
	buf = append(buf, did[:]...)
	buf = append(buf, nullifier...)
	ts := uint64(t.Unix())
	buf = append(buf,
		byte(ts>>56), byte(ts>>48), byte(ts>>40), byte(ts>>32),
		byte(ts>>24), byte(ts>>16), byte(ts>>8), byte(ts))
	return sha256.Sum256(buf)
}

// ─────────────────────────────────────────────────────────────────────────────
// Nullifier registry (in-memory; persisted to chain in production)
// ─────────────────────────────────────────────────────────────────────────────

// NullifierRegistry tracks used nullifiers to enforce one-human-one-DID.
type NullifierRegistry struct {
	mu         sync.RWMutex
	nullifiers map[[32]byte]types.DID // nullifier → DID that registered it
}

// NewNullifierRegistry creates an empty registry.
func NewNullifierRegistry() *NullifierRegistry {
	return &NullifierRegistry{
		nullifiers: make(map[[32]byte]types.DID),
	}
}

var ErrNullifierAlreadyUsed = errors.New("nullifier already registered: duplicate human detected")

// Register attempts to register a nullifier for a DID.
// Returns ErrNullifierAlreadyUsed if the same nullifier was already registered
// (meaning the same person tried to register twice).
func (r *NullifierRegistry) Register(cred *PoHCredential) error {
	if !VerifyPoHCredential(cred) {
		return errors.New("invalid PoH credential signature")
	}
	var key [32]byte
	copy(key[:], cred.Nullifier)

	r.mu.Lock()
	defer r.mu.Unlock()
	if existing, ok := r.nullifiers[key]; ok {
		if existing != cred.DIDHash {
			return ErrNullifierAlreadyUsed
		}
		// Idempotent: same DID re-registering is a no-op
		return nil
	}
	r.nullifiers[key] = cred.DIDHash
	return nil
}

// IsRegistered reports whether the given DID has a valid PoH credential.
func (r *NullifierRegistry) IsRegistered(did types.DID) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, d := range r.nullifiers {
		if d == did {
			return true
		}
	}
	return false
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

// keccak256 computes the Keccak-256 hash (Ethereum-compatible).
func keccak256(data []byte) []byte {
	h := sha3.NewLegacyKeccak256()
	h.Write(data)
	return h.Sum(nil)
}

// suppress unused import warning — ecdsa imported for interface compliance
var _ = (*ecdsa.PublicKey)(nil)
var _ = rand.Read
