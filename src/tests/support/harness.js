/**
 * Test harness funnel — the one way a test boots the plugin, gets a child,
 * releases it, and speaks the server's event language.
 *
 * Every suite that drives the REAL plugin used to carry its own copy of the
 * temp-project-dir rule, the process-global resets, a mock client, and a
 * spawn/cleanup pair. Five copies meant five places for a child to leak, for
 * the ledger resets to drift, and for a mock to answer a shape the server
 * never sends. This module is the single declaration of all of it.
 *
 * Ground truth, not test doubles of the thing under test (Tenet 12): the
 * harness boots `dist/index.js` and calls its real tools and real event
 * handler. Only the *host* (the OpenCode server) is faked, and the fake lives
 * in `mock-host.js` — this module is the driver, that one is the server.
 */

//jscpd:ignore-start
import assert from "node:assert";
import { FAULTS, unengagedFaults, witnesses } from "./faults.js";
import { abortRequests, abortWasRequestedFor } from "./client-queries.js";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import {
  applyHostStatus,
  createMockClient,
  events,
  setHostTurn,
} from "./mock-host.js";
import { textTools, v2Context } from "./v2-context.js";
import { CREATE_INTENT_PREFIX } from "../../../dist/shared/create-intent.js";
import { DEBUG_DIR } from "../../../dist/debug-logger.js";
import { afterEach } from "node:test";
import { clearNotifyLedger } from "../../../dist/shared/notify.js";
import { createStore } from "../../../dist/shared/durable-store.js";
import nodePath, { join } from "node:path";
import { ledgerOver } from "./durable-world.js";
import { opaqueHost } from "./opaque-host.js";
import { resetAgentCache } from "../../../dist/shared/admission.js";
import { shrinkBoundsForTesting } from "../../../dist/shared/execution-bound.js";
import { tmpdir } from "node:os";

//jscpd:ignore-end
export {
  abortRequests,
  abortWasRequestedFor,
  abortedSessions,
  confirmationFor,
  declareNeedsInput,
  dialCount,
  notifiedNotes,
  promptsCarrying,
  promptsSaying,
  promptsTo,
  promptsToCarrying,
  promptTextsTo,
  sentPrompts,
  sessionBody,
  sessionCount,
  sessionIds,
  wasAborted,
} from "./client-queries.js";
import { sleep } from "./timing.js";

export { drain, settled, sleep } from "./timing.js";
export {
  resultForChild,
  resultForUnreadableChild,
  setupTwoTurnHarness,
  withAskedChild,
  withChild,
  withDispatchTree,
  withLoggedChild,
  withSettledChild,
  withSettledDispatchTree,
} from "./child-fixtures.js";
export { textTools, v2Context } from "./v2-context.js";


/**
 * Run `fn` with a seam installed, and put the seam back when the case ends —
 * including when it throws. Every temporary seam in this suite is that shape (a
 * deadline, an environment variable, a temp path), and each was spelling out its
 * own try/finally, which is how one of them grows a restore clause the others
 * lack. `install` is evaluated before the case runs and hands back the undo, so a
 * seam that must snapshot what it replaces can snapshot it before it changes
 * anything.
 */
async function withSeam(install, fn) {
  const undo = install();
  try {
    return await fn();
  } finally {
    undo();
  }
}

/**
 * Run `fn` with every deadline shrunk to a value a test can outwait. The timer
 * is real and still fires — only the patience changes, so a test that observes a
 * bound proves the bound rather than proving a mocked clock. This is the only
 * sanctioned way to shorten a deadline (see shrinkBoundsForTesting).
 */
export const bounded = (ms, fn) => withSeam(() => shrinkBoundsForTesting(ms), fn);

/**
 * Set an env var for the duration of a test and put the host back exactly as
 * it was. The save/restore dance was copied per test, and one copy leaked:
 * a test that wrote a var without a finally left it set for every suite after
 * it in the same process. Restoring the ABSENCE of a var matters as much as
 * its value, so this owns that too — and `undefined` means "unset", so a case
 * table can say "not set" without reaching past this seam.
 */
/**
 * The structured debug lines this project has written, as the operator reads them.
 *
 * v2 gave a plugin no log sink, so there are now two files where there was one
 * host log: a per-(parent, child) file of JSON `debugLog` records, and one
 * `plugin.log` of prose `safeLog` warnings. Reading them back off disk — rather than
 * off a fake host array the host no longer writes — is what makes a log assertion
 * mean anything: the writer under test is the one whose output is checked.
 */
