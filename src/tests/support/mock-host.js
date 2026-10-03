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

import { readFileSync } from "node:fs";
import { FAULTS, armFault, armHookFaults, armedFlag, armedHostFault, fault, forId, neverAnswers } from "./faults.js";
// The host's status vocabulary and not-found spelling, parsed out of the SDK
// declaration the production code compiles against — so the fake is held to the
// host's own words rather than to a hand-kept list that drifts in the one
// direction which hides a defect.
import { missingSessionError, hostOutcomeWords } from "./sdk-contract.js";
// The role the reader looks for, named by the module that looks for it. A mock
// message part that hardcodes the role is a message the plugin may correctly
// ignore, and a test that builds one still passes.
import { ASSISTANT_ROLE } from "../../../dist/shared/prompt.js";
import { isParentNotification, notificationKindOf } from "../../../dist/shared/notification-text.js";
// The host's event vocabulary is PRODUCTION's, not the suite's. Every name below
// is `satisfies Event["type"]` in host-events.ts, so this module cannot fire an
// event the host does not publish — which is the one thing a fixture must never
// be able to do, because a fixture that invents an event certifies a gate that
// listens for it. That is exactly how `question.created` shipped. The names are
// used to BUILD events (the `events` factory below) rather than re-exported as a
// second list: a suite that named a raw event type would be naming it from a
// hand-kept copy of this import, which is the drift the import exists to prevent.
import {
  FORM_CANCELLED,
  PERMISSION_ASKED,
  PERMISSION_REPLIED,
  SESSION_DELETED,
  SESSION_ERROR,
  SESSION_EXECUTION_INTERRUPTED,
  SESSION_EXECUTION_STARTED,
  SESSION_EXECUTION_SUCCEEDED,
  SESSION_IDLE,
} from "../../../dist/shared/host-events.js";

/**
 * An assistant turn as the HOST's transcript carries one: `info` holding the
 * clock, parts beside it. The liveness reader takes an age from `info.time`, and
 * getting this shape wrong does not crash — it renders as "this child has never
 * written a message", which is what a live smoke test caught on a child that had
 * written three. So the shape is stated once, here, and the mock that answers a
 * transcript read and the cases that seed one both read it from here.
 */
const textParts = (text) => [{ type: "text", text }];
// One builder for every assistant message the fake writes: the role and the text
// envelope never vary, only the clock (finished vs still writing) and the caller.
const assistantMessage = (text, time, extra) => ({
  info: { role: ASSISTANT_ROLE, time, ...extra },
  parts: textParts(text),
});
export const hostSaid = (text, at = Date.now(), extra) => assistantMessage(text, { created: at, completed: at }, extra);

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
function assertPermissionReply({ sessionID, requestID, decision }) {
  assert.ok(typeof sessionID === "string", `permission.reply must name the session it answers in (got ${JSON.stringify(sessionID)})`);
  assert.ok(typeof requestID === "string", `permission.reply must address the request by requestID (got ${JSON.stringify(requestID)})`);
  assert.ok(
    PERMISSION_DECISIONS.includes(decision),
    `decision must be one of ${PERMISSION_DECISIONS.join(" | ")} — the host answers a whole request, not one question of it (got ${JSON.stringify(decision)})`,
  );
}

/** v2 answers a permission with one word; literals here mean a typo cannot pass. */
const PERMISSION_DECISIONS = ["once", "always", "reject"];

/**
 * `permission.reply` as v2's contract makes it: flat `{sessionID, requestID,
 * decision}`, and the decision answers the whole request rather than one question
 * of it. A mock that accepts any shape is what let four wrong field names pass as
 * a green suite, so this one refuses them and records the call actually made.
 */
const permissionEndpoint = (state, hooks) =>
  async (args) => {
    const { sessionID, requestID, decision } = args;
    if (hooks.permissionReplyThrows) throw new Error("permission.reply failed");
    assertPermissionReply(args);
    state.permissionCalls.push({ sessionID, requestID, decision });
    return { ok: true };
  };

/**
 * A client whose only method is the parent write, plus the list of writes that
 * actually reached it. Every test in this file needs the same two things — a
 * transport whose answer the test decides, and the count of writes that got
 * there — and they were two hand-written client literals per test, so "dialed
 * exactly once" was answered by whichever literal that test happened to copy. One
 * wrapper, one recording: a test that wants the write to park, to throw, or to
 * note its own ordering says so in `respond`, and the record is the same record.
 */
