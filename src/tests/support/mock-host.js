/**
 * The fake OpenCode server's transport: the client surface, its refusals and its
 * faults, assembled from the three shape modules it is made of.
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
 *
 * The shapes live where they can be checked against one thing each:
 * `mock-transcript.js` owns what the host writes into a session and how a turn ends,
 * `mock-events.js` owns the event vocabulary and what is read back out of it, and
 * this module re-exports both so a suite has one import to name the host through.
 */

import { isParentNotification } from "../../../dist/shared/notification-text.js";
import { armedFlag, armedHostFault, armFault, armHookFaults, fault, forId, neverAnswers } from "./faults.js";
import { captureNotice, noticeRecord } from "./mock-events.js";
import { armGate } from "./mock-gates.js";
import { permissionEndpoint } from "./mock-permission.js";
import { mockState, seedHostTurns } from "./mock-state.js";
import { createMockStorage } from "./mock-storage.js";
import { closeHostTurn, hostSaid, setHostTurn, stampHostTurn } from "./mock-transcript.js";
import { missingSessionError } from "./sdk-contract.js";


/**
 * The host's sync session.updated envelope. `status` is the word it reports, or
 * the error object it reports instead — the one field those two spellings
 * disagree on, and the field a terminal verdict reads. The address rides
 * separately, so a case about the shape alone has no session to invent.
 */
export const sessionUpdatedEnvelope = (status) => ({
  data: { info: { status } },
  name: "session.updated.1",
  type: "sync",
});

/**
 * The host's `session.get` answer: the fields the SDK's `Session` declares
 * required. A fake that answers with `{id}` alone is a fake answering a smaller
 * question than the one production asked, and the missing fields are exactly where
 * a real divergence shows up.
 */
