// CSIT5760 Individual Project — comprehensive test suite for
// AntiScalpingTicketing, run on an in-process EVM (@ethereumjs/vm).
const fs = require("fs");
const path = require("path");
const { Interface, id, keccak256, toUtf8Bytes } = require("ethers");
const h = require("./helpers");

const BUILD = path.join(__dirname, "..", "build");
const MAIN = JSON.parse(fs.readFileSync(path.join(BUILD, "AntiScalpingTicketing.json"), "utf8"));
const ATTACKER = JSON.parse(fs.readFileSync(path.join(BUILD, "ReentrantAttacker.json"), "utf8"));

const ABI = MAIN.abi;
const iface = new Interface(ABI);

const ORGANISER_ROLE = keccak256(toUtf8Bytes("ORGANISER_ROLE"));
const GATE_CHECKER_ROLE = keccak256(toUtf8Bytes("GATE_CHECKER_ROLE"));
const ADMIN_ROLE = "0x" + "00".repeat(32);

const E = 10n ** 18n;
const PRICE = 1n * E;
const RESALE_CAP = 2n * E;
const MAX_PER_ACCOUNT = 2n;
const MAX_SUPPLY = 3n;

// Custom error selectors
const SEL = (sig) => id(sig).slice(0, 10);
const ERR = {
  NotOrganiser: SEL("NotOrganiser()"),
  NotHolder: SEL("NotHolder()"),
  NotOriginalOwner: SEL("NotOriginalOwner()"),
  TicketNonTransferable: SEL("TicketNonTransferable()"),
  IncorrectPayment: SEL("IncorrectPayment()"),
  TicketSoldOut: SEL("TicketSoldOut()"),
  ExceedsPurchaseLimit: SEL("ExceedsPurchaseLimit()"),
  PriceAboveCap: SEL("PriceAboveCap()"),
  InvalidPrice: SEL("InvalidPrice()"),
  SaleNotOpen: SEL("SaleNotOpen()"),
  SaleEnded: SEL("SaleEnded()"),
  ResaleClosed: SEL("ResaleClosed()"),
  RefundClosed: SEL("RefundClosed()"),
  AlreadyListed: SEL("AlreadyListed()"),
  NotListed: SEL("NotListed()"),
  CannotBuyOwnTicket: SEL("CannotBuyOwnTicket()"),
  WithdrawalNotAvailable: SEL("WithdrawalNotAvailable()"),
  InvalidDeadlines: SEL("InvalidDeadlines()"),
  InvalidState: SEL("InvalidState()"),
  ErrorString: "0x08c379a0", // OpenZeppelin Error(string)
};

/* ------------------------- tiny test runner ------------------------- */
const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}
let passCount = 0;
let failCount = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function eq(actual, expected, msg) {
  const a = typeof actual === "bigint" ? actual : actual;
  const b = typeof expected === "bigint" ? expected : expected;
  if (a !== b) throw new Error(`${msg || "eq"}: expected ${expected}, got ${actual}`);
}
function assertRevert(result, expectedSelector, msg) {
  if (!h.isRevert(result)) {
    throw new Error(`${msg || "revert"}: expected revert but tx succeeded (status=${result.receipt?.status})`);
  }
  if (expectedSelector !== undefined) {
    const got = h.revertSelector(result);
    if (got !== expectedSelector) {
      throw new Error(`${msg || "revert selector"}: expected ${expectedSelector}, got ${got}`);
    }
  }
}
function eventsOf(result) {
  return h.ethersLogs(result)
    .map((l) => iface.parseLog(l))
    .filter((e) => e !== null);
}
function hasEvent(result, name) {
  return eventsOf(result).some((e) => e.name === name);
}

/* ------------------------- fixtures ------------------------- */
async function setupFresh() {
  const { vm, accounts, time } = await h.setup();
  const ctx = { time };
  const { address } = await h.deploy(
    vm, ctx, accounts.admin.key, ABI, MAIN.bytecode, [accounts.admin.addressHex]
  );
  await h.call(vm, ctx, accounts.admin.key, address, ABI, "grantRole", [ORGANISER_ROLE, accounts.organiser.addressHex]);
  await h.call(vm, ctx, accounts.admin.key, address, ABI, "grantRole", [GATE_CHECKER_ROLE, accounts.gateChecker.addressHex]);
  return { vm, accounts, ctx, address };
}

