/**
 * The host's session boundary, read from every side.
 *
 * The readers that take an event, an SDK result or a sync envelope and answer a
 * session id, a status word, or a payload. These were one describe among sixty in
 * a single grab-bag file, which is the only reason a reader had to hold the whole
 * plugin's contract in mind to check one function.
 *
 * The subject spans three owners now, and each import below names which one it is
 * testing: the readers in host-events.ts, the ledger in task-ledger.ts, and the
 * parentage this file is named after in session-lifecycle.ts.
 */

// The host's event vocabulary, named by the module that owns it. A test firing a
// hardcoded event name is asserting against a name it invented: rename the host
// event and the case keeps firing something the plugin correctly ignores.
import { SESSION_DELETED, SESSION_ERROR, SESSION_IDLE, getEventLifecycleStatus, getSessionIdFromEvent, hostPayload, isTerminalSessionEvent, normalizeStatus } from "../../dist/shared/host-events.js";
import { activeEntry, owedEntry, retainedEntry } from "./support/records.js";
import { assert, describe, it } from "./support/runner.js";
import { assertAbsent, assertEmpty, assertIs, assertNothing, compareStrings } from "./support/assertions.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadTaskLedger, mergeLedgerChange, saveTaskLedger } from "../../dist/shared/task-ledger.js";
import { resolveParentSessionId, validateSessionResult } from "../../dist/shared/session-lifecycle.js";
import { tmpLedgerPath, withEnv, withTempFile } from "./support/harness.js";
import { sessionUpdatedEnvelope } from "./support/mock-host.js";
import { tmpdir } from "node:os";
// The strip the writer applies to a durable record, read from production rather
// than restated as a field list — a test that enumerates the advisories cannot
// notice a fifth one.
import { withoutAdvisory } from "../../dist/shared/task-state.js";

describe("validateSessionResult", () => {
  it("extracts id from flat result", () => {
    assert.strictEqual(validateSessionResult({ id: "ses_123" }), "ses_123");
  });

  it("extracts id from body wrapper", () => {
    assert.strictEqual(
      validateSessionResult({ body: { id: "ses_456" } }),
      "ses_456"
    );
  });

  it("extracts id from data wrapper", () => {
    assert.strictEqual(
      validateSessionResult({ data: { id: "ses_789" } }),
      "ses_789"
    );
  });

  it("returns null for invalid result", () => {
    assertNothing(validateSessionResult(null), "no result at all");
    assertNothing(validateSessionResult({ noId: true }), "a result carrying no id");
  });
});

/**
 * The refusals a session-id reader owes, as one claim: no field at all, no event,
 * or an id that is only whitespace. Two cases state it — one on its own, one with
 * the legacy ambient var set, where a reader that consulted it would answer with
 * the phantom instead of nothing.
 */
const noUsableSessionId = () => {
  assertNothing(resolveParentSessionId({}), "an event with no session field");
  assertNothing(resolveParentSessionId(null), "no event at all");
  assertNothing(resolveParentSessionId({ sessionID: "   " }), "a blank session id");
};

/** The same refusals with the legacy ambient var set: a reader that consulted it would answer the phantom. */
const noUsableSessionIdUnderThePhantomVar = async () => {
  await withEnv("DYNAMIC_TASK_TEST_SESSION_ID", "ses_phantom", noUsableSessionId);
};

describe("resolveParentSessionId", () => {
  it("prefers explicit sessionID", () => {
    const ctx = { sessionID: "ses_parent_1", sessionId: "ses_parent_2" };
    assert.strictEqual(resolveParentSessionId(ctx), "ses_parent_1");
  });

  it("falls back through known keys", () => {
    assert.strictEqual(
      resolveParentSessionId({ sessionId: "ses_parent_2" }),
      "ses_parent_2"
    );
    assert.strictEqual(
      resolveParentSessionId({ session: { id: "ses_parent_3" } }),
      "ses_parent_3"
    );
    assert.strictEqual(resolveParentSessionId({ id: "ses_parent_4" }), "ses_parent_4");
  });

  it("returns null when no usable id exists", () => {
    noUsableSessionId();
  });

  it("ignores the legacy ambient test var — callers resolve explicitly", noUsableSessionIdUnderThePhantomVar);
});

