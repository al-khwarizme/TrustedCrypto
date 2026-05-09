/**
 * src/services/governance.ts
 *
 * Governance interactions.
 * Reads proposals from the node HTTP API; sends votes signed by the device key.
 */

import { ethers } from 'ethers';
import { getAllProposals, getActiveProposals, castVote as castVoteRpc } from './node';
import { buildDIDDocument, loadOrCreateWallet, signHash } from './identity';
import type { Proposal } from '../types';

export async function fetchProposals(activeOnly = false): Promise<Proposal[]> {
  return activeOnly ? getActiveProposals() : getAllProposals();
}

/** Cast a governance vote.
 *
 * Signs: keccak256(abi.encode(proposalId, support))
 * Matching the Governance.sol verifyVoteSignature check.
 */
export async function castVote(proposalId: number, support: boolean): Promise<void> {
  const wallet = await loadOrCreateWallet();
  const did = buildDIDDocument(wallet);

  // Deterministic vote hash (proposalId as uint256 + support as uint8)
  const encoded = ethers.solidityPacked(
    ['uint256', 'bool'],
    [proposalId, support],
  );
  const msgHash = ethers.keccak256(encoded);
  const signature = await signHash(wallet, msgHash);

  await castVoteRpc(proposalId, support, signature, did.id);
}
