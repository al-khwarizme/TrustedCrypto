// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title WalletCap
 * @notice Enforces a per-DID (not per-address) aggregate balance cap across both TRC-G and TRC-U.
 *         The cap is dynamic and scales with network size to prevent wealth concentration.
 *
 *         Cap schedule (total supply share):
 *           >= 1,000,000 participants  → 0.01%
 *           100,000 – 999,999          → 0.10%
 *           10,000 – 99,999            → 0.50%
 *           < 10,000                   → 1.00%
 */
contract WalletCap is AccessControl, ReentrancyGuard {
    bytes32 public constant DID_REGISTRY_ROLE = keccak256("DID_REGISTRY_ROLE");
    bytes32 public constant TOKEN_ROLE        = keccak256("TOKEN_ROLE");    // granted to TRC-G and TRC-U
    bytes32 public constant ORACLE_ROLE       = keccak256("ORACLE_ROLE");   // updates participant count

    // --- DID ↔ address mapping ---
    mapping(bytes32 => address[])  private _didToAddresses;
    mapping(address => bytes32)    private _addressToDid;
    mapping(bytes32 => bool)       private _registeredDid;

    // --- Aggregate balances per DID (combined TRC-G + TRC-U in native units) ---
    // We track aggregate in a single unit for cap purposes; the oracle provides the
    // exchange rate used for cross-token aggregation if desired. For simplicity, both
    // tokens are considered unit-equivalent for cap enforcement (most conservative).
    mapping(bytes32 => uint256) public didAggregateBalance;

    /// @notice Current count of registered unique participants, updated by oracle
    uint256 public participantCount;

    /// @notice Total supply used for cap calculation, updated by oracle
    uint256 public totalNetworkSupply;

    event AddressRegistered(bytes32 indexed did, address indexed wallet);
    event AddressRevoked(bytes32 indexed did, address indexed wallet);
    event ParticipantCountUpdated(uint256 newCount, uint256 newTotalSupply);
    event BalanceUpdated(bytes32 indexed did, uint256 newAggregate);

    error AddressAlreadyRegistered(address wallet);
    error AddressNotRegistered(address wallet);
    error DIDNotRegistered(bytes32 did);
    error CapExceeded(bytes32 did, uint256 currentBalance, uint256 additionalAmount, uint256 cap);
    error ZeroAddress();
    error ZeroDID();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /**
     * @notice Links a wallet address to a DID. Must be called by the DID registry
     *         or an authorized identity contract after human-proof verification.
     * @param did    The W3C-style DID identifier (keccak hash of the DID string for storage)
     * @param wallet The wallet address to associate
     */
    function registerAddress(bytes32 did, address wallet) external onlyRole(DID_REGISTRY_ROLE) {
        if (wallet == address(0)) revert ZeroAddress();
        if (did == bytes32(0))    revert ZeroDID();
        if (_addressToDid[wallet] != bytes32(0)) revert AddressAlreadyRegistered(wallet);

        _addressToDid[wallet] = did;
        _didToAddresses[did].push(wallet);
        _registeredDid[did] = true;

        emit AddressRegistered(did, wallet);
    }

    /**
     * @notice Revokes a wallet-to-DID link. Existing balances are unaffected but
     *         the address can no longer receive tokens under this DID.
     */
    function revokeAddress(bytes32 did, address wallet) external onlyRole(DID_REGISTRY_ROLE) {
        if (_addressToDid[wallet] != did) revert AddressNotRegistered(wallet);

        _addressToDid[wallet] = bytes32(0);

        address[] storage addrs = _didToAddresses[did];
        for (uint256 i = 0; i < addrs.length; i++) {
            if (addrs[i] == wallet) {
                addrs[i] = addrs[addrs.length - 1];
                addrs.pop();
                break;
            }
        }

        emit AddressRevoked(did, wallet);
    }

    /**
     * @notice Called by TRC-G and TRC-U before every transfer to enforce the DID cap.
     * @dev Reverts if the recipient's DID aggregate would exceed the current cap.
     *      Transfers to unregistered addresses are allowed but untracked (for exchange compatibility).
     */
    function enforceCapOnTransfer(address wallet, uint256 additionalAmount) external view onlyRole(TOKEN_ROLE) {
        bytes32 did = _addressToDid[wallet];
        if (did == bytes32(0)) return; // unregistered address, no cap enforcement

        uint256 cap = _computeCap();
        uint256 current = didAggregateBalance[did];
        if (current + additionalAmount > cap) {
            revert CapExceeded(did, current, additionalAmount, cap);
        }
    }

    /**
     * @notice Records a balance change for a DID. Called by token contracts after
     *         successful transfer. Separate from enforceCapOnTransfer to allow
     *         the token contract to call both in sequence.
     */
    function recordTransfer(address wallet, int256 delta) external onlyRole(TOKEN_ROLE) {
        bytes32 did = _addressToDid[wallet];
        if (did == bytes32(0)) return;

        if (delta > 0) {
            didAggregateBalance[did] += uint256(delta);
        } else {
            uint256 abs = uint256(-delta);
            if (abs > didAggregateBalance[did]) {
                didAggregateBalance[did] = 0;
            } else {
                didAggregateBalance[did] -= abs;
            }
        }

        emit BalanceUpdated(did, didAggregateBalance[did]);
    }

    /**
     * @notice Checks whether a DID can receive an additional amount without exceeding its cap.
     * @param did              The DID identifier
     * @param additionalAmount Amount to be received
     * @return true if under cap
     */
    function checkCap(bytes32 did, uint256 additionalAmount) public view returns (bool) {
        if (!_registeredDid[did]) return false;
        uint256 cap = _computeCap();
        return (didAggregateBalance[did] + additionalAmount) <= cap;
    }

    /**
     * @notice Returns the current cap in token units based on participant count and total supply.
     */
    function getCap() public view returns (uint256) {
        return _computeCap();
    }

    /**
     * @notice Returns all wallet addresses associated with a DID.
     */
    function getAddressesForDID(bytes32 did) external view returns (address[] memory) {
        return _didToAddresses[did];
    }

    /**
     * @notice Returns the DID for a given wallet address.
     */
    function getDIDForAddress(address wallet) external view returns (bytes32) {
        return _addressToDid[wallet];
    }

    /**
     * @notice Oracle updates the participant count and total supply used for cap computation.
     */
    function updateNetworkStats(uint256 _participantCount, uint256 _totalSupply) external onlyRole(ORACLE_ROLE) {
        participantCount   = _participantCount;
        totalNetworkSupply = _totalSupply;
        emit ParticipantCountUpdated(_participantCount, _totalSupply);
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _computeCap() internal view returns (uint256) {
        if (totalNetworkSupply == 0) return type(uint256).max;

        uint256 bps;
        if (participantCount >= 1_000_000) {
            bps = 1;    // 0.01%
        } else if (participantCount >= 100_000) {
            bps = 10;   // 0.10%
        } else if (participantCount >= 10_000) {
            bps = 50;   // 0.50%
        } else {
            bps = 100;  // 1.00%
        }

        // totalNetworkSupply * bps / 10000
        return (totalNetworkSupply * bps) / 10_000;
    }
}
