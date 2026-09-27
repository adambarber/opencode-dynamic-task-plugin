// src/shared/admission.ts
// Spawn admission gate (Task 07) — the ONLY module that resolves agents,
// applies policy, and registers tasks. Callers render errors; this module
// decides. Lineage resolution (parentID chains) and dependency readiness
// land here in Task 07 proper; the funnel exists now so no new spawn path
// can bypass it.

import type { DynamicTaskConfig } from "./config.js";
import { admissibleLaneNames, resolveLane as lanePolicyFor, resolveLaneName } from "./config.js";
import { liveLanes } from "./lane-overlay.js";
import type { OpenCodeClient } from "./client.js";
import { safeLog } from "./notify.js";
import { admitPromptInput, type AdmittedPromptInput } from "./prompt.js";
import type { Verdict } from "./verdict.js";
import { hostPayload } from './session-lifecycle.js';
import { isEventRecord } from './host-shape.js';
import {
  validateAgent,
  validateLineage,
  buildTaskLineage,
  isDispatchableAgent,
} from "./task-policy.js";
import {
  registerActiveTask,
  findTask,
  pruneRetainedTasks,
  TASK_STATES,
  TaskState,
  type ActiveTaskState,
  type NewTaskRegistration,
  type TaskStore,
} from "./task-state.js";
import type { AgentRecord } from "./host-shape.js";

/**
 * A refusal, as the one value that carries both the decision and the words.
 *
 * There is no discriminant to branch on, and that is the whole design. A string
 * tag makes every renderer re-derive what the producer already knew: it compiles
 * unchanged under a rename, a newly added refusal falls through to whatever the
 * final `else` was, and neither mistake is a type error. So the sentence is
 * assembled where the decision is made and travels as the value.
 *
 * This also deletes an argument the old signature needed. `formatAdmissionError`
 * took the agent list and the requested name purely to render two of its five
 * variants, which meant the parent was shown a list of available agents computed
 * by the CALLER from an agent list the gate itself had already been handed — two
 * derivations of one fact, free to disagree. The gate builds it once now.
 */
export interface AdmissionDenial {
  /** Exactly what the parent reads. */
  refusal: string;
}

const noSubagentType = (available: string): AdmissionDenial => ({
  refusal: `ERROR: No subagent_type provided.\n\nAvailable: ${available}`,
});

const unknownAgent = (requested: unknown, available: string): AdmissionDenial => ({
  refusal: `ERROR: Agent "${String(requested)}" not found.\n\nAvailable: ${available}`,
});

const unknownLane = (requested: string, known: string[]): AdmissionDenial => ({
  refusal:
    `ERROR: Unknown lane "${requested}".\n\nDeclared lanes: ${known.length > 0 ? known.join(", ") : "(none declared)"}. ` +
    "Declare one in the dynamic-task config, or dispatch without a lane to use the default.",
});

/** The two refusals a policy check hands over as a bare sentence. */
const policyRefused = (message: string): AdmissionDenial => ({ refusal: `ERROR: ${message}` });

export type Admission =
  | { ok: true; agent: AgentRecord; newLineage: string[]; lane: string }
  | { ok: false; reason: AdmissionDenial };

// ─── resolveAdmission ──────────────────────────────────────────────
// Pre-create check: find the agent by name (case-insensitive, trimmed —
// same matching the orchestrator has always used), then apply blocked-agent
// and lineage policy. Pure wrt the store: no mutation, no client calls.

/**
 * The names a dispatch can actually spend: dispatchable, and not blocked.
 *
 * It lives HERE and not in task-policy because the admission gate is the only
 * place allowed to apply policy — a second derivation of "which agents could this
 * project delegate to" is a second answer, and the build gate that enforces the
 * single gate is right to refuse it anywhere else.
 *
 * An agent this plugin would refuse cannot lengthen a chain, so counting one
 * would report a depth the operator can never reach: a cap that looks generous
 * and is not.
 */
export function dispatchableAgentNames(
  agents: readonly AgentRecord[],
  config: Pick<DynamicTaskConfig, "blockedAgents">,
): string[] {
  return agents.filter((agent) => validateAgent(agent.name, config as DynamicTaskConfig).ok).map((agent) => agent.name);
}

