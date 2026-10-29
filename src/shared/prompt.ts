// src/shared/prompt.ts
// Prompt invocation dance (Task 03) — the ONLY module that builds
// session.prompt payloads and invokes them. Siblings call invokePrompt;
// error meaning is classified in one place via classifyPromptError.
// Result hydration semantics (single-wait, content-first) land here in
// Task 03 proper; the funnel exists now so no new prompt path can bypass it.

import { callHost, type FailureReporter, fireAndForget, type OpaqueHost } from "./client.js";
import { READ_BOUNDS } from "./execution-bound.js";
import { hostPayload } from "./host-events.js";
import { errorMessage, eventField, eventString, isEventRecord } from "./host-shape.js";
import type { Verdict } from "./verdict.js";
import { MAX_PROMPT_CHARS, promptTooLong } from "./voice.js";

// ─── invokePrompt ──────────────────────────────────────────────────
// Builds the single payload shape and invokes it. Rejects with the raw
// client error — callers classify via classifyPromptError.

// Prompt routing (1.18 contract): agent and model ride on the message,
// not the session. SessionCreate takes title/parentID only — fields sent
// anywhere else are silently dropped by the server.

export interface ModelOverride {
  providerID: string;
  modelID: string;
}

export interface PromptRouting {
  agent?: string;
  model?: ModelOverride;
  /** The host's inbox delivery verdict, on a caller that means to set one. */
  delivery?: "steer" | "queue";
}

// The input gate for every prompt-carrying tool. One place decides the ORDER
// and the LIMITS of static prompt validation, so a new caller cannot accept an
// oversized prompt, or send one before checking the model shape. The absent-
// prompt wording is the caller's (spawn and steer phrase it differently);
// everything else is decided here. Both checks run before any side effect:
// a bad id must fail without creating or steering anything.
export interface AdmittedPromptInput {
  prompt: string;
  modelOverride: ModelOverride | undefined;
}

export function admitPromptInput(
  prompt: unknown,
  model: unknown,
  absentPromptVoice: string,
): Verdict<AdmittedPromptInput> {
  if (!prompt || typeof prompt !== "string") return { error: absentPromptVoice, ok: false };
  if (prompt.length > MAX_PROMPT_CHARS) return { error: promptTooLong(prompt.length), ok: false };
  const modelShapeError = describeModelShapeError(model);
  if (modelShapeError) return { error: `ERROR: ${modelShapeError}`, ok: false };
  return { input: { modelOverride: parseModelOverride(model), prompt }, ok: true };
}

export function parseModelOverride(model: unknown): ModelOverride | undefined {
  if (typeof model !== "string") return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash === -1) return { modelID: trimmed, providerID: "" };
  return { modelID: trimmed.slice(slash + 1), providerID: trimmed.slice(0, slash) };
}

// Admission-time shape check: a bare id (no provider prefix) fails LOUD with
// the qualified form. Shape only, never an allowlist — the server accepts ids
// not literally present in config, so unknown-but-qualified ids must pass.
// Null means admissible (absent and malformed-non-string inputs are ignored,
// as they always were: the override simply does not ride the prompt).
export function describeModelShapeError(model: unknown): string | null {
  if (model === undefined) return null;
  if (typeof model !== "string" || !model.trim()) return null;
  const parsed = parseModelOverride(model);
  if (parsed && !parsed.providerID) {
    return `Invalid model "${model.trim()}": use the fully-qualified providerID/modelID form as spelled in opencode.jsonc (e.g. "nvidia/z-ai/glm-5.3"). Bare model ids are rejected at admission — the provider prefix is required.`;
  }
  return null;
}

/**
 * Fire-and-forget by contract: the caller never awaits a prompt, so its turn is free
 * to end. The absent returned promise IS the contract — a caller that awaited it fails
 * to compile, which is what `fireAndForget`'s `void` is for.
 */
