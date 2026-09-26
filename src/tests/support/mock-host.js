/**
 * The fake OpenCode server — everything this suite is allowed to assert about the
 * host, in one place.
 *
 * Split from `harness.js` along the client interface: this module IS the host
 * (its transcript shapes, its event vocabulary, its status map, its SDK envelope,
 * its refusals), and `harness.js` is the driver that boots the REAL plugin against
 * it. The boundary matters because the two fail in opposite ways. A lie told here
 * certifies a host that does not exist, so every shape below is the server's own
 * and the mock refuses the wrong ones; a fixture told here would instead
 * manufacture the failure it exists to detect.
 *
 * Ground truth, not test doubles of the thing under test (Tenet 12): nothing in
 * this file is a stand-in for plugin code. Only the host is faked, because the
 * server is not what these suites are about.
 */

import assert from "node:assert";
// The role the reader looks for, named by the module that looks for it. A mock
// message part that hardcodes the role is a message the plugin may correctly
// ignore, and a test that builds one still passes.
import { ASSISTANT_ROLE } from "../../../dist/shared/prompt.js";
import { isParentNotification } from "../../../dist/shared/notify.js";
// The host's event vocabulary is PRODUCTION's, not the suite's. Every name below
// is `satisfies Event["type"]` in host-events.ts, so this module cannot fire an
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

/**
 * An assistant turn as the HOST's transcript carries one: `info` holding the
 * clock, parts beside it. The liveness reader takes an age from `info.time`, and
 * getting this shape wrong does not crash — it renders as "this child has never
 * written a message", which is what a live smoke test caught on a child that had
 * written three. So the shape is stated once, here, and the mock that answers a
 * transcript read and the cases that seed one both read it from here.
 */
export const hostSaid = (text, at = Date.now()) => ({
  info: { role: ASSISTANT_ROLE, time: { created: at, completed: at } },
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
 * The message fixtures beside it carry the second half of the same lesson: a
 * message is `{ info, parts }`, with the role and the clock on `info`. A mock
 * that put `time` on the item made a finished child read as "(none yet)".
 */
export const SDK_ENVELOPE = (data) => ({ data, request: {}, response: { status: 200 } });

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
export function armGate(state, name, { fails = false } = {}) {
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
export const putHostStatus = (state, id, type) => state.hostStatus.set(id, hostWord(type));

/**
 * The one place the mock MOVES a session's host status word: an abort parks the
 * turn, a prompt starts it — the same two transitions the server makes, from the
 * same two calls, so a read that consults the map sees what the plugin's own
 * calls would have caused. Word only, never an event: the event a real server
 * sends is the plugin's to react to, and a test that delivers it says so. The
 * guard is what makes this a MOVE: a session the host no longer lists must not
 * come back from a status write.
 */
export function setHostTurn(state, id, type) {
  if (state.hostStatus.has(id)) putHostStatus(state, id, type);
}

/**
 * Fold a delivered event into the host's status map, the way the server keeps
 * it. Terminal events are the ones that move a session to another word: the
 * idle event and the status channel's own word both park it, an error marks it
 * failed, a deletion drops it from the map entirely. Every other event is
 * motion — it moves the clock the map's `at` reads, and nothing else.
 */
export function applyHostStatus(state, event) {
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
 * The text one prompt body carries, with the parts envelope stripped. Tolerant of a
 * body carrying no text part, because the two readers that classify a prompt by its
 * marker run before anything knows the body has parts at all — a strict reader there
 * throws inside a mock instead of reporting the prompt as not-a-notification.
 */
export const promptText = (args) => args?.body?.parts?.[0]?.text || "";

/**
 * The ONE "this session is gone" error the mock transport reports. Three
 * conditions produce it — a session the host never had, a test-declared failure
 * id, and a gate released with `fails` — and they share the message on purpose:
 * a test asserting what the transport said must not be able to tell which
 * scenario it hit, because what the server says is the contract and the
 * condition is only the story that produces it. Spelled three times, the message
 * was three chances to drift away from the server's own wording.
 */
const sessionNotFound = (id) => new Error(`Session "${id}" not found.`);

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
 * in `harness.js` are what isolate it (production never resets anything).
 */
export function createMockClient(hooks = {}) {
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
      // session.prompt routes by marker: parent notifications carry the tag
      // production's own isParentNotification recognises; everything else is
      // child work.
      prompt: (args) => {
        const { path, body } = args;
        const text = promptText(args);
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
        if (isParentNotification(text)) {
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

/**
 * The host's agent list, as a case needs it: one dispatchable agent declaring
 * exactly the tools it provisions to its children. Owned here rather than in a
 * suite because the tools map is a fact about the HOST, and a suite that wrote
 * one would be the second place that shape is spelled.
 */
export const agentDeclaring = (tools) => [{ name: "explore", mode: "subagent", tools }];
