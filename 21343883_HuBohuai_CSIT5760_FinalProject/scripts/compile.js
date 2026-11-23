// Compiles contracts/ with the solc npm package (in-process WASM build) and
// writes ABI + bytecode for each contract to build/.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.join(__dirname, "..");
const CONTRACTS_DIR = path.join(ROOT, "contracts");
const BUILD_DIR = path.join(ROOT, "build");

const FILES = [
  "AntiScalpingTicketing.sol",
  "ReentrantAttacker.sol",
];

if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

const sources = {};
for (const f of FILES) {
  sources[f] = { content: fs.readFileSync(path.join(CONTRACTS_DIR, f), "utf8") };
}

function findImports(importPath) {
  const candidates = [
    path.join(ROOT, "node_modules", importPath),
    path.join(ROOT, importPath),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return { contents: fs.readFileSync(c, "utf8") };
    }
  }
  return { error: "File not found: " + importPath };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "london",
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"],
      },
    },
  },
};

const output = JSON.parse(
  solc.compile(JSON.stringify(input), { import: findImports })
);

if (output.errors) {
  for (const e of output.errors) {
    console.log(`${e.severity}: ${e.formattedMessage}`);
  }
  const severe = output.errors.filter((e) => e.severity === "error");
  if (severe.length > 0) {
    console.error("Compilation failed with errors.");
    process.exit(1);
  }
}

const artifacts = {};
for (const [sourceName, contracts] of Object.entries(output.contracts)) {
  for (const [contractName, c] of Object.entries(contracts)) {
    const artifact = {
      contractName,
      sourceName,
      abi: c.abi,
      bytecode: "0x" + c.evm.bytecode.object,
      deployedBytecode: "0x" + c.evm.deployedBytecode.object,
    };
    artifacts[contractName] = artifact;
    fs.writeFileSync(
      path.join(BUILD_DIR, contractName + ".json"),
      JSON.stringify(artifact, null, 2)
    );
    console.log(
      `${contractName}: ${(artifact.deployedBytecode.length - 2) / 2} bytes deployed, ` +
        `${artifact.abi.length} ABI entries`
    );
  }
}

console.log("Compilation successful.");
