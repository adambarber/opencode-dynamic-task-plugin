// dynamic_task executor: spawn admission — resolve, policy-check, create,
// register, fire. The ONLY session.create site (funnel test pins this).
//jscpd:ignore-start
import {
  CreateRefusalReason,
  INVALID_PROMPT,
  PERMISSION_DENIED,
  agentGone,
  createFailed,
  createRefusedMissing,
  dependenciesPending,
  descriptionTooLong,
  sessionLost,
  spawnConfirmation,
} from "../shared/voice.js";
import { NOTIFY_TOOL, NotifyKind } from "../shared/notification-text.js";
import {
  type NewTaskRegistration,
  TaskState,
  activeRecord,
  agentCapacityRefusal,
  isRunning,
  transitionState,
} from "../shared/task-state.js";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { UNKNOWN_PARENT, resolveParentSessionId, validateSessionResult } from "../shared/session-lifecycle.js";
import { ExpiryPhase, WRITE_BOUNDS } from "../shared/execution-bound.js";
import { abortSession } from "../shared/session-abort.js";
import {
  admitToolPrompt,
  fetchAgents,
  registerAdmittedTask,
  resolveAdmission,
  resolveDependencies,
} from "../shared/admission.js";
import { agentCanNotify } from "../shared/agent-record.js";
import { buildBackgroundPrompt } from "../shared/task-formatting.js";
import { callHost } from "../shared/client.js";
import { debugLog } from "../debug-logger.js";
import { deliverParent, fireChildPrompt } from "../entry/lifecycle.js";
import { errorMessage } from "../shared/host-shape.js";
import { holdDispatchWait } from "../shared/dispatch-wait.js";
import { isSessionMissing } from "../shared/liveness.js";
import { type CreateIntent, issueCreateIntent, resolveCreateIntent } from "../shared/create-intent.js";
import { liveAgentCaps } from "../shared/caps.js";
import { notifyRunning } from "../shared/change-sinks.js";
import { readParentModel, resolveChildModel } from "../shared/model-choice.js";

//jscpd:ignore-end

// Labels ride every notification verbatim — bound them like prompts.
const MAX_DESCRIPTION_CHARS = 2000;
import type { SessionId } from "../shared/ids.js";
import type { SpawnArgs } from "./args.js";
import { createDummyLineage, type ToolDeps } from "./context.js";

export type { SpawnArgs } from "./args.js";

