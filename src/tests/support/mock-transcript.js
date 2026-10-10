/**
 * The mock host's own turn model: what it writes into a session transcript, and how
 * a host turn reaches a terminal state.
 *
 * A fake that invents its own liveness is how a suite comes to "pass" against a
 * contract the host does not have — these are the host's v2 `outcome` words and its
 * `time.idle`, read from `sdk-contract` rather than kept as a hand-copied list, so a
 * host that adds a verdict makes this file name it.
 */

import { SESSION_DELETED, SESSION_ERROR, SESSION_EXECUTION_INTERRUPTED, SESSION_EXECUTION_STARTED, SESSION_EXECUTION_SUCCEEDED, SESSION_IDLE } from "./mock-events.js";
import { hostOutcomeWords } from "./sdk-contract.js";

// One builder for every assistant message the fake writes, in the host's
// own v2 spelling: flat `type`, flat clock, `content` members.
const assistantMessage = (text, time, extra) => ({
  content: [{ text, type: "text" }],
  time,
  type: "assistant",
  ...extra,
});
export const hostSaid = (text, at = Date.now(), extra) => assistantMessage(text, { completed: at, created: at }, extra);

/** The same turn carrying no clock at all — what a plugin booted mid-turn sees. */
export const unclockedSaid = (text = "go", role = "user") => ({
  ...hostSaid(text),
  time: undefined,
  type: role,
});

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
export const stampHostTurn = (state, id, extra) => {
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
// The fake serves both transcript eras deliberately (v2 for the host's own
// spelling, v1 for the tolerance pins), so the closer reads both: the role off
// `type` or `info.role`, the clock off `time` or `info.time`, and the stamp goes
// back in the spelling it found. Stamping a v1 seed with a flat clock would
// orphan its error under `info` while the readers walk the new `time`.
const messageRole = (m) => m?.type ?? m?.info?.role;
const messageClock = (m) => m?.time ?? m?.info?.time;
const finishOpenMessage = (have, extra) => {
  const last = have.at(-1);
  const open = messageRole(last) === "assistant" && messageClock(last)?.completed === undefined;
  if (!open) return [...have, hostSaid("", undefined, extra)];
  const stamped = { ...last, ...extra };
  if (last?.info) stamped.info = { ...last.info, time: { ...messageClock(last), completed: Date.now() } };
  else stamped.time = { ...messageClock(last), completed: Date.now() };
  return [...have.slice(0, -1), stamped];
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
export const openHostTurn = (state, id) => {
  state.turns.set(id, { idle: undefined, outcome: undefined });
};

export const closeHostTurn = (state, id, outcome) => {
  // A closed turn KEEPS its verdict. The host records the outcome of the last
  // completed execution; an event that arrives afterwards for a turn that already
  // ended must not rewrite history, or an interrupt of a finished turn would
  // report the finished work as interrupted.
  if (state.turns.get(id)?.outcome !== undefined) return;
  state.turns.set(id, { idle: Date.now(), outcome });
};

/** The verdict a closing idle implies, read off the transcript it is closing. */
function idleVerdict(state, id) {
  const last = (state.transcripts.get(id) ?? []).at(-1);
  return last?.info?.error ?? last?.error ? "failed" : "succeeded";
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
