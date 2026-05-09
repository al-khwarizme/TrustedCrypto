/**
 * src/services/mining.ts
 *
 * Proof-of-Contribution (PoC) mining service.
 *
 * Responsibilities:
 *   - Maintain a per-device nonce counter (AsyncStorage)
 *   - Build and sign uptime proof + oracle-price proofs
 *   - Submit contributions to the full-node via HTTP
 *   - Provide session telemetry for the Mining screen
 *   - Integrate react-native-background-fetch for periodic tasks
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import BackgroundFetch from 'react-native-background-fetch';
import { ethers } from 'ethers';
import {
  buildProofHash,
  buildDIDDocument,
  loadOrCreateWallet,
  signContributionPreimage,
  hashDID,
} from './identity';
import { submitContribution, getContributionScore } from './node';
import {
  UPTIME_INTERVAL_MS,
  UPTIME_POINTS_PER_HOUR,
  ORACLE_CYCLE_MS,
  STORAGE_KEYS,
} from '../constants';
import { ContributionType } from '../types';
import type { ContributionProof, ContributionScore, MiningSession, OracleAsset, PriceReport } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Nonce management
// ─────────────────────────────────────────────────────────────────────────────

const NONCE_KEY = 'trc.mining.nonce';

async function nextNonce(): Promise<number> {
  const raw = await AsyncStorage.getItem(NONCE_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  await AsyncStorage.setItem(NONCE_KEY, String(n + 1));
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Proof builders
// ─────────────────────────────────────────────────────────────────────────────

/** Build a signed uptime contribution proof. */
async function buildUptimeProof(wallet: ethers.Wallet): Promise<ContributionProof> {
  const did = buildDIDDocument(wallet);
  const didHash = hashDID(did.id);
  const nonce = await nextNonce();
  const timestamp = new Date();

  const proofHash = buildProofHash(
    didHash,
    ContributionType.NodeUptime,
    UPTIME_POINTS_PER_HOUR,
    timestamp,
    nonce,
    new Uint8Array(0),
  );

  const signature = await signContributionPreimage(wallet, proofHash, didHash);

  return {
    did: did.id,
    type: ContributionType.NodeUptime,
    points: UPTIME_POINTS_PER_HOUR,
    timestamp,
    nonce,
    proofHash,
    signature,
    proofData: '',
  };
}

/** Build a signed oracle price contribution proof. */
async function buildOraclePriceProof(
  wallet: ethers.Wallet,
  report: PriceReport,
): Promise<ContributionProof> {
  const did = buildDIDDocument(wallet);
  const didHash = hashDID(did.id);
  const nonce = await nextNonce();
  const timestamp = new Date();

  // Encode the price report as proof data (big-endian uint256 + asset bytes)
  const priceHex = report.price.toString(16).padStart(64, '0');
  const proofData = ethers.getBytes('0x' + priceHex);

  const proofHash = buildProofHash(
    didHash,
    ContributionType.OracleData,
    10, // oracle data earns 10 pts per cycle
    timestamp,
    nonce,
    proofData,
  );

  const signature = await signContributionPreimage(wallet, proofHash, didHash);

  return {
    did: did.id,
    type: ContributionType.OracleData,
    points: 10,
    timestamp,
    nonce,
    proofHash,
    signature,
    proofData: '0x' + priceHex,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Session state (in-memory; read by the Mining screen)
// ─────────────────────────────────────────────────────────────────────────────

let _session: MiningSession | null = null;

export function getActiveMiningSession(): MiningSession | null {
  return _session;
}

export async function refreshContributionScore(): Promise<ContributionScore | null> {
  try {
    const wallet = await loadOrCreateWallet();
    const did = buildDIDDocument(wallet);
    return await getContributionScore(did.id);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Submit helpers (exported for direct use from screens / oracle service)
// ─────────────────────────────────────────────────────────────────────────────

export async function submitUptimeProof(): Promise<void> {
  const wallet = await loadOrCreateWallet();
  const proof = await buildUptimeProof(wallet);
  await submitContribution(proof);
  if (_session) {
    _session.pointsEarned += proof.points;
    _session.lastProofAt = new Date();
  }
}

export async function submitOraclePriceProof(report: PriceReport): Promise<void> {
  const wallet = await loadOrCreateWallet();
  const proof = await buildOraclePriceProof(wallet, report);
  await submitContribution(proof);
  if (_session) {
    _session.pointsEarned += proof.points;
    _session.lastProofAt = new Date();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Session lifecycle
// ─────────────────────────────────────────────────────────────────────────────

export async function startMiningSession(oracleAsset?: OracleAsset): Promise<void> {
  _session = {
    startedAt: new Date(),
    pointsEarned: 0,
    oracleAsset: oracleAsset ?? null,
    lastProofAt: null,
    active: true,
  };
}

export function stopMiningSession(): void {
  if (_session) {
    _session.active = false;
  }
  _session = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Background fetch integration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register background periodic tasks.
 * Call once from App.tsx after identity is bootstrapped.
 */
export async function configureMiningBackgroundFetch(): Promise<void> {
  await BackgroundFetch.configure(
    {
      minimumFetchInterval: Math.floor(UPTIME_INTERVAL_MS / 60_000), // minutes
      stopOnTerminate: false,
      startOnBoot: true,
      enableHeadless: true,
    },
    async (taskId) => {
      try {
        await submitUptimeProof();
      } catch {
        // Best-effort; the node will not count the hour if absent
      }
      BackgroundFetch.finish(taskId);
    },
    (taskId) => {
      BackgroundFetch.finish(taskId);
    },
  );

  // Schedule a shorter oracle task if the device has a configured asset
  const storedPeers = await AsyncStorage.getItem(STORAGE_KEYS.BOOT_PEERS_OVERRIDE);
  if (storedPeers) {
    await BackgroundFetch.scheduleTask({
      taskId: 'trc.oracle.price',
      delay: ORACLE_CYCLE_MS,
      periodic: true,
    });
  }
}
