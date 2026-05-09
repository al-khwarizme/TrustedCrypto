/**
 * @trustedcrypto/sdk — contract interaction helpers
 *
 * Provides typed wrappers around every TrustedCrypto smart contract using
 * ethers.js v6. All methods return native BigInt values for on-chain amounts.
 *
 * Usage:
 *   const client = new TRCClient({ provider, signer, addresses });
 *   const balance = await client.gold.balanceOf(userAddress);
 */

import { ethers, Contract, type Signer, type Provider } from "ethers";
import {
  TRCGoldABI,
  TRCUtilityABI,
  WalletCapABI,
  GovernanceABI,
  PoCRewardsABI,
  ReserveABI,
  CommonsABI,
} from "./abis";
import type { NetworkConfig, CapInfo } from "./types";
import { ProposalType } from "./types";

// Re-export so callers don't need to import ethers directly
export { ethers };

// --------------------------------------------------------------------------
// Internal helper: attach a contract with optional signer fallback
// --------------------------------------------------------------------------

function attach(
  address: string,
  abi: readonly string[],
  signerOrProvider: Signer | Provider
): Contract {
  return new Contract(address, abi as string[], signerOrProvider);
}

// --------------------------------------------------------------------------
// TRCGoldClient
// --------------------------------------------------------------------------

export class TRCGoldClient {
  private readonly contract: Contract;

  constructor(address: string, signerOrProvider: Signer | Provider) {
    this.contract = attach(address, TRCGoldABI, signerOrProvider);
  }

  get address(): string {
    return this.contract.target as string;
  }

  async balanceOf(account: string): Promise<bigint> {
    return this.contract.balanceOf(account) as Promise<bigint>;
  }

  async totalSupply(): Promise<bigint> {
    return this.contract.totalSupply() as Promise<bigint>;
  }

  async gramsInReserve(): Promise<bigint> {
    return this.contract.gramsInReserve() as Promise<bigint>;
  }

  /** Returns reserve ratio as a 1e18-scaled fraction. 1e18 = 100% backed. */
  async reserveRatio(): Promise<bigint> {
    return this.contract.reserveRatio() as Promise<bigint>;
  }

  async transfer(to: string, amount: bigint): Promise<ethers.ContractTransactionResponse> {
    return this.contract.transfer(to, amount) as Promise<ethers.ContractTransactionResponse>;
  }

  async approve(spender: string, amount: bigint): Promise<ethers.ContractTransactionResponse> {
    return this.contract.approve(spender, amount) as Promise<ethers.ContractTransactionResponse>;
  }

  async allowance(owner: string, spender: string): Promise<bigint> {
    return this.contract.allowance(owner, spender) as Promise<bigint>;
  }

  /** @returns Deposit proof → amount mapping (non-zero if proof was used) */
  async depositProofToMinted(proof: string): Promise<bigint> {
    return this.contract.depositProofToMinted(proof) as Promise<bigint>;
  }

  /** Subscribe to Transfer events. Returns an ethers EventListener. */
  onTransfer(
    callback: (from: string, to: string, value: bigint) => void
  ): void {
    this.contract.on("Transfer", callback);
  }

  offTransfer(
    callback: (from: string, to: string, value: bigint) => void
  ): void {
    this.contract.off("Transfer", callback);
  }

  /** Subscribe to GoldMinted events. */
  onGoldMinted(
    callback: (to: string, amount: bigint, proof: string, reserve: bigint) => void
  ): void {
    this.contract.on("GoldMinted", callback);
  }
}

// --------------------------------------------------------------------------
// TRCUtilityClient
// --------------------------------------------------------------------------

export class TRCUtilityClient {
  private readonly contract: Contract;

  constructor(address: string, signerOrProvider: Signer | Provider) {
    this.contract = attach(address, TRCUtilityABI, signerOrProvider);
  }

  get address(): string {
    return this.contract.target as string;
  }

  async balanceOf(account: string): Promise<bigint> {
    return this.contract.balanceOf(account) as Promise<bigint>;
  }

  async totalSupply(): Promise<bigint> {
    return this.contract.totalSupply() as Promise<bigint>;
  }

  async utilityPoolBalance(): Promise<bigint> {
    return this.contract.utilityPoolBalance() as Promise<bigint>;
  }

  async transfer(to: string, amount: bigint): Promise<ethers.ContractTransactionResponse> {
    return this.contract.transfer(to, amount) as Promise<ethers.ContractTransactionResponse>;
  }

  async approve(spender: string, amount: bigint): Promise<ethers.ContractTransactionResponse> {
    return this.contract.approve(spender, amount) as Promise<ethers.ContractTransactionResponse>;
  }