async function createEvent(env, overrides = {}) {
  const t = env.ctx.time;
  const r = await h.call(env.vm, env.ctx, env.accounts.organiser.key, env.address, ABI, "createEvent", [
    overrides.name ?? "Test Event",
    overrides.date ?? t + 86400n,
    overrides.price ?? PRICE,
    overrides.resaleCap ?? RESALE_CAP,
    overrides.maxPerAccount ?? MAX_PER_ACCOUNT,
    overrides.maxSupply ?? MAX_SUPPLY,
    overrides.saleStartTime ?? t,
    overrides.saleDeadline ?? t + 3600n,
    overrides.refundDeadline ?? t + 7200n,
  ]);
  return r;
}

async function buy(env, buyer, eventId, value = PRICE) {
  return h.call(env.vm, env.ctx, env.accounts[buyer].key, env.address, ABI, "purchaseTicket", [eventId], { value });
}

async function readEvent(env, eventId) {
  return h.view(env.vm, env.ctx, env.accounts.admin.key, env.address, ABI, "getEvent", [eventId]);
}
async function readTicket(env, ticketId) {
  return h.view(env.vm, env.ctx, env.accounts.admin.key, env.address, ABI, "getTicket", [ticketId]);
}

/* ===================================================================== */
/* 1. Deployment and role setup                                         */
/* ===================================================================== */
test("deployment sets correct name/symbol and admin role", async () => {
  const { vm, accounts, ctx, address } = await setupFresh();
  const name = await h.view(vm, ctx, accounts.admin.key, address, ABI, "name", []);
  const symbol = await h.view(vm, ctx, accounts.admin.key, address, ABI, "symbol", []);
  eq(name, "AntiScalpingTicket", "name");
  eq(symbol, "AST", "symbol");
  const isAdmin = await h.view(vm, ctx, accounts.admin.key, address, ABI, "hasRole", [ADMIN_ROLE, accounts.admin.addressHex]);
  eq(isAdmin, true, "admin has DEFAULT_ADMIN_ROLE");
});

/* ===================================================================== */
/* 2. Positive tests                                                    */
/* ===================================================================== */
test("positive: organiser creates event and buyer purchases a ticket", async () => {
  const env = await setupFresh();
  const { accounts } = env;

  let r = await createEvent(env);
  if (r.execResult.exceptionError) throw new Error("createEvent failed: " + h.bytesToHex(r.execResult.returnValue));
  assert(hasEvent(r, "EventCreated"), "EventCreated emitted");

  const ev = await readEvent(env, 1n);
  eq(ev.name, "Test Event", "event name");
  eq(ev.status, 1n, "status OnSale");
  eq(ev.price, PRICE, "price");

  r = await buy(env, "buyer1", 1n);
  if (r.execResult.exceptionError) throw new Error("purchaseTicket failed: " + h.bytesToHex(r.execResult.returnValue));
  assert(hasEvent(r, "TicketPurchased"), "TicketPurchased emitted");

  const owner = await h.view(env.vm, env.ctx, accounts.admin.key, env.address, ABI, "ownerOf", [1n]);
  eq(owner.toLowerCase(), accounts.buyer1.addressHex.toLowerCase(), "NFT minted to buyer");

  const t = await readTicket(env, 1n);
  eq(t.status, 0n, "ticket Minted");
  eq(t.purchasePrice, PRICE, "ticket purchase price");

  const ev2 = await readEvent(env, 1n);
  eq(ev2.totalMinted, 1n, "totalMinted incremented");
  eq(ev2.totalSold, 1n, "totalSold incremented");
  eq(ev2.proceeds, PRICE, "proceeds incremented");
});

