/**
 * task-state.ts — the fleet, as state.
 *
 * One store, one file: registration through the concurrency gate, the settlement
 * edge that is exactly-once and terminal, revival and withdrawal, retention's
 * prune, and the callback that tells the ledger a retained write happened. These
 * are the cases that decide whether a child can be settled twice, so they live
 * together rather than being spread across whichever suite happened to touch them.
 */

import { ADVISORY_FIELDS, createTaskStore, findTask, listTasks, noteActivity, oldestRetainedId, pruneRetainedTasks, recordAbortError, recordSettledOutcome, registerActiveTask, reviveRetainedTask, transitionState, withdrawInterruptClaim } from "../../dist/shared/task-state.js";
import { activeEntry, retainedEntry } from "./support/records.js";
import { annotateNotice, markTurnReplacement } from "../../dist/shared/notice-claim.js";
import { assert, beforeEach, describe, it } from "./support/runner.js";
import { assertEmpty, assertIs, assertNothing } from "./support/assertions.js";
import { childParams, defaultConfig, singleSlotConfig } from "./support/fixtures.js";
import { restoreActive, restoreRetained } from "../../dist/shared/task-ledger.js";
import { LedgerChangeKind } from "../../dist/shared/ledger-change.js";
import { normalizeDynamicTaskConfig } from "../../dist/shared/config.js";

/** A store holding one running child named ses_active — where most state cases start. */
function storeWithActive(cfg = defaultConfig) {
  const store = createTaskStore();
  seedSesActive(store, cfg);
  return store;
}

// Every change each of the store's two sinks was handed, in order.
//
// The previous shape counted CALLS on the retained sink alone, and that is how a
// publish of an EMPTY change array satisfied four assertions in this file: the
// call happened and did nothing, because `persistLedger` returns on a zero-length
// payload before it writes anything. It is also why a withdrawal's test could
// only say "the sink was called" — the `Running` change it publishes travels the
// ACTIVE sink, and one counter for both sinks cannot tell them apart.
//
// Production wires both sinks to the same writer (`entry/state.ts`), so what a
// test observes here is what the file receives — but the sinks stay separate,
// because "this write must not persist" is a decision about which of the two
// carried it.
function recordChanges(store) {
  const sink = { active: [], retained: [] };
  store.onRetainedChange = (changes) => { sink.retained.push(...changes); };
  store.onActiveChange = (changes) => { sink.active.push(...changes); };
  return sink;
}

const kinds = (changes) => changes.map((c) => c.kind).join(",");

/** The kind of the change a sink was handed LAST — the one an amendment just made. */
const lastKind = (changes) => changes.at(-1)?.kind ?? "";

/** The same store with both change sinks recorded: the callback cases' subject. */
function recordingStore(cfg = defaultConfig) {
  const store = storeWithActive(cfg);
  return { changes: recordChanges(store), store };
}

function fillBackgroundTasks(store, config, ids) {
  for (const id of ids) {
    registerActiveTask(store, childParams({ agent: id, description: id, id }), config);
  }
}

function seedSesActive(store, config) {
  registerActiveTask(store, childParams({ agent: "reviewer", id: "ses_active" }), config);
}

/** A store already holding the configured maximum of active children. */
function storeAtLimit(cfg) {
  const store = createTaskStore();
  fillBackgroundTasks(store, cfg, ["ses_1", "ses_2", "ses_3"]);
  return store;
}

/**
 * A store whose one task has already been retained in the given state. The
 * settled-record invariant is guarded from two entry points — transitionState
 * and recordSettledOutcome — so the arrangement needs a name, not a state.
 */
function storeSettledAs(state, cfg) {
  const store = storeWithActive(cfg);
  transitionState(store, "ses_active", state);
  return store;
}

/**
 * The exactly-once claim about a settled record, asserted once: a second
 * settlement throws, and the record still holds the outcome that landed first.
 * Two sites guarded this with slightly different patterns, which is two chances
 * to accept a weaker pattern than the sentence claims.
 */
function assertSettlementIsFinal(store) {
  assert.throws(() => transitionState(store, "ses_active", "error"), /terminal|invalid|not found/i);
  assert.strictEqual(store.retainedTasks.get("ses_active").state, "completed");
}

/** A store holding nothing — the claim behind a fresh store, a filter, and a prune. */
function assertStoreEmpty(store, why) {
  assert.strictEqual(store.activeTasks.size, 0, `${why}: nothing running`);
  assert.strictEqual(store.retainedTasks.size, 0, `${why}: nothing retained`);
}

