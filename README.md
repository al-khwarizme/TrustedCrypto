# TrustedCrypto (TRC)

> **An asset-backed, community-owned digital currency for equitable global exchange.**  
> One verified person · one vote · one wallet cap · real-world backing.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Go](https://img.shields.io/badge/Go-1.22-blue.svg)](./protocol)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.24-purple.svg)](./contracts)
[![Tests](https://img.shields.io/badge/tests-47%20Solidity%20%7C%2019%20Go-brightgreen.svg)](#proof-of-concept-test-results)

---

## Table of Contents

1. [What is TrustedCrypto?](#what-is-trustedcrypto)
2. [Architecture Overview](#architecture-overview)
3. [Repository Structure](#repository-structure)
4. [Smart Contracts (Solidity)](#smart-contracts-solidity)
5. [Protocol Layer (Go)](#protocol-layer-go)
6. [Mobile Client (React Native)](#mobile-client-react-native)
7. [SDK](#sdk)
8. [Proof-of-Concept Test Results](#proof-of-concept-test-results)
9. [Getting Started](#getting-started)
10. [Contributing](#contributing)
11. [Whitepaper](#whitepaper)
12. [License](#license)

---

## What is TrustedCrypto?

TrustedCrypto is a gold-backed cooperative currency designed to correct the structural failures of existing cryptocurrencies — speculation, wealth concentration, and inaccessibility.

**Four pillars:**

| Pillar | Mechanism |
|--------|-----------|
| **Real-world backing** | Every TRC-Gold token is backed by independently audited physical gold and commodity reserves |
| **Accessible mining** | Any smartphone earns TRC-Utility tokens through Proof-of-Contribution (uptime, oracle data, governance votes) |
| **Anti-monopoly caps** | Identity-linked wallet caps enforced on-chain prevent any entity from accumulating beyond a fixed ceiling |
| **Cooperative governance** | One verified human · one vote. Wealth does not purchase governance power |

Read the full design rationale in the **[Whitepaper](./whitepaper.md)**.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Mobile Client (RN)                   │
│  Wallet · Mining · Oracle · Governance · Onboarding    │
└──────────────────────┬──────────────────────────────────┘
                       │ JSON-RPC / HTTP
┌──────────────────────▼──────────────────────────────────┐
│               Go Protocol Layer                         │
│  Full Node ─ Light Node ─ Consensus (PoC) ─ Oracle     │
│  Identity (DID + zkPoH) ─ Network (P2P SPV)            │
└──────────────────────┬──────────────────────────────────┘
                       │ EVM calls
┌──────────────────────▼──────────────────────────────────┐
│            Smart Contracts (Solidity 0.8.24)            │
│  TRCGold · TRCUtility · WalletCap · PoCRewards         │
│  Governance · Reserve · ProducerPledge · Commons       │
└─────────────────────────────────────────────────────────┘
```

---

## Repository Structure

```
TrustedCrypto/
├── whitepaper.md           ← Full design document
├── LICENSE                 ← MIT
├── contracts/              ← Solidity contracts + Hardhat tests
│   ├── contracts/
│   │   ├── TRCGold.sol
│   │   ├── TRCUtility.sol
│   │   ├── WalletCap.sol
│   │   ├── PoCRewards.sol
│   │   ├── Governance.sol
│   │   ├── Reserve.sol
│   │   ├── ProducerPledge.sol
│   │   ├── SurplusConversion.sol
│   │   └── Commons.sol
│   ├── test/
│   │   ├── TRCGold.test.ts   (23 tests)
│   │   └── WalletCap.test.ts (24 tests)
│   ├── hardhat.config.ts
│   └── package.json
├── protocol/               ← Go protocol layer
│   ├── types/              ← Shared types (DID, Block, Contribution)
│   ├── identity/           ← Key management, DID documents, zkPoH stub
│   ├── consensus/          ← PoC engine, validator selection, rewards
│   ├── oracle/             ← Price aggregation, vault attestation
│   ├── network/            ← P2P peer management, SPV light client
│   ├── cmd/node/           ← Full node binary
│   └── cmd/lightnode/      ← Light node binary
├── mobile/                 ← React Native 0.74 mobile client
│   └── src/
│       ├── services/       ← identity, node RPC, mining, oracle, governance
│       ├── screens/        ← Wallet, Send, Receive, Mine, Oracle, Governance
│       ├── navigation/     ← Stack + bottom-tab navigator
│       ├── theme/          ← Gold-accented design system
│       └── utils/          ← Formatting helpers
└── sdk/                    ← TypeScript SDK (in progress)
```

---

## Smart Contracts (Solidity)

| Contract | Purpose |
|----------|---------|
| `TRCGold.sol` | ERC-20 gold-backed token with mint/burn audit controls and reserve ratio |
| `TRCUtility.sol` | ERC-20 utility token distributed as PoC mining rewards |
| `WalletCap.sol` | Identity-linked per-wallet holding cap (4 tiers: Standard → Institutional) |
| `PoCRewards.sol` | On-chain Proof-of-Contribution score ledger and TRC-U distribution |
| `Governance.sol` | One-person-one-vote proposal and voting system |
| `Reserve.sol` | Multi-sig controlled gold/commodity reserve manager |
| `ProducerPledge.sol` | Three-verifier commodity pledge workflow |
| `SurplusConversion.sol` | TRC-G ↔ TRC-U conversion at oracle rate |
| `Commons.sol` | Community investment pool governor |

**Requirements:** Node ≥ 18, Hardhat ^2.20, Solidity 0.8.24 (`evmVersion: cancun`)

---

## Protocol Layer (Go)

Built with Go 1.22 and `github.com/btcsuite/btcd/btcec/v2` (secp256k1 — same curve as the mobile client).

| Package | Responsibility |
|---------|---------------|
| `types` | Shared primitives: `DID`, `Hash`, `BlockHeader`, `ContributionProof` |
| `identity` | secp256k1 key pairs, DID documents, zkPoH credential issuance |
| `consensus` | PoC engine: rolling score, weekly decay, type caps, validator selection, Merkle proofs, epoch reward distribution |
| `oracle` | Price window aggregation, outlier rejection (2σ), vault attestation store |
| `network` | P2P peer management, SPV header chain, Bloom-filter tx proofs |
| `cmd/node` | Full-node entry point |
| `cmd/lightnode` | Light-node entry point |

---

## Mobile Client (React Native)

React Native 0.74.1 + TypeScript. Key libraries:

- **ethers v6** — secp256k1 key derivation, EVM address, keccak256/sha256 matching Go identity package  
- **react-native-encrypted-storage** — private key stored in Android Keystore / iOS Secure Enclave  
- **React Navigation v6** — bottom tabs + modal stack  
- **react-native-background-fetch** — hourly uptime proofs, 15-min oracle price submissions  
- **react-native-qrcode-svg / react-native-camera** — QR display and scan  

**Screens:** Onboarding → Wallet → Send/Receive/ScanQR → Mining → Oracle → Governance

---

## SDK

TypeScript SDK for integrating TRC into third-party applications. Located in `sdk/src/` — currently scaffolded; contributions welcome.

---

## Proof-of-Concept Test Results

All tests run against local Hardhat network and in-process Go — no external dependencies.

### Smart Contracts — Hardhat (Solidity 0.8.24, EVM Cancun)

```
  TRCGold
    Deployment               ✓  3 tests
    mint()                   ✓  7 tests  (includes double-mint prevention)
    burn()                   ✓  3 tests
    auditFreeze/Unfreeze     ✓  4 tests
    reserveRatio()           ✓  2 tests
    ERC-20 transfers         ✓  3 tests  (cap-aware)

  WalletCap
    registerAddress()        ✓  7 tests
    revokeAddress()          ✓  3 tests
    getCap() — 4 tiers       ✓  4 tests
    enforceCapOnTransfer()   ✓  4 tests
    Multi-wallet prevention  ✓  3 tests
    checkCap()               ✓  3 tests

  47 passing (989ms)
```

### Go Protocol Layer

```
  types     ✓  5 tests  — DID determinism, uniqueness, Hex, BlockHeaderHash
  identity  ✓  6 tests  — KeyPair, Address, Sign/Verify, DIDDocument, zkPoH nullifier
  consensus ✓  9 tests  — SubmitContribution, replay protection, validator set, Merkle proof, epoch rewards
  oracle    ✓  5 tests  — Submit, invalid/unsupported asset, LastPrice, BuildCommitment
```

### Mobile Client

TypeScript compiles without errors (`tsc --noEmit`). Runtime testing requires a physical device or emulator with React Native environment.

---

## Getting Started

### Smart Contracts

```bash
cd contracts
npm install
npx hardhat test          # run all 47 tests
npx hardhat compile       # compile to artifacts/
```

> Requires `evmVersion: "cancun"` (already set in `hardhat.config.ts`) for OpenZeppelin v5 `Bytes.sol`.

### Protocol (Go)

```bash
cd protocol
go mod download
go build ./...            # compile all binaries
go test ./...             # run all tests

# Run a local full node (default port 18080)
go run ./cmd/node

# Run a light node
go run ./cmd/lightnode
```

### Mobile Client

```bash
cd mobile
npm install

# iOS
npx pod-install ios
npx react-native run-ios

# Android
npx react-native run-android
```

---

## Contributing

TrustedCrypto is a public cooperative. Contributions of all kinds are welcome.

1. **Fork** this repository
2. Create a branch: `git checkout -b feat/your-feature`
3. Write tests for any new behaviour
4. Open a pull request against `main` — describe your change and its motivation
5. All contributors agree to the MIT license

Areas especially needing help:
- ZK circuit for Proof-of-Humanity (`identity/` stub)
- Cross-platform React Native testing
- SDK completion (`sdk/`)
- Translation of the whitepaper
- Economic modelling and simulation

**Code of conduct:** In the spirit of the cooperative model, contributors are expected to engage respectfully and in good faith.

---

## Whitepaper

The full design rationale — economic model, governance structure, security analysis, asset backing, and technical architecture — is in **[whitepaper.md](./whitepaper.md)**.

*White Paper v0.1 · May 2026 · Authored under the name Al-Khwarizme*

---

## License

[MIT](./LICENSE) — Copyright © 2026 Al-Khwarizme

Free to use, fork, modify, and distribute. This project belongs to everyone.