test("positive: full resale flow (list -> buy) transfers NFT and funds", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;

  await createEvent(env);
  await buy(env, "buyer1", 1n);

  // buyer1 lists ticket 1 at exactly the cap
  let r = await h.call(vm, ctx, accounts.buyer1.key, address, ABI, "resellTicket", [1n, RESALE_CAP]);
  assert(hasEvent(r, "TicketResold"), "TicketResold emitted");
  let t = await readTicket(env, 1n);
  eq(t.status, 1n, "ticket Listed");

  // buyer2 buys the listing
  const sellerBefore = await h.balanceOf(vm, accounts.buyer1.addressHex);
  r = await h.call(vm, ctx, accounts.buyer2.key, address, ABI, "buyResaleTicket", [1n], { value: RESALE_CAP });
  assert(hasEvent(r, "ResalePurchased"), "ResalePurchased emitted");

  const owner = await h.view(vm, ctx, accounts.admin.key, address, ABI, "ownerOf", [1n]);
  eq(owner.toLowerCase(), accounts.buyer2.addressHex.toLowerCase(), "NFT transferred to resale buyer");

  const sellerAfter = await h.balanceOf(vm, accounts.buyer1.addressHex);
  eq(sellerAfter - sellerBefore, RESALE_CAP, "seller received resale price");

  t = await readTicket(env, 1n);
  eq(t.status, 0n, "ticket back to Minted under new holder");
});

test("positive: gate checker validates a Minted ticket", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;

  await createEvent(env);
  await buy(env, "buyer1", 1n);

  const r = await h.call(vm, ctx, accounts.gateChecker.key, address, ABI, "validateTicket", [1n]);
  assert(hasEvent(r, "TicketUsed"), "TicketUsed emitted");
  const t = await readTicket(env, 1n);
  eq(t.status, 2n, "ticket Used");
});

test("positive: organiser withdraws proceeds after refund deadline", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;

  await createEvent(env);
  await buy(env, "buyer1", 1n);
  await buy(env, "buyer2", 1n);

  eq(await h.balanceOf(vm, address), PRICE * 2n, "contract holds proceeds before withdraw");

  ctx.time = ctx.time + 7201n; // past refund deadline
  const r = await h.call(vm, ctx, accounts.organiser.key, address, ABI, "withdraw", [1n]);
  assert(hasEvent(r, "Withdrawn"), "Withdrawn emitted");

  const ev = eventsOf(r).find((e) => e.name === "Withdrawn");
  eq(ev.args.amount, PRICE * 2n, "withdraw amount");
  eq(await h.balanceOf(vm, address), 0n, "contract drained");
});

test("positive: pause and unpause are admin-only and block operations", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;

  await createEvent(env);

  let r = await h.call(vm, ctx, accounts.admin.key, address, ABI, "pause", []);
  assert(hasEvent(r, "Paused"), "Paused emitted");

  // purchase while paused reverts with Pausable string
  r = await buy(env, "buyer1", 1n);
  assertRevert(r, ERR.ErrorString, "purchase while paused");

  r = await h.call(vm, ctx, accounts.admin.key, address, ABI, "unpause", []);
  assert(hasEvent(r, "Unpaused"), "Unpaused emitted");

  r = await buy(env, "buyer1", 1n);
  eq(r.receipt.status, 1, "purchase succeeds after unpause");
});

/* ===================================================================== */
/* 3. Negative tests                                                    */
/* ===================================================================== */
test("negative: non-organiser cannot createEvent", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;
  const t = ctx.time;
  const r = await h.call(vm, ctx, accounts.unauthorized.key, address, ABI, "createEvent", [
    "X", t + 86400n, PRICE, RESALE_CAP, MAX_PER_ACCOUNT, MAX_SUPPLY, t, t + 3600n, t + 7200n,
  ]);
  assertRevert(r, ERR.NotOrganiser, "non-organiser createEvent");
});

test("negative: createEvent rejects invalid deadlines", async () => {
  const env = await setupFresh();
  const t = env.ctx.time;
  const r = await createEvent(env, { saleDeadline: t + 7200n, refundDeadline: t + 3600n }); // saleDeadline > refundDeadline
  assertRevert(r, ERR.InvalidDeadlines, "invalid deadlines");
});

test("negative: createEvent rejects resale cap below face value", async () => {
  const env = await setupFresh();
  const r = await createEvent(env, { resaleCap: PRICE - 1n });
  assertRevert(r, ERR.PriceAboveCap, "resaleCap < price");
});