export function invokePrompt(
  host: OpaqueHost,
  sessionId: string,
  text: string,
  routing: PromptRouting = {},
  onFailure?: FailureReporter,
): void {
  fireAndForget(
    host,
    // v2 took routing OUT of the prompt: `SessionPromptInput` has no model and no
    // agent field at all, so the session is switched first and then prompted. Three
    // bounded writes where v1 did one, and that is the price of the current API.
    async (client) => {
      if (routing.agent !== undefined) await client.session.switchAgent({ agent: routing.agent, sessionID: sessionId });
      if (routing.model !== undefined)
        await client.session.switchModel({
          model: { id: routing.model.modelID, providerID: routing.model.providerID },
          sessionID: sessionId,
        });
      // The delivery verdict rides the prompt payload only when the caller set
      // one: the host routes "steer" at the next step boundary of a running
      // turn and parks "queue" until the turn ends. A prompt without one keeps
      // the host's own default, which is what every legacy call site wants.
      return client.session.prompt({ sessionID: sessionId, text, ...(routing.delivery !== undefined ? { delivery: routing.delivery } : {}) });
    },
    onFailure,
  );
}

// ─── classifyPromptError ───────────────────────────────────────────
// Maps a prompt transport failure to message + retryability. Vocabulary
// matches task_result's retryable states (ECONNREFUSED / ETIMEDOUT).

export interface PromptErrorClass {
  message: string;
  retryable: boolean;
}

const RETRYABLE_FRAGMENTS = [
  "econnrefused",
  "etimedout",
  "econnreset",
  "fetch failed",
  "network error",
  "timeout",
];

export function classifyPromptError(error: unknown): PromptErrorClass {
  const message = errorMessage(error);
  const lowered = message.toLowerCase();
  return {
    message,
    retryable: RETRYABLE_FRAGMENTS.some((fragment) => lowered.includes(fragment)),
  };
}

// A SETTLED outcome's transient markers used to live here, as a boolean that
// only decorated a sentence. They are now a named classification in
// `failure-class.ts` — which is a decision, not a hint, and so it has to carry
// the evidence and the conservative default with it. This module keeps only the
// markers that answer a question about a failed WRITE, which is a different
// question asked of a different error.

// ─── Message/Part family (Task 08 Cycle 5) ─────────────────────────
// The one hand-made type design in the program: the shapes the extraction
// group validates *toward*. Guards are the only door in — consumers below
// use the narrowed types instead of re-probing fields, so raw payloads are
// treated as text parts or messages only once they have proven themselves.

/**
 * The message roles this plugin knows, as an enum.
 *
 * An enum for the reason the rest of this plugin uses them: two sites branch on
 * a role, and a role compared as a raw literal compiles clean under a rename.
 * The host's own role vocabulary is OPEN — `messageRoleOf` answers with whatever
 * the payload said — so this names only the roles the plugin reads, and an
 * unrecognised one stays the string it was rather than becoming a type claim.
 *
 * The two aliases below are the roles anything actually branches on. They are
 * names rather than restatements of the members so a caller spells the decision
 * and not the wire word.
 */
enum MessageRole {
  User = "user",
  Assistant = "assistant",
  System = "system",
  Error = "error",
}

/** The only role the extraction group branches on. */
export const ASSISTANT_ROLE = MessageRole.Assistant;

/** The role a failed turn carries its error under. */
const ERROR_ROLE = MessageRole.Error;

const MESSAGE_ROLES: readonly string[] = Object.values(MessageRole);

/**
 * Is this string one of the message roles this plugin reads?
 *
 * A predicate over the enum's own values rather than a restated list, so a role
 * added to the vocabulary is recognised without anyone editing a table. It is
 * what makes the narrowing below a fact the compiler checks instead of a cast.
 */
function isMessageRole(role: string): role is MessageRole {
  return MESSAGE_ROLES.includes(role);
}

/**
 * The role a branch reads, narrowed to the vocabulary — or undefined.
 *
 * `messageRoleOf` answers with the host's own word, which is an OPEN vocabulary:
 * an unrecognised role must stay the string it was rather than become a type
 * claim. That is the right answer at the boundary and the wrong one at a `===`,
 * where comparing a raw string to an enum member is an unsafe comparison the
 * lint gate refuses — correctly, because it is the comparison that survives a
 * rename. Every branch that acts on a role narrows through here first.
 */
function branchedRoleOf(message: Message): MessageRole | undefined {
  const role = messageRoleOf(message);
  return isMessageRole(role) ? role : undefined;
}

export interface TextPart {
  type: "text";
  text: string;
}

