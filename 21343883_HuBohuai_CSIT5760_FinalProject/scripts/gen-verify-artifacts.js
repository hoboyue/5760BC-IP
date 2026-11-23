// Generate the exact solc standard-JSON input used to compile the deployed
// contract, then recompile and confirm the bytecode matches build/ (which is
// what was deployed to Sepolia).
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const ROOT = path.join(__dirname, "..");
const ENTRY = path.join(ROOT, "contracts", "AntiScalpingTicketing.sol");
const OUT_DIR = path.join(ROOT, "deployment");

function resolveImport(importPath, fromFile) {
  const base = fromFile ? path.dirname(fromFile) : path.join(ROOT, "contracts");
  const candidates = [
    path.join(ROOT, "node_modules", importPath),
    path.join(base, importPath),
    path.join(ROOT, importPath),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("Cannot resolve import: " + importPath + " from " + fromFile);
}

const sources = {};
function collect(file) {
  const abs = path.resolve(file);
  if (sources[abs]) return;
  const content = fs.readFileSync(abs, "utf8");
  sources[abs] = content;
  const re = /import\s+(?:[^;]*?from\s*)?["']([^"']+)["']\s*;/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    collect(resolveImport(m[1], abs));
  }
}
collect(ENTRY);

// Source keys must exactly match what scripts/compile.js uses:
//   - contract files: basename (e.g. "AntiScalpingTicketing.sol")
//   - node_modules: "@openzeppelin/contracts/..." (path relative to node_modules)
const stdSources = {};
for (const abs of Object.keys(sources)) {
  let key;
  if (abs.includes("node_modules")) {
    key = path.relative(path.join(ROOT, "node_modules"), abs).split(path.sep).join("/");
  } else {
    key = path.basename(abs);
  }
  stdSources[key] = { content: sources[abs] };
}

// Settings MUST match scripts/compile.js exactly (no metadata override: solc
// 0.8.9 defaults metadata.bytecodeHash to "ipfs", which is what was deployed).
const input = {
  language: "Solidity",
  sources: stdSources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "london",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};

// Recompile with the standard input and compare against build/.
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) {
  for (const e of errors) console.log(e.formattedMessage);
  console.error("COMPILE FAILED");
  process.exit(1);
}

const c = out.contracts["AntiScalpingTicketing.sol"].AntiScalpingTicketing;
const bc = "0x" + c.evm.bytecode.object;
const dbc = "0x" + c.evm.deployedBytecode.object;

const build = JSON.parse(fs.readFileSync(path.join(ROOT, "build", "AntiScalpingTicketing.json"), "utf8"));
console.log("sources collected :", Object.keys(stdSources).length);
console.log("creation bytecode match :", bc === build.bytecode ? "YES" : "NO");
console.log("deployed  bytecode match :", dbc === build.deployedBytecode ? "YES" : "NO");

fs.writeFileSync(path.join(OUT_DIR, "standard-input.json"), JSON.stringify(input, null, 2));
console.log("Wrote deployment/standard-input.json");

// Also emit the constructor ABI hint (defaultAdmin) for the verifier.
console.log("\nConstructor argument (ABI-encoded, single address arg):");
const { Interface } = require("ethers");
const iface = new Interface(build.abi);
const encoded = iface.encodeDeploy(["0xB0B16c5ffCcB31f3f68a45c17Cab8C226A5D5222"]);
console.log("  defaultAdmin = 0xB0B16c5ffCcB31f3f68a45c17Cab8C226A5D5222");
console.log("  ABI-encoded  =", encoded);
