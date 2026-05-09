import { ethers } from "ethers";

/**
 * A TrustedCrypto Decentralized Identity (DID).
 *
 * Each DID is derived from a secp256k1 key pair and formatted as:
 *   did:trc:0x<20-byte-hex-address>
 *
 * The DID hash (bytes32) is keccak256 of the DID string — this is the value
 * stored on-chain in WalletCap, PoCRewards, and Governance contracts.
 *
 * Key derivation matches the Go identity package and the mobile client:
 * address = last 20 bytes of keccak256(uncompressed pubkey[1:])
 */
export class TRCIdentity {
  readonly didString: string;
  readonly didHash: string;
  readonly address: string;

  private constructor(
    private readonly wallet: ethers.Wallet,
    didString: string
  ) {
    this.didString = didString;
    this.didHash = ethers.keccak256(ethers.toUtf8Bytes(didString));
    this.address = wallet.address;
  }

  /** Generate a new random identity. Store the private key securely. */
  static generate(): TRCIdentity {
    const hd = ethers.Wallet.createRandom(); // returns HDNodeWallet in ethers v6
    const wallet = new ethers.Wallet(hd.privateKey);
    const didString = `did:trc:${wallet.address.toLowerCase()}`;
    return new TRCIdentity(wallet, didString);
  }

  /**
   * Restore an identity from an existing private key.
   * @param privateKey  Hex-encoded 32-byte private key (with or without 0x prefix)
   */
  static fromPrivateKey(privateKey: string): TRCIdentity {
    const wallet = new ethers.Wallet(privateKey);
    const didString = `did:trc:${wallet.address.toLowerCase()}`;
    return new TRCIdentity(wallet, didString);
  }

  /**
   * Restore an identity from a BIP-39 mnemonic phrase.
   * @param mnemonic  12 or 24 word BIP-39 mnemonic
   * @param path      BIP-44 derivation path (default: m/44'/60'/0'/0/0)
   */
  static fromMnemonic(
    mnemonic: string,
    path = "m/44'/60'/0'/0/0"
  ): TRCIdentity {
    const wallet = ethers.HDNodeWallet.fromPhrase(mnemonic, undefined, path);
    const didString = `did:trc:${wallet.address.toLowerCase()}`;
    return new TRCIdentity(new ethers.Wallet(wallet.privateKey), didString);
  }

  /** Export the private key. Never log or transmit this. */
  get privateKey(): string {
    return this.wallet.privateKey;
  }

  /** Connect this identity to an ethers provider for on-chain transactions. */
  connect(provider: ethers.Provider): ethers.Wallet {
    return this.wallet.connect(provider);
  }

  /**
   * Sign an arbitrary 32-byte message hash (EIP-191 personal_sign style).
   * Used for contribution proofs, oracle submissions, and governance votes.
   */
  async sign(messageHash: Uint8Array | string): Promise<string> {
    return this.wallet.signMessage(messageHash);
  }

  /**
   * Build and sign a contribution proof payload.
   * The resulting signature should be submitted to PoCRewards via the Go node RPC.
   *
   * @param type    ContributionType enum value
   * @param points  Contribution points (max per-type cap enforced on-chain)
   * @param nonce   Unique nonce to prevent replay (use Date.now() or random)
   */
  async signContributionProof(
    type: number,
    points: number,
    nonce: bigint
  ): Promise<{ proofHash: string; signature: string }> {
    const timestamp = BigInt(Math.floor(Date.now() / 1000));
    const payload = ethers.solidityPacked(
      ["bytes32", "uint8", "uint32", "uint64", "uint64"],
      [this.didHash, type, points, timestamp, nonce]
    );
    const proofHash = ethers.keccak256(payload);
    const msgHash = ethers.keccak256(
      ethers.concat([ethers.getBytes(proofHash), ethers.getBytes(this.didHash)])
    );
    const signature = await this.wallet.signMessage(ethers.getBytes(msgHash));
    return { proofHash, signature };
  }
}