describe("normalizeStatus", () => {
  it("returns lowercase string status", () => {
    assert.strictEqual(normalizeStatus("IDLE"), "idle");
  });

  it("extracts status.type objects", () => {
    assert.strictEqual(normalizeStatus({ type: "error" }), "error");
  });

  it("returns empty string for unsupported values", () => {
    assert.strictEqual(normalizeStatus({ nope: true }), "");
  });

  it("returns empty string for null", () => {
    assert.strictEqual(normalizeStatus(null), "");
  });

  it("returns empty string for undefined", () => {
    assert.strictEqual(normalizeStatus(undefined), "");
  });

  it("returns empty string for number input", () => {
    assertEmpty(normalizeStatus(123), "a number is not a status word");
  });
});

describe("getSessionIdFromEvent", () => {
  it("extracts sessionID from properties", () => {
    const event = { data: { sessionID: "ses_123" } };
    assert.strictEqual(getSessionIdFromEvent(event), "ses_123");
  });

  it("extracts sessionId from data", () => {
    const event = { data: { sessionId: "ses_456" } };
    assert.strictEqual(getSessionIdFromEvent(event), "ses_456");
  });

  it("extracts from aggregateID fallback", () => {
    const event = { aggregateID: "ses_789" };
    assert.strictEqual(getSessionIdFromEvent(event), "ses_789");
  });

  it("extracts from top-level id fallback", () => {
    const event = { id: "ses_top_level" };
    assert.strictEqual(getSessionIdFromEvent(event), "ses_top_level");
  });

  it("returns null for no match", () => {
    assertNothing(getSessionIdFromEvent({}), "an event with no id");
    assertNothing(getSessionIdFromEvent(null), "no event at all");
  });

  it("returns null for whitespace-only id", () => {
    assertNothing(getSessionIdFromEvent({ id: "  " }), "a whitespace-only id");
  });
});

describe("getEventLifecycleStatus", () => {
  it("prefers event.properties.status when present", () => {
    assert.strictEqual(
      getEventLifecycleStatus({ data: { status: { type: "completed" } } }),
      "completed"
    );
  });

  it("falls back to sync event data.info.status", () => {
    assert.strictEqual(
      getEventLifecycleStatus({ data: { info: { status: "error" } } }),
      "error"
    );
  });

  it("returns empty string for no status anywhere", () => {
    assert.strictEqual(getEventLifecycleStatus({}), "");
  });

  // A provider failure (429/auth/overload) is delivered as a session.error
  // event whose payload rides properties.error — there is NO status field, so
  // the status-path candidates return "" and the task was misreported as a
  // clean completion (field log 2026-09-11T19:30:00.485Z). An error-typed
  // event is an error regardless of payload shape, which is why the map is a
  // table: a new host event type is a new row, not a fourth copy of the same
  // three lines.
  for (const [why, event, expected] of [
    ["a session.error event with no status field", { data: { error: { data: { message: "Too Many Requests" }, name: "APIError" }, sessionID: "s1" }, type: SESSION_ERROR }, "error"],
    ["a failure event carrying only a session id", { data: { sessionID: "s1" }, type: SESSION_ERROR }, "error"],
    ["a non-error event still reads its own status", { data: { sessionID: "s1", status: "idle" }, type: SESSION_IDLE }, "idle"],
  ]) {
    it(`${JSON.stringify(why)} reads as ${JSON.stringify(expected) || "(nothing)"}`, () => {
      assertIs(getEventLifecycleStatus(event), expected, why);
    });
  }
});

// One hypothesis, one arrangement: which event SHAPES end a turn. Each case
// keeps its own name because the shape is what a reader needs to see.
describe("isTerminalSessionEvent", () => {
  const shapes = [
    ["treats sync session.updated idle as terminal", sessionUpdatedEnvelope("idle"), true],
    ["treats sync session.updated error as terminal", sessionUpdatedEnvelope({ type: "error" }), true],
    ["treats a bare deletion as terminal", {
      data: { sessionID: "s1" },
      type: SESSION_DELETED,
    }, true],
    ["treats session.idle event as terminal", { type: SESSION_IDLE }, true],
    ["treats session.error event as terminal", { type: SESSION_ERROR }, true],
    ["does not treat an ordinary session event as terminal", { data: { sessionID: "ses_x" }, type: "message.updated" }, false],
  ];
  for (const [name, event, expected] of shapes) {
    it(name, () => {
      assert.strictEqual(isTerminalSessionEvent(event), expected);
    });
  }

  it("matches the broad catch-all", () => {
    assert.strictEqual(
      isTerminalSessionEvent({ data: { sessionID: "s1", status: "idle" }, type: "session.custom" }),
      true
    );
  });
});

