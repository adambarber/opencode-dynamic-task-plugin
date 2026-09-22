// dynamic_task executor: spawn admission — resolve, policy-check, create,
// register, fire. The ONLY session.create site (funnel test pins this).
import type { ToolContext } from "@opencode-ai/plugin";
import { checkConcurrencyLimit } from "../shared/config.js";
import {
  resolveAdmission,
  registerAdmittedTask,
  resolveDependencies,
  formatAdmissionError,
  buildAgentList,
  fetchAgents,
} from "../shared/admission.js";
import { parseModelOverride, describeModelShapeError } from "../shared/prompt.js";
import { resolveParentSessionId, validateSessionResult, errorMessage } from "../shared/session-lifecycle.js";
import { buildBackgroundPrompt } from "../shared/task-formatting.js";
import { transitionState, pruneRetainedTasks } from "../shared/task-state.js";
import { debugLog } from "../debug-logger.js";
import { deliverParent, fireChildPrompt } from "../entry/lifecycle.js";
import {
  INVALID_PROMPT,
  promptTooLong,
  dependenciesPending,
  createFailed,
  spawnConfirmation,
  agentGone,
  PERMISSION_DENIED,
} from "../shared/voice.js";
import { createDummyLineage, type ToolDeps } from "./context.js";

export interface SpawnArgs {
  description?: string | undefined;
  subagent_type?: string | undefined;
  prompt?: string | undefined;
  model?: string | undefined;
  depends_on?: string[] | undefined;
  depends_on_settled?: string[] | undefined;
}

export async function executeDynamicTask(deps: ToolDeps, args: SpawnArgs, ctx: ToolContext): Promise<string> {
  const { client, store, config, directory } = deps;
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
    return INVALID_PROMPT;
  }

  if (args.prompt.length > 100000) {
    return promptTooLong(args.prompt.length);
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
    return dependenciesPending(readiness.pending);
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
      return createFailed(sessionResult);
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
      return spawnConfirmation({
        agentName: agent.name,
        childSessionId,
        model: requestedModelLabel,
        parentSessionId,
      });
    }

    return spawnConfirmation({
      agentName: agent.name,
      childSessionId,
      model: requestedModelLabel,
      parentSessionId: null,
    });
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
      return agentGone(agent.name);
    }
    if (message.includes("permission") || message.includes("denied")) {
      return PERMISSION_DENIED;
    }
    return `ERROR: ${message}`;
  }
}
