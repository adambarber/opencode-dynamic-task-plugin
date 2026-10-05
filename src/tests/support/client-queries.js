/**
 * Every question a test can ask about what the host was told, and its
 * answer's shape decided once: which prompts reached a child, which carried
 * a given text, whether a turn was aborted, how many dials the gate made.
 * The client is the argument because a `failing` or `one` harness and the
 * primary `h` are all equally valid subjects. Extracted from harness.js so
 * the question vocabulary lives in one module.
 */
import { promptText } from "./mock-host.js";

/** Every prompt the host was asked to send, oldest first. */
export const sentPrompts = (client) => client.testState.promptBodies;

/** The prompts addressed to one session — "which turns of this child fired". */
export const promptsTo = (client, sessionId) => client.testState.promptBodies.filter((p) => p.to === sessionId);

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
export const wasAborted = (client, sessionId) => client.testState.aborted.includes(sessionId);

/** The sessions aborted so far, for a failure message that wants the list. */
export const abortedSessions = (client) => client.testState.aborted;

/**
 * Whether the host was ever ASKED to abort a session.
 *
 * `wasAborted` asks what the host did, which is the wrong question for anything
 * about authority: a host that does not own the id answers 404, so a plugin that
 * stopped a session it had no business stopping produces no `aborted` entry and a
 * test written against `wasAborted` calls that clean. The request is the record.
 */
export const abortWasRequestedFor = (client, sessionId) =>
  client.testState.abortAttempts.includes(sessionId);

/** Every session the host was asked to abort, in order. */
export const abortRequests = (client) => client.testState.abortAttempts;

/** Every session the host has been asked to create. */
export const sessionIds = (client) => [...client.testState.sessions];

/** How many sessions the host has been asked to create. */
export const sessionCount = (client) => client.testState.sessions.size;

/** The create body recorded for one session — what the host was told to make. */
export const sessionBody = (client, sessionId) => client.testState.sessionBodies.get(sessionId);

/** How many dials the gate made, held or not. */
export const dialCount = (client) => client.testState.notifyCalls.length;

/** The parent notifications the plugin recorded. */
export const notifiedNotes = (client) => client.testState.notifications;

/** A child declaring it cannot continue without something. The `needs_input` kind is the
 * production contract for that gesture, so it is spelled here once rather than at
 * every site that needs a child to be stuck. */
export const declareNeedsInput = (child, words) => child.notify(words, { kind: "needs_input" });