  /**
   * Burn TRC-U in exchange for a commodity redemption voucher.
   * @param amount        Amount in token units (18 decimals)
   * @param commodityType keccak256 of commodity name, e.g. keccak256("WHEAT_KG")
   */
  async redeemCommodity(
    amount: bigint,
    commodityType: string
  ): Promise<ethers.ContractTransactionResponse> {
    return this.contract.redeemCommodity(amount, commodityType) as Promise<ethers.ContractTransactionResponse>;
  }

  onTransfer(
    callback: (from: string, to: string, value: bigint) => void
  ): void {
    this.contract.on("Transfer", callback);
  }
}

// --------------------------------------------------------------------------
// WalletCapClient
// --------------------------------------------------------------------------

export class WalletCapClient {
  private readonly contract: Contract;

  constructor(address: string, signerOrProvider: Signer | Provider) {
    this.contract = attach(address, WalletCapABI, signerOrProvider);
  }

  async getCap(): Promise<bigint> {
    return this.contract.getCap() as Promise<bigint>;
  }

  async didAggregateBalance(didHash: string): Promise<bigint> {
    return this.contract.didAggregateBalance(didHash) as Promise<bigint>;
  }

  /**
   * Returns full cap info for a DID, including remaining headroom.
   */
  async getCapInfo(didHash: string): Promise<CapInfo> {
    const [cap, currentBalance] = await Promise.all([
      this.contract.getCap() as Promise<bigint>,
      this.contract.didAggregateBalance(didHash) as Promise<bigint>,
    ]);
    const remaining = cap > currentBalance ? cap - currentBalance : 0n;
    return {
      cap,
      currentBalance,
      remaining,
      canReceive: (amount: bigint) => currentBalance + amount <= cap,
    };
  }

  async checkCap(didHash: string, additionalAmount: bigint): Promise<boolean> {
    return this.contract.checkCap(didHash, additionalAmount) as Promise<boolean>;
  }

  async getDIDForAddress(wallet: string): Promise<string> {
    return this.contract.getDIDForAddress(wallet) as Promise<string>;
  }

  async getAddressesForDID(didHash: string): Promise<string[]> {
    return this.contract.getAddressesForDID(didHash) as Promise<string[]>;
  }

  async participantCount(): Promise<bigint> {
    return this.contract.participantCount() as Promise<bigint>;
  }
}

// --------------------------------------------------------------------------
// GovernanceClient
// --------------------------------------------------------------------------

export class GovernanceClient {
  private readonly contract: Contract;

  constructor(address: string, signerOrProvider: Signer | Provider) {
    this.contract = attach(address, GovernanceABI, signerOrProvider);
  }

  async proposalCount(): Promise<bigint> {
    return this.contract.proposalCount() as Promise<bigint>;
  }

  async registeredDIDCount(): Promise<bigint> {
    return this.contract.registeredDIDCount() as Promise<bigint>;
  }

  async getProposalState(proposalId: bigint): Promise<number> {
    return this.contract.getProposalState(proposalId) as Promise<number>;
  }

  async getVoteTotals(
    proposalId: bigint
  ): Promise<{ votesFor: bigint; votesAgainst: bigint }> {
    const [votesFor, votesAgainst] = await this.contract.getVoteTotals(proposalId);
    return { votesFor, votesAgainst };
  }

  /**
   * Create a new governance proposal.
   * @param type            ProposalType enum value
   * @param description     Human-readable description
   * @param executionData   ABI-encoded calldata for the on-chain action (or "0x")
   * @param executionTarget Target contract address (or ethers.ZeroAddress for text-only)
   */
  async propose(
    type: ProposalType,
    description: string,
    executionData: string = "0x",
    executionTarget: string = ethers.ZeroAddress
  ): Promise<ethers.ContractTransactionResponse> {
    return this.contract.propose(
      type,
      description,
      executionData,
      executionTarget
    ) as Promise<ethers.ContractTransactionResponse>;
  }

  /**
   * Cast a vote on a proposal.
   * @param proposalId  The proposal ID returned by propose()
   * @param voterDID    keccak256 of the voter's DID string
   * @param support     true = in favour, false = against
   */
  async vote(
    proposalId: bigint,
    voterDID: string,
    support: boolean
  ): Promise<ethers.ContractTransactionResponse> {
    return this.contract.vote(proposalId, voterDID, support) as Promise<ethers.ContractTransactionResponse>;
  }

  async queue(proposalId: bigint): Promise<ethers.ContractTransactionResponse> {
    return this.contract.queue(proposalId) as Promise<ethers.ContractTransactionResponse>;
  }

  async execute(proposalId: bigint): Promise<ethers.ContractTransactionResponse> {
    return this.contract.execute(proposalId) as Promise<ethers.ContractTransactionResponse>;
  }

