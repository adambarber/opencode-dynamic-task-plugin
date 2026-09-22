// Dynamic Task Plugin — non-blocking subagent orchestration with parent notifications
// Location: ~/.config/opencode/plugins/dynamic-task.ts (auto-scanned)
// Docs: https://opencode.ai/docs/plugins
//
// The contract: tools never wait. Every prompt is fired and owned at the gate;
// every settlement (completed/error) rides a lifecycle event through the
// single-winner ledger; children speak mid-flight through task_notify. The
// plugin arms no timers — settlement lives at the notification layer, and the
// only bound on a child is operator intent (task_interrupt).

import { tool } from "@opencode-ai/plugin";
import type { PluginInput, PluginOptions, ToolContext } from "@opencode-ai/plugin";
import type { OpenCodeClient } from "./shared/client.js";
import {
  getSessionIdFromEvent,
  getEventLifecycleStatus,
  isEventRecord,
  eventField,
  eventString,
  eventLooksDeleted,
  errorMessage,
  isTerminalSessionEvent,
  resolveParentSessionId,
  validateSessionResult,
  loadTaskLedger,
  saveTaskLedger,
  resolveTaskLedgerPath,
} from "./shared/session-lifecycle.js";
import { debugLog, configureDebugRoot } from "./debug-logger.js";
import {
  normalizeQuestionAnswers,
  replyToQuestion,
  rejectQuestion,
  resolveQuestionSession,
  getRequestIdFromQuestion,
  decideQuestion,
  rememberQuestionSession,
  forgetQuestionSession,
} from "./shared/question-handling.js";
import {
  normalizeDynamicTaskConfig,
  parseDynamicTaskJsonc,
  checkConcurrencyLimit,
  type DynamicTaskConfig,
} from "./shared/config.js";
import {
  resolveAdmission,
  registerAdmittedTask,
  resolveDependencies,
  formatAdmissionError,
  buildAgentList,
  fetchAgents,
} from "./shared/admission.js";
import {
  invokePrompt,
  classifyPromptError,
  extractMessages,
  getLatestAssistantText,
  hydrateLatestOutcome,
  extractSessionStatus,
  parseModelOverride,
  describeModelShapeError,
} from "./shared/prompt.js";
import {
  notifyParent,
  resolveNotifyKind,
  safeLog,
  formatParentNotification,
  noticeDedupKey,
  recordNotification,
  getLatestNotification,
  gateLedger,
  type NotifyKind,
} from "./shared/notify.js";
import {
  buildBackgroundPrompt,
  formatTaskResultSummary,
  formatTaskListSummary,
  formatTaskStatusDetail,
} from "./shared/task-formatting.js";
import {
  createTaskStore,
  transitionState,
  pruneRetainedTasks,
  findTask,
  listTasks,
  noteLateOutcome,
  annotateNotice,
  markSteerPending,
  consumeSteerPending,
  reviveRetainedTask,
  withdrawInterruptClaim,
  noteAbortLanded,
  recordAbortError,
  restoreRetained,
  type TaskStore,
  type TaskState,
} from "./shared/task-state.js";

// Plugin-level state store (ephemeral — lost on restart)
interface PluginState {
  store: TaskStore;
  config: DynamicTaskConfig;
}

function initPluginState(directory: string, options?: PluginOptions): PluginState {
  // Load dedicated config file if it exists
  const configPath = directory
    ? `${directory}/.opencode/dynamic-task-plugin.jsonc`
    : null;
  const fileConfig = configPath ? parseDynamicTaskJsonc(configPath) : null;

  const config = normalizeDynamicTaskConfig(options, fileConfig);
  const store = createTaskStore();

  // State is scoped to the project directory the host provides (the same
  // root as the config file above) — never the process CWD, which for
  // tests and multi-project hosts is somebody else's tree.
  configureDebugRoot(directory);
  const ledgerPath = resolveTaskLedgerPath(directory);

  // Ledger sync: every retained mutation persists. Errors are swallowed
  // here so a durable-state failure can never break control flow.
  store.onRetainedChange = () => {
    try {
      saveTaskLedger(store.retainedTasks, ledgerPath);
    } catch {
      // best-effort persistence; the next mutation retries
    }
  };

  // Crash recovery: rehydrate retained tasks from the ledger.
  restoreRetained(store, loadTaskLedger(ledgerPath), config.retainedTaskMaxEntries);
  pruneRetainedTasks(store, config);

  return { store, config };
}