export function recordingClient(respond) {
  const calls = [];
  const turns = new Map();
  return {
    calls,
    // The same two facts the big fake keeps, written to the same place: a turn running
    // is an assistant message with no `completed`, and its absence from the record is
    // the one thing that reads as "open". A private map here would be a second copy
    // of a fact production reads from the transcript.
    setStatus: (id, word) => {
      turns.set(id, [word === "open" ? hostSaying("") : hostSaid("")]);
    },
    setMessages: (id, list) => turns.set(id, list),
    client: {
      session: {
        context: async (args) => turns.get(args.sessionID) ?? [],
        // Project the message list down to the turn record production reads: no
        // finished message means the host has recorded no verdict, and a finished
        // message's own error/absence of one names how it ended. A session this
        // client has no messages for at all is a NotFound like any other.
        get: async ({ sessionID }) => {
          if (!turns.has(sessionID)) throw missingSessionError();
          const messages = turns.get(sessionID) ?? [];
          const lastAssistant = [...messages].reverse().find((m) => m?.info?.role === "assistant");
          if (!lastAssistant || lastAssistant.info?.time?.completed === undefined) {
            return { id: sessionID, outcome: undefined, time: { created: Date.now() } };
          }
          return {
            id: sessionID,
            outcome: lastAssistant.info?.error ? "failed" : "succeeded",
            time: { created: lastAssistant.info.time.created ?? Date.now(), idle: lastAssistant.info.time.completed },
          };
        },
        prompt: async (args) => {
          calls.push(args);
          return respond(args);
        },
      },
    },
  };
}

/**
 * The SDK envelope every answer arrives in. `refusal` is the second half of the
 * same contract: the SDK does not throw on an API error, it RESOLVES the envelope
 * with an `error` beside a non-2xx status — which is why a fake that can only
 * refuse by throwing cannot express a refusal, and why a case written against it
 * tested the wrong branch.
 */

/** A promise plus its resolver — the gate tests use to hold a reply open. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Arm one host call open, the way every gated call is armed. The mock consults
 * `state[name]`, the test holds the release: one shape, so a new gate cannot
 * invent its own protocol with the mock.
 */
export function armGate(state, name, { fails = false, maybe = false } = {}) {
  const gate = deferred();
  state[name] = { promise: gate.promise, used: false, fails, release: gate.resolve };
  // The gate name is the fault name: one spelling, so the teardown rule needs no
  // translation table between "what a test armed" and "what a branch records".
  armFault(state, name);
  if (maybe) state.maybe.add(name);
  return { release: () => gate.resolve() };
}

/**
 * The host's `session.get` answer: the fields the SDK's `Session` declares
 * required. A fake that answers with `{id}` alone is a fake answering a smaller
 * question than the one production asked, and the missing fields are exactly where
 * a real divergence shows up.
 */
const sessionObject = (id, state) => {
  const turn = state?.turns?.get(id);
  return {
    id,
    projectID: "ses_project_mock",
    directory: "/mock/project",
    title: `mock ${id}`,
    // The turn record, spelled as v2 spells it: `outcome` and `time.idle` appear
    // only once an execution has reached a terminal transition, so a session with
    // a running turn answers with NEITHER and a caller cannot mistake one for the
    // other. This is the field the plugin now reads to decide a turn is open.
    ...(turn?.outcome === undefined ? {} : { outcome: turn.outcome }),
    time: { created: 0, updated: 0, ...(turn?.idle === undefined ? {} : { idle: turn.idle }) },
  };
};

/**
 * What an entry in the host's status map IS: the word the host published and
 * the clock it published it at. Declared once because the map is read by
 * liveness code as "when did this session last change", and a second way of
 * spelling an entry is a second answer to that question.
 */

/**
 * Put an entry in the host's status map — or, for the one word the host answers by
 * DELETING, remove it. It takes the MAP, not the state, so a client of this module with
 * a map of its own obeys this rule instead of copying it. opencode v1.18.30 `session/status.ts` publishes `idle` and
 * drops the key, so a map that could hold `idle` would be a map no read can trust:
 * absence would stop meaning "nothing running" and start meaning two things at once.
 */


/**
 * The one place the mock MOVES a session's host status word: an abort parks the
 * turn, a prompt starts it — the same two transitions the server makes, from the
 * same two calls, so a read that consults the transcript sees what the plugin's own
 * calls would have caused. Word only, never an event: the event a real server
 * sends is the plugin's to react to, and a test that delivers it says so. The
 * guard is what makes this a MOVE: a session the host no longer lists must not
 * come back from a status write.
 */
export function setHostTurn(state, id, word) {
  const verdicts = hostOutcomeWords();
  if (word !== "open" && !verdicts.includes(word)) {
    throw new Error(
      `mock-host: "${word}" is not a v2 turn state (declared: open, ${verdicts.join(", ")}) — the fake may not invent vocabulary`,
    );
  }
  if (word === "open") {
    // No transcript message: a session that has said nothing has no transcript yet,
    // and `context` answers that absence with the COMPLETED_OK fallback. Seeding an
    // empty "saying" message here would shadow the fallback with silence.
    openHostTurn(state, id);
    return;
  }
  state.transcripts.set(id, finishOpenMessage(state.transcripts.get(id) ?? []));
  closeHostTurn(state, id, word);
}

