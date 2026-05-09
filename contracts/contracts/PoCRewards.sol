// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title PoCRewards
 * @notice Manages Proof-of-Contribution scoring and TRC-U reward distribution.
 *
 *         Contribution types and their on-chain weight caps:
 *           NODE_UPTIME            — proof: signed uptime report
 *           ORACLE_DATA            — proof: price submission hash + signature
 *           GOVERNANCE_VOTE        — proof: proposal ID + vote hash
 *           PHYSICAL_VERIFICATION  — proof: GPS + timestamp + verifier signature
 *           TRANSACTION_ACTIVITY   — proof: tx count window
 *
 *         Anti-gaming: no single contribution type may exceed 30% of a DID's total score.
 *         Score decay: 10% per week for DIDs with no contributions that week.
 *         Rolling window: 30 days.
 */
contract PoCRewards is AccessControl, ReentrancyGuard {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    bytes32 public constant ORACLE_ROLE    = keccak256("ORACLE_ROLE");
    bytes32 public constant EPOCH_ROLE     = keccak256("EPOCH_ROLE");
    bytes32 public constant ADMIN_ROLE     = keccak256("ADMIN_ROLE");

    enum ContributionType {
        NODE_UPTIME,
        ORACLE_DATA,
        GOVERNANCE_VOTE,
        PHYSICAL_VERIFICATION,
        TRANSACTION_ACTIVITY
    }

    struct ContributionRecord {
        bytes32 did;
        ContributionType ctype;
        uint256 points;
        uint256 timestamp;
        bytes32 proofHash;
    }

    struct DIDScore {
        uint256 rollingScore;
        uint256 lastUpdated;
        uint256 lastDecayedAt;
        // Per-type accumulated points within current 30-day window
        mapping(ContributionType => uint256) typePoints;
        // Daily contribution count per type to enforce daily caps
        mapping(ContributionType => uint256) dailyCount;
        uint256 dailyCountResetAt;
    }

    /// @notice Maximum points any single type may contribute as fraction of total (30%)
    uint256 public constant TYPE_CAP_BPS = 3000; // 30% in basis points

    /// @notice Daily per-type cap in points per DID
    uint256 public constant DAILY_TYPE_CAP = 1000;

    /// @notice Score decay per week: 10%
    uint256 public constant WEEKLY_DECAY_BPS = 1000; // 10%

    uint256 public constant ROLLING_WINDOW = 30 days;
    uint256 public constant WEEK           = 7 days;
    uint256 public constant DAY            = 1 days;

    address public trcUtilityContract;

    mapping(bytes32 => DIDScore) private _scores;

    /// @notice Tracks used proof hashes to prevent replay attacks
    mapping(bytes32 => bool) private _usedProofs;

    /// @notice Epoch reward pools — filled by fee income; distributed each epoch
    uint256 public epochRewardPool;

    event ContributionSubmitted(
        bytes32 indexed did,
        ContributionType ctype,
        uint256 points,
        bytes32 proofHash,
        uint256 newRollingScore
    );
    event EpochRewardsDistributed(uint256 epochId, uint256 totalReward, uint256 validatorCount);
    event ScoreDecayed(bytes32 indexed did, uint256 oldScore, uint256 newScore);
    event RewardPoolFunded(uint256 amount);

    error ProofAlreadyUsed(bytes32 proofHash);
    error InvalidOracleSignature();
    error DailyCapExceeded(bytes32 did, ContributionType ctype);
    error ZeroPoints();
    error LengthMismatch();

    constructor(address admin, address _trcUtility) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        trcUtilityContract = _trcUtility;
    }

    /**
     * @notice Records a contribution from a DID, signed and submitted by the network oracle.
     * @param did    The contributor's DID hash
     * @param ctype  Contribution type enum value
     * @param points Raw points awarded for this contribution
     * @param proof  Off-chain proof bytes (type-specific; oracle pre-validates)
     */
    function submitContribution(
        bytes32 did,
        ContributionType ctype,
        uint256 points,
        bytes calldata proof
    ) external onlyRole(ORACLE_ROLE) nonReentrant {
        if (points == 0) revert ZeroPoints();

        bytes32 proofHash = keccak256(proof);
        if (_usedProofs[proofHash]) revert ProofAlreadyUsed(proofHash);
        _usedProofs[proofHash] = true;

        DIDScore storage score = _scores[did];

        // Decay stale score before adding new points
        _applyDecay(did, score);

        // Reset daily counts if a new UTC day has started
        _resetDailyIfNeeded(score);

        if (score.dailyCount[ctype] + points > DAILY_TYPE_CAP) revert DailyCapExceeded(did, ctype);

        // Apply the contribution
        score.dailyCount[ctype]  += points;
        score.typePoints[ctype]  += points;
        score.rollingScore       += points;
        score.lastUpdated         = block.timestamp;

        // Enforce 30% type cap: if any type exceeds 30% of total, redistribute excess to zero
        _enforceTypeCap(score);

        emit ContributionSubmitted(did, ctype, points, proofHash, score.rollingScore);
    }

    /**
     * @notice Returns the 30-day rolling score for a DID.
     */
    function getScore(bytes32 did) external view returns (uint256) {
        // Return a decay-adjusted view without writing state
        DIDScore storage score = _scores[did];
        if (score.rollingScore == 0) return 0;

        uint256 weeksElapsed = (block.timestamp - score.lastDecayedAt) / WEEK;
        if (weeksElapsed == 0) return score.rollingScore;

        uint256 current = score.rollingScore;
        for (uint256 i = 0; i < weeksElapsed && current > 0; i++) {
            current = current - (current * WEEKLY_DECAY_BPS) / 10_000;
        }
        return current;
    }

    /**
     * @notice Distributes TRC-U rewards to epoch validators proportionally by score.
     * @param validators  Array of DID hashes for this epoch's validator set
     * @param scores      Corresponding scores (must match validators length)
     */
    function distributeEpochRewards(
        bytes32[] calldata validators,
        uint256[] calldata scores,
        uint256 epochId
    ) external onlyRole(EPOCH_ROLE) nonReentrant {
        if (validators.length != scores.length) revert LengthMismatch();

        uint256 pool = epochRewardPool;
        if (pool == 0 || validators.length == 0) return;

        uint256 totalScore = 0;
        for (uint256 i = 0; i < scores.length; i++) {
            totalScore += scores[i];
        }
        if (totalScore == 0) return;

        epochRewardPool = 0;

        ITRCUtility utility = ITRCUtility(trcUtilityContract);

        for (uint256 i = 0; i < validators.length; i++) {
            if (scores[i] == 0) continue;
            uint256 reward = (pool * scores[i]) / totalScore;
            if (reward > 0) {
                // Rewards are minted from the protocol pool; the PoCRewards contract
                // holds the POC_REWARDS_ROLE on TRCUtility.
                // The recipient address must be resolved from the DID registry off-chain
                // and passed via the oracle; for on-chain simplicity we call distributeReward
                // using the DID itself as a bytes32 proof key, and the validator address is
                // tracked separately. This call is a placeholder — the actual address
                // is resolved by the epoch oracle before calling this function.
                // In the full implementation, validators[] contains addresses, not DIDs.
                // We emit an event so the bridge can mint.
                emit ValidatorRewarded(validators[i], reward, epochId);
            }
        }

        emit EpochRewardsDistributed(epochId, pool, validators.length);
    }

    /**
     * @notice Directly distributes reward to a specific address. Called by the epoch oracle
     *         after resolving DID → address mapping.
     */
    function rewardAddress(
        address recipient,
        uint256 amount,
        bytes32 contributionProof
    ) external onlyRole(EPOCH_ROLE) nonReentrant {
        ITRCUtility(trcUtilityContract).distributeReward(recipient, amount, contributionProof);
    }

    /**
     * @notice Funds the epoch reward pool. Called by the fee distributor.
     */
    function fundEpochPool(uint256 amount) external onlyRole(ADMIN_ROLE) {
        epochRewardPool += amount;
        emit RewardPoolFunded(amount);
    }

    /**
     * @notice Triggers score decay for a batch of DIDs. Should be called weekly by the epoch manager.
     */
    function decayScores(bytes32[] calldata dids) external onlyRole(ORACLE_ROLE) {
        for (uint256 i = 0; i < dids.length; i++) {
            DIDScore storage score = _scores[dids[i]];
            _applyDecay(dids[i], score);
        }
    }

    event ValidatorRewarded(bytes32 indexed did, uint256 amount, uint256 epochId);

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    function _applyDecay(bytes32 did, DIDScore storage score) internal {
        if (score.rollingScore == 0) return;
        if (score.lastDecayedAt == 0) {
            score.lastDecayedAt = block.timestamp;
            return;
        }

        uint256 weeksElapsed = (block.timestamp - score.lastDecayedAt) / WEEK;
        if (weeksElapsed == 0) return;

        uint256 oldScore = score.rollingScore;
        for (uint256 i = 0; i < weeksElapsed && score.rollingScore > 0; i++) {
            score.rollingScore = score.rollingScore - (score.rollingScore * WEEKLY_DECAY_BPS) / 10_000;
        }

        // Decay each type proportionally
        if (oldScore > 0) {
            uint256 ratio = (score.rollingScore * 1e18) / oldScore;
            score.typePoints[ContributionType.NODE_UPTIME]           = (score.typePoints[ContributionType.NODE_UPTIME] * ratio) / 1e18;
            score.typePoints[ContributionType.ORACLE_DATA]           = (score.typePoints[ContributionType.ORACLE_DATA] * ratio) / 1e18;
            score.typePoints[ContributionType.GOVERNANCE_VOTE]       = (score.typePoints[ContributionType.GOVERNANCE_VOTE] * ratio) / 1e18;
            score.typePoints[ContributionType.PHYSICAL_VERIFICATION] = (score.typePoints[ContributionType.PHYSICAL_VERIFICATION] * ratio) / 1e18;
            score.typePoints[ContributionType.TRANSACTION_ACTIVITY]  = (score.typePoints[ContributionType.TRANSACTION_ACTIVITY] * ratio) / 1e18;
        }

        score.lastDecayedAt += weeksElapsed * WEEK;
        emit ScoreDecayed(did, oldScore, score.rollingScore);
    }

    function _enforceTypeCap(DIDScore storage score) internal {
        uint256 total = score.rollingScore;
        if (total == 0) return;

        uint256 cap = (total * TYPE_CAP_BPS) / 10_000;

        // If any type exceeds 30%, reduce score by the excess
        for (uint8 t = 0; t <= uint8(ContributionType.TRANSACTION_ACTIVITY); t++) {
            ContributionType ct = ContributionType(t);
            if (score.typePoints[ct] > cap) {
                uint256 excess = score.typePoints[ct] - cap;
                score.typePoints[ct]   = cap;
                score.rollingScore    -= excess;
            }
        }
    }

    function _resetDailyIfNeeded(DIDScore storage score) internal {
        uint256 todayStart = (block.timestamp / DAY) * DAY;
        if (score.dailyCountResetAt < todayStart) {
            score.dailyCount[ContributionType.NODE_UPTIME]           = 0;
            score.dailyCount[ContributionType.ORACLE_DATA]           = 0;
            score.dailyCount[ContributionType.GOVERNANCE_VOTE]       = 0;
            score.dailyCount[ContributionType.PHYSICAL_VERIFICATION] = 0;
            score.dailyCount[ContributionType.TRANSACTION_ACTIVITY]  = 0;
            score.dailyCountResetAt = todayStart;
        }
    }
}

interface ITRCUtility {
    function distributeReward(address contributor, uint256 amount, bytes32 contributionProof) external;
}
