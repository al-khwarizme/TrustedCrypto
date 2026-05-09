/**
 * src/services/node.ts
 *
 * Light-node bridge: communicates with a full-node peer over HTTP/WebSocket
 * (the Go light-node runs in the background and exposes a local RPC port,
 * or for platforms where the Go binary cannot be embedded, this module
 * speaks directly to a trusted full-node gateway).
 *
 * API surface matches the Go protocol layer.
 */

import type {
  AggregatedPrice,
  ContributionProof,
  ContributionScore,
  NodeStatus,
  OracleAsset,
  PriceReport,
  Proposal,
  TxReceipt,
  TxRequest,
  WalletState,
} from '../types';
import type { Address } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

let _baseUrl = 'http://127.0.0.1:18080'; // local light-node RPC
let _gatewayUrl = 'https://gateway.trustedcrypto.network'; // fallback full-node

export function configureNodeRPC(localUrl: string, gatewayUrl: string): void {
  _baseUrl = localUrl;
  _gatewayUrl = gatewayUrl;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────────────────────

async function rpc<T>(path: string, body?: unknown, useGateway = false): Promise<T> {
  const base = useGateway ? _gatewayUrl : _baseUrl;
  const url = `${base}${path}`;
  const opts: RequestInit = {
    method: body !== undefined ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`RPC ${path} → ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

/** Try local node first; fall back to gateway on failure. */
async function rpcWithFallback<T>(path: string, body?: unknown): Promise<T> {
  try {
    return await rpc<T>(path, body, false);
  } catch {
    return rpc<T>(path, body, true);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Node / sync status
// ─────────────────────────────────────────────────────────────────────────────

export async function getNodeStatus(): Promise<NodeStatus> {
  return rpcWithFallback<NodeStatus>('/status');
}

// ─────────────────────────────────────────────────────────────────────────────
// Wallet
// ─────────────────────────────────────────────────────────────────────────────

export async function getWalletState(address: Address): Promise<WalletState> {
  return rpcWithFallback<WalletState>(`/wallet/${address}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Transactions
// ─────────────────────────────────────────────────────────────────────────────

export async function sendTransaction(
  signedTx: string,
  req: TxRequest,
): Promise<TxReceipt> {
  return rpcWithFallback<TxReceipt>('/tx/send', { signedTx, ...req });
}

export async function getTxReceipt(hash: string): Promise<TxReceipt> {
  return rpcWithFallback<TxReceipt>(`/tx/${hash}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Proof-of-Contribution
// ─────────────────────────────────────────────────────────────────────────────

export async function submitContribution(proof: ContributionProof): Promise<void> {
  await rpcWithFallback<void>('/contrib/submit', proof);
}

export async function getContributionScore(did: string): Promise<ContributionScore> {
  return rpcWithFallback<ContributionScore>(`/contrib/score/${encodeURIComponent(did)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Oracle
// ─────────────────────────────────────────────────────────────────────────────

export async function submitPriceReport(report: PriceReport): Promise<void> {
  await rpcWithFallback<void>('/oracle/report', report);
}

export async function getLatestPrice(asset: OracleAsset): Promise<AggregatedPrice> {
  return rpcWithFallback<AggregatedPrice>(`/oracle/price/${encodeURIComponent(asset)}`);
}

export async function getAllPrices(): Promise<AggregatedPrice[]> {
  return rpcWithFallback<AggregatedPrice[]>('/oracle/prices');
}

// ─────────────────────────────────────────────────────────────────────────────
// Governance
// ─────────────────────────────────────────────────────────────────────────────

export async function getActiveProposals(): Promise<Proposal[]> {
  return rpcWithFallback<Proposal[]>('/governance/proposals?status=Active');
}

export async function getAllProposals(): Promise<Proposal[]> {
  return rpcWithFallback<Proposal[]>('/governance/proposals');
}

export async function castVote(
  proposalId: number,
  support: boolean,
  signature: string,
  did: string,
): Promise<void> {
  await rpcWithFallback<void>('/governance/vote', { proposalId, support, signature, did });
}