/**
 * The turn word a transcript records, and the one way a delivered terminal event
 * records a turn's FATE.
 *
 * v2 split the old status word in two and that split is load-bearing: `idle` says
 * only that no turn is running, while `succeeded`/`failed` say how the turn ended.
 * Folding them together let `session.idle` APPEND a successful assistant message,
 * so a child whose last real message was an API error was reported as a success —
 * the fake inventing the verdict it was supposed to detect. A terminal event
 * therefore STAMPS the open message rather than adding another: the host finishes
 * the message it was writing.
 */
const stampHostTurn = (state, id, extra) => {
  // Absence is a fact: a session with no transcript reads through the COMPLETED_OK
  // fallback in `context`, which is the mock's standing answer for "what the child
  // said". Manufacturing an empty message here would shadow that fallback with
  // silence, so a completion would notify with no result text.
  if (!state.transcripts.has(id)) return;
  state.transcripts.set(id, finishOpenMessage(state.transcripts.get(id) ?? [], extra));
};

// One closer for the message a finished turn was writing: stamp it completed, or
// append the host's own finished shape when nothing is open. Both turn writers
// (verdict seeding and terminal events) finish the same message, so they share it.
const finishOpenMessage = (have, extra) => {
  const last = have.at(-1);
  const open = last?.info?.role === ASSISTANT_ROLE && last.info.time?.completed === undefined;
  return open
    ? [...have.slice(0, -1), { ...last, info: { ...last.info, time: { ...last.info.time, completed: Date.now() }, ...extra } }]
    : [...have, hostSaid("", undefined, extra)];
};

/**
 * A MESSAGE the host has not finished. One step of a turn, not the turn — a turn is
 * a sequence of these and stays open until the host records a verdict for it.
 */
export const hostSaying = (text, at = Date.now()) => assistantMessage(text, { created: at });

/**
 * The host's TURN record, which is not the transcript.
 *
 * A v2 turn is a SEQUENCE of assistant messages that each carry their own
 * `time.completed`, so "the last message finished" is true for most of a running
 * turn. Measured on a live child: message 7 completed 30s into a 47-minute turn.
 * The turn's own verdict lives on `Session.Info.outcome` and is absent until the
 * execution reaches a terminal transition — so that is what the fake records here,
 * and it is what `session.get` hands production.
 */
const openHostTurn = (state, id) => {
  state.turns.set(id, { outcome: undefined, idle: undefined });
};

const closeHostTurn = (state, id, outcome) => {
  // A closed turn KEEPS its verdict. The host records the outcome of the last
  // completed execution; an event that arrives afterwards for a turn that already
  // ended must not rewrite history, or an interrupt of a finished turn would
  // report the finished work as interrupted.
  if (state.turns.get(id)?.outcome !== undefined) return;
  state.turns.set(id, { outcome, idle: Date.now() });
};

/** The verdict a closing idle implies, read off the transcript it is closing. */
function idleVerdict(state, id) {
  const last = (state.transcripts.get(id) ?? []).at(-1);
  return last?.info?.error ? "failed" : "succeeded";
}

/**
 * Fold a delivered event into the host's own record of the turn, the way the server
 * keeps it. `started` OPENS a turn and adds a message to it — a turn may hold many,
 * and none of them finishing ends it. `idle`/`succeeded`/`interrupted`/`failed`
 * CLOSE it with a verdict. A deletion drops the session's messages entirely.
 */
export function applyHostStatus(state, event) {
  if (typeof event !== "object" || event === null) return;
  const id = event.data?.sessionID;
  if (typeof id !== "string") return;
  if (event.type === SESSION_DELETED) {
    state.transcripts.delete(id);
    return;
  }
  if (event.type === SESSION_EXECUTION_STARTED) {
    // No transcript message: a turn starting says nothing yet, and seeding an empty
    // "saying" message would shadow both the COMPLETED_OK fallback and a test's
    // `hooks.messages` script for what the child actually said.
    openHostTurn(state, id);
  } else if (event.type === SESSION_ERROR) {
    // The event's own error, if it carries one — never a stand-in. Stamping a
    // hardcoded `{message: "failed"}` here would overwrite the transcript's own
    // error detail (the child's real last words) with a word the classifier
    // reads as structural, turning every transient blip into a real failure.
    const carried = event.data?.error;
    stampHostTurn(state, id, carried === undefined ? {} : { error: carried });
    closeHostTurn(state, id, "failed");
  } else if (event.type === SESSION_IDLE) {
    stampHostTurn(state, id, {});
    closeHostTurn(state, id, idleVerdict(state, id));
  } else if (event.type === SESSION_EXECUTION_SUCCEEDED) {
    stampHostTurn(state, id, {});
    closeHostTurn(state, id, "succeeded");
  } else if (event.type === SESSION_EXECUTION_INTERRUPTED) {
    stampHostTurn(state, id, {});
    closeHostTurn(state, id, "interrupted");
  }
}

