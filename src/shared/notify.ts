// src/shared/notify.ts
// Parent-notification gate (Task 05) — the ONLY module that delivers
// parent-directed messages. Kinds are constructed here via
// resolveNotifyKind; every delivery is attempted, retried once after a
// short delay, and recorded in a bounded ledger that task_result surfaces.
// A failed delivery is data, not silence: the record carries the cause and
// the planner recovers by reading.

export type NotifyKind = "timeout" | "completed" | "completed_after_timeout" | "error";

export interface NotificationRecord {
  childSessionId: string;
  parentSessionId: string;
  kind: NotifyKind;
  delivered: boolean;
  attempts: number;
  error?: string;
  at: number;
}

// Bound for the in-memory ledger (Tenet 7: named, single place).
export const MAX_NOTIFICATION_RECORDS = 200;

const ledger: NotificationRecord[] = [];

/** Test seam: clears the ledger. Production code never calls this. */
export function resetNotificationLog(): void {
  ledger.length = 0;
}

export function getLatestNotification(childSessionId: string): NotificationRecord | undefined {
  for (let i = ledger.length - 1; i >= 0; i--) {
    const rec = ledger[i];
    if (rec && rec.childSessionId === childSessionId) return rec;
  }
  return undefined;
}

// ─── resolveNotifyKind ─────────────────────────────────────────────
// Single site where notification kinds are constructed. Timeout triggers
// always map to timeout; event triggers map status plus whether a timeout
// was already reported (the completed_after_timeout race).

export function resolveNotifyKind(
  trigger: "event" | "timeout",
  status: string,
  timeoutNotified: boolean,
): NotifyKind {
  if (trigger === "timeout") return "timeout";
  if (status === "error") return "error";
  if (timeoutNotified) return "completed_after_timeout";
  return "completed";
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

// ─── notifyParent ──────────────────────────────────────────────────
// Delivers with exactly one retry, then records the outcome either way.
// Never throws — transport failure is returned as data.

import type { OpenCodeClient } from "./client.js";
import { errorMessage } from "./session-lifecycle.js";

export async function notifyParent(
  client: OpenCodeClient,
  parentSessionId: string,
  message: string,
  meta: { childSessionId: string; kind: NotifyKind },
  opts: { retryDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<NotificationRecord> {
  const sleep = opts.sleep ?? defaultSleep;
  const delayMs = opts.retryDelayMs ?? 250;
  const record: NotificationRecord = {
    childSessionId: meta.childSessionId,
    parentSessionId,
    kind: meta.kind,
    delivered: false,
    attempts: 0,
    at: Date.now(),
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    record.attempts = attempt;
    try {
      await client.session.prompt({
        path: { id: parentSessionId },
        body: { parts: [{ type: "text", text: message }] },
      });
      record.delivered = true;
      break;
  } catch (error: unknown) {
    record.error = errorMessage(error) || String(error);
    if (attempt < 2) await sleep(delayMs);
  }
  }

  ledger.push(record);
  while (ledger.length > MAX_NOTIFICATION_RECORDS) ledger.shift();
  return record;
}
