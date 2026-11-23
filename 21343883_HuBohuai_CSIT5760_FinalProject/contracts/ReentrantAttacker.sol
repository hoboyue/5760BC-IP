// SPDX-License-Identifier: MIT
pragma solidity ^0.8.9;

import "../AntiScalpingTicketing.sol";

/**
 * @title ReentrantAttacker
 * @notice Test-only helper contract used by the test suite to attempt a
 *         reentrancy attack against requestRefund(). It is NOT part of the
 *         production system and is never deployed to a test network.
 */
contract ReentrantAttacker {
    AntiScalpingTicketing public target;

    uint256 public ticketId;
    bool public attackEnabled;
    uint256 public reentryAttempts;
    bool public reentryBlocked;

    constructor(AntiScalpingTicketing _target) {
        target = _target;
    }

    /// @dev Required so that _safeMint in purchaseTicket accepts this contract.
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    /// @notice Buys a primary ticket (the attacker becomes the ticket's owner).
    function buyTicket(uint256 eventId) external payable {
        target.purchaseTicket{value: msg.value}(eventId);
    }

    /// @notice Starts a refund and attempts to reenter requestRefund during the
    ///         Ether transfer, via the receive() fallback.
    function startRefundAttack(uint256 _ticketId) external {
        ticketId = _ticketId;
        attackEnabled = true;
        target.requestRefund(_ticketId);
    }

    /// @dev Called when the refund Ether arrives; attempts a reentrant refund.
    receive() external payable {
        if (attackEnabled && reentryAttempts < 3) {
            reentryAttempts += 1;
            try target.requestRefund(ticketId) {
                // Should be unreachable: the reentrant call must be blocked.
            } catch {
                reentryBlocked = true;
            }
        }
    }
}
