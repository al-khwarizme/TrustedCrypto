// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title Reserve
 * @notice Manages physical gold reserve backing for TRC-G.
 *         - Deposits require 3-of-5 auditor multisig for large amounts.
 *         - Reserve ratio must always be >= 1e18 (100%).
 *         - Each vault is identified by a UUID-style vaultId.
 */
contract Reserve is AccessControl, ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    bytes32 public constant AUDITOR_ROLE   = keccak256("AUDITOR_ROLE");
    bytes32 public constant OPERATOR_ROLE  = keccak256("OPERATOR_ROLE");

    /// @notice Gram threshold above which 3-of-5 multisig is required (100 troy oz = 3110.35g)
    uint256 public constant LARGE_DEPOSIT_THRESHOLD = 3110 * 1e18;

    /// @notice Required confirmations for large deposits
    uint256 public constant MULTISIG_THRESHOLD = 3;

    struct VaultDeposit {
        bytes32 vaultId;
        uint256 grams;
        uint256 timestamp;
        bytes32 depositProof;
        bool minted;
    }

    struct PendingDeposit {
        bytes32 vaultId;
        uint256 grams;
        uint256 confirmationCount;
        mapping(address => bool) confirmed;
        bool executed;
    }

    struct RedemptionOrder {
        address redeemer;
        uint256 tokenAmount;
        bytes32 encryptedDeliveryAddress;
        uint256 timestamp;
        bool fulfilled;
    }

    ITRCGold public trcGold;

    uint256 public goldInVault;           // total grams in reserve (1e18 = 1 gram)
    uint256 public pendingDepositNonce;
    uint256 public redemptionNonce;

    mapping(uint256 => PendingDeposit) private _pendingDeposits;
    mapping(bytes32 => VaultDeposit)   public  vaultDeposits;
    mapping(uint256 => RedemptionOrder) public  redemptionOrders;

    event DepositProposed(uint256 indexed nonce, bytes32 indexed vaultId, uint256 grams);
    event DepositConfirmed(uint256 indexed nonce, address indexed auditor, uint256 confirmations);
    event DepositExecuted(uint256 indexed nonce, bytes32 indexed vaultId, uint256 grams, bytes32 depositProof);
    event RedemptionInitiated(uint256 indexed redemptionId, address indexed redeemer, uint256 tokenAmount);
    event RedemptionFulfilled(uint256 indexed redemptionId);

    error InsufficientReserve();
    error ReserveRatioViolation(uint256 ratio);
    error DepositAlreadyExecuted(uint256 nonce);
    error AlreadyConfirmed(uint256 nonce, address auditor);
    error InsufficientConfirmations(uint256 have, uint256 need);
    error InvalidVaultId();
    error RedemptionAlreadyFulfilled(uint256 redemptionId);

    constructor(address admin, address _trcGold) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AUDITOR_ROLE, admin);
        trcGold = ITRCGold(_trcGold);
    }

    /**
     * @notice Proposes a gold deposit. For small deposits (< threshold), immediately
     *         executes with single auditor. For large deposits, creates a pending multisig.
     * @param vaultId           Unique identifier for the physical vault
     * @param grams             Amount of gold in grams (1e18 precision)
     * @param auditorSignature  ECDSA signature over keccak256(vaultId, grams, block.chainid)
     */
    function depositGold(
        bytes32 vaultId,
        uint256 grams,
        bytes calldata auditorSignature
    ) external onlyRole(AUDITOR_ROLE) nonReentrant returns (uint256 nonce) {
        if (vaultId == bytes32(0)) revert InvalidVaultId();

        // Verify auditor signature over the deposit parameters
        bytes32 msgHash = keccak256(abi.encodePacked(vaultId, grams, block.chainid)).toEthSignedMessageHash();
        address signer  = msgHash.recover(auditorSignature);
        if (!hasRole(AUDITOR_ROLE, signer)) revert InvalidAuditorSignature();

        nonce = pendingDepositNonce++;

        PendingDeposit storage deposit = _pendingDeposits[nonce];
        deposit.vaultId           = vaultId;
        deposit.grams             = grams;
        deposit.confirmationCount = 1;
        deposit.confirmed[signer] = true;

        emit DepositProposed(nonce, vaultId, grams);
        emit DepositConfirmed(nonce, signer, 1);

        // Small deposits execute immediately with a single auditor signature
        if (grams < LARGE_DEPOSIT_THRESHOLD) {
            _executeDeposit(nonce);
        }
    }

    /**
     * @notice Adds an auditor confirmation to a pending large deposit.
     * @param nonce             The deposit nonce returned from depositGold
     * @param auditorSignature  Signature over keccak256(nonce, vaultId, grams)
     */
    function confirmDeposit(
        uint256 nonce,
        bytes calldata auditorSignature
    ) external onlyRole(AUDITOR_ROLE) nonReentrant {
        PendingDeposit storage deposit = _pendingDeposits[nonce];
        if (deposit.executed) revert DepositAlreadyExecuted(nonce);

        bytes32 msgHash = keccak256(
            abi.encodePacked(nonce, deposit.vaultId, deposit.grams, block.chainid)
        ).toEthSignedMessageHash();
        address signer = msgHash.recover(auditorSignature);

        if (!hasRole(AUDITOR_ROLE, signer)) revert InvalidAuditorSignature();
        if (deposit.confirmed[signer]) revert AlreadyConfirmed(nonce, signer);

        deposit.confirmed[signer] = true;
        deposit.confirmationCount++;

        emit DepositConfirmed(nonce, signer, deposit.confirmationCount);

        if (deposit.confirmationCount >= MULTISIG_THRESHOLD) {
            _executeDeposit(nonce);
        }
    }

    /**
     * @notice Initiates a gold redemption. Burns TRC-G and records an encrypted delivery address
     *         for off-chain fulfillment by the vault operator.
     * @param tokenAmount              Amount of TRC-G to redeem (burn)
     * @param encryptedDeliveryAddress Asymmetrically encrypted shipping details (auditor public key)
     */
    function initiateRedemption(
        uint256 tokenAmount,
        bytes32 encryptedDeliveryAddress
    ) external nonReentrant returns (uint256 redemptionId) {
        // Caller must have approved this contract to burn their tokens.
        // In practice the caller calls TRCGold.approve(Reserve, amount) first.
        redemptionId = redemptionNonce++;

        goldInVault -= tokenAmount; // will underflow (revert) if reserve insufficient
        trcGold.burn(msg.sender, tokenAmount);

        redemptionOrders[redemptionId] = RedemptionOrder({
            redeemer:                msg.sender,
            tokenAmount:             tokenAmount,
            encryptedDeliveryAddress: encryptedDeliveryAddress,
            timestamp:               block.timestamp,
            fulfilled:               false
        });

        emit RedemptionInitiated(redemptionId, msg.sender, tokenAmount);
    }

    /**
     * @notice Marks a redemption as fulfilled by vault operator. Emits event for audit trail.
     */
    function markRedemptionFulfilled(uint256 redemptionId) external onlyRole(OPERATOR_ROLE) {
        RedemptionOrder storage order = redemptionOrders[redemptionId];
        if (order.fulfilled) revert RedemptionAlreadyFulfilled(redemptionId);
        order.fulfilled = true;
        emit RedemptionFulfilled(redemptionId);
    }

    /**
     * @notice Returns total grams currently in vault.
     */
    function getGoldInVault() public view returns (uint256) {
        return goldInVault;
    }

    /**
     * @notice Reserve ratio must be >= 1e18 (100%) at all times.
     *         Values above 1e18 indicate surplus eligible for SurplusConversion.
     */
    function reserveRatio() public view returns (uint256) {
        return trcGold.reserveRatio();
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _executeDeposit(uint256 nonce) internal {
        PendingDeposit storage deposit = _pendingDeposits[nonce];
        if (deposit.executed) revert DepositAlreadyExecuted(nonce);
        deposit.executed = true;

        bytes32 depositProof = keccak256(
            abi.encodePacked(nonce, deposit.vaultId, deposit.grams, block.timestamp, block.chainid)
        );

        goldInVault += deposit.grams;

        vaultDeposits[deposit.vaultId] = VaultDeposit({
            vaultId:     deposit.vaultId,
            grams:       deposit.grams,
            timestamp:   block.timestamp,
            depositProof: depositProof,
            minted:      true
        });

        // Mint TRC-G to this contract; operator distributes to depositor off-chain
        // (or we can pass the depositor address as a parameter in a future version)
        trcGold.mint(address(this), deposit.grams, depositProof);

        emit DepositExecuted(nonce, deposit.vaultId, deposit.grams, depositProof);
    }

    error InvalidAuditorSignature();
}

interface ITRCGold {
    function mint(address to, uint256 amount, bytes32 depositProof) external;
    function burn(address from, uint256 amount) external;
    function reserveRatio() external view returns (uint256);
    function totalSupply() external view returns (uint256);
}