export function isTextPart(value: unknown): value is TextPart {
  if (!isEventRecord(value)) return false;
  return value.type === "text" && typeof value.text === "string";
}

// Role arrives as `type` (v2) or top-level/nested-under-info `role` (v1);
// content arrives as `content` (v2) or `parts` (v1). Both spellings stay
// readable: the host speaks v2, old fixtures speak v1. Members are
// discriminated per part by isTextPart at read time.
//
// `parts` is OPTIONAL, and that is load-bearing. The host omits the key
// entirely on a turn that produced no output — an aborted turn arrives as
// role + error and nothing else. Requiring an array here made content
// presence a precondition for identity, so the empty turn was the one record
// the reader could not see: latestMessageErrorDetail walked past it, the
// settlement kept the host's `idle`, and a child that had been aborted was
// notified as a success. 51 of 421 settlements in the 2026-09 field corpus.
// A turn declares itself a message by its ROLE; parts are what it said, not
// what it is. Do not re-tighten this guard.
export interface Message {
  type?: unknown;
  role?: unknown;
  info?: unknown;
  time?: unknown;
  parts?: unknown[];
  content?: unknown[];
}

export function isMessage(value: unknown): value is Message {
  if (!isEventRecord(value)) return false;
  return (
    Array.isArray(value.parts) ||
    Array.isArray(value.content) ||
    messageRoleOf(value) !== ""
  );
}

export function messageRoleOf(message: Message): string {
  if (typeof message.type === "string" && message.type !== "") return message.type;
  const info = isEventRecord(message.info) ? message.info : undefined;
  const role = info?.role ?? message.role;
  return typeof role === "string" ? role : "";
}

/** The members a message speaks through, v2 first: `content`, then `parts`. */
function contentPartsOf(message: Message): unknown[] {
  if (Array.isArray(message.content)) return message.content;
  if (Array.isArray(message.parts)) return message.parts;
  return [];
}

// ─── extractTextFromParts ──────────────────────────────────────────
// (Moved verbatim from index.ts — prompt-result domain belongs to the
// dance. Text parts are probed through isTextPart, never cast.)

export function extractTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const out: string[] = [];
  for (const part of parts) {
    if (isTextPart(part)) out.push(part.text);
  }
  return out.join("\n");
}

/**
 * A tool call as the host's transcript carries it: `state.input` is untyped by
 * the SDK, so every field is read through a guard and the shape is never cast.
 */
export interface ToolPart {
  tool: string;
  input: Record<string, unknown>;
  incomplete: boolean;
}

/**
 * A tool call, projected out of the host's part shape, or null when the part is
 * not one.
 *
 * A PROJECTOR and not a type predicate, because the fields the reader needs —
 * `state.input` and `state.status` — are not on the part itself. A guard would
 * answer "is this a tool call" and leave the reader to reach back through the raw
 * record, and a predicate that returns true has already promised a shape whose
 * `status` is `undefined`: the first version of this did exactly that, and the
 * test that asked whether a rejected write was marked failed is what caught it.
 *
 * The status is normalized to a question rather than carried out, for two reasons
 * that are really one. A comparison against the host's raw `"error"` is a tag
 * compared as a string, which the strong-types gate exists to stop; and there is
 * a second answer the raw string cannot give honestly — a call still `running`
 * when its child died has ALSO not landed, and reporting it as anything but
 * incomplete would tell a resuming parent that a half-applied edit was a
 * finished one.
 */
export function toolCallOf(value: unknown): ToolPart | null {
  if (!isEventRecord(value) || value.type !== "tool") return null;
  const name = value.name ?? value.tool;
  if (typeof name !== "string") return null;
  if (!isEventRecord(value.state) || !isEventRecord(value.state.input)) return null;
  const {status} = value.state;
  return {
    incomplete: typeof status !== "string" || !LANDED_CALLS.has(status),
    input: value.state.input,
    tool: name,
  };
}

/**
 * The statuses that mean the change is on disk. The host's `ToolState` is a
 * closed union whose settled member is this one; everything else — pending,
 * running, error, or a word from a future host — is not on disk, which is the
 * only question this reader asks.
 */
const LANDED_CALLS: ReadonlySet<string> = new Set(["completed"]);