  onProposalCreated(
    callback: (id: bigint, proposerDID: string, ptype: number, description: string) => void
  ): void {
    this.contract.on("ProposalCreated", callback);
  }

  onVoteCast(
    callback: (proposalId: bigint, voterDID: string, support: boolean) => void
  ): void {
    this.contract.on("VoteCast", callback);
  }
}

// --------------------------------------------------------------------------
// PoCRewardsClient
// --------------------------------------------------------------------------

export class PoCRewardsClient {
  private readonly contract: Contract;

  constructor(address: string, signerOrProvider: Signer | Provider) {
    this.contract = attach(address, PoCRewardsABI, signerOrProvider);
  }

  async getScore(didHash: string): Promise<bigint> {
    return this.contract.getScore(didHash) as Promise<bigint>;
  }

  onContributionSubmitted(
    callback: (did: string, ctype: number, points: bigint, proofHash: string) => void
  ): void {
    this.contract.on("ContributionSubmitted", callback);
  }
}

// --------------------------------------------------------------------------
// ReserveClient
// --------------------------------------------------------------------------

export class ReserveClient {
  private readonly contract: Contract;

  constructor(address: string, signerOrProvider: Signer | Provider) {
    this.contract = attach(address, ReserveABI, signerOrProvider);
  }

  async goldInVault(): Promise<bigint> {
    return this.contract.goldInVault() as Promise<bigint>;
  }

  async pendingDepositNonce(): Promise<bigint> {
    return this.contract.pendingDepositNonce() as Promise<bigint>;
  }

  async requestRedemption(
    tokenAmount: bigint,
    encryptedDeliveryAddress: string
  ): Promise<ethers.ContractTransactionResponse> {
    return this.contract.requestRedemption(
      tokenAmount,
      encryptedDeliveryAddress
    ) as Promise<ethers.ContractTransactionResponse>;
  }

  onRedemptionRequested(
    callback: (nonce: bigint, redeemer: string, tokenAmount: bigint) => void
  ): void {
    this.contract.on("RedemptionRequested", callback);
  }
}

// --------------------------------------------------------------------------
// TRCClient — unified entry point
// --------------------------------------------------------------------------

/**
 * Main entry point for the TrustedCrypto SDK.
 *
 * @example
 * ```ts
 * import { TRCClient } from "@trustedcrypto/sdk";
 * import { JsonRpcProvider, Wallet } from "ethers";
 * import addresses from "./deployments/sepolia.json";
 *
 * const provider = new JsonRpcProvider("https://sepolia.infura.io/v3/<key>");
 * const signer   = new Wallet(process.env.PRIVATE_KEY!, provider);
 *
 * const client = new TRCClient({ provider, signer, addresses: addresses.contracts });
 *
 * const balance = await client.gold.balanceOf(signer.address);
 * console.log("TRC-G balance:", balance);
 * ```
 */
export class TRCClient {
  readonly gold:       TRCGoldClient;
  readonly utility:    TRCUtilityClient;
  readonly walletCap:  WalletCapClient;
  readonly governance: GovernanceClient;
  readonly pocRewards: PoCRewardsClient;
  readonly reserve:    ReserveClient;

  constructor({ provider, signer, addresses }: NetworkConfig) {
    const signerOrProvider: Signer | Provider = signer ?? provider;

    this.gold       = new TRCGoldClient(addresses.trcGold,       signerOrProvider);
    this.utility    = new TRCUtilityClient(addresses.trcUtility,  signerOrProvider);
    this.walletCap  = new WalletCapClient(addresses.walletCap,   provider); // read-only
    this.governance = new GovernanceClient(addresses.governance,  signerOrProvider);
    this.pocRewards = new PoCRewardsClient(addresses.pocRewards,  signerOrProvider);
    this.reserve    = new ReserveClient(addresses.reserve,        signerOrProvider);
  }

  /**
   * Returns the backing ratio of TRC-G as a human-readable percentage.
   * Should always be ≥ 100% for a healthy reserve.
   */
  async reserveRatioPercent(): Promise<string> {
    const ratio = await this.gold.reserveRatio();
    return ((Number(ratio) / 1e18) * 100).toFixed(4) + "%";
  }

  /**
   * Helper: format a token amount (18 decimals) to a human-readable string.
   * @example formatAmount(1_000_000_000_000_000_000n) // "1.0000"
   */
  static formatAmount(amount: bigint, decimals = 4): string {
    return parseFloat(ethers.formatEther(amount)).toFixed(decimals);
  }

  /**
   * Helper: parse a human-readable token amount to 18-decimal bigint.
   * @example parseAmount("1.5") // 1_500_000_000_000_000_000n
   */
  static parseAmount(amount: string): bigint {
    return ethers.parseEther(amount);
  }
}
