// dynamic_task executor: spawn admission — resolve, policy-check, create,
// register, fire. The ONLY session.create site (funnel test pins this).
import type { ToolContext } from "@opencode-ai/plugin";
import {
  resolveAdmission,
  registerAdmittedTask,
  resolveDependencies,
  fetchAgents,
  admitToolPrompt,
} from "../shared/admission.js";
import { agentCanNotify } from "../shared/task-policy.js";
import { resolveParentSessionId, validateSessionResult, abortSession, UNKNOWN_PARENT } from "../shared/session-lifecycle.js";
import { errorMessage } from "../shared/host-shape.js";
import { buildBackgroundPrompt } from "../shared/task-formatting.js";
import { transitionState, laneCapacityRefusal } from "../shared/task-state.js";
import { holdDispatchWait } from "../shared/dispatch-wait.js";
import { debugLog } from "../debug-logger.js";
import { deliverParent, fireChildPrompt } from "../entry/lifecycle.js";
import {
  INVALID_PROMPT,
  descriptionTooLong,
  dependenciesPending,
  createFailed,
  spawnConfirmation,
  agentGone,
  PERMISSION_DENIED,
} from "../shared/voice.js";

// Labels ride every notification verbatim — bound them like prompts.
const MAX_DESCRIPTION_CHARS = 2000;
import { createDummyLineage, type ToolDeps } from "./context.js";
import type { SpawnArgs } from "./args.js";

export type { SpawnArgs } from "./args.js";

export async function executeDynamicTask(deps: ToolDeps, args: SpawnArgs, ctx: ToolContext): Promise<string> {
  const { client, store, config, directory } = deps;
  const agents = await fetchAgents(client, config.agentCacheTtlMs);

  // Admission gate: resolve + policy-check before session.create.
  // Fail-fast ordering: unknown callers are rejected before payload validation.
  const lineage = createDummyLineage(ctx, store);
  const admission = resolveAdmission(agents, args.subagent_type, lineage, config, args.lane);
  if (!admission.ok) {
    return admission.reason.refusal;
  }
  const agent = admission.agent;
  const lane = admission.lane;

  // The shared opening for a prompt-bearing tool: prompt and model shape are
  // admission-checked before the session exists (a bad id would otherwise fail
  // after creation, surfacing on the lifecycle path with nothing naming the
  // suspect), and retained history is pruned before anything reads it.
  const promptAdmission = admitToolPrompt(args, INVALID_PROMPT, store, config);
  if (!promptAdmission.ok) return promptAdmission.error;
  const admitted = promptAdmission.input;

  if (typeof args.description === "string" && args.description.length > MAX_DESCRIPTION_CHARS) {
    return descriptionTooLong(args.description.length);
  }

  const requestedModelLabel =
    typeof args.model === "string" && args.model.trim() ? args.model.trim() : null;

  // Dependency readiness (temporal — after all static validation).
  const readiness = resolveDependencies(store, args.depends_on, args.depends_on_settled);
  if (!readiness.ok) {
    // The refusal is ALSO held as state. A sentence tells the parent it was
    // refused and nothing more; the parent then has to carry the wait in prose
    // and be alive at the moment the edge settles to re-dispatch. Holding it
    // here is what lets the settlement funnel say "your dispatch can go" to a
    // parent that has long since forgotten asking.
    const waitingParent = resolveParentSessionId(ctx);
    if (waitingParent) {
      holdDispatchWait(store, {
        description: args.description || `Task: ${agent.name}`,
        parentSessionId: waitingParent,
        dependsOn: args.depends_on ?? [],
        dependsOnSettled: args.depends_on_settled ?? [],
      });
    }
    return dependenciesPending(readiness.pending);
  }

  // Concurrency is checked BEFORE create: rejecting after the session
  // exists orphans an untracked child on the server. registerActiveTask
  // re-checks as the authoritative gate against a same-tick race; the
  // catch below aborts any session that slips past this advisory check.
  // The judgment is the store's, not ours — this is the same function the
  // authoritative re-check calls, so an advisory pass and the gate that
  // overrides it cannot come to disagree about what "full" means.
  const limitError = laneCapacityRefusal(store, lane, config);
  if (limitError) return `ERROR: ${limitError}`;

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
      parentSessionId: parentSessionId || UNKNOWN_PARENT,
      agentName: agent.name,
      description: args.description || `Task: ${agent.name}`,
      lineage: admission.newLineage,
      lane,
      ...(admitted.modelOverride !== undefined ? { requestedModel: admitted.modelOverride } : {}),
      ...(args.depends_on !== undefined ? { dependsOn: args.depends_on } : {}),
      ...(args.depends_on_settled !== undefined ? { dependsOnSettled: args.depends_on_settled } : {}),
    }, config);

    // Fire-and-forget: the lifecycle event owns settlement, the
    // catch owns delivery failure.
    // The opening describes the child to itself, so it must describe the tools
    // the child actually has: `agent` is the admitted record, and its declared
    // tool map is the only evidence available about what its sessions can call.
    fireChildPrompt(client, store, activeTask, buildBackgroundPrompt(admitted.prompt, { canNotify: agentCanNotify(agent) }));

    debugLog(parentSessionId || UNKNOWN_PARENT, childSessionId, "background-task-registered", {
      description: args.description || `Task: ${agent.name}`,
    });

    // One confirmation for both shapes: a child with no parent to name is still
    // a tracked child, and `parentSessionId` is already nullable in the report —
    // deciding here what that field means is the one place that can decide it.
    return spawnConfirmation({
      agentName: agent.name,
      childSessionId,
      model: requestedModelLabel,
      parentSessionId: parentSessionId || null,
      canNotify: agentCanNotify(agent),
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
        // Best-effort: the child is already untracked, so the outcome
        // changes nothing here — it cannot be notified, only left running.
        await abortSession(client, failedChildSessionId);
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
        parentSessionId || UNKNOWN_PARENT,
        failedChildSessionId,
        args.description || "background task",
        "error",
        spawnErrorText,
      ).then((delivered) => debugLog(parentSessionId || UNKNOWN_PARENT, failedChildSessionId, "spawn-error-notify", { delivered }));
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
