/**
 * TrustedCrypto — Full Contract Deployment Script
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network <network>
 *
 * Networks:
 *   hardhat   — local ephemeral (default)
 *   localhost  — local node (npx hardhat node)
 *   sepolia   — Ethereum testnet (requires SEPOLIA_URL + DEPLOYER_KEY in .env)
 *   mainnet   — Ethereum mainnet (requires MAINNET_URL + DEPLOYER_KEY in .env)
 *
 * Environment variables (.env):
 *   DEPLOYER_KEY         — deployer private key (no 0x prefix)
 *   MINING_POOL_ADDRESS  — address of the mining rewards pool wallet (optional, defaults to deployer)
 *   LOTTERY_POOL_ADDRESS — address of the lottery pool wallet (optional, defaults to deployer)
 *   PROTOCOL_DEV_ADDRESS — address of the protocol dev wallet (optional, defaults to deployer)
 *   ETHERSCAN_API_KEY    — for on-chain verification (optional)
 */

import { ethers, network } from "hardhat";
import { writeFileSync, mkdirSync } from "fs";
import { join }             from "path";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function addr(contract: { target: string } | { getAddress(): Promise<string> } | string): string {
  if (typeof contract === "string") return contract;
  if ("target" in contract)         return contract.target as string;
  throw new Error("Unexpected contract type");
}

