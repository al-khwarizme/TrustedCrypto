# @trustedcrypto/sdk

TypeScript SDK for interacting with the TrustedCrypto smart-contract suite. Wraps all nine on-chain contracts with typed, ergonomic helpers built on [ethers.js v6](https://docs.ethers.org/v6/).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../LICENSE)

---

## Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Identity Management](#identity-management)
- [TRCClient API](#trcclient-api)
  - [TRC-G (Gold token)](#trc-g-gold-token)
  - [TRC-U (Utility token)](#trc-u-utility-token)
  - [WalletCap](#walletcap)
  - [Governance](#governance)
  - [PoC Rewards](#poc-rewards)
  - [Reserve](#reserve)
- [Types & Enums](#types--enums)
- [ABIs](#abis)
- [Building](#building)
- [Contributing](#contributing)

---

## Installation

```bash
npm install @trustedcrypto/sdk ethers
# or
yarn add @trustedcrypto/sdk ethers
```

> **Peer dependency**: ethers v6 (`^6.0.0`) must be installed separately.

---

## Quick Start

```ts
import { TRCClient, TRCIdentity } from "@trustedcrypto/sdk";
import { JsonRpcProvider, Wallet } from "ethers";

// 1. Load your deployed contract addresses (output of scripts/deploy.ts)
import addresses from "./deployments/sepolia.json";

// 2. Set up ethers provider + signer
const provider = new JsonRpcProvider("https://sepolia.infura.io/v3/<YOUR_KEY>");
const signer   = new Wallet(process.env.PRIVATE_KEY!, provider);

// 3. Instantiate the SDK client
const client = new TRCClient({
  provider,
  signer,
  addresses: addresses.contracts,
});

// 4. Read balances
const goldBalance    = await client.gold.balanceOf(signer.address);
const utilityBalance = await client.utility.balanceOf(signer.address);
console.log("TRC-G:", TRCClient.formatAmount(goldBalance));
console.log("TRC-U:", TRCClient.formatAmount(utilityBalance));

// 5. Check reserve backing
console.log("Reserve ratio:", await client.reserveRatioPercent()); // e.g. "100.0000%"
```

---

## Identity Management

`TRCIdentity` handles key generation and DID derivation, matching the Go protocol layer exactly. Each DID is formatted as `did:trc:0x<20-byte-address>` and stored on-chain as `keccak256(didString)`.

```ts
import { TRCIdentity } from "@trustedcrypto/sdk";

// Generate a new identity (save the private key securely!)
const identity = TRCIdentity.generate();
console.log(identity.didString); // did:trc:0xabc...
console.log(identity.didHash);   // 0x... (bytes32 used in contracts)
console.log(identity.address);   // EVM wallet address

// Restore from private key
const restored = TRCIdentity.fromPrivateKey(process.env.PRIVATE_KEY!);

// Restore from BIP-39 mnemonic
const fromMnemonic = TRCIdentity.fromMnemonic(
  "abandon abandon abandon ... about",
  "m/44'/60'/0'/0/0"  // optional, this is the default path
);

// Connect to a provider for on-chain transactions
const signer = identity.connect(provider);

// Sign a contribution proof for PoC submission
const { proofHash, signature } = await identity.signContributionProof(
  ContributionType.NODE_UPTIME,  // type
  100,                            // points
  BigInt(Date.now())              // nonce
);
```

---

## TRCClient API

### TRC-G (Gold token)

```ts
// Read-only
const balance    = await client.gold.balanceOf(address);      // bigint (18 decimals)
const supply     = await client.gold.totalSupply();            // bigint
const reserve    = await client.gold.gramsInReserve();        // bigint
const ratio      = await client.gold.reserveRatio();          // bigint (1e18 = 100%)
const allowance  = await client.gold.allowance(owner, spender);

// Write (requires signer)
await client.gold.transfer(recipient, TRCClient.parseAmount("1.5"));
await client.gold.approve(spender, TRCClient.parseAmount("100"));

// Events
client.gold.onTransfer((from, to, value) => {
  console.log(`Transfer: ${from} → ${to}: ${TRCClient.formatAmount(value)} TRC-G`);
});

client.gold.onGoldMinted((to, amount, proof, newReserve) => {
  console.log(`Minted ${TRCClient.formatAmount(amount)} TRC-G to ${to}`);
});
```

### TRC-U (Utility token)

```ts
// Read-only
const balance = await client.utility.balanceOf(address);
const pool    = await client.utility.utilityPoolBalance();

// Write (requires signer)
await client.utility.transfer(recipient, TRCClient.parseAmount("50"));

// Redeem TRC-U for a commodity voucher
const WHEAT_KG = ethers.keccak256(ethers.toUtf8Bytes("WHEAT_KG"));
await client.utility.redeemCommodity(TRCClient.parseAmount("200"), WHEAT_KG);
```

### WalletCap

The `WalletCapClient` is always read-only (aggregate cap enforcement happens inside the tokens).

```ts
// Current network-wide cap per DID
const cap = await client.walletCap.getCap(); // bigint

// Cap info for a specific DID
const info = await client.walletCap.getCapInfo(identity.didHash);
console.log("Current balance:", TRCClient.formatAmount(info.currentBalance));
console.log("Remaining room:", TRCClient.formatAmount(info.remaining));
console.log("Can receive 500?", info.canReceive(TRCClient.parseAmount("500")));

// Look up wallet addresses for a DID
const addresses = await client.walletCap.getAddressesForDID(identity.didHash);

// Look up DID for an address
const didHash = await client.walletCap.getDIDForAddress(walletAddress);
```

### Governance

```ts
import { ProposalType, ProposalState } from "@trustedcrypto/sdk";

// Create a proposal (signer required; proposer must have a registered DID)
const tx = await client.governance.propose(
  ProposalType.STANDARD,
  "Increase mining reward pool allocation to 65%",
  "0x",              // no on-chain execution data for text proposals
  ethers.ZeroAddress
);
const receipt = await tx.wait();

// Get proposal state
const state = await client.governance.getProposalState(1n);
// ProposalState.ACTIVE, .SUCCEEDED, .EXECUTED, etc.

// Vote
await client.governance.vote(
  1n,                  // proposalId
  identity.didHash,    // voterDID (bytes32)
  true                 // support
);

// Get vote counts
const { votesFor, votesAgainst } = await client.governance.getVoteTotals(1n);

// Queue and execute after timelock
await client.governance.queue(1n);
// ... wait for timelock ...
await client.governance.execute(1n);

// Subscribe to events
client.governance.onVoteCast((proposalId, voterDID, support) => {
  console.log(`Vote on ${proposalId}: ${support ? "FOR" : "AGAINST"}`);
});
```

### PoC Rewards

```ts
// Read contribution score for a DID
const score = await client.pocRewards.getScore(identity.didHash);

// Listen for contribution events
client.pocRewards.onContributionSubmitted((did, ctype, points, proofHash) => {
  console.log(`Contribution: DID=${did}, type=${ctype}, pts=${points}`);
});
```

> **Note**: Contribution submission (`submitContribution`) is called by the Go protocol node, not directly by client applications. Use `TRCIdentity.signContributionProof` to create the proof payload for the node RPC.

### Reserve

```ts
// Read vault state
const goldInVault = await client.reserve.goldInVault();
console.log("Gold in vault:", TRCClient.formatAmount(goldInVault), "grams");

// Request gold redemption (burns TRC-G)
// encryptedDeliveryAddress = keccak256 of AES-encrypted delivery details
const encryptedAddr = ethers.keccak256(encryptedDeliveryBytes);
await client.reserve.requestRedemption(
  TRCClient.parseAmount("10"),  // 10 grams
  encryptedAddr
);
```

---

## Types & Enums

```ts
import {
  ContributionType,  // NODE_UPTIME | ORACLE_DATA | GOVERNANCE_VOTE | PHYSICAL_VERIFICATION | TRANSACTION_ACTIVITY
  ProposalType,      // STANDARD | PROTOCOL | RESERVE_POLICY | CONSTITUTIONAL | EMERGENCY
  ProposalState,     // PENDING | ACTIVE | SUCCEEDED | DEFEATED | QUEUED | EXECUTED | CANCELLED
  OracleAssets,      // { GOLD_USD, WHEAT_KG_USD, RICE_KG_USD, … }
} from "@trustedcrypto/sdk";

import type {
  ContractAddresses,  // address map for all 9 contracts
  NetworkConfig,      // { provider, signer?, addresses }
  CapInfo,            // { cap, currentBalance, remaining, canReceive() }
} from "@trustedcrypto/sdk";
```

---

## ABIs

Human-readable ABIs for all contracts are exported for direct use with `ethers.Contract`:

```ts
import { TRCGoldABI, WalletCapABI } from "@trustedcrypto/sdk";
import { Contract } from "ethers";

const gold = new Contract(goldAddress, TRCGoldABI, provider);
```

Full JSON ABIs are generated by the Hardhat build at `contracts/typechain-types/` after running:

```bash
cd contracts && npx hardhat compile
```

---

## Building

```bash
cd sdk
npm install          # installs devDependencies (TypeScript)
npm run build        # compiles to dist/
npm run typecheck    # type-check without emitting
```

---

## Contributing

1. Fork the repo and create a feature branch off `main`
2. Make changes inside `sdk/src/`
3. Run `npm run typecheck` — must pass with zero errors
4. Submit a pull request against `main`

See the root [README](../README.md) and [whitepaper](../whitepaper.md) for architecture context.
