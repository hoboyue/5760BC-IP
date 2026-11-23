# Etherscan Source Verification — Step by Step

The contract is already deployed to Sepolia. Verification must be done on the
Etherscan website (it cannot be scripted from the sandboxed environment).

## Contract details

| Item | Value |
| --- | --- |
| Network | Sepolia (Chain ID 11155111) |
| Contract address | `0x47e0546d504fe68757753aBE05Db0CF41Fe476AB` |
| Contract name | AntiScalpingTicketing |
| Compiler | Solidity `v0.8.9+commit.e5eed63a` |
| Optimization | Enabled, 200 runs |
| EVM version | `london` |
| License | MIT (SPDX in source) |

## Method — Standard JSON Input (bytecode-exact)

1. Open https://sepolia.etherscan.io/address/0x47e0546d504fe68757753aBE05Db0CF41Fe476AB
2. Click the **Contract** tab → **Verify and Publish**.
3. Fill in:
   - **Contract address**: `0x47e0546d504fe68757753aBE05Db0CF41Fe476AB`
   - **Compiler Type**: `Solidity (Standard-Json-Input)`
   - **Compiler Version**: `v0.8.9+commit.e5eed63a`
   - **License Type**: `MIT License (MIT)`
4. In the "Enter the Solidity Standard-Json-Input" box, paste the ENTIRE
   contents of `deployment/standard-input.json`.
5. In **Constructor Arguments ABI-encoded**, paste:
   ```
   0x000000000000000000000000b0b16c5ffccb31f3f68a45c17cab8c226a5d5222
   ```
   (This is `defaultAdmin = 0xB0B16c5ffCcB31f3f68a45c17Cab8C226A5D5222`.)
6. Click **Verify and Publish**.

If it succeeds, the Contract tab will show the source and a green "Contract Source Code
Verified" badge.

## After verification

- Record the direct URL:
  `https://sepolia.etherscan.io/address/0x47e0546d504fe68757753aBE05Db0CF41Fe476AB#code`
- Take a screenshot and save it as `screenshots/verification.png`.