export function resolveAdmission(
  agents: AgentRecord[],
  requestedName: unknown,
  lineage: string[],
  config: DynamicTaskConfig,
  requestedLane?: unknown,
): Admission {
  const available = buildAgentList(agents);
  const normalized =
    typeof requestedName === "string" ? requestedName.toLowerCase().trim() : "";
  if (!normalized) {
    return { ok: false, reason: noSubagentType(available) };
  }

  const agent = agents.find((a) => a.name.toLowerCase() === normalized);
  if (!agent) {
    return { ok: false, reason: unknownAgent(requestedName, available) };
  }

  const agentCheck = validateAgent(agent.name, config);
  if (!agentCheck.ok) {
    return { ok: false, reason: policyRefused(agentCheck.error) };
  }

  const laneCheck = admitLaneName(config, requestedLane);
  if (!laneCheck.ok) {
    return { ok: false, reason: laneCheck.reason };
  }

  // Depth is judged against the LANE's cap, with the dispatchable set in hand so
  // the refusal can name the constraint that actually binds. A lane that declares
  // its own maxDepth is only real if this reads the resolved lane rather than the
  // top-level number.
  const lanePolicy = lanePolicyFor(liveLanes(config), laneCheck.lane);
  const lineageCheck = validateLineage(
    lineage,
    agent.name,
    { maxDepth: lanePolicy.maxDepth, allowSameAgentRecursion: config.allowSameAgentRecursion },
    dispatchableAgentNames(agents, config),
    laneCheck.lane,
  );
  if (!lineageCheck.ok) {
    return { ok: false, reason: policyRefused(lineageCheck.error) };
  }

  return { ok: true, agent, newLineage: buildTaskLineage(lineage, agent.name), lane: laneCheck.lane };
}

// Lane admission, separated from the lane's LIMITS (config.ts owns those).
// The gate is total: anything that is not a usable lane name is a refusal, and a
// refusal that is NOT a fall back to the default lane, because a typo silently
// spending a different budget than the operator meant is the failure mode a
// named-lane feature exists to prevent.
//
// With no lanes declared the accept-set is the default lane alone, so naming a
// lane then REFUSES. That is the one behaviour that cannot be left implicit:
// before lanes existed, any string here was ignored, so a name that used to be
// decorative is now a typo the parent has to be told about. Declaring the lane
// is the remedy, and the refusal says so.
function admitLaneName(
  config: DynamicTaskConfig,
  requestedLane: unknown,
): { ok: true; lane: string } | { ok: false; reason: AdmissionDenial } {
  // Live policy, for the same reason the capacity judgment is live: a lane
  // created in the UI is admissible on the very next dispatch, so the accept-set
  // is read from the overlay rather than from the config frozen at boot. A lane
  // the UI just made would otherwise be refused by name for as long as the
  // process lived, and the refusal would name the remedy as "declare it in the
  // config" — advice that is already stale.
  const known = admissibleLaneNames(liveLanes(config));
  if (typeof requestedLane !== "string" && requestedLane !== undefined) {
    return { ok: false, reason: unknownLane(String(requestedLane), known) };
  }
  const lane = resolveLaneName(requestedLane);
  if (!known.includes(lane)) {
    return { ok: false, reason: unknownLane(lane, known) };
  }
  return { ok: true, lane };
}

// ─── resolveDependencies ───────────────────────────────────────────
// Readiness gate: strict dependencies must have completed; settled-wait
// dependencies must have left active (any terminal state satisfies). Running
// deps block under both lists. Unknown ids pass: they may have completed and
// aged out of the bounded retained history, and blocking forever on
// garbage-collected history would deadlock planners.

// Satisfaction is a DELIVERY claim, and only a delivered result is one: a
// blocked dependency settled, but it produced nothing, so anything waiting on it
// still waits. This list is the one place that says what "done" means, and it is
// deliberately not derived from the machine — deriving it would make every new
// state an unexamined dependency-satisfying state. The type is what keeps that
// choice honest while it stays a choice: both lists are `TaskState[]`, so the
// membership test below is a check the compiler makes, and renaming a state is a
// compile error here rather than a dependency that silently stops being
// satisfied. The judgement stays a human's; the spellings stop being free.
//
// Settlement, by contrast, IS derivable: a dependency that will not run again
// cannot be waited on, whatever it settled as. Deriving it means a state added
// to the machine is settled here by construction instead of by a second hand-
// written list that drifts.
const SATISFIED_DEPENDENCY_STATES: readonly TaskState[] = [TaskState.Completed];
const SETTLED_DEPENDENCY_STATES: readonly TaskState[] = TASK_STATES.filter((state) => state !== TaskState.Active);