// Shared arg guard: every session-scoped tool rejects empty ids identically.
// (Module-private: the host invokes every entry export as a candidate plugin
// function, so only the default export is public.)
function missingSessionId(args: unknown): string | null {
  if (!isEventRecord(args) || !args.session_id) return "ERROR: session_id is required.";
  return null;
}

// Single shape for unknown sessions across all tools.
function unknownSessionResult(sessionId: string): string {
  return JSON.stringify({ status: "unknown", session_id: sessionId });
}

// One delivery helper for every settlement path (event, prompt failure):
// notification is fire-and-forget by contract — the gate owns retries, the
// ledger owns history, and a failed delivery is visible via the notification
// record, never a reason to disturb the caller's control flow. Always a
// Promise so every call site voids it the same way; the parentless path
// resolves false immediately after recording the non-delivery.
function deliverParent(
  client: OpenCodeClient,
  parentSessionId: string,
  childSessionId: string,
  description: string,
  kind: NotifyKind,
  text: string,
): Promise<boolean> {
  const message = formatParentNotification({ childSessionId, description }, kind, text);
  if (!parentSessionId || parentSessionId === "unknown") {
    // Nowhere to deliver — but the non-delivery is recorded, so deafness is
    // distinguishable from "no event yet" in task_result.
    recordNotification({
      at: Date.now(),
      parentSessionId: parentSessionId || "unknown",
      childSessionId,
      kind,
      message,
      attempts: 0,
      delivered: false,
    });
    return Promise.resolve(false);
  }
  return notifyParent(client, parentSessionId, message, { childSessionId, kind });
}

interface ChildRef {
  childSessionId: string;
  parentSessionId: string;
  agentName: string;
  description: string;
  requestedModel?: { providerID: string; modelID: string } | undefined;
}

// Fire a child prompt and own its failure path. The prompt resolving is NOT
// how a task settles — lifecycle events are. This catch exists only for
// delivery failures where no event will ever arrive (session vanished,
// transport rejected): without it a fired prompt leaves the ledger active
// and the parent silently deaf.
function fireChildPrompt(client: OpenCodeClient, store: TaskStore, task: ChildRef, prompt: string): void {
  const routing: { agent: string; model?: { providerID: string; modelID: string } } = {
    agent: task.agentName,
    ...(task.requestedModel !== undefined ? { model: task.requestedModel } : {}),
  };
  // A delivery failure settles exactly once through the same gate the async
  // path uses — but only a NON-retryable one. A transport blip (timeout,
  // refused connection) says nothing about the child: the turn may well be
  // running, and settling error here would deafen the ledger to the child's
  // genuine terminal event. Retryable failures leave the task active; the
  // only bound on a truly-dead child stays operator interruption.
  const onPromptFailure = (error: unknown): void => {
    const classified = classifyPromptError(error);
    void safeLog(client, "warn", `Prompt delivery failed for ${task.childSessionId}: ${classified.message} (retryable: ${classified.retryable})`);
    if (classified.retryable) return;
    let settled = false;
    try {
      transitionState(store, task.childSessionId, "error");
      settled = true;
    } catch { /* a lifecycle event won the settlement */ }
    if (settled) {
      // The requested model rides along so a bad id names its suspect.
      const modelSuffix = task.requestedModel
        ? `\nRequested model: ${task.requestedModel.providerID}/${task.requestedModel.modelID}`
        : "";
      void deliverParent(client, task.parentSessionId, task.childSessionId, task.description, "error", `${classified.message}${modelSuffix}`)
        .then((delivered) => debugLog(task.parentSessionId, task.childSessionId, "prompt-error-notify", { delivered }));
    }
  };
  try {
    invokePrompt(client, task.childSessionId, prompt, routing).catch(onPromptFailure);
  } catch (error: unknown) {
    onPromptFailure(error);
  }
}

