// src/shared/prompt.ts
// Prompt invocation dance (Task 03) — the ONLY module that builds
// session.prompt payloads and invokes them. Siblings call invokePrompt;
// error meaning is classified in one place via classifyPromptError.
// Result hydration semantics (single-wait, content-first) land here in
// Task 03 proper; the funnel exists now so no new prompt path can bypass it.

import type { OpenCodeClient } from "./client.js";
import { eventField, isEventRecord, errorMessage } from "./session-lifecycle.js";

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

export function parseModelOverride(model: unknown): ModelOverride | undefined {
  if (typeof model !== "string") return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash < 0) return { providerID: "", modelID: trimmed };
  return { providerID: trimmed.slice(0, slash), modelID: trimmed.slice(slash + 1) };
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

// ─── extractTextFromPromptResult ───────────────────────────────────
// (Moved verbatim from index.ts.)

export function extractTextFromPromptResult(result: unknown): string {
  const candidates = [
    eventField(result, "parts"),
    eventField(result, "data", "parts"),
    eventField(result, "body", "parts"),
    eventField(result, "message", "parts"),
    eventField(result, "data", "message", "parts"),
    eventField(result, "body", "message", "parts"),
  ];

  for (const parts of candidates) {
    const text = extractTextFromParts(parts);
    if (text.trim()) return text;
  }

  const messageCandidates = [
    eventField(result, "text"),
    eventField(result, "data", "text"),
    eventField(result, "body", "text"),
    eventField(result, "content"),
    eventField(result, "data", "content"),
    eventField(result, "body", "content"),
  ];

  for (const text of messageCandidates) {
    if (typeof text === "string" && text.trim()) return text;
  }

  return "";
}

// ─── extractMessages ───────────────────────────────────────────────
// (Moved verbatim from index.ts — message-shape handling belongs here.)

export function extractMessages(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const data = eventField(result, "data");
  if (Array.isArray(data)) return data;
  const nested = eventField(result, "body", "messages");
  if (Array.isArray(nested)) return nested;
  return [];
}

// ─── getLatestAssistantText ────────────────────────────────────────
// (Moved verbatim from index.ts.)

export function getLatestAssistantText(messages: unknown, startIndex: number = 0): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const from = Math.max(0, startIndex);

  for (let i = messages.length - 1; i >= from; i--) {
    const msg = messages[i];
    if (!isMessage(msg)) continue;
    if (messageRoleOf(msg) !== ASSISTANT_ROLE) continue;

    const text = extractTextFromParts(msg.parts);
    if (text.trim()) return text;
  }

  return "";
}

// ─── hydrateLatestText ─────────────────────────────────────────────
// Best-effort read of the latest assistant text for notifications and
// summaries. Never throws: failures yield "" and callers apply their own
// fallback marker — hydration must never break completion reporting.

export async function hydrateLatestText(
  client: OpenCodeClient,
  sessionId: string,
  startIndex = 0,
): Promise<string> {
  try {
    const messagesResult = await client.session.messages({ path: { id: sessionId } });
    const messages = extractMessages(messagesResult);
    return getLatestAssistantText(messages, startIndex);
  } catch {
    return "";
  }
}
