// Dynamic Task Plugin - async subagent orchestration with parent notifications
// Location: ~/.config/opencode/plugins/dynamic-task.ts (auto-scanned)
// Docs: https://opencode.ai/docs/plugins

import { tool } from "@opencode-ai/plugin";
import type { PluginInput, PluginOptions, ToolContext } from "@opencode-ai/plugin";
import type { OpenCodeClient } from "./shared/client.js";
import {
  normalizeStatus,
  getSessionIdFromEvent,
  getEventLifecycleStatus,
  isTerminalSessionEvent,
  isEventRecord,
  eventField,
  eventString,
  errorMessage,
} from "./shared/session-lifecycle.js";
import {
  buildBackgroundPrompt,
  formatParentNotification,
  formatTaskResultSummary,
  formatTaskListSummary,
  formatTaskStatusDetail,
} from "./shared/task-formatting.js";
import { debugLog, configureDebugRoot } from "./debug-logger.js";
import {
  normalizeQuestionAnswers,
  replyToQuestion,
  rejectQuestion,
  resolveQuestionSession,
  decideQuestion,
  rememberQuestionSession,
  forgetQuestionSession,
} from "./shared/question-handling.js";
import {
  normalizeDynamicTaskConfig,
  resolveTimeoutMs,
  parseDynamicTaskJsonc,
  type DynamicTaskConfig,
} from "./shared/config.js";
import {
  resolveAwaitResponse,
  isDispatchableAgent,
} from "./shared/task-policy.js";
import {
  resolveAdmission,
  registerAdmittedTask,
  resolveDependencies,
  formatAdmissionError,
  parseAgentList,
  type AgentRecord,
} from "./shared/admission.js";
import {
  invokePrompt,
  classifyPromptError,
  extractTextFromPromptResult,
  extractMessages,
  getLatestAssistantText,
  hydrateLatestText,
  parseModelOverride,
} from "./shared/prompt.js";
import {
  startTimeout,
  withBound,
  ABORT_TIMEOUT_MS,
  type BoundOutcome,
} from "./shared/bound.js";
import {
  notifyParent,
  resolveNotifyKind,
  getLatestNotification,
} from "./shared/notify.js";
import {
  createStateStore,
  transitionState,
  findTask,
  listTasks,
  noteTimeoutFired,
  markActiveCompleted,
  forceRetain,
  discardRetained,
  stealTimeoutHandle,
  noteLateOutcome,
  restoreRetained,
  type TaskStore,
} from "./shared/task-state.js";

let cachedAgents: AgentRecord[] = [];
let lastCacheTime = 0;

const CACHE_TTL = 300000;

// Plugin-level state store (ephemeral — lost on restart)
interface PluginState {
  store: TaskStore;
  config: DynamicTaskConfig;
  deprecationWarned: boolean;
}

let pluginState: PluginState | null = null;

/** Safe logger that never throws — prevents secondary failures in error paths */
type LogLevel = "debug" | "error" | "info" | "warn";

async function safeLog(client: OpenCodeClient, level: LogLevel, message: string): Promise<void> {
  try {
    await client.app.log({
      body: { service: "dynamic-task", level, message },
    });
  } catch {
    // best-effort: logging must never break control flow
  }
}

// Durable retained-task ledger for crash recovery (Task 06)
import { loadTaskLedger, saveTaskLedger, resolveTaskLedgerPath } from "./shared/session-lifecycle.js";

function initPluginState(directory: string, options?: PluginOptions): PluginState {
  // Load dedicated config file if it exists
  const configPath = directory
    ? `${directory}/.opencode/dynamic-task-plugin.jsonc`
    : null;
  const fileConfig = configPath ? parseDynamicTaskJsonc(configPath) : null;

  const config = normalizeDynamicTaskConfig(options, fileConfig);
  const store = createStateStore({
    retainedTaskTtlMs: config.retainedTaskTtlMs,
    retainedTaskMaxEntries: config.retainedTaskMaxEntries,
  });

  // State is scoped to the project directory the host provides (the same
  // root as the config file above) — never the process CWD, which for
  // tests and multi-project hosts is somebody else's tree.
  configureDebugRoot(directory);
  const ledgerPath = resolveTaskLedgerPath(directory);

  // Ledger sync: every retained mutation persists (never throws — the
  // store swallows callback errors so persistence can't break control flow).
  store.onRetainedChange = () => {
    saveTaskLedger(store.retainedTasks, ledgerPath);
  };

  // Crash recovery: rehydrate retained tasks from the ledger.
  restoreRetained(store, loadTaskLedger(ledgerPath));

  return {
    store,
    config,
    deprecationWarned: false,
  };
}