async function grantRole(
  contract: any,
  roleKey: string,
  grantee: string,
  label: string
) {
  const role = ethers.keccak256(ethers.toUtf8Bytes(roleKey));
  await (await contract.grantRole(role, grantee)).wait();
  console.log(`  ✓ ${label} → granted ${roleKey} to ${grantee.slice(0, 10)}…`);
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║   TrustedCrypto — Contract Deployment   ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`Network  : ${network.name}`);
  console.log(`Deployer : ${deployer.address}`);
  console.log(`Balance  : ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);

  // Pool addresses — default to deployer for local/testnet, should be multisigs on mainnet
  const miningPool  = process.env.MINING_POOL_ADDRESS  ?? deployer.address;
  const lotteryPool = process.env.LOTTERY_POOL_ADDRESS ?? deployer.address;
  const protocolDev = process.env.PROTOCOL_DEV_ADDRESS ?? deployer.address;

  // ── 1. WalletCap ─────────────────────────────────────────────────────────
  console.log("Deploying WalletCap…");
  const WalletCap = await ethers.getContractFactory("WalletCap");
  const walletCap = await WalletCap.deploy(deployer.address);
  await walletCap.waitForDeployment();
  console.log(`  ✓ WalletCap   : ${addr(walletCap)}`);

  // ── 2. TRCGold ───────────────────────────────────────────────────────────
  console.log("Deploying TRCGold…");
  const TRCGold = await ethers.getContractFactory("TRCGold");
  const trcGold = await TRCGold.deploy(deployer.address);
  await trcGold.waitForDeployment();
  console.log(`  ✓ TRCGold     : ${addr(trcGold)}`);

  // ── 3. TRCUtility ────────────────────────────────────────────────────────
  console.log("Deploying TRCUtility…");
  const TRCUtility = await ethers.getContractFactory("TRCUtility");
  const trcUtility = await TRCUtility.deploy(
    deployer.address,
    miningPool,
    lotteryPool,
    protocolDev
  );
  await trcUtility.waitForDeployment();
  console.log(`  ✓ TRCUtility  : ${addr(trcUtility)}`);

  // ── 4. Reserve ───────────────────────────────────────────────────────────
  console.log("Deploying Reserve…");
  const Reserve = await ethers.getContractFactory("Reserve");
  const reserve = await Reserve.deploy(deployer.address, addr(trcGold));
  await reserve.waitForDeployment();
  console.log(`  ✓ Reserve     : ${addr(reserve)}`);

  // ── 5. PoCRewards ────────────────────────────────────────────────────────
  console.log("Deploying PoCRewards…");
  const PoCRewards = await ethers.getContractFactory("PoCRewards");
  const pocRewards = await PoCRewards.deploy(deployer.address, addr(trcUtility));
  await pocRewards.waitForDeployment();
  console.log(`  ✓ PoCRewards  : ${addr(pocRewards)}`);

  // ── 6. ProducerPledge ────────────────────────────────────────────────────
  console.log("Deploying ProducerPledge…");
  const ProducerPledge = await ethers.getContractFactory("ProducerPledge");
  const producerPledge = await ProducerPledge.deploy(deployer.address, addr(trcUtility));
  await producerPledge.waitForDeployment();
  console.log(`  ✓ ProducerPledge : ${addr(producerPledge)}`);

  // ── 7. Governance ────────────────────────────────────────────────────────
  console.log("Deploying Governance…");
  const Governance = await ethers.getContractFactory("Governance");
  const governance = await Governance.deploy(deployer.address, addr(walletCap));
  await governance.waitForDeployment();
  console.log(`  ✓ Governance  : ${addr(governance)}`);

  // ── 8. SurplusConversion ─────────────────────────────────────────────────
  console.log("Deploying SurplusConversion…");
  const SurplusConversion = await ethers.getContractFactory("SurplusConversion");
  const surplusConversion = await SurplusConversion.deploy(
    deployer.address,
    addr(trcGold),
    addr(trcUtility),
    addr(reserve)
  );
  await surplusConversion.waitForDeployment();
  console.log(`  ✓ SurplusConversion : ${addr(surplusConversion)}`);

  // ── 9. Commons ───────────────────────────────────────────────────────────
  console.log("Deploying Commons…");
  const Commons = await ethers.getContractFactory("Commons");
  const commons = await Commons.deploy(deployer.address, addr(trcUtility));
  await commons.waitForDeployment();
  console.log(`  ✓ Commons     : ${addr(commons)}`);

  // ==========================================================================
  // Post-deployment role wiring
  // ==========================================================================

  console.log("\nWiring roles…");

  // WalletCap: grant TOKEN_ROLE to both token contracts
  await grantRole(walletCap, "TOKEN_ROLE", addr(trcGold),     "WalletCap");
  await grantRole(walletCap, "TOKEN_ROLE", addr(trcUtility),  "WalletCap");

  // TRCGold: wire wallet cap + grant RESERVE_ROLE to Reserve
  await (await trcGold.setWalletCapContract(addr(walletCap))).wait();
  console.log(`  ✓ TRCGold     → walletCapContract set`);
  await grantRole(trcGold, "RESERVE_ROLE",    addr(reserve),          "TRCGold");
  await grantRole(trcGold, "REDEMPTION_ROLE", addr(surplusConversion), "TRCGold");

  // TRCUtility: wire wallet cap + grant roles to minting contracts
  await (await trcUtility.setWalletCapContract(addr(walletCap))).wait();
  console.log(`  ✓ TRCUtility  → walletCapContract set`);
  await grantRole(trcUtility, "POC_REWARDS_ROLE",   addr(pocRewards),     "TRCUtility");
  await grantRole(trcUtility, "MINTER_ROLE",         addr(producerPledge), "TRCUtility");
  await grantRole(trcUtility, "REDEMPTION_ROLE",     addr(surplusConversion), "TRCUtility");

  // ==========================================================================
  // Persist deployment addresses
  // ==========================================================================

  const deployments = {
    network:          network.name,
    deployedAt:       new Date().toISOString(),
    deployer:         deployer.address,
    contracts: {
      WalletCap:          addr(walletCap),
      TRCGold:            addr(trcGold),
      TRCUtility:         addr(trcUtility),
      Reserve:            addr(reserve),
      PoCRewards:         addr(pocRewards),
      ProducerPledge:     addr(producerPledge),
      Governance:         addr(governance),
      SurplusConversion:  addr(surplusConversion),
      Commons:            addr(commons),
    },
    pools: {
      miningRewardsPool: miningPool,
      lotteryPool,
      protocolDevPool:   protocolDev,
    },
  };

  const outDir = join(__dirname, "..", "deployments");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${network.name}.json`);
  writeFileSync(outFile, JSON.stringify(deployments, null, 2));
  console.log(`\nDeployment manifest written to deployments/${network.name}.json`);

  // ==========================================================================
  // Summary
  // ==========================================================================

  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║          Deployment complete ✓           ║");
  console.log("╠══════════════════════════════════════════╣");
  for (const [name, address] of Object.entries(deployments.contracts)) {
    console.log(`║  ${name.padEnd(18)} ${address.slice(0, 22)}…`);
  }
  console.log("╚══════════════════════════════════════════╝\n");

  if (process.env.ETHERSCAN_API_KEY) {
    console.log("Etherscan verification — run manually:");
    for (const [name, address] of Object.entries(deployments.contracts)) {
      console.log(`  npx hardhat verify --network ${network.name} ${address}   # ${name}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
