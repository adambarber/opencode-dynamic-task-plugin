// Dynamic Task Plugin - async subagent orchestration with parent notifications
// Location: ~/.config/opencode/plugins/dynamic-task.ts (auto-scanned)
// Docs: https://opencode.ai/docs/plugins

import { tool } from "@opencode-ai/plugin";
import {
  normalizeStatus,
  getSessionIdFromEvent,
  getEventLifecycleStatus,
  isTerminalSessionEvent,
} from "./shared/session-lifecycle.js";
import {
  buildBackgroundPrompt,
  formatParentNotification,
  formatTaskResultSummary,
} from "./shared/task-formatting.js";
import { debugLog } from "./debug-logger.js";
import {
  getRequestIdFromQuestion,
  normalizeQuestionAnswers,
  replyToQuestion,
  rejectQuestion,
} from "./shared/question-handling.js";
import {
  normalizeDynamicTaskConfig,
  resolveTimeoutMs,
  parseDynamicTaskJsonc,
  checkConcurrencyLimit,
  type DynamicTaskConfig,
} from "./shared/config.js";
import {
  normalizeAgentName,
  validateAgent,
  validateLineage,
  buildTaskLineage,
  resolveAwaitResponse,
  isDispatchableAgent,
} from "./shared/task-policy.js";
import {
  createStateStore,
  registerActiveTask,
  transitionState,
  findTask,
  pruneRetainedTasks,
  type TaskStore,
  type ActiveTaskState,
  type RetainedTaskState,
  type TaskLifecycleState,
} from "./shared/task-state.js";

let cachedAgents: any[] = [];
let lastCacheTime = 0;

const CACHE_TTL = 300000;
const POLL_INTERVAL = 3000;

// Plugin-level state store (ephemeral — lost on restart)
interface PluginState {
  store: TaskStore;
  config: DynamicTaskConfig;
  deprecationWarned: boolean;
  pendingSyncRequests: Map<string, {
    resolve: (result: any) => void;
    reject: (error: Error) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
  }>;
}

let pluginState: PluginState | null = null;

/** Safe logger that never throws — prevents secondary failures in error paths */
async function safeLog(client: any, level: string, message: string): Promise<void> {
  try {
    await client.app.log({
      body: { service: "dynamic-task", level, message },
    });
  } catch {
    // best-effort: logging must never break control flow
  }
}

/** Check whether an error indicates a session was not found (404, NOT_FOUND code, etc.) */
function isNotFoundSessionError(error: any): boolean {
  if (error?.status === 404) return true;
  if (error?.response?.status === 404) return true;
  if (error?.code === "NOT_FOUND" || error?.code === "not_found") return true;

  const message = error?.message || "";
  if (typeof message === "string") {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("session not found") ||
      normalized.includes("session_id not found") ||
      normalized.includes("enoent")
    );
  }
  return false;
}

/** Abort a session server-side (best-effort, swallows errors) */
async function abortSession(client: any, sessionId: string): Promise<void> {
  try {
    await client.session.abort({ path: { id: sessionId } });
  } catch {
    // best-effort: server may be unreachable or session already terminated
  }
}

// Persisted task-to-session mapping for crash recovery
import { loadTaskIdMap, saveTaskIdMap, validateTaskId } from "./shared/session-lifecycle.js";

const taskIdToSessionId: Map<string, string> = new Map();
// Runtime question-to-session mapping (not persisted, populated from events)
const questionIdToSessionId: Map<string, string> = new Map();

function initPluginState(directory: string, options: any): PluginState {
  // Load dedicated config file if it exists
  const configPath = directory
    ? `${directory}/.opencode/dynamic-task-plugin.jsonc`
    : null;
  const fileConfig = configPath ? parseDynamicTaskJsonc(configPath) : null;

  const config = normalizeDynamicTaskConfig(options, fileConfig as any);
  const store = createStateStore();

  return {
    store,
    config,
    deprecationWarned: false,
    pendingSyncRequests: new Map(),
  };
}

// Exported for contract tests (Tenet 12): suites pin these pure helpers via
// dist/index.js instead of maintaining local copies that drift.
export function resolveParentSessionId(ctx: any): string | null {
  const candidates = [
    ctx?.sessionID,
    ctx?.sessionId,
    ctx?.session?.id,
    ctx?.session?.sessionID,
    ctx?.id,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return null;
}

export function validateSessionResult(result: any): string | null {
  if (!result) return null;
  if (typeof result.id === "string") return result.id;
  if (result.body && typeof result.body.id === "string") return result.body.id;
  if (result.data && typeof result.data.id === "string") return result.data.id;
  return null;
}

export function buildAgentList(agents: any[]): string {
  if (agents.length === 0) return "(none discovered)";
  return agents.map((a: any) => a.name).join(", ");
}

export function extractTextFromParts(parts: any[]): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
    .map((p: any) => p.text)
    .join("\n");
}