test("negative: purchase with incorrect payment reverts", async () => {
  const env = await setupFresh();
  await createEvent(env);
  let r = await buy(env, "buyer1", 1n, PRICE - 1n);
  assertRevert(r, ERR.IncorrectPayment, "underpay");
  r = await buy(env, "buyer1", 1n, PRICE + 1n);
  assertRevert(r, ERR.IncorrectPayment, "overpay");
});

test("negative: purchase before sale opens and after sale ends", async () => {
  const env = await setupFresh();
  const t = env.ctx.time;
  // future sale start
  await createEvent(env, { saleStartTime: t + 1000n });
  let r = await buy(env, "buyer1", 1n);
  assertRevert(r, ERR.SaleNotOpen, "sale not open");

  // past sale deadline
  const env2 = await setupFresh();
  await createEvent(env2);
  env2.ctx.time = env2.ctx.time + 3601n;
  r = await buy(env2, "buyer1", 1n);
  assertRevert(r, ERR.SaleEnded, "sale ended");
});

test("negative: resale above cap reverts; at cap succeeds", async () => {
  const env = await setupFresh();
  await createEvent(env);
  await buy(env, "buyer1", 1n);
  let r = await h.call(env.vm, env.ctx, env.accounts.buyer1.key, env.address, ABI, "resellTicket", [1n, RESALE_CAP + 1n]);
  assertRevert(r, ERR.PriceAboveCap, "above cap");
  r = await h.call(env.vm, env.ctx, env.accounts.buyer1.key, env.address, ABI, "resellTicket", [1n, RESALE_CAP]);
  eq(r.receipt.status, 1, "at cap succeeds");
});

test("negative: non-holder cannot resell or cancel", async () => {
  const env = await setupFresh();
  await createEvent(env);
  await buy(env, "buyer1", 1n);
  let r = await h.call(env.vm, env.ctx, env.accounts.buyer2.key, env.address, ABI, "resellTicket", [1n, PRICE]);
  assertRevert(r, ERR.NotHolder, "non-holder resell");
  await h.call(env.vm, env.ctx, env.accounts.buyer1.key, env.address, ABI, "resellTicket", [1n, PRICE]);
  r = await h.call(env.vm, env.ctx, env.accounts.buyer2.key, env.address, ABI, "cancelResale", [1n]);
  assertRevert(r, ERR.NotHolder, "non-holder cancel");
});

test("negative: buying own listing and wrong amount revert", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;
  await createEvent(env);
  await buy(env, "buyer1", 1n);
  await h.call(vm, ctx, accounts.buyer1.key, address, ABI, "resellTicket", [1n, PRICE]);

  let r = await h.call(vm, ctx, accounts.buyer1.key, address, ABI, "buyResaleTicket", [1n], { value: PRICE });
  assertRevert(r, ERR.CannotBuyOwnTicket, "buy own listing");

  r = await h.call(vm, ctx, accounts.buyer2.key, address, ABI, "buyResaleTicket", [1n], { value: PRICE - 1n });
  assertRevert(r, ERR.IncorrectPayment, "wrong amount");
});

test("negative: refund by non-owner and non-original-owner revert", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;
  await createEvent(env);
  await buy(env, "buyer1", 1n);

  let r = await h.call(vm, ctx, accounts.buyer2.key, address, ABI, "requestRefund", [1n]);
  assertRevert(r, ERR.NotHolder, "non-owner refund");

  // resell to buyer2, then buyer2 (not original owner) tries refund
  await h.call(vm, ctx, accounts.buyer1.key, address, ABI, "resellTicket", [1n, PRICE]);
  await h.call(vm, ctx, accounts.buyer2.key, address, ABI, "buyResaleTicket", [1n], { value: PRICE });
  r = await h.call(vm, ctx, accounts.buyer2.key, address, ABI, "requestRefund", [1n]);
  assertRevert(r, ERR.NotOriginalOwner, "resold ticket refund by new holder");
});