// The envelope every host read is routed through. The wrapped case is the one
// production takes (the SDK client resolves to { data, request, response }) and
// the one a reader cannot detect on its own: looking a field up at the top
// level finds nothing rather than throwing.
describe("hostPayload", () => {
  it("unwraps the transport envelope", () => {
    const map = { ses_1: { type: "busy" } };
    assert.deepStrictEqual(hostPayload({ data: map, request: {}, response: {} }), map);
  });
  it("passes a bare payload through", () => {
    const map = { ses_1: { type: "busy" } };
    assert.strictEqual(hostPayload(map), map);
  });
  it("leaves a non-record alone", () => {
    assert.deepStrictEqual(hostPayload([1, 2]), [1, 2]);
    assertAbsent(hostPayload(undefined), "no envelope, no payload");
  });
});

// A scratch file in the OS temp dir, cleaned up including the `.tmp` sidecar.
// Named for intent at the call site: inLedgerFile for the ledger's own on-disk
// shape, inTempFile for a fixture the parser reads.
const inLedgerFile = (fn) => withTempFile(tmpLedgerPath(), fn);

// inLedgerFile, with one record and one owed notice already saved. Durability is
// checked in two places — what comes back out, and what is left on disk — and
// both start here.
const withSavedLedger = (fn) =>
  inLedgerFile((file) => {
    const saved = {
      active: new Map([["ses_2", activeEntry()]]),
      pending: [owedEntry()],
      retained: new Map([["ses_1", retainedEntry()]]),
    };
    saveTaskLedger(saved, file);
    return fn(file, saved);
  });

/** withRawLedger's middle, for the case that already holds the file. */
const withRawLedgerSync = (document, file) => {
  writeFileSync(file, JSON.stringify({ version: 3, ...document }));
  return loadTaskLedger(file);
};

/**
 * A ledger file holding a document the case composed by hand, read back. These
 * cases are about files the plugin has to survive — corrupt, partial, or written
 * by a past it cannot read — and `saveTaskLedger` cannot produce any of them, so
 * going through it would test the writer instead of the reader.
 */
const withRawLedger = (document, fn) =>
  inLedgerFile((file) => fn(withRawLedgerSync(document, file), file));

/**
 * The load of a raw ledger the case wrote: the document in, what the loader made
 * of it. The all-or-nothing and version cases are the same arrangement with a
 * different document, so it is named once and each case states only the document
 * and the claim — the alternative was a reader of a red run having to guess which
 * of three near-identical bodies failed.
 */
const loadRaw = async (document) => {
  let loaded;
  await inLedgerFile(async (file) => {
    loaded = withRawLedgerSync(document, file);
  });
  return loaded;
};

