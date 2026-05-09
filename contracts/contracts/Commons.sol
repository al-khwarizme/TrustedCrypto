// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Commons
 * @notice Manages the Commons Investment Pool — 30% of transaction fees fund
 *         collective ownership stakes in real-world productive assets.
 *         Revenue flows from operators to the Utility Pool; annual dividends
 *         are distributed weighted by contribution score.
 */
contract Commons is AccessControl, ReentrancyGuard {
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant OPERATOR_ROLE   = keccak256("OPERATOR_ROLE");
    bytes32 public constant ORACLE_ROLE     = keccak256("ORACLE_ROLE");

    enum ProjectStatus {
        PROPOSED,
        ACTIVE,
        EXITING,
        EXITED
    }

    struct Project {
        bytes32    projectId;
        address    operator;
        uint256    allocation;           // TRC-U committed from pool
        uint16     revenueShareBps;      // Operator keeps (10000 - revenueShareBps)
        uint256    minHoldPeriod;        // Seconds before exit is allowed
        uint256    approvedAt;
        uint256    totalRevenue;
        uint256    totalDistributed;
        ProjectStatus status;
    }

    ITRCUtility public trcUtility;

    mapping(bytes32 => Project)  public projects;
    bytes32[]                    public projectIds;

    /// @notice Accumulated dividend balance per DID (scored contribution → dividend weight)
    mapping(bytes32 => uint256)  public didDividendBalance;

    /// @notice Total pool balance (TRC-U)
    uint256 public poolBalance;

    /// @notice Annual revenue accumulated since last dividend distribution
    uint256 public annualRevenueAccumulated;
    uint256 public lastDividendAt;

    event ProjectProposed(bytes32 indexed projectId, address indexed operator, uint256 allocation, uint16 revenueShareBps);
    event ProjectApproved(bytes32 indexed projectId);
    event RevenueRecorded(bytes32 indexed projectId, uint256 amount, uint256 poolShare);
    event ExitInitiated(bytes32 indexed projectId);
    event ExitExecuted(bytes32 indexed projectId, uint256 saleProceeds);
    event DividendDistributed(uint256 totalAmount, uint256 recipientCount);
    event DividendClaimed(bytes32 indexed did, address indexed recipient, uint256 amount);

    error ProjectAlreadyExists(bytes32 projectId);
    error ProjectNotFound(bytes32 projectId);
    error InvalidStatus(ProjectStatus current, ProjectStatus required);
    error MinHoldPeriodNotElapsed(uint256 remaining);
    error InvalidAllocation();
    error ZeroAmount();

    constructor(address admin, address _trcUtility) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, admin);
        trcUtility = ITRCUtility(_trcUtility);
    }

    /**
     * @notice Proposes a new Commons investment project. Must be approved by Governance.
     * @param projectId       Unique identifier (e.g. keccak256("SOLAR_FARM_KENYA_2024"))
     * @param operator        Address of the project operator (receives remaining revenue share)
     * @param allocation      TRC-U to allocate from Commons Pool
     * @param revenueShareBps Basis points of revenue returned to pool (e.g. 7000 = 70%)
     * @param minHoldPeriod   Minimum seconds before exit vote is valid
     */
    function proposeProject(
        bytes32 projectId,
        address operator,
        uint256 allocation,
        uint16  revenueShareBps,
        uint256 minHoldPeriod
    ) external onlyRole(GOVERNANCE_ROLE) {
        if (projects[projectId].projectId != bytes32(0)) revert ProjectAlreadyExists(projectId);
        if (allocation == 0 || allocation > poolBalance)  revert InvalidAllocation();
        if (revenueShareBps > 10_000) revert InvalidAllocation();

        projects[projectId] = Project({
            projectId:       projectId,
            operator:        operator,
            allocation:      allocation,
            revenueShareBps: revenueShareBps,
            minHoldPeriod:   minHoldPeriod,
            approvedAt:      0,
            totalRevenue:    0,
            totalDistributed: 0,
            status:          ProjectStatus.PROPOSED
        });

        projectIds.push(projectId);
        emit ProjectProposed(projectId, operator, allocation, revenueShareBps);
    }

    /**
     * @notice Governance approves a proposed project and locks the allocation.
     */
    function approveProject(bytes32 projectId) external onlyRole(GOVERNANCE_ROLE) {
        Project storage p = _getProject(projectId);
        if (p.status != ProjectStatus.PROPOSED) revert InvalidStatus(p.status, ProjectStatus.PROPOSED);
        if (p.allocation > poolBalance) revert InvalidAllocation();

        poolBalance      -= p.allocation;
        p.status          = ProjectStatus.ACTIVE;
        p.approvedAt      = block.timestamp;

        emit ProjectApproved(projectId);
    }

    /**
     * @notice Operator records monthly revenue; the pool's share is distributed to the Utility Pool.
     * @dev Operator must have transferred `amount` of TRC-U to this contract before calling.
     * @param projectId  Project identifier
     * @param amount     Total revenue in TRC-U
     */
    function recordRevenue(bytes32 projectId, uint256 amount) external onlyRole(OPERATOR_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Project storage p = _getProject(projectId);
        if (p.status != ProjectStatus.ACTIVE) revert InvalidStatus(p.status, ProjectStatus.ACTIVE);

        uint256 poolShare     = (amount * p.revenueShareBps) / 10_000;
        uint256 operatorShare = amount - poolShare;

        p.totalRevenue += amount;
        annualRevenueAccumulated += poolShare;

        // Credit pool share back to the Commons Pool balance
        poolBalance += poolShare;

        // Distribute operator share via TRCUtility.mint (operator earned it)
        trcUtility.mint(p.operator, operatorShare);

        emit RevenueRecorded(projectId, amount, poolShare);
    }

    /**
     * @notice Governance initiates a project exit (requires vote).
     */
    function initiateExit(bytes32 projectId) external onlyRole(GOVERNANCE_ROLE) {
        Project storage p = _getProject(projectId);
        if (p.status != ProjectStatus.ACTIVE) revert InvalidStatus(p.status, ProjectStatus.ACTIVE);
        if (block.timestamp < p.approvedAt + p.minHoldPeriod) {
            revert MinHoldPeriodNotElapsed(p.approvedAt + p.minHoldPeriod - block.timestamp);
        }

        p.status = ProjectStatus.EXITING;
        emit ExitInitiated(projectId);
    }

    /**
     * @notice Finalizes a project exit, returning sale proceeds to the Commons Pool.
     * @param projectId    Project being exited
     * @param saleProceeds Total TRC-U received from asset sale
     */
    function executeExit(bytes32 projectId, uint256 saleProceeds) external onlyRole(GOVERNANCE_ROLE) nonReentrant {
        Project storage p = _getProject(projectId);
        if (p.status != ProjectStatus.EXITING) revert InvalidStatus(p.status, ProjectStatus.EXITING);

        p.status = ProjectStatus.EXITED;
        poolBalance += saleProceeds;

        emit ExitExecuted(projectId, saleProceeds);
    }

    /**
     * @notice Distributes annual dividends weighted by contribution score.
     *         Oracle provides the sorted list of (DID, score) pairs off-chain.
     * @param dids    Array of DID hashes to receive dividends
     * @param scores  Corresponding contribution scores
     */
    function distributeAnnualDividend(
        bytes32[] calldata dids,
        uint256[] calldata scores
    ) external onlyRole(ORACLE_ROLE) nonReentrant {
        if (dids.length != scores.length || dids.length == 0) revert LengthMismatch();

        uint256 totalDividend = annualRevenueAccumulated;
        if (totalDividend == 0) return;

        annualRevenueAccumulated = 0;
        lastDividendAt           = block.timestamp;

        uint256 totalScore = 0;
        for (uint256 i = 0; i < scores.length; i++) totalScore += scores[i];
        if (totalScore == 0) return;

        for (uint256 i = 0; i < dids.length; i++) {
            if (scores[i] == 0) continue;
            uint256 share = (totalDividend * scores[i]) / totalScore;
            didDividendBalance[dids[i]] += share;
        }

        emit DividendDistributed(totalDividend, dids.length);
    }

    /**
     * @notice Allows a DID holder to claim accumulated dividends to a specified address.
     * @param did       The claimant's DID hash
     * @param recipient Address to receive the TRC-U dividend
     */
    function claimDividend(bytes32 did, address recipient) external nonReentrant {
        // In production: verify msg.sender owns `did` via DID registry.
        // Simplified: trusts the caller — integrate with DID contract in full deployment.
        uint256 amount = didDividendBalance[did];
        if (amount == 0) revert ZeroAmount();

        didDividendBalance[did] = 0;
        trcUtility.mint(recipient, amount);

        emit DividendClaimed(did, recipient, amount);
    }

    /**
     * @notice Returns all project IDs.
     */
    function getProjectIds() external view returns (bytes32[] memory) {
        return projectIds;
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _getProject(bytes32 projectId) internal view returns (Project storage) {
        Project storage p = projects[projectId];
        if (p.projectId == bytes32(0)) revert ProjectNotFound(projectId);
        return p;
    }

    error LengthMismatch();
}

interface ITRCUtility {
    function mint(address to, uint256 amount) external;
}