export async function executeDynamicTask(deps: ToolDeps, args: SpawnArgs, ctx: ToolContext): Promise<string> {
  const { host, store, config } = deps;
  const agents = await fetchAgents({ host }, config.agentCacheTtlMs);

  // Admission gate: resolve + policy-check before session.create.
  // Fail-fast ordering: unknown callers are rejected before payload validation.
  const lineage = createDummyLineage(ctx, store);
  const admission = resolveAdmission(agents, args.subagent_type, lineage, config);
  if (!admission.ok) {
    return admission.reason.refusal;
  }
  const {agent} = admission;

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
        dependsOn: args.depends_on ?? [],
        dependsOnSettled: args.depends_on_settled ?? [],
        description: args.description || `Task: ${agent.name}`,
        parentSessionId: waitingParent,
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
  const limitError = agentCapacityRefusal(store, agent.id, config);
  if (limitError) return `ERROR: ${limitError}`;

  // The model ladder, asked in ONE place and in the only order that means anything:
  // the dispatch's own argument, then this agent's setting, then the global one, then
  // the dispatching parent's own model. Nothing below reads a model — the RESOLVED
  // pair rides the record and the record answers routing, the confirmation and the
  // failure text alike. Per-dispatch rather than at configuration time because layer 1
  // is live, and a configured model skips the host read entirely, so the ladder costs
  // as many host calls as the ladder has layers with nothing stated above them.
  const resolvedModel = await resolveChildModel({
    agent: agent.id,
    inherit: () => readParentModel(host, resolveParentSessionId(ctx)),
    requested: admitted.modelOverride,
    scope: liveAgentCaps(config),
  });
  const requestedModelLabel =
    resolvedModel !== undefined ? `${resolvedModel.providerID}/${resolvedModel.modelID}` : null;

  let createdSessionId: SessionId | null = null;
  const parentSessionId = resolveParentSessionId(ctx);
  // The registration, minus the id the create has not returned yet. Built BEFORE
  // the try so the failure path can leave the record the success path would have
  // left: a registered child and a created-but-unregistered one are the same
  // dispatch, and spelling the record twice is how an orphan would end up
  // described differently from the task it was.
  const registration = {
    agentLabel: agent.name,
    // The registry id, not the display label: this field is the routing key the host
    // resolves, and sending the label is how live dispatch died with `Agent not found`.
    agentName: agent.id,
    description: args.description || `Task: ${agent.name}`,
    lineage: admission.newLineage,
    parentSessionId: parentSessionId || UNKNOWN_PARENT,
    ...(resolvedModel !== undefined ? { requestedModel: resolvedModel } : {}),
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

    // The create is about to be issued and cannot be un-issued, so the record of
    // WHAT WAS ISSUED goes down first. A bound that fires leaves a session that may
    // exist and an id nobody holds; this is the difference between that session being
    // findable and it being one more untracked child, and it is the only fact worth
    // having when the answer never comes.
    const intent: CreateIntent = { parentSessionId, title: sessionBody.title };
    issueCreateIntent(deps.intent, intent);

    // Bounded like every other outbound call: this one is awaited by the CALLER'S
    // turn, so a create the host never answers is not a slow dispatch — it is a
    // `dynamic_task` that never returns, with the parent's turn open behind it.
    const created = await callHost(
      host,
      WRITE_BOUNDS.create,
      // v2 takes the create body FLAT — `{title, parentID}` at the top level, no `body`
    // envelope and no `query.directory`: the plugin's context already names the project.
    (client) => client.session.create(sessionBody),
      null,
    );
    if (created.timedOut) {
      // Two phases, one flag: an absent host never sent this, but a bound that fired
      // already handed it over, so the session may exist. The refusal says which, and
      // names the record rather than asking the parent to search for a title it could
      // have duplicated.
      const refused = created.phase === ExpiryPhase.Sent;
      if (refused) adoptLateAnswer(created.finished, intent);
      return createFailed(created.value, intent, refused ? CreateRefusalReason.Unanswered : CreateRefusalReason.Unsent);
    }
    const sessionResult = created.value;

    const childSessionId = validateSessionResult(sessionResult);
    if (!childSessionId) {
      // The title and parent are passed rather than re-derived in the renderer: they
      // are the two facts that make a session nobody can name findable, and they are
      // fixed at the point the create was asked for. A session created without a
      // title is titled after its agent here, so this is always a real string.
      //
      // The record STAYS for this one: the host answered, so the late-answer hook is
      // not there, and the session may still exist with nobody holding its id.
      return createFailed(sessionResult, intent, CreateRefusalReason.Idless);
    }
    createdSessionId = childSessionId;
    // The create answered, so the child is the ledger's to name and this record has
    // done its only job.
    resolveCreateIntent(deps.intent, intent);

    // Register in active state via the admission gate.
    const activeTask = registerAdmittedTask(store, { ...registration, childSessionId }, config);

    // Fire-and-forget: the lifecycle event owns settlement, the
    // catch owns delivery failure.
    // The opening describes the child to itself, so it must describe the tools
    // the child actually has: `agent` is the admitted record, and its declared
    // tool map is the only evidence available about what its sessions can call.
    fireChildPrompt(host, store, activeTask, buildBackgroundPrompt(admitted.prompt, { canNotify: agentCanNotify(agent, NOTIFY_TOOL) }));

    debugLog(parentSessionId || UNKNOWN_PARENT, childSessionId, "background-task-registered", {
      description: args.description || `Task: ${agent.name}`,
    });

    // One confirmation for both shapes: a child with no parent to name is still
    // a tracked child, and `parentSessionId` is already nullable in the report —
    // deciding here what that field means is the one place that can decide it.
    return spawnConfirmation({
      agentName: agent.name,
      canNotify: agentCanNotify(agent, NOTIFY_TOOL),
      childSessionId,
      model: requestedModelLabel,
      parentSessionId: parentSessionId || null,
    });
  } catch (error: unknown) {
    const message = errorMessage(error);
    // Post-create failure must never strand a child: a registered task
    // is settled through the transition choke point; a created-but-
    // untracked session (e.g. the authoritative re-check threw) is
    // aborted so it cannot run unmonitored on the server.
    if (createdSessionId) {
      const failedChildSessionId = createdSessionId;
      if (isRunning(store, failedChildSessionId)) {
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
        await abortSession({ callerSessionId: parentSessionId || undefined, host, store }, failedChildSessionId);
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
    // A missing AGENT still carries its name in the message, so the substring
    // holds for it — but a missing SESSION arrives with no message at all, and
    // blaming the agent for the host losing the session is the wrong recovery.
    // Which of the two missing-session facts this is: a session the host created and
    // then lost, or a create the host refused. `createdSessionId` is the discriminator
    // — it is set only once the create has answered with an id.
    if (isSessionMissing(error)) {
      return createdSessionId ? sessionLost(createdSessionId) : createRefusedMissing(parentSessionId || UNKNOWN_PARENT);
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

/**
 * Close an intent whose create was handed over and not answered in time.
 *
 * The record is dropped ONLY if the late answer names a session, because a drop is a
 * claim that the ledger now holds the child and this path never registers one — so a
 * create that failed outright leaves the record standing, which is the answer that
 * says "issued, and there is nothing behind it" rather than "nothing happened".
 *
 * Nothing here reports upward: the parent's turn already received its refusal, and a
 * second message about a create it has been told about would be noise about a session
 * it may never have got. The record is the channel; the log is the trace.
 */
function adoptLateAnswer(finished: Promise<unknown>, intent: CreateIntent): void {
  void finished.then(
    (late) => {
      if (validateSessionResult(late) !== null) {
        debugLog(intent.parentSessionId || UNKNOWN_PARENT, "", "create-landed-late", { title: intent.title });
      }
    },
    () => {},
  );
}
