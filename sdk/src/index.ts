/**
 * @trustedcrypto/sdk
 *
 * TypeScript SDK for integrating TrustedCrypto (TRC) into applications.
 *
 * Primary entry points:
 *   - `TRCClient`   — unified contract interface (gold, utility, governance, …)
 *   - `TRCIdentity` — key generation, DID derivation, contribution proof signing
 *
 * @packageDocumentation
 */

// ── Core client ──────────────────────────────────────────────────────────────
export {
  TRCClient,
  TRCGoldClient,
  TRCUtilityClient,
  WalletCapClient,
  GovernanceClient,
  PoCRewardsClient,
  ReserveClient,
  ethers,
} from "./contracts";

// ── Identity ─────────────────────────────────────────────────────────────────
export { TRCIdentity } from "./identity";

// ── Types ────────────────────────────────────────────────────────────────────
export type {
  ContractAddresses,
  NetworkConfig,
  CapInfo,
  OracleAsset,
} from "./types";

export {
  ContributionType,
  ProposalType,
  ProposalState,
  OracleAssets,
} from "./types";

// ── ABIs (useful for direct ethers.Contract use) ─────────────────────────────
export {
  TRCGoldABI,
  TRCUtilityABI,
  WalletCapABI,
  GovernanceABI,
  PoCRewardsABI,
  ReserveABI,
  CommonsABI,
} from "./abis";
