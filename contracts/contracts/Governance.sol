// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title Governance
 * @notice On-chain governance with one-DID-one-vote, multiple proposal types,
 *         and type-specific quorums, thresholds, and timelocks.
 *
 *         Proposal types and parameters:
 *           STANDARD        — 10% quorum, 51% threshold, 2-day timelock
 *           PROTOCOL        — 20% quorum, 66% threshold, 7-day timelock
 *           RESERVE_POLICY  — 25% quorum, 75% threshold, 7-day timelock
 *           CONSTITUTIONAL  — 33% quorum, 80% threshold, 14-day timelock
 *           EMERGENCY       — 10% quorum, 66% threshold, 0 timelock (DAO guardian required)
 */
contract Governance is AccessControl, ReentrancyGuard {
    bytes32 public constant GUARDIAN_ROLE  = keccak256("GUARDIAN_ROLE");
    bytes32 public constant DID_REGISTRY   = keccak256("DID_REGISTRY");

    enum ProposalType {
        STANDARD,
        PROTOCOL,
        RESERVE_POLICY,
        CONSTITUTIONAL,
        EMERGENCY
    }

    enum ProposalState {
        PENDING,
        ACTIVE,
        SUCCEEDED,
        DEFEATED,
        QUEUED,
        EXECUTED,
        CANCELLED
    }

    struct ProposalParams {
        uint256 quorumBps;     // Minimum % of registered DIDs that must vote
        uint256 thresholdBps;  // % of votes that must be in favor
        uint256 timelockSecs;  // Seconds to wait after success before execution
    }

    struct Proposal {
        uint256      id;
        bytes32      proposerDID;
        string       description;
        ProposalType ptype;
        bytes        executionData;
        address      executionTarget;
        uint256      votesFor;
        uint256      votesAgainst;
        uint256      startTime;
        uint256      endTime;
        uint256      queuedAt;
        bool         executed;
        bool         cancelled;
    }

    IWalletCap public walletCap;

    uint256 public constant VOTING_PERIOD   = 5 days;
    uint256 public constant PROPOSAL_COOLDOWN = 1 days; // proposer cooldown
    uint256 public totalRegisteredDIDs;

    mapping(ProposalType => ProposalParams) public typeParams;

    uint256 public proposalCount;
    mapping(uint256 => Proposal)                  public proposals;
    mapping(uint256 => mapping(bytes32 => bool))  public hasVoted;     // proposalId => did => voted
    mapping(bytes32 => uint256)                   public lastProposed;  // did => timestamp

    event ProposalCreated(uint256 indexed id, bytes32 indexed proposerDID, ProposalType ptype, string description);
    event VoteCast(uint256 indexed proposalId, bytes32 indexed did, bool support, uint256 weight);
    event ProposalQueued(uint256 indexed proposalId, uint256 eta);
    event ProposalExecuted(uint256 indexed proposalId);
    event ProposalCancelled(uint256 indexed proposalId);
    event DIDCountUpdated(uint256 newCount);

    error ProposalNotFound(uint256 id);
    error VotingClosed(uint256 id);
    error VotingStillOpen(uint256 id);
    error AlreadyVoted(uint256 id, bytes32 did);
    error DIDNotRegistered(bytes32 did);
    error ProposalNotSucceeded(uint256 id);
    error TimelockNotElapsed(uint256 eta);
    error ProposalAlreadyExecuted(uint256 id);
    error ProposalCancelledError(uint256 id);
    error ProposerCooldown(bytes32 did, uint256 remaining);
    error EmergencyRequiresGuardian();

    constructor(address admin, address _walletCap) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
        walletCap = IWalletCap(_walletCap);

        typeParams[ProposalType.STANDARD]       = ProposalParams(1000, 5100, 2 days);
        typeParams[ProposalType.PROTOCOL]       = ProposalParams(2000, 6600, 7 days);
        typeParams[ProposalType.RESERVE_POLICY] = ProposalParams(2500, 7500, 7 days);
        typeParams[ProposalType.CONSTITUTIONAL] = ProposalParams(3300, 8000, 14 days);
        typeParams[ProposalType.EMERGENCY]      = ProposalParams(1000, 6600, 0);
    }

    /**
     * @notice Creates a new governance proposal.
     * @param description    Human-readable description of the proposal
     * @param ptype          Proposal type determining quorum, threshold, and timelock
     * @param executionTarget Contract address to call on execution
     * @param executionData  ABI-encoded function call to execute
     * @param proposerDID    DID of the proposer (must be registered)
     */
    function propose(
        string calldata description,
        ProposalType ptype,
        address executionTarget,
        bytes calldata executionData,
        bytes32 proposerDID
    ) external nonReentrant returns (uint256 proposalId) {
        if (!_isDIDRegistered(proposerDID)) revert DIDNotRegistered(proposerDID);
        if (ptype == ProposalType.EMERGENCY && !hasRole(GUARDIAN_ROLE, msg.sender)) {
            revert EmergencyRequiresGuardian();
        }

        uint256 cooldownEnd = lastProposed[proposerDID] + PROPOSAL_COOLDOWN;
        if (block.timestamp < cooldownEnd) {
            revert ProposerCooldown(proposerDID, cooldownEnd - block.timestamp);
        }

        proposalId = proposalCount++;
        lastProposed[proposerDID] = block.timestamp;

        proposals[proposalId] = Proposal({
            id:              proposalId,
            proposerDID:     proposerDID,
            description:     description,
            ptype:           ptype,
            executionData:   executionData,
            executionTarget: executionTarget,
            votesFor:        0,
            votesAgainst:    0,
            startTime:       block.timestamp,
            endTime:         block.timestamp + VOTING_PERIOD,
            queuedAt:        0,
            executed:        false,
            cancelled:       false
        });

        emit ProposalCreated(proposalId, proposerDID, ptype, description);
    }

    /**
     * @notice Casts a vote on an active proposal. One vote per DID per proposal.
     * @param proposalId  ID of the proposal
     * @param support     true = vote for, false = vote against
     * @param did         Voter's DID hash (must be registered in WalletCap)
     */
    function vote(
        uint256 proposalId,
        bool support,
        bytes32 did
    ) external nonReentrant {
        Proposal storage p = _getProposal(proposalId);
        if (p.cancelled) revert ProposalCancelledError(proposalId);
        if (block.timestamp > p.endTime) revert VotingClosed(proposalId);
        if (!_isDIDRegistered(did)) revert DIDNotRegistered(did);
        if (hasVoted[proposalId][did]) revert AlreadyVoted(proposalId, did);

        hasVoted[proposalId][did] = true;

        if (support) {
            p.votesFor++;
        } else {
            p.votesAgainst++;
        }

        emit VoteCast(proposalId, did, support, 1);
    }

    /**
     * @notice Queues a successful proposal into the timelock.
     */
    function queue(uint256 proposalId) external {
        Proposal storage p = _getProposal(proposalId);
        if (block.timestamp <= p.endTime) revert VotingStillOpen(proposalId);
        if (_state(p) != ProposalState.SUCCEEDED) revert ProposalNotSucceeded(proposalId);

        p.queuedAt = block.timestamp;
        emit ProposalQueued(proposalId, block.timestamp + typeParams[p.ptype].timelockSecs);
    }

    /**
     * @notice Executes a queued proposal after its timelock has elapsed.
     */
    function execute(uint256 proposalId) external nonReentrant {
        Proposal storage p = _getProposal(proposalId);
        if (p.executed)  revert ProposalAlreadyExecuted(proposalId);
        if (p.cancelled) revert ProposalCancelledError(proposalId);

        if (_state(p) != ProposalState.QUEUED) revert ProposalNotSucceeded(proposalId);

        uint256 eta = p.queuedAt + typeParams[p.ptype].timelockSecs;
        if (block.timestamp < eta) revert TimelockNotElapsed(eta);

        p.executed = true;

        (bool success, bytes memory returndata) = p.executionTarget.call(p.executionData);
        if (!success) {
            if (returndata.length > 0) {
                assembly {
                    revert(add(32, returndata), mload(returndata))
                }
            }
            revert ExecutionFailed(proposalId);
        }

        emit ProposalExecuted(proposalId);
    }

    /**
     * @notice Cancels a proposal. Only guardian or proposer can cancel.
     */
    function cancel(uint256 proposalId, bytes32 callerDID) external {
        Proposal storage p = _getProposal(proposalId);
        if (p.executed) revert ProposalAlreadyExecuted(proposalId);

        bool isGuardian  = hasRole(GUARDIAN_ROLE, msg.sender);
        bool isProposer  = (callerDID == p.proposerDID && _isDIDRegistered(callerDID));

        if (!isGuardian && !isProposer) revert Unauthorized();

        p.cancelled = true;
        emit ProposalCancelled(proposalId);
    }

    /**
     * @notice Returns the current state of a proposal.
     */
    function state(uint256 proposalId) external view returns (ProposalState) {
        return _state(_getProposal(proposalId));
    }

    /**
     * @notice Updates the total registered DID count (called by DID registry).
     */
    function updateDIDCount(uint256 count) external onlyRole(DID_REGISTRY) {
        totalRegisteredDIDs = count;
        emit DIDCountUpdated(count);
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _state(Proposal storage p) internal view returns (ProposalState) {
        if (p.cancelled) return ProposalState.CANCELLED;
        if (p.executed)  return ProposalState.EXECUTED;

        if (block.timestamp <= p.endTime) return ProposalState.ACTIVE;

        ProposalParams storage params = typeParams[p.ptype];
        uint256 totalVotes = p.votesFor + p.votesAgainst;

        // Quorum check: totalVotes must be >= quorum% of registered DIDs
        uint256 quorumRequired = (totalRegisteredDIDs * params.quorumBps) / 10_000;
        if (totalVotes < quorumRequired) return ProposalState.DEFEATED;

        // Threshold: forVotes / totalVotes >= threshold%
        if (totalVotes == 0) return ProposalState.DEFEATED;
        uint256 forBps = (p.votesFor * 10_000) / totalVotes;
        if (forBps < params.thresholdBps) return ProposalState.DEFEATED;

        if (p.queuedAt == 0) return ProposalState.SUCCEEDED;
        return ProposalState.QUEUED;
    }

    function _getProposal(uint256 id) internal view returns (Proposal storage) {
        if (id >= proposalCount) revert ProposalNotFound(id);
        return proposals[id];
    }

    function _isDIDRegistered(bytes32 did) internal view returns (bool) {
        // Delegates to WalletCap which is the source of truth for DID registration
        return walletCap.isDIDRegistered(did);
    }

    error ExecutionFailed(uint256 proposalId);
    error Unauthorized();
}

interface IWalletCap {
    function isDIDRegistered(bytes32 did) external view returns (bool);
}
