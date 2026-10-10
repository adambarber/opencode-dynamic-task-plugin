// src/tests/support/sdk-contract.js
//
// The host's own vocabulary, read out of the SDK's actual declaration at test time.
//
// Why this exists rather than a constant: the plugin's production code is typed
// against `SessionStatus`, so it can only be wrong about the host by way of a MOCK.
// A mock's word list is hand-maintained, and a hand-maintained list drifts silently
// in the one direction that hides a defect — the fake grows a word the host never
// emits, the plugin reads it as a real status, and every test passes.
//
// So the list is not written here. It is parsed out of the `.d.ts` the production
// code compiles against, so a host that adds or renames a word fails these tests
// loudly and immediately, and a fake that invents one cannot pass the gate at all.


import { readFileSync } from "node:fs";
import path from "node:path";
import { SESSION_NOT_FOUND_TAG } from "../../../dist/shared/liveness.js";
import { REPO_ROOT } from "./corpus.js";

const SCHEMA_ROOT = path.join(REPO_ROOT, "node_modules", "@opencode", "schema", "dist");
const TYPES = path.join(SCHEMA_ROOT, "session.d.ts");

const CLIENT_ROOT = path.join(REPO_ROOT, "node_modules", "@opencode", "client", "dist");

/** A declared file's text, read once. A miss here is fatal by design — see `require`. */
const readOnce = new Map();
function read(path_) {
  if (!readOnce.has(path_)) readOnce.set(path_, readFileSync(path_, "utf8"));
  return readOnce.get(path_);
}

function declared(name) {
  return read(path.join(SCHEMA_ROOT, name));
}

/** The client's own declarations — where the transport's failure vocabulary lives. */
function clientFile(name) {
  return read(path.join(CLIENT_ROOT, name));
}

function source() {
  return declared("session.d.ts");
}

/**
 * Fail loudly rather than return an empty answer.
 *
 * An empty word list would make every gate downstream vacuously true: a fake
 * constrained to no words would pass a "no invented words" check, and a status
 * word check would compare against nothing. So a parse that finds less than it
 * expects is a thrown error, never a default.
 */
// Two parse idioms the readers below share: distinct capture-group words out of a
// body, and every quoted word out of one. One spelling each, so a reader cannot
// quietly change what "declared" means for its own word list.
const requiredQuoted = (what, text) => requireFound(what, [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1]));

function requireFound(what, found) {
  if (found.length === 0) {
    throw new Error(`sdk-contract could not read ${what} out of ${TYPES} — the declaration moved`);
  }
  return found;
}

/**
 * The v2 domains a plugin may name, read out of the `Context` the published plugin
 * package declares.
 *
 * This is the list the old scanner carried by hand as `app|session|question`, and it is
 * why that scanner went blind: v2 renamed `question` to `permission` and added `agent`,
 * and a hand-written allowlist cannot notice. Parsed instead, so the set is the host's.
 */

/**
 * Every verdict the host declares for a COMPLETED execution, parsed out of
 * `Session.Info.outcome`.
 *
 * This is the list a turn-level reader must cover, and it is the reason the list is
 * parsed: the plugin once derived "the turn is over" from a MESSAGE field instead,
 * and a hand-kept word list is what let a fixture agree with that mistake. A host
 * that adds a verdict now lands in the absence of the suite below and fails it,
 * rather than passing as a word nothing reads.
 */
export function hostOutcomeWords() {
  const at = source().indexOf("readonly outcome:");
  if (at === -1) return requireFound("Session.Info.outcome", []);
  const entry = source().slice(at).match(/Schema\.Literals<readonly \[([^\]]+)\]>/);
  if (!entry) throw new Error(`sdk-contract: Session.Info.outcome declares no Literals list in ${TYPES}`);
  return requiredQuoted("Session.Info.outcome", entry[1]);
}

/**
 * The words a fixture may use to describe a TURN's state: `open`, or one of the
 * verdicts the host declares for a completed execution.
 *
 * Deliberately not the message words: a v2 turn is a SEQUENCE of messages that each
 * carry their own completion, so a step ending is not a turn ending, and a
 * vocabulary that could not tell them apart is how the two got confused.
 */

/**
 * Every reason the client declares it can FAIL, parsed out of `ClientErrorReason`.
 *
 * v2 has no declared not-found error type at all: `session.get` rejects with a
 * `ClientError`, which carries a `reason` from this union and the offending HTTP
 * response on `cause`. So the reason a session is missing is a PAIR — this reason
 * plus a 404 on the cause — and a reader that checks only one of them is a reader
 * that reports a missing session as anything at all.
 */
export function clientErrorReasons() {
  const text = clientFile("promise/generated/client-error.d.ts");
  const at = text.indexOf("ClientErrorReason =");
  if (at === -1) return requireFound("ClientErrorReason", []);
  const entry = text.slice(at).match(/=([^;]+);/);
  if (!entry) throw new Error("sdk-contract: ClientErrorReason declares no union");
  return requiredQuoted("ClientErrorReason", entry[1]);
}

/**
 * How the in-process host says "no such session": the core
 * `Session.NotFoundError` (`packages/core/src/session/error.ts`), thrown
 * across the plugin boundary as an Error instance carrying the dotted tag
 * and the session id — and no message (the class declares no override).
 *
 * That class is unpublished: no installed package exports it, so the tag
 * string below is the one token cited from source rather than imported.
 * Everything else is the class's nature (Error instance, empty message),
 * not invention. The HTTP `ClientError` spelling this replaced is a
 * remote-client shape the in-process API never throws.
 */
export function missingSessionError(sessionID = "ses_missing") {
  // The tag is imported, not retyped: the suite forbids test-side copies of
  // bound production values, and this is one. Its spelling is owned by
  // liveness.ts with the host source cited there.
  return Object.assign(new Error(""), {
    _tag: SESSION_NOT_FOUND_TAG,
    sessionID,
  });
}

