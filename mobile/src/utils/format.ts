/**
 * src/utils/format.ts
 *
 * Formatting helpers for amounts, addresses, and dates.
 */

import { WEI } from '../constants';

/** Format a wei-amount to a human-readable decimal string (up to 6 dp). */
export function formatToken(amount: bigint, decimals = 6): string {
  if (amount === 0n) {
    return '0';
  }
  const whole = amount / WEI;
  const frac = amount % WEI;
  if (frac === 0n) {
    return whole.toString();
  }
  const fracStr = frac.toString().padStart(18, '0').slice(0, decimals).replace(/0+$/, '');
  return fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
}

/** Shorten an address: "0x1234...abcd" */
export function shortAddress(address: string): string {
  if (address.length < 12) {
    return address;
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Shorten a DID: "did:trc:0x1234...abcd" */
export function shortDID(did: string): string {
  const addr = did.replace('did:trc:', '');
  return `did:trc:${shortAddress(addr)}`;
}

/** Format a Date as "9 May 2026 14:30" */
export function formatDate(date: Date): string {
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format a number of seconds as "2h 34m" */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const m = Math.floor(seconds / 60);
  if (m < 60) {
    return `${m}m`;
  }
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

/** Convert a bigint USD price (18-decimal) to a human-readable "$1,234.56" */
export function formatUsd(price: bigint): string {
  const dollars = Number(price / WEI);
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollars);
}

/** Format contribution points with thousands separator */
export function formatPoints(pts: number): string {
  return new Intl.NumberFormat().format(pts);
}
