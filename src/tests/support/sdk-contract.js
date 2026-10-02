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

import { REPO_ROOT } from "./corpus.js";

const SDK_ROOT = path.join(REPO_ROOT, "node_modules", "@opencode-ai", "sdk");
const TYPES = path.join(SDK_ROOT, "dist", "gen", "types.gen.d.ts");

/** The declared source, read once. A miss here is fatal by design — see `require`. */
let declaration;
function source() {
  declaration ??= readFileSync(TYPES, "utf8");
  return declaration;
}

/**
 * Fail loudly rather than return an empty answer.
 *
 * An empty word list would make every gate downstream vacuously true: a fake
 * constrained to no words would pass a "no invented words" check, and a status
 * word check would compare against nothing. So a parse that finds less than it
 * expects is a thrown error, never a default.
 */
function require_(what, found) {
  if (found.length === 0) {
    throw new Error(`sdk-contract could not read ${what} out of ${TYPES} — the declaration moved`);
  }
  return found;
}

/** The members of a declared union, by its `type` discriminant. */
function unionWords(typeName, endMarker) {
  const text = source();
  const start = text.indexOf(`export type ${typeName} =`);
  if (start < 0) return require_(typeName, []);
  const rest = text.slice(start);
  const end = rest.indexOf(endMarker);
  const body = end < 0 ? rest : rest.slice(0, end);
  return require_(
    typeName,
    [...new Set([...body.matchAll(/type:\s*"([a-z]+)"/g)].map((m) => m[1]))],
  );
}

/**
 * Every word the host's status channel can hold — parsed from `SessionStatus`.
 *
 * This is the list the fake is held to, so it is the list that also proves the
 * production switch is exhaustive: if the host adds a word, this grows, and the
 * compile-time pin in `type-invariants.ts` stops compiling.
 */
export function hostStatusWords() {
  return unionWords("SessionStatus", "export type EventSessionStatus");
}

/**
 * The word whose arrival means the host DELETES a status entry rather than storing
 * one. opencode v1.18.30 `packages/opencode/src/session/status.ts`:
 *
 *   if (status.type === "idle") { events.publish(Event.Idle, {sessionID}); data.delete(sessionID); return }
 *
 * So this word is the reason an absent key cannot be read as a missing session, and
 * the reason the fake is required to delete on it.
 */
export function idleWord() {
  const words = hostStatusWords();
  if (!words.includes("idle")) throw new Error(`sdk-contract: no "idle" member in SessionStatus (${words.join(", ")})`);
  return "idle";
}

/**
 * The word the host publishes when a turn is at work — the one every "is this child
 * running" question bottoms out in, and so the word a fixture naming "running" needs.
 *
 * Parsed rather than typed because `idleWord()` sits beside it for exactly one reason:
 * a fixture that hardcodes either word passes on a day the host renames it and fails on
 * no day at all.
 */
export function busyWord() {
  const words = hostStatusWords();
  if (!words.includes("busy")) throw new Error(`sdk-contract: no "busy" member in SessionStatus (${words.join(", ")})`);
  return "busy";
}

/** The declared name of the host's not-found: `SessionGetErrors[404]`'s type's `name`. */
export function notFoundName() {
  const errors = source().indexOf("export type SessionGetErrors =");
  if (errors < 0) return require_("SessionGetErrors", []);
  const slice = source().slice(errors);
  const entry = slice.match(/\n\s*404:\s*([A-Za-z]+);/);
  if (!entry) throw new Error(`sdk-contract: SessionGetErrors has no 404 member in ${TYPES}`);
  // The named type may be declared BEFORE SessionGetErrors in the file, so it is
  // looked up in the whole source rather than in the slice from the error map.
  const at = source().indexOf(`export type ${entry[1]} =`);
  if (at < 0) throw new Error(`sdk-contract: SessionGetErrors[404] names an undeclared ${entry[1]}`);
  const body = source().slice(at);
  const name = body.match(/name:\s*"([^"]+)"/);
  if (!name) throw new Error(`sdk-contract: ${entry[1]} declares no name literal in ${TYPES}`);
  return name[1];
}

/** The status code `SessionGetErrors` pins for "not found". */
export function notFoundStatus() {
  const errors = source().indexOf("export type SessionGetErrors =");
  if (errors < 0) throw new Error(`sdk-contract: no SessionGetErrors in ${TYPES}`);
  const entry = source().slice(errors).match(/\n\s*(\d{3}):\s*NotFoundError;/);
  if (!entry) throw new Error(`sdk-contract: SessionGetErrors pins no 404 in ${TYPES}`);
  return Number(entry[1]);
}

/** The installed SDK version, so a drifting dependency cannot pass unnoticed. */
export function installedSdkVersion() {
  return JSON.parse(readFileSync(path.join(SDK_ROOT, "package.json"), "utf8")).version;
}