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

import assert from "node:assert";
import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "node:test";
import { resetAgentCache } from "../../../dist/shared/admission.js";
import { clearNotifyLedger, isParentNotification } from "../../../dist/shared/notify.js";
import { shrinkBoundsForTesting } from "../../../dist/shared/execution-bound.js";
import { ASSISTANT_ROLE } from "../../../dist/shared/prompt.js";
import { getDebugLogPath } from "../../../dist/debug-logger.js";
import {
  applyHostStatus,
  createMockClient,
  events,
  promptText,
  putHostStatus,
  unclockedSaid,
} from "./mock-host.js";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
export const withTempFile = (path, fn) =>
  // Nothing to install — the case is handed the path, and the undo is the cleanup.
  withSeam(() => () => {
    for (const file of [path, `${path}.tmp`]) {
      try {
        unlinkSync(file);
      } catch {
        /* never created */
      }
    }
  }, () => fn(path));

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
 * Questions about the fake host's recorded state, asked here instead of by 26
 * hand-rolled reach-throughs.
 *
 * The harness owns `_state` — that is the whole point of it — and the tests were
 * each re-deriving the same queries out of it: `filter((p) => p.to === id)`,
 * `filter((p) => p.body.parts[0].text.includes("pivot"))`, `aborted.includes(id)`.
 * The body shape and the field names then had 26 callers to keep in step, and a
 * test that renames one gets a filter that matches nothing — which is the
 * dangerous direction, because the common assertion is "this did NOT happen", so
 * a broken predicate still passes.
 *
 * Each function below is one of those questions with its answer's shape decided
 * once: which prompts reached a child, which carried a given text, whether a turn
 * was aborted, how many dials the gate made. The client is the argument because a
 * `failing` or `one` harness and the primary `h` are all equally valid subjects.
 */

/** Every prompt the host was asked to send, oldest first. */
export const sentPrompts = (client) => client._state.promptBodies;

/** The prompts addressed to one session — "which turns of this child fired". */
export const promptsTo = (client, sessionId) => client._state.promptBodies.filter((p) => p.to === sessionId);

/** The text of every prompt addressed to one session. */
export const promptTextsTo = (client, sessionId) => promptsTo(client, sessionId).map(promptText);

/**
 * The text the spawning turn was told back — the confirmation, not the child's
 * opening. Its sibling `promptTextsTo` reads what went OUT; this reads what came
 * back, and a case that wants the dispatcher's side of a spawn should not have to
 * destructure the seam's whole return to get one string out of it.
 */
export const confirmationFor = async (h, description, args = {}) =>
  (await h.spawn({ ...args, description })).out;

/** "This prompt said these words" — the one predicate both prompt readers use. */
const carries = (words) => (p) => promptText(p).includes(words);

/** The prompts addressed to one session that carry the given words. */
export const promptsToCarrying = (client, sessionId, words) => promptsTo(client, sessionId).filter(carries(words));

/** Every prompt whose text contains the given words — "which turn said this". */
export const promptsCarrying = (client, words) => sentPrompts(client).filter(carries(words));

/** How many prompts said the given words — the count a "nothing fired" case asserts. */
export const promptsSaying = (client, words) => promptsCarrying(client, words).length;

/** Whether a turn was aborted, without leaking the array to compare against. */
export const wasAborted = (client, sessionId) => client._state.aborted.includes(sessionId);

/** The sessions aborted so far, for a failure message that wants the list. */
export const abortedSessions = (client) => client._state.aborted;

/** Every session the host has been asked to create. */
export const sessionIds = (client) => [...client._state.sessions];

/** How many sessions the host has been asked to create. */
export const sessionCount = (client) => client._state.sessions.size;

/** The create body recorded for one session — what the host was told to make. */
export const sessionBody = (client, sessionId) => client._state.sessionBodies.get(sessionId);

/** How many dials the gate made, held or not. */
export const dialCount = (client) => client._state.notifyCalls.length;

/** The parent notifications the plugin recorded. */
export const notifiedNotes = (client) => client._state.notifications;

/** How many times the host's status channel was read. */
export const statusReadCount = (client) => client._state.statusReads;

/** A child declaring it cannot continue without something. The `needs_input` kind is the
 * production contract for that gesture, so it is spelled here once rather than at
 * every site that needs a child to be stuck. */
