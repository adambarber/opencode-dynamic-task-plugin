// Session read executors (result/status/list): store-authoritative views with
// the server's own liveness read beside them. Pure readers — they mutate
// nothing except read-path TTL pruning.
import { eventField, errorMessage } from "../shared/session-lifecycle.js";
import { getLatestAssistantText } from "../shared/prompt.js";
import { getLatestNotification, getTurnNotification } from "../shared/notify.js";
import { readLiveness, readSessionMessages, statusFromHostState, type LivenessReading } from "../shared/liveness.js";
import {
  formatTaskResultSummary,
  formatTaskListSummary,
  formatTaskStatusDetail,
} from "../shared/task-formatting.js";
import { pruneRetainedTasks, findTask, listTasks } from "../shared/task-state.js";
import { unknownSessionResult, type ResolvedSessionScope, type ToolDeps } from "./context.js";

// The prologue both readers share: resolve the session, prune, look up. Pruning
// first is the point — a retained record past its TTL must not answer as though
// it were live — and both readers depend on that order, so it is one function
// rather than two copies free to drift.
function readTarget(scope: ResolvedSessionScope) {
  pruneRetainedTasks(scope.store, scope.config);
  const { client, sessionId } = scope;
  return { client, sessionId, task: findTask(scope.store, sessionId) };
}

export async function executeTaskResult(scope: ResolvedSessionScope): Promise<string> {
  const { client, sessionId, task } = readTarget(scope);
  try {
    const messages = await readSessionMessages(client, sessionId);
    // One read, one rendering. The store's word when it has a record, the
    // server's own word when it does not — and never a guess about message
    // shapes, which is what used to make a working child read as completed.
    const liveness = await readLivenessSafely(client, sessionId, messages);
    return formatTaskResultSummary({
      sessionId,
      status: task ? task.state : statusFromHostState(liveness?.hostState ?? null),
      messageCount: messages.length,
      latestText: getLatestAssistantText(messages) || "(No assistant text found)",
      tracked: task !== undefined,
      notification: task ? getTurnNotification(sessionId, task.startedAt) : getLatestNotification(sessionId),
      task: task ?? null,
      liveness,
    });
  } catch (err: unknown) {
    // 404 or network error → unknown/error states in the same markdown voice.
    const message = errorMessage(err);
    const status = eventField(err, "status");
    const code = eventField(err, "code");
    if (status === 404 || message.includes("not found")) {
      return unknownSessionResult(sessionId);
    }
    const retryable = code === "ECONNREFUSED" || code === "ETIMEDOUT";
    if (!task) {
      return formatTaskResultSummary({
        sessionId,
        status: "error",
        messageCount: 0,
        latestText: "(See error above)",
        tracked: false,
        error: `${message || "Network error querying session"}${retryable ? " (retryable)" : " (not retryable)"}`,
      });
    }
    // A tracked task whose read failed still has a store state to report, and
    // saying so is the honest answer — the liveness block is simply absent.
    return formatTaskResultSummary({
      sessionId,
      status: task.state,
      messageCount: 0,
      latestText: "(API unavailable)",
      tracked: true,
      notification: getTurnNotification(sessionId, task.startedAt),
    });
  }
}

export async function executeTaskStatus(scope: ResolvedSessionScope): Promise<string> {
  const { client, sessionId, task } = readTarget(scope);
  if (!task) {
    return unknownSessionResult(sessionId);
  }
  // The same read task_result makes: a status view that cannot see the server's
  // own word is not a status view, and the two tools answering differently
  // about one child is how a reader comes to the wrong recovery.
  return formatTaskStatusDetail(
    task,
    getTurnNotification(sessionId, task.startedAt),
    await readLivenessSafely(client, sessionId),
  );
}

// Liveness is a read, not a precondition: a status view must render the record
// it has even when the server cannot be asked. A failed read says so, which is
// the difference between "the server says idle" and "the server did not answer".
async function readLivenessSafely(
  client: ResolvedSessionScope["client"],
  sessionId: string,
  messages?: unknown[],
): Promise<LivenessReading | null> {
  try {
    return await readLiveness(client, sessionId, messages);
  } catch {
    return null;
  }
}

export async function executeTaskList(deps: ToolDeps): Promise<string> {
  const { store, config } = deps;
  const pruned = pruneRetainedTasks(store, config);
  const { active, retained } = listTasks(store);
  const toRow = (t: { childSessionId: string; agentName: string; description: string; state: string; startedAt: number }) => ({
    childSessionId: t.childSessionId,
    agentName: t.agentName,
    description: t.description,
    state: t.state,
    startedAt: t.startedAt,
  });
  return formatTaskListSummary({
    active: active.map(toRow),
    retained: retained.map(toRow),
    maxConcurrent: config.maxConcurrent,
    pruned,
  });
}