/**
 * The verbs that CHANGE a file.
 *
 * An allowlist, deliberately, and the reason is the corpus rather than taste:
 * queried against the host's own store, every tool that carries a `filePath` in
 * its input includes `read` — 36,951 of them — and also `glob`, `bash` and
 * `aft_search`, which name a path for their own reasons. A tool missing from this
 * set is simply not reported, so a new tool is a missing line and never a wrong
 * one. `read` is the trap that makes the set necessary: it shares the exact key
 * the mutators use.
 */
const MUTATING_TOOLS: ReadonlySet<string> = new Set(["edit", "write"]);

/** One file the child changed, or tried to. */
export interface FileTouch {
  verb: string;
  path: string;
  /**
   * The call never reported completion, so the file is probably NOT what the
   * child intended. That distinction is the point of keeping the verb: a
   * half-applied edit and a finished one look identical in a file listing and
   * are not the same amount of work to redo.
   */
  incomplete: boolean;
}

/**
 * The files a child changed, oldest first, deduplicated, from its own transcript.
 *
 * From the TRANSCRIPT rather than the working tree, and that is the whole design:
 * a project's dirty files belong to every child running against it at once, so
 * "what did this child change" cannot be answered by asking git — it can only be
 * answered by what this child actually called. It is also free: `task_result`
 * already reads this transcript to count messages, so the brief costs no host call
 * and nothing is added to the settlement's event head.
 */
export function touchedFiles(messages: unknown): FileTouch[] {
  if (!Array.isArray(messages)) return [];
  const seen = new Set<string>();
  const touches: FileTouch[] = [];
  for (const message of messages) {
    if (!isMessage(message)) continue;
    for (const part of contentPartsOf(message)) {
      const call = toolCallOf(part);
      if (call === null || !MUTATING_TOOLS.has(call.tool)) continue;
      // Through the family's own door rather than a bare `input.filePath`. The
      // SDK types this object as `{[key: string]: unknown}`, so a direct read is
      // the `noPropertyAccessFromIndexSignature` shape the strong-types doc names
      // as the next measurement to take — a new site written the known-wrong way
      // on the day that measurement is being prepared is a poor look.
      const filePath = eventString(call.input, "filePath");
      if (filePath === undefined) continue;
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      touches.push({ incomplete: call.incomplete, path: filePath, verb: call.tool });
    }
  }
  return touches;
}

/**
 * Read-only session message fetch, shared by every reader of a child.
 *
 * ONE chokepoint, bounded, and strict: a caller that reports what it read
 * (task_result) must be able to say a read failed, and a swallowed error would
 * print "(none yet)" for a child whose work exists. The tolerant reader is
 * `readLiveness`, which catches. It lived here and in `liveness` at once, with a
 * deadline on only one side, so the two readers of a child's transcript could
 * disagree about how long that child gets to describe itself.
 */
export async function readSessionMessages(
  host: OpaqueHost,
  sessionId: string,
  query?: { limit?: number },
): Promise<unknown[]> {
  // v2 renamed this call to `session.context` and flattened the id into `sessionID`.
  // The v1 `query.limit` had no counterpart — v2 returns the whole context — so the
  // limit is applied HERE, after the read, where it costs nothing and stays honest
  // about what the host actually said.
  const bounded = await callHost(host, READ_BOUNDS.transcript, (client) => client.session.context({ sessionID: sessionId }), null);
  // The throw is HERE, not in the timeout arm: an arm runs inside the timer callback,
  // where a throw escapes as an uncaught exception and leaves this promise pending
  // forever. The bound's job is to report, and the report has to be readable.
  if (bounded.timedOut) throw new Error(`transcript unanswered after ${READ_BOUNDS.transcript}ms`);
  const whole = extractMessages(bounded.value);
  return query?.limit === undefined ? whole : whole.slice(-query.limit);
}

// ─── extractMessages ───────────────────────────────────────────────
// (Moved verbatim from index.ts — message-shape handling belongs here.)

function extractMessages(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const payload = hostPayload(result);
  if (Array.isArray(payload)) return payload;
  const nested = eventField(payload, "messages");
  if (Array.isArray(nested)) return nested;
  return [];
}

// ─── getLatestAssistantText ────────────────────────────────────────
// (Moved verbatim from index.ts.)