test("negative: gate validation by non-gate-checker reverts", async () => {
  const env = await setupFresh();
  await createEvent(env);
  await buy(env, "buyer1", 1n);
  const r = await h.call(env.vm, env.ctx, env.accounts.buyer2.key, env.address, ABI, "validateTicket", [1n]);
  assertRevert(r, ERR.ErrorString, "non-gate-checker validate"); // AccessControl revert string
});

test("negative: withdraw before refund deadline and by other organiser revert", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;
  await createEvent(env);
  await buy(env, "buyer1", 1n);

  let r = await h.call(vm, ctx, accounts.organiser.key, address, ABI, "withdraw", [1n]);
  assertRevert(r, ERR.WithdrawalNotAvailable, "withdraw before deadline");

  // another account granted organiser role but not the event's organiser
  await h.call(vm, ctx, accounts.admin.key, address, ABI, "grantRole", [ORGANISER_ROLE, accounts.organiser2.addressHex]);
  ctx.time = ctx.time + 7201n;
  r = await h.call(vm, ctx, accounts.organiser2.key, address, ABI, "withdraw", [1n]);
  assertRevert(r, ERR.NotOrganiser, "wrong organiser withdraw");
});

test("negative: direct transferFrom is blocked (anti-scalping)", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;
  await createEvent(env);
  await buy(env, "buyer1", 1n);

  // buyer1 approves buyer2 then tries direct transfer
  await h.call(vm, ctx, accounts.buyer1.key, address, ABI, "approve", [accounts.buyer2.addressHex, 1n]);
  const r = await h.call(vm, ctx, accounts.buyer2.key, address, ABI, "transferFrom", [
    accounts.buyer1.addressHex, accounts.buyer2.addressHex, 1n,
  ]);
  assertRevert(r, ERR.TicketNonTransferable, "direct transfer blocked");
});

/* ===================================================================== */
/* 4. Boundary tests                                                    */
/* ===================================================================== */
test("boundary: per-account limit exact vs one over", async () => {
  const env = await setupFresh();
  await createEvent(env); // maxPerAccount = 2
  let r = await buy(env, "buyer1", 1n);
  eq(r.receipt.status, 1, "1st purchase ok");
  r = await buy(env, "buyer1", 1n);
  eq(r.receipt.status, 1, "2nd purchase ok (at limit)");
  r = await buy(env, "buyer1", 1n);
  assertRevert(r, ERR.ExceedsPurchaseLimit, "3rd purchase reverts");
});

test("boundary: max supply exact vs one over", async () => {
  const env = await setupFresh();
  await createEvent(env); // maxSupply = 3
  eq((await buy(env, "buyer1", 1n)).receipt.status, 1, "ticket 1");
  eq((await buy(env, "buyer2", 1n)).receipt.status, 1, "ticket 2");
  eq((await buy(env, "buyer3", 1n)).receipt.status, 1, "ticket 3 (sold out)");
  const r = await buy(env, "outsider", 1n);
  assertRevert(r, ERR.TicketSoldOut, "4th purchase reverts sold out");
});

test("boundary: resale exactly at cap succeeds, one wei above reverts", async () => {
  const env = await setupFresh();
  await createEvent(env);
  await buy(env, "buyer1", 1n);
  let r = await h.call(env.vm, env.ctx, env.accounts.buyer1.key, env.address, ABI, "resellTicket", [1n, RESALE_CAP]);
  eq(r.receipt.status, 1, "at cap ok");
  // cancel then try above
  await h.call(env.vm, env.ctx, env.accounts.buyer1.key, env.address, ABI, "cancelResale", [1n]);
  r = await h.call(env.vm, env.ctx, env.accounts.buyer1.key, env.address, ABI, "resellTicket", [1n, RESALE_CAP + 1n]);
  assertRevert(r, ERR.PriceAboveCap, "one wei above cap");
});

