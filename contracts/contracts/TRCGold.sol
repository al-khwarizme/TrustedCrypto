// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title TRCGold
 * @notice Gold-backed ERC-20 token. Each token represents one gram of physical gold
 *         held in an audited vault. Minting is only possible when physical gold enters
 *         the reserve; redemption burns tokens against the Reserve contract.
 */
contract TRCGold is ERC20, AccessControl, ReentrancyGuard, Pausable {
    bytes32 public constant RESERVE_ROLE = keccak256("RESERVE_ROLE");
    bytes32 public constant REDEMPTION_ROLE = keccak256("REDEMPTION_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    bytes32 public constant WALLET_CAP_ROLE = keccak256("WALLET_CAP_ROLE");

    /// @notice Grams of gold physically held in reserve (18 decimal fixed point, same as token)
    uint256 public gramsInReserve;

    /// @notice Maps deposit proof hash to the amount minted against it — prevents double-minting
    mapping(bytes32 => uint256) public depositProofToMinted;

    /// @notice Transfer hook: called before every transfer to enforce wallet caps
    address public walletCapContract;

    event GoldMinted(address indexed to, uint256 amount, bytes32 indexed depositProof, uint256 gramsInReserve);
    event GoldBurned(address indexed from, uint256 amount, uint256 gramsInReserve);
    event AuditFreezeToggled(bool frozen, address indexed auditor);
    event ReserveUpdated(uint256 newGramsInReserve);
    event WalletCapContractSet(address indexed newContract);

    error DepositProofAlreadyUsed(bytes32 proof);
    error ReserveMismatch(uint256 reserve, uint256 supply);
    error ZeroAmount();
    error InvalidDepositProof();

    constructor(address admin) ERC20("TrustedCrypto Gold", "TRC-G") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(AUDITOR_ROLE, admin);
    }

    /**
     * @notice Mints TRC-G backed by a verified physical gold deposit.
     * @dev Only callable by the Reserve contract after auditor signatures are verified.
     *      Each deposit proof can only be used once to prevent double-minting.
     * @param to        Recipient of newly minted tokens
     * @param amount    Amount in token units (1e18 = 1 gram)
     * @param depositProof  Keccak hash of the audited vault receipt, included on-chain for auditability
     */
    function mint(
        address to,
        uint256 amount,
        bytes32 depositProof
    ) external onlyRole(RESERVE_ROLE) whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (depositProof == bytes32(0)) revert InvalidDepositProof();
        if (depositProofToMinted[depositProof] != 0) revert DepositProofAlreadyUsed(depositProof);

        depositProofToMinted[depositProof] = amount;
        gramsInReserve += amount;
        _mint(to, amount);

        emit GoldMinted(to, amount, depositProof, gramsInReserve);
    }

    /**
     * @notice Burns TRC-G when physical gold is released for redemption.
     * @dev Only callable by the Redemption contract after redemption order verification.
     * @param from   Address whose tokens are burned
     * @param amount Amount to burn
     */
    function burn(address from, uint256 amount) external onlyRole(REDEMPTION_ROLE) nonReentrant {
        if (amount == 0) revert ZeroAmount();
        gramsInReserve -= amount;
        _burn(from, amount);

        emit GoldBurned(from, amount, gramsInReserve);
    }

    /**
     * @notice Freezes all transfers during a reserve audit. Existing balances are untouched.
     */
    function auditFreeze() external onlyRole(AUDITOR_ROLE) {
        _pause();
        emit AuditFreezeToggled(true, msg.sender);
    }

    /**
     * @notice Unfreezes transfers once the audit is complete and reserve integrity is confirmed.
     */
    function auditUnfreeze() external onlyRole(AUDITOR_ROLE) {
        _unpause();
        emit AuditFreezeToggled(false, msg.sender);
    }

    /**
     * @notice Returns the reserve ratio as a fixed-point number (1e18 = 100%).
     *         This should always equal exactly 1e18 — any deviation signals a critical failure.
     */
    function reserveRatio() public view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return 1e18;
        // gramsInReserve and totalSupply both use 18 decimals
        return (gramsInReserve * 1e18) / supply;
    }

    /**
     * @notice Sets the WalletCap contract address so transfers can be validated.
     */
    function setWalletCapContract(address cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        walletCapContract = cap;
        emit WalletCapContractSet(cap);
    }

    /**
     * @dev Hook called before every transfer. Enforces wallet cap per DID and
     *      updates the WalletCap aggregate balance so cumulative cap tracking works.
     *      Skipped for mint/burn (to/from == address(0)).
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
