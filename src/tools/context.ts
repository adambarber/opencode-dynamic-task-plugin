// Shared tool context (entry/tools boundary): everything a tool executor
// needs, owned in one place so no executor reaches past the funnel.
import type { ToolContext } from "@opencode-ai/plugin";
import type { OpenCodeClient } from "../shared/client.js";
import type { DynamicTaskConfig } from "../shared/config.js";
import type { TaskStore } from "../shared/task-state.js";
import { findTask } from "../shared/task-state.js";
import { isEventRecord, resolveParentSessionId } from "../shared/session-lifecycle.js";
import { extractMessages } from "../shared/prompt.js";
import { formatTaskResultSummary } from "../shared/task-formatting.js";

export interface ToolDeps {
  client: OpenCodeClient;
  store: TaskStore;
  config: DynamicTaskConfig;
  directory: string;
}

// Shared arg guard: every session-scoped tool rejects empty ids identically.
// (Module-private in the old entry: the host invokes every entry export as a
// candidate plugin function, so only the default export is public.)
export function missingSessionId(args: unknown): string | null {
  if (!isEventRecord(args) || !args.session_id) return "ERROR: session_id is required.";
  return null;
}

// Single shape for unknown sessions across all tools — the same markdown
// voice as every other read (never raw JSON).
export function unknownSessionResult(sessionId: string): string {
  return formatTaskResultSummary({
    sessionId,
    status: "unknown",
    messageCount: 0,
    latestText: "(No session record found)",
    tracked: false,
  });
}

// Read-only session message fetch shared by the session readers.
export async function readSessionMessages(client: OpenCodeClient, sessionId: string): Promise<unknown[]> {
  const messagesResult = await client.session.messages({ path: { id: sessionId } });
  return extractMessages(messagesResult);
}

// Lineage from current session (for nested dynamic_task calls).
export function createDummyLineage(ctx: ToolContext, store: TaskStore): string[] {
  const callerSessionId = resolveParentSessionId(ctx);
  if (!callerSessionId || callerSessionId === "unknown") return [];
  const callerTask = findTask(store, callerSessionId);
  if (callerTask) {
    // The stored lineage already ends with the caller's own agent (it was
    // built as admission.newLineage) — re-appending it would double-count.
    return [...callerTask.lineage];
  }
  return [];
}