// Session identity with legacy tolerance (Task 08): the 1.18 contract
// carries sessionID, but older shapes used sibling keys. The required
// sessionID stays required; legacy keys are optional maybes — runtime
// behavior (first non-empty wins) is unchanged, only the type is honest.
export interface SessionContext extends ToolContext {
  sessionId?: unknown;
  session?: { id?: unknown; sessionID?: unknown } | null;
  id?: unknown;
}

// Exported for contract tests (Tenet 12): suites pin these pure helpers via
// dist/index.js instead of maintaining local copies that drift.
export function resolveParentSessionId(ctx: SessionContext): string | null {
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

export // Shared arg guard: every session-scoped tool rejects empty ids identically.
function missingSessionId(args: { session_id: string }): string | null {
  if (!args.session_id) return "ERROR: session_id is required.";
  return null;
}

// Single shape for unknown sessions across all tools.
function unknownSessionResult(sessionId: string): string {
  return JSON.stringify({ status: "unknown", session_id: sessionId });
}

// Shared bound waiter for live-session prompts (Tasks 02/07): one timer
// owns abort + transition + race for every prompt that must settle bounded.
// Callers pass already-started work; prompt construction stays at the site.
function awaitContinuation(
  store: TaskStore,
  config: DynamicTaskConfig,
  client: OpenCodeClient,
  sessionId: string,
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<BoundOutcome<unknown>> {
  return withBound(config.timerProvider, timeoutMs, work, () => {
    if (config.timeoutBehavior === "interrupt") {
      client.session.abort({ path: { id: sessionId } }).catch(() => {});
    }
    try { transitionState(store, sessionId, "timed_out_retained"); } catch { /* ok */ }
  });
}

// Shared shell for session-scoped read tools: identical arg schema and
// empty-id guard. Handlers receive raw args and focus on their read.
function sessionReadTool(
  description: string,
  handler: (args: { session_id: string }) => Promise<string> | string,
) {
  return tool({
    description,
    args: {
      session_id: tool.schema.string(),
    },
    async execute(args) {
      const missing = missingSessionId(args);
      if (missing) return missing;
      return handler(args);
    },
  });
}

export function validateSessionResult(result: unknown): string | null {
  const direct = eventField(result, "id");
  if (typeof direct === "string") return direct;
  const bodyId = eventField(result, "body", "id");
  if (typeof bodyId === "string") return bodyId;
  const dataId = eventField(result, "data", "id");
  if (typeof dataId === "string") return dataId;
  return null;
}

export function buildAgentList(agents: AgentRecord[]): string {
  if (agents.length === 0) return "(none discovered)";
  return agents.map((a) => a.name).join(", ");
}

export function extractSessionStatus(sessionInfo: unknown, messages: unknown = []): string {
  const candidates = [
    eventField(sessionInfo, "status"),
    eventField(sessionInfo, "body", "status"),
    eventField(sessionInfo, "data", "status"),
    eventField(sessionInfo, "data", "info", "status"),
    eventField(sessionInfo, "info", "status"),
    eventField(sessionInfo, "body", "info", "status"),
    eventField(sessionInfo, "data", "state"),
    eventField(sessionInfo, "state"),
  ];
  for (const c of candidates) {
    const normalized = normalizeStatus(c);
    if (normalized) return normalized;
  }

  // client.session.get() does not return a status field — infer from messages
  const list = Array.isArray(messages) ? messages : [];
  if (list.length >= 2) {
    const latest = list[list.length - 1];
    const info = isEventRecord(latest) ? latest.info : undefined;
    const role = (isEventRecord(info) ? info.role : undefined) ?? (isEventRecord(latest) ? latest.role : undefined);
    if (role === "assistant") return "completed";
    if (role === "error") return "error";
  }
  if (list.length > 0) return "busy";

  return "unknown";
}

async function readSessionMessages(client: OpenCodeClient, sessionId: string): Promise<unknown[]> {
  const messagesResult = await client.session.messages({ path: { id: sessionId } });
  return extractMessages(messagesResult);
}

export async function fetchAgents(client: OpenCodeClient): Promise<AgentRecord[]> {
  const now = Date.now();
  if (now - lastCacheTime < CACHE_TTL && cachedAgents.length > 0) {
    return cachedAgents;
  }

  // One immediate retry: setup races and transient blips often clear on
  // re-dial; persistent failure keeps the warn-and-stale behavior below.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
       const result: unknown = await client.app.agents();
       cachedAgents = parseAgentList(result).filter((a) => isDispatchableAgent(a));

       lastCacheTime = now;
       break;
     } catch (error: unknown) {
       if (attempt === 1 && error instanceof Error) {
         await client.app.log({
           body: {
             service: "dynamic-task",
             level: "warn",
             message: `Failed to fetch agents: ${error.message}`,
           },
         });
       }
     }
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

async function handleTimeout(store: TaskStore, childSessionId: string, client: OpenCodeClient, config: DynamicTaskConfig): Promise<void> {
  const task = store.activeTasks.get(childSessionId);
  if (!task || task.completed) return;

  noteTimeoutFired(store, childSessionId);

  const timeoutKind = resolveNotifyKind("timeout", "", false);
  const timeoutMessage = formatParentNotification({
    childSessionId: task.childSessionId,
    description: task.description,
    timeoutMs: config.defaultTimeoutMs,
  }, timeoutKind);

  let abortError: string | undefined;

  if (config.timeoutBehavior === "interrupt") {
    // Await the abort and track its outcome — prevents silent failure
    try {
      const result: { aborted: boolean; error?: string } = await Promise.race([
        client.session.abort({ path: { id: childSessionId } }).then(() => ({ aborted: true })),
        new Promise<{ aborted: false; error: string }>((_, reject) =>
          config.timerProvider.setTimeout(() => reject(new Error("abort timeout")), ABORT_TIMEOUT_MS)
        ),
      ]);
       if (!result.aborted) {
         abortError = result.error;
       }
     } catch (error: unknown) {
       abortError = error instanceof Error ? error.message : "abort failed";
     }
  }

  // Guard: event handler may have processed completion during the abort await
  if (!store.activeTasks.has(childSessionId)) {
    return;
  }

  // Always transition to retained — preserves state regardless of abort outcome
  try {
    transitionState(store, childSessionId, "timed_out_retained");
   } catch {
     // Race: completion landed during the abort await — force the move
     forceRetain(store, childSessionId, {
       state: "timed_out_retained",
       timeoutNotified: true,
       completed: true,
       abortError,
     });
   }

  // Attach abort error to retained entry if applicable
  if (abortError) {
    const retained = store.retainedTasks.get(childSessionId);
    if (retained) {
      retained.abortError = abortError;
    }
  }

  await notifyParent(client, task.parentSessionId, timeoutMessage, {
    childSessionId: task.childSessionId,
    kind: timeoutKind,
  });

  // Release the stored bound (it already fired — cancel is a no-op now)
  stealTimeoutHandle(store, childSessionId)?.cancel();

  debugLog(task.parentSessionId, childSessionId, "timeout-fired", {
    timeoutBehavior: config.timeoutBehavior,
    childSessionId,
    abortError,
  });
}

async function handleChildLifecycleEvent(client: OpenCodeClient, event: unknown): Promise<void> {
  if (!pluginState) return;
  const { store, config } = pluginState;

  if (!isTerminalSessionEvent(event)) return;

  const childSessionId = getSessionIdFromEvent(event);
  if (!childSessionId) return;

    // Check active tasks first
    const active = store.activeTasks.get(childSessionId);
    if (active) {
      await safeLog(client, "info", `Event handler: found active task ${childSessionId}, status=${getEventLifecycleStatus(event)}, completed=${active.completed}`);
      
      // Cancel the stored bound — prevents the "timeout wins the race" bug
      stealTimeoutHandle(store, childSessionId)?.cancel();

      // If already marked completed (timeout fired first), still report the result
      const alreadyCompleted = markActiveCompleted(store, childSessionId);

      const status = getEventLifecycleStatus(event);
      if (status === "error") {
        transitionState(store, childSessionId, "error");
      } else if (active.timeoutNotified || alreadyCompleted) {
        transitionState(store, childSessionId, "completed_after_timeout");
      } else {
        transitionState(store, childSessionId, "completed");
      }
      const kind = resolveNotifyKind("event", status, active.timeoutNotified || alreadyCompleted);

    // Hydrate the result text — the parent gets content, not a liveness ping.
    const latestText = (await hydrateLatestText(client, childSessionId)) || "(completed)";
    const parentMessage = formatParentNotification({
      childSessionId: active.childSessionId,
      description: active.description,
      timeoutMs: config.defaultTimeoutMs,
    }, kind, latestText);
    await notifyParent(client, active.parentSessionId, parentMessage, {
      childSessionId: active.childSessionId,
      kind,
    });

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
    if (status !== "error" && retained.state !== "timed_out_retained") {
      // For other states (completed, error, interrupted), no update needed
      return;
    }
    const newState: "completed_after_timeout" | "error" =
      status === "error" ? "error" : "completed_after_timeout";
    noteLateOutcome(store, childSessionId, newState);

    // Notify parent that the timed-out task actually finished
    const latestText = (await hydrateLatestText(client, childSessionId)) || "(completed after timeout)";
    const kind = resolveNotifyKind("event", status, true);
    const parentMessage = formatParentNotification({
      childSessionId: retained.childSessionId,
      description: retained.description,
      timeoutMs: config.defaultTimeoutMs,
    }, kind, latestText);
    await notifyParent(client, retained.parentSessionId, parentMessage, {
      childSessionId: retained.childSessionId,
      kind,
    });

    debugLog(retained.parentSessionId, childSessionId, "retained-lifecycle-event", {
      status,
      newState,
      previousState: retained.state,
    });
  }
}

// Lineage inheritance: a nested caller's session is itself a tracked child
// whose stored lineage already ends with its own agent — inherit verbatim
// (a copy). Re-appending would double-count the parent and collapse depth.
function createDummyLineage(ctx: SessionContext, store: TaskStore): string[] {
  const parentSessionId = resolveParentSessionId(ctx);
  if (!parentSessionId) return [];

  // Check if the parent session is itself a child task (i.e., this is a nested call)
  const parentTask = store.activeTasks.get(parentSessionId);
  if (parentTask) {
    return [...parentTask.lineage];
  }

  // Also check retained tasks for the parent
  const parentRetained = store.retainedTasks.get(parentSessionId);
  if (parentRetained) {
    return [...parentRetained.lineage];
  }

  // Root-level call — no lineage constraints
  return [];
}

export default async function dynamicTaskPlugin(
  input: PluginInput,
  options?: PluginOptions,
) {
  // Single sanctioned boundary cast (Task 08): the host provides the
  // `question` namespace beyond the generated SDK surface. Everything
  // downstream takes the augmented OpenCodeClient — no further casts.
  const directory = input.directory;
  const client = input.client as OpenCodeClient;

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
  const { config, store } = state;

  await client.app.log({
    body: {
      service: "dynamic-task",
      level: "info",
      message: "Plugin loaded with dynamic_task, task_continue, task_result, and task_interrupt tools",
    },
  });

  return {
    event: async ({ event }: { event: unknown }) => {
      const eventType = eventString(event, ["type"]) ?? "(none)";
      const eventName = eventString(event, ["name"]) ?? "(none)";
      const evtSessionId = getSessionIdFromEvent(event);
      const evtStatus = getEventLifecycleStatus(event);
      const topKeys = isEventRecord(event) ? Object.keys(event).slice(0, 8).join(",") : "(null)";

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

      // --- Question gate (Task 04): attribute through the gate, then settle.
      // Unattributable questions (including the operator's own) are never
      // touched — the gate fails closed on ambiguity. ---
      try {
        if (eventString(event, ["type"]) === "question.created") {
          const resolved = resolveQuestionSession(event, store);
          if (!resolved) {
            debugLog("unknown", "unknown", "question-missing-id", { type: eventString(event, ["type"]) });
          } else {
            const { questionId, childSessionId } = resolved;
            if (childSessionId === null) {
              debugLog("unknown", "unknown", "question-unmatched", { questionId, type: eventString(event, ["type"]) });
            } else {
              const active = store.activeTasks.get(childSessionId);
              const retained = active ? undefined : store.retainedTasks.get(childSessionId);

              if (active) {
                rememberQuestionSession(questionId, childSessionId);
                const answers = normalizeQuestionAnswers(eventField(event, "properties", "answers"));
                const decision = decideQuestion("active", answers);
                if (decision.action === "reply") {
                  const result = await replyToQuestion(client, questionId, decision.answer);
                  if (result.succeeded) {
                    debugLog(active.parentSessionId, childSessionId, "question-auto-answered", {
                      questionId,
                      answer: decision.answer,
                    });
                  } else {
                    debugLog(active.parentSessionId, childSessionId, "question-auto-answer-failed", {
                      questionId,
                      reason: result.reason,
                    });
                    const rejectResult = await rejectQuestion(client, questionId,
                      "Background task question auto-answer failed");
                    if (!rejectResult.succeeded) {
                      debugLog(active.parentSessionId, childSessionId, "question-auto-reject-failed", {
                        questionId,
                        reason: rejectResult.reason,
                      });
                    }
                  }
                } else {
                  const result = await rejectQuestion(client, questionId, decision.reason);
                  if (!result.succeeded) {
                    debugLog(active.parentSessionId, childSessionId, "question-auto-reject-failed", {
                      questionId,
                      reason: result.reason,
                    });
                  } else {
                    debugLog(active.parentSessionId, childSessionId, "question-auto-rejected", {
                      questionId,
                    });
                  }
                }
              } else if (retained) {
                rememberQuestionSession(questionId, childSessionId);
                const decision = decideQuestion("retained", []);
                if (decision.action === "reject") {
                  await rejectQuestion(client, questionId, decision.reason);
                }
                debugLog(retained.parentSessionId, childSessionId, "question-retained-rejected", { questionId });
              } else {
                debugLog("unknown", "unknown", "question-unmatched", { questionId, type: eventString(event, ["type"]) });
              }
            }
          }
        }

        if (eventString(event, ["type"]) === "question.replied" || eventString(event, ["type"]) === "question.rejected") {
          const questionId = eventString(event, ["properties", "id"]);
          if (questionId) {
            forgetQuestionSession(questionId);
          }
        }
      } catch (qerr: unknown) {
        debugLog("unknown", "unknown", "question-handler-error", { error: errorMessage(qerr) });
      }

      // --- Session lifecycle event handler ---
       try {
         await handleChildLifecycleEvent(client, event);
       } catch (error: unknown) {
         if (error instanceof Error) {
           await client.app.log({
             body: {
               service: "dynamic-task",
               level: "warn",
               message: `event handler error: ${error.message}`,
             },
           });
           debugLog("event-handler", "event-handler", "event-handler-error", {
             error: error.message,
           });
         }
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
        async execute(args, ctx: ToolContext) {
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

          // Pruning is internal to the store (bounds set at init).
          const agents = await fetchAgents(client);

          // Admission gate: resolve + policy-check before session.create.
          // Fail-fast ordering: unknown callers are rejected before payload validation.
          const lineage = createDummyLineage(ctx, store);
          const admission = resolveAdmission(agents, args.subagent_type, lineage, config);
          if (!admission.ok) {
            return formatAdmissionError(admission.reason, buildAgentList(agents), args.subagent_type);
          }
          const agent = admission.agent;

          if (!args.prompt || typeof args.prompt !== "string") {
            return "ERROR: Invalid prompt. Must be a non-empty string.";
          }

          if (args.prompt.length > 100000) {
            return `ERROR: Prompt too long (${args.prompt.length} chars). Max: 100000.`;
          }

          // Resolve config values
          const timeoutMs = resolveTimeoutMs(args.timeout_ms, config);
          const shouldAwait = resolveAwaitResponse(args.await_response, config);

          // Dependency readiness (temporal — after all static validation).
          const readiness = resolveDependencies(store, args.depends_on);
          if (!readiness.ok) {
            return [
              `ERROR: Dependencies pending: ${readiness.pending.join(", ")}.`,
              "Complete them first (unknown ids are treated as satisfied).",
            ].join("\n");
          }

          try {
            // 1.18 contract: sessions carry title/parentID only — agent and
            // model ride on each prompt via PromptRouting.
            const sessionBody: { title: string; parentID?: string } = {
              title: args.description || `Task: ${agent.name}`,
            };
            const modelOverride = parseModelOverride(args.model);

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

            // Register in active state via the admission gate
            const isBg = !shouldAwait;

            const activeTask = registerAdmittedTask(store, {
              childSessionId,
              parentSessionId: parentSessionId || "unknown",
              agentName: agent.name,
              description: args.description || `Task: ${agent.name}`,
              lineage: admission.newLineage,
              isBackground: isBg,
              requestedModel: args.model || undefined,
              dependsOn: args.depends_on,
            }, config);

            if (shouldAwait) {
              // Bounded prompt (Tasks 02/07): abort + transition on timeout.
              const outcome = await awaitContinuation(
                store, config, client, childSessionId,
                invokePrompt(client, childSessionId, args.prompt, {
                  agent: agent.name,
                  ...(modelOverride !== undefined ? { model: modelOverride } : {}),
                }),
                timeoutMs,
              );

              if (outcome.timedOut) {
                return `## @${agent.name} Response\n\n(Timed out after ${timeoutMs / 1000}s. Session: ${childSessionId}. Use task_continue to resume.)\n\n---\n*Session: ${childSessionId}*`;
              }

              const responseText = extractTextFromPromptResult(outcome.value);
              try {
                transitionState(store, childSessionId, "completed");
              } catch { /* already terminal or not tracked */ }
              return `## @${agent.name} Response\n\n${responseText || "(Subagent completed)"}\n\n---\n*Session: ${childSessionId}*`;
            }

            if (!shouldAwait) {
              const childPrompt = buildBackgroundPrompt(args.prompt);
              invokePrompt(client, childSessionId, childPrompt, {
                agent: agent.name,
                ...(modelOverride !== undefined ? { model: modelOverride } : {}),
              }).catch((error: unknown) => {
                const classified = classifyPromptError(error);
                safeLog(client, "warn", `Background prompt failed for ${childSessionId}: ${classified.message} (retryable: ${classified.retryable})`);
                // First-class failure: record and notify now instead of
                // stalling to timeout. Only the first terminal reporter wins.
                stealTimeoutHandle(store, childSessionId)?.cancel();
                let recorded = false;
                try {
                  transitionState(store, childSessionId, "error");
                  recorded = true;
                } catch { /* already settled */ }
                if (recorded && parentSessionId) {
                  const errorKind = resolveNotifyKind("event", "error", false);
                  const parentMessage = formatParentNotification({
                    childSessionId,
                    description: args.description || `Task: ${agent.name}`,
                    timeoutMs: config.defaultTimeoutMs,
                  }, errorKind, classified.message);
                  void notifyParent(client, parentSessionId, parentMessage, { childSessionId, kind: errorKind });
                }
              });

              // Fire-and-forget background mode: one bound owns the timeout.
              // Stored on the task so completion and interrupt paths can cancel it.
              activeTask.timeoutHandle = startTimeout(config.timerProvider, timeoutMs, () =>
                handleTimeout(store, childSessionId, client, config),
              );

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

          } catch (error: unknown) {
            const message = errorMessage(error);
            if (message.includes("not found")) {
              return `ERROR: Agent "${agent.name}" not found.`;
            }
            if (message.includes("permission") || message.includes("denied")) {
              return "ERROR: Permission denied.";
            }
            return `ERROR: ${message}`;
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
        async execute(args) {
          if (!args.session_id || !args.prompt) {
            return "ERROR: session_id and prompt are required.";
          }

          if (args.prompt.length > 100000) {
            return `ERROR: Prompt too long (${args.prompt.length} chars).`;
          }

          // Pruning is internal to the store (bounds set at init).

          // Check if this is a retained task — spawn new session
          const retained = store.retainedTasks.get(args.session_id);
          if (retained) {
            // Try existing session first — send prompt and await response directly.
            // A genuine timeout reports as such; a dead session falls through
            // to re-admission below.
             try {
               const timeoutMs = resolveTimeoutMs(args.timeout_ms, config);
               const modelOverride = parseModelOverride(retained.requestedModel);

               // Bounded prompt (Tasks 02/07): abort + transition on timeout.
               const outcome = await awaitContinuation(
                 store, config, client, args.session_id,
                 invokePrompt(client, args.session_id, args.prompt, {
                   agent: retained.agentName,
                   ...(modelOverride !== undefined ? { model: modelOverride } : {}),
                 }).catch(() => null),
                 timeoutMs,
               );

              if (outcome.timedOut) {
                return `(Timed out after ${timeoutMs / 1000}s. Session: ${args.session_id}. Use task_continue to resume.)`;
              }

              if (outcome.value !== null) {
                const responseText = extractTextFromPromptResult(outcome.value);
                try { transitionState(store, args.session_id, "completed"); } catch { }
                return `## Follow-up Response\n\n${responseText || "(Subagent completed)"}\n\n---\n*Session: ${args.session_id}*`;
              }
              // Async-dead session (prompt rejected): fall through to re-admission.
            } catch {
              // Synchronously dead session — fall through to re-admission below.
            }

            // Continuation policy (Task 07): a dead session earns a fresh
            // continuation only through the admission gate. Ancestors-only
            // lineage: resuming is not re-delegating, so the task's own tail
            // does not count against it.
            const agents = await fetchAgents(client);
            const readmission = resolveAdmission(
              agents,
              retained.agentName,
              retained.lineage.slice(0, -1),
              config,
            );
            if (!readmission.ok) {
              return [
                formatAdmissionError(readmission.reason, buildAgentList(agents), retained.agentName),
                `(Previous session ${args.session_id} did not respond and cannot be continued.)`,
              ].join("\n\n");
            }

            // Spawn a new child session with the same agent
            try {
              const sessionBody: { title: string; parentID?: string } = {
                title: `Continuation: ${retained.description}`,
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
               registerAdmittedTask(store, {
                 childSessionId: newSessionId,
                 parentSessionId: retained.parentSessionId,
                 agentName: retained.agentName,
                 description: `Continue: ${retained.description}`,
                 lineage: retained.lineage,
                 isBackground: false,
               }, config);

               const timeoutMs = resolveTimeoutMs(args.timeout_ms, config);
               const modelOverride = parseModelOverride(retained.requestedModel);

               // Single-wait (Task 03): the prompt result IS the response,
               // settled through the shared bound waiter.
               const outcome = await awaitContinuation(
                 store, config, client, newSessionId,
                 invokePrompt(client, newSessionId, args.prompt, {
                   agent: retained.agentName,
                   ...(modelOverride !== undefined ? { model: modelOverride } : {}),
                 }),
                 timeoutMs,
               );

              const response = outcome.timedOut
                ? `(Timed out after ${timeoutMs / 1000}s. Continuation session: ${newSessionId})`
                : extractTextFromPromptResult(outcome.value) || "(Subagent completed)";

              return `## Follow-up Response (new session)\n\n${response}\n\n---\n*Previous session: ${args.session_id}*  *New session: ${newSessionId}*`;
             } catch (error: unknown) {
               return `ERROR: ${errorMessage(error)}`;
             }
           }

           // Not a retained task — check if it's active
          const active = store.activeTasks.get(args.session_id);
           if (active) {
            // Send prompt to existing active session
            const timeoutMs = resolveTimeoutMs(args.timeout_ms, config);
            const modelOverride = parseModelOverride(active.requestedModel);
            try {
              // Single-wait (Task 03): the prompt result IS the response,
              // settled through the shared bound waiter.
              const outcome = await awaitContinuation(
                store, config, client, args.session_id,
                invokePrompt(client, args.session_id, args.prompt, {
                  agent: active.agentName,
                  ...(modelOverride !== undefined ? { model: modelOverride } : {}),
                }),
                timeoutMs,
              );

              if (outcome.timedOut) {
                return `## Follow-up Response\n\n(Timed out after ${timeoutMs / 1000}s. Session: ${args.session_id})\n\n---\n*Session: ${args.session_id}*`;
              }

              const responseText = extractTextFromPromptResult(outcome.value);
              return `## Follow-up Response\n\n${responseText || "(Subagent completed)"}\n\n---\n*Session: ${args.session_id}*`;
            } catch (error: unknown) {
              const message = errorMessage(error);
              if (message.includes("not found")) {
                return `ERROR: Session "${args.session_id}" not found.`;
              }
              return `ERROR: ${message}`;
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
            return unknownSessionResult(args.session_id);
          }
        },
      }),

      task_result: sessionReadTool(
        "Fetch latest known child session result/status without sending a new prompt.",
        async (args) => {
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
                notification: getLatestNotification(args.session_id),
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
                notification: getLatestNotification(args.session_id),
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
              notification: getLatestNotification(args.session_id),
            });
          } catch (err: unknown) {
            // 404 or network error → return unknown state
            const message = errorMessage(err);
            const status = eventField(err, "status");
            const code = eventField(err, "code");
            if (status === 404 || message.includes("not found")) {
              return unknownSessionResult(args.session_id);
            }
            return JSON.stringify({
              status: "error",
              session_id: args.session_id,
              error: message || "Network error querying session",
              retryable: code === "ECONNREFUSED" || code === "ETIMEDOUT",
            });
          }
        },
      ),

      task_interrupt: tool({
        description: "Interrupt/abort a running child session.",
        args: {
          session_id: tool.schema.string(),
        },
        async execute(args) {
          const missing = missingSessionId(args);
          if (missing) return missing;

          try {
            await client.session.abort({ path: { id: args.session_id } });

            // Cancel the armed bound first — the handle must not outlive the task.
            stealTimeoutHandle(store, args.session_id)?.cancel();

            // Clean up from active tasks if present
            const active = store.activeTasks.get(args.session_id);
            if (active) {
              transitionState(store, args.session_id, "interrupted");
            }

            // Clean up from retained tasks if present
            discardRetained(store, args.session_id);

            return `Session ${args.session_id} interrupted.`;
          } catch (error: unknown) {
            const message = errorMessage(error);
            if (message.includes("not found")) {
              return `ERROR: Session "${args.session_id}" not found.`;
            }
            return `ERROR: ${message}`;
          }
        },
      }),

      task_list: tool({
        description: "List all tracked background tasks with their lifecycle states.",
        args: {},
        async execute() {
          const { active, retained } = listTasks(store);
          const toRow = (t: { childSessionId: string; agentName: string; description: string; state: string; isBackground: boolean; startedAt: number }) => ({
            childSessionId: t.childSessionId,
            agentName: t.agentName,
            description: t.description,
            state: t.state,
            isBackground: t.isBackground,
            startedAt: t.startedAt,
          });
          return formatTaskListSummary({
            active: active.map(toRow),
            retained: retained.map(toRow),
            maxConcurrent: config.maxConcurrent,
          });
        },
      }),

      task_status: sessionReadTool(
        "Detailed tracked state for one task without calling the API.",
        async (args) => {
          const task = findTask(store, args.session_id);
          if (!task) {
            return unknownSessionResult(args.session_id);
          }
          return formatTaskStatusDetail(task, getLatestNotification(args.session_id) ?? null);
        },
      ),
    },
  };
}
