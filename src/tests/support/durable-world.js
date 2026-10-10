// src/tests/support/durable-world.js
// One world with durable state in it, for every suite that exercises the store or
// the facade that reads through it.
//
// It exists because two suites built this world separately and the duplicate gate
// found them: the client, the refusals it produced, the gate, the write, and the
// read all had to be spelled again in each, so a change to the storage fake reached
// one suite first and the other failed for the wrong reason.
//
// Every case gets its world BUILT FOR IT, by a builder named after the claim it is
// about. That is not tidiness: a case that assembles its own world spells the same
// arrangement as every other case that does, and the duplicate gate reads that as
// duplication of the code under test rather than of the fixture.

import { createStore } from "../../../dist/shared/durable-store.js";
import { shrinkBoundsForTesting } from "../../../dist/shared/execution-bound.js";
import { createLedgerStore, LEDGER_KEYS } from "../../../dist/shared/ledger-storage.js";
import { createStateFacade } from "../../../dist/shared/state-facade.js";
import { createTaskStore } from "../../../dist/shared/task-state.js";
import { createMockClient } from "./mock-host.js";
import { opaqueHost } from "./opaque-host.js";
import { afterEach, assert, beforeEach } from "./runner.js";

/** Small enough that a hung host costs a case milliseconds rather than seconds. */
const PATIENCE_MS = 5;

/** Nothing yet. Named, because a case reads it as "not yet" rather than as "broken". */
const NOT_YET = () => {};

/** The keys every case uses. One prefix, so a case cannot quietly address another. */
const PREFIX = "ledger/v3/task/";

/**
 * A record as the ledger writes one: an object with a state, and nothing else
 * claimed. The guard every read here is asked to apply, so it lives beside the
 * reader rather than in each suite.
 */
const isTaskRecord = (value) =>
  typeof value === "object" && value !== null && typeof value.state === "string";

/**
 * A world over a fake host: the live `kv`, the store, the facade, and the refusals
 * reported in order.
 */
function build(options) {
  const client = createMockClient(options);
  const refusals = [];
  const store = createStore(opaqueHost(client), (what) => refusals.push(what));
  const { kv } = client.testState;
  const facade = createStateFacade(store);
  return {
    /** What the host now holds. Absence is asserted as absence, not as undefined. */
    assertDurable: (name, value) => assert.deepEqual(kv.get(key(name)), value),
    assertNotHeld: (name) => assert.equal(kv.has(key(name)), false),
    /** One refusal, said once. Several cases assert this; spelled out it drifted. */
    assertRefused: (about) => {
      assert.equal(refusals.length, 1, "a refusal is reported once, and only once");
      assert.match(refusals[0], about);
    },
    client,
    facade,
    kv,
    /** The production ledger reader over this same chain, for a boot-shaped claim. */
    ledger: ledgerOver(store),
    /** Read every record under the prefix through the facade, guarded. */
    readAll: () => facade.readAll(PREFIX, isTaskRecord),
    refusals,
    /** Put a record in the host's hands without going through the store. */
    seed: (name, value) => kv.set(key(name), value),
    store,
  };
}

/** Every record under the prefix, as the store itself sees them: no guard, no counts. */
function loaded(world) {
  return world.store.load(PREFIX);
}

/** The one way a case names a record. Outside this module nobody knows the prefix. */
function key(name) {
  return `${PREFIX}${name}`;
}

/**
 * Stage one write and wait for the chain. A case that asserts about durability has
 * to observe it, and spelling "put then await settled" by hand is how one forgets.
 */
async function written(world, name, value) {
  world.store.put(key(name), value);
  await world.store.settled();
}

/** A world whose host is holding a storage call: the one thing nothing can wait on. */
function held(options) {
  const world = build(options);
  return { ...world, gate: world.client.gateStorage() };
}



/** A world already holding `records`, keyed by name under the prefix. */
function seeded(records = {}) {
  const world = build();
  for (const [name, value] of Object.entries(records)) {
    world.seed(name, typeof value === "string" ? value : JSON.stringify(value));
  }
  return world;
}

