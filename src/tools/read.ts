// Session read executors (result/status/list): store-authoritative views with
// advisory live reads. Pure readers — they mutate nothing except read-path
// TTL pruning.
import { eventField, errorMessage } from "../shared/session-lifecycle.js";
import { getLatestAssistantText, extractSessionStatus } from "../shared/prompt.js";
import { getLatestNotification, getTurnNotification } from "../shared/notify.js";
import {
  formatTaskResultSummary,
  formatTaskListSummary,
  formatTaskStatusDetail,
} from "../shared/task-formatting.js";
import { pruneRetainedTasks, findTask, listTasks } from "../shared/task-state.js";
import { missingSessionId, unknownSessionResult, readSessionMessages, type ToolDeps } from "./context.js";

export interface ReadArgs {
  session_id?: string | undefined;
}

export async function executeTaskResult(deps: ToolDeps, args: ReadArgs): Promise<string> {
  const { client, store, config } = deps;
  const missing = missingSessionId(args);
  if (missing) return missing;
  const sessionId = String(args.session_id ?? "");

  pruneRetainedTasks(store, config);
  const task = findTask(store, sessionId);
  if (task) {
    try {
      const sessionInfo = await client.session.get({ path: { id: sessionId } });
      const messages = await readSessionMessages(client, sessionId);
      // The store is the liveness authority: Status reports the tracked
      // state verbatim and never contradicts the task_continue gate.
      // The live API inference is advisory only — a child that just
      // wrote text (e.g. a task_notify) reads "completed" from the
      // message stream while still active, so it renders as a
      // subordinate block, computed for active tasks alone.
      const live = task.state === "active"
        ? extractSessionStatus(sessionInfo, messages)
        : undefined;

      return formatTaskResultSummary({
        sessionId,
        status: task.state,
        messageCount: messages.length,
        latestText: getLatestAssistantText(messages) || "(No assistant text found)",
                tracked: true,
                notification: getTurnNotification(sessionId, task.startedAt),
                liveStatus: live,
      });
    } catch {
      // API error — return what we know from state
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

  // Not in our state — query API, gracefully handle errors
  try {
    const sessionInfo = await client.session.get({ path: { id: sessionId } });
    const messages = await readSessionMessages(client, sessionId);
    const status = extractSessionStatus(sessionInfo, messages);

    return formatTaskResultSummary({
      sessionId,
      status,
      messageCount: messages.length,
      latestText: getLatestAssistantText(messages) || "(No assistant text found)",
      tracked: false,
      notification: getLatestNotification(sessionId),
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
    return formatTaskResultSummary({
      sessionId,
      status: "error",
      messageCount: 0,
      latestText: "(See error above)",
      tracked: false,
      error: `${message || "Network error querying session"}${retryable ? " (retryable)" : " (not retryable)"}`,
    });
  }
}

export async function executeTaskStatus(deps: ToolDeps, args: ReadArgs): Promise<string> {
  const { store, config } = deps;
  const missing = missingSessionId(args);
  if (missing) return missing;
  const sessionId = String(args.session_id ?? "");

  pruneRetainedTasks(store, config);
  const task = findTask(store, sessionId);
  if (!task) {
    return unknownSessionResult(sessionId);
  }
  return formatTaskStatusDetail(task, getTurnNotification(sessionId, task.startedAt));
}

export async function executeTaskList(deps: ToolDeps): Promise<string> {
  const { store, config } = deps;
  pruneRetainedTasks(store, config);
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
  });
}