async function handleChildLifecycleEvent(
  client: OpenCodeClient,
  store: TaskStore,
  event: unknown,
): Promise<void> {
  const childSessionId = getSessionIdFromEvent(event);
  if (!childSessionId) return;

  const active = store.activeTasks.get(childSessionId);
  if (active) {
    // A steered turn's abort echo is not a settlement: task_continue armed the
    // claim synchronously before aborting, so the pre-steer turn's terminal
    // event is consumed here and the task stays active for its replacement
    // turn. The next genuine terminal event settles normally.
    if (consumeSteerPending(store, childSessionId)) {
      void safeLog(client, "info", `Event handler: consumed steer echo for ${childSessionId}, staying active`);
      return;
    }
    // Synchronous claim — no awaits before this. transitionState is the one
    // settlement gate: the winner replaces the active entry, so every
    // competing writer's transition throws and bows out.
    const status = getEventLifecycleStatus(event);
    const failed = status === "error" || status === "deleted" || eventLooksDeleted(event);
    const provisional: TaskState = failed ? "error" : "completed";
    const parentSessionId = active.parentSessionId;
    const childDescription = active.description;
    try {
      transitionState(store, childSessionId, provisional);
    } catch {
      void safeLog(client, "info", `Event handler: lost settlement race for ${childSessionId}, dropping`);
      return;
    }
    void safeLog(client, "info", `Event handler: settled ${childSessionId} as ${provisional}`);

    const outcome = await hydrateLatestOutcome(client, childSessionId);
    // Kind follows the SETTLED outcome, not the raw status text: a deleted
    // session whose stale status still reads idle notifies error (F-R3).
    let kind: NotifyKind = failed ? "error" : (resolveNotifyKind(status) ?? provisional);
    if (kind === "completed" && outcome.errorDetail) {
      kind = "error";
      if (!noteLateOutcome(store, childSessionId, "error")) {
        void safeLog(client, "info", `Event handler: late error already recorded for ${childSessionId}`);
      }
    }
    const latestText = outcome.text || (kind === "error" ? outcome.errorDetail || "(error — no detail)" : "(completed)");
    // Detached: the synchronous claim above is the settlement guarantee;
    // delivery transport must never hold the event pump head-of-line.
    // Observability survives via the ledger record, logged on completion.
    // deliverParent is the single funnel for parent-directed writes: it
    // records parentless settlements instead of dialing a phantom session.
    void deliverParent(client, parentSessionId, childSessionId, childDescription, kind, latestText)
      .then((delivered) => debugLog(parentSessionId, childSessionId, "completion-notify", { kind, delivered }));
    return;
  }

  const retained = store.retainedTasks.get(childSessionId);
  if (retained) {
    // Late failures are the only amendment a settled record accepts: an event
    // contradicting a reported success escalates completed→error. Interrupted
    // and errored records are final — post-interrupt errors are our own
    // abort's echo, not a discovery, and escalating them would notify the
    // parent of a "failure" it deliberately caused.
    const status = getEventLifecycleStatus(event);
    if (status !== "error" && status !== "deleted") return;
    if (retained.state !== "completed") return;
    const outcome = await hydrateLatestOutcome(client, childSessionId);
    const current = store.retainedTasks.get(childSessionId);
    if (!current || current.state !== "completed") return; // lost the escalation race
    noteLateOutcome(store, childSessionId, "error");
    const errorDetail = outcome.errorDetail || "(session vanished before output was readable)";
    void deliverParent(client, retained.parentSessionId, childSessionId, retained.description, "error", errorDetail)
      .then((delivered) => debugLog(retained.parentSessionId, childSessionId, "retained-late-error", { kind: "error", delivered }));
  }
}

// Read-only session message fetch shared by the session readers.
async function readSessionMessages(client: OpenCodeClient, sessionId: string): Promise<unknown[]> {
  const messagesResult = await client.session.messages({ path: { id: sessionId } });
  return extractMessages(messagesResult);
}

function sessionReadTool(
  description: string,
  handler: (args: Record<string, unknown>) => Promise<string>,
) {
  return tool({
    description,
    args: {
      session_id: tool.schema.string().describe("Background task session ID (ses_...)"),
    },
    execute: async (args: Record<string, unknown>) => handler(args),
  });
}

