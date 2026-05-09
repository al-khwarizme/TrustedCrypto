/**
 * src/constants/index.ts
 *
 * Chain constants matching the Go protocol layer.
 */

export const CHAIN_ID = 1;
export const BLOCKS_PER_EPOCH = 10_800; // 2-second blocks × 6 hours
export const EPOCH_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours
export const BLOCK_TIME_MS = 2_000;

/** Maximum TRC-G or TRC-U a single DID may hold (dynamic; this is the floor). */
export const WALLET_CAP_BPS_FLOOR = 10; // 0.01% of total supply

/** Mining resource limits */
export const CPU_CAP_PERCENT = 2;
export const BATTERY_CAP_PERCENT_PER_HOUR = 5;

/** Light node connects to at most 8 full-node peers */
export const MAX_LIGHT_PEERS = 8;

/** Oracle cycle: submit every 15 minutes */
export const ORACLE_CYCLE_MS = 15 * 60 * 1000;

/** Uptime proof submitted every hour */
export const UPTIME_INTERVAL_MS = 60 * 60 * 1000;

/** Points earned per hour of uptime (capped at 100/day) */
export const UPTIME_POINTS_PER_HOUR = 10;

// Contract addresses (testnet defaults — overridden by remote config in production)
export const CONTRACT_ADDRESSES = {
  TRC_GOLD: '0x0000000000000000000000000000000000000001',
  TRC_UTILITY: '0x0000000000000000000000000000000000000002',
  WALLET_CAP: '0x0000000000000000000000000000000000000003',
  POC_REWARDS: '0x0000000000000000000000000000000000000004',
  GOVERNANCE: '0x0000000000000000000000000000000000000005',
  COMMONS: '0x0000000000000000000000000000000000000006',
  RESERVE: '0x0000000000000000000000000000000000000007',
} as const;

/** 18-decimal multiplier */
export const WEI = BigInt('1000000000000000000');

/** Boot full-node peers (mainnet) */
export const BOOT_PEERS: string[] = [];

/** Encrypted-storage keys */
export const STORAGE_KEYS = {
  PRIVATE_KEY: 'trc.identity.privkey',
  DID_DOCUMENT: 'trc.identity.did',
  BOOT_PEERS_OVERRIDE: 'trc.network.boot_peers',
  ONBOARDING_DONE: 'trc.onboarding.done',
} as const;
