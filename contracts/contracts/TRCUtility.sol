// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title TRCUtility
 * @notice Utility token (TRC-U) earned through Proof-of-Contribution.
 *         Backed by commodity pledges, transaction fees, and Commons Pool returns.
 *
 *         Pool split: 60% mining rewards | 25% distribution lottery | 15% protocol dev
 */
contract TRCUtility is ERC20, AccessControl, ReentrancyGuard, Pausable {
    bytes32 public constant POC_REWARDS_ROLE   = keccak256("POC_REWARDS_ROLE");
    bytes32 public constant FEE_COLLECTOR_ROLE = keccak256("FEE_COLLECTOR_ROLE");
    bytes32 public constant REDEMPTION_ROLE    = keccak256("REDEMPTION_ROLE");
    bytes32 public constant MINTER_ROLE        = keccak256("MINTER_ROLE");
    bytes32 public constant WALLET_CAP_ROLE    = keccak256("WALLET_CAP_ROLE");

    // Pool split in basis points (must sum to 10000)
    uint16 public constant MINING_REWARDS_BPS  = 6000; // 60%
    uint16 public constant LOTTERY_BPS         = 2500; // 25%
    uint16 public constant PROTOCOL_DEV_BPS    = 1500; // 15%

    address public miningRewardsPool;
    address public lotteryPool;
    address public protocolDevPool;
    address public walletCapContract;

    /// @notice Total fees collected into the utility pool (undistributed)
    uint256 public utilityPoolBalance;

    /// @notice Maps commodity redemption requests for off-chain settlement
    /// redemptionId => amount burned
    mapping(bytes32 => uint256) public redemptionVouchers;

    event RewardDistributed(address indexed contributor, uint256 amount, bytes32 indexed contributionProof);
    event FeeCollected(uint256 totalFee, uint256 toMining, uint256 toLottery, uint256 toProtocol);
    event CommodityRedeemed(address indexed redeemer, uint256 amount, bytes32 indexed commodityType, bytes32 redemptionId);
    event WalletCapContractSet(address indexed newContract);
    event PoolAddressesSet(address mining, address lottery, address protocol);

    error ZeroAmount();
    error PoolNotConfigured();
    error DuplicateRedemption(bytes32 redemptionId);

    constructor(
        address admin,
        address _miningRewardsPool,
        address _lotteryPool,
        address _protocolDevPool
    ) ERC20("TrustedCrypto Utility", "TRC-U") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        miningRewardsPool  = _miningRewardsPool;
        lotteryPool        = _lotteryPool;
        protocolDevPool    = _protocolDevPool;
    }

    /**
     * @notice Mints TRC-U to a contributor as a PoC epoch reward.
     * @dev Only callable by the PoCRewards contract.
     * @param contributor      Recipient address
     * @param amount           Token amount to mint
     * @param contributionProof  Hash of the off-chain contribution record
     */
    function distributeReward(
        address contributor,
        uint256 amount,
        bytes32 contributionProof
    ) external onlyRole(POC_REWARDS_ROLE) whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _mint(contributor, amount);
        emit RewardDistributed(contributor, amount, contributionProof);
    }

    /**
     * @notice Accepts a transaction fee and splits it among the three sub-pools.
     * @dev Called by the fee-collector on every on-chain transaction.
     * @param feeAmount  Total fee amount in TRC-U units; must already be transferred to this contract.
     */
    function fundPool(uint256 feeAmount) external onlyRole(FEE_COLLECTOR_ROLE) nonReentrant {
        if (feeAmount == 0) revert ZeroAmount();
        if (miningRewardsPool == address(0) || lotteryPool == address(0) || protocolDevPool == address(0)) {
            revert PoolNotConfigured();
        }

        uint256 toMining   = (feeAmount * MINING_REWARDS_BPS)  / 10000;
        uint256 toLottery  = (feeAmount * LOTTERY_BPS)         / 10000;
        uint256 toProtocol = feeAmount - toMining - toLottery; // remainder avoids rounding loss

        utilityPoolBalance += feeAmount;

        // These are logical accounting transfers; actual ERC-20 transfers happen
        // when rewards are claimed from the sub-pools.
        _mint(miningRewardsPool, toMining);
        _mint(lotteryPool, toLottery);
        _mint(protocolDevPool, toProtocol);

        emit FeeCollected(feeAmount, toMining, toLottery, toProtocol);
    }

    /**
     * @notice Burns TRC-U in exchange for a commodity redemption voucher.
     *         The voucher ID is emitted on-chain; off-chain settlement follows.
     * @param amount         Amount of TRC-U to burn
     * @param commodityType  Keccak hash of the commodity identifier (e.g. keccak256("WHEAT_KG"))
     */
    function redeemCommodity(
        uint256 amount,
        bytes32 commodityType
    ) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        bytes32 redemptionId = keccak256(abi.encodePacked(msg.sender, commodityType, amount, block.timestamp, block.number));
        if (redemptionVouchers[redemptionId] != 0) revert DuplicateRedemption(redemptionId);

        redemptionVouchers[redemptionId] = amount;
        _burn(msg.sender, amount);

        emit CommodityRedeemed(msg.sender, amount, commodityType, redemptionId);
    }

    /**
     * @notice External minting for ProducerPledge confirmation. Only callable by MINTER_ROLE.
     */
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _mint(to, amount);
    }

    /**
     * @notice External burning used by SurplusConversion. Only callable by REDEMPTION_ROLE.
     */
    function burn(address from, uint256 amount) external onlyRole(REDEMPTION_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _burn(from, amount);
    }

    /**
     * @notice Sets the WalletCap contract address for transfer hook enforcement.
     */
    function setWalletCapContract(address cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        walletCapContract = cap;
        emit WalletCapContractSet(cap);
    }

    function setPoolAddresses(
        address _mining,
        address _lottery,
        address _protocol
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        miningRewardsPool = _mining;
        lotteryPool       = _lottery;
        protocolDevPool   = _protocol;
        emit PoolAddressesSet(_mining, _lottery, _protocol);
    }

    /**
     * @dev Hook: enforces wallet cap and updates cumulative aggregate balance per DID.
     */
    function _update(address from, address to, uint256 value) internal override whenNotPaused {
        // Enforce cap for transfers AND mints (from == address(0)).
        // Burns (to == address(0)) are exempt — reducing supply can't violate a cap.
        if (walletCapContract != address(0) && to != address(0)) {
            IWalletCap(walletCapContract).enforceCapOnTransfer(to, value);
        }
        super._update(from, to, value);
        if (walletCapContract != address(0)) {
            if (to != address(0)) {
                IWalletCap(walletCapContract).recordTransfer(to, int256(value));
            }
            if (from != address(0)) {
                IWalletCap(walletCapContract).recordTransfer(from, -int256(value));
            }
        }
    }
}

interface IWalletCap {
    function enforceCapOnTransfer(address wallet, uint256 additionalAmount) external view;
    function recordTransfer(address wallet, int256 delta) external;
}
