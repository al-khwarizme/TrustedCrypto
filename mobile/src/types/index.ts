/**
 * src/types/index.ts
 *
 * Shared TypeScript types mirroring the Go protocol layer.
 * All big-number amounts are bigint (18 decimal precision, matching ERC-20).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Identity
// ─────────────────────────────────────────────────────────────────────────────

/** W3C-compatible DID: "did:trc:0x<20-byte-hex>" */
export type DID = string;

/** 32-byte hex string (0x-prefixed) */
export type Bytes32 = string;

/** 20-byte EVM address (0x-prefixed, checksummed) */
export type Address = string;

export interface DIDDocument {
  id: DID;
  didHash: Bytes32;
  publicKey: string; // compressed secp256k1, hex
  walletAddresses: Address[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokens & balances
// ─────────────────────────────────────────────────────────────────────────────

export interface TokenBalance {
  /** TRC-G or TRC-U */
  symbol: 'TRC-G' | 'TRC-U';
  /** Amount in wei-equivalent (18 decimals) */
  amount: bigint;
  /** Current wallet-cap allowance remaining */
  capRemaining: bigint;
}

export interface WalletState {
  address: Address;
  trcG: TokenBalance;
  trcU: TokenBalance;
  /** TRC-G value in USD (from oracle) */
  goldUsdPrice: number;
  lastUpdated: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transactions
// ─────────────────────────────────────────────────────────────────────────────

export interface TxRequest {
  to: Address;
  amount: bigint;
  token: 'TRC-G' | 'TRC-U';
  memo?: string;
}

export interface TxReceipt {
  hash: string;
  blockHeight: number;
  timestamp: Date;
  status: 'pending' | 'confirmed' | 'failed';
  gasUsed: bigint;
}

// ─────────────────────────────────────────────────────────────────────────────
// Proof-of-Contribution
// ─────────────────────────────────────────────────────────────────────────────

export enum ContributionType {
  NodeUptime = 0,
  OracleData = 1,
  GovernanceVote = 2,
  PhysicalVerification = 3,
  TransactionActivity = 4,
}

export const CONTRIBUTION_LABELS: Record<ContributionType, string> = {
  [ContributionType.NodeUptime]: 'Node Uptime',
  [ContributionType.OracleData]: 'Oracle Data',
  [ContributionType.GovernanceVote]: 'Governance Vote',
  [ContributionType.PhysicalVerification]: 'Physical Verification',
  [ContributionType.TransactionActivity]: 'Transaction Activity',
};

export const DAILY_CAPS: Record<ContributionType, number> = {
  [ContributionType.NodeUptime]: 100,
  [ContributionType.OracleData]: 200,
  [ContributionType.GovernanceVote]: 100,
  [ContributionType.PhysicalVerification]: 500,
  [ContributionType.TransactionActivity]: 100,
};

export interface ContributionProof {
  did: DID;
  type: ContributionType;
  points: number;
  timestamp: Date;
  nonce: number;
  /** sha256 of the proof data + DID */
  proofHash: Bytes32;
  signature: string;
}

export interface ContributionScore {
  total: number;
  byType: Record<ContributionType, number>;
  /** Epoch in which this score was last updated */
  epochId: number;
  /** Estimated TRC-U reward this epoch */
  estimatedReward: bigint;
  /** Rank within validator scoreboard (undefined if not in top tier) */
  rank?: number;
}

export interface MiningSession {
  startedAt: Date;
  uptimeSeconds: number;
  proofsSubmitted: number;
  pointsEarned: number;
  isActive: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Oracle
// ─────────────────────────────────────────────────────────────────────────────

export const ORACLE_ASSETS = [
  'XAU/USD',
  'WHEAT_KG_USD',
  'RICE_KG_USD',
  'WTI_BBL_USD',
  'COPPER_KG_USD',
  'SOLAR_KWH_USD',
] as const;

export type OracleAsset = (typeof ORACLE_ASSETS)[number];

export const ORACLE_ASSET_LABELS: Record<OracleAsset, string> = {
  'XAU/USD': 'Gold (troy oz)',
  WHEAT_KG_USD: 'Wheat (per kg)',
  RICE_KG_USD: 'Rice (per kg)',
  WTI_BBL_USD: 'Crude Oil (barrel)',
  COPPER_KG_USD: 'Copper (per kg)',
  SOLAR_KWH_USD: 'Solar Energy (kWh)',
};

export interface PriceReport {
  asset: OracleAsset;
  /** Price in USD × 10^18 */
  price: bigint;
  timestamp: Date;
  reporter: DID;
}

export interface AggregatedPrice {
  asset: OracleAsset;
  medianPrice: bigint;
  reports: number;
  timestamp: Date;
  epochId: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Governance
// ─────────────────────────────────────────────────────────────────────────────

export enum ProposalType {
  Standard = 0,
  Protocol = 1,
  ReservePolicy = 2,
  Constitutional = 3,
  Emergency = 4,
}

export const PROPOSAL_TYPE_LABELS: Record<ProposalType, string> = {
  [ProposalType.Standard]: 'Standard',
  [ProposalType.Protocol]: 'Protocol',
  [ProposalType.ReservePolicy]: 'Reserve Policy',
  [ProposalType.Constitutional]: 'Constitutional',
  [ProposalType.Emergency]: 'Emergency',
};

export type ProposalStatus = 'Active' | 'Passed' | 'Failed' | 'Executed' | 'Cancelled';

export interface Proposal {
  id: number;
  type: ProposalType;
  proposer: DID;
  title: string;
  description: string;
  status: ProposalStatus;
  votesFor: number;
  votesAgainst: number;
  quorum: number;
  threshold: number;
  createdAt: Date;
  endsAt: Date;
  /** Undefined if caller has not voted */
  myVote?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Network / peer state
// ─────────────────────────────────────────────────────────────────────────────

export interface NodeStatus {
  connected: boolean;
  peerCount: number;
  syncHeight: number;
  chainHeight: number;
  /** Sync progress 0–1 */
  syncProgress: number;
  epochId: number;
}
