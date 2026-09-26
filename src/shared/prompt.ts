// src/shared/prompt.ts
// Prompt invocation dance (Task 03) — the ONLY module that builds
// session.prompt payloads and invokes them. Siblings call invokePrompt;
// error meaning is classified in one place via classifyPromptError.
// Result hydration semantics (single-wait, content-first) land here in
// Task 03 proper; the funnel exists now so no new prompt path can bypass it.

import type { OpenCodeClient } from "./client.js";
import { MAX_PROMPT_CHARS, promptTooLong } from "./voice.js";
import { eventField, isEventRecord, errorMessage, hostPayload } from "./session-lifecycle.js";
import { withBound, READ_BOUNDS } from "./execution-bound.js";

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
): { ok: true; input: AdmittedPromptInput } | { ok: false; error: string } {
  if (!prompt || typeof prompt !== "string") return { ok: false, error: absentPromptVoice };
  if (prompt.length > MAX_PROMPT_CHARS) return { ok: false, error: promptTooLong(prompt.length) };
  const modelShapeError = describeModelShapeError(model);
  if (modelShapeError) return { ok: false, error: `ERROR: ${modelShapeError}` };
  return { ok: true, input: { prompt, modelOverride: parseModelOverride(model) } };
}

export function parseModelOverride(model: unknown): ModelOverride | undefined {
  if (typeof model !== "string") return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash < 0) return { providerID: "", modelID: trimmed };
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
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

export function invokePrompt(
  client: OpenCodeClient,
  sessionId: string,
  text: string,
  routing: PromptRouting = {},
): Promise<unknown> {
  return client.session.prompt({
    path: { id: sessionId },
    body: {
      parts: [{ type: "text", text }],
      ...(routing.agent !== undefined ? { agent: routing.agent } : {}),
      ...(routing.model !== undefined ? { model: routing.model } : {}),
    },
  });
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

// Advisory-only transient markers for settled outcomes. Unlike
// RETRYABLE_FRAGMENTS (which gate the prompt-failure path), these never
// decide anything — they annotate the settlement so the parent can judge
// "safe to task_continue". Heuristics are permitted here precisely because
// they are not load-bearing (Tenet 2): the worst case is a wrong hint, never
// a wrong state.
const TRANSIENT_OUTCOME_FRAGMENTS = [
  ...RETRYABLE_FRAGMENTS,
  "429",
  "rate limit",
  "overload",
  "temporar",
  "unavailable",
  "500",
  "502",
  "503",
];

export function isTransientOutcomeError(detail: unknown): boolean {
  if (typeof detail !== "string" || !detail.trim()) return false;
  const lowered = detail.toLowerCase();
  return TRANSIENT_OUTCOME_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

// ─── Message/Part family (Task 08 Cycle 5) ─────────────────────────
// The one hand-made type design in the program: the shapes the extraction
// group validates *toward*. Guards are the only door in — consumers below
// use the narrowed types instead of re-probing fields, so raw payloads are
// treated as text parts or messages only once they have proven themselves.

export type MessageRole = "user" | "assistant" | "system" | "error";

// The only role the extraction group branches on. Unknown role strings in
// raw payloads stay data (messageRoleOf returns them unvalidated), never
// type claims.
export const ASSISTANT_ROLE: MessageRole = "assistant";

export interface TextPart {
  type: "text";
  text: string;
}

export function isTextPart(value: unknown): value is TextPart {
  if (!isEventRecord(value)) return false;
  return value.type === "text" && typeof value.text === "string";
}

// Role arrives top-level or nested under info depending on the hydration
// era (the shape this family exists to absorb); parts stay unknown[] —
// text members are discriminated per part by isTextPart at read time.
export interface Message {
  role?: unknown;
  info?: unknown;
  parts: unknown[];
}

export function isMessage(value: unknown): value is Message {
  return isEventRecord(value) && Array.isArray(value.parts);
}

export function messageRoleOf(message: Message): string {
  const info = isEventRecord(message.info) ? message.info : undefined;
  const role = info?.role ?? message.role;
  return typeof role === "string" ? role : "";
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

// ─── extractMessages ───────────────────────────────────────────────
// (Moved verbatim from index.ts — message-shape handling belongs here.)

export function extractMessages(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const payload = hostPayload(result);
  if (Array.isArray(payload)) return payload;
  const nested = eventField(payload, "messages");
  if (Array.isArray(nested)) return nested;
  return [];
}

// ─── getLatestAssistantText ────────────────────────────────────────
// (Moved verbatim from index.ts.)

export function getLatestAssistantText(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isMessage(msg)) continue;
    if (messageRoleOf(msg) !== ASSISTANT_ROLE) continue;

    const text = extractTextFromParts(msg.parts);
    if (text.trim()) return text;
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
  if (messageRoleOf(message) === "error") return extractTextFromParts(message.parts).trim();
  return "";
}

// The newest message decides — walking past it would resurface stale errors
// from earlier (retried) turns.
function latestMessageErrorDetail(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
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
  client: OpenCodeClient,
  sessionId: string,
): Promise<HydratedOutcome> {
  const blank: HydratedOutcome = { text: "", errorDetail: "", unreadable: true };
  try {
    const bounded = await withBound(
      READ_BOUNDS.transcript,
      () => client.session.messages({ path: { id: sessionId } }),
      () => null,
    );
    if (bounded.timedOut) return blank;
    const messages = extractMessages(bounded.value);
    return {
      text: getLatestAssistantText(messages),
      errorDetail: latestMessageErrorDetail(messages),
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

