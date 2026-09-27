// Session read executors (result/status/list): store-authoritative views with
// the server's own liveness read beside them. Pure readers — they mutate
// nothing except read-path TTL pruning.
import { errorMessage } from "../shared/host-shape.js";
import { eventField } from "../shared/host-shape.js";
import { getLatestAssistantText } from "../shared/prompt.js";
import { getLatestNotification, getTurnNotification } from "../shared/notify.js";
import {
  readLiveness,
  readSessionMessages,
  statusFromHostState,
  type LivenessReading,
} from "../shared/liveness.js";
import {
  formatTaskResultSummary,
  formatTaskListSummary,
  formatTaskStatusDetail,
  taskResultRecord,
  NO_ASSISTANT_TEXT,
  SEE_ERROR_ABOVE,
  API_UNAVAILABLE,
  type FleetRow,
} from "../shared/task-formatting.js";
import { pruneRetainedTasks, findTask, listTasks, TaskState } from "../shared/task-state.js";
import { dispatchForest, type DispatchNode } from "../shared/dispatch-tree.js";
import { activeByAgent } from "../shared/task-state.js";
import { dispatchableAgentNamesOrNull } from "../shared/admission.js";
import { agentOccupancy } from "../shared/caps.js";
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
    return formatTaskResultSummary(
      taskResultRecord({
        sessionId,
        status: task ? task.state : statusFromHostState(liveness?.hostState ?? null),
        messageCount: messages.length,
        latestText: getLatestAssistantText(messages) || NO_ASSISTANT_TEXT,
        tracked: task !== undefined,
        notification: task ? getTurnNotification(sessionId, task.startedAt) : getLatestNotification(sessionId),
        task: task ?? null,
        liveness,
      }),
    );
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
      return formatTaskResultSummary(
        taskResultRecord({
          sessionId,
          status: TaskState.Error,
          latestText: SEE_ERROR_ABOVE,
          error: `${message || "Network error querying session"}${retryable ? " (retryable)" : " (not retryable)"}`,
        }),
      );
    }
    // A tracked task whose read failed still has a store state to report, and
    // saying so is the honest answer — the liveness block is simply absent.
    return formatTaskResultSummary(
      taskResultRecord({
        sessionId,
        status: task.state,
        latestText: API_UNAVAILABLE,
        tracked: true,
        notification: getTurnNotification(sessionId, task.startedAt),
      }),
    );
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
// The parameters are readLiveness's own, so this wrapper cannot answer a
// different question than the reader it wraps if that reader grows an argument.
async function readLivenessSafely(
  ...args: Parameters<typeof readLiveness>
): Promise<LivenessReading | null> {
  try {
    return await readLiveness(...args);
  } catch {
    return null;
  }
}

export async function executeTaskList(deps: ToolDeps): Promise<string> {
  const { client, store, config } = deps;
  const pruned = pruneRetainedTasks(store, config);
  const { retained } = listTasks(store);
  // The row shape is FleetRow's, named rather than re-spelled: an inline
  // signature here is a second declaration of the renderer's contract, and the
  // two could disagree about which fields a row carries.
  const toRow = (t: FleetRow): FleetRow => ({
    childSessionId: t.childSessionId,
    agentName: t.agentName,
    description: t.description,
    state: t.state,
    startedAt: t.startedAt,
  });
  // The running fleet as the tree it is: every active task, in dispatch order,
  // indented under whatever spawned it. Settled tasks that still have a running
  // descendant are kept — they are what places it — and settled leaves are
  // dropped, because history has no running work to place and the Retained
  // section already lists them. The store holds every edge, so the shape costs
  // no host read: a view that spent one status call per row would turn a single
  // question into a burst of transport.
  // A running task is kept with everything below it — a running grandchild does
  // not make its parent disappear — and a settled task is kept only if a
  // running descendant needs it to hold its place.
  const liveBranch = (node: DispatchNode): DispatchNode[] => {
    const below = node.children.flatMap(liveBranch);
    return node.task.state === TaskState.Active || below.length > 0 ? [node, ...below] : [];
  };
  const branch = dispatchForest(store).flatMap(liveBranch);
  // The agents line, from the store and the config. The ONE thing it cannot know
  // without asking the host is which agents are dispatchable — the agent set is
  // not in the store — so that is a TTL-cached fetch, and a fetch that fails
  // leaves the effective depth UNKNOWN rather than zero. Reporting 0 would read
  // as "this agent cannot delegate at all", which is a claim the plugin cannot
  // support when it simply could not ask.
  const agents = await dispatchableAgentNamesOrNull(client, config);
  return formatTaskListSummary({
    tree: branch.map((node) => ({
      ...toRow(node.task),
      depth: node.depth,
      parentSessionId: node.task.parentSessionId,
      parentTracked: node.parentTracked,
    })),
    activeCount: branch.filter((node) => node.task.state === TaskState.Active).length,
    retained: retained.map(toRow),
    maxConcurrent: config.maxConcurrent,
    pruned,
    agents: agentOccupancy(config, agents, activeByAgent(store), config.allowSameAgentRecursion),
  });
}
