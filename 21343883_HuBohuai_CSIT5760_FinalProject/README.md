# Blockchain-Based Event Ticketing with Enforced Anti-Scalping Controls

CSIT5760 — Blockchain and Smart Contracts — Individual Project

**Student:** Hu Bohuai
**Student ID:** 21343883
**Instructor:** RAJKHOWA, Pritom

## 1. Project Title and Summary

`AntiScalpingTicketing` is a Solidity smart contract that issues each event ticket as an
ERC-721 non-fungible token (NFT) and enforces anti-scalping rules on-chain: a maximum
resale price cap, a per-account primary purchase limit, and resale/refund deadlines.
A regulated secondary market lets ticket holders resell only through the contract, so the
price cap cannot be bypassed, and gate checkers can validate tickets at the venue entrance
to prevent reuse.

## 2. Software Prerequisites

- Node.js >= 20
- npm >= 10
- A Sepolia JSON-RPC endpoint (public RPCs work, e.g. `https://ethereum-sepolia-rpc.publicnode.com`)
- MetaMask (or another wallet) with Sepolia test ETH for deployment

## 3. Installation

```bash
npm install
```

## 4. Compilation

```bash
node scripts/compile.js
```

This compiles `contracts/AntiScalpingTicketing.sol` (and the test-only
`contracts/ReentrantAttacker.sol`) with **Solidity 0.8.9** and writes ABI + bytecode to
`build/`.

## 5. Testing

```bash
node test/run-tests.js
```

The suite runs 29 test cases on an in-process EVM (`@ethereumjs/vm`) covering positive,
negative, boundary, state-transition, and reentrancy scenarios. Result: **29 passed, 0 failed**.

## 6. Deployment

```bash
$env:RPC_URL="https://ethereum-sepolia-rpc.publicnode.com"
$env:PRIVATE_KEY="<deployer testnet private key>"
node scripts/deploy-sepolia.js
```

The deployment script writes the full deployment record to
`deployment/deployment-information.txt`.

## 7. Deployed Contract Addresses

| Contract | Network | Address |
| --- | --- | --- |
| AntiScalpingTicketing | Sepolia (Chain ID 11155111) | `0x47e0546d504fe68757753aBE05Db0CF41Fe476AB` |

Deployment transaction: `0xe674b0b199c523e3e130eef385208e7cef4f569de2ea63b75e9c5cb9caef9fa9`
(block 12192551).

## 8. Verified Etherscan URLs

https://sepolia.etherscan.io/address/0x47e0546d504fe68757753aBE05Db0CF41Fe476AB#code

## 9. External Libraries and Exact Versions

| Library / tool | Version |
| --- | --- |
| Solidity (solc) | 0.8.9 |
| OpenZeppelin Contracts | 4.9.6 |
| ethers.js | 6.13.4 |
| @ethereumjs/vm (test EVM) | 10.1.3 |
| @ethereumjs/tx / util / common | 10.1.3 |
| ethereum-cryptography | 3.2.0 |

## 10. Roles and Account Assumptions

- **Platform Admin** (`DEFAULT_ADMIN_ROLE`) — the deployer; grants/revokes roles and can
  pause/unpause the contract in an emergency.
- **Event Organiser** (`ORGANISER_ROLE`) — creates events and withdraws proceeds for the
  events they own.
- **Gate Checker** (`GATE_CHECKER_ROLE`) — validates ticket authenticity/ownership at entry.
- **Ticket Holder / Buyer** — any account; buys primary tickets and trades on the secondary
  market.

Each wallet address is treated as one buyer for the purchase limit (Sybil resistance is
limited to one-address-one-ticket).

## 11. Interacting with the Contract

Primary flows:

1. **Admin** grants `ORGANISER_ROLE` and `GATE_CHECKER_ROLE` to the relevant accounts
   (`grantRole`).
2. **Organiser** calls `createEvent(name, date, price, resaleCap, maxPerAccount,
   maxSupply, saleStartTime, saleDeadline, refundDeadline)`.
3. **Buyer** calls `purchaseTicket(eventId)` sending exactly `price` wei.
4. **Holder** calls `resellTicket(ticketId, price)` (price ≤ `resaleCap`), then a buyer
   calls `buyResaleTicket(listingId)` sending the listing price.
5. **Gate Checker** calls `validateTicket(ticketId)` at entry.
6. **Original buyer** calls `requestRefund(ticketId)` before `refundDeadline`.
7. **Organiser** calls `withdraw(eventId)` after `refundDeadline`.

## 12. Known Limitations

- No real identity/KYC: the purchase limit uses wallet addresses.
- No external price oracle: the resale cap is fixed on-chain per event.
- No fiat on/off ramps or external payment-gateway integration.
- No multi-venue or cross-platform ticket interoperability.
- Automated dispute resolution is limited to the refund rules.
- Tickets are non-transferable by users (`transferFrom`/`safeTransferFrom` are overridden
  to revert), which enforces on-platform-only resale.

## 13. Academic Integrity

Third-party code (OpenZeppelin Contracts) is acknowledged; all application logic and the
test suite were written for this project. No wallet seed phrases, private keys, or API
secrets are included anywhere in this repository.
