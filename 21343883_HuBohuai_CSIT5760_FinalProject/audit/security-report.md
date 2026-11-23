# Smart Contract Security Report — AntiScalpingTicketing

**Project:** Blockchain-Based Event Ticketing with Enforced Anti-Scalping Controls
**Contract:** `AntiScalpingTicketing.sol` (Solidity 0.8.9)
**Deployed address (Sepolia):** `0x47e0546d504fe68757753aBE05Db0CF41Fe476AB`
**Student:** Hu Bohuai (21343883)

## 1. Scope and Methodology

The review covered the full `AntiScalpingTicketing` contract, including its OpenZeppelin
base contracts (ERC721, AccessControl, Pausable, ReentrancyGuard v4.9.6). The analysis was
performed as a **manual code review** combined with **targeted exploit tests** on an
in-process EVM (`@ethereumjs/vm`). The review addressed:

- Access control and authorisation
- Reentrancy
- Input validation
- Repeated / duplicate execution
- Ether handling
- State-transition validation
- Denial of service
- Timestamp limitations
- On-chain privacy

> Note: Slither/Mythril could not be installed in the sandboxed development environment, so
> the review is manual and test-driven. The findings below were interpreted and remediated
> rather than relying on unexamined tool output.

## 2. Findings Summary

| ID | Severity | Finding | Affected code | Remediation | Status |
| --- | --- | --- | --- | --- | --- |
| F1 | Medium | Reentrancy during refund/resale Ether settlement | `requestRefund`, `buyResaleTicket` | Checks-effects-interactions + `ReentrancyGuard` on every payable function | Mitigated — retested with `ReentrantAttacker` |
| F2 | Medium | Unauthorised access to privileged functions | `createEvent`, `validateTicket`, `withdraw`, `pause` | `AccessControl` modifiers (`onlyRole`, `onlyOrganiser`) + per-event organiser check | Mitigated — negative tests pass |
| F3 | High | Resale price-cap bypass via direct NFT transfer | `transferFrom` / `safeTransferFrom` | Overridden to revert `TicketNonTransferable()`; resale only through the contract | Mitigated — test asserts revert |
| F4 | Low | Timestamp dependence for deadlines | `createEvent` deadlines | Coarse 1-second deadlines set at creation; documented | Accepted limitation |

No unmitigated critical or high-severity finding remains.

## 3. Manual Security Review Notes

- **Access control** — `onlyRole`/`onlyOrganiser` gate `createEvent`, `validateTicket`,
  `pause`/`unpause`, and `withdraw`; `withdraw` additionally requires
  `msg.sender == event.organiser`. Negative tests confirm unauthorised calls revert.
- **Checks-effects-interactions** — every payable function updates state before any external
  call; all state-changing functions carry `ReentrancyGuard`.
- **Reentrancy** — the `ReentrantAttacker` test attempts to reenter `requestRefund()` during
  the Ether transfer; the reentrant call is blocked and the attacker receives exactly one refund.
- **Input validation** — `createEvent` validates non-empty name, non-zero price,
  `resaleCap >= price`, non-zero limits, and deadline ordering; purchase/resale validate exact
  payment and price bounds.
- **Repeated execution** — the ticket state machine (Used/Refunded terminal, Listed unique)
  prevents double use, double refund, and double listing.
- **Ether handling** — proceeds are tracked explicitly rather than trusting the raw balance;
  `withdraw` is gated on `refundDeadline` so refunds always settle first.
- **Denial of service** — proceeds withdrawal uses a pull pattern (call to `msg.sender`) with
  failure handled; no unbounded loops over attacker-controlled arrays.
- **Timestamp limitations** — deadlines use 1-second granularity and are set by the organiser
  at creation.
- **On-chain privacy** — only synthetic/non-sensitive data is stored; no personal data or
  credentials are placed on-chain.

## 4. Retesting Evidence

The full test suite (`node test/run-tests.js`) runs 29 cases and reports **29 passed, 0 failed**.
The reentrancy defence is exercised specifically by the `ReentrantAttacker` exploit test
(`security: reentrancy on requestRefund is blocked`), which passes.