const sessionObject = (id, state) => {
  const turn = state?.turns?.get(id);
  // The session's own model, as the host's projector writes it: `session.switchModel`
  // publishes `ModelSelected` and the session row carries the ref from then on, so a
  // `session.get` answers with it. The fake models the same round trip, because the
  // plugin's inheritance layer reads exactly this.
  const model = state?.sessionModels?.get(id);
  return {
    id,
    ...(model === undefined ? {} : { model }),
    directory: "/mock/project",
    projectID: "ses_project_mock",
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


const sessionNotFound = () => missingSessionError();

/**
 * The production-shaped mock host.
 *
 * hooks: {
 *   createThrowsOnce?: boolean,
 *   createReturnsIdless?: boolean,      // the session is real; the response names none
 *   createHangsAfterCreate?: boolean,   // the session is real; the answer never comes
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

/**
 * `domain` is the host's durable table, handed in when a case needs TWO plugin
 * processes to share one. The host's KV is global, so sharing is the truth and a
 * private Map per client is the simplification — which is only safe while every
 * case asks questions about a single plugin, and quietly unaskable the moment one
 * does not.
 */
export function createMockClient(hooks = {}, domain = {}) {
  const state = mockState(domain);

  // The registry when a case seeds no agents: the same two the live host publishes,
  // named once so the list reader and the routing guard cannot disagree.
  const defaultAgents = () => [
    { id: "explore", mode: "subagent", name: "Explore", permissions: [] },
    { id: "general", mode: "subagent", name: "General", permissions: [] },
  ];

  // Sessions the host already knows about when the test starts, for boot-time
  // work that must ask the host BEFORE any event has been delivered (reconciling
  // what the last process left running). The seed is the host's TURN RECORD: a
  // verdict means the host has closed that turn, its absence means one is open.
  seedHostTurns(state, hooks.hostTurnSeed);
  armHookFaults(state, hooks);
  const {
    askedWrites: storageAskedWrites,
    holdNext: holdNextStorageWrite,
    holdReads: holdStorageReads,
    storage,
    untilWrites: untilStorageWrites,
  } = createMockStorage(state, hooks);

  const endpoints = {
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
        return { data, location: { directory: state.directory } };
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
            { cause: { status: 500 }, reason: "UnexpectedStatus" },
          );
        }
        if (state.transcripts.has(sessionID)) {
          return state.transcripts.get(sessionID);
        }
        if (hooks.messages) return hooks.messages({ sessionID });
        if (!state.sessions.has(sessionID)) {
          throw missingSessionError();
        }
        return [hostSaid("COMPLETED_OK")];
      },
      create: async ({ title, parentID, location }) => {
        if (armedFlag(state, hooks, "createThrowsOnce") && !state.createThrown) {
          fault(state, "createThrowsOnce");
          state.createThrown = true;
          throw new Error("create failed");
        }
        // The host refusing the create with its own missing-session shape, the way it
        // answers when the session being branched from is gone. No session is created,
        // so nothing exists to abort and no id was ever returned.
        if (armedFlag(state, hooks, "createRefusedMissing")) {
          fault(state, "createRefusedMissing");
          throw missingSessionError(parentID ?? "ses_parent_gone");
        }
        // Always `ses_`-prefixed, even when told to distinguish hosts: the
        // ledger reader validates that shape and drops an entry without it, so a
        // prefix in front would be a silent, self-inflicted data loss.
        const prefix = hooks.sessionPrefix ? `ses_${hooks.sessionPrefix}_` : "ses_mock_";
        const id = `${prefix}${state.sessions.size + 1}`;
        state.sessions.add(id);
        setHostTurn(state, id, "open");
        state.sessionBodies.set(id, { parentID, title, location });
        // The host created the session and then answered with something no id can
        // be read out of. The session is real — it is in `state.sessions`, so
        // `sessionCount` counts it and nothing ever aborts it — which is the whole
        // shape of the orphan: a running child the plugin has no name for.
        if (armedFlag(state, hooks, "createReturnsIdless")) {
          fault(state, "createReturnsIdless");
          return { info: { title } };
        }
        // Created, then nothing. The session is real and in `state.sessions`, while
        // the caller's bound expires holding a request that will never answer: the
        // shape `silentHost` could not express, since it goes quiet BEFORE the create.
        if (armedFlag(state, hooks, "createHangsAfterCreate")) {
          fault(state, "createHangsAfterCreate");
          return new Promise(() => {});
        }
        return { id };
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
      // The Session Inbox namespace (v2.1.4+), presented only when a case arms
      // it: `hooks.inboxHost` is the verdict the boot's shape probe reads, and
      // a fake without it is a below-inbox host by construction. The three
      // methods are the ones the installed client declares; the fake answers
      // their shapes but no case has needed real list/cancel semantics yet —
      // what the plugin asks for is the DELIVERY verdict on prompt, modelled
      // below.
      ...(hooks.inboxHost
        ? {
            inbox: {
              cancel: async () => undefined,
              list: async () => [],
              update: async () => undefined,
            },
          }
        : {}),
      // session.prompt routes by marker: parent notifications carry the tag
      // production's own isParentNotification recognises; everything else is
      // child work.
      prompt: (args) => {
        const { sessionID, text } = args;
        // The Session Inbox verdict (v2.1.4+), when the fake presents the
        // surface. Recorded on every delivery-capable prompt, whatever it
        // carried, so a suite can assert WHAT was asked for rather than infer
        // it from where the text landed.
        const { delivery } = args;
        if (delivery !== undefined) state.promptDeliveries.push({ delivery, to: sessionID });
        if (delivery === "queue") {
          // "queue" parks in the host's inbox table until the turn ends, then
          // becomes the next turn on its own — so the fake parks the text and
          // `closeHostTurn` flushes it. The text is NOT yet a prompt the child
          // is working through, and a suite reading promptBodies must not see
          // it until the simulated turn actually ends.
          //
          // A parent notification parked here is DELIVERED — the write is the
          // delivery; the host now owns when the parent reads it — so the
          // notice is captured at the park, exactly as a non-queue write to a
          // mid-turn parent is captured on landing (line 469's hold does the
          // same). Otherwise every queue-delivered settlement would look
          // silent to a suite reading `notifications`, and "delivered" would
          // read as "vanished".
          if (isParentNotification(text)) {
            fault(state, "notifyTransport");
            state.notifyCalls.push(text);
            captureNotice(state, noticeRecord(sessionID, text));
          }
          const parked = state.inboxQueue.get(sessionID) ?? [];
          parked.push({ delivery, text });
          state.inboxQueue.set(sessionID, parked);
          return Promise.resolve({ parts: [{ text: "QUEUED_OK", type: "text" }] });
        }
        if (delivery === "steer") {
          // "steer" is promoted at the next step boundary of the running
          // turn: the prompt JOINS the turn — recorded like any other prompt —
          // and nothing about the turn is disturbed. No abort, no close, no
          // park: the whole point of the native steer is that the in-flight
          // step completes first. The prompt gate still applies (a steer can
          // be raced against its own delivery failing), unchanged.
          if (state.promptGate && !state.promptGate.used) {
            fault(state, "promptGate");
            state.promptGate.used = true;
            return state.promptGate.promise.then(() => {
              throw new Error("prompt rejected by the provider");
            });
          }
          state.promptBodies.push({ text, to: sessionID });
          return Promise.resolve({ parts: [{ text: "STEER_OK", type: "text" }] });
        }
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
          state.promptBodies.push({ text, to: sessionID });
        }
        if (hooks.promptRefusal) {
          // v2 says NO by REJECTING: every client method returns Promise<T> and an
          // API error throws, so a refusal is a thrown value and there is no
          // envelope to resolve. Production's retry catches exactly this.
          fault(state, "promptRefusal");
          const { status, message } = hooks.promptRefusal;
          throw Object.assign(new Error(message), { name: "ApiError", status });
        }
        return Promise.resolve({ parts: [{ text: "PROMPT_OK", type: "text" }] });
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
        state.routed.set(sessionID, { ...state.routed.get(sessionID), agent });
        return { ok: true };
      },
      switchModel: async ({ sessionID, model }) => {
        // The host's projector side: the switch lands on the session row, so a later
        // `session.get` reads the model the host was asked to run. Without it the
        // inheritance layer could never observe a parent that switched models.
        if (model?.providerID !== undefined && model?.id !== undefined) {
          state.sessionModels.set(sessionID, { id: model.id, providerID: model.providerID });
        }
        state.routed.set(sessionID, { ...state.routed.get(sessionID), modelID: model?.id, providerID: model?.providerID });
        // The host's projector side: the switch lands on the session row, so a later
        // `session.get` reads the model the host was asked to run. Without it the
        // inheritance layer could never observe a parent that switched models.
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
    // Hold the next durable storage call open. The host writes plugin records in
    // its own SQLite, so a write can be accepted and never stored — and a state
    // write that never lands must be refused, not waited on.
    gateStorage(opts) {
      return armGate(state, "storageGate", opts);
    },
    // Hold ONE storage write until it lands, so a case can watch a write the plugin
    // already gave up on arrive and observe what the store does about it.
    holdNextStorageWrite() {
      return holdNextStorageWrite();
    },
    // The keys the host was ASKED to write, in order: put-then-drop is a claim about
    // what a case asked for, which the rows in `kv` cannot show.
    storageWriteKeys() {
      return storageAskedWrites();
    },
    // A host that has stopped answering reads. Unanswered is not empty, and a case
    // cannot tell them apart unless the fake can make one happen on purpose.
    holdStorageReads() {
      return holdStorageReads();
    },
    // Resolve once `n` durable writes have LANDED. A store repairing a late landing
    // does it with a real write, so waiting for the repair waits for the host.
    untilStorageWrites(n) {
      return untilStorageWrites(n);
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
    storage,
    testState: state,
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
    return { decision: "once", requestID: "prb_shape_probe", sessionID: probeId };
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
export const agentDeclaring = (permissions) => [{ mode: "subagent", name: "explore", permissions }];

/** The ruleset entries as this plugin spells them: the host's ordered walk, two effects. */
export const permitting = (...rules) => rules;
export const allowAction = (action) => ({ action, effect: "allow", resource: "*" });
export const denyAction = (action) => ({ action, effect: "deny", resource: "*" });
