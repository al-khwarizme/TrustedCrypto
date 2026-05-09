/**
 * src/services/identity.ts
 *
 * DID key generation, signing, and secure storage.
 *
 * Uses:
 *   - ethers.js Wallet for secp256k1 key generation (same curve as Go layer)
 *   - react-native-encrypted-storage for OS-level key protection
 *     (Android Keystore / iOS Secure Enclave backed)
 *   - keccak256 derivation matching the Go identity package
 */

import { ethers } from 'ethers';
import EncryptedStorage from 'react-native-encrypted-storage';
import { STORAGE_KEYS } from '../constants';
import type { Address, Bytes32, DID, DIDDocument } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Key generation & DID derivation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Derives a W3C-compatible TRC DID from an EVM address.
 *   did:trc:<checksummed-address>
 */
export function addressToDID(address: Address): DID {
  return `did:trc:${ethers.getAddress(address)}`;
}

/**
 * Computes the 32-byte DID hash (keccak256 of the DID string),
 * matching types.DID in the Go layer.
 */
export function hashDID(did: DID): Bytes32 {
  return ethers.keccak256(ethers.toUtf8Bytes(did));
}

// ─────────────────────────────────────────────────────────────────────────────
// Secure storage
// ─────────────────────────────────────────────────────────────────────────────

/** Load the wallet from encrypted storage, or create one if absent. */
export async function loadOrCreateWallet(): Promise<ethers.Wallet> {
  const stored = await EncryptedStorage.getItem(STORAGE_KEYS.PRIVATE_KEY);
  if (stored) {
    return new ethers.Wallet(stored);
  }
  const wallet = ethers.Wallet.createRandom();
  await EncryptedStorage.setItem(STORAGE_KEYS.PRIVATE_KEY, wallet.privateKey);
  return wallet;
}

/** Build the DIDDocument for this device's wallet. */
export function buildDIDDocument(wallet: ethers.Wallet): DIDDocument {
  const address = wallet.address as Address;
  const did = addressToDID(address);
  return {
    id: did,
    didHash: hashDID(did),
    publicKey: wallet.signingKey.compressedPublicKey,
    walletAddresses: [address],
  };
}

/** Persist the DIDDocument (public, non-sensitive). */
export async function saveDIDDocument(doc: DIDDocument): Promise<void> {
  await EncryptedStorage.setItem(STORAGE_KEYS.DID_DOCUMENT, JSON.stringify(doc));
}

/** Load the persisted DIDDocument. Returns null if not yet created. */
export async function loadDIDDocument(): Promise<DIDDocument | null> {
  const raw = await EncryptedStorage.getItem(STORAGE_KEYS.DID_DOCUMENT);
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as DIDDocument;
}

/** Wipe all identity material from device storage. */
export async function clearIdentity(): Promise<void> {
  await EncryptedStorage.removeItem(STORAGE_KEYS.PRIVATE_KEY);
  await EncryptedStorage.removeItem(STORAGE_KEYS.DID_DOCUMENT);
}

// ─────────────────────────────────────────────────────────────────────────────
// Signing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sign an arbitrary 32-byte hash with the device key.
 * Returns 65-byte compact signature hex (r || s || v).
 */
export async function signHash(wallet: ethers.Wallet, hash: Bytes32): Promise<string> {
  return wallet.signingKey.sign(hash).serialized;
}

/**
 * Sign a contribution proof pre-image.
 *
 * Pre-image: keccak256(proofHash || didHash)
 * This matches identity.go SignContributionProof in the Go layer.
 */
export async function signContributionPreimage(
  wallet: ethers.Wallet,
  proofHash: Bytes32,
  didHash: Bytes32,
): Promise<string> {
  const combined = ethers.concat([
    ethers.getBytes(proofHash),
    ethers.getBytes(didHash),
  ]);
  const msgHash = ethers.sha256(combined);
  return signHash(wallet, msgHash);
}

/**
 * Compute a contribution proof hash.
 *
 * sha256(did || type || points || timestamp || nonce || proofData)
 * Matches identity.go SignContributionProof pre-image.
 */
export function buildProofHash(
  didHash: Bytes32,
  type: number,
  points: number,
  timestamp: Date,
  nonce: number,
  proofData: Uint8Array,
): Bytes32 {
  const tsBytes = new Uint8Array(8);
  const ts = BigInt(Math.floor(timestamp.getTime() / 1000));
  const tsView = new DataView(tsBytes.buffer);
  tsView.setBigUint64(0, ts, false);

  const nonceBytes = new Uint8Array(8);
  const nonceView = new DataView(nonceBytes.buffer);
  nonceView.setBigUint64(0, BigInt(nonce), false);

  const typeBytes = new Uint8Array([type]);
  const pointsBytes = new Uint8Array(4);
  new DataView(pointsBytes.buffer).setUint32(0, points, false);

  const preimage = ethers.concat([
    ethers.getBytes(didHash),
    typeBytes,
    pointsBytes,
    tsBytes,
    nonceBytes,
    proofData,
  ]);
  return ethers.sha256(preimage);
}

// ─────────────────────────────────────────────────────────────────────────────
// Proof-of-Humanity stub
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute a PoH nullifier from a salt and government-ID bytes.
 * sha256(salt || idBytes) — identical to Go IssuePoHCredential.
 *
 * NOTE: The actual zkPoH credential issuance happens via a partner
 * verification service. This function is used client-side to verify
 * that the local nullifier matches the on-chain registry.
 */
export function computeNullifier(salt: Uint8Array, idBytes: Uint8Array): Bytes32 {
  const combined = ethers.concat([salt, idBytes]);
  return ethers.sha256(combined);
}