// Every case here owns a temp ledger for the duration of one assertion. The
// old hand-rolled cleanup unlinked the file but not the ledger dance's `.tmp`
// sidecar in the two sites that mattered, and the missing-file site skipped
// cleanup entirely — withTempFile owns the whole lifetime.
describe("task ledger persistence", () => {
  const itRoundTrips = (name, check) => it(name, () => withSavedLedger((file, saved) => check(loadTaskLedger(file), saved)));

  itRoundTrips("round-trips retained records through an injectable path", (loaded) => {
    const record = loaded.retained.get("ses_1");
    assert.strictEqual(loaded.retained.size, 1);
    assert.strictEqual(record.agentName, "explore");
    assert.strictEqual(record.state, "completed");
  });

  // A ledger on disk outlives the build that wrote it: a field this build no
  // longer knows about must be dropped by the reader rather than carried into the
  // store, or a record re-persisted from it would grow the field back. Pinned
  // with a real legacy field, not with one of our own — the previous version of
  // this assertion checked for a field the fixtures no longer set, so it could not
  // fail.
  it("a ledger field this build does not know about is dropped, not carried", () =>
    withRawLedger({ tasks: { ses_1: { ...retainedEntry(), retiredByTheNextBuild: { at: 1, why: "gone" } } } }, (loaded) => {
      assert.strictEqual(loaded.retained.get("ses_1").retiredByTheNextBuild, undefined,
        "an unknown field must not reach the store");
      assert.ok(loaded.retained.has("ses_1"), "and its absence must not cost the record");
    }));

  itRoundTrips("round-trips the owed-notice queue, exact write and attempt count intact", (loaded) => {
    assert.deepStrictEqual(loaded.pending, [owedEntry()], "the owed write survives verbatim");
  });

  it("round-trips a running task, and strips every advisory field from it", () =>
    withSavedLedger(async (file, saved) => {
      const restored = loadTaskLedger(file).active.get("ses_2");
      assert.ok(restored, "the running task comes back");
      assert.deepStrictEqual(restored, withoutAdvisory(saved.active.get("ses_2")),
        "identity and routing survive; the advisory fields do not");
      // Compared against production's own strip rather than a list written out
      // here: a test that enumerates the advisories cannot notice a fifth one, and
      // the list is exactly what a fifth advisory field would have had to be
      // remembered in twice.
      assert.deepStrictEqual(
        JSON.parse(readFileSync(file, "utf8")).active.ses_2,
        withoutAdvisory(saved.active.get("ses_2")),
        "no advisory field reaches disk",
      );
    }));

  // One hypothesis: a record is restored whole or not at all. An active entry
  // missing a base field would be settled by reconciliation with no clock, no
  // lineage and no parent to tell, i.e. a record invented from a corrupt file.
  it("an active entry missing a base field is dropped, not half-restored", async () => {
    const { startedAt: _noClock, ...clockless } = activeEntry({ childSessionId: "ses_nostart" });
    const loaded = await loadRaw({
      active: { ses_nostart: clockless, ses_ok: activeEntry({ childSessionId: "ses_ok" }) },
      pending: [],
      tasks: {},
    });
    assert.deepStrictEqual([...loaded.active.keys()], ["ses_ok"], "only the whole entry returns");
  });

  // The same hypothesis for the queue: a queued write missing any of its fields
  // cannot be redelivered (no parent, no text, or an unknown kind), and half of
  // one is worse than none — the boot would dial a message nobody can account for.
  it("drops a queue entry missing any field, never half of it", async () => {
    const loaded = await loadRaw({ pending: [
      owedEntry({ childSessionId: "ses_noparent", parentSessionId: undefined }),
      owedEntry({ childSessionId: "ses_notext", text: "" }),
      owedEntry({ childSessionId: "ses_badkind", kind: "shout" }),
      // Intentionally corrupt: two spellings of the id (last wins at runtime).
      // Built with fromEntries so the suite does not itself carry a dupe key.
      owedEntry(Object.fromEntries([["childSessionId", "ses_noid"], ["childSessionId", 42]])),
      owedEntry(),
    ], tasks: {} });
    assert.deepStrictEqual(loaded.pending, [owedEntry()], "only the whole entry returns");
  });

  it("returns empty for missing, corrupt, and unknown-version files", async () => {
    const empty = (file) => {
      const loaded = loadTaskLedger(file);
      assert.strictEqual(loaded.retained.size, 0);
      assert.deepStrictEqual(loaded.pending, []);
    };
    empty(`${tmpdir()}/dt-nope-${Date.now()}.json`);
    await withTempFile(tmpLedgerPath(), async (bad) => {
      writeFileSync(bad, "{ nope");
      empty(bad);
    });
    await withTempFile(tmpLedgerPath(), async (future) => {
      writeFileSync(future, JSON.stringify({ pending: [owedEntry()], tasks: {}, version: 999 }));
      empty(future);
    });
  });

  it("save writes atomically via rename — no .tmp residue", () =>
    withSavedLedger(async (file) => {
      assert.strictEqual(existsSync(`${file}.tmp`), false, "tmp must be renamed away, not left behind");
      assert.strictEqual(loadTaskLedger(file).retained.size, 1, "renamed content intact");
      assert.strictEqual(loadTaskLedger(file).active.size, 1, "the running task is written, not dropped");
    }));

  // One hypothesis: an entry survives only if it is well-formed AND agrees with
  // its map key. A divergent or malformed entry is corrupt, not relabeled, so
  // each case declares the tasks it writes and exactly which keys must return.
  const survived = [
    ["rejects entries disagreeing with their map key",
      { ses_a: { ...retainedEntry(), childSessionId: "ses_b" } }, []],
    ["drops entries with unknown states or invalid ids", {
      ses_bad: { ...retainedEntry(), childSessionId: "ses_bad", state: "flying" },
      ses_noid: { ...retainedEntry(), childSessionId: 42 },
      ses_ok: { ...retainedEntry(), childSessionId: "ses_ok" },
    }, ["ses_ok"]],
  ];
  for (const [name, tasks, keepers] of survived) {
    it(name, async () => {
      await inLedgerFile(async (file) => {
        writeFileSync(file, JSON.stringify({ active: {}, pending: [], tasks, version: 3 }));
        assert.deepStrictEqual([...loadTaskLedger(file).retained.keys()], keepers);
      });
    });
  }

  it("rejects non-finite timestamps and mixed lineage wholesale", async () => {
    await inLedgerFile(async (file) => {
      const nanEntry = { ...retainedEntry(), startedAt: NaN };
      const mixedLineage = { ...retainedEntry(), childSessionId: "ses_mix", lineage: ["x", 42] };
      saveTaskLedger({ active: new Map(), pending: [], retained: new Map([["ses_nan", nanEntry], ["ses_mix", mixedLineage]]) }, file);
      const loaded = loadTaskLedger(file).retained;
      assert.strictEqual(loaded.has("ses_nan"), false, "NaN does not survive the durability boundary");
      assert.strictEqual(loaded.has("ses_mix"), false, "mixed lineage is rejected, not silently shortened");
    });
  });

  // The version policy, stated once: a past this reader cannot fully understand
  // is discarded wholesale, because a partially-restored past is worse than a
  // clean boot — a retained history that silently lost entries reads as history.
  it("a v2 ledger is discarded whole, retained records and owed notices alike", async () => {
    const loaded = await loadRaw({ pending: [owedEntry()], tasks: { ses_1: retainedEntry() }, version: 2 });
    assert.strictEqual(loaded.retained.size, 0, "no half-restored history");
    assert.strictEqual(loaded.active.size, 0, "and no running task from a past this build cannot read");
    assert.deepStrictEqual(loaded.pending, [], "no debt from a world this reader cannot describe");
  });

});