// Lineage from current session (for nested dynamic_task calls).
function createDummyLineage(ctx: ToolContext, store: TaskStore): string[] {
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
    await safeLog(client, "warn", "Missing required client APIs, plugin disabled");
    return {};
  }

  // Initialize state at plugin load time — captured per instance: a second
  // init (multi-workspace) must never reroute this instance's events into
  // another project's store.
  const { config, store } = initPluginState(directory, options);

  await safeLog(client, "info", "Plugin loaded with dynamic_task, task_continue, task_notify, task_result, task_status, task_list, task_interrupt tools");

  return {
    event: async ({ event }: { event: unknown }) => {
      const eventType = eventString(event, ["type"]) ?? "(none)";
      const eventName = eventString(event, ["name"]) ?? "(none)";
      const evtSessionId = getSessionIdFromEvent(event);
      const topKeys = isEventRecord(event) ? Object.keys(event).slice(0, 8).join(",") : "(null)";

      // The head is guarded too: a dead log call must never skip the question
      // gate or lifecycle handling for every subsequent event.
      try {
        await safeLog(client, "info", `event: type=${eventType} name=${eventName} sid=${evtSessionId ?? "(none)"} keys=[${topKeys}]`);
        debugLog("event-handler", "event-handler", "event-received", {
          type: eventType,
          name: eventName,
          sessionId: evtSessionId,
        });
      } catch { /* best-effort visibility */ }

      // --- Question gate (Task 04): attribute through the gate, then settle.
      // Unattributable questions (including the operator's own) are never
      // touched — the gate fails closed on ambiguity. ---
      try {
        if (eventType === "question.replied" || eventType === "question.rejected") {
          // Release uses getRequestIdFromQuestion's first-match spelling ladder
          // — the same ladder the created path keyed the linkage with, so a
          // reply carrying only request_id releases a request_id-keyed link.
          // A reply that spells the id differently from the create event finds
          // no entry to forget; the linkage lingers until a reply matches.
          const questionId = getRequestIdFromQuestion(event);
          if (questionId) {
            forgetQuestionSession(questionId);
          }
          return;
        }
        if (eventType === "question.created") {
          const resolved = resolveQuestionSession(event, store);
          if (!resolved) {
            debugLog("unknown", "unknown", "question-missing-id", { type: eventType });
            return;
          }
          const { questionId, childSessionId } = resolved;
          if (childSessionId === null) {
            debugLog("unknown", "unknown", "question-unmatched", { questionId, type: eventType });
            return;
          }
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
              const result = await rejectQuestion(client, questionId, decision.reason);
              if (!result.succeeded) {
                debugLog(retained.parentSessionId, childSessionId, "question-retained-reject-failed", {
                  questionId,
                  reason: result.reason,
                });
              } else {
                debugLog(retained.parentSessionId, childSessionId, "question-retained-rejected", { questionId });
              }
            }
          } else {
            debugLog("unknown", "unknown", "question-unmatched", { questionId, type: eventType });
          }
          return;
        }
      } catch (qerr: unknown) {
        debugLog("unknown", "unknown", "question-handler-error", { error: errorMessage(qerr) });
      }

      // --- Session lifecycle event handler ---
      if (!isTerminalSessionEvent(event)) return;
      try {
        await handleChildLifecycleEvent(client, store, event);
      } catch (error: unknown) {
        await safeLog(client, "warn", `event handler error: ${errorMessage(error)}`);
        debugLog("event-handler", "event-handler", "event-handler-error", {
          error: errorMessage(error),
        });
      }
    },

    tool: {
      dynamic_task: tool({
        description:
          "Spawn a subagent task. Returns immediately — the task never blocks this session. Its outcome arrives exactly once as a [dynamic-task-notify] message when it settles; the child can also send mid-flight [dynamic-task-notice] notices with task_notify. Inspect with task_result/task_status/task_list; steer a running child or revive a settled one with task_continue; stop it with task_interrupt.",
        args: {
          description: tool.schema.string().describe("Short human-readable task label"),
          subagent_type: tool.schema.string().describe("Agent to invoke"),
          prompt: tool.schema.string().describe("Instructions for the child session"),
          model: tool.schema
            .string()
            .optional()
            .describe("Optional model override as providerID/modelID exactly as spelled in opencode.jsonc (e.g. \"nvidia/z-ai/glm-5.3\"). Bare ids are rejected at admission."),
          depends_on: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Task dependencies — session IDs this task depends on. Each must have completed."),
          depends_on_settled: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Task dependencies that only need to settle (completed, error, or interrupted) before this task runs. Strict ordering still uses depends_on."),
        },
        async execute(args, ctx: ToolContext) {
          const agents = await fetchAgents(client, config.agentCacheTtlMs);

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

          // Model shape is admission-checked before the session exists: a bad
          // id otherwise fails after creation, and the failure surfaces on
          // the lifecycle path with nothing naming the suspect.
          const modelOverride = parseModelOverride(args.model);
          const modelShapeError = describeModelShapeError(args.model);
          if (modelShapeError) {
            return `ERROR: ${modelShapeError}`;
          }
          const requestedModelLabel =
            typeof args.model === "string" && args.model.trim() ? args.model.trim() : null;

          // Dependency readiness (temporal — after all static validation).
          pruneRetainedTasks(store, config);
          const readiness = resolveDependencies(store, args.depends_on, args.depends_on_settled);
          if (!readiness.ok) {
            return [
              `ERROR: Dependencies pending: ${readiness.pending.map((p) => `${p.id} (${p.state})`).join(", ")}.`,
              "Complete them first (unknown ids are treated as satisfied; depends_on_settled only waits for settlement).",
            ].join("\n");
          }

          // Concurrency is checked BEFORE create: rejecting after the session
          // exists orphans an untracked child on the server. registerActiveTask
          // re-checks as the authoritative gate against a same-tick race; the
          // catch below aborts any session that slips past this advisory check.
          const limitError = checkConcurrencyLimit(store.activeTasks.size, config);
          if (limitError) {
            // Same voice as the authoritative re-check (its throw is the
            // builder's message) — one rejection, one wording.
            return `ERROR: ${limitError}`;
          }

          let createdSessionId: string | null = null;
          let parentSessionId: string | null = null;
          try {
            // 1.18 contract: sessions carry title/parentID only — agent and
            // model ride on each prompt via PromptRouting.
            const sessionBody: { title: string; parentID?: string } = {
              title: args.description || `Task: ${agent.name}`,
            };

            parentSessionId = resolveParentSessionId(ctx);
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
            createdSessionId = childSessionId;

            // Register in active state via the admission gate.
            const activeTask = registerAdmittedTask(store, {
              childSessionId,
              parentSessionId: parentSessionId || "unknown",
              agentName: agent.name,
              description: args.description || `Task: ${agent.name}`,
              lineage: admission.newLineage,
              ...(modelOverride !== undefined ? { requestedModel: modelOverride } : {}),
              ...(args.depends_on !== undefined ? { dependsOn: args.depends_on } : {}),
              ...(args.depends_on_settled !== undefined ? { dependsOnSettled: args.depends_on_settled } : {}),
            }, config);

            // Fire-and-forget: the lifecycle event owns settlement, the
            // catch owns delivery failure.
            fireChildPrompt(client, store, activeTask, buildBackgroundPrompt(args.prompt));

            debugLog(parentSessionId || "unknown", childSessionId, "background-task-registered", {
              description: args.description || `Task: ${agent.name}`,
            });

            if (parentSessionId) {
              return [
                `Spawned @${agent.name} in background.`,
                `Session: ${childSessionId}`,
                `Model: ${requestedModelLabel ?? "(default)"}`,
                `Async notification: enabled (parent ${parentSessionId})`,
                "The outcome arrives unprompted as a dynamic-task-notify message; use task_result to inspect progress meanwhile.",
              ].join("\n");
            }

            return [
              `Spawned @${agent.name} in background.`,
              `Session: ${childSessionId}`,
              `Model: ${requestedModelLabel ?? "(default)"}`,
              "Async notification: disabled (parent session ID not available in tool context)",
            ].join("\n");
          } catch (error: unknown) {
            const message = errorMessage(error);
            // Post-create failure must never strand a child: a registered task
            // is settled through the transition choke point; a created-but-
            // untracked session (e.g. the authoritative re-check threw) is
            // aborted so it cannot run unmonitored on the server.
            if (createdSessionId) {
              const failedChildSessionId = createdSessionId;
              if (store.activeTasks.has(failedChildSessionId)) {
                try { transitionState(store, failedChildSessionId, "error"); } catch { /* already terminal */ }
              } else {
                try { await client.session.abort({ path: { id: failedChildSessionId } }); } catch { /* best-effort */ }
              }
              // The error settlement notifies like every other terminal
              // settlement — a failed spawn the parent never hears about
              // is a silent lie, registered or not. The requested model rides
              // along so a bad id names its suspect in the settlement.
              const spawnErrorText = requestedModelLabel
                ? `${message}\nRequested model: ${requestedModelLabel}`
                : message;
              void deliverParent(
                client,
                parentSessionId || "unknown",
                failedChildSessionId,
                args.description || "background task",
                "error",
                spawnErrorText,
              ).then((delivered) => debugLog(parentSessionId || "unknown", failedChildSessionId, "spawn-error-notify", { delivered }));
            }
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
        description:
          "Send a follow-up prompt to a tracked child session and return immediately. A running child is steered: its current turn is aborted and the message becomes its next turn, staying active. A settled child is revived for a fresh turn. Either way the next outcome arrives as a dynamic-task-notify message. Interrupted tasks are never revived — spawn a fresh dynamic_task instead.",
        args: {
          session_id: tool.schema.string().describe("Child session ID from dynamic_task"),
          prompt: tool.schema.string().describe("Follow-up instructions"),
        },
        async execute(args) {
          const missing = missingSessionId(args);
          if (missing) return missing;
          if (!args.prompt || typeof args.prompt !== "string") {
            return "ERROR: prompt is required and must be a non-empty string.";
          }

          if (args.prompt.length > 100000) {
            return `ERROR: Prompt too long (${args.prompt.length} chars). Max: 100000.`;
          }

          pruneRetainedTasks(store, config);
          const sessionId = String(args.session_id ?? "");

          const active = store.activeTasks.get(sessionId);
          if (active) {
            // Steer: the parent speaks to a running child as a turn
            // replacement — stop, append, re-submit. The claim is armed
            // synchronously (before any await) so the pre-steer turn's
            // terminal event cannot settle the task before the abort lands;
            // the lifecycle handler consumes it and the task stays active.
            // This path never settles: only the replacement turn's genuine
            // terminal event, or operator interruption, ends the task.
            markSteerPending(store, sessionId);
            let abortError: string | undefined;
            let serverGone = false;
            try {
              await client.session.abort({ path: { id: sessionId } });
            } catch (error: unknown) {
              const message = errorMessage(error);
              serverGone = message.includes("not found");
              if (!serverGone) abortError = message;
            }
            if (serverGone) {
              // Nothing left to steer: the session is gone. Settle error so
              // the ledger never strands an active task with no server side.
              try { transitionState(store, sessionId, "error"); } catch { /* settled concurrently */ }
              void deliverParent(client, active.parentSessionId, sessionId, active.description, "error", `Steer failed: session "${sessionId}" not found on the server.`)
                .then((delivered) => debugLog(active.parentSessionId, sessionId, "steer-missing-notify", { delivered }));
              return `ERROR: Session "${sessionId}" not found — steer failed; task settled as error, history preserved.`;
            }
            if (abortError) {
              // The abort may never have reached the server, so the turn may
              // still be running — a replacement prompt now would compete
              // with it instead of replacing it. Disarm the claim (the live
              // turn's genuine terminal event must still settle it) and stay
              // active without sending.
              consumeSteerPending(store, sessionId);
              return `ERROR: abort failed (${abortError}) — task left active; the running turn was not stopped, so no message was sent. Retry task_continue to steer again.`;
            }
            // The turn is dead: fire the parent message as the next user turn.
            // Fire-and-forget like every prompt — the lifecycle event owns
            // settlement, and the prompt-failure path owns delivery failure.
            const steerText = [
              "[Parent steer — read before continuing.]",
              "The parent sent the following while you were running. Read it first, then continue your task with it in mind.",
              "",
              args.prompt,
            ].join("\n");
            fireChildPrompt(client, store, {
              childSessionId: sessionId,
              parentSessionId: active.parentSessionId,
              agentName: active.agentName,
              description: active.description,
              ...(active.requestedModel !== undefined ? { requestedModel: active.requestedModel } : {}),
            }, steerText);
            return `Steer sent to ${sessionId} (@${active.agentName}): the running turn was stopped and the message was sent as the next turn. The task stays active; its outcome arrives as a dynamic-task-notify message.`;
          }

          let task;
          try {
            task = reviveRetainedTask(store, sessionId, config);
            // A revived task is a fresh settlement subject: clear its
            // settle-dedup so the next completion can be delivered.
            gateLedger.forgetChild(sessionId);
          } catch (error: unknown) {
            if (!store.retainedTasks.has(sessionId)) {
              return `ERROR: Session "${sessionId}" is not a tracked task. Use task_list to see tracked sessions, or dynamic_task to start a new one.`;
            }
            return `ERROR: ${errorMessage(error)}`;
          }

          fireChildPrompt(client, store, task, args.prompt);
          return `Follow-up sent to ${task.childSessionId} (@${task.agentName}). The reply arrives as a dynamic-task-notify message.`;
        },
      }),

      task_notify: tool({
        description:
          "Send a message to the parent session while running: progress, findings, or a block needing parent input. This is a mid-flight notice, not a settlement — the task stays active and reports normally when it finishes. If you are blocked, say exactly what would unblock you; the parent can reply via task_continue. Notices arrive as [dynamic-task-notice], distinct from the [dynamic-task-notify] settlement tag. (Children spawned by dynamic_task only.)",
        args: {
          message: tool.schema.string().describe("What the parent needs to know"),
        },
        async execute(args, ctx: ToolContext) {
          const callerId = resolveParentSessionId(ctx);
          if (!callerId || callerId === "unknown") {
            return "ERROR: Unable to resolve the calling session.";
          }
          if (!isEventRecord(args) || typeof args.message !== "string" || !args.message.trim()) {
            return "ERROR: message is required.";
          }
          const message = args.message.trim();
          if (message.length > 4000) {
            return `ERROR: message too long (${message.length} chars). Max: 4000 — this goes into the parent's conversation; summarize.`;
          }

          pruneRetainedTasks(store, config);
          const task = findTask(store, callerId);
          if (!task) {
            return "ERROR: Not a tracked task. Child-to-parent messages route through the task ledger; only sessions spawned by dynamic_task can notify.";
          }
          if (task.state !== "active") {
            return `Message not sent: the task already settled (${task.state}).`;
          }

          annotateNotice(store, callerId, message);
          if (task.parentSessionId === "unknown") {
            return "Message recorded locally; this task has no parent session to deliver to.";
          }
          const parentMessage = formatParentNotification(
            { childSessionId: task.childSessionId, description: task.description },
            "notice",
            message,
          );
          const delivered = await notifyParent(client, task.parentSessionId, parentMessage, {
            childSessionId: task.childSessionId,
            kind: "notice",
            dedupKey: noticeDedupKey(message),
          });
          return delivered
            ? "Message sent to parent."
            : "Message not sent: an identical notice was already delivered (duplicate suppressed), or the parent was unreachable.";
        },
      }),

      task_result: sessionReadTool(
        "Fetch latest known child session result/status without sending a new prompt.",
        async (args) => {
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
                notification: getLatestNotification(sessionId),
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
                notification: getLatestNotification(sessionId),
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
            // 404 or network error → return unknown state
            const message = errorMessage(err);
            const status = eventField(err, "status");
            const code = eventField(err, "code");
            if (status === 404 || message.includes("not found")) {
              return unknownSessionResult(sessionId);
            }
            return JSON.stringify({
              status: "error",
              session_id: sessionId,
              error: message || "Network error querying session",
              retryable: code === "ECONNREFUSED" || code === "ETIMEDOUT",
            });
          }
        },
      ),

      task_interrupt: tool({
        description:
          "Terminate a child session by request. The task settles as interrupted synchronously; its history is preserved. An interrupted child is not revived by task_continue — spawn a fresh dynamic_task instead.",
        args: {
          session_id: tool.schema.string(),
        },
        async execute(args) {
          const missing = missingSessionId(args);
          if (missing) return missing;
          const sessionId = String(args.session_id ?? "");

          // Claim first, then touch the server: settling the task synchronously
          // means the idle/error events our own abort provokes can never be
          // misclaimed as a fresh completion by the lifecycle handler.
          const active = store.activeTasks.get(sessionId);
          let claimed = false;
          const claimTime = Date.now();
          if (active) {
            try { transitionState(store, sessionId, "interrupted"); claimed = true; } catch { /* settled concurrently */ }
          }

          let abortMessage: string | undefined;
          let serverGone = false;
          try {
            await client.session.abort({ path: { id: sessionId } });
          } catch (error: unknown) {
            const message = errorMessage(error);
            serverGone = message.includes("not found");
            abortMessage = serverGone ? undefined : message;
          }

          const retained = store.retainedTasks.get(sessionId);
          if (!claimed && !retained) {
            // Untracked: transient abort failures are simply the caller's
            // transport error; nothing of ours is at stake.
            if (abortMessage) return `ERROR: ${abortMessage}`;
            if (serverGone) return `ERROR: Session "${sessionId}" not found.`;
            return `Session ${sessionId} aborted (not a tracked task).`;
          }

          if (abortMessage) {
            // Transport failure (not a 404): the abort may never have reached
            // the server, so a claimed live child is withdrawn back to active
            // — its genuine terminal event still settles it. A 404 means dead
            // and never withdraws. Settled history is recorded, not disturbed.
            // Withdrawal additionally requires no newer abort to have landed
            // since the claim (F-R4: success is knowledge, failure is
            // ignorance — the newer success wins).
            if (claimed && store.retainedTasks.get(sessionId)?.state === "interrupted") {
              if (withdrawInterruptClaim(store, sessionId, claimTime, config)) {
                void safeLog(client, "warn", `Interrupt: abort failed for ${sessionId} (${abortMessage}); speculative claim withdrawn, child may still be live.`);
                return `ERROR: abort failed (${abortMessage}) — task left active; its lifecycle events will still settle it. Retry task_interrupt to abort again.`;
              }
              recordAbortError(store, sessionId, abortMessage);
              return `ERROR: abort failed (${abortMessage}) — task retained as interrupted; history preserved. Retry task_interrupt to abort again.`;
            }
            // A success record is never annotated with abort noise — the gap
            // belongs in the operator-visible report, not on the outcome.
            if (retained && retained.state !== "completed") recordAbortError(store, sessionId, abortMessage);
            const state = store.retainedTasks.get(sessionId)?.state ?? "unknown";
            return `ERROR: abort failed (${abortMessage}) — task already settled as ${state}; history preserved.`;
          }
          if (serverGone) {
            return `ERROR: Session "${sessionId}" not found — history preserved.`;
          }
          if (!claimed && retained) {
            // A successful abort landing on settled history is stamped: a
            // concurrent interruptor's stale withdraw must observe it (F-R4).
            noteAbortLanded(store, sessionId);
            return `Session ${sessionId} already settled as ${retained.state}; abort sent to the server, history preserved.`;
          }
          // Successful abort on our own fresh claim: stamp it so a concurrent
          // stale withdraw cannot resurrect a dead child.
          noteAbortLanded(store, sessionId);
          return `Session ${sessionId} interrupted.`;
        },
      }),

      task_list: tool({
        description: "List all tracked tasks with their lifecycle states.",
        args: {},
        async execute() {
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
        },
      }),

      task_status: sessionReadTool(
        "Detailed tracked state for one task without calling the API.",
        async (args) => {
          const missing = missingSessionId(args);
          if (missing) return missing;
          const sessionId = String(args.session_id ?? "");

          pruneRetainedTasks(store, config);
          const task = findTask(store, sessionId);
          if (!task) {
            return unknownSessionResult(sessionId);
          }
          return formatTaskStatusDetail(task, getLatestNotification(sessionId) ?? null);
        },
      ),
    },
  };
}