export interface DependencyBlock {
  id: string;
  state: TaskState;
}

export function resolveDependencies(
  store: TaskStore,
  dependsOn: string[] | undefined,
  dependsOnSettled: string[] | undefined = [],
): { ok: true } | { ok: false; pending: DependencyBlock[] } {
  const strict = dependsOn ?? [];
  const lenient = dependsOnSettled ?? [];
  if (strict.length === 0 && lenient.length === 0) return { ok: true };
  // Strict wins on overlap: an id in both lists must have completed.
  const seen = new Set<string>();
  const pending: DependencyBlock[] = [];
  const check = (id: string, states: readonly TaskState[]): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const task = findTask(store, id);
    if (!task) return;
    if (!states.includes(task.state)) pending.push({ id, state: task.state });
  };
  for (const id of strict) check(id, SATISFIED_DEPENDENCY_STATES);
  for (const id of lenient) check(id, SETTLED_DEPENDENCY_STATES);
  return pending.length === 0 ? { ok: true } : { ok: false, pending };
}

// ─── parseAgentList ────────────────────────────────────────────────
// Turns an untyped registry response into agent records. The envelope is
// hostPayload's business (the client resolves to { data, request, response },
// and a keyed map keyed by agent name is the other shape this endpoint
// returns) — what is left here is the payload: a list, or a map whose values
// are lists, and the first one holding valid records wins. Anything else
// yields []. Records are validated minimally ({name: string}); mode policy
// stays in isDispatchableAgent.

export function parseAgentList(result: unknown): AgentRecord[] {
  const payload = hostPayload(result);
  const groups: unknown[] = Array.isArray(payload)
    ? [payload]
    : isEventRecord(payload)
      ? [Object.values(payload)]
      : [];
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    const records = group.filter(isAgentRecord);
    if (records.length > 0) return records;
  }
  return [];
}

function isAgentRecord(item: unknown): item is AgentRecord {
  return (
    !!item &&
    typeof item === "object" &&
    typeof (item as { name?: unknown }).name === "string"
  );
}

// ─── registerAdmittedTask ──────────────────────────────────────────
// Post-create registration. Thin today by design: single ownership of the
// registration path so continuation policy (Task 07) has one place to land.

export function registerAdmittedTask(
  store: TaskStore,
  params: NewTaskRegistration,
  config: DynamicTaskConfig,
): ActiveTaskState {
  return registerActiveTask(store, params, config);
}

// ─── the shared opening for a prompt-bearing tool ───────────────────
/**
 * dynamic_task and task_continue are the only two tools that carry a prompt to a
 * child, and they open the same way: validate the prompt and model under THIS
 * tool's voice for an absent prompt, then prune retained history, then proceed.
 * Both halves are ordering-sensitive and neither is optional — a prune ahead of
 * the validation would let a rejected prompt act on the store, and a tool that
 * skipped the prune would answer from a record past its TTL. Keeping the
 * sequence in one function makes "a bad prompt fails before anything moves" a
 * property of the tool rather than a habit at a call site.
 *
 * The refusal comes back as a VALUE in the same `{ ok, error }` shape every other
 * gate in this module answers in (`resolveAdmission`, `resolveDependencies`), so
 * the caller's early return is the one line every gate's caller already writes,
 * rather than a typeof check each prompt-bearing tool re-spells for itself.
 */
export type ToolPromptAdmission = Verdict<AdmittedPromptInput>;

export function admitToolPrompt(
  args: { prompt?: unknown; model?: unknown },
  absentPromptVoice: string,
  store: TaskStore,
  config: DynamicTaskConfig,
): ToolPromptAdmission {
  const admitted = admitPromptInput(args.prompt, args.model, absentPromptVoice);
  if (!admitted.ok) return admitted;
  pruneRetainedTasks(store, config);
  return { ok: true, input: admitted.input };
}

// ─── agent discovery ───────────────────────────────────────────────
// Server agent listing with caching lives here (not on the plugin entry):
// the host invokes every entry export as a candidate plugin function, so
// entry-adjacent helpers must be total — and agent shape is this module's
// domain. All three functions degrade instead of throwing on probe input.