// --- The file shape the comment promises, checked against a real write -------
// The version comment beside TASK_LEDGER_VERSION documents the on-disk shape in
// prose, and it went stale: it listed { version, tasks, pending } and omitted
// `active` entirely, which is the half a crash mid-run needs and the smoke test
// found in the wild. Nothing detected it because a prose comment is not
// something a type checker reads and the round-trip test only cares that the
// reader understands what the writer wrote. So the shape is pinned from both
// sides here — a real write names the keys, and the comment must name every one
// of them.
describe("the ledger's documented shape is the shape it writes", () => {
  it("names every key the writer actually produces", async () => {
    const file = `${tmpdir()}/dt-shape-${process.pid}.json`;
    saveTaskLedger({ active: new Map(), pending: [], retained: new Map() }, file);
    const written = Object.keys(JSON.parse(readFileSync(file, "utf8")));

    const source = readFileSync(
      new URL("../../src/shared/task-ledger.ts", import.meta.url),
      "utf8",
    );
    // Scoped to the line that CLAIMS to enumerate, not the whole comment block.
    // A whole-block search passed against a comment that had dropped a key from
    // its File shape line, because the key's name appeared in the prose above —
    // so the first version of this gate was satisfied by the very drift it
    // exists to catch.
    const shape = /^\/\/ File shape:.*$/m.exec(source)?.[0];
    assert.ok(shape, "could not find the 'File shape:' line above TASK_LEDGER_VERSION");

    const undocumented = written.filter((key) => !shape.includes(key));
    assert.deepStrictEqual(
      undocumented,
      [],
      `the File shape line does not mention ${JSON.stringify(undocumented)}. The on-disk ledger ` +
      `is ${JSON.stringify(written)}; a reader who trusts the comment is reading a past. ` +
      `Found: ${shape}`,
    );
  });
});