test("boundary: refund exactly at deadline succeeds, one second after reverts", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;
  await createEvent(env); // refundDeadline = time + 7200

  await buy(env, "buyer1", 1n); // ticket 1
  await buy(env, "buyer2", 1n); // ticket 2

  // ticket 1: refund exactly at deadline
  ctx.time = ctx.time + 7200n;
  let r = await h.call(vm, ctx, accounts.buyer1.key, address, ABI, "requestRefund", [1n]);
  eq(r.receipt.status, 1, "refund at deadline ok");

  // ticket 2: refund one second after deadline
  ctx.time = ctx.time + 1n;
  r = await h.call(vm, ctx, accounts.buyer2.key, address, ABI, "requestRefund", [2n]);
  assertRevert(r, ERR.RefundClosed, "refund after deadline");
});

test("boundary: purchase exactly at sale deadline succeeds, after reverts", async () => {
  const env = await setupFresh();
  const { ctx } = env;
  await createEvent(env); // saleDeadline = time + 3600
  ctx.time = ctx.time + 3600n;
  let r = await buy(env, "buyer1", 1n);
  eq(r.receipt.status, 1, "purchase at sale deadline ok");

  ctx.time = ctx.time + 1n;
  r = await buy(env, "buyer2", 1n);
  assertRevert(r, ERR.SaleEnded, "purchase after sale deadline");
});

/* ===================================================================== */
/* 5. State-transition tests                                            */
/* ===================================================================== */
test("state: event Created -> OnSale -> Ended transitions", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;
  const t = ctx.time;
  await createEvent(env, { saleStartTime: t + 1000n }); // future start

  let ev = await readEvent(env, 1n);
  eq(ev.status, 0n, "Created");

  // before start, purchase reverts
  let r = await buy(env, "buyer1", 1n);
  assertRevert(r, ERR.SaleNotOpen, "before start");

  // at start, transitions to OnSale
  ctx.time = t + 1000n;
  r = await buy(env, "buyer1", 1n);
  eq(r.receipt.status, 1, "purchase after start");
  ev = await readEvent(env, 1n);
  eq(ev.status, 1n, "OnSale");

  // after deadline, transitions to Ended
  ctx.time = t + 3601n;
  r = await buy(env, "buyer2", 1n);
  assertRevert(r, ERR.SaleEnded, "after deadline");

  // A committing state-changing call persists the Ended transition.
  r = await h.call(vm, ctx, accounts.buyer1.key, address, ABI, "resellTicket", [1n, PRICE]);
  eq(r.receipt.status, 1, "resale still allowed before refund deadline");
  ev = await readEvent(env, 1n);
  eq(ev.status, 2n, "Ended");
});

test("state: ticket Minted -> Listed -> Minted -> Used", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;
  await createEvent(env);
  await buy(env, "buyer1", 1n);

  let t = await readTicket(env, 1n);
  eq(t.status, 0n, "Minted");

  await h.call(vm, ctx, accounts.buyer1.key, address, ABI, "resellTicket", [1n, PRICE]);
  t = await readTicket(env, 1n);
  eq(t.status, 1n, "Listed");

  await h.call(vm, ctx, accounts.buyer1.key, address, ABI, "cancelResale", [1n]);
  t = await readTicket(env, 1n);
  eq(t.status, 0n, "back to Minted");

  await h.call(vm, ctx, accounts.gateChecker.key, address, ABI, "validateTicket", [1n]);
  t = await readTicket(env, 1n);
  eq(t.status, 2n, "Used");
});

test("state: Used and Refunded are terminal (repeated ops revert)", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;
  await createEvent(env);
  await buy(env, "buyer1", 1n);
  await buy(env, "buyer2", 1n);

  // validate ticket 1 -> Used; second validate reverts
  await h.call(vm, ctx, accounts.gateChecker.key, address, ABI, "validateTicket", [1n]);
  let r = await h.call(vm, ctx, accounts.gateChecker.key, address, ABI, "validateTicket", [1n]);
  assertRevert(r, ERR.InvalidState, "double validate");

  // refund ticket 2 -> Refunded; second refund reverts
  await h.call(vm, ctx, accounts.buyer2.key, address, ABI, "requestRefund", [2n]);
  r = await h.call(vm, ctx, accounts.buyer2.key, address, ABI, "requestRefund", [2n]);
  assertRevert(r, ERR.InvalidState, "double refund");
});

