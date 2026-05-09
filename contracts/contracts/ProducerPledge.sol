// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title ProducerPledge
 * @notice Enables commodity producers to pledge future delivery of real-world goods.
 *         Upon pledge confirmation by 3 independent verifier agents, TRC-U is minted
 *         to the producer. Failed delivery burns the pledged TRC-U and penalizes reputation.
 */
contract ProducerPledge is AccessControl, ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
    bytes32 public constant ORACLE_ROLE   = keccak256("ORACLE_ROLE");

    enum PledgeStatus {
        PENDING,
        CONFIRMED,
        DELIVERED,
        FAILED
    }

    struct Pledge {
        bytes32      pledgeId;
        bytes32      producerDID;
        bytes32      commodityType;      // keccak256 of commodity name e.g. "WHEAT_KG"
        uint256      quantity;           // in commodity units (e.g. kg), 1e18 precision
        uint256      deliveryDate;       // Unix timestamp
        bytes32[3]   verifierDIDs;       // Three independent verifier agents
        uint256      verificationCount;
        mapping(bytes32 => bool) verified; // verifierDID => signed
        PledgeStatus status;
        uint256      mintedAmount;       // TRC-U minted on confirmation
        address      producerAddress;   // receives TRC-U
    }

    ITRCUtility public trcUtility;

    /// @notice TRC-U minted per unit of commodity (oracle-provided, per commodity type)
    mapping(bytes32 => uint256) public commodityMintRate;  // commodityType => TRC-U per unit (1e18)

    /// @notice Reputation score per DID (decremented on failure)
    mapping(bytes32 => int256) public producerReputation;

    mapping(bytes32 => Pledge) private _pledges;

    uint256 public constant REQUIRED_VERIFICATIONS = 3;
    int256  public constant FAILURE_REPUTATION_PENALTY = -100;

    event PledgeRegistered(bytes32 indexed pledgeId, bytes32 indexed producerDID, bytes32 commodityType, uint256 quantity, uint256 deliveryDate);
    event PledgeVerified(bytes32 indexed pledgeId, bytes32 indexed verifierDID, uint256 count);
    event PledgeConfirmed(bytes32 indexed pledgeId, uint256 mintedAmount);
    event DeliveryConfirmed(bytes32 indexed pledgeId);
    event DeliveryFailed(bytes32 indexed pledgeId, bytes32 indexed producerDID, int256 newReputation);
    event CommodityRateSet(bytes32 indexed commodityType, uint256 rate);

    error PledgeNotFound(bytes32 pledgeId);
    error PledgeAlreadyExists(bytes32 pledgeId);
    error InvalidPledgeStatus(PledgeStatus current);
    error AlreadyVerified(bytes32 pledgeId, bytes32 verifierDID);
    error NotADesignatedVerifier(bytes32 verifierDID);
    error DeliveryDateNotPassed(uint256 deliveryDate, uint256 current);
    error CommodityRateNotSet(bytes32 commodityType);
    error ZeroQuantity();
    error InvalidVerifiers();

    constructor(address admin, address _trcUtility) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VERIFIER_ROLE, admin);
        _grantRole(ORACLE_ROLE, admin);
        trcUtility = ITRCUtility(_trcUtility);
    }

    /**
     * @notice Registers a new commodity pledge. The producer specifies three independent
     *         verifier agents who must all sign off before TRC-U is minted.
     * @param commodityType  keccak256 of commodity name
     * @param quantity       Amount in commodity units (1e18 precision)
     * @param deliveryDate   Expected delivery Unix timestamp
     * @param verifierDIDs   Exactly three distinct verifier DID hashes
     */
    function registerPledge(
        bytes32 commodityType,
        uint256 quantity,
        uint256 deliveryDate,
        bytes32[3] calldata verifierDIDs,
        bytes32 producerDID,
        address producerAddress
    ) external nonReentrant returns (bytes32 pledgeId) {
        if (quantity == 0) revert ZeroQuantity();
        if (commodityMintRate[commodityType] == 0) revert CommodityRateNotSet(commodityType);

        // Ensure verifiers are distinct
        if (
            verifierDIDs[0] == verifierDIDs[1] ||
            verifierDIDs[1] == verifierDIDs[2] ||
            verifierDIDs[0] == verifierDIDs[2]
        ) revert InvalidVerifiers();

        pledgeId = keccak256(
            abi.encodePacked(producerDID, commodityType, quantity, deliveryDate, block.timestamp)
        );
        if (_pledges[pledgeId].pledgeId != bytes32(0)) revert PledgeAlreadyExists(pledgeId);

        Pledge storage pledge = _pledges[pledgeId];
        pledge.pledgeId       = pledgeId;
        pledge.producerDID    = producerDID;
        pledge.commodityType  = commodityType;
        pledge.quantity       = quantity;
        pledge.deliveryDate   = deliveryDate;
        pledge.verifierDIDs   = verifierDIDs;
        pledge.status         = PledgeStatus.PENDING;
        pledge.producerAddress = producerAddress;

        emit PledgeRegistered(pledgeId, producerDID, commodityType, quantity, deliveryDate);
    }

    /**
     * @notice A designated verifier agent signs off on a pledge.
     *         Once all 3 verifiers confirm, TRC-U is minted to the producer.
     * @param pledgeId       Pledge identifier
     * @param verifierDID    DID of the confirming verifier
     * @param signature      ECDSA signature over keccak256(pledgeId, verifierDID)
     */
    function verifyPledge(
        bytes32 pledgeId,
        bytes32 verifierDID,
        bytes calldata signature
    ) external onlyRole(VERIFIER_ROLE) nonReentrant {
        Pledge storage pledge = _getPledge(pledgeId);
        if (pledge.status != PledgeStatus.PENDING) revert InvalidPledgeStatus(pledge.status);
        if (pledge.verified[verifierDID]) revert AlreadyVerified(pledgeId, verifierDID);

        // Verify the verifier is one of the three designated agents
        bool isDesignated = (
            pledge.verifierDIDs[0] == verifierDID ||
            pledge.verifierDIDs[1] == verifierDID ||
            pledge.verifierDIDs[2] == verifierDID
        );
        if (!isDesignated) revert NotADesignatedVerifier(verifierDID);

        // Verify ECDSA signature from the verifier's key
        bytes32 msgHash = keccak256(abi.encodePacked(pledgeId, verifierDID)).toEthSignedMessageHash();
        address signer  = msgHash.recover(signature);
        // In production: resolve verifierDID → signer address via DID registry
        // For now we accept any valid ECDSA from a VERIFIER_ROLE address
        if (!hasRole(VERIFIER_ROLE, signer)) revert InvalidVerifierSignature();

        pledge.verified[verifierDID] = true;
        pledge.verificationCount++;

        emit PledgeVerified(pledgeId, verifierDID, pledge.verificationCount);

        if (pledge.verificationCount >= REQUIRED_VERIFICATIONS) {
            _confirmPledge(pledge);
        }
    }

    /**
     * @notice Redeemer (buyer) confirms physical delivery of the commodity.
     */
    function confirmDelivery(bytes32 pledgeId) external onlyRole(VERIFIER_ROLE) nonReentrant {
        Pledge storage pledge = _getPledge(pledgeId);
        if (pledge.status != PledgeStatus.CONFIRMED) revert InvalidPledgeStatus(pledge.status);
        if (block.timestamp < pledge.deliveryDate) {
            revert DeliveryDateNotPassed(pledge.deliveryDate, block.timestamp);
        }

        pledge.status = PledgeStatus.DELIVERED;
        emit DeliveryConfirmed(pledgeId);
    }

    /**
     * @notice Reports a failed delivery. Burns the minted TRC-U and penalizes producer reputation.
     */
    function reportFailure(bytes32 pledgeId) external onlyRole(VERIFIER_ROLE) nonReentrant {
        Pledge storage pledge = _getPledge(pledgeId);
        if (pledge.status != PledgeStatus.CONFIRMED) revert InvalidPledgeStatus(pledge.status);

        pledge.status = PledgeStatus.FAILED;

        if (pledge.mintedAmount > 0) {
            // Burns TRC-U from the producer's address
            trcUtility.burn(pledge.producerAddress, pledge.mintedAmount);
        }

        producerReputation[pledge.producerDID] += FAILURE_REPUTATION_PENALTY;

        emit DeliveryFailed(pledgeId, pledge.producerDID, producerReputation[pledge.producerDID]);
    }

    /**
     * @notice Returns the status of a pledge.
     */
    function getPledgeStatus(bytes32 pledgeId) external view returns (PledgeStatus) {
        return _getPledge(pledgeId).status;
    }

    /**
     * @notice Sets the TRC-U mint rate for a commodity type. Oracle role only.
     * @param commodityType  keccak256 of commodity name
     * @param ratePerUnit    TRC-U minted per unit of commodity (1e18 precision)
     */
    function setCommodityMintRate(bytes32 commodityType, uint256 ratePerUnit) external onlyRole(ORACLE_ROLE) {
        commodityMintRate[commodityType] = ratePerUnit;
        emit CommodityRateSet(commodityType, ratePerUnit);
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _confirmPledge(Pledge storage pledge) internal {
        pledge.status = PledgeStatus.CONFIRMED;
        uint256 mintAmount = (pledge.quantity * commodityMintRate[pledge.commodityType]) / 1e18;
        pledge.mintedAmount = mintAmount;

        if (mintAmount > 0) {
            trcUtility.mint(pledge.producerAddress, mintAmount);
        }

        emit PledgeConfirmed(pledge.pledgeId, mintAmount);
    }

    function _getPledge(bytes32 pledgeId) internal view returns (Pledge storage) {
        Pledge storage p = _pledges[pledgeId];
        if (p.pledgeId == bytes32(0)) revert PledgeNotFound(pledgeId);
        return p;
    }

    error InvalidVerifierSignature();
}

interface ITRCUtility {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}