// ─── The merge that stopped one process deleting another's ──────────────────
//
// The ledger is one file, and every opencode process in a project writes it.
// Refusing a second instance was ruled out, so the writer stopped re-serializing
// its own view and started stating what changed. Pinned HERE, as a pure function,
// because the integration route cannot reach it: the owed queue is a
// module-level singleton, so a second in-process harness installs its own writer
// over the first's and the last write of any settlement comes from the wrong
// instance. boot.test.js carries the one case that does discriminate end to end.
//
// "Foreign" below means: written by another process, and never named by this
// change. Every case asserts it survives, which is the entire claim.
describe("a ledger change never touches an entry it does not name", () => {
  const entry = (id, agent) => ({
    agentName: agent,
    childSessionId: id,
    description: `work for ${agent}`,
    lineage: [agent],
    parentSessionId: "ses_p",
    startedAt: 1000,
    state: "active",
  });
  const ledgerWith = (over = {}) => ({ active: new Map(), pending: [], retained: new Map(), ...over });
  const keys = (map) => [...map.keys()].toSorted(compareStrings);

  it("a running task joins whatever else the file holds", () => {
    // Seeded in ALL THREE halves, because a write that rebuilt any one of them
    // from nothing would still look right to a case that only seeded the others.
    const theirs = entry("ses_theirs", "general");
    const onDisk = ledgerWith({
      active: new Map([["ses_theirs", theirs]]),
      pending: [{ childSessionId: "ses_theirs", kind: "completion", parentSessionId: "ses_p", text: "owed" }],
      retained: new Map([["ses_settled", { ...theirs, childSessionId: "ses_settled", retainedAt: 1, state: "completed" }]]),
    });
    const merged = mergeLedgerChange(onDisk, [{ id: "ses_mine", kind: "running", record: entry("ses_mine", "general") }]);

    assert.deepStrictEqual(keys(merged.active), ["ses_mine", "ses_theirs"], "the other process's running task is untouched");
    assert.deepStrictEqual(keys(merged.retained), ["ses_settled"], "and so is its settled history");
    assert.strictEqual(merged.pending.length, 1, "and the notice it is still owed");
    assert.deepStrictEqual([...onDisk.active.keys()], ["ses_theirs"], "and the input is not mutated underneath the caller");
  });

  it("settling one task does not clear another process's running task", () => {
    const onDisk = ledgerWith({
      active: new Map([["ses_theirs", entry("ses_theirs", "general")], ["ses_mine", entry("ses_mine", "general")]]),
    });
    const settled = { ...entry("ses_mine", "general"), retainedAt: 2000, state: "completed" };
    const merged = mergeLedgerChange(onDisk, [{ id: "ses_mine", kind: "settled", record: settled }]);
    assert.deepStrictEqual(keys(merged.active), ["ses_theirs"], "the settled task left the running set");
    assert.deepStrictEqual(keys(merged.retained), ["ses_mine"], "and is retained, in the same write");
  });

  it("forgetting a task clears it from both halves and nothing else", () => {
    const onDisk = ledgerWith({
      active: new Map([["ses_theirs", entry("ses_theirs", "general")]]),
      retained: new Map([["ses_mine", { ...entry("ses_mine", "general"), retainedAt: 1, state: "completed" }]]),
    });
    const merged = mergeLedgerChange(onDisk, [{ id: "ses_mine", kind: "forgotten" }]);
    assert.deepStrictEqual(keys(merged.retained), [], "the forgotten task is gone");
    assert.deepStrictEqual(keys(merged.active), ["ses_theirs"], "and forgetting one task is not a reason to forget another");
  });

  it("an owed notice joins another process's, and delivering one drops only that one", () => {
    const theirs = { childSessionId: "ses_theirs", kind: "completion", parentSessionId: "ses_p", text: "theirs" };
    const mine = { childSessionId: "ses_mine", kind: "completion", parentSessionId: "ses_p", text: "mine" };
    const onDisk = ledgerWith({ pending: [theirs] });

    const owed = mergeLedgerChange(onDisk, [{ kind: "owed", record: mine }]);
    assert.strictEqual(owed.pending.length, 2, "the other process's owed notice is still owed");

    const delivered = mergeLedgerChange(owed, [{ kind: "delivered", record: mine }]);
    assert.deepStrictEqual(delivered.pending, [theirs], "delivering mine left theirs owed");
  });

  it("the same notice owed twice is one notice, not two", () => {
    const entry2 = { childSessionId: "ses_mine", kind: "completion", parentSessionId: "ses_p", text: "mine" };
    const twice = mergeLedgerChange(ledgerWith(), [
      { kind: "owed", record: entry2 },
      { kind: "owed", record: { ...entry2 } },
    ]);
    assert.strictEqual(twice.pending.length, 1, "re-owing a notice replaces it rather than duplicating it");
  });

  it("a batch of changes lands as one write's worth of work", () => {
    const onDisk = ledgerWith({ active: new Map([["ses_theirs", entry("ses_theirs", "general")]]) });
    const merged = mergeLedgerChange(onDisk, [
      { id: "ses_mine", kind: "running", record: entry("ses_mine", "general") },
      { id: "ses_mine", kind: "stopped" },
    ]);
    assert.deepStrictEqual(keys(merged.active), ["ses_theirs"], "the batch applied in order, and stopped what running started");
  });
});