export const declareNeedsInput = (child, words) => child.notify(words, { kind: "needs_input" });

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
export async function setupHarness({ hooks = {}, options = {}, directory = tmpProjectDir() } = {}) {
  const client = createMockClient(hooks);
  const state = client._state;

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
  const pluginFn = mod.default || mod;
  const result = await pluginFn({ client, directory }, options);
  assert.ok(result.tool?.dynamic_task, "dynamic_task tool must be registered");
  const spawned = [];

  const harness = {
    client,
    tool: result.tool,
    directory,
    spawned,
    fireEvent: (event) => {
      applyHostStatus(state, event);
      return result.event({ event });
    },
    /**
     * Put a session's host status where the server's map would hold it, for
     * states a test cannot reach by delivering events (a session the plugin
     * never saw, or one the host has already forgotten).
     */
    setHostStatus: (id, type) => putHostStatus(state, id, type),
    /** Drop a session from the host's map entirely — no turn, no entry. */
    forgetHostStatus: (id) => state.hostStatus.delete(id),
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
    // The notice that mentions a child session, or undefined. A child id is
    // in every settlement notice, so this is the handle for "the notice FOR
    // this child" — routing target included.
    noticeFor: (childId) => state.notifications.find((n) => n.message.includes(childId)),
    questionCalls: () => state.questionCalls,
    logs: () => state.logs,
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
      return (await oneNotice(() => harness.fireEvent(event)))[0];
    },
    /**
     * Settle a child and hand back the single notice the parent received.
     * Ends the turn the way the host does — see settle.
     */    async settledNotice(id) {
      return (await oneNotice(() => harness.settle(id)))[0].message;
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
    trySpawn(args, ctx = { sessionID: "p1" }) {
      return harness.tool.dynamic_task.execute(args, ctx);
    },
    /**
     * Spawn one child. Returns the id, the spawn confirmation, and the child's
     * bound tools — binding here means a test never restates which session it
     * is talking about, and it cannot bind the wrong one.
     */
    async spawn(args = {}, ctx = { sessionID: "p1" }) {
      const out = await harness.tool.dynamic_task.execute(
        { description: "bg task", subagent_type: "explore", prompt: "Return DONE", ...args },
        ctx,
      );
      const id = extractSessionId(out);
      if (id) spawned.push(id);
      return { out, id, c: bindChild(harness, id, args, ctx) };
    },
    /**
     * A child that already exists, with its tools bound to it. Every test in a
     * tool suite drives SOME child's tool, so the (tool, session_id, ctx)
     * triple is the suite's boilerplate — binding it once here is why no test
     * restates which session it is talking about. Use withChild() to spawn one.
     */
    child(id, args = {}, ctx = { sessionID: "p1" }) {
      return bindChild(harness, id, args, ctx);
    },
  };
  liveHarnesses.push(harness);
  return harness;
}

/**
 * The tools of a child session, bound. `id` may be null for a child that does
 * not exist yet (a steer that revives a settled turn, a list) — the binding is
 * lazy so the handle is usable either way.
 */