/**
 * A world that has just REFUSED the write of one record, with that write still HELD
 * by the host. `holdNext` rather than the generic gate, because the question this
 * world exists to ask is what the store does when the abandoned call finally
 * ARRIVES — and only a held write arrives after the newer one has already landed.
 */
async function refusing(name, value) {
  const world = build();
  const gate = world.client.holdNextStorageWrite();
  await written({ ...world, gate }, name, value);
  return { ...world, gate };
}

/**
 * `count` records, and a record of every page the host was asked for. The cursor is
 * the claim, so the case that cares about it must be able to see how it was used.
 */
function paged(count) {
  const world = build();
  for (let index = 0; index < count; index += 1) world.seed(`ses_${index}`, { n: index });
  const sizes = [];
  const real = world.client.storage.scan;
  world.client.storage.scan = async (options) => {
    const page = await real({ ...options, limit: 5 });
    sizes.push(page.entries.length);
    return page;
  };
  return { sizes, world };
}

/** A world whose host throws rather than answering. */
function failing() {
  return build({ storageThrows: true });
}

/** A world holding one record in every shape the host may hand a reader. */
function everyShape() {
  const world = seeded({ ses_bad: { nope: true }, ses_text: { state: "active" } });
  world.seed("ses_object", { state: "active" });
  world.seed("ses_torn", "{not json");
  return world;
}

/**
 * A world whose subject is the LEDGER rather than the store: the real ledger over the
 * real facade, over the same fake host. A case that built this itself would spell the
 * three layers again, and would be free to wire them in an order the plugin never uses.
 */
function ledger() {
  const world = build();
  const store = world.ledger;
  return {
    ...world,
    /** A child must be in exactly one half. Absence is asserted as absence, not as
     *  an undefined lookup — a record that merely reads as empty is a defect here. */
    assertHalfGone: (half, child, why) => {
      assert.equal(world.kv.has(LEDGER_KEYS[half](child)), false, why);
    },
    ledger: store,
    /** Persist, wait until the host has it, and report what is durable. A case that
     *  observes durability without the wait is asserting about a queue it never saw. */
    persist: async (changes) => {
      store.persist(changes);
      await world.store.settled();
      return store.load();
    },
    read: () => store.load(),
    /** Let everything queued so far reach the host. A case that observes durability
     *  without this is asserting about a queue it never waited on. */
    settle: () => world.store.settled(),
  };
}

/**
 * A ledger world that has ALREADY persisted the given changes, one persist per change,
 * in the order given. Most claims here are about what is durable once something
 * happened, so the thing that happened is the arrangement and the claim is what
 * follows — spelling "world, persist, await, read" in every case made the ceremony the
 * only thing the duplicate gate could see.
 */
async function ledgerAfter(...firstChanges) {
  const world = ledger();
  for (const change of firstChanges) {
    await world.persist([change]);
  }
  return world;
}

/**
 * A ledger world where a child has already MOVED from one half to the other. Three
 * claims here are about a move rather than about a record, and each spelled the same
 * "running, then settle it" arrival: the ceremony was the thing they shared, not a
 * defect in any one of them.
 */
async function ledgerMoved(from, to) {
  const world = await ledgerAfter(from);
  await world.persist([to]);
  return world;
}

/**
 * One child already written, with the host HOLDING the next write it is asked for. A
 * refused move is only possible in this world — a write that is merely late asks a
 * different question — so the arming belongs beside the arrival, not in each case.
 */
async function ledgerHeldAfter(firstChange) {
  const world = await ledgerAfter(firstChange);
  return { held: world.client.holdNextStorageWrite(), world };
}

/**
 * A ledger world whose host table holds exactly the given rows, for a claim about a
 * value the writer never produced — a torn row, a record filed under the wrong child,
 * a field this build does not know. The rows ARE the arrangement, so they are named
 * rather than written inside a closure in every corrupt-value case.
 */
function ledgerHolding(...rows) {
  const world = ledger();
  for (const [rowKey, value] of rows) {
    world.kv.set(rowKey, value);
  }
  return world;
}

