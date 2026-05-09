import type { Signer, Provider } from "ethers";

/** Addresses of all deployed TrustedCrypto contracts on a given network. */
export interface ContractAddresses {
  trcGold: string;
  trcUtility: string;
  walletCap: string;
  governance: string;
  pocRewards: string;
  reserve: string;
  surplusConversion: string;
  producerPledge: string;
  commons: string;
}

/** Network configuration passed to TRCClient. */
export interface NetworkConfig {
  /** ethers.js provider (JsonRpcProvider, BrowserProvider, etc.) */
  provider: Provider;
  /** Signer for transactions. Optional for read-only clients. */
  signer?: Signer;
  /** Deployed contract addresses for this network. */
  addresses: ContractAddresses;
}

/**
 * On-chain contribution types — must match PoCRewards.sol ContributionType enum.
 * Index values are used directly in contract calls.
 */
export enum ContributionType {
  NODE_UPTIME = 0,
  ORACLE_DATA = 1,
  GOVERNANCE_VOTE = 2,
  PHYSICAL_VERIFICATION = 3,
  TRANSACTION_ACTIVITY = 4,
}

/**
 * On-chain proposal types — must match Governance.sol ProposalType enum.
 */
export enum ProposalType {
  STANDARD = 0,
  PROTOCOL = 1,
  RESERVE_POLICY = 2,
  CONSTITUTIONAL = 3,
  EMERGENCY = 4,
}

/**
 * On-chain proposal states — must match Governance.sol ProposalState enum.
 */
export enum ProposalState {
  PENDING = 0,
  ACTIVE = 1,
  SUCCEEDED = 2,
  DEFEATED = 3,
  QUEUED = 4,
  EXECUTED = 5,
  CANCELLED = 6,
}

/** Supported oracle asset identifiers — must match oracle/oracle.go constants. */
export const OracleAssets = {
  GOLD_USD: "XAU/USD",
  WHEAT_KG_USD: "WHEAT_KG_USD",
  RICE_KG_USD: "RICE_KG_USD",
  CRUDE_OIL_BBL_USD: "WTI_BBL_USD",
  COPPER_KG_USD: "COPPER_KG_USD",
  SOLAR_KWH_USD: "SOLAR_KWH_USD",
} as const;

export type OracleAsset = (typeof OracleAssets)[keyof typeof OracleAssets];

/** Result from a WalletCap query. */
export interface CapInfo {
  cap: bigint;
  currentBalance: bigint;
  remaining: bigint;
  canReceive: (amount: bigint) => boolean;
}

/** A submitted contribution proof. */
export interface ContributionProof {
  did: string;
  type: ContributionType;
  points: number;
  proofHash: string;
  signature: string;
}

/** A governance proposal. */
export interface Proposal {
  id: bigint;
  type: ProposalType;
  description: string;
  state: ProposalState;
  votesFor: bigint;
  votesAgainst: bigint;
  executionTarget: string;
  executionData: string;
}