// Agent discovery is scoped per client (WeakMap): the cache used to be
// process-global, so a second plugin instance — or the host probing entry
// exports with a different client — could be served another client's agent
// list. resetAgentCache bumps an epoch instead of iterating: WeakMaps are not
// enumerable, and an entry whose epoch is stale is treated as empty, which
// invalidates every client's cache at once with no retained references.
interface AgentCacheEntry {
  agents: AgentRecord[];
  at: number;
  epoch: number;
}

const agentCaches = new WeakMap<object, AgentCacheEntry>();
// Tenet 9: the epoch is process-global by design — per-client lists stay
// isolated in the WeakMap; the epoch only invalidates, never shares.
let agentCacheEpoch = 0;

const CACHE_TTL = 300000;

/**
 * The agent list as one comma-joined line for a prompt.
 *
 * Total on malformed input: the host may invoke named exports outside the
 * default-export lifecycle (observed: called with a non-array while the plugin
 * entry never ran), and a throw here fails the entire plugin boot. Never throw;
 * degrade to the empty-list marker.
 */
export function buildAgentList(agents: unknown): string {
  if (!Array.isArray(agents)) return "(none discovered)";
  const names = agents.filter(isAgentRecord).map((a) => a.name);
  if (names.length === 0) return "(none discovered)";
  return names.join(", ");
}

export async function fetchAgents(client: OpenCodeClient, cacheTtlMs: number = CACHE_TTL): Promise<AgentRecord[]> {
  return (await fetchAgentListing(client, cacheTtlMs)).agents;
}

/**
 * The agent list, and whether it is one at all.
 *
 * `fetchAgents` cannot throw — a throw here fails the entire plugin boot — so a
 * host that cannot be asked comes back as `[]`. That is the right answer for a
 * caller that only wants names to try, and a WRONG one for a caller that reports
 * a depth: an empty list and a failed read both render as 0, and 0 reads as "this
 * project cannot delegate at all". So the two cases are separated in the type
 * rather than inferred from an array's emptiness.
 *
 * A STALE cached list is `known`: it is a real list, just an old one, and saying
 * otherwise would make a transient blip look like a project with no agents.
 */
export interface AgentListing {
  agents: AgentRecord[];
  known: boolean;
}

export async function fetchAgentsOrUnknown(
  client: OpenCodeClient,
  cacheTtlMs: number = CACHE_TTL,
): Promise<AgentListing> {
  return fetchAgentListing(client, cacheTtlMs);
}

async function fetchAgentListing(client: OpenCodeClient, cacheTtlMs: number = CACHE_TTL): Promise<AgentListing> {
  // Non-object clients (the host's probes) can't key a WeakMap; they also
  // can't serve a successful fetch, so they simply never cache.
  const cacheKey: object | null = typeof client === "object" && client !== null ? client : null;
  const now = Date.now();
  const cached = cacheKey ? agentCaches.get(cacheKey) : undefined;
  if (cached && cached.epoch === agentCacheEpoch && cached.agents.length > 0 && now - cached.at < cacheTtlMs) {
    return { agents: cached.agents, known: true };
  }

  // One immediate retry: setup races and transient blips often clear on
  // re-dial; persistent failure keeps the warn-and-stale behavior below.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result: unknown = await client.app.agents();
      const entry: AgentCacheEntry = {
        agents: parseAgentList(result).filter((a) => isDispatchableAgent(a)),
        at: Date.now(),
        epoch: agentCacheEpoch,
      };
      if (cacheKey) agentCaches.set(cacheKey, entry);
      return { agents: entry.agents, known: true };
    } catch (error: unknown) {
      if (attempt === 1 && error instanceof Error) {
        // safeLog, not a raw app.log: the client itself may be unusable
        // (host probes entry exports outside the plugin lifecycle) and a
        // throw here fails the entire plugin boot.
        await safeLog(client, "warn", `Failed to fetch agents: ${error.message}`);
      }
    }
  }

  // Persistent failure: serve this client's last known list from the current
  // epoch — stale beats empty, another client's list never does.
  if (cached && cached.epoch === agentCacheEpoch) return { agents: cached.agents, known: true };
  return { agents: [], known: false };
}

/** Test seam: invalidates every client's cached agent list. Production code never calls this. */
export function resetAgentCache(): void {
  agentCacheEpoch++;
}
