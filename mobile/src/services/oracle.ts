/**
 * src/services/oracle.ts
 *
 * Oracle price report submission.
 * Builds a signed PriceReport, wraps it as a ContributionProof, then
 * fires both to the full-node RPC.
 */

import { buildDIDDocument, loadOrCreateWallet, signHash, hashDID } from './identity';
import { submitPriceReport as submitToNode } from './node';
import { submitOraclePriceProof } from './mining';
import type { OracleAsset, PriceReport } from '../types';
import { ethers } from 'ethers';
import { WEI } from '../constants';

/**
 * Submit a price observation.
 *
 * @param asset  The oracle asset (e.g. 'XAU/USD')
 * @param price  Human-readable price string, e.g. "1923.45"
 */
export async function submitPrice(asset: OracleAsset, priceStr: string): Promise<void> {
  const wallet = await loadOrCreateWallet();
  const did = buildDIDDocument(wallet);
  const didHash = hashDID(did.id);

  // Convert to 18-decimal integer
  const priceWei = ethers.parseUnits(priceStr, 18);

  // Sign the (asset, price, timestamp) tuple so the aggregator can verify
  const timestamp = Math.floor(Date.now() / 1000);
  const encoded = ethers.solidityPacked(
    ['string', 'uint256', 'uint256'],
    [asset, priceWei, timestamp],
  );
  const msgHash = ethers.keccak256(encoded);
  const signature = await signHash(wallet, msgHash);

  const report: PriceReport = {
    asset,
    price: priceWei,
    reporter: did.id,
    signature,
    timestamp: new Date(timestamp * 1000),
  };

  // Submit oracle data + contribution proof in parallel
  await Promise.all([
    submitToNode(report),
    submitOraclePriceProof(report),
  ]);
}