/**
 * The ONE reverse walk over a message list. "The newest message decides" is a
 * property of the data, not a rule each reader has to re-derive: two readers
 * that each hand-wrote a backwards index loop could disagree about which end is
 * first, and a disagreement there is a stale error reported as the current one.
 * Total on a non-array — callers hand it whatever shape the host answered with.
 */
function* newestFirst(messages: unknown) {
  // Unknown in, unknown out: Array.isArray narrows to any[], so the elements
  // are re-read through unknown[] before yielding — otherwise the `any` leaks
  // to every transcript consumer through inference.
  const list: unknown[] = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) yield list[i];
}

export function getLatestAssistantText(messages: unknown): string {
  for (const msg of newestFirst(messages)) {
    if (!isMessage(msg)) continue;
    if (branchedRoleOf(msg) !== ASSISTANT_ROLE) continue;

    const text = extractTextFromParts(contentPartsOf(msg));
    return text;
  }

  return "";
}

// ─── message error detail + outcome hydration ──────────────────────
// The message stream is the ground truth for turn failures: a provider error
// ends the turn as "idle" with the cause on the message info, invisible to
// event status. These readers surface it so notifications never claim success
// for a failed turn.

// Provider failures (429/auth/overload) are recorded on the message INFO
// (AssistantMessage.error -> ApiError.data.message), never as a part type or
// a message role: a failed turn still has role "assistant" with empty text.
// Dual-era like messageRoleOf — the legacy flat { role: "error" } carried the
// cause in its text parts. Returns "" for a clean message.
export function messageErrorDetail(message: unknown): string {
  if (!isMessage(message) || !isEventRecord(message)) return "";
  const info = isEventRecord(message.info) ? message.info : undefined;
  const error = info?.error ?? message.error;
  if (isEventRecord(error)) {
    const data = isEventRecord(error.data) ? error.data : undefined;
    const detail =
      (typeof data?.message === "string" && data.message) ||
      (typeof error.message === "string" && error.message) ||
      (typeof error.name === "string" && error.name) ||
      "";
    return detail.trim();
  }
  if (typeof error === "string" && error.trim()) return error.trim();
  if (branchedRoleOf(message) === ERROR_ROLE) return extractTextFromParts(contentPartsOf(message)).trim();
  return "";
}

// The newest message decides — walking past it would resurface stale errors
// from earlier (retried) turns.
function latestMessageErrorDetail(messages: unknown): string {
  for (const message of newestFirst(messages)) {
    if (isMessage(message)) return messageErrorDetail(message);
  }
  return "";
}

// One read of the message stream supplies BOTH the latest assistant text and
// the message-level error detail — a terminal "idle" event can hide a provider
// failure that only the message info reveals. Never throws: failures yield
// empty fields and callers degrade to event-status-only reporting. Bounded for
// the same reason from the other side — a read that never SETTLES would park
// the parent notification behind it, which a never-throws contract does not
// prevent. `unreadable` is the honest report of that: no fields because the
// transcript could not be read, not because the child said nothing.
export interface HydratedOutcome {
  text: string;
  errorDetail: string;
  unreadable: boolean;
}

export async function hydrateLatestOutcome(
  host: OpaqueHost,
  sessionId: string,
): Promise<HydratedOutcome> {
  const blank: HydratedOutcome = { errorDetail: "", text: "", unreadable: true };
  try {
    // Through the shared transcript read, which is where the bound lives. It used
    // to be a second chokepoint with its own deadline, so the two could disagree
    // about how long a child gets to describe itself.
    const messages = await readSessionMessages(host, sessionId);
    return {
      errorDetail: latestMessageErrorDetail(messages),
      text: getLatestAssistantText(messages),
      unreadable: false,
    };
  } catch {
    return blank;
  }
}

// ─── liveness ───────────────────────────────────────────────────────
// Liveness used to be inferred here, from the session record's absent status
// field and from the shape of the message tail. Both inferences were wrong in
// ways the field reproduced: a child that had just written a message read
// "completed" while still working, and a turn that had only ever written one
// message could not be distinguished from a finished one. It now lives in
// liveness.ts, reading the server's status channel and the child's own
// message clock — two sources, named as such, no guessing.