export function debugLines(directory) {
  return readLogDir(directory)
    .filter((name) => name !== PLUGIN_LOG)
    .flatMap((name) => readFileSync(nodePath.join(directory, DEBUG_DIR, name), "utf8").split("\n"))
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** The prose warnings the plugin leaves for an operator, from `plugin.log`. */
export function pluginLog(directory) {
  try {
    return readFileSync(nodePath.join(directory, DEBUG_DIR, PLUGIN_LOG), "utf8");
  } catch {
    return "";
  }
}

const PLUGIN_LOG = "plugin.log";

function readLogDir(directory) {
  try {
    return readdirSync(nodePath.join(directory, DEBUG_DIR));
  } catch {
    return [];
  }
}

export const withEnv = (key, value, fn) =>
  withSeam(() => {
    const had = Object.hasOwn(process.env, key);
    const prev = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    return () => {
      if (had) process.env[key] = prev;
      else delete process.env[key];
    };
  }, fn);

/**
 * Hand a test a path in the OS temp dir and clean up whatever the test left
 * there — INCLUDING the ledger dance's `.tmp` sidecar. Two hand-rolled copies
 * unlinked only the file, so a failing atomic write could leave the sidecar
 * behind; the absence check is the cleanup, not a hope.
 */
/**
 * A unique path for a ledger file, for a case that owns one.
 *
 * Shared because two suites durably write ledgers and the factory was copied: the
 * copy drifted to a different prefix while `withTempFile` still cleaned up both
 * the path and its `.tmp` sidecar, so nothing caught the divergence.
 */
export const tmpLedgerPath = () => `${tmpdir()}/dt-ledger-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;

export const withTempFile = (target, fn) =>
  // Nothing to install — the case is handed the path, and the undo is the cleanup.
  withSeam(() => () => {
    for (const file of [target, `${target}.tmp`]) {
      try {
        unlinkSync(file);
      } catch {
        /* never created */
      }
    }
  }, () => fn(target));

/** A unique path in the OS temp dir. The caller does not create it. */
export const tmpFilePath = (label = "dt") =>
  join(tmpdir(), `${label}-${process.pid}-${Math.floor(Math.random() * 1e6)}`);

/**
 * Harness state must live in a fresh temp project dir, never CWD or a shared
 * path — see the ledger-scoping regression suite.
 */
export function tmpProjectDir() {
  return mkdtempSync(join(tmpdir(), `dt-harness-${Date.now()}-${Math.floor(Math.random() * 1e6)}-`));
}

/** Parse the child id out of the same line the parent reads. */
export function extractSessionId(spawnOutput) {
  const match = spawnOutput.match(/Session: (\S+)/);
  assert.ok(match, `spawn output must contain a session id, got: ${spawnOutput}`);
  return match[1];
}

/**
 * Rendered ages come back as "45s" / "12m" / "1h 5m" — parse them back to
 * seconds so a test can compare the two clocks instead of eyeballing text.
 */
export function renderedAgeSeconds(detail, label) {
  const match = detail.match(new RegExp(`^${label}: (?:(\\d+)h )?(?:(\\d+)m )?(\\d+)s ago$`, "m"));
  assert.ok(match, `"${label}" must render an age. Got: ${detail}`);
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3]);
}





/**
 * `task_interrupt` with the CALLER named, because in every ownership case the
 * caller is the subject rather than a fixture: naming the caller as an argument is
 * what lets a suite ask "what if the caller is this?" instead of re-stating the
 * tool map's argument shape at every call site.
 */
export const interruptAs = (h, sessionId, caller = PARENT) =>
  h.tool.task_interrupt.execute({ session_id: sessionId }, { sessionID: caller });

/**
 * That a stop was REFUSED and never reached the host — the one claim an
 * ownership suite can make about every refusal at once, so it is stated once:
 * no request for any named session, and an answer that says so. A refusal proven
 * only by its wording still passes when the request went out and the host 404'd,
 * which is the bug this funnel exists to catch.
 */
export function assertRefusedWithoutReachingTheHost(h, answer, targets, note) {
  for (const id of [targets].flat()) {
    assert.strictEqual(
      abortWasRequestedFor(h.client, id),
      false,
      `${note}: the host must never be asked about ${id}. asked: ${JSON.stringify(abortRequests(h.client))}`,
    );
  }
  assert.match(String(answer), /Refused/, `${note}: the answer names the refusal. got: ${answer}`);
}

/** The complement: a stop the plugin WAS entitled to make, named per session. */
export function assertStopped(h, targets, _answer, note) {
  for (const id of [targets].flat()) {
    assert.ok(
      abortWasRequestedFor(h.client, id),
      `${note}: ${id} must have been stopped. asked: ${JSON.stringify(abortRequests(h.client))}`,
    );
  }
}







// Harnesses booted during the current test, so one afterEach can release every
// child any test spawned — including ones a test built inline rather than
// through a shared beforeEach.
const liveHarnesses = [];

/**
 * Boot the real plugin against a mock host and return the harness.
 *
 * The process-global stores are reset HERE, at the moment a plugin instance
 * is created, rather than in a per-file beforeEach that a test could run
 * without. `harness.spawn` records the child it creates, so cleanup cannot be
 * forgotten by a test that builds its harness inline.
 */
export async function setupHarness({ hooks = {}, options = {}, directory = tmpProjectDir(), storage, domain = {} } = {}) {
  // v2 took the host's log sink away, so the plugin's debug log is a FILE and the
  // only one. A reader pointed at a host array would read a sink nothing writes,
  // and a log assertion against it passes against silence — so every harness test
  // runs with debug logging ON and `logs()` reads the files off disk.
  process.env.DYNAMIC_TASK_DEBUG = "1";
  const trace = (mark) => {
    if (process.env.HARNESS_TRACE) appendFileSync(process.env.HARNESS_TRACE, `${mark}\n`);
  };
  trace("setup:enter");
  const client = createMockClient(hooks, { kv: domain.kv });
  trace("setup:client");
  const state = client.testState;
  /**
   * The plugin's own durable reader. Every case that asks what was PERSISTED goes
   * through here rather than through `kv`, because a map is the writer's opinion of
   * itself and `load` is what a restart would read.
   */
  const durable = () => createStore(opaqueHost(client), () => {});

  // A step that must produce exactly one notice, counted against a baseline so
  // a suite that already has notices is judged only on this step. The sleep is
  // for CI scheduling, not the contract: delivery is a microtask away.
  //
  // The baseline reader is the shared half: notices are counted as WHAT THIS STEP
  // ADDED, never as what the ledger happens to hold, and both notice assertions
  // in this harness read through it rather than re-deriving the slice.
  const noticesAfter = (action) => {
    const before = state.notifications.length;
    return async () => {
      await action();
      return () => state.notifications.slice(before);
    };
  };
  const oneNotice = async (action) => {
    const fresh = await noticesAfter(action)();
    await sleep(30);
    const notes = fresh();
    assert.strictEqual(notes.length, 1, "a terminal event notifies exactly once");
    return notes;
  };
  resetAgentCache();
  clearNotifyLedger();
  const mod = await import("../../../dist/index.js");
  const plugin = mod.default;
  trace("setup:plugin-loaded");
  // v2 hands the plugin a CONTEXT and registers through it: tools arrive by the
  // editor transform, events by an async iterable. The fake drives those two
  // surfaces for real rather than reaching past them, so a plugin that
  // registered wrongly would fail here instead of in production.
  const { context, rawTools, deliverEvent, rpc } = v2Context(client, directory, options);
  // Options ride on the context itself (`context.options`) — the loader calls
  // `setup(context)` with one argument, so a harness passing them positionally
  // would exercise defaults while believing otherwise.
  // Durable state is seeded BEFORE the boot, because boot is the read: a case that
  // seeds afterwards has already missed the only moment the plugin looks.
  if (storage) storage(state.kv);
  await plugin.setup(context);
  trace("setup:plugin-run");
  assert.ok(rawTools.has("dynamic_task"), "dynamic_task tool must be registered");
  const spawned = [];

  const harness = {
    client,
    /**
     * The host's RPC, as both ends. A case that speaks to the channel goes through the
     * subclient — the way the TUI does — so a method the server never registered fails
     * here instead of passing against a client built from the definition alone.
     */
    rpc,
    /** The host's own durable table, so a case can see what the plugin persisted. */
    kv: state.kv,
    /**
     * What a RESTART would believe, read through the reader the plugin itself uses.
     * A case that reads the rows instead is reading the writer's opinion of itself.
     */
    readLedger: () => ledgerOver(durable()).load(),
    /**
   * The outstanding create intents, through the same reader. The lookup a parent
   * would perform after a refused dispatch: present means issued and never answered,
   * absent means the child is in the ledger.
   *
   * Settled FIRST, because the store enqueues and returns — a drop that is still on the
   * chain is not yet a fact, and a lookup that ran ahead of it would report an answered
   * create as outstanding.
   */
  readIntents: () => durable().load(CREATE_INTENT_PREFIX),
    tool: textTools(rawTools),
    rawTools,
    directory,
    spawned,
    fireEvent: async (event) => {
      applyHostStatus(state, event);
      await deliverEvent(event);
    },
    /**
     * Say whether a session's turn is open, for states a test cannot reach by
     * delivering events (a session the plugin never saw, or one the host has
     * already forgotten). This writes the TRANSCRIPT, which is where production
     * reads the answer from — a fixture holding the fact anywhere else is a
     * second copy of it, and the two could disagree.
     */
    setHostStatus: (id, type) => setHostTurn(state, id, type),

    /**
     * How many times production asked the host for a transcript. Counted because a
     * view that fans out into one read per task turns a fleet view into a burst
     * against a host that answers the whole fleet in one — and v2 left the transcript
     * as the only place a turn's state is recorded, so that burst is now the one a
     * fleet view can make. The count is the only proof a view did not make it.
     */
    transcriptReads: () => state.transcriptReads,
    /** Drop the session's transcript entirely — no turn, no record. */
    forgetHostStatus: (id) => state.transcripts.delete(id),
    /**
     * Say the host HAS this session, without pretending this run created it — the
     * shape of a restore. Distinct from `forgetHostSession` because the status map
     * cannot answer the question: "no turn running" and "never existed" are the
     * same absence there, so a case that needs to separate them says so here.
     */
    rememberHostSession: (id) => state.foreignSessions.add(id),
    /** The host's own not-found: it has no such session, and will say so. */
    forgetHostSession: (id) => {
      state.foreignSessions.delete(id);
      state.sessions.delete(id);
    },
    // The settlement funnel: a task settles only by the event the server
    // would emit, delivered straight to the handler.
    /**
     * A turn ENDING, as the host actually delivers it: the turn is seen working
     * first, then its ending. A turn cannot be over before it has started, so a
     * bare terminal event with nothing before it is not a shape the host
     * produces — tests that need one (echo races, claim-order questions) fire
     * the event themselves through fireEvent and say so.
     */
    // A turn ending the way the server ends one: seen working, then parked.
    // Both events go through fireEvent so the host's status map follows them —
    // a read that consults the map must see what these events said.
    settle: async (id) => {
      await harness.fireEvent(events.working(id));
      await harness.fireEvent(events.idle(id));
    },
    // What the parent has been sent, in order: { to, message } records — the
    // routing target is part of the contract, so it stays visible.
    notices: () => state.notifications,
    noticeBodies: () => state.notifications.map((n) => n.message),
    // What KIND each notice declared. Classification rides on the payload's own
    // field, so a settlement case asserts a kind instead of retyping the prose that
    // tells one kind from another — the vocabulary that made twenty tests fail
    // whenever a sentence was honestly reworded.
    noticeKinds: () => state.notifications.map((n) => n.kind),
    // The notice that mentions a child session, or undefined. A child id is
    // in every settlement notice, so this is the handle for "the notice FOR
    // this child" — routing target included.
    noticeFor: (childId) => state.notifications.find((n) => n.message.includes(childId)),
    permissionCalls: () => state.permissionCalls,
    logs: () => debugLines(directory),
    /** The prose an operator would read: one file, written for a person. */
    prose: () => pluginLog(directory),
    /**
     * The log lines for one event name, as the writer spelled it.
     *
     * The debug log is structured — an `eventName` and its payload — so a case that
     * greps for prose pins wording, and the sentence a writer happens to use today
     * says nothing about whether it logs at all. Naming the event is the contract.
     */
    events: (name) => debugLines(directory).filter((entry) => entry.eventName === name),
    /** The plugin's own prose warnings — the v2 stand-in for the host log. */
    pluginLog: () => pluginLog(directory),
    aborted: () => state.aborted,
    /**
     * Deliver a terminal event and return the ONE notice it produced. Exactly
     * once is the contract, so the count is asserted here rather than at each
     * call site — and counted against a baseline, because a suite may already
     * have notices. The routing target is part of the notice, so the record
     * comes back whole. The sleep is for CI scheduling, not the contract:
     * delivery is a microtask away.
     */
    async noticeAfter(event) {
      const seen = await oneNotice(() => harness.fireEvent(event));
      return seen[0];
    },
    /**
     * Settle a child and hand back the single notice the parent received.
     * Ends the turn the way the host does — see settle. A NOTICE RECORD, like
     * `noticeAfter`: one shape for one concept, so `.message` and `.kind` are the
     * same two fields whichever of the two a case reached for.
     */
    async settledNotice(id) {
      const seen = await oneNotice(() => harness.settle(id));
      return seen[0];
    },
    /**
     * Run an action and hand back every NEW notice whose message matches.
     *
     * `oneNotice` counts a terminal event's notices, so it cannot serve a
     * settlement that legitimately produces more than one — a release hint
     * rides alongside the settlement it released. This polls the observable
     * (the notice itself) rather than a clock, and stops as soon as `expected`
     * have arrived, so a case that is waiting for one notice does not pay for
     * the bound. `expected: 0` is the negative case: it still waits out the
     * bound, because "nothing was said" is only a claim if delivery had its
     * chance. The bound exists so a missing notice FAILS instead of hanging.
     */
    async noticesMatching(match, action, expected = 1) {
      const fresh = await noticesAfter(action)();
      const matched = () => fresh().filter((n) => match.test(n.message));
      for (let waited = 0; waited < 40 && matched().length < expected; waited += 2) await sleep(2);
      return matched();
    },
    /**
     * The admission path's own call: the tool's answer, with no id and nothing
     * to clean up. A refusal test states the whole request, so any default here
     * would fill in the very field under test.
     */
    trySpawn(args, ctx = { sessionID: PARENT }) {
      return harness.tool.dynamic_task.execute(args, ctx);
    },
    /**
     * Spawn one child. Returns the id, the spawn confirmation, and the child's
     * bound tools — binding here means a test never restates which session it
     * is talking about, and it cannot bind the wrong one.
     */
    async spawn(args = {}, ctx = { sessionID: PARENT }) {
      const out = await harness.tool.dynamic_task.execute(
        { description: "bg task", prompt: "Return DONE", subagent_type: "explore", ...args },
        ctx,
      );
      const id = extractSessionId(out);
      if (id) spawned.push(id);
      return { c: bindChild(harness, id, args, ctx), id, out };
    },
    /**
     * A child that already exists, with its tools bound to it. Every test in a
     * tool suite drives SOME child's tool, so the (tool, session_id, ctx)
     * triple is the suite's boilerplate — binding it once here is why no test
     * restates which session it is talking about. Use withChild() to spawn one.
     */
    child(id, args = {}, ctx = { sessionID: PARENT }) {
      return bindChild(harness, id, args, ctx);
    },
    /**
     * Which faults the host actually applied, by name.
     *
     * A test that arms a fault and asserts nothing about it has proved only that
     * the fault did not break the thing under test — which is also what a fake
     * whose fault never engages reports. So the witness is the answer to "was the
     * host really hostile?".
     */
    witnesses() {
      return witnesses(client.testState);
    },
    /**
     * Assert the host really applied `name`. Fails with what DID fire, because
     * "silentHost never fired" is a bug in the fake and the diagnostic has to
     * point there rather than at the plugin behaviour under test.
     */
    assertFired(name) {
      const seen = witnesses(client.testState);
      assert.ok(
        (seen[name] ?? 0) > 0,
        `fault "${name}" never fired — the fake did not engage. Fired: ${JSON.stringify(seen)}`,
      );
      return seen[name];
    },
    /** The fault names this fake can inject, for a suite that enumerates them. */
    faults: FAULTS,
    /**
     * Declare that an armed fault may never fire in this case — the only way out
     * of the teardown rule, so "the host was hostile" is always a claim somebody
     * made deliberately rather than one the run happened to satisfy.
     */
    maybeFault(name) {
      client.testState.maybe.add(name);
    },
    /**
     * Arm the silent host the way a case that boots live then loses the host
     * does: by flipping the flag, which the fake counts as arming on the read.
     */
    silence() {
      return client.silenceHost();
    },
  };
  liveHarnesses.push(harness);
  trace("setup:done");
  return harness;
}

/**
 * The tools of a child session, bound. `id` may be null for a child that does
 * not exist yet (a steer that revives a settled turn, a list) — the binding is
 * lazy so the handle is usable either way.
 */
function bindChild(harness, id, spawnArgs = {}, ctx = { sessionID: PARENT }) {
  const tool = (name) => (args = {}, callCtx) =>
    harness.tool[name].execute({ session_id: id, ...args }, callCtx ?? ctx);
  return {
    get id() { return id; },
    set id(next) { id = next; },
    tool,
    /** Spawn this child and keep the handle's id in sync. */
    async spawn(args = {}) {
      const out = await harness.spawn({ ...spawnArgs, ...args }, ctx);
      id = out.id;
      return out;
    },
    steer: (prompt) => tool("task_continue")({ prompt }),
    interrupt: () => tool("task_interrupt")(),
    status: () => tool("task_status")(),
    result: () => tool("task_result")(),
    revive: () => tool("task_revive")(),
    // The child speaks to its parent, so notify routes by the CHILD's id. Extra
    // args (a notice's payload kind) ride through, so a test never restates the
    // envelope to say what kind of notice it is.
    notify: (message, args = {}) =>
      harness.tool.task_notify.execute({ message, ...args }, { sessionID: id ?? ctx.sessionID }),
    settle: () => harness.settle(id),
  };
}

/**
 * The session the harness calls the parent, stated ONCE. It was spelled as the
 * literal "p1" in six places, so a suite that named its own parent could diverge
 * from the fixtures it was built on and fail as a missing session rather than as
 * a wrong one.
 */
export const PARENT = "p1";


/** Release one harness's children. Best-effort: settled children are fine. */
export async function releaseSpawns(harness) {
  for (const id of harness.spawned.splice(0)) {
    try {
      await harness.tool.task_interrupt.execute({ session_id: id });
    } catch {
      // Already settled — cleanup is best-effort.
    }
  }
}

// Registered here, not in each test file: importing the harness is the opt-in.
afterEach(async () => {
  for (const harness of liveHarnesses.splice(0)) {
    await releaseSpawns(harness);
    // A fault that was armed and never applied is a passing case about nothing,
    // and it fails in the direction that makes tests easy: the fake went
    // indifferent, so the run went green while proving nothing about a hostile
    // host. The rule is here rather than in each test because the property is
    // about the fake, and a test that has to remember it is a test that will not.
    const unengaged = unengagedFaults(harness.client.testState).filter(
      (name) => !harness.client.testState.maybe.has(name),
    );
    assert.deepStrictEqual(
      unengaged,
      [],
      `armed but never applied: ${unengaged.join(", ")} — the fake did not engage, so this case proved nothing`,
    );
  }
});


/**
 * A host theme, for the api double.
 *
 * The host derives `text` from the TERMINAL's own `defaultForeground` and `textMuted`
 * from a gray scale over the terminal background, so these are a dark terminal's
 * foreground and one step of gray below it — the values that actually occur, rather than
 * a theme shaped to suit an assertion.
 *
 * It is all that is left of a set of four. `lightTheme`, `themeRoles` and `bareTheme`
 * existed for one claim — that our own token resolution followed the host's theme through
 * a light one, a set of role names, and a theme declaring none of the optional roles —
 * and no screen of ours paints a figure any more, so the claim has no subject and those
 * three fixtures have no reader.
 */
export const darkTheme = () => ({
  current: {
    accent: RGBA.fromInts(0x88, 0x88, 0xFF),
    syntaxComment: RGBA.fromInts(0x50, 0x50, 0x50),
    text: RGBA.fromInts(0xD0, 0xD0, 0xD0),
    textMuted: RGBA.fromInts(0x6C, 0x6C, 0x6C),
  },
  mode: () => "dark",
});

/**
 * A cap cell, whole.
 *
 * Added because a `bounded` field arrived on `CapCell` and three suites still built
 * `{ value, stated }` literals: the renderer asked `cell.bounded !== null`, `undefined`
 * is not null, and the footer painted the string "undefined" where the number was. The
 * tests are JavaScript, so the type that would have caught it does not run here — which
 * makes this the only place that CAN catch it. Building cells by hand is how a suite
 * starts describing a shape the production code no longer has, and it fails as a wrong
 * number rather than as an error, which is the worst way to fail.
 */
export const capCell = (value, stated = true, limit = null) => ({ bounded: limit, stated, value });
import { RGBA } from "@opentui/core";

