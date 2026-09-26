/**
 * task-state.ts — the fleet, as state.
 *
 * One store, one file: registration through the concurrency gate, the settlement
 * edge that is exactly-once and terminal, revival and withdrawal, retention's
 * prune, and the callback that tells the ledger a retained write happened. These
 * are the cases that decide whether a child can be settled twice, so they live
 * together rather than being spread across whichever suite happened to touch them.
 */

import { describe, it, beforeEach, assert } from "./support/runner.js";
import { ADVISORY_FIELDS, annotateNotice, createTaskStore, findTask, listTasks, markTurnReplacement, noteActivity, noteLateOutcome, oldestRetainedId, pruneRetainedTasks, recordAbortError, registerActiveTask, restoreActive, restoreRetained, reviveRetainedTask, transitionState, withdrawInterruptClaim } from "../../dist/shared/task-state.js";
import { normalizeDynamicTaskConfig } from "../../dist/shared/config.js";
import { retainedEntry } from "./support/records.js";
import { assertIs, assertNothing } from "./support/assertions.js";
import { childParams, defaultConfig, singleSlotConfig } from "./support/fixtures.js";

/** A store holding one running child named ses_active — where most state cases start. */
function storeWithActive(cfg = defaultConfig) {
  const store = createTaskStore();
  seedSesActive(store, cfg);
  return store;
}

// The persistence signal a retained mutation must emit. Wiring the counter to
// the store here means no test hand-rolls the callback and then has to read the
// same counter it wrote.
function countRetainedChanges(store) {
  const counter = { calls: 0 };
  store.onRetainedChange = () => { counter.calls++; };
  return counter;
}

/** The same store with the retained-change signal counted: the callback cases' subject. */
function countingStore(cfg = defaultConfig) {
  const store = storeWithActive(cfg);
  return { store, changes: countRetainedChanges(store) };
}

function fillBackgroundTasks(store, config, ids) {
  for (const id of ids) {
    registerActiveTask(store, childParams({ id, agent: id, description: id }), config);
  }
}

function seedSesActive(store, config) {
  registerActiveTask(store, childParams({ id: "ses_active", agent: "reviewer" }), config);
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
 * and noteLateOutcome — so the arrangement needs a name, not a state.
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
    const task = registerActiveTask(store, childParams({ id: "ses_1", agent: "reviewer", description: "test task", lineage: ["explore"] }), config);
    assert.strictEqual(task.state, "active");
    assert.strictEqual(store.activeTasks.size, 1);
  });

  it("throws ConcurrencyLimitExceeded when at the limit", () => {
    const store = storeAtLimit(config);
    assert.throws(() => {
      registerActiveTask(store, childParams({ id: "ses_4", agent: "a4" }), config);
    }, /Concurrency/);
  });

  it("settlement frees the slot for the next registration", () => {
    const store = storeAtLimit(config);
    transitionState(store, "ses_1", "completed");
    const task = registerActiveTask(store, childParams({ id: "ses_4", agent: "a4" }), config);
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
  // only arrive through noteLateOutcome, never through transitionState.
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
      turnLiveAt: noteActivity(store, "ses_active", false),
      replacedAt: markTurnReplacement(store, "ses_active"),
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
    const counted = countingStore(cfg);
    transitionState(counted.store, "ses_active", "interrupted", cfg);
    return counted;
  }

  it("withdrawInterruptClaim persists the ledger via emitRetainedChange", () => {
    const { store, changes } = interruptClaim();
    const before = changes.calls;
    withdrawInterruptClaim(store, "ses_active", Date.now(), defaultConfig);
    assert.strictEqual(changes.calls, before + 1, "withdraw is a retained mutation and must persist");
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
    registerActiveTask(store, childParams({ id: "ses_other", agent: "a2" }), limited);
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

describe("task-state: noteLateOutcome", () => {

  it("escalates a completed record to error — the one retained rewrite edge", () => {
    const store = storeSettledAs("completed", defaultConfig);
    assert.strictEqual(noteLateOutcome(store, "ses_active", "error"), true);
    assert.strictEqual(store.retainedTasks.get("ses_active").state, "error");
    assert.ok(store.retainedTasks.has("ses_active"), "stays retained");
  });

  it("refuses to rewrite interrupted or errored records", () => {
    const store = storeSettledAs("interrupted", defaultConfig);
    assert.strictEqual(noteLateOutcome(store, "ses_active", "error"), false);
  });

  it("refuses non-edges and unknown sessions", () => {
    const store = storeSettledAs("completed", defaultConfig);
    assert.strictEqual(noteLateOutcome(store, "ses_active", "completed"), false);
    assertIs(noteLateOutcome(store, "ses_nope", "error"), false, "an untracked session has no outcome to note");
  });
});

describe("task store: retained-change callback", () => {

  function seedActive(store, id) {
    registerActiveTask(store, childParams({ id: id }), defaultConfig);
  }

  it("notifies on retained writes, silent on active-only writes", () => {
    const { store, changes } = countingStore();
    seedActive(store, "s1");
    assert.strictEqual(changes.calls, 0, "active-only writes stay silent");
    transitionState(store, "s1", "completed");
    assert.strictEqual(changes.calls, 1);
    noteLateOutcome(store, "s1", "error");
    assert.strictEqual(changes.calls, 2);
    reviveRetainedTask(store, "s1", defaultConfig);
    assert.strictEqual(changes.calls, 3, "revival leaves the retained ledger");
  });

  it("pruning emits the change signal when entries expire", () => {
    const store = createTaskStore();
    const changes = { calls: 0 };
    store.onRetainedChange = () => { changes.calls++; };
    seedActive(store, "s1");
    transitionState(store, "s1", "completed");
    store.retainedTasks.get("s1").retainedAt = 0;
    assert.strictEqual(pruneRetainedTasks(store, { retainedTaskTtlMs: 1000, retainedTaskMaxEntries: 100 }), 1);
    assert.strictEqual(changes.calls, 2);
  });
});

describe("task-state: restoreRetained", () => {

  function ledgerEntry(id, state = "completed") {
    return {
      childSessionId: id, parentSessionId: "p", agentName: "a",
      description: "d", lineage: [], state,
      startedAt: 1, retainedAt: 2,
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
    const writes = { retained: 0, active: 0 };
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
});

describe("pruneRetainedTasks — TTL and max entry eviction", () => {
  const config = normalizeDynamicTaskConfig({ retainedTaskTtlMs: 50, retainedTaskMaxEntries: 2 });

  // Retention prunes on `retainedAt`, so an age IS the fixture, and every record
  // in a store must be aged against the same clock the prune will read. Stated
  // once, through the shared record shape: a hand-written record here could omit
  // `state` and then be asserting about pruning something that was never settled.
  const storeAged = (...agesById) => {
    const store = createTaskStore();
    const now = Date.now();
    for (const [id, age] of agesById) {
      store.retainedTasks.set(id, retainedEntry({ childSessionId: id, retainedAt: now - age }));
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

  it("finds active task before retained task", () => {
    const store = createTaskStore();
    registerActiveTask(store, childParams({ id: "ses_dup", description: "t" }), defaultConfig);
    // Same key in both maps — should not happen in practice — and while the task
    // runs, the running record is the truth.
    store.retainedTasks.set("ses_dup", retainedEntry({ childSessionId: "ses_dup", description: "t" }));

    const result = findTask(store, "ses_dup");
    assert.strictEqual(result?.state, "active", "Should find active before retained");
  });
});
