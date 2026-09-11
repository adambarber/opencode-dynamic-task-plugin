// src/shared/prompt.ts
// Prompt invocation dance (Task 03) — the ONLY module that builds
// session.prompt payloads and invokes them. Siblings call invokePrompt;
// error meaning is classified in one place via classifyPromptError.
// Result hydration semantics (single-wait, content-first) land here in
// Task 03 proper; the funnel exists now so no new prompt path can bypass it.

// ─── invokePrompt ──────────────────────────────────────────────────
// Builds the single payload shape and invokes it. Rejects with the raw
// client error — callers classify via classifyPromptError.

export function invokePrompt(client: any, sessionId: string, text: string): Promise<unknown> {
  return client.session.prompt({
    path: { id: sessionId },
    body: { parts: [{ type: "text", text }] },
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
  const message =
    (error as any)?.message !== undefined && (error as any)?.message !== null
      ? String((error as any).message)
      : String(error);
  const lowered = message.toLowerCase();
  return {
    message,
    retryable: RETRYABLE_FRAGMENTS.some((fragment) => lowered.includes(fragment)),
  };
}

// ─── extractTextFromParts ──────────────────────────────────────────
// (Moved verbatim from index.ts — prompt-result domain belongs to the dance.)

export function extractTextFromParts(parts: any[]): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
    .map((p: any) => p.text)
    .join("\n");
}

// ─── extractTextFromPromptResult ───────────────────────────────────
// (Moved verbatim from index.ts.)

export function extractTextFromPromptResult(result: any): string {
  const candidates = [
    result?.parts,
    result?.data?.parts,
    result?.body?.parts,
    result?.message?.parts,
    result?.data?.message?.parts,
    result?.body?.message?.parts,
  ];

  for (const parts of candidates) {
    const text = extractTextFromParts(parts);
    if (text.trim()) return text;
  }

  const messageCandidates = [
    result?.text,
    result?.data?.text,
    result?.body?.text,
    result?.content,
    result?.data?.content,
    result?.body?.content,
  ];

  for (const text of messageCandidates) {
    if (typeof text === "string" && text.trim()) return text;
  }

  return "";
}