function extractTextFromPromptResult(result: any): string {
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

function extractSessionStatus(sessionInfo: any, messages: any[] = []): string {
  const candidates = [
    sessionInfo?.status,
    sessionInfo?.body?.status,
    sessionInfo?.data?.status,
    sessionInfo?.data?.info?.status,
    sessionInfo?.info?.status,
    sessionInfo?.body?.info?.status,
    sessionInfo?.data?.state,
    sessionInfo?.state,
  ];
  for (const c of candidates) {
    const normalized = normalizeStatus(c);
    if (normalized) return normalized;
  }

  // client.session.get() does not return a status field — infer from messages
  if (messages.length >= 2) {
    const latest = messages[messages.length - 1];
    const role = latest?.info?.role || latest?.role;
    if (role === "assistant") return "completed";
    if (role === "error") return "error";
  }
  if (messages.length > 0) return "busy";

  return "unknown";
}

function extractMessages(result: any): any[] {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.body?.messages)) return result.body.messages;
  return [];
}

function getLatestAssistantText(messages: any[], startIndex: number = 0): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const from = Math.max(0, startIndex);

  for (let i = messages.length - 1; i >= from; i--) {
    const msg = messages[i];
    const role = msg?.info?.role || msg?.role;
    if (role !== "assistant") continue;

    const text = extractTextFromParts(msg?.parts || []);
    if (text.trim()) return text;
  }

  return "";
}

async function readSessionMessages(client: any, sessionId: string): Promise<any[]> {
  const messagesResult = await client.session.messages({ path: { id: sessionId } });
  return extractMessages(messagesResult);
}

async function getMessageCount(client: any, sessionId: string): Promise<number> {
  try {
    const messages = await readSessionMessages(client, sessionId);
    return messages.length;
  } catch {
    return 0;
  }
}

export async function fetchAgents(client: any): Promise<any[]> {
  const now = Date.now();
  if (now - lastCacheTime < CACHE_TTL && cachedAgents.length > 0) {
    return cachedAgents;
  }

  try {
    const result = await client.app.agents();
    let agents: any[] = [];

    if (Array.isArray(result)) {
      agents = result;
    } else if (result && typeof result === "object") {
      agents = result.agents || result.data || Object.values(result);
    }

    cachedAgents = agents.filter((a: any) => isDispatchableAgent(a));

    lastCacheTime = now;
  } catch (e: any) {
    await client.app.log({
      body: {
        service: "dynamic-task",
        level: "warn",
        message: `Failed to fetch agents: ${e.message}`,
      },
    });
  }

  return cachedAgents;
}

/** Test seam: clears the agent-list cache. Production code never calls this. */
export function resetAgentCache(): void {
  cachedAgents = [];
  lastCacheTime = 0;
}

function truncateText(text: string, maxChars: number = 1200): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

async function notifyParentSession(client: any, parentSessionId: string, message: string): Promise<void> {
  try {
    await client.session.prompt({
      path: { id: parentSessionId },
      body: { parts: [{ type: "text", text: message }] },
    });
  } catch (e: any) {
    await client.app.log({
      body: {
        service: "dynamic-task",
        level: "warn",
        message: `Failed parent notification to ${parentSessionId}: ${e.message}`,
      },
    });
  }
}

