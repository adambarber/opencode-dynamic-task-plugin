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

import { afterEach, assert, beforeEach } from "./runner.js";
import { createMockClient } from "./mock-host.js";
import { createStateFacade } from "../../../dist/shared/state-facade.js";
import { createStore } from "../../../dist/shared/durable-store.js";
import { opaqueHost } from "./opaque-host.js";
import { shrinkBoundsForTesting } from "../../../dist/shared/execution-bound.js";

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

/** A world holding exactly one record of ours, beside a document that is not ours. */
function besideAForeignKey(records) {
  const world = seeded(records);
  world.kv.set("overlay/v1", { caps: {} });
  return world;
}

/**
 * Shrink every deadline for a whole suite, and put them back after each case. A
 * case that asserts about a bound needs it held across the arrange and not only
 * across the await that observes it, and two suites spelling the hook pair drifted
 * into two slightly different save/restore dances.
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

export const durable = {
  besideAForeignKey,
  build,
  everyShape,
  failing,
  held,
  isTaskRecord,
  key,
  loaded,
  paged,
  refusing,
  seeded,
  tightBounds,
  written,
};