function bindChild(harness, id, spawnArgs = {}, ctx = { sessionID: "p1" }) {
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
 * Boot the plugin, spawn one child, and return the pair a tool test needs.
 * This is the suite's standard arrangement, so it is declared once here rather
 * than forty times as boot-then-spawn.
 */
export async function withChild({ harness = {}, spawn = {}, ctx = { sessionID: "p1" } } = {}) {
  const h = await setupHarness(harness);
  const { id, out, c } = await h.spawn(spawn, ctx);
  return { h, c, id, out };
}

/** `withChild` plus one step, for the arrangements that are this one and then something. */
async function withChildThen(step, opts) {
  const child = await withChild(opts);
  await step(child.h, child.id);
  return child;
}

/**
 * Boot, spawn one child, and settle it — the precondition for reading a
 * child's settled state. Naming it keeps a test from spelling out the same
 * three steps to ask the same question.
 */
export async function withSettledChild(opts = {}) {
  return withChildThen((h, id) => h.settle(id), opts);
}

/**
 * Boot, spawn one child, and have the host ask it a question — the arrangement
 * every question-gate case starts from.
 *
 * Named because the preamble is load-bearing: the ask must reach the gate under
 * the session id the child was dispatched with, and a case that hand-rolled it
 * could use a different one without noticing. A gate that never sees the ask
 * never answers it, so the ask is part of the setup, not the test.
 */
export async function withAskedChild(questionId, ...options) {
  return withChildThen((h, id) => h.fireEvent(events.ask(id, questionId, ...options)));
}

/**
 * Boot, spawn, settle, and run `body` with debug logging on, handing it the
 * child's debug log — the arrangement every "this must reach the log" assertion
 * needs.
 *
 * A callback, not a handle, and that is the whole point: `debugLog` gates on
 * DYNAMIC_TASK_DEBUG at CALL time, so a fixture that enabled it only for boot
 * would hand back a log that is frozen at the registration line. Every event
 * after the setup — which is every event a log assertion is actually about —
 * would be silently dropped, and an assertion against that log passes against
 * silence. A fixture that cannot outlive its own setup is a fixture that
 * manufactures the failure it is meant to detect.
 *
 * Named because the alternative is four steps (a temp project dir, debug
 * enabled, a settled child, then the log) re-derived per test — and the log path
 * is easy to get subtly wrong. A path that matches nothing reads as an EMPTY
 * log, which is indistinguishable from a gate that logged nothing at all. The
 * derivation belongs next to the debug writer that creates the path, not in
 * each of its readers.
 */
export async function withLoggedChild({ hooks = {} } = {}, body) {
  const directory = tmpProjectDir();
  return withEnv("DYNAMIC_TASK_DEBUG", "1", async () => {
    const { h, c, id, out } = await withSettledChild({ harness: { hooks, directory } });
    return body({
      h,
      c,
      id,
      out,
      directory,
      /** The child's debug log, as the operator would read it. */
      log: () => readFileSync(getDebugLogPath("p1", id), "utf8"),
    });
  });
}

/**
 * Boot the plugin and spawn a two-level dispatch tree: a child, and a
 * grandchild that child spawned.
 *
 * Two levels is the deepest tree reachable — lineage accumulates every
 * ancestor's agent NAME and no agent may appear twice, so a chain is bounded by
 * the number of agent types, and the types alternate here for the same reason.
 * Declared once because the fleet views and the subtree stop ask about the same
 * tree, and two copies of "the tree" would be two different trees.
 */
export async function withDispatchTree(harness = {}) {
  const h = await setupHarness(harness);
  const child = await h.spawn({ description: "child task" });
  const grandchild = await h.spawn(
    { description: "grandchild task", subagent_type: "general" },
    { sessionID: child.id },
  );
  return { h, child, grandchild };
}

/**
 * As withDispatchTree, with the grandchild already finished — the shape both
 * the stop and the view have to answer for (a finished node in a running tree).
 */
export async function withSettledDispatchTree(harness = {}) {
  const tree = await withDispatchTree(harness);
  await tree.h.settle(tree.grandchild.id);
  return tree;
}

/**
 * task_result for a spawned child whose message read returns exactly
 * `messages`. Liveness is a question about what a child has written, so a test
 * that asks it is one line of arrangement and one expectation.
 */
export async function resultForChild(messages, opts = {}) {
  return readForChild(() => messages, opts);
}

/** As resultForChild, for the child whose message read itself fails. */
export async function resultForUnreadableChild(error = new Error("boom"), opts = {}) {
  return readForChild(() => {
    throw error;
  }, opts);
}

async function readForChild(messages, opts) {
  const { c } = await withChild({
    ...opts,
    harness: { ...opts.harness, hooks: { ...opts.harness?.hooks, messages } },
  });
  return c.result();
}

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
  }
});

/**
 * The two-turn harness the claim-order/revival tests share: the message stream
 * names each turn's output, and the FIRST parent notification fails so the
 * gate's retry lands inside the test's timing window.
 */
export async function setupTwoTurnHarness() {
  let msgCalls = 0;
  const harness = await setupHarness({
    hooks: {
      messages: () => {
        msgCalls++;
        const text = msgCalls === 1 ? "TURN-ONE-OUTPUT" : "TURN-TWO-OUTPUT";
        return [unclockedSaid(text, ASSISTANT_ROLE)];
      },
    },
  });
  const origPrompt = harness.client.session.prompt;
  let parentNotifies = 0;
  harness.client.session.prompt = (args) => {
    if (isParentNotification(promptText(args))) {
      parentNotifies++;
      if (parentNotifies === 1) return Promise.reject(new Error("parent busy"));
    }
    return origPrompt(args);
  };
  return harness;
}

/**
 * A host theme, for the screens that resolve their design tokens from one.
 *
 * The host derives `text` from the TERMINAL's own `defaultForeground` and `textMuted`
 * from a gray scale over the terminal background, so these are a dark terminal's
 * foreground and one step of gray below it — the values that actually occur, rather than
 * a theme shaped to suit an assertion. A case that wants a LIGHT theme builds one with
 * `lightTheme` rather than editing this, because the point of the tokens is that they
 * follow the theme and a case cannot prove that against a constant.
 */
export const darkTheme = () => ({
  current: {
    text: RGBA.fromInts(0xd0, 0xd0, 0xd0),
    textMuted: RGBA.fromInts(0x6c, 0x6c, 0x6c),
    accent: RGBA.fromInts(0x88, 0x88, 0xff),
  },
  mode: () => "dark",
});

/** The same shape, inverted — what a light terminal hands the host. */
export const lightTheme = () => ({
  current: {
    text: RGBA.fromInts(0x20, 0x20, 0x20),
    textMuted: RGBA.fromInts(0x90, 0x90, 0x90),
    accent: RGBA.fromInts(0x33, 0x33, 0xcc),
  },
  mode: () => "light",
});
import { RGBA } from "@opentui/core";
