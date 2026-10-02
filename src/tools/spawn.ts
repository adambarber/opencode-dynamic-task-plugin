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
import { WRITE_BOUNDS } from "../shared/execution-bound.js";
import { callHost } from "../shared/client.js";
import { buildBackgroundPrompt } from "../shared/task-formatting.js";
import {
  activeRecord,
  transitionState,
  agentCapacityRefusal,
  TaskState,
  type NewTaskRegistration,
} from "../shared/task-state.js";
import { notifyRunning } from "../shared/change-sinks.js";
import { NotifyKind } from "../shared/notification-text.js";
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
  const { host, store, config, directory } = deps;
  const agents = await fetchAgents({ host }, config.agentCacheTtlMs);

  // Admission gate: resolve + policy-check before session.create.
  // Fail-fast ordering: unknown callers are rejected before payload validation.
  const lineage = createDummyLineage(ctx, store);
  const admission = resolveAdmission(agents, args.subagent_type, lineage, config);
  if (!admission.ok) {
    return admission.reason.refusal;
  }
  const agent = admission.agent;

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
  const limitError = agentCapacityRefusal(store, agent.name, config);
  if (limitError) return `ERROR: ${limitError}`;

  let createdSessionId: string | null = null;
  const parentSessionId = resolveParentSessionId(ctx);
  // The registration, minus the id the create has not returned yet. Built BEFORE
  // the try so the failure path can leave the record the success path would have
  // left: a registered child and a created-but-unregistered one are the same
  // dispatch, and spelling the record twice is how an orphan would end up
  // described differently from the task it was.
  const registration = {
    parentSessionId: parentSessionId || UNKNOWN_PARENT,
    agentName: agent.name,
    description: args.description || `Task: ${agent.name}`,
    lineage: admission.newLineage,
    ...(admitted.modelOverride !== undefined ? { requestedModel: admitted.modelOverride } : {}),
    ...(args.depends_on !== undefined ? { dependsOn: args.depends_on } : {}),
    ...(args.depends_on_settled !== undefined ? { dependsOnSettled: args.depends_on_settled } : {}),
  } satisfies Omit<NewTaskRegistration, "childSessionId">;
  try {
    // 1.18 contract: sessions carry title/parentID only — agent and
    // model ride on each prompt via PromptRouting.
    const sessionBody: { title: string; parentID?: string } = {
      title: registration.description,
    };

    if (parentSessionId) {
      sessionBody.parentID = parentSessionId;
    }

    // Bounded like every other outbound call: this one is awaited by the CALLER'S
    // turn, so a create the host never answers is not a slow dispatch — it is a
    // `dynamic_task` that never returns, with the parent's turn open behind it.
    const created = await callHost(
      host,
      WRITE_BOUNDS.create,
      (client) => client.session.create({ body: sessionBody, query: { directory: directory || ctx.directory } }),
      null,
    );
    if (created.timedOut) throw new Error(`session create unanswered after ${WRITE_BOUNDS.create}ms`);
    const sessionResult = created.value;

    const childSessionId = validateSessionResult(sessionResult);
    if (!childSessionId) {
      // The title and parent are passed rather than re-derived in the renderer: they
      // are the two facts that make a session nobody can name findable, and they are
      // fixed at the point the create was asked for. A session created without a
      // title is titled after its agent here, so this is always a real string.
      return createFailed(sessionResult, { title: sessionBody.title, parentSessionId });
    }
    createdSessionId = childSessionId;

    // Register in active state via the admission gate.
    const activeTask = registerAdmittedTask(store, { ...registration, childSessionId }, config);

    // Fire-and-forget: the lifecycle event owns settlement, the
    // catch owns delivery failure.
    // The opening describes the child to itself, so it must describe the tools
    // the child actually has: `agent` is the admitted record, and its declared
    // tool map is the only evidence available about what its sessions can call.
    fireChildPrompt(host, store, activeTask, buildBackgroundPrompt(admitted.prompt, { canNotify: agentCanNotify(agent) }));

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
        try { transitionState(store, failedChildSessionId, TaskState.Error); } catch { /* already terminal */ }
      } else {
        // Not "already untracked, nothing to do" — this process created the session,
        // so the record is how it accounts for it. Three things turn on it: the kill
        // becomes VISIBLE to every fleet view, the session comes under the same
        // ownership rule as any other task (which is what lets the kill below be sent
        // rather than refused as a stranger's), and the orphan counts against the
        // retained cap instead of living forever outside it.
        //
        // Through the ordinary pair rather than a private write, because there is no
        // private write: the store never saw it run, so `transitionState` has no
        // from-state until `markRunning` gives it one. The intermediate "running"
        // change is published and then overwritten in the same pending write, so the
        // ledger ends holding the settled record and nothing ever read the transient
        // state — it exists to reach the funnel, not to be observed.
        notifyRunning(store, store.markRunning(
          failedChildSessionId,
          activeRecord({ ...registration, childSessionId: failedChildSessionId }, Date.now()),
        ));
        try { transitionState(store, failedChildSessionId, TaskState.Error); } catch { /* settled concurrently */ }
        await abortSession({ host, store, callerSessionId: parentSessionId || undefined }, failedChildSessionId);
      }
      // The error settlement notifies like every other terminal
      // settlement — a failed spawn the parent never hears about
      // is a silent lie, registered or not. The requested model rides
      // along so a bad id names its suspect in the settlement.
      const spawnErrorText = requestedModelLabel
        ? `${message}\nRequested model: ${requestedModelLabel}`
        : message;
      void deliverParent(
        host,
        parentSessionId || UNKNOWN_PARENT,
        failedChildSessionId,
        args.description || "background task",
        NotifyKind.Error,
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