/**
 * What the ledger reader makes of the given host rows. Almost every claim about a
 * seeded row IS that read, so building the world and reading it are one arrangement:
 * splitting them left every case spelling the same two lines, and the duplicate gate
 * read the ceremony as duplication of the reader.
 */
async function ledgerReading(...rows) {
  const world = ledgerHolding(...rows);
  return { read: await world.read(), world };
}

/**
 * The production LEDGER reader over an existing bounded store: the real store, the
 * real facade, the real reader — layered over the chain the writes go into, never a
 * second one. Two chains over one host is a world the plugin never has, and a case
 * that awaits the empty one learns nothing about whether its write landed.
 */
export function ledgerOver(store) {
  return createLedgerStore(createStateFacade(store));
}

/**
 * The LEDGER world wired to a real task store the way `entry/state.ts` wires it, so a
 * case can ask the only question the ledger exists to answer: after the process dies,
 * what will the next one believe? The sinks ARE the subject — they are the line an
 * empty publish used to vanish behind — so they are wired once, here, rather than in
 * every suite that needs the join.
 */
async function durableTask(fn) {
  const world = ledger();
  const store = createTaskStore();
  store.onActiveChange = (changes) => world.ledger.persist(changes);
  store.onRetainedChange = (changes) => world.ledger.persist(changes);
  const out = await fn(world, store);
  return { ...out, store, world };
}

/** A world holding exactly one record of ours, beside a document that is not ours. */
function besideAForeignKey(records) {
  const world = seeded(records);
  world.kv.set("overlay/v1", { caps: {} });
  return world;
}

/**
 * Nothing answered at all. The claim is the same at either level of the reader — it is
 * why `incomplete` exists — and only the collection each reader reports differs, so a
 * case names that. An operator told "no records" would conclude there is nothing to
 * settle, when in fact nothing could be read.
 */
function assertNothingAnswered(read, size, why) {
  assert.equal(read.incomplete, true, `nothing answered, and the read says PARTIAL — ${why}`);
  assert.equal(size(read), 0, `and it is empty rather than clean — ${why}`);
  return read;
}

/**
 * Run a claim with every deadline shrunk, and put them back afterwards. A claim about
 * a REFUSAL needs the bound to expire inside the test, and the save/restore dance was
 * spelled out in each such case, which is how two of them drifted into two slightly
 * different teardowns.
 */
async function whileRefused(claim) {
  const restore = shrink();
  try {
    return await claim();
  } finally {
    restore();
  }
}

/**
 * Shrink every deadline for a whole suite, and put them back after each case, so a
 * bound is held across the arrange and not only across the await that observes it.
 */
function tightBounds(ms = PATIENCE_MS) {
  let restore = NOT_YET;
  beforeEach(() => {
    restore = shrinkBoundsForTesting(ms);
  });
  afterEach(() => {
    restore();
  });
}

/**
 * Shorten every deadline for one case, and put it back after. A case that asserts a
 * REFUSAL needs the bound to expire inside the test; a case that asserts a successful
 * read or write must not have its answer race a clock it does not control, so it runs
 * at the production bound and passes by observation rather than by luck.
 */
function shrink(ms = PATIENCE_MS) {
  return shrinkBoundsForTesting(ms);
}

/**
 * The plugin's own durable reader over a client.
 *
 * Exported because three support modules were each building it by hand, and a case
 * that constructs its own facade can disagree with the plugin's about what "durable"
 * means without either being wrong.
 */
export function facadeOver(client) {
  return createStateFacade(createStore(opaqueHost(client), () => {}));
}

export const durable = {
  assertNothingAnswered,
  besideAForeignKey,
  build,
  durableTask,
  everyShape,
  failing,
  held,
  isTaskRecord,
  key,
  ledger,
  ledgerAfter,
  ledgerHeldAfter,
  ledgerHolding,
  ledgerMoved,
  ledgerReading,
  loaded,
  paged,
  refusing,
  seeded,
  shrink,
  tightBounds,
  whileRefused,
  written,
};