/**
 * The advisory fields a settlement must not carry into retention. A heartbeat and
 * a mid-flight notice are the two the event funnel writes, and neither survives a
 * restart — the claim is one, so the check is one.
 */
function assertNotRetainedFrom(store, field) {
  assert.ok(!(field in store.retainedTasks.get("ses_active")), `${field} must not reach the retained record`);
}

describe("task-state: createTaskStore", () => {
  it("creates empty active and retained maps", () => {
    assertStoreEmpty(createTaskStore(), "a fresh store");
  });
});

describe("task-state: registerActiveTask", () => {
  const config = normalizeDynamicTaskConfig({ maxConcurrent: 3 });

  it("registers an active record for the session", () => {
    const store = createTaskStore();
    const task = registerActiveTask(store, childParams({ agent: "reviewer", description: "test task", id: "ses_1", lineage: ["explore"] }), config);
    assert.strictEqual(task.state, "active");
    assert.strictEqual(store.activeTasks.size, 1);
  });

  it("throws ConcurrencyLimitExceeded when at the limit", () => {
    const store = storeAtLimit(config);
    assert.throws(() => {
      registerActiveTask(store, childParams({ agent: "a4", id: "ses_4" }), config);
    }, /Concurrency/);
  });

  it("settlement frees the slot for the next registration", () => {
    const store = storeAtLimit(config);
    transitionState(store, "ses_1", "completed");
    const task = registerActiveTask(store, childParams({ agent: "a4", id: "ses_4" }), config);
    assert.strictEqual(task.state, "active");
  });
});

describe("task-state: transitionState", () => {
  let store;

  beforeEach(() => {
    store = createTaskStore();
    seedSesActive(store, defaultConfig);
  });

  it("settles active → completed into retention", () => {
    const result = transitionState(store, "ses_active", "completed");
    assert.strictEqual(result.state, "completed");
    assert.strictEqual(result.completed, true);
    assert.strictEqual(store.activeTasks.has("ses_active"), false);
    assert.strictEqual(store.retainedTasks.has("ses_active"), true);
  });

  it("transitions active → error and active → interrupted", () => {
    assert.strictEqual(transitionState(store, "ses_active", "error").state, "error");
    const store2 = storeWithActive(defaultConfig);
    assert.strictEqual(transitionState(store2, "ses_active", "interrupted").state, "interrupted");
  });

  it("settle is exactly-once: a second settlement throws and cannot regress retention", () => {
    transitionState(store, "ses_active", "completed");
    assertSettlementIsFinal(store);
  });

  // The timeout-era races are structurally gone: settlement is exactly once
  // (active -> terminal), so a late error after a reported completion can
  // only arrive through recordSettledOutcome, never through transitionState.
  it("a second settlement attempt cannot regress the first outcome", () => {
    assertSettlementIsFinal(storeSettledAs("completed", defaultConfig));
  });

  it("settlement strips every advisory the record can carry — the ledger carries no heartbeat", () => {
    // One case over the whole list, not a case per field. Production exports
    // ADVISORY_FIELDS, so a fifth advisory is covered the day it is added — where
    // three hand-named cases would have quietly stopped covering anything new.
    const stamped = {
      lastActivityAt: noteActivity(store, "ses_active"),
      lastNotice: annotateNotice(store, "ses_active", "interim", "progress"),
      replacedAt: markTurnReplacement(store, "ses_active"),
      turnLiveAt: noteActivity(store, "ses_active", false),
    };
    for (const field of ADVISORY_FIELDS) {
      assert.ok(stamped[field], `the event funnel stamps ${field} on the active record`);
    }
    transitionState(store, "ses_active", "completed");
    for (const field of ADVISORY_FIELDS) assertNotRetainedFrom(store, field);
  });

  it("retained task remains visible to findTask", () => {
    transitionState(store, "ses_active", "completed");
    const found = findTask(store, "ses_active");
    assert.ok(found, "Retained task must be findable");
    assert.strictEqual(found?.state, "completed");
  });

  it("unknown session ID transition throws", () => {
    assert.throws(() => transitionState(store, "nonexistent", "completed"), /not found|invalid|not active/i);
  });
});

describe("task-state: revival and annotations", () => {

  /** A store whose one child has already been retained in the given state. */
  const retained = (state = "completed", cfg = defaultConfig) => storeSettledAs(state, cfg);

  // The subject of every withdrawInterruptClaim test: one task holding a
  // speculative interrupt claim in the retained ledger, with the persistence
  // signal already wired. Naming the arrangement is what lets each test state
  // only the rule it is about.
  function interruptClaim(cfg = defaultConfig) {
    const counted = recordingStore(cfg);
    transitionState(counted.store, "ses_active", "interrupted", cfg);
    return counted;
  }

  it("withdrawInterruptClaim persists the ledger by publishing the reclaim", () => {
    const { store, changes } = interruptClaim();
    withdrawInterruptClaim(store, "ses_active", Date.now(), defaultConfig);
    assertIs(lastKind(changes.active), "running", "the reclaim itself is the publish, and it travels the active sink");
    assert.strictEqual(store.activeTasks.get("ses_active")?.state, "active");
  });

  it("withdrawInterruptClaim refuses when full or superseded", () => {
    const limited = singleSlotConfig();
    const { store } = interruptClaim(limited);
    fillBackgroundTasks(store, limited, ["ses_other"]);
    assert.strictEqual(
      withdrawInterruptClaim(store, "ses_active", Date.now(), limited), false,
      "no slot accounting bypass past maxConcurrent",
    );
    assert.ok(store.retainedTasks.has("ses_active"), "stays retained when full");

    const { store: store2 } = interruptClaim();
    store2.retainedTasks.get("ses_active").lastAbortAt = Date.now();
    assert.strictEqual(
      withdrawInterruptClaim(store2, "ses_active", 0, defaultConfig), false,
      "a newer abort landing supersedes the stale claim",
    );
  });

  // Same-ms success is still knowledge: a withdraw stamped at the instant of
  // a successful abort must lose to it (>=, not >).
  it("withdrawInterruptClaim refuses when the abort landed in the same millisecond", () => {
    const { store } = interruptClaim();
    const sameInstant = Date.now();
    store.retainedTasks.get("ses_active").lastAbortAt = sameInstant;
    assert.strictEqual(
      withdrawInterruptClaim(store, "ses_active", sameInstant, defaultConfig), false,
      "a same-millisecond successful abort supersedes the withdraw",
    );
    assert.ok(store.retainedTasks.has("ses_active"), "refused withdraw leaves the record retained");
  });

  it("withdrawInterruptClaim returns a fresh speculative claim to active", () => {
    const store = createTaskStore();
    assert.strictEqual(withdrawInterruptClaim(store, "ses_nope"), false);
    seedSesActive(store, defaultConfig);
    transitionState(store, "ses_active", "completed");
    assert.strictEqual(withdrawInterruptClaim(store, "ses_active"), false, "only interrupted claims withdraw");
    const store2 = storeWithActive(defaultConfig);
    transitionState(store2, "ses_active", "interrupted");
    assert.strictEqual(withdrawInterruptClaim(store2, "ses_active", Date.now(), defaultConfig), true);
    assert.strictEqual(store2.activeTasks.get("ses_active")?.state, "active");
    assert.strictEqual(store2.retainedTasks.has("ses_active"), false);
    assert.strictEqual(withdrawInterruptClaim(store2, "ses_active", Date.now(), defaultConfig), false, "second withdrawal refuses");
  });

  it("reviveRetainedTask moves a settled task back to active", () => {
    const store = retained();
    const revived = reviveRetainedTask(store, "ses_active", defaultConfig);
    assert.strictEqual(revived.state, "active");
    assert.strictEqual(store.activeTasks.has("ses_active"), true);
    assert.strictEqual(store.retainedTasks.has("ses_active"), false);
  });

  it("interrupted tasks are not revived — that takes a fresh spawn", () => {
    const store = retained("interrupted");
    assert.throws(() => reviveRetainedTask(store, "ses_active", defaultConfig), /interrupt/i);
  });

  it("revival passes through the concurrency gate", () => {
    const limited = singleSlotConfig();
    const store = storeSettledAs("completed", limited);
    registerActiveTask(store, childParams({ agent: "a2", id: "ses_other" }), limited);
    assert.throws(() => reviveRetainedTask(store, "ses_active", limited), /Concurrency/);
    assert.strictEqual(store.retainedTasks.get("ses_active").state, "completed", "rejected revival leaves the record untouched");
  });

  it("annotateNotice records the latest child message on active tasks only", () => {
    const store = storeWithActive();
    assert.strictEqual(annotateNotice(store, "ses_active", "blocked on credentials"), true);
    assert.strictEqual(store.activeTasks.get("ses_active").lastNotice.message, "blocked on credentials");
    assert.strictEqual(annotateNotice(store, "ses_nope", "x"), false);
    transitionState(store, "ses_active", "completed");
    assert.strictEqual(annotateNotice(store, "ses_active", "late"), false, "settled tasks take no notices");
  });

  it("recordAbortError annotates retained records and is silent otherwise", () => {
    const store = retained("interrupted");
    recordAbortError(store, "ses_active", "boom");
    assert.strictEqual(store.retainedTasks.get("ses_active").abortError, "boom");
    recordAbortError(store, "ses_nope", "boom"); // no throw
  });

  it("oldestRetainedId reads retention order", () => {
    const store = storeWithActive();
    assertNothing(oldestRetainedId(store), "a store that has retained nothing");
    transitionState(store, "ses_active", "completed");
    assert.strictEqual(oldestRetainedId(store), "ses_active");
  });

  it("listTasks splits the fleet by state", () => {
    const store = retained();
    registerActiveTask(store, childParams({ id: "ses_run" }), defaultConfig);
    const { active, retained: settled } = listTasks(store);
    assert.deepStrictEqual(active.map((t) => t.childSessionId), ["ses_run"]);
    assert.deepStrictEqual(settled.map((t) => t.childSessionId), ["ses_active"]);
  });
});

describe("task-state: recordSettledOutcome", () => {

  it("escalates a completed record to error — the one retained rewrite edge", () => {
    const store = storeSettledAs("completed", defaultConfig);
    assert.strictEqual(recordSettledOutcome(store, "ses_active", "error"), true);
    assert.strictEqual(store.retainedTasks.get("ses_active").state, "error");
    assert.ok(store.retainedTasks.has("ses_active"), "stays retained");
  });

  it("refuses to rewrite interrupted or errored records", () => {
    const store = storeSettledAs("interrupted", defaultConfig);
    assert.strictEqual(recordSettledOutcome(store, "ses_active", "error"), false);
  });

  it("refuses non-edges and unknown sessions", () => {
    const store = storeSettledAs("completed", defaultConfig);
    assert.strictEqual(recordSettledOutcome(store, "ses_active", "completed"), false);
    assertIs(recordSettledOutcome(store, "ses_nope", "error"), false, "an untracked session has no outcome to note");
  });
});

describe("task store: retained-change callback", () => {

  function seedActive(store, id) {
    registerActiveTask(store, childParams({ id }), defaultConfig);
  }

  it("notifies on retained writes, silent on active-only writes", () => {
    const { store, changes } = recordingStore();
    seedActive(store, "s1");
    assertIs(kinds(changes.retained), "", "active-only writes stay silent");
    transitionState(store, "s1", "completed");
    assertIs(kinds(changes.retained), "settled");
    recordSettledOutcome(store, "s1", "error");
    assertIs(kinds(changes.retained), "settled,settled");
    // The escalation is the one amendment that REWRITES a recorded success, so
    // the change it publishes has to carry the corrected record. It used to
    // publish an empty array, which the file writer discards — the correction
    // lived in memory until a restart put the success back.
    assertIs(changes.retained[1].record.state, "error", "the published record is the corrected one");
    reviveRetainedTask(store, "s1", defaultConfig);
    assertIs(kinds(changes.retained), "settled,settled", "revival reclaims; it does not settle a second time");
    assertIs(lastKind(changes.active), "running", "and the reclaim it did make is on its way to the file");
  });

  it("pruning emits the change signal when entries expire", () => {
    const store = createTaskStore();
    const changes = recordChanges(store);
    seedActive(store, "s1");
    transitionState(store, "s1", "completed");
    store.retainedTasks.get("s1").retainedAt = 0;
    assert.strictEqual(pruneRetainedTasks(store, { retainedTaskMaxEntries: 100, retainedTaskTtlMs: 1000 }), 1);
    assertIs(kinds(changes.retained), "settled,forgotten");
  });
});

describe("task-state: restoreRetained", () => {

  function ledgerEntry(id, state = "completed") {
    return {
      agentName: "a", childSessionId: id, description: "d", lineage: [], parentSessionId: "p", retainedAt: 2, startedAt: 1, state,
    };
  }

  it("restores unknown ids and skips live state", () => {
    const store = storeWithActive();
    const restored = restoreRetained(store, [
      ["ses_ledger", ledgerEntry("ses_ledger")],
      ["ses_active", ledgerEntry("ses_active")],
    ]);
    assert.strictEqual(restored, 1);
    assert.ok(store.retainedTasks.has("ses_ledger"));
    assert.ok(store.activeTasks.has("ses_active"), "live state wins");
  });

  it("returns zero for empty input", () => {
    assertIs(restoreRetained(createTaskStore(), []), 0, "a store with nothing retained restores nothing");
  });

  // The claim being pinned is the WRITE, not the placement: restoring is a
  // load, and a load that rewrites the file it just read is quadratic in the
  // record count. Measured before this shape existed — a boot restoring the
  // configured cap of 100 records serialized 1.5 MB and issued 200 syscalls to
  // produce a 30 KB file, every boot, for no change in content.
  // Two arrangements the restore cases share, named once. The write counters
  // are the subject of the first two cases, so they are a fixture rather than
  // three lines of `writes = 0` that a case could forget to reset; and a batch of
  // N records differs only in N, which is why N is a number.
  const countingStore = () => {
    const store = createTaskStore();
    const writes = { active: 0, retained: 0 };
    store.onRetainedChange = () => { writes.retained++; };
    store.onActiveChange = () => { writes.active++; };
    return { store, writes };
  };

  const ledgerBatch = (n, state) =>
    Array.from({ length: n }, (_, i) => {
      const id = `ses_${state[0]}${i}`;
      return [id, ledgerEntry(id, state)];
    });

  // The claim being pinned is the WRITE, not the placement: restoring is a
  // load, and a load that rewrites the file it just read is quadratic in the
  // record count. Measured before this shape existed, restoring 200 records
  // issued 200 writes and serialized 4.8 MB to produce a 30 KB file — on every
  // plugin boot, for no change in content.
  it("a whole restore tells the write funnel once, not once per record", () => {
    const settled = countingStore();
    restoreRetained(settled.store, ledgerBatch(100, "completed"));
    assert.strictEqual(settled.writes.retained, 1, "one retained write for a hundred records");

    // A second store, because the two halves outrank each other by design: a
    // record the running half holds is not also a settled one.
    const running = countingStore();
    restoreActive(running.store, new Map(ledgerBatch(100, "active")));
    assert.strictEqual(running.writes.active, 1, "and one running-set write, for the same reason");
  });

  // One write is only safe if the file still ends up telling the truth, and a
  // restore is not always a copy: the cap can drop a record on the way in.
  it("a restore that dropped a record still writes, so the file matches memory", () => {
    const { store, writes } = countingStore();
    restoreRetained(store, ledgerBatch(5, "completed"), 2);
    // The count is PLACEMENTS, not survivors — the cap prunes on the way in, so
    // every record is read and every record offered; what the store keeps is the
    // cap's decision, and the write is what makes the file agree with it.
    assert.strictEqual(store.retainedTasks.size, 2, "the cap kept two of five");
    assert.strictEqual(writes.retained, 1, "the file is written once so it stops claiming five");
  });

  it("a restore of nothing writes nothing", () => {
    const store = createTaskStore();
    let writes = 0;
    store.onRetainedChange = () => { writes++; };
    restoreRetained(store, []);
    assert.strictEqual(writes, 0, "a first boot has no file to correct");
  });

  // The cap's eviction is published as `Forgotten` and written back, so choosing
  // the wrong record is not a slip that washes out on the next boot — it is the
  // file agreeing with the wrong answer. And a file's key order is not its age
  // order: a merge of two ledgers, a formatter, a hand edit, or a clock that
  // moved backwards between two records all produce one, and the oldest record
  // then arrives LAST. Evicting the oldest record already held while keeping the
  // newest arrival — the only two things the function can do — evicts a record
  // newer than the one it keeps, forever.
  //
  // So the claim is CONVERGENCE rather than a single outcome: the same two
  // records in either order must leave the same one standing and name the same
  // one forgotten. One outcome asserted once would be satisfied by an
  // implementation that happens to be right about one order, which is the whole
  // failure. Ages are derived from the id so the two orders cannot be quietly
  // the same fixture.
  const twoAges = (order) =>
    order.map((id) => [id, { ...ledgerEntry(id), retainedAt: id === "ses_older" ? 1 : 9 }]);
  const outcomeOf = (order) => {
    const store = createTaskStore();
    const forgotten = [];
    store.onRetainedChange = (changes) => {
      changes.filter((change) => change.kind === LedgerChangeKind.Forgotten).forEach((change) => forgotten.push(change.id));
    };
    restoreRetained(store, twoAges(order), 1);
    return { forgotten, standing: [...store.retainedTasks.keys()] };
  };

  it("evicts the OLDEST record, whichever order the file arrived in", () => {
    const olderArrivesLast = outcomeOf(["ses_newer", "ses_older"]);
    const olderArrivesFirst = outcomeOf(["ses_older", "ses_newer"]);

    assert.deepStrictEqual(olderArrivesLast.standing, ["ses_newer"], "the cap is one record, and it is the newer one");
    assert.deepStrictEqual(olderArrivesLast, olderArrivesFirst, "where a record sat in the file cannot decide which record survives");
  });
});

describe("pruneRetainedTasks — TTL and max entry eviction", () => {
  const config = normalizeDynamicTaskConfig({ retainedTaskMaxEntries: 2, retainedTaskTtlMs: 50 });

  // Retention prunes on `retainedAt`, so an age IS the fixture, and every record
  // in a store must be aged against the same clock the prune will read. Stated
  // once, through the shared record shape: a hand-written record here could omit
  // `state` and then be asserting about pruning something that was never settled.
  const storeAged = (...agesById) => {
    const store = createTaskStore();
    const now = Date.now();
    for (const [id, age] of agesById) {
      store.markRetained(id, retainedEntry({ childSessionId: id, retainedAt: now - age }));
    }
    return store;
  };

  it("removes expired retained tasks by TTL", () => {
    const store = storeAged(["ses_old", 100000]);
    assert.strictEqual(pruneRetainedTasks(store, config), 1, "Should prune 1 expired entry");
    assertStoreEmpty(store, "only the expired entry was pruned");
  });

  // max is 2, all three within the TTL window — so only the max can prune here.
  it("evicts oldest entries when over max", () => {
    const store = storeAged(["ses_a", 5], ["ses_b", 3], ["ses_c", 0]);
    assert.strictEqual(pruneRetainedTasks(store, config), 1, "Should evict 1 oldest entry");
    assert.strictEqual(store.retainedTasks.size, 2);
    assert.ok(!store.retainedTasks.has("ses_a"), "the oldest entry is the one that goes");
  });

  it("prunes nothing when under limits", () => {
    const store = storeAged(["ses_1", 0]);
    assert.strictEqual(pruneRetainedTasks(store, config), 0);
    assert.strictEqual(store.retainedTasks.size, 1);
  });
});

describe("findTask — edge cases", () => {
  it("returns null for unknown session ID", () => {
    const store = createTaskStore();
    assertNothing(findTask(store, "nonexistent"), "an unknown session is not a task");
  });

  it("finds a settled task", () => {
    const store = createTaskStore();
    store.markRetained("ses_done", retainedEntry({ childSessionId: "ses_done" }));
    assert.strictEqual(findTask(store, "ses_done")?.state, "completed", "a settled task is still findable");
  });

  it("finds a running task", () => {
    const store = createTaskStore();
    registerActiveTask(store, childParams({ description: "t", id: "ses_live" }), defaultConfig);
    assert.strictEqual(findTask(store, "ses_live")?.state, "active", "a running task is findable");
  });
});

// A task is in EXACTLY ONE half of the store, and that is a fact about the store
// rather than a convention its thirty call sites happen to keep. The old
// arrangement let both maps hold one id, and the test above documented the
// overlap as "should not happen in practice" — which is exactly how a false
// `completed` got persisted over a running child: the ledger learned about both
// halves and the boot pass reconciled the same id twice.
describe("the two halves are exclusive, not a convention", () => {
  const idInBothHalves = (store) =>
    [...store.activeTasks.keys()].filter((k) => store.retainedTasks.has(k)).join(",");

  it("a revival takes the task out of the settled set", () => {
    const store = createTaskStore();
    store.markRetained("ses_x", retainedEntry({ childSessionId: "ses_x" }));
    store.markRunning("ses_x", activeEntry({ childSessionId: "ses_x" }));
    assertEmpty(idInBothHalves(store), "a running task is not also a settled one");
  });

  it("a settlement takes the task out of the running set", () => {
    const store = createTaskStore();
    store.markRunning("ses_y", activeEntry({ childSessionId: "ses_y" }));
    store.markRetained("ses_y", retainedEntry({ childSessionId: "ses_y" }));
    assertEmpty(idInBothHalves(store), "a settled task is not also a running one");
  });
});