/**
 * A host event envelope: the type the server names, the session it is about, and
 * whatever else it carries. The server's lifecycle event shapes below are all
 * this, and tests used to spell the literals inline, which is how a test can end
 * up asserting against a shape the host never emits.
 */
const hostEvent = (type, id, properties) => ({ type, data: { sessionID: id, ...properties } });

/**
 * The server's lifecycle event shapes, declared once. `updated` and `error` take
 * the inner status so one declaration covers both the plain and error-valued
 * payloads.
 */
export const events = {
  idle: (id, properties = {}) => hostEvent(SESSION_IDLE, id, properties),
  /**
   * A turn at work: the host saying this session is running. It is the first
   * fact a replacement turn produces, and therefore the life sign that lets that
   * turn's ending be attributed to it rather than to the turn it replaced.
   *
   * v2 replaced the readable status channel with EXECUTION events — started,
   * succeeded, interrupted, failed — and every one of those is declared in
   * `host-events.ts` with `satisfies HostEventType`, so a fixture cannot invent a
   * fifth. A `session.status` here would have been a shape no host emits, which is
   * exactly how `question.created` shipped.
   */
  working: (id) => hostEvent(SESSION_EXECUTION_STARTED, id),
  /** The turn that ended well. Its counterpart to `working`, and named as such. */
  succeeded: (id) => hostEvent(SESSION_EXECUTION_SUCCEEDED, id),
  /** The turn the operator cut short — a third ending, distinct from failure. */
  interrupted: (id) => hostEvent(SESSION_EXECUTION_INTERRUPTED, id),
  deleted: (id, properties = {}) => hostEvent(SESSION_DELETED, id, properties),
  // The failure event carries an error detail, never a status field.
  error: (id, error) => hostEvent(SESSION_ERROR, id, error ? { error } : {}),
  /**
   * The host ASKING a permission, verbatim from the v2 manifest: `permission.asked`
   * carries `{id, sessionID, action, resources}` and no options at all. An absent
   * `sessionID` is the unattributable ask the gate must never touch.
   */
  permissionAsked: (sessionID, properties) => ({
    type: PERMISSION_ASKED,
    data: { ...(sessionID ? { sessionID } : {}), ...properties },
  }),
  /** The ask a live child would raise, spelled the way the manifest spells it. */
  ask: (sessionID, requestId, action = "edit") => events.permissionAsked(sessionID, { id: requestId, action, resources: [] }),
  /** The retirement of an ask — a decision, so it is a settlement the gate does not owe anyone. */
  permissionReplied: (props) => ({ type: PERMISSION_REPLIED, data: props }),
  permissionCancelled: (props) => ({ type: FORM_CANCELLED, data: props }),
};

/**
 * The text one prompt body carries, with the parts envelope stripped. Tolerant of a
 * body carrying no text part, because the two readers that classify a prompt by its
 * marker run before anything knows the body has parts at all — a strict reader there
 * throws inside a mock instead of reporting the prompt as not-a-notification.
 */
export const promptText = (args) => args?.text || "";

/**
 * One funnel for "the parent has now been sent this", and it classifies.
 *
 * Two capture sites typed the same record by hand, so the KIND rode nowhere: every
 * settlement case then told a success from a failure by the REGISTER of the prose,
 * which is how the corpus mis-read an ended turn as a finished job. A record is
 * therefore built here once, carrying the kind the payload declares — and a
 * parent-directed payload that declares none is a PLUGIN bug, so it throws at the
 * capture rather than entering the ledger as an unlabelled notice.
 */
const noticeRecord = (to, text) => {
  const kind = notificationKindOf(text);
  if (!kind) {
    throw new Error(`parent-directed payload carries no Kind field:\n${text}`);
  }
  return { to, kind, message: text };
};

/**
 * …and the one place a notice joins the ledger, kept separate from classifying it
 * so a REJECTED attempt stays undelivered. Classifying and capturing together
 * counted a failed dial as a delivery and doubled every redelivery case.
 */