async function handleTimeout(store: TaskStore, childSessionId: string, client: any, config: DynamicTaskConfig,
  pendingSyncRequests: Map<string, { resolve: (result: any) => void; reject: (error: Error) => void; timeoutHandle: ReturnType<typeof setTimeout>; }>): Promise<void> {
  const task = store.activeTasks.get(childSessionId);
  if (!task || task.completed) return;

  task.timeoutNotified = true;
  task.completed = true;

  const timeoutMessage = formatParentNotification({
    childSessionId: task.childSessionId,
    description: task.description,
    timeoutMs: config.defaultTimeoutMs,
  }, "timeout");

  let abortError: string | undefined;

  if (config.timeoutBehavior === "interrupt") {
    // Await the abort and track its outcome — prevents silent failure
    try {
      const result = await Promise.race([
        client.session.abort({ path: { id: childSessionId } }).then(() => ({ aborted: true })),
        new Promise<{ aborted: false; error: string }>((_, reject) =>
          config.timerProvider.setTimeout(() => reject(new Error("abort timeout")), 5000)
        ),
      ]);
      if (!result.aborted) {
        abortError = result.error;
      }
    } catch (e: any) {
      abortError = e?.message || "abort failed";
    }
  }

  // Guard: event handler may have processed completion during the abort await
  if (!store.activeTasks.has(childSessionId)) {
    pendingSyncRequests.delete(childSessionId);
    return;
  }

  // Always transition to retained — preserves state regardless of abort outcome
  try {
    transitionState(store, childSessionId, "timed_out_retained", config);
  } catch {
    // If transition fails (e.g., already terminal), force the move manually
    store.activeTasks.delete(childSessionId);
    store.retainedTasks.set(childSessionId, {
      ...task,
      state: "timed_out_retained",
      retainedAt: Date.now(),
      timeoutNotified: true,
      completed: true,
      abortError,
    } as RetainedTaskState);
  }

  // Attach abort error to retained entry if applicable
  if (abortError) {
    const retained = store.retainedTasks.get(childSessionId);
    if (retained) {
      retained.abortError = abortError;
    }
  }

  await notifyParentSession(client, task.parentSessionId, timeoutMessage);

  // Clean up any pending sync request
  const pending = pendingSyncRequests.get(childSessionId);
  if (pending) {
    config.timerProvider.clearTimeout(pending.timeoutHandle);
    pendingSyncRequests.delete(childSessionId);
  }

  // Clear the stored timeout handle (it already fired, no-op now)
  if (task.timeoutHandle) {
    config.timerProvider.clearTimeout(task.timeoutHandle);
  }

  debugLog(task.parentSessionId, childSessionId, "timeout-fired", {
    timeoutBehavior: config.timeoutBehavior,
    childSessionId,
    abortError,
  });
}

async function handleChildLifecycleEvent(client: any, event: any): Promise<void> {
  if (!pluginState) return;
  const { store, config, pendingSyncRequests } = pluginState;

  if (!isTerminalSessionEvent(event)) return;

  const childSessionId = getSessionIdFromEvent(event);
  if (!childSessionId) return;

    // Check active tasks first
    const active = store.activeTasks.get(childSessionId);
    if (active) {
      await safeLog(client, "info", `Event handler: found active task ${childSessionId}, status=${getEventLifecycleStatus(event)}, completed=${active.completed}`);
      
      // Clear the stored timeout handle — prevents the "timeout wins the race" bug
      if (active.timeoutHandle) {
        config.timerProvider.clearTimeout(active.timeoutHandle);
      }

      // If already marked completed (timeout fired first), still report the result
      const alreadyCompleted = active.completed;
      active.completed = true;

      const status = getEventLifecycleStatus(event);
      let kind: "timeout" | "completed" | "completed_after_timeout" | "error" = "completed";
      if (status === "error") {
        kind = "error";
        transitionState(store, childSessionId, "error", config);
      } else if (active.timeoutNotified || alreadyCompleted) {
        kind = "completed_after_timeout";
        transitionState(store, childSessionId, "completed_after_timeout", config);
      } else {
        transitionState(store, childSessionId, "completed", config);
      }

      // Check if there's a pending sync request for this task
      const pending = pendingSyncRequests.get(childSessionId);
      await safeLog(client, "info", `Event handler: pendingSyncRequest for ${childSessionId} = ${pending ? 'FOUND' : 'NOT FOUND'}`);
      if (pending) {
        config.timerProvider.clearTimeout(pending.timeoutHandle);
        pendingSyncRequests.delete(childSessionId);
        // Resolve the sync Promise — this unblocks the parent
        pending.resolve({ text: "(completed)" });
      }

    const latestText = "(completed)";
    const parentMessage = formatParentNotification({
      childSessionId: active.childSessionId,
      description: active.description,
      timeoutMs: config.defaultTimeoutMs,
    }, kind, latestText);
    await notifyParentSession(client, active.parentSessionId, parentMessage);

    debugLog(active.parentSessionId, childSessionId, "child-lifecycle-event", {
      status,
      kind,
      timeoutNotified: active.timeoutNotified,
      alreadyCompleted,
    });
    return;
  }

  // Check retained tasks — update state and notify parent of late completion
  const retained = store.retainedTasks.get(childSessionId);
  if (retained) {
    const status = getEventLifecycleStatus(event);
    let newState: TaskLifecycleState = retained.state;

    if (status === "error") {
      newState = "error";
    } else if (retained.state === "timed_out_retained") {
      newState = "completed_after_timeout";
    } else {
      // For other states (completed, error, interrupted), no update needed
      return;
    }

    retained.state = newState;

    // Notify parent that the timed-out task actually finished
    const latestText = "(completed after timeout)";
    const kind = newState === "error" ? "error" : "completed_after_timeout";
    const parentMessage = formatParentNotification({
      childSessionId: retained.childSessionId,
      description: retained.description,
      timeoutMs: config.defaultTimeoutMs,
    }, kind, latestText);
    await notifyParentSession(client, retained.parentSessionId, parentMessage);

    debugLog(retained.parentSessionId, childSessionId, "retained-lifecycle-event", {
      status,
      newState,
      previousState: retained.state,
    });
  }
}

