// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SurplusConversion
 * @notice Opens a TRC-U → TRC-G conversion window when the reserve ratio exceeds 110%.
 *         Window parameters:
 *           - Duration:    72 hours
 *           - Frequency:   At most once per 30 days
 *           - Max per window: 5% of reserve surplus
 *           - Auto-close:  If reserve ratio drops to 105%
 */
contract SurplusConversion is AccessControl, ReentrancyGuard {
    bytes32 public constant ORACLE_ROLE    = keccak256("ORACLE_ROLE");
    bytes32 public constant OPERATOR_ROLE  = keccak256("OPERATOR_ROLE");

    uint256 public constant WINDOW_DURATION     = 72 hours;
    uint256 public constant WINDOW_COOLDOWN     = 30 days;
    uint256 public constant OPEN_RATIO_BPS      = 11000; // 110% in bps (ratio * 10000 / 1e18)
    uint256 public constant CLOSE_RATIO_BPS     = 10500; // 105%
    uint256 public constant MAX_SURPLUS_SHARE   = 500;   // 5% of surplus in bps

    ITRCGold    public trcGold;
    ITRCUtility public trcUtility;
    IReserve    public reserve;

    bool    public isWindowOpen;
    uint256 public windowOpenedAt;
    uint256 public lastWindowClosedAt;
    uint256 public windowAllowance;       // TRC-G that can still be minted this window
    uint256 public windowConverted;       // TRC-G minted so far this window

    // Exchange rate: how many TRC-U per 1 TRC-G (set at window open, in 1e18)
    uint256 public conversionRate;

    event WindowOpened(uint256 timestamp, uint256 allowance, uint256 rate);
    event WindowClosed(uint256 timestamp, uint256 totalConverted);
    event ConversionExecuted(address indexed user, uint256 uAmount, uint256 gAmount);

    error WindowNotOpen();
    error WindowAlreadyOpen();
    error CooldownNotElapsed(uint256 remaining);
    error RatioBelowThreshold(uint256 ratio);
    error ExceedsWindowAllowance(uint256 requested, uint256 remaining);
    error ZeroAmount();

    constructor(address admin, address _trcGold, address _trcUtility, address _reserve) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
        trcGold     = ITRCGold(_trcGold);
        trcUtility  = ITRCUtility(_trcUtility);
        reserve     = IReserve(_reserve);
    }

    /**
     * @notice Returns whether the conversion window is currently active.
     */
    function windowOpen() public view returns (bool) {
        if (!isWindowOpen) return false;
        if (block.timestamp > windowOpenedAt + WINDOW_DURATION) return false;
        uint256 currentRatioBps = (reserve.reserveRatio() * 10_000) / 1e18;
        if (currentRatioBps < CLOSE_RATIO_BPS) return false;
        return true;
    }

    /**
     * @notice Opens a conversion window. Callable by the oracle when reserve ratio > 110%.
     *         Computes the window allowance as 5% of the surplus gold.
     */
    function openWindow() external onlyRole(ORACLE_ROLE) {
        if (isWindowOpen) revert WindowAlreadyOpen();

        if (block.timestamp < lastWindowClosedAt + WINDOW_COOLDOWN) {
            revert CooldownNotElapsed(lastWindowClosedAt + WINDOW_COOLDOWN - block.timestamp);
        }

        uint256 currentRatio = reserve.reserveRatio(); // 1e18 = 100%
        uint256 ratioBps     = (currentRatio * 10_000) / 1e18;
        if (ratioBps < OPEN_RATIO_BPS) revert RatioBelowThreshold(ratioBps);

        // Surplus = (goldInVault - totalSupply) ; allowance = 5% of surplus
        uint256 totalSupply  = trcGold.totalSupply();
        uint256 goldInVault  = reserve.getGoldInVault();
        uint256 surplus      = goldInVault > totalSupply ? goldInVault - totalSupply : 0;
        windowAllowance      = (surplus * MAX_SURPLUS_SHARE) / 10_000;
        windowConverted      = 0;

        // Conversion rate: 1 TRC-G = current_market_rate TRC-U (oracle provides)
        // Simplified: use the ratio as a proxy. In production the oracle provides a market rate.
        conversionRate = (currentRatio * 1e18) / 1e18; // placeholder — oracle should set this

        isWindowOpen    = true;
        windowOpenedAt  = block.timestamp;

        emit WindowOpened(block.timestamp, windowAllowance, conversionRate);
    }

    /**
     * @notice Closes the window manually (e.g., when ratio drops below 105%).
     */
    function closeWindow() external {
        // Anyone may close if conditions are no longer met; only oracle can force close.
        if (!isWindowOpen) revert WindowNotOpen();
        bool shouldClose = !windowOpen();
        if (!shouldClose && !hasRole(ORACLE_ROLE, msg.sender)) revert WindowStillValid();

        _closeWindow();
    }

    /**
     * @notice Converts TRC-U to TRC-G at the fixed window rate.
     * @dev Burns TRC-U from caller; mints TRC-G via Reserve surplus.
     *      Caller must approve this contract on TRCUtility before calling.
     * @param uAmount  Amount of TRC-U to convert
     */
    function convert(uint256 uAmount) external nonReentrant {
        if (!windowOpen()) revert WindowNotOpen();
        if (uAmount == 0) revert ZeroAmount();

        // gAmount = uAmount / conversionRate  (both in 1e18)
        uint256 gAmount = (uAmount * 1e18) / conversionRate;
        if (gAmount == 0) revert ZeroAmount();

        uint256 remaining = windowAllowance - windowConverted;
        if (gAmount > remaining) revert ExceedsWindowAllowance(gAmount, remaining);

        windowConverted += gAmount;

        // Burn TRC-U from caller
        trcUtility.burn(msg.sender, uAmount);

        // Mint TRC-G — Reserve contract must grant this contract RESERVE_ROLE on TRCGold
        // In practice Reserve.mintFromSurplus is called here
        trcGold.mintFromSurplus(msg.sender, gAmount);

        emit ConversionExecuted(msg.sender, uAmount, gAmount);

        // Auto-close if allowance exhausted or ratio has dropped
        if (windowConverted >= windowAllowance || !windowOpen()) {
            _closeWindow();
        }
    }

    /**
     * @notice Allows the oracle to update the conversion rate mid-window if market moves significantly.
     */
    function updateConversionRate(uint256 newRate) external onlyRole(ORACLE_ROLE) {
        conversionRate = newRate;
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    function _closeWindow() internal {
        isWindowOpen         = false;
        lastWindowClosedAt   = block.timestamp;
        emit WindowClosed(block.timestamp, windowConverted);
    }

    error WindowStillValid();
}

interface ITRCGold {
    function totalSupply() external view returns (uint256);
    function mintFromSurplus(address to, uint256 amount) external;
}

interface ITRCUtility {
    function burn(address from, uint256 amount) external;
}

interface IReserve {
    function reserveRatio() external view returns (uint256);
    function getGoldInVault() external view returns (uint256);
}
