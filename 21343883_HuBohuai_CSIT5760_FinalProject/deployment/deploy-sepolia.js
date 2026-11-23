// Deploy AntiScalpingTicketing to Sepolia and record full deployment info.
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const artifact = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "build", "AntiScalpingTicketing.json"), "utf8")
);

const RPC_URL = process.env.RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

async function main() {
  if (!PRIVATE_KEY) throw new Error("Missing PRIVATE_KEY environment variable");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const net = await provider.getNetwork();
  console.log("Network chainId:", net.chainId.toString());
  console.log("Deployer address:", wallet.address);
  console.log("Balance:", ethers.formatEther(await provider.getBalance(wallet.address)), "ETH");

  // Deploy with deployer as DEFAULT_ADMIN_ROLE
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(wallet.address);
  const deployTx = contract.deploymentTransaction();
  console.log("Deployment tx hash:", deployTx.hash);

  const receipt = await deployTx.wait();
  const address = await contract.getAddress();

  console.log("\n===== DEPLOYMENT RESULT =====");
  console.log("Contract address :", address);
  console.log("Block number     :", receipt.blockNumber);
  console.log("Gas used         :", receipt.gasUsed.toString());
  console.log("Status           :", receipt.status === 1 ? "success" : "FAILED");
  console.log("Etherscan URL    :", `https://sepolia.etherscan.io/address/${address}`);

  const now = new Date().toISOString();
  const info = `Deployment Information — AntiScalpingTicketing
================================================

Network name      : Sepolia
Chain ID          : 11155111
Contract name     : AntiScalpingTicketing
Contract address  : ${address}
Deployer address  : ${wallet.address}
Deployment tx hash: ${deployTx.hash}
Block number      : ${receipt.blockNumber}
Gas used          : ${receipt.gasUsed}
Compiler version  : 0.8.9+commit.e5eed63a.Emscripten.clang
Optimization      : enabled
Optimization runs : 200
EVM version       : london
Deployment tool   : ethers.js 6.13.4 (scripts/deploy-sepolia.js)
Deployment date   : ${now}
Etherscan URL     : https://sepolia.etherscan.io/address/${address}
Verification URL  : https://sepolia.etherscan.io/address/${address}#code

Constructor arguments:
  defaultAdmin = ${wallet.address}
`;

  const outPath = path.join(__dirname, "..", "deployment", "deployment-information.txt");
  fs.writeFileSync(outPath, info, "utf8");
  console.log("\nSaved deployment info to:", outPath);
}

main().catch((e) => {
  console.error("Deployment failed:", e);
  process.exit(1);
});