function createDummyLineage(ctx: any, store: TaskStore): string[] {
  const parentSessionId = resolveParentSessionId(ctx);
  if (!parentSessionId) return [];

  // Check if the parent session is itself a child task (i.e., this is a nested call)
  const parentTask = store.activeTasks.get(parentSessionId);
  if (parentTask) {
    // Inherit parent's lineage plus parent's own agent type
    return buildTaskLineage(parentTask.lineage, parentTask.agentName);
  }

  // Also check retained tasks for the parent
  const parentRetained = store.retainedTasks.get(parentSessionId);
  if (parentRetained) {
    return buildTaskLineage(parentRetained.lineage, parentRetained.agentName);
  }

  // Root-level call — no lineage constraints
  return [];
}

export default async function dynamicTaskPlugin(
  input: { client: any; directory: string },
  options: any = {},
) {
  const { client, directory } = input;

  if (!client?.app?.agents || !client?.session?.create || !client?.session?.prompt) {
    try {
      await client.app?.log?.({
        body: {
          service: "dynamic-task",
          level: "warn",
          message: "Missing required client APIs, plugin disabled",
        },
      });
    } catch { /* silent failure */ }
    return {};
  }

  // Initialize state at plugin load time
  pluginState = initPluginState(directory, options);
  const state = pluginState;
  const { config, store, pendingSyncRequests } = state;

  // Load persisted task ID mappings
  try {
    const taskMap = loadTaskIdMap();
    for (const [k, v] of taskMap) {
      taskIdToSessionId.set(k, v);
    }
  } catch { /* ignore */ }

  await client.app.log({
    body: {
      service: "dynamic-task",
      level: "info",
      message: "Plugin loaded with dynamic_task, task_continue, task_result, and task_interrupt tools",
    },
  });

  return {
    event: async ({ event }: any) => {
      const eventType = event?.type;
      const eventName = event?.name;
      const evtSessionId = getSessionIdFromEvent(event);
      const evtStatus = getEventLifecycleStatus(event);
      const topKeys = event ? Object.keys(event).slice(0, 8).join(",") : "(null)";

      await client.app.log({
        body: {
          service: "dynamic-task",
          level: "info",
          message: `event: type=${eventType} name=${eventName} sid=${evtSessionId} status=${evtStatus} keys=[${topKeys}]`,
        },
      });

      debugLog("event-handler", "event-handler", "event-received", {
        type: eventType,
        name: eventName,
        sessionId: evtSessionId,
        status: evtStatus,
      });

      // --- Question API handlers ---
      try {
        if (event?.type === "question.created") {
          const questionId = event.properties?.id;
          if (!questionId) {
            debugLog("unknown", "unknown", "question-missing-id", { type: event.type });
          } else {
            let childSessionId = questionIdToSessionId.get(questionId) || null;

            if (!childSessionId) {
              for (const [sessionId, task] of store.activeTasks) {
                if (task.completed) continue;
                // Find by matching session ID pattern
              }
            }

            // Check if this question is for a retained task
            const retainedTask = childSessionId ? store.retainedTasks.get(childSessionId) : null;
            if (retainedTask) {
              // M3: Questions for retained tasks are rejected with guidance
              await rejectQuestion(client, questionId,
                "This task timed out in the parent session. No response will be provided.");
              debugLog("unknown", childSessionId || "unknown", "question-retained-rejected", { questionId });
            } else if (childSessionId && store.activeTasks.has(childSessionId)) {
              const task = store.activeTasks.get(childSessionId)!;
              questionIdToSessionId.set(questionId, childSessionId);

              const answers = normalizeQuestionAnswers(event.properties?.answers);
              if (answers.length > 0) {
                const result = await replyToQuestion(client, questionId, answers[0]);
                if (!result.succeeded) {
                  debugLog("unknown", childSessionId, "question-auto-answer-failed", {
                    questionId,
                    reason: result.reason,
                  });
                  const rejectResult = await rejectQuestion(client, questionId,
                    "Background task question auto-answer failed");
                  if (!rejectResult.succeeded) {
                    debugLog("unknown", childSessionId, "question-auto-reject-failed", {
                      questionId,
                      reason: rejectResult.reason,
                    });
                  }
                }
              } else {
                const result = await rejectQuestion(client, questionId,
                  "Background task — use task_continue for follow-up");
                if (!result.succeeded) {
                  debugLog("unknown", childSessionId, "question-auto-reject-failed", {
                    questionId,
                    reason: result.reason,
                  });
                }
              }
            } else {
              debugLog("unknown", "unknown", "question-unmatched", { questionId, type: event.type });
            }
          }
        }

        if (event?.type === "question.replied" || event?.type === "question.rejected") {
          const questionId = event.properties?.id;
          if (questionId) {
            questionIdToSessionId.delete(questionId);
          }
        }
      } catch (qerr: any) {
        debugLog("unknown", "unknown", "question-handler-error", { error: qerr?.message });
      }

      // --- Session lifecycle event handler ---
      try {
        await handleChildLifecycleEvent(client, event);
      } catch (e: any) {
        await client.app.log({
          body: {
            service: "dynamic-task",
            level: "warn",
            message: `event handler error: ${e?.message}`,
          },
        });
        debugLog("event-handler", "event-handler", "event-handler-error", {
          error: e?.message,
        });
      }
    },

    tool: {
      dynamic_task: tool({
        description:
          "Spawn a subagent task. Set await_response=false to run in background with async parent notifications.",
        args: {
          description: tool.schema.string().describe("Brief task description"),
          subagent_type: tool.schema.string().describe("Subagent name to invoke"),
          prompt: tool.schema.string().describe("Instructions for the child session"),
          await_response: tool.schema
            .boolean()
            .optional()
            .describe("If true, wait for response. If false (default), return immediately."),
          timeout_ms: tool.schema
            .number()
            .optional()
            .describe("Max wait in ms for awaiting mode or timeout notification in background mode."),
          model: tool.schema
            .string()
            .optional()
            .describe("Optional model override for the child session."),
          depends_on: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Task dependencies — session IDs this task depends on."),
        },
        async execute(args: any, ctx: any) {
          // Debug logging for await_response
          await safeLog(client, "info", `dynamic_task called with await_response=${JSON.stringify(args.await_response)} (type: ${typeof args.await_response})`);
          
          // Deprecation warning for missing await_response
          if (state.config.defaultAwaitResponse === false && args.await_response === undefined) {
            if (!state.deprecationWarned) {
              state.deprecationWarned = true;
              await client.app.log({
                body: {
                  service: "dynamic-task",
                  level: "warn",
                  message: "Deprecation: dynamic_task now runs async by default. Pass await_response: true for sync behavior.",
                },
              });
            }
          }

          // Prune retained tasks before any operation
          pruneRetainedTasks(store, config);

          const agents = await fetchAgents(client);
          const requestedName = args.subagent_type?.toLowerCase()?.trim();

          if (!requestedName) {
            return `ERROR: No subagent_type provided.\n\nAvailable: ${buildAgentList(agents)}`;
          }

          const agent = agents.find((a: any) => a.name.toLowerCase() === requestedName);
          if (!agent) {
            return `ERROR: Agent "${args.subagent_type}" not found.\n\nAvailable: ${buildAgentList(agents)}`;
          }

          if (!args.prompt || typeof args.prompt !== "string") {
            return "ERROR: Invalid prompt. Must be a non-empty string.";
          }

          if (args.prompt.length > 100000) {
            return `ERROR: Prompt too long (${args.prompt.length} chars). Max: 100000.`;
          }

          // Resolve config values
          const timeoutMs = resolveTimeoutMs(args.timeout_ms, config);
          const shouldAwait = resolveAwaitResponse(args.await_response, config);

          // Policy checks before session.create
          const lineage = createDummyLineage(ctx, store);

          const agentCheck = validateAgent(agent.name, config);
          if (!agentCheck.ok) {
            return `ERROR: ${agentCheck.error}`;
          }

          const lineageCheck = validateLineage(lineage, agent.name, config);
          if (!lineageCheck.ok) {
            return `ERROR: ${lineageCheck.error}`;
          }

          try {
            const sessionBody: any = {
              title: args.description || `Task: ${agent.name}`,
              agent: agent.name,
            };

            if (args.model) {
              const parts = args.model.split("/");
              sessionBody.model = parts.length >= 2
                ? { providerID: parts[0], modelID: parts.slice(1).join("/") }
                : { providerID: "", modelID: args.model };
            }

            const parentSessionId = resolveParentSessionId(ctx);
            if (parentSessionId) {
              sessionBody.parentID = parentSessionId;
            }

            const sessionResult = await client.session.create({
              body: sessionBody,
              query: { directory: directory || ctx.directory },
            });

            const childSessionId = validateSessionResult(sessionResult);
            if (!childSessionId) {
              return `ERROR: Failed to create session. Response: ${JSON.stringify(sessionResult)}`;
            }

            // Register in active state
            const newLineage = buildTaskLineage(lineage, agent.name);
            const isBg = !shouldAwait;

            const activeTask = registerActiveTask(store, {
              childSessionId,
              parentSessionId: parentSessionId || "unknown",
              agentName: agent.name,
              description: args.description || `Task: ${agent.name}`,
              lineage: newLineage,
              isBackground: isBg,
              requestedModel: args.model || undefined,
              dependsOn: args.depends_on,
            }, config);

            // Persist taskId mapping
            if (args.description && validateTaskId(args.description)) {
              taskIdToSessionId.set(childSessionId, args.description);
              saveTaskIdMap(taskIdToSessionId);
            }

            if (shouldAwait) {
              let timedOut = false;
              const timeoutResult = Symbol("dynamic-task-timeout");
              const timeoutHandle = config.timerProvider.setTimeout(async () => {
                timedOut = true;
                if (config.timeoutBehavior === "interrupt") {
                  try { await client.session.abort({ path: { id: childSessionId } }); } catch { /* ok */ }
                }
                try { transitionState(store, childSessionId, "timed_out_retained", config); } catch { /* ok */ }
              }, timeoutMs);

              const promptResult = await Promise.race([
                client.session.prompt({
                  path: { id: childSessionId },
                  body: { parts: [{ type: "text", text: args.prompt }] },
                }),
                new Promise<typeof timeoutResult>((resolve) => {
                  config.timerProvider.setTimeout(() => resolve(timeoutResult), timeoutMs);
                }),
              ]);

              if (promptResult !== timeoutResult) {
                config.timerProvider.clearTimeout(timeoutHandle);
              }

              if (promptResult === timeoutResult || timedOut) {
                return `## @${agent.name} Response\n\n(Timed out after ${timeoutMs / 1000}s. Session: ${childSessionId}. Use task_continue to resume.)\n\n---\n*Session: ${childSessionId}*`;
              }

              const responseText = extractTextFromPromptResult(promptResult);
              try {
                transitionState(store, childSessionId, "completed", config);
              } catch { /* already terminal or not tracked */ }
              return `## @${agent.name} Response\n\n${responseText || "(Subagent completed)"}\n\n---\n*Session: ${childSessionId}*`;
            }

            if (!shouldAwait) {
              const childPrompt = buildBackgroundPrompt(args.prompt);
              client.session.prompt({
                path: { id: childSessionId },
                body: { parts: [{ type: "text", text: childPrompt }] },
              }).catch((error: any) => {
                safeLog(client, "warn", `Background prompt failed for ${childSessionId}: ${error?.message || error}`);
              });

              // Fire-and-forget background mode
              const timeoutHandle = config.timerProvider.setTimeout(
                () => handleTimeout(store, childSessionId, client, config, pendingSyncRequests),
                timeoutMs,
              );
              // Store the handle so the lifecycle handler can clear it on early completion
              activeTask.timeoutHandle = timeoutHandle;

              debugLog(parentSessionId || "unknown", childSessionId, "background-task-registered", {
                timeoutMs,
                description: args.description || `Task: ${agent.name}`,
                shouldAwait: false,
              });

              if (parentSessionId) {
                return [
                  `Spawned @${agent.name} in background.`,
                  `Session: ${childSessionId}`,
                  `Async notification: enabled (parent ${parentSessionId})`,
                  "Use task_result(session_id=...) to inspect progress while it runs.",
                ].join("\n");
              }

              return [
                `Spawned @${agent.name} in background.`,
                `Session: ${childSessionId}`,
                "Async notification: disabled (parent session ID not available in tool context)",
              ].join("\n");
            }

            return "ERROR: Unreachable dynamic_task state.";

          } catch (error: any) {
            if (error.message?.includes("not found")) {
              return `ERROR: Agent "${agent.name}" not found.`;
            }
            if (error.message?.includes("permission") || error.message?.includes("denied")) {
              return "ERROR: Permission denied.";
            }
            return `ERROR: ${error.message}`;
          }
        },
      }),

      task_continue: tool({
        description: "Send a follow-up prompt to a child session and wait for its new response.",
        args: {
          session_id: tool.schema.string(),
          prompt: tool.schema.string(),
          timeout_ms: tool.schema.number().optional().describe("Default: 120000"),
        },
        async execute(args: any) {
          if (!args.session_id || !args.prompt) {
            return "ERROR: session_id and prompt are required.";
          }

          if (args.prompt.length > 100000) {
            return `ERROR: Prompt too long (${args.prompt.length} chars).`;
          }

          pruneRetainedTasks(store, config);

          // Check if this is a retained task — spawn new session
          const retained = store.retainedTasks.get(args.session_id);
          if (retained) {
            // Try existing session first — send prompt and await response directly
            try {
              const timeoutMs = resolveTimeoutMs(args.timeout_ms, config);
              let timedOut = false;

              // Schedule timeout
              const timeoutHandle = config.timerProvider.setTimeout(() => {
                timedOut = true;
                if (config.timeoutBehavior === "interrupt") {
                  client.session.abort({ path: { id: args.session_id } }).catch(() => {});
                }
                try { transitionState(store, args.session_id, "timed_out_retained", config); } catch { }
              }, timeoutMs);

              const result = await Promise.race([
                client.session.prompt({
                  path: { id: args.session_id },
                  body: { parts: [{ type: "text", text: args.prompt }] },
                }).catch(() => null),
                new Promise<null>((resolve) =>
                  config.timerProvider.setTimeout(() => resolve(null), timeoutMs)
                ),
              ]);

              config.timerProvider.clearTimeout(timeoutHandle);

              if (result === null || timedOut) {
                return `(Timed out after ${timeoutMs / 1000}s. Session: ${args.session_id}. Use task_continue to resume.)`;
              }

              const responseText = extractTextFromPromptResult(result);
              try { transitionState(store, args.session_id, "completed", config); } catch { }
              return `## Follow-up Response\n\n${responseText || "(Subagent completed)"}\n\n---\n*Session: ${args.session_id}*`;
            } catch {
              // Session dead — fall through to spawn logic below
            }

            // Spawn a new child session with the same agent
            try {
              const sessionBody: any = {
                title: `Continuation: ${retained.description}`,
                agent: retained.agentName,
              };
              if (retained.parentSessionId) {
                sessionBody.parentID = retained.parentSessionId;
              }

              const sessionResult = await client.session.create({
                body: sessionBody,
                query: { directory: directory || "" },
              });

              const newSessionId = validateSessionResult(sessionResult);
              if (!newSessionId) {
                return `ERROR: Failed to create continuation session. Response: ${JSON.stringify(sessionResult)}`;
              }

              // Register new active task for the continuation
              const activeTask = registerActiveTask(store, {
                childSessionId: newSessionId,
                parentSessionId: retained.parentSessionId,
                agentName: retained.agentName,
                description: `Continue: ${retained.description}`,
                lineage: retained.lineage,
                isBackground: false,
              }, config);

              const timeoutMs = resolveTimeoutMs(args.timeout_ms, config);
              await client.session.prompt({
                path: { id: newSessionId },
                body: { parts: [{ type: "text", text: args.prompt }] },
              });

              // Sync wait for response
              const baselineCount = await getMessageCount(client, newSessionId);
              const response = await new Promise<string>((resolve) => {
                const timeoutHandle = config.timerProvider.setTimeout(() => {
                  pendingSyncRequests.delete(newSessionId);
                  if (config.timeoutBehavior === "interrupt") {
                    client.session.abort({ path: { id: newSessionId } }).catch(() => {});
                  }
                  resolve(`(Timed out after ${timeoutMs / 1000}s. Continuation session: ${newSessionId})`);
                }, timeoutMs);

                pendingSyncRequests.set(newSessionId, {
                  resolve: (result: any) => {
                    config.timerProvider.clearTimeout(timeoutHandle);
                    resolve(result.text || "(Subagent completed)");
                  },
                  reject: (err: Error) => {
                    config.timerProvider.clearTimeout(timeoutHandle);
                    resolve(`(Error: ${err.message})`);
                  },
                  timeoutHandle,
                });
              });

              return `## Follow-up Response (new session)\n\n${response}\n\n---\n*Previous session: ${args.session_id}*  *New session: ${newSessionId}*`;
            } catch (error: any) {
              return `ERROR: ${error.message}`;
            }
          }

          // Not a retained task — check if it's active
          const active = store.activeTasks.get(args.session_id);
          if (active) {
            // Send prompt to existing active session
            const timeoutMs = resolveTimeoutMs(args.timeout_ms, config);
            try {
              const baselineCount = await getMessageCount(client, args.session_id);
              await client.session.prompt({
                path: { id: args.session_id },
                body: { parts: [{ type: "text", text: args.prompt }] },
              });

              const response = await new Promise<string>((resolve) => {
                const timeoutHandle = config.timerProvider.setTimeout(() => {
                  pendingSyncRequests.delete(args.session_id);
                  resolve(`(Timed out after ${timeoutMs / 1000}s. Session: ${args.session_id})`);
                }, timeoutMs);

                pendingSyncRequests.set(args.session_id, {
                  resolve: (result: any) => {
                    config.timerProvider.clearTimeout(timeoutHandle);
                    resolve(result.text || "(Subagent completed)");
                  },
                  reject: (err: Error) => {
                    config.timerProvider.clearTimeout(timeoutHandle);
                    resolve(`(Error: ${err.message})`);
                  },
                  timeoutHandle,
                });
              });

              return `## Follow-up Response\n\n${response}\n\n---\n*Session: ${args.session_id}*`;
            } catch (error: any) {
              if (error.message?.includes("not found")) {
                return `ERROR: Session "${args.session_id}" not found.`;
              }
              return `ERROR: ${error.message}`;
            }
          }

          // Unknown session — query the API
          try {
            const sessionInfo = await client.session.get({ path: { id: args.session_id } });
            const messages = await readSessionMessages(client, args.session_id);
            const status = extractSessionStatus(sessionInfo, messages);
            return formatTaskResultSummary({
              sessionId: args.session_id,
              status,
              messageCount: messages.length,
              latestText: getLatestAssistantText(messages, 0) || "(No assistant text found)",
              tracked: false,
              timeoutNotified: false,
            });
          } catch {
            return JSON.stringify({ status: "unknown", session_id: args.session_id });
          }
        },
      }),

      task_result: tool({
        description: "Fetch latest known child session result/status without sending a new prompt.",
        args: {
          session_id: tool.schema.string(),
        },
        async execute(args: any) {
          if (!args.session_id) {
            return "ERROR: session_id is required.";
          }

          // Search active first, then retained
          const task = findTask(store, args.session_id);
          if (task) {
            // Check if it's still in active and may need API query for latest output
            try {
              const sessionInfo = await client.session.get({ path: { id: args.session_id } });
              const messages = await readSessionMessages(client, args.session_id);
              const status = task.state === "active"
                ? extractSessionStatus(sessionInfo, messages)
                : task.state;

              const latest = getLatestAssistantText(messages, 0) || "(No assistant text found)";

              const isTracked = store.activeTasks.has(args.session_id) ||
                store.retainedTasks.has(args.session_id);

              return formatTaskResultSummary({
                sessionId: args.session_id,
                status,
                messageCount: messages.length,
                latestText: truncateText(latest),
                tracked: isTracked,
                timeoutNotified: "timeoutNotified" in task ? Boolean(task.timeoutNotified) : false,
              });
            } catch {
              // API error — return what we know from state
              return formatTaskResultSummary({
                sessionId: args.session_id,
                status: task.state,
                messageCount: 0,
                latestText: "(API unavailable)",
                tracked: true,
                timeoutNotified: "timeoutNotified" in task ? Boolean(task.timeoutNotified) : false,
              });
            }
          }

          // Not in our state — query API, gracefully handle errors
          try {
            const sessionInfo = await client.session.get({ path: { id: args.session_id } });
            const messages = await readSessionMessages(client, args.session_id);
            const status = extractSessionStatus(sessionInfo, messages);
            const latest = getLatestAssistantText(messages, 0) || "(No assistant text found)";

            return formatTaskResultSummary({
              sessionId: args.session_id,
              status,
              messageCount: messages.length,
              latestText: truncateText(latest),
              tracked: false,
              timeoutNotified: false,
            });
          } catch (err: any) {
            // 404 or network error → return unknown state
            if (err?.status === 404 || err?.message?.includes("not found")) {
              return JSON.stringify({ status: "unknown", session_id: args.session_id });
            }
            return JSON.stringify({
              status: "error",
              session_id: args.session_id,
              error: err?.message || "Network error querying session",
              retryable: err?.code === "ECONNREFUSED" || err?.code === "ETIMEDOUT",
            });
          }
        },
      }),

      task_interrupt: tool({
        description: "Interrupt/abort a running child session.",
        args: {
          session_id: tool.schema.string(),
        },
        async execute(args: any) {
          if (!args.session_id) {
            return "ERROR: session_id is required.";
          }

          try {
            await client.session.abort({ path: { id: args.session_id } });

            // Clean up from active tasks if present
            const active = store.activeTasks.get(args.session_id);
            if (active) {
              transitionState(store, args.session_id, "interrupted", config);
            }

            // Clean up from retained tasks if present
            const retained = store.retainedTasks.get(args.session_id);
            if (retained) {
              store.retainedTasks.delete(args.session_id);
            }

            return `Session ${args.session_id} interrupted.`;
          } catch (error: any) {
            if (error.message?.includes("not found")) {
              return `ERROR: Session "${args.session_id}" not found.`;
            }
            return `ERROR: ${error.message}`;
          }
        },
      }),
    },
  };
}