/* ===================================================================== */
/* 6. Reentrancy / security                                             */
/* ===================================================================== */
test("security: reentrancy on requestRefund is blocked", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;

  await createEvent(env);

  // Deploy the malicious attacker contract
  const attacker = await h.deploy(
    vm, ctx, accounts.admin.key, ATTACKER.abi, ATTACKER.bytecode, [address]
  );
  const attackerAddr = attacker.address;

  // Attacker buys a ticket (becomes owner and original owner)
  let r = await h.call(vm, ctx, accounts.admin.key, attackerAddr, ATTACKER.abi, "buyTicket", [1n], { value: PRICE });
  if (r.execResult.exceptionError) throw new Error("attacker buy failed: " + h.bytesToHex(r.execResult.returnValue));

  const owner = await h.view(vm, ctx, accounts.admin.key, address, ABI, "ownerOf", [1n]);
  eq(owner.toLowerCase(), attackerAddr.toLowerCase(), "attacker owns ticket");

  const balanceBefore = await h.balanceOf(vm, attackerAddr);

  // Trigger refund + reentrancy attempt
  r = await h.call(vm, ctx, accounts.admin.key, attackerAddr, ATTACKER.abi, "startRefundAttack", [1n]);
  if (r.execResult.exceptionError) throw new Error("attack tx failed: " + h.bytesToHex(r.execResult.returnValue));

  const balanceAfter = await h.balanceOf(vm, attackerAddr);
  eq(balanceAfter - balanceBefore, PRICE, "attacker received exactly one refund (not double)");

  const blocked = await h.view(vm, ctx, accounts.admin.key, attackerAddr, ATTACKER.abi, "reentryBlocked", []);
  eq(blocked, true, "reentrant call was blocked");
});

/* ===================================================================== */
/* 7. Balance / ownership integrity                                     */
/* ===================================================================== */
test("integrity: refund burns the NFT and returns face value", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;
  await createEvent(env);
  await buy(env, "buyer1", 1n);

  eq(await h.balanceOf(vm, address), PRICE, "contract holds proceeds before refund");

  const r = await h.call(vm, ctx, accounts.buyer1.key, address, ABI, "requestRefund", [1n]);
  assert(hasEvent(r, "RefundRequested"), "RefundRequested emitted");

  const ev = eventsOf(r).find((e) => e.name === "RefundRequested");
  eq(ev.args.amount, PRICE, "refund amount");
  eq(await h.balanceOf(vm, address), 0n, "contract returned funds");

  const bal = await h.view(vm, ctx, accounts.admin.key, address, ABI, "balanceOf", [accounts.buyer1.addressHex]);
  eq(bal, 0n, "NFT burned");
});

test("integrity: contract Ether balance is consistent through lifecycle", async () => {
  const env = await setupFresh();
  const { vm, accounts, ctx, address } = env;
  await createEvent(env);
  await buy(env, "buyer1", 1n);
  await buy(env, "buyer2", 1n);

  // contract holds 2 * PRICE (primary proceeds)
  eq(await h.balanceOf(vm, address), PRICE * 2n, "contract holds primary proceeds");

  // buyer1 refunds one ticket
  await h.call(vm, ctx, accounts.buyer1.key, address, ABI, "requestRefund", [1n]);
  eq(await h.balanceOf(vm, address), PRICE, "contract balance after one refund");

  // organiser withdraws after deadline
  ctx.time = ctx.time + 7201n;
  await h.call(vm, ctx, accounts.organiser.key, address, ABI, "withdraw", [1n]);
  eq(await h.balanceOf(vm, address), 0n, "contract drained after withdraw");
});

/* ===================================================================== */
/* Runner                                                               */
/* ===================================================================== */
(async function run() {
  for (const t of tests) {
    try {
      await t.fn();
      passCount++;
      console.log("PASS  " + t.name);
    } catch (e) {
      failCount++;
      failures.push({ name: t.name, error: e.message });
      console.log("FAIL  " + t.name + "  ->  " + e.message);
    }
  }
  console.log("\n======================================");
  console.log(`Total: ${tests.length}  Passed: ${passCount}  Failed: ${failCount}`);
  if (failCount > 0) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log("  - " + f.name + ": " + f.error);
    }
    process.exit(1);
  }
})();