const captureNotice = (state, record) => state.notifications.push(record);

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
 *   createReturnsIdless?: boolean,      // the session is real; the response names none
 *   promptFailIds?: Set<string>,         // async rejections
 *   promptHangIds?: Set<string>,         // never-settling prompts (non-blocking proof)
 *   promptSyncThrowIds?: Set<string>,    // synchronous throws
 *   abortThrowsOnce?: boolean,
 *   abortFailIds?: Set<string>,
 *   abortLoseOnceIds?: Set<string>,     // first abort per id never answers; later ones do
 *   abortHangIds?: Set<string>,         // never-settling aborts
 *   statusThrows?: Error,               // the status channel itself is down
 *   statusHang?: boolean,               // the status channel accepts and never answers
 *   presenceThrows?: Error,             // the presence read fails in a way that is not a 404
 *   presenceHang?: boolean,             // the presence read accepts and never answers

 *   messages?: (args: { path: { id: string } }) => unknown,
 *   permissionReplyThrows?: boolean,
 *   agentsList?: unknown[],
 *   sessionPrefix?: string,            // tells two hosts apart in one project
 *   silentHost?: boolean,              // every call is accepted and none is answered
 * }
 * Hook sets are read live: mutate them after setup to arm later phases.
 *
 * Session ids are per-host and numbered from 1, so a test can name
 * `ses_mock_1` and be sure it is the first child it created. They repeat
 * across hosts on purpose: the notify ledger is process-global, and the resets
 * in `harness.js` are what isolate it (production never resets anything). A
 * test that needs the two told apart — two plugin instances in one project, say
 * — says so with `sessionPrefix` rather than renumbering.
 */
/**
 * A host that accepts every call and answers none of them.
 *
 * Armed through one Proxy over the three namespaces the plugin actually dials
 * (`app`, `question`, `session`), read live, so a case can boot against a working
 * host and then go silent for the call under test. The gate is here rather than in
 * each endpoint because the point of the case is that NOTHING answers: a sweep over
 * a hand-written list of hung methods proves only that the list is current.
 */
const SILENCED = new Set(["agent", "permission", "session"]);

const silence = (state, hooks, value, ns = "") =>
  new Proxy(value, {
    get(target, prop) {
      const inner = target[prop];
      if (typeof inner === "function") {
        return async (...args) => {
          if (!armedFlag(state, hooks, "silentHost")) return inner(...args);
          // A trace of what the host swallowed, so a hang can be located instead of
          // raced. The suite still proves nothing by waiting; this names the call.
          fault(state, "silentHost");
      const called = `${ns}${String(prop)}`;
          if (Array.isArray(hooks.silencedCalls)) hooks.silencedCalls.push(called);
          if (process.env.SILENCE_TRACE) appendFileSync(process.env.SILENCE_TRACE, `${called}\n`);
          return neverAnswers();
        };
      }
      if (inner !== null && typeof inner === "object") return silence(state, hooks, inner, `${ns}${String(prop)}.`);
      return inner;
    },
  });

