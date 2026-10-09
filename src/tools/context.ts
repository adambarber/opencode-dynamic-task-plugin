// Shared tool context (entry/tools boundary): everything a tool executor
// needs, owned in one place so no executor reaches past the funnel.
//jscpd:ignore-start
import type { DynamicTaskConfig } from "../shared/config.js";
import type { IntentStore } from "../shared/create-intent.js";
import { NO_SESSION_RECORD, formatTaskResultSummary, taskResultRecord } from "../shared/task-formatting.js";
import type { OpaqueHost } from "../shared/client.js";
import type { Refusal } from "../shared/verdict.js";
import { type SessionId, sessionIdOf } from "../shared/ids.js";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { UntrackedStatus } from "../shared/liveness.js";
import { findTask, type TaskRecord, type TaskStore } from "../shared/task-state.js";
import { isEventRecord } from "../shared/host-shape.js";
import { isParentless, resolveParentSessionId } from "../shared/session-lifecycle.js";

//jscpd:ignore-end
export interface ToolDeps {
  host: OpaqueHost;
  /** Durable writes for issued-but-unanswered creates; the same chain as the ledger. */
  intent: IntentStore;
  store: TaskStore;
  config: DynamicTaskConfig;
  directory: string;
}

// Shared arg guard: every session-scoped tool rejects empty ids identically.
// (Module-private in the old entry: the host invokes every entry export as a
// candidate plugin function, so only the default export is public.)
/** The one sentence for a session-scoped tool asked to run without a usable id. */
const MISSING_SESSION_ID = "ERROR: session_id is required.";

function missingSessionId(args: unknown): string | null {
  if (!isEventRecord(args) || !args.session_id) return MISSING_SESSION_ID;
  return null;
}

/**
 * The session scope a session-scoped tool runs in. Resolution is ONE function, and
 * the resolved branch is the only thing an executor can accept: the guard and the
 * id read are the same hazard — an executor that destructures deps first and reads
 * `args.session_id` later can query the store under "" while its sibling refuses.
 * Making the resolved scope the executor's parameter means "ran with an empty id"
 * is unrepresentable past the tool map, not merely discouraged inside four files.
 *
 * `ToolDeps` minus the one field a session-scoped tool has no business reading,
 * rather than three of its four fields written out again. The field it drops is the
 * whole argument for deriving instead of restating: a session has no directory of
 * its own, and a copy of the list could not say so — it could only omit a field,
 * which is indistinguishable from forgetting one. A fourth dependency added to
 * `ToolDeps` reaches every executor automatically now, and the session-scoped ones
 * will say so by failing to compile if they were relying on it not arriving.
 *
 * `callerSessionId` is the other half of the same hazard and the reason the guard
 * is possible: `sessionId` is what the tool was ASKED to act on, read from the
 * arguments, and `callerSessionId` is who is asking, read from the host's context.
 * They are the same kind of value and routinely the same id, which is precisely why
 * they are two named fields and not one. `task_interrupt` and `task_continue` both
 * stop a session, and a tool that cannot see who called it cannot tell a caller
 * naming its own session from one naming a child's — the confusion that had the
 * plugin asking the server to kill the turn it was speaking in. Undefined means the
 * host named no caller, which is not the same as "no caller": such a call has
 * nothing to be protected FROM, so ownership falls back to the store alone.
 */
export type ResolvedSessionScope = Omit<ToolDeps, "directory"> & {
  sessionId: SessionId;
  callerSessionId: string | undefined;
};

export type SessionScope = { ok: true; scope: ResolvedSessionScope } | Refusal;

export function openSessionScope(deps: ToolDeps, args: unknown, ctx: ToolContext): SessionScope {
  const missing = missingSessionId(args);
  if (missing) return { error: missing, ok: false };
  const sessionId = sessionIdOf(String(isEventRecord(args) ? args.session_id : undefined));
  // The mint is the SECOND half of the guard, not a formality: `missingSessionId`
  // above answers "is there a value", and a whitespace-only id is one it passes on.
  // The mint answers the question the guard cannot, and its refusal is the same
  // sentence in the same voice, so an executor never sees an id it did not earn.
  if (sessionId === undefined) return { error: MISSING_SESSION_ID, ok: false };
  return {
    ok: true,
    scope: {
      callerSessionId: callerSessionId(ctx),
      config: deps.config,
      host: deps.host,
      intent: deps.intent,
      store: deps.store,
      sessionId,
    },
  };
}

// Single shape for unknown sessions across all tools — the same markdown
// voice as every other read (never raw JSON).
export function unknownSessionResult(sessionId: SessionId): string {
  return formatTaskResultSummary(
    taskResultRecord({ latestText: NO_SESSION_RECORD, sessionId, status: UntrackedStatus.Unknown }),
  );
}

/**
 * The caller of the current tool, as the tool layer sees it: the host's word for
 * the calling session, or undefined when it gave none — `unknown` IS that word,
 * so it is treated as no caller at all. The two child-side tools that need a
 * caller (a notice, a nested dispatch) resolve it here rather than each
 * re-implementing what "the host named no session" means.
 */
export function callerSessionId(ctx: ToolContext): SessionId | undefined {
  const caller = resolveParentSessionId(ctx);
  if (isParentless(caller)) return undefined;
  return caller;
}

/** The caller's own record, or undefined when there is no caller or it is not one of ours. */
export function callerTask(ctx: ToolContext, store: TaskStore): TaskRecord | undefined {
  const caller = callerSessionId(ctx);
  return caller === undefined ? undefined : (findTask(store, caller) ?? undefined);
}

// Lineage from current session (for nested dynamic_task calls).
export function createDummyLineage(ctx: ToolContext, store: TaskStore): string[] {
  const task = callerTask(ctx, store);
  // The stored lineage already ends with the caller's own agent (it was
  // built as admission.newLineage) — re-appending it would double-count.
  return task ? [...task.lineage] : [];
}