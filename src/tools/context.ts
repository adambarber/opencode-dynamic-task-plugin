// Shared tool context (entry/tools boundary): everything a tool executor
// needs, owned in one place so no executor reaches past the funnel.
import type { ToolContext } from "@opencode-ai/plugin";
import type { OpenCodeClient } from "../shared/client.js";
import type { DynamicTaskConfig } from "../shared/config.js";
import type { TaskStore } from "../shared/task-state.js";
import { findTask } from "../shared/task-state.js";
import { isEventRecord, resolveParentSessionId } from "../shared/session-lifecycle.js";
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
function missingSessionId(args: unknown): string | null {
  if (!isEventRecord(args) || !args.session_id) return "ERROR: session_id is required.";
  return null;
}

// The session scope a session-scoped tool runs in. Resolution is ONE
// function, and the resolved branch is the only thing an executor can accept:
// the guard and the id read are the same hazard — an executor that
// destructures deps first and reads `args.session_id` later can query the
// store under "" while its sibling refuses. Making the resolved scope the
// executor's parameter means "ran with an empty id" is unrepresentable past
// the tool map, not merely discouraged inside four files.
export interface ResolvedSessionScope {
  sessionId: string;
  client: OpenCodeClient;
  store: TaskStore;
  config: DynamicTaskConfig;
}

export type SessionScope =
  | { ok: true; scope: ResolvedSessionScope }
  | { ok: false; error: string };

export function openSessionScope(deps: ToolDeps, args: unknown): SessionScope {
  const missing = missingSessionId(args);
  if (missing) return { ok: false, error: missing };
  return {
    ok: true,
    scope: {
      sessionId: String((args as { session_id: string }).session_id),
      client: deps.client,
      store: deps.store,
      config: deps.config,
    },
  };
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
