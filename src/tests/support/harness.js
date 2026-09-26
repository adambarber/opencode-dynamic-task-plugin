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
 * handler. Only the *host* (the OpenCode server) is faked, because the server
 * is not what these suites are about.
 */

import assert from "node:assert";
import { mkdtempSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "node:test";
import { resetAgentCache } from "../../../dist/shared/admission.js";
import { clearNotifyLedger } from "../../../dist/shared/notify.js";
import { shrinkBoundsForTesting } from "../../../dist/shared/execution-bound.js";
// The host's event vocabulary is PRODUCTION's, not the suite's. Every name below
// is `satisfies Event["type"]` in host-events.ts, so the harness cannot fire an
// event the host does not publish — which is the one thing a fixture must never
// be able to do, because a fixture that invents an event certifies a gate that
// listens for it. That is exactly how `question.created` shipped. The names are
// used to BUILD events (the `events` factory below) rather than re-exported as a
// second list: a suite that named a raw event type would be naming it from a
// hand-kept copy of this import, which is the drift the import exists to prevent.
import {
  QUESTION_ASKED,
  QUESTION_REJECTED,
  QUESTION_REPLIED,
  SESSION_DELETED,
  SESSION_ERROR,
  SESSION_IDLE,
  SESSION_STATUS,
} from "../../../dist/shared/host-events.js";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An assistant turn as the HOST's transcript carries one: `info` holding the
 * clock, parts beside it. The liveness reader takes an age from `info.time`, and
 * getting this shape wrong does not crash — it renders as "this child has never
 * written a message", which is what a live smoke test caught on a child that had
 * written three. So the shape is stated once, here, and the mock that answers a
 * transcript read and the cases that seed one both read it from here.
 */
export const hostSaid = (text, at = Date.now()) => ({
  info: { role: "assistant", time: { created: at, completed: at } },
  parts: [{ type: "text", text }],
});

/** The same turn carrying no clock at all — what a plugin booted mid-turn sees. */
export const unclockedSaid = (text = "go", role = "user") => ({
  ...hostSaid(text),
  info: { role },
});

/**
 * The host's sync session.updated envelope. `status` is the word it reports, or
 * the error object it reports instead — the one field those two spellings
 * disagree on, and the field a terminal verdict reads. The address rides
 * separately, so a case about the shape alone has no session to invent.
 */
export const sessionUpdatedEnvelope = (status) => ({
  type: "sync",
  name: "session.updated.1",
  data: { info: { status } },
});

/**
 * Refuse a question settlement the host would not accept. Derived from the SDK's
 * QuestionReplyData/QuestionRejectData: the path key is `requestID` (verified
 * against opencode 1.18.30, which serves /question/{requestID}/reply and no
 * {id} route), a reply body is `answers` — one entry per asked question, each a
 * list of chosen labels — and the reject body is `never`. Asserting the contract
 * HERE is what makes the harness a check on the plugin's host calls, not just a
 * record of them.
 */
function assertQuestionSettlement(method, path, body, { carriesAnswers }) {
  assert.ok(
    path !== null && typeof path === "object" && typeof path.requestID === "string",
    `${method} must address /question/{requestID} — path.requestID, not path.id (got ${JSON.stringify(path)})`,
  );
  if (!carriesAnswers) {
    assert.strictEqual(
      body,
      undefined,
      `the reject endpoint declares body?: never — no reason can reach the asking session (got ${JSON.stringify(body)})`,
    );
    return;
  }
  assert.ok(
    body !== null && typeof body === "object" && Array.isArray(body.answers),
    `${method} must send body.answers (got ${JSON.stringify(body)})`,
  );
  assert.ok(
    body.answers.every((answer) => Array.isArray(answer) && answer.every((label) => typeof label === "string")),
    `each entry of body.answers is a list of labels, not a bare string (got ${JSON.stringify(body.answers)})`,
  );
}

/**
 * One of the two question endpoints, as the host's own contract makes them: the
 * route is /question/{requestID} (`path.requestID`, not `path.id`), a reply
 * carries `answers`, and a reject carries no body at all. A mock that accepts any
 * shape is exactly what let four wrong field names (`path.id`, `body.answer`, a
 * reject body) pass as a green suite, so this one refuses them the way a real
 * host would, and records the call the plugin actually made.
 */
const questionEndpoint = (state, hooks, { method, carriesAnswers, throws: throwHook }) =>
  async ({ path, body }) => {
    if (hooks[throwHook]) throw new Error(`${method} failed`);
    assertQuestionSettlement(method, path, body, { carriesAnswers });
    state.questionCalls.push({
      method,
      requestID: path.requestID,
      ...(carriesAnswers ? { answers: body.answers } : {}),
    });
    return { ok: true };
  };

/**
 * The envelope the real SDK client resolves every call to: its `responseStyle`
 * default is "fields", so a call resolves to `{ data, request, response }` and
 * never to the bare payload.
 *
 * This harness used to hand back bare payloads, and that was a defect in the
 * test double rather than a convenience: a reader that looks for a field one
 * level too high finds *nothing* instead of throwing, so the mocks let a whole
 * class of production bug through — the status read answered "no session" for
 * every child while the suite stayed green. Mocking the shape the code meets in
 * production is the only version of this mock that proves anything.
 *
 * The message fixtures inside it carry the second half of the same lesson: a
 * message is `{ info, parts }`, with the role and the clock on `info`. A mock
 * that put `time` on the item made a finished child read as "(none yet)".
 */
export const SDK_ENVELOPE = (data) => ({ data, request: {}, response: { status: 200 } });

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

/** A promise plus its resolver — the gate tests use to hold a reply open. */
export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

/**
 * Arm one host call open, the way every gated call is armed. The mock consults
 * `state[name]`, the test holds the release: one shape, so a new gate cannot
 * invent its own protocol with the mock.
 */
function armGate(state, name, { fails = false } = {}) {
  const gate = deferred();
  state[name] = { promise: gate.promise, used: false, fails, release: gate.resolve };
  return { release: () => gate.resolve() };
}

/**
 * What an entry in the host's status map IS: the word the host published and
 * the clock it published it at. Declared once because the map is read by
 * liveness code as "when did this session last change", and a second way of
 * spelling an entry is a second answer to that question.
 */
const hostWord = (type) => ({ type, at: Date.now() });

/** Put an entry in the host's status map, creating it for a session the host does not yet list. */
const putHostStatus = (state, id, type) => state.hostStatus.set(id, hostWord(type));

/**
 * The one place the mock MOVES a session's host status word: an abort parks the
 * turn, a prompt starts it — the same two transitions the server makes, from
 * the same two calls, so a read that consults the map sees what the plugin's own
 * calls would have caused. Word only, never an event: the event a real server
 * sends is the plugin's to react to, and a test that delivers it says so. The
 * guard is what makes this a MOVE: a session the host no longer lists must not
 * come back from a status write.
 */
function setHostTurn(state, id, type) {
  if (state.hostStatus.has(id)) putHostStatus(state, id, type);
}

/**
 * Fold a delivered event into the host's status map, the way the server keeps
 * it. Terminal events are the ones that move a session to another word: the
 * idle event and the status channel's own word both park it, an error marks it
 * failed, a deletion drops it from the map entirely. Every other event is
 * motion — it moves the clock the map's `at` reads, and nothing else.
 */
function applyHostStatus(state, event) {
  if (typeof event !== "object" || event === null) return;
  const id = event.properties?.sessionID;
  if (typeof id !== "string") return;
  const current = state.hostStatus.get(id);
  if (event.type === SESSION_DELETED) {
    state.hostStatus.delete(id);
    return;
  }
  if (!current) return;
  const status = event.properties?.status;
  const word = typeof status === "string" ? status : status?.type;
  if (event.type === SESSION_ERROR) {
    setHostTurn(state, id, "error");
  } else if (event.type === SESSION_IDLE || (event.type === SESSION_STATUS && word)) {
    // The idle event carries no word of its own — the event's name IS the word.
    setHostTurn(state, id, event.type === SESSION_IDLE ? "idle" : word);
  } else if (current.type === "busy") {
    setHostTurn(state, id, "busy");
  }
}

/**
 * Harness state must live in a fresh temp project dir, never CWD or a shared
 * path — see the ledger-scoping regression suite.
 */
export function tmpProjectDir() {
  return mkdtempSync(join(tmpdir(), `dt-harness-${Date.now()}-${Math.floor(Math.random() * 1e6)}-`));
}

/**
 * A host event envelope: the type the server names, the session it is about, and
 * whatever else it carries. The server's lifecycle event shapes below are all
 * this, and tests used to spell the literals inline, which is how a test can end
 * up asserting against a shape the host never emits.
 */
const hostEvent = (type, id, properties) => ({ type, properties: { sessionID: id, ...properties } });

/**
 * The server's lifecycle event shapes, declared once. `updated` and `error` take
 * the inner status so one declaration covers both the plain and error-valued
 * payloads.
 */
export const events = {
  /**
   * `properties` rides through so a test can reproduce a slimmer host payload
   * (`events.idle(id, {})`) when the absence of a field is the point.
   */
  idle: (id, properties = { status: "idle" }) => hostEvent(SESSION_IDLE, id, properties),
  // The host's status channel, in the host's own nested spelling
  // (`status: {type}`), not the string shorthand it used to be declared with.
  status: (id, status = "idle") => hostEvent(SESSION_STATUS, id, { status: { type: status } }),
  /**
   * A turn at work: the host saying this session is running. It is the first
   * event a replacement turn produces, and therefore the life sign that lets
   * that turn's ending be attributed to it rather than to the turn it replaced.
   */
  working: (id) => events.status(id, "busy"),
  // A sync update. `status` is the string, or the host's error object.
  updated: (id, status = "idle") => ({
    ...sessionUpdatedEnvelope(status),
    properties: { sessionID: id },
  }),
  errorUpdate: (id) => events.updated(id, { type: "error" }),
  deleted: (id, properties = {}) => hostEvent(SESSION_DELETED, id, properties),
  // EventSessionError carries an error detail, never a status field.
  error: (id, error) => ({
    type: SESSION_ERROR,
    properties: { sessionID: id, ...(error ? { error } : {}) },
  }),
  /**
   * A question the child asked. `answers: []` is the answerless variant; an
   * absent `sessionID` is the unowned question, which the gate must ignore.
   * A question carries `id`, or `request_id`, or both — the identity the host
   * used is part of the shape, so pass whichever the test is about.
   */
  /**
   * The shape opencode 1.18.30 publishes. Verified against the server binary:
   * it emits `question.asked` (never `question.created`), and an asked question
   * carries `questions: QuestionInfo[]` — the suggestions live on each question's
   * `options`, not on an `answers` field, which belongs to the REPLY event.
   * A mock that invents a different shape certifies a host that does not exist,
   * so the fixture is the host's own shape verbatim.
   */
  questionAsked: (sessionID, properties) => ({
    type: QUESTION_ASKED,
    properties: { ...(sessionID ? { sessionID } : {}), ...properties },
  }),
  /** A question the host published, spelled as the SDK types it. */
  hostQuestion: (text, options) => ({
    question: text,
    header: "Question",
    options: options.map((label) => ({ label })),
  }),
  /**
   * The host asking one question, the way it asks. Every question-gate test
   * needs this composition, and each one spelled out its own — which is how five
   * copies of the same event drifted into five slightly different fixtures. The
   * options are the host's QuestionOption[]: the suggestion lives on the option's
   * label, never on a top-level answers field.
   */
  ask: (sessionID, questionId, ...options) =>
    events.questionAsked(sessionID, { id: questionId, questions: [events.hostQuestion("Ship it?", options)] }),
  /** The reply that retires a question — the host spells the id `requestID`. */
  questionReplied: (props) => ({ type: QUESTION_REPLIED, properties: props }),
  questionRejected: (props) => ({ type: QUESTION_REJECTED, properties: props }),
};

/**
 * The production-shaped mock host.
 *
 * hooks: {
 *   createThrowsOnce?: boolean,
 *   promptFailIds?: Set<string>,         // async rejections
 *   promptHangIds?: Set<string>,         // never-settling prompts (non-blocking proof)
 *   promptSyncThrowIds?: Set<string>,    // synchronous throws
 *   abortThrowsOnce?: boolean,
 *   abortFailIds?: Set<string>,
 *   statusThrows?: Error,               // the status channel itself is down
 *   hostStatusSeed?: Record<string, "busy" | "idle">,  // live at boot, before any event
 *   messages?: (args: { path: { id: string } }) => unknown,
 *   questionReplyThrows?: boolean,
 *   questionRejectThrows?: boolean,
 *   agentsList?: unknown[],
 * }
 * Hook sets are read live: mutate them after setup to arm later phases.
 *
 * Session ids are per-host and numbered from 1, so a test can name
 * `ses_mock_1` and be sure it is the first child it created. They repeat
 * across hosts on purpose: the notify ledger is process-global, and the resets
 * below are what isolate it (production never resets anything).
 */
export /**
 * The ONE "this session is gone" error the mock transport reports. Three
 * conditions produce it — a session the host never had, a test-declared failure
 * id, and a gate released with `fails` — and they share the message on purpose:
 * a test asserting what the transport said must not be able to tell which
 * scenario it hit, because what the server says is the contract and the
 * condition is only the story that produces it. Spelled three times, the message
 * was three chances to drift away from the server's own wording.
 */
const sessionNotFound = (id) => new Error(`Session "${id}" not found.`);

function createMockClient(hooks = {}) {
  const state = {
    sessions: new Set(),
    notifications: [],
    // Every notification the plugin DIALS, held or not — the count that proves
    // a held write was never retried behind the parent's back.
    notifyCalls: [],
    // Sessions whose transcript refuses to be read.
    unreadable: new Set(),
    logs: [],
    aborted: [],
    questionCalls: [],
    promptBodies: [],
    sessionBodies: new Map(),
    createThrown: false,
    // How many times the host's status channel was read. Views that already
    // know what they need must not spend a read per row.
    statusReads: 0,
    abortThrown: false,
    notifyAttempts: 0,
    childPromptFailed: false,
    abortGate: null,
    promptGate: null,
    messageReadGate: null,
    // The host's status map, shaped as the server holds it: every live
    // session, with the host's own three words. Derived from the events a test
    // delivers (a spawned session is busy, a turn's ending makes it idle, a
    // deletion removes it), so a read that consults it exercises the same
    // sequence the server would have produced. `at` is when the status last
    // changed — the clock behind the child's last-message time.
    hostStatus: new Map(),
  };

  // Sessions the host already knows about when the test starts, for boot-time
  // work that must read the status map BEFORE any event has been delivered
  // (reconciling what the last process left running). A seeded session exists
  // by definition — a session in the host's map is a session it lists.
  for (const [id, type] of Object.entries(hooks.hostStatusSeed ?? {})) {
    state.sessions.add(id);
    putHostStatus(state, id, type);
  }

  return {
    _state: state,
    app: {
      agents: async () => SDK_ENVELOPE(hooks.agentsList ?? [
        { name: "explore", mode: "subagent" },
        { name: "general", mode: "subagent" },
      ]),
      log: async ({ body }) => {
        state.logs.push(body);
      },
    },
    // The question namespace, modelled on the host's generated contract rather
    // than on whatever the plugin happened to send. A mock that accepts any
    // shape is exactly what let four wrong field names (`path.id`, `body.answer`,
    // a reject body) pass as a green suite, so this one refuses them the way a
    // real host would: the route is /question/{requestID}, a reply carries
    // `answers: Array<QuestionAnswer>`, and a reject carries no body at all.
    question: {
      reply: questionEndpoint(state, hooks, { method: "reply", carriesAnswers: true, throws: "questionReplyThrows" }),
      reject: questionEndpoint(state, hooks, { method: "reject", carriesAnswers: false, throws: "questionRejectThrows" }),
    },
    session: {
      create: async ({ body }) => {
        if (hooks.createThrowsOnce && !state.createThrown) {
          state.createThrown = true;
          throw new Error("create failed");
        }
        const id = `ses_mock_${state.sessions.size + 1}`;
        state.sessions.add(id);
        state.hostStatus.set(id, { type: "busy", at: Date.now() });
        state.sessionBodies.set(id, body);
        return SDK_ENVELOPE({ id });
      },
      // session.prompt routes by marker: parent notifications carry
      // [dynamic-task-notify] / [dynamic-task-notice]; everything else is
      // child work.
      prompt: ({ path, body }) => {
        // The prompt gate: the next child prompt parks here until the test
        // releases it, then fails non-retryably. A turn's own prompt delivery
        // failing is the one settlement that can still land while a steer
        // waits on its abort, so this is how a steer is raced against it.
        if (state.promptGate && !state.promptGate.used) {
          state.promptGate.used = true;
          return state.promptGate.promise.then(() => {
            throw new Error("prompt rejected by the provider");
          });
        }
        if (hooks.promptSyncThrowIds?.has(path.id)) {
          throw new Error(`prompt sync-dead for ${path.id}`);
        }
        if (hooks.promptHangIds?.has(path.id)) {
          return new Promise(() => {});
        }
        if (hooks.promptFailIds?.has(path.id)) {
          return Promise.reject(new Error(`prompt failed for ${path.id}`));
        }
        const text = body?.parts?.[0]?.text || "";
        const isNotify =
          text.includes("[dynamic-task-notify]") || text.includes("[dynamic-task-notice]");
        if (isNotify) {
          // The delivery transport for THIS notification, as a plan rather
          // than an override: a test states what the transport does, never how
          // the plugin reaches it.
          const plan = hooks.notifyTransport;
          state.notifyCalls.push(text);
          if (plan) {
            // An unrecognised plan is a FALSE GREEN, not a no-op. A mistyped
            // plan key is silently ignored, the write takes the success path,
            // and the test asserts against a delivery the host never performed
            // — observed live 2026-09-26, where `hold` (a plan that did not
            // exist yet) made a held-write test pass while the real behaviour
            // was the failure it existed to catch. So the vocabulary is
            // closed here: adding a plan means teaching the harness its shape.
            const PLANS = ["hang", "hold", "failTimes"];
            for (const key of Object.keys(plan)) {
              if (!PLANS.includes(key)) {
                throw new Error(
                  `unknown notifyTransport plan "${key}" — known: ${PLANS.join(", ")}`,
                );
              }
            }
          }
          if (plan?.hold) {
            // The live shape of a held write, observed 2026-09-26: the host
            // puts the notification in the parent's context AND leaves the
            // request open — delivery and acknowledgement are independent, and
            // the promise can outlive the message by minutes. Modelling a hold
            // as "not delivered" (see `hang`, below) is what let the child be
            // told its message was not sent while the parent had read it.
            state.notifications.push({ to: path.id, message: text });
            return plan.hold;
          }
          if (plan?.hang) return plan.hang;
          if (plan?.failTimes && ++state.notifyAttempts <= plan.failTimes) {
            return Promise.reject(new Error("parent notify failed"));
          }
          state.notifications.push({ to: path.id, message: text });
        } else {
          if (hooks.childPromptFailOnce && !state.childPromptFailed) {
            state.childPromptFailed = true;
            return Promise.reject(
              Object.assign(new Error(hooks.childPromptFailOnce.message), {
                code: hooks.childPromptFailOnce.code,
              }),
            );
          }
          state.promptBodies.push({ to: path.id, body });
        }
        return Promise.resolve({ parts: [{ type: "text", text: "PROMPT_OK" }] });
      },
      // The server's status channel: a map of every session with a turn the
      // host knows about. A session absent from it has no turn running.
      //
      // Counted, because a read that fans out into one call per task turns a
      // fleet view into a burst of transport against a host that answers the
      // whole fleet in one. The count is the only proof a view did not do it.
      status: async () => {
        state.statusReads += 1;
        if (hooks.statusThrows) throw hooks.statusThrows;
        return SDK_ENVELOPE(
          Object.fromEntries([...state.hostStatus].map(([id, entry]) => [id, { type: entry.type }])),
        );
      },
      messages: async ({ path }) => {
        if (state.messageReadGate?.used) {
          state.messageReadGate.used = true;
          await state.messageReadGate.promise;
        }
        if (state.unreadable.has(path.id)) {
          const error = new Error(`Session "${path.id}" transcript unavailable.`);
          error.status = 500;
          throw error;
        }
        if (hooks.messages) return SDK_ENVELOPE(hooks.messages({ path }));
        if (!state.sessions.has(path.id)) {
          const error = new Error(`Session "${path.id}" not found.`);
          error.status = 404;
          throw error;
        }
        return SDK_ENVELOPE([hostSaid("COMPLETED_OK", state.hostStatus.get(path.id)?.at ?? Date.now())]);
      },
      // No session.get: the plugin does not call it. It was here to back the
      // status guess this mock also once invented a status field for — both are
      // gone, and a mock surface nobody calls is a lie waiting to mislead.
      abort: async ({ path }) => {
        if (hooks.abortThrowsOnce && !state.abortThrown) {
          state.abortThrown = true;
          throw new Error("abort failed");
        }
        if (hooks.abortThrows) {
          // The message is what a test will assert it saw, so the plan carries
          // it rather than the test reaching in to normalize it.
          throw new Error(hooks.abortThrows === true ? "abort transport is down" : hooks.abortThrows);
        }
        // "The server has no such session" has two causes here, and the host
        // cannot tell them apart: an id the harness never created, and an id whose
        // abort is scripted to come back that way. One predicate, so a case that
        // scripts a failing abort gets the same 404 shape as a case that names a
        // session that was never there.
        const serverLostIt = (id) => !state.sessions.has(id) || Boolean(hooks.abortFailIds?.has(id));
        if (serverLostIt(path.id)) {
          throw sessionNotFound(path.id);
        }
        // The abort gate: the first abort parks here until the test releases
        // it, so a racing call can be arranged without monkey-patching. With
        // `fails`, the released abort reports the session as gone — the race
        // outcome the settlement path must survive.
        if (state.abortGate && !state.abortGate.used) {
          state.abortGate.used = true;
          await state.abortGate.promise;
          if (state.abortGate.fails) {
            throw sessionNotFound(path.id);
          }
        }
        state.aborted.push(path.id);
        setHostTurn(state, path.id, "idle");
        return { ok: true };
      },
    },
    // Hold the next abort open. Returns the release, awaited by the test.
    gateAbort(opts) {
      return armGate(state, "abortGate", opts);
    },
    // Hold the next child prompt open; the released prompt fails
    // non-retryably, which settles the task through the prompt-failure path.
    gateChildPrompt(opts) {
      return armGate(state, "promptGate", opts);
    },
    // Hold the next transcript read open. A real host can leave a read hanging,
    // and a settlement that quotes the child must not hang with it.
    gateMessageRead(opts) {
      return armGate(state, "messageReadGate", opts);
    },
    // Make this session's transcript refuse to be read, the way a real read
    // fails. A settlement that could not quote the child must say so.
    makeUnreadable(sessionId) {
      state.unreadable.add(sessionId);
    },
  };
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

/** The text one prompt body carries, with the parts envelope stripped. */
export const promptText = (body) => body.body.parts[0].text;

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
      log: () => readFileSync(join(directory, ".dynamic-task-logs", `parent-p1__child-${id}.log`), "utf8"),
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
        return [unclockedSaid(text, "assistant")];
      },
    },
  });
  const origPrompt = harness.client.session.prompt;
  let parentNotifies = 0;
  harness.client.session.prompt = (args) => {
    const text = args.body?.parts?.[0]?.text || "";
    if (text.includes("[dynamic-task-notify]") || text.includes("[dynamic-task-notice]")) {
      parentNotifies++;
      if (parentNotifies === 1) return Promise.reject(new Error("parent busy"));
    }
    return origPrompt(args);
  };
  return harness;
}
