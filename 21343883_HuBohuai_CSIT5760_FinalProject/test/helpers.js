// Minimal in-process EVM test harness built on @ethereumjs/vm (pure JS, no
// child processes) so the test suite runs inside this sandboxed environment.
const { createVM, runTx } = require("@ethereumjs/vm");
const { createLegacyTx } = require("@ethereumjs/tx");
const { createBlock } = require("@ethereumjs/block");
const {
  Address,
  createAccount,
  createAddressFromPrivateKey,
  hexToBytes,
  bytesToHex,
} = require("@ethereumjs/util");
const { Interface } = require("ethers");

const GAS_LIMIT = 30_000_000n;
const GAS_PRICE = 1_000_000_000n; // 1 gwei
const INITIAL_BALANCE = 1_000_000n * 10n ** 18n; // 1,000,000 ETH

// Deterministic private keys (32 bytes each) for the test accounts.
const PRIV = {
  admin: hexToBytes("0x" + "11".repeat(32)),
  organiser: hexToBytes("0x" + "22".repeat(32)),
  organiser2: hexToBytes("0x" + "33".repeat(32)),
  gateChecker: hexToBytes("0x" + "44".repeat(32)),
  buyer1: hexToBytes("0x" + "55".repeat(32)),
  buyer2: hexToBytes("0x" + "66".repeat(32)),
  buyer3: hexToBytes("0x" + "77".repeat(32)),
  unauthorized: hexToBytes("0x" + "88".repeat(32)),
  outsider: hexToBytes("0x" + "99".repeat(32)),
};

async function setup() {
  const vm = await createVM();
  const accounts = {};
  for (const [name, key] of Object.entries(PRIV)) {
    const address = createAddressFromPrivateKey(key);
    await vm.stateManager.putAccount(
      address,
      createAccount({ balance: INITIAL_BALANCE, nonce: 0n })
    );
    accounts[name] = { key, address, addressHex: address.toString() };
  }
  return { vm, accounts, time: 1_700_000_000n }; // base timestamp (seconds)
}

// Build a signed legacy transaction and run it against the VM.
async function sendTx(vm, ctx, { from, to, value, data, gasLimit = GAS_LIMIT }) {
  const txData = {
    nonce: 0n,
    gasPrice: GAS_PRICE,
    gasLimit,
    value: value ?? 0n,
    data: data ?? "0x",
  };
  if (to !== undefined && to !== null) {
    txData.to = to; // hex string '0x...'
  }
  const tx = createLegacyTx(txData).sign(from);
  const block = createBlock({ header: { timestamp: ctx.time, gasLimit } });
  return await runTx(vm, {
    tx,
    block,
    skipNonce: true,
    skipBlockGasLimitValidation: true,
  });
}

// Deploy a contract. Returns { address, result }.
async function deploy(vm, ctx, privKey, abi, bytecode, args = []) {
  const iface = new Interface(abi);
  let data = bytecode;
  if (args.length > 0) {
    data += iface.encodeDeploy(args).slice(2);
  }
  const result = await sendTx(vm, ctx, { from: privKey, data });
  if (result.execResult.exceptionError) {
    throw new Error(
      "Deploy failed: " +
        result.execResult.exceptionError.error +
        " data=" +
        bytesToHex(result.execResult.returnValue)
    );
  }
  const address = result.createdAddress.toString();
  return { address, result };
}

// Call a state-changing function. Returns the raw RunTxResult.
async function call(vm, ctx, privKey, address, abi, method, args = [], opts = {}) {
  const iface = new Interface(abi);
  const data = iface.encodeFunctionData(method, args);
  return await sendTx(vm, ctx, {
    from: privKey,
    to: address,
    value: opts.value,
    data,
  });
}

// Call a view/pure function and return the decoded result.
async function view(vm, ctx, privKey, address, abi, method, args = []) {
  const iface = new Interface(abi);
  const result = await call(vm, ctx, privKey, address, abi, method, args);
  if (result.execResult.exceptionError) {
    throw new Error("View call failed: " + result.execResult.exceptionError.error);
  }
  const decoded = iface.decodeFunctionResult(method, result.execResult.returnValue);
  return decoded.length === 1 ? decoded[0] : decoded;
}

function ethersLogs(result) {
  return (result.receipt.logs ?? []).map(([addr, topics, data]) => ({
    address: bytesToHex(addr),
    topics: topics.map((t) => bytesToHex(t)),
    data: bytesToHex(data),
  }));
}

// Returns the 4-byte selector of the revert payload, or null.
function revertSelector(result) {
  const rv = result.execResult?.returnValue;
  if (!rv || rv.length < 4) return null;
  return bytesToHex(rv.slice(0, 4));
}

function isRevert(result) {
  return (
    result.receipt?.status === 0 &&
    result.execResult?.exceptionError?.error === "revert"
  );
}

async function balanceOf(vm, addressHex) {
  const account = await vm.stateManager.getAccount(new Address(hexToBytes(addressHex)));
  return account ? account.balance : 0n;
}

module.exports = {
  PRIV,
  setup,
  deploy,
  call,
  view,
  sendTx,
  ethersLogs,
  revertSelector,
  isRevert,
  balanceOf,
  GAS_LIMIT,
  INITIAL_BALANCE,
  hexToBytes,
  bytesToHex,
};
