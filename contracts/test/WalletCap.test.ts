import { expect }          from "chai";
import { ethers }          from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { WalletCap }       from "../typechain-types";

describe("WalletCap", function () {
  let walletCap:   WalletCap;
  let admin:       SignerWithAddress;
  let registry:    SignerWithAddress;
  let tokenA:      SignerWithAddress;  // simulates TRC-G
  let tokenB:      SignerWithAddress;  // simulates TRC-U
  let oracle:      SignerWithAddress;
  let user1:       SignerWithAddress;
  let user2:       SignerWithAddress;
  let user3:       SignerWithAddress;

  const DID_REGISTRY_ROLE = ethers.keccak256(ethers.toUtf8Bytes("DID_REGISTRY_ROLE"));
  const TOKEN_ROLE        = ethers.keccak256(ethers.toUtf8Bytes("TOKEN_ROLE"));
  const ORACLE_ROLE       = ethers.keccak256(ethers.toUtf8Bytes("ORACLE_ROLE"));

  const DID_ALICE = ethers.keccak256(ethers.toUtf8Bytes("did:trc:alice"));
  const DID_BOB   = ethers.keccak256(ethers.toUtf8Bytes("did:trc:bob"));

  // 100,000 tokens total supply, 50 participants → 1% cap → 1000 tokens
  const TOTAL_SUPPLY    = ethers.parseEther("100000");
  const PARTICIPANTS_FEW = 5000n; // <10k → 1% cap
  const PARTICIPANTS_MED = 50000n; // 10k-100k → 0.5% cap
  const PARTICIPANTS_BIG = 500000n; // 100k-1M → 0.1% cap

  beforeEach(async () => {
    [admin, registry, tokenA, tokenB, oracle, user1, user2, user3] = await ethers.getSigners();

    const WalletCapFactory = await ethers.getContractFactory("WalletCap");
    walletCap = await WalletCapFactory.deploy(admin.address);
    await walletCap.waitForDeployment();

    await walletCap.grantRole(DID_REGISTRY_ROLE, registry.address);
    await walletCap.grantRole(TOKEN_ROLE,         tokenA.address);
    await walletCap.grantRole(TOKEN_ROLE,         tokenB.address);
    await walletCap.grantRole(ORACLE_ROLE,        oracle.address);
  });

  // -------------------------------------------------------------------------
  // DID registration
  // -------------------------------------------------------------------------

  describe("registerAddress()", () => {
    it("links a wallet address to a DID", async () => {
      await walletCap.connect(registry).registerAddress(DID_ALICE, user1.address);
      expect(await walletCap.getDIDForAddress(user1.address)).to.equal(DID_ALICE);
    });

    it("emits AddressRegistered event", async () => {
      await expect(walletCap.connect(registry).registerAddress(DID_ALICE, user1.address))
        .to.emit(walletCap, "AddressRegistered")
        .withArgs(DID_ALICE, user1.address);
    });

    it("rejects double-registration of same wallet", async () => {
      await walletCap.connect(registry).registerAddress(DID_ALICE, user1.address);
      await expect(
        walletCap.connect(registry).registerAddress(DID_BOB, user1.address)
      ).to.be.revertedWithCustomError(walletCap, "AddressAlreadyRegistered");
    });

    it("allows multiple wallets under the same DID", async () => {
      await walletCap.connect(registry).registerAddress(DID_ALICE, user1.address);
      await walletCap.connect(registry).registerAddress(DID_ALICE, user2.address);

      const addrs = await walletCap.getAddressesForDID(DID_ALICE);
      expect(addrs).to.include(user1.address);
      expect(addrs).to.include(user2.address);
    });

    it("rejects zero wallet address", async () => {
      await expect(
        walletCap.connect(registry).registerAddress(DID_ALICE, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(walletCap, "ZeroAddress");
    });

    it("rejects zero DID", async () => {
      await expect(
        walletCap.connect(registry).registerAddress(ethers.ZeroHash, user1.address)
      ).to.be.revertedWithCustomError(walletCap, "ZeroDID");
    });

    it("non-registry cannot register", async () => {
      await expect(
        walletCap.connect(user1).registerAddress(DID_ALICE, user1.address)
      ).to.be.revertedWithCustomError(walletCap, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------------------------
  // Address revocation
  // -------------------------------------------------------------------------

  describe("revokeAddress()", () => {
    beforeEach(async () => {
      await walletCap.connect(registry).registerAddress(DID_ALICE, user1.address);
    });

    it("removes the wallet from DID mapping", async () => {
      await walletCap.connect(registry).revokeAddress(DID_ALICE, user1.address);
      expect(await walletCap.getDIDForAddress(user1.address)).to.equal(ethers.ZeroHash);
    });

    it("emits AddressRevoked event", async () => {
      await expect(walletCap.connect(registry).revokeAddress(DID_ALICE, user1.address))
        .to.emit(walletCap, "AddressRevoked")
        .withArgs(DID_ALICE, user1.address);
    });

    it("reverts if wallet was not registered under given DID", async () => {
      await expect(
        walletCap.connect(registry).revokeAddress(DID_BOB, user1.address)
      ).to.be.revertedWithCustomError(walletCap, "AddressNotRegistered");
    });
  });

  // -------------------------------------------------------------------------
  // Cap computation
  // -------------------------------------------------------------------------

  describe("getCap()", () => {
    beforeEach(async () => {
      await walletCap.connect(oracle).updateNetworkStats(PARTICIPANTS_FEW, TOTAL_SUPPLY);
    });

    it("returns 1% of supply for <10k participants", async () => {
      // 1% of 100,000 = 1,000 tokens
      const expectedCap = (TOTAL_SUPPLY * 100n) / 10_000n;
      expect(await walletCap.getCap()).to.equal(expectedCap);
    });

    it("returns 0.5% of supply for 10k-100k participants", async () => {
      await walletCap.connect(oracle).updateNetworkStats(PARTICIPANTS_MED, TOTAL_SUPPLY);
      const expectedCap = (TOTAL_SUPPLY * 50n) / 10_000n;
      expect(await walletCap.getCap()).to.equal(expectedCap);
    });

    it("returns 0.1% for 100k-1M participants", async () => {
      await walletCap.connect(oracle).updateNetworkStats(PARTICIPANTS_BIG, TOTAL_SUPPLY);
      const expectedCap = (TOTAL_SUPPLY * 10n) / 10_000n;
      expect(await walletCap.getCap()).to.equal(expectedCap);
    });

    it("returns 0.01% for >=1M participants", async () => {
      await walletCap.connect(oracle).updateNetworkStats(1_500_000n, TOTAL_SUPPLY);
      const expectedCap = (TOTAL_SUPPLY * 1n) / 10_000n;
      expect(await walletCap.getCap()).to.equal(expectedCap);
    });
  });

  // -------------------------------------------------------------------------
  // Cap enforcement
  // -------------------------------------------------------------------------

  describe("enforceCapOnTransfer()", () => {
    const CAP_AMOUNT = (TOTAL_SUPPLY * 100n) / 10_000n; // 1% = 1000 tokens

    beforeEach(async () => {
      await walletCap.connect(oracle).updateNetworkStats(PARTICIPANTS_FEW, TOTAL_SUPPLY);
      await walletCap.connect(registry).registerAddress(DID_ALICE, user1.address);
    });

    it("does not revert when transfer is within cap", async () => {
      await expect(
        walletCap.connect(tokenA).enforceCapOnTransfer(user1.address, CAP_AMOUNT)
      ).to.not.be.reverted;
    });

    it("reverts when transfer would exceed cap", async () => {
      await expect(
        walletCap.connect(tokenA).enforceCapOnTransfer(user1.address, CAP_AMOUNT + 1n)
      ).to.be.revertedWithCustomError(walletCap, "CapExceeded");
    });

    it("does not revert for unregistered addresses (exchange compatibility)", async () => {
      await expect(
        walletCap.connect(tokenA).enforceCapOnTransfer(user3.address, TOTAL_SUPPLY)
      ).to.not.be.reverted;
    });

    it("rejects calls from non-TOKEN_ROLE", async () => {
      await expect(
        walletCap.connect(user1).enforceCapOnTransfer(user1.address, 1n)
      ).to.be.revertedWithCustomError(walletCap, "AccessControlUnauthorizedAccount");
    });
  });

  // -------------------------------------------------------------------------
  // Multi-wallet attack prevention
  // -------------------------------------------------------------------------

  describe("Multi-wallet attack prevention", () => {
    const CAP_AMOUNT = (TOTAL_SUPPLY * 100n) / 10_000n;

    beforeEach(async () => {
      await walletCap.connect(oracle).updateNetworkStats(PARTICIPANTS_FEW, TOTAL_SUPPLY);

      // Alice registers two wallets under one DID
      await walletCap.connect(registry).registerAddress(DID_ALICE, user1.address);
      await walletCap.connect(registry).registerAddress(DID_ALICE, user2.address);
    });

    it("aggregate balance tracked across multiple wallets of same DID", async () => {
      const halfCap = CAP_AMOUNT / 2n;

      // First wallet receives half the cap
      await walletCap.connect(tokenA).enforceCapOnTransfer(user1.address, halfCap);
      await walletCap.connect(tokenA).recordTransfer(user1.address, BigInt(halfCap));

      // Second wallet trying to receive another half — aggregate would hit cap exactly
      await expect(
        walletCap.connect(tokenA).enforceCapOnTransfer(user2.address, halfCap)
      ).to.not.be.reverted;

      // But exceeding aggregate across both wallets should revert
      await walletCap.connect(tokenA).recordTransfer(user2.address, BigInt(halfCap));
      await expect(
        walletCap.connect(tokenA).enforceCapOnTransfer(user1.address, 1n)
      ).to.be.revertedWithCustomError(walletCap, "CapExceeded");
    });

    it("a single wallet cannot exceed cap even if it belongs to same DID", async () => {
      await walletCap.connect(tokenA).recordTransfer(user1.address, BigInt(CAP_AMOUNT));

      await expect(
        walletCap.connect(tokenA).enforceCapOnTransfer(user2.address, 1n)
      ).to.be.revertedWithCustomError(walletCap, "CapExceeded");
    });

    it("two different DIDs maintain independent caps", async () => {
      await walletCap.connect(registry).registerAddress(DID_BOB, user3.address);

      // Alice's wallet hits cap
      await walletCap.connect(tokenA).recordTransfer(user1.address, BigInt(CAP_AMOUNT));

      // Bob's wallet is unaffected
      await expect(
        walletCap.connect(tokenA).enforceCapOnTransfer(user3.address, CAP_AMOUNT)
      ).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // checkCap view function
  // -------------------------------------------------------------------------

  describe("checkCap()", () => {
    beforeEach(async () => {
      await walletCap.connect(oracle).updateNetworkStats(PARTICIPANTS_FEW, TOTAL_SUPPLY);
      await walletCap.connect(registry).registerAddress(DID_ALICE, user1.address);
    });

    it("returns true when DID balance + additionalAmount <= cap", async () => {
      const cap = await walletCap.getCap();
      expect(await walletCap.checkCap(DID_ALICE, cap)).to.be.true;
    });

    it("returns false when DID balance + additionalAmount > cap", async () => {
      const cap = await walletCap.getCap();
      expect(await walletCap.checkCap(DID_ALICE, cap + 1n)).to.be.false;
    });

    it("returns false for unregistered DID", async () => {
      expect(await walletCap.checkCap(DID_BOB, 1n)).to.be.false;
    });
  });
});
