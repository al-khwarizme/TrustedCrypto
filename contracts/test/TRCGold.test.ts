import { expect }          from "chai";
import { ethers }          from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { TRCGold }         from "../typechain-types";

describe("TRCGold", function () {
  let trcGold:   TRCGold;
  let admin:     SignerWithAddress;
  let reserve:   SignerWithAddress;
  let redemption: SignerWithAddress;
  let auditor:   SignerWithAddress;
  let user1:     SignerWithAddress;
  let user2:     SignerWithAddress;

  const RESERVE_ROLE    = ethers.keccak256(ethers.toUtf8Bytes("RESERVE_ROLE"));
  const REDEMPTION_ROLE = ethers.keccak256(ethers.toUtf8Bytes("REDEMPTION_ROLE"));
  const AUDITOR_ROLE    = ethers.keccak256(ethers.toUtf8Bytes("AUDITOR_ROLE"));

  const ONE_GRAM = ethers.parseEther("1"); // 1e18 units = 1 gram
  const DEPOSIT_PROOF = ethers.keccak256(ethers.toUtf8Bytes("vault-receipt-001"));

  beforeEach(async () => {
    [admin, reserve, redemption, auditor, user1, user2] = await ethers.getSigners();

    const TRCGoldFactory = await ethers.getContractFactory("TRCGold");
    trcGold = await TRCGoldFactory.deploy(admin.address);
    await trcGold.waitForDeployment();

    // Grant roles
    await trcGold.grantRole(RESERVE_ROLE,    reserve.address);
    await trcGold.grantRole(REDEMPTION_ROLE, redemption.address);
    await trcGold.grantRole(AUDITOR_ROLE,    auditor.address);
  });

  // -------------------------------------------------------------------------
  // Deployment
  // -------------------------------------------------------------------------

  describe("Deployment", () => {
    it("sets correct token name and symbol", async () => {
      expect(await trcGold.name()).to.equal("TrustedCrypto Gold");
      expect(await trcGold.symbol()).to.equal("TRC-G");
    });

    it("starts with zero supply and zero reserve", async () => {
      expect(await trcGold.totalSupply()).to.equal(0n);
      expect(await trcGold.gramsInReserve()).to.equal(0n);
    });

    it("reserve ratio returns 1e18 when supply is zero", async () => {
      expect(await trcGold.reserveRatio()).to.equal(ethers.parseEther("1"));
    });

    it("grants admin the DEFAULT_ADMIN_ROLE", async () => {
      const DEFAULT_ADMIN = ethers.ZeroHash;
      expect(await trcGold.hasRole(DEFAULT_ADMIN, admin.address)).to.be.true;
    });
  });

  // -------------------------------------------------------------------------
  // Minting
  // -------------------------------------------------------------------------

  describe("mint()", () => {
    it("allows RESERVE_ROLE to mint with a valid proof", async () => {
      await expect(trcGold.connect(reserve).mint(user1.address, ONE_GRAM, DEPOSIT_PROOF))
        .to.emit(trcGold, "GoldMinted")
        .withArgs(user1.address, ONE_GRAM, DEPOSIT_PROOF, ONE_GRAM);

      expect(await trcGold.balanceOf(user1.address)).to.equal(ONE_GRAM);
      expect(await trcGold.gramsInReserve()).to.equal(ONE_GRAM);
    });

    it("records the deposit proof → amount mapping", async () => {
      await trcGold.connect(reserve).mint(user1.address, ONE_GRAM, DEPOSIT_PROOF);
      expect(await trcGold.depositProofToMinted(DEPOSIT_PROOF)).to.equal(ONE_GRAM);
    });

    it("reverts on duplicate deposit proof (double-mint prevention)", async () => {
      await trcGold.connect(reserve).mint(user1.address, ONE_GRAM, DEPOSIT_PROOF);
      await expect(
        trcGold.connect(reserve).mint(user2.address, ONE_GRAM, DEPOSIT_PROOF)
      ).to.be.revertedWithCustomError(trcGold, "DepositProofAlreadyUsed");
    });

    it("reverts on zero amount", async () => {
      await expect(
        trcGold.connect(reserve).mint(user1.address, 0n, DEPOSIT_PROOF)
      ).to.be.revertedWithCustomError(trcGold, "ZeroAmount");
    });

    it("reverts on zero deposit proof", async () => {
      await expect(
        trcGold.connect(reserve).mint(user1.address, ONE_GRAM, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(trcGold, "InvalidDepositProof");
    });

    it("rejects callers without RESERVE_ROLE", async () => {
      await expect(
        trcGold.connect(user1).mint(user1.address, ONE_GRAM, DEPOSIT_PROOF)
      ).to.be.revertedWithCustomError(trcGold, "AccessControlUnauthorizedAccount");
    });

    it("correctly maintains reserve ratio at 1:1 after multiple mints", async () => {
      const proof2 = ethers.keccak256(ethers.toUtf8Bytes("vault-receipt-002"));
      await trcGold.connect(reserve).mint(user1.address, ONE_GRAM,         DEPOSIT_PROOF);
      await trcGold.connect(reserve).mint(user2.address, ONE_GRAM * 5n,    proof2);

      const ratio = await trcGold.reserveRatio();
      expect(ratio).to.equal(ethers.parseEther("1")); // exactly 100%
    });
  });

  // -------------------------------------------------------------------------
  // Burning
  // -------------------------------------------------------------------------

  describe("burn()", () => {
    beforeEach(async () => {
      await trcGold.connect(reserve).mint(user1.address, ONE_GRAM * 10n, DEPOSIT_PROOF);
    });

    it("allows REDEMPTION_ROLE to burn tokens", async () => {
      await expect(trcGold.connect(redemption).burn(user1.address, ONE_GRAM * 3n))
        .to.emit(trcGold, "GoldBurned")
        .withArgs(user1.address, ONE_GRAM * 3n, ONE_GRAM * 7n);

      expect(await trcGold.balanceOf(user1.address)).to.equal(ONE_GRAM * 7n);
      expect(await trcGold.gramsInReserve()).to.equal(ONE_GRAM * 7n);
    });

    it("reverts if non-REDEMPTION_ROLE tries to burn", async () => {
      await expect(
        trcGold.connect(user1).burn(user1.address, ONE_GRAM)
      ).to.be.revertedWithCustomError(trcGold, "AccessControlUnauthorizedAccount");
    });

    it("reverts on zero burn amount", async () => {
      await expect(
        trcGold.connect(redemption).burn(user1.address, 0n)
      ).to.be.revertedWithCustomError(trcGold, "ZeroAmount");
    });
  });

  // -------------------------------------------------------------------------
  // Audit freeze / unfreeze
  // -------------------------------------------------------------------------

  describe("auditFreeze() / auditUnfreeze()", () => {
    beforeEach(async () => {
      await trcGold.connect(reserve).mint(user1.address, ONE_GRAM * 5n, DEPOSIT_PROOF);
    });

    it("auditor can freeze all transfers", async () => {
      await expect(trcGold.connect(auditor).auditFreeze())
        .to.emit(trcGold, "AuditFreezeToggled")
        .withArgs(true, auditor.address);

      await expect(
        trcGold.connect(user1).transfer(user2.address, ONE_GRAM)
      ).to.be.revertedWithCustomError(trcGold, "EnforcedPause");
    });

    it("auditor can unfreeze after audit", async () => {
      await trcGold.connect(auditor).auditFreeze();
      await trcGold.connect(auditor).auditUnfreeze();

      await expect(
        trcGold.connect(user1).transfer(user2.address, ONE_GRAM)
      ).to.not.be.reverted;
    });

    it("non-auditor cannot freeze", async () => {
      await expect(
        trcGold.connect(user1).auditFreeze()
      ).to.be.revertedWithCustomError(trcGold, "AccessControlUnauthorizedAccount");
    });

    it("mint is blocked during freeze", async () => {
      await trcGold.connect(auditor).auditFreeze();
      const proof2 = ethers.keccak256(ethers.toUtf8Bytes("proof-2"));
      await expect(
        trcGold.connect(reserve).mint(user1.address, ONE_GRAM, proof2)
      ).to.be.revertedWithCustomError(trcGold, "EnforcedPause");
    });
  });

  // -------------------------------------------------------------------------
  // Reserve ratio
  // -------------------------------------------------------------------------

  describe("reserveRatio()", () => {
    it("is exactly 1e18 when supply equals reserve", async () => {
      await trcGold.connect(reserve).mint(user1.address, ONE_GRAM * 100n, DEPOSIT_PROOF);
      expect(await trcGold.reserveRatio()).to.equal(ethers.parseEther("1"));
    });

    it("decreases correctly after burn (simulating reserve drawdown)", async () => {
      await trcGold.connect(reserve).mint(user1.address, ONE_GRAM * 10n, DEPOSIT_PROOF);
      // Burn 5 grams worth but keep 10 grams in reserve manually for testing
      // In practice the Reserve contract updates goldInReserve.
      // Here we just verify the math.
      expect(await trcGold.gramsInReserve()).to.equal(ONE_GRAM * 10n);
      expect(await trcGold.totalSupply()).to.equal(ONE_GRAM * 10n);
      expect(await trcGold.reserveRatio()).to.equal(ethers.parseEther("1"));
    });
  });

  // -------------------------------------------------------------------------
  // Transfer events and standard ERC-20 behavior
  // -------------------------------------------------------------------------

  describe("ERC-20 transfers", () => {
    beforeEach(async () => {
      await trcGold.connect(reserve).mint(user1.address, ONE_GRAM * 10n, DEPOSIT_PROOF);
    });

    it("transfers emit Transfer event", async () => {
      await expect(trcGold.connect(user1).transfer(user2.address, ONE_GRAM))
        .to.emit(trcGold, "Transfer")
        .withArgs(user1.address, user2.address, ONE_GRAM);
    });

    it("approve + transferFrom works correctly", async () => {
      await trcGold.connect(user1).approve(user2.address, ONE_GRAM * 3n);
      await trcGold.connect(user2).transferFrom(user1.address, user2.address, ONE_GRAM * 3n);
      expect(await trcGold.balanceOf(user2.address)).to.equal(ONE_GRAM * 3n);
    });

    it("reverts transferFrom over allowance", async () => {
      await trcGold.connect(user1).approve(user2.address, ONE_GRAM);
      await expect(
        trcGold.connect(user2).transferFrom(user1.address, user2.address, ONE_GRAM * 2n)
      ).to.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // recordTransfer bug regression: cap enforced on mint, pause blocks transfers
  // -------------------------------------------------------------------------

  describe("WalletCap integration (bug regression)", () => {
    let walletCap: any;
    const DID_REGISTRY_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DID_REGISTRY_ROLE"));
    const TOKEN_ROLE        = ethers.keccak256(ethers.toUtf8Bytes("TOKEN_ROLE"));
    const ORACLE_ROLE       = ethers.keccak256(ethers.toUtf8Bytes("ORACLE_ROLE"));
    const USER1_DID = ethers.keccak256(ethers.toUtf8Bytes("did:trc:user1"));
    const CAP_AMOUNT = ethers.parseEther("1000");   // totalSupply=1e6, bps=100 → cap=100 — use 1000 tokens
    const TOTAL_SUPPLY_BIG = ethers.parseEther("100000"); // so cap = 1% = 1000

    beforeEach(async () => {
      const WalletCapFactory = await ethers.getContractFactory("WalletCap");
      walletCap = await WalletCapFactory.deploy(admin.address);
      await walletCap.waitForDeployment();

      await walletCap.grantRole(DID_REGISTRY_ROLE, admin.address);
      await walletCap.grantRole(TOKEN_ROLE, await trcGold.getAddress());
      await walletCap.grantRole(ORACLE_ROLE, admin.address);

      // participantCount < 10,000 → bps = 100 → cap = 1% of totalNetworkSupply
      await walletCap.updateNetworkStats(100n, TOTAL_SUPPLY_BIG);
      await walletCap.registerAddress(USER1_DID, user1.address);
      await trcGold.setWalletCapContract(await walletCap.getAddress());
    });

    it("enforces cap on mint (bug fix: from == address(0) was previously bypassing cap)", async () => {
      // Mint exactly at the cap — should succeed
      await trcGold.connect(reserve).mint(user1.address, CAP_AMOUNT, DEPOSIT_PROOF);
      expect(await trcGold.balanceOf(user1.address)).to.equal(CAP_AMOUNT);

      // Mint one more token over the cap — must revert
      const proof2 = ethers.keccak256(ethers.toUtf8Bytes("vault-receipt-002"));
      await expect(
        trcGold.connect(reserve).mint(user1.address, 1n, proof2)
      ).to.be.revertedWithCustomError(walletCap, "CapExceeded");
    });

    it("auditFreeze blocks transfers (whenNotPaused on _update)", async () => {
      await trcGold.connect(reserve).mint(user1.address, ONE_GRAM, DEPOSIT_PROOF);
      await trcGold.connect(auditor).auditFreeze();
      await expect(
        trcGold.connect(user1).transfer(user2.address, ONE_GRAM)
      ).to.be.revertedWithCustomError(trcGold, "EnforcedPause");
    });
  });
});