export function createMockClient(hooks = {}) {
  const state = {
    sessions: new Set(),
    // Sessions the host HAS but did not create in this run — a restore. Kept apart
    // from `sessions` so a case can say "this session predates the test" without
    // pretending the plugin's own dispatch created it.
    foreignSessions: new Set(),
    notifications: [],
    // Every notification the plugin DIALS, held or not — the count that proves
    // a held write was never retried behind the parent's back.
    notifyCalls: [],
    // Sessions whose transcript refuses to be read.
    unreadable: new Set(),
    unreadableError: new Map(),
    // Per-session transcript overrides — see `setTranscript` below. A Map, not a
    // field on the setup hook, because a case needs to change what ONE child
    // says between two settlements of that same child.
    transcripts: new Map(),
    // The host's TURN record per session — the verdict on the last completed
    // execution, absent while a turn is open. Separate from the transcript on
    // purpose: in v2 those are different facts.
    turns: new Map(),
    logs: [],
    aborted: [],
    // Every fault application, counted by name, and every fault a test asked
    // for. See `FAULTS`.
    faults: new Map(),
    armed: new Set(),
    // Faults a case knowingly may not reach — the only way out of the teardown
    // rule, so "the host was hostile" is always a claim somebody made on purpose.
    maybe: new Set(),
    // Every abort the plugin ASKED for, refused ones included. `aborted` above
    // records what the host actually did, which is the wrong question for an
    // ownership suite: a plugin that must never stop a session it did not
    // dispatch is caught by the request reaching the server at all, and against a
    // host that would 404 the target the two records diverge exactly where the
    // bug lives.
    abortAttempts: [],
    permissionCalls: [],
    // Where each session is currently routed, as the two flat v2 calls set it.
    routed: new Map(),
    transcriptReads: 0,
    agentListReads: 0,
    promptBodies: [],
    sessionBodies: new Map(),
    createThrown: false,
    // How many times the host's status channel was read. Views that already
    // know what they need must not spend a read per row.
    statusReads: 0,
    presenceReads: 0,
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
      // Ids whose first abort was lost, so a "loses once" fixture is spent.
    abortsLost: new Set(),
  };

  // The registry when a case seeds no agents: the same two the live host publishes,
  // named once so the list reader and the routing guard cannot disagree.
  const defaultAgents = () => [
    { id: "explore", name: "Explore", mode: "subagent", permissions: [] },
    { id: "general", name: "General", mode: "subagent", permissions: [] },
  ];

  // Sessions the host already knows about when the test starts, for boot-time
  // work that must ask the host BEFORE any event has been delivered (reconciling
  // what the last process left running). The seed is the host's TURN RECORD: a
  // verdict means the host has closed that turn, its absence means one is open.
  for (const [id, verdict] of Object.entries(hooks.hostTurnSeed ?? {})) {
    state.sessions.add(id);
    if (verdict === undefined) openHostTurn(state, id);
    else closeHostTurn(state, id, verdict);
  }
  armHookFaults(state, hooks);

  const endpoints = {
    _state: state,
    // v2 names this domain `agent` and its reader `list`, and the answer is a bare
    // array: there is no envelope to unwrap, so a reader reaching for `.data` now
    // fails on an array rather than quietly finding nothing.
    agent: {
      // A host that cannot answer is a case the plugin has to survive, and a
      // mock that can only ever succeed cannot express one.
      list: async () => {
        state.agentListReads += 1;
        if (armedFlag(state, hooks, "agentsListThrows")) {
          fault(state, "agentsListThrows");
          throw new Error("agent list unavailable");
        }
        // The real client answers the `AgentListOutput` envelope, not a bare array —
        // a fake answering the array let the reader believe a shape the host never
        // sends, which is exactly how live dispatch failed admission unnoticed.
        // The host's own records: a lowercase registry id plus a display label, which
        // are NOT interchangeable — routing resolves the id, case-sensitively.
        const data = hooks.agentsList ?? defaultAgents();
        return { location: { directory: state.directory }, data };
      },
    },
    // The question namespace, modelled on the host's generated contract rather
    // than on whatever the plugin happened to send. A mock that accepts any
    // shape is exactly what let four wrong field names (`path.id`, `body.answer`,
    // a reject body) pass as a green suite, so this one refuses them the way a
    // real host would: the route is /question/{requestID}, a reply carries
    // `answers: Array<QuestionAnswer>`, and a reject carries no body at all.
    permission: {
      reply: permissionEndpoint(state, hooks),
    },
    session: {
      create: async ({ title, parentID }) => {
        if (armedFlag(state, hooks, "createThrowsOnce") && !state.createThrown) {
          fault(state, "createThrowsOnce");
          state.createThrown = true;
          throw new Error("create failed");
        }
        // Always `ses_`-prefixed, even when told to distinguish hosts: the
        // ledger reader validates that shape and drops an entry without it, so a
        // prefix in front would be a silent, self-inflicted data loss.
        const prefix = hooks.sessionPrefix ? `ses_${hooks.sessionPrefix}_` : "ses_mock_";
        const id = `${prefix}${state.sessions.size + 1}`;
        state.sessions.add(id);
        setHostTurn(state, id, "open");
        state.sessionBodies.set(id, { title, parentID });
        // The host created the session and then answered with something no id can
        // be read out of. The session is real — it is in `state.sessions`, so
        // `sessionCount` counts it and nothing ever aborts it — which is the whole
        // shape of the orphan: a running child the plugin has no name for.
        if (armedFlag(state, hooks, "createReturnsIdless")) {
          fault(state, "createReturnsIdless");
          return { info: { title } };
        }
        return { id };
      },
      // session.prompt routes by marker: parent notifications carry the tag
      // production's own isParentNotification recognises; everything else is
      // child work.
      prompt: (args) => {
        const { sessionID, text } = args;
        // The prompt gate: the next child prompt parks here until the test
        // releases it, then fails non-retryably. A turn's own prompt delivery
        // failing is the one settlement that can still land while a steer
        // waits on its abort, so this is how a steer is raced against it.
        if (state.promptGate && !state.promptGate.used) {
          fault(state, "promptGate");
          state.promptGate.used = true;
          return state.promptGate.promise.then(() => {
            throw new Error("prompt rejected by the provider");
          });
        }
        const syncDead = forId(state, "promptSyncThrow", hooks.promptSyncThrowIds, sessionID, () => {
          throw new Error(`prompt sync-dead for ${sessionID}`);
        });
        if (syncDead) return syncDead;
        const hung = forId(state, "promptHang", hooks.promptHangIds, sessionID, neverAnswers);
        if (hung) return hung;
        const failed = forId(state, "promptFail", hooks.promptFailIds, sessionID, () => {
          throw new Error(`prompt failed for ${sessionID}`);
        });
        if (failed) return failed;
        if (isParentNotification(text)) {
          // The delivery transport for THIS notification, as a plan rather
          // than an override: a test states what the transport does, never how
          // the plugin reaches it.
          fault(state, "notifyTransport");
          const plan = hooks.notifyTransport;
          state.notifyCalls.push(text);
          const record = noticeRecord(sessionID, text);
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
            captureNotice(state, record);
            return plan.hold;
          }
          if (plan?.hang) return plan.hang;
          if (plan?.failTimes && ++state.notifyAttempts <= plan.failTimes) {
            return Promise.reject(new Error("parent notify failed"));
          }
          captureNotice(state, record);
        } else {
          if (hooks.childPromptFailOnce && !state.childPromptFailed) {
          fault(state, "childPromptFailOnce");
            state.childPromptFailed = true;
            return Promise.reject(
              Object.assign(new Error(hooks.childPromptFailOnce.message), {
                code: hooks.childPromptFailOnce.code,
              }),
            );
          }
          state.promptBodies.push({ to: sessionID, text });
        }
        if (hooks.promptRefusal) {
          // v2 says NO by REJECTING: every client method returns Promise<T> and an
          // API error throws, so a refusal is a thrown value and there is no
          // envelope to resolve. Production's retry catches exactly this.
          fault(state, "promptRefusal");
          const { status, message } = hooks.promptRefusal;
          throw Object.assign(new Error(message), { name: "ApiError", status });
        }
        return Promise.resolve({ parts: [{ type: "text", text: "PROMPT_OK" }] });
      },
      // v2 gives a plugin NO status channel, so the fake does not serve one: keeping
      // a map here would keep a v1 belief alive that production has already given up.
      context: async ({ sessionID }) => {
        state.transcriptReads += 1;
        if (state.messageReadGate && !state.messageReadGate.used) {
          fault(state, "messageReadGate");
          state.messageReadGate.used = true;
          await state.messageReadGate.promise;
        }
        if (state.unreadable.has(sessionID)) {
          fault(state, "unreadableTranscript");
          throw state.unreadableError.get(sessionID) ?? Object.assign(
            new Error(`Session "${sessionID}" transcript unavailable.`),
            { reason: "UnexpectedStatus", cause: { status: 500 } },
          );
        }
        if (state.transcripts.has(sessionID)) {
          return state.transcripts.get(sessionID);
        }
        if (hooks.messages) return hooks.messages({ sessionID });
        if (!state.sessions.has(sessionID)) {
          const error = new Error(`Session "${sessionID}" not found.`);
          error.status = 404;
          throw error;
        }
        return [hostSaid("COMPLETED_OK")];
      },
      // Does the host still HAVE this session — the only endpoint whose contract
      // answers that. The status map cannot: "nothing running" and "never existed"
      // are the same absence there, and reading one as the other is what made a
      // restart invent errors for children the host still had. So the fake answers
      // it, refusing with the host's OWN declared not-found.
      get: async ({ sessionID }) => {
        state.presenceReads += 1;
        const hostile = armedHostFault(state, hooks, "presenceHang", "presenceThrows");
        if (hostile) return hostile();
        if (state.sessions.has(sessionID) || state.foreignSessions.has(sessionID)) {
          return sessionObject(sessionID, state);
        }
        throw missingSessionError();
      },
      // v2 routes a turn by setting the session's agent and model, both flat calls
      // on the same domain. A turn is not dispatched against a model until the
      // prompt goes out with `parts` alone, so an unset route is a real failure
      // the fake can express.
      switchAgent: async ({ sessionID, agent }) => {
        // The host resolves by registry id, case-sensitively: a fake accepting
        // anything let production route display labels uncaught, which is how live
        // dispatch died with `Agent not found` under a green suite.
        const known = (hooks.agentsList ?? defaultAgents()).some(
          (a) => a?.id === agent || (a?.id === undefined && a?.name === agent),
        );
        if (!known) {
          const err = new Error(`Agent not found: "${agent}"`);
          err.name = "Session.AgentNotFoundError";
          throw err;
        }
        state.routed.set(sessionID, { ...(state.routed.get(sessionID) ?? {}), agent });
        return { ok: true };
      },
      switchModel: async ({ sessionID, model }) => {
        state.routed.set(sessionID, { ...(state.routed.get(sessionID) ?? {}), providerID: model?.providerID, modelID: model?.id });
        return { ok: true };
      },
      interrupt: async ({ sessionID }) => {
        state.abortAttempts.push(sessionID);
        // v2 records what a turn ENDED as. An interrupt closes an open turn as
        // `interrupted` — a real verdict, and the one that distinguishes a steer
        // (interrupted, replacement pending) from a turn that simply has nothing
        // on it yet. A turn already closed keeps the verdict it was given.
        closeHostTurn(state, sessionID, "interrupted");
        // A transport that never answers. The plugin bounds every other host
        // call, so a hang here is the one shape a caller cannot survive unless
        // the abort path carries its own deadline.
        const abortHung = forId(state, "abortHang", hooks.abortHangIds, sessionID, neverAnswers);
        if (abortHung) return abortHung;
        // The lost packet: ONE abort per id never comes back, and every later one
        // is answered normally. `abortHangIds` is the wrong shape for a deadline
        // test — a hang that never lifts also hangs the harness's teardown, so the
        // suite would stop reporting anything after the case it was written for.
        // This is the shape a real network failure has: the request is lost once,
        // and a retry gets through.
        if (!state.abortsLost.has(sessionID)) {
          const lost = forId(state, "abortLoseOnce", hooks.abortLoseOnceIds, sessionID, () => {
            state.abortsLost.add(sessionID);
            return neverAnswers();
          });
          if (lost) return lost;
        }
        if (armedFlag(state, hooks, "abortThrowsOnce") && !state.abortThrown) {
          fault(state, "abortThrowsOnce");
          state.abortThrown = true;
          throw new Error("abort failed");
        }
        if (armedFlag(state, hooks, "abortThrows")) {
          fault(state, "abortThrows");
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
        if (serverLostIt(sessionID)) {
          if (hooks.abortFailIds?.has(sessionID)) fault(state, "abortFail");
          throw sessionNotFound(sessionID);
        }
        // The abort gate: the first abort parks here until the test releases
        // it, so a racing call can be arranged without monkey-patching. With
        // `fails`, the released abort reports the session as gone — the race
        // outcome the settlement path must survive.
        if (state.abortGate && !state.abortGate.used) {
          fault(state, "abortGate");
          state.abortGate.used = true;
          await state.abortGate.promise;
          if (state.abortGate.fails) {
            throw sessionNotFound(sessionID);
          }
        }
        state.aborted.push(sessionID);
        stampHostTurn(state, sessionID, {});
        closeHostTurn(state, sessionID, "interrupted");
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
    makeUnreadable(sessionId, error) {
      state.unreadable.add(sessionId);
      state.unreadableError.set(sessionId, error);
    },
    /**
     * What a session's transcript reads as, replaceable while the harness is
     * live. Consulted BEFORE the setup-time `messages` hook, because the case
     * that needs it is always the same shape: one child, two settlements, two
     * fates — it was dying of a network blip, and now it has a real answer. A
     * setup hook is a constant, so a case that needed a second fate had to
     * build a second harness and a second child, which tests something else.
     */
    setTranscript(sessionId, messages) {
      state.transcripts.set(sessionId, messages);
    },
    /**
     * Go silent for every call from here on. The fake owns the flip because
     * arming is the fake's bookkeeping: a case that set the flag by hand still
     * armed it, but a case that goes through here cannot arm it twice, and the
     * teardown rule sees both the same way.
     */
    silenceHost() {
      hooks.silentHost = true;
      armFault(state, "silentHost");
      return { release: () => (hooks.silentHost = false) };
    },
  };
  // Only the three namespaces the plugin dials are silenced; the helpers above are
  // how a case ARMS the silence, so silencing them would leave nothing to arm with.
  return Object.fromEntries(
    Object.entries(endpoints).map(([key, value]) => [key, SILENCED.has(key) ? silence(state, hooks, value) : value]),
  );
}

/**
 * The fake's own source, for a suite that has to READ what the fake says rather than
 * run it. Owned here so every such suite asks the same reader: two suites each
 * assembling the path would be the drift this file exists to prevent, one level up.
 */
export const FAKE_SOURCE = readFileSync(new URL(import.meta.url), "utf8");

/**
 * Is this the answer shape the SDK sends — the payload beside the response it arrived
 * in? Beside the builder because a producer and a recogniser of one shape are one fact,
 * and two copies of it would drift the way everything else here did.
 */

/**
 * The arguments one endpoint answers, by namespace and method — the shape the
 * HOST's route expects, which is not the same shape as the plugin's.
 *
 * This lives beside the endpoints rather than in the suite that probes them,
 * because that suite's only question is what comes BACK and the thing it must not
 * decide for itself is what to send. `question.reject` is why: its route takes no
 * body at all, so a probe that sends one learns nothing except that the fake
 * knows its routes better than the probe did.
 */
export function hostCallArgs(ns, method, probeId) {
  if (ns === "permission" && method === "reply")
    return { sessionID: probeId, requestID: "prb_shape_probe", decision: "once" };
  if (ns === "session" && method === "prompt") return { sessionID: probeId, text: "probe" };
  if (ns === "session" && method === "create") return { title: "probe" };
  if (ns === "session") return { sessionID: probeId };
  return {};
}

/**
 * The host's agent list, as a case needs it: one dispatchable agent declaring
 * exactly the tools it provisions to its children. Owned here rather than in a
 * suite because the tools map is a fact about the HOST, and a suite that wrote
 * one would be the second place that shape is spelled.
 */
export const agentDeclaring = (permissions) => [{ name: "explore", mode: "subagent", permissions }];

/** The ruleset entries as this plugin spells them: the host's ordered walk, two effects. */
export const permitting = (...rules) => rules;
export const allowAction = (action) => ({ action, resource: "*", effect: "allow" });
export const denyAction = (action) => ({ action, resource: "*", effect: "deny" });
