// src/shared/admission.ts
// Spawn admission gate (Task 07) — the ONLY module that resolves agents,
// applies policy, and registers tasks. Callers render errors; this module
// decides. Lineage resolution (parentID chains) and dependency readiness
// land here in Task 07 proper; the funnel exists now so no new spawn path
// can bypass it.

import type { DynamicTaskConfig } from "./config.js";
import { resolveAgentCaps } from "./caps.js";
import { liveAgentCaps } from "./caps.js";
import { safeLog } from "./notify.js";
import { callHost, type OpaqueHost } from "./client.js";

// The one host call the listing makes. Stated structurally so a FAKE can satisfy it
// without the whole host: the reader is bounded, so it needs the shape, not the client.
export interface AgentCaller {
  agent: { list: () => Promise<unknown> };
}

/**
 * What the agent listing needs from a host: just the opaque host, and not the host's
 * whole domain object — so a test can hand in a caller that lists agents and nothing
 * else, instead of claiming to be a host.
 */
export interface AgentLister<C = AgentCaller> {
  /** The only route to a host namespace from here, and it is always bounded. */
  host: OpaqueHost<C>;
}

import { admitPromptInput, type AdmittedPromptInput } from "./prompt.js";
import type { Verdict } from "./verdict.js";
import { errorMessage } from "./host-shape.js";
import { READ_BOUNDS } from "./execution-bound.js";
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
import { toAgentRecords, type AgentRecord } from "./agent-record.js";

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

/** The two refusals a policy check hands over as a bare sentence. */
const policyRefused = (message: string): AdmissionDenial => ({ refusal: `ERROR: ${message}` });

export type Admission =
  | { ok: true; agent: AgentRecord; newLineage: string[] }
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
  return agents.filter((agent) => validateAgent(agent.id, config).ok).map((agent) => agent.id);
}

export function resolveAdmission(
  agents: AgentRecord[],
  requestedName: unknown,
  lineage: string[],
  config: DynamicTaskConfig,
): Admission {
  const available = buildAgentList(agents);
  const normalized =
    typeof requestedName === "string" ? requestedName.toLowerCase().trim() : "";
  if (!normalized) {
    return { ok: false, reason: noSubagentType(available) };
  }

  // Either key spends: the registry id is what the host routes by, the display name
  // is what a person types. Both fold the same way, so neither spelling can admit
  // an agent the other would refuse.
  const agent = agents.find((a) => a.id.toLowerCase() === normalized || a.name.toLowerCase() === normalized);
  if (!agent) {
    return { ok: false, reason: unknownAgent(requestedName, available) };
  }

  const agentCheck = validateAgent(agent.name, config);
  if (!agentCheck.ok) {
    return { ok: false, reason: policyRefused(agentCheck.error) };
  }

  // Depth is judged against THIS AGENT's cap, read live so an edit in the dialog
  // applies to the next dispatch. There is no separate lane to admit: the agent name
  // a dispatch supplies IS the key space, and `unknownAgent` above has already
  // checked it against the host's registered set, so a second gate asking "is this
  // key declared" would only be able to disagree with the first.
  const policy = resolveAgentCaps(liveAgentCaps(config), agent.id);
  const lineageCheck = validateLineage(
    lineage,
    agent.name,
    { maxDepth: policy.maxDepth, allowSameAgentRecursion: config.allowSameAgentRecursion },
    dispatchableAgentNames(agents, config),
  );
  if (!lineageCheck.ok) {
    return { ok: false, reason: policyRefused(lineageCheck.error) };
  }

  return { ok: true, agent, newLineage: buildTaskLineage(lineage, agent.name) };
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
// The reader is one constructor over whatever `agent.list` answered. The v2 client
// answers its `AgentListOutput` envelope (`{ location, data }`); the TUI store answers
// a bare array. An earlier revision claimed the bare array was the only shape, so every
// live dispatch failed admission with "(none discovered)" — the envelope is not an
// array, and there is no second chance: the refusal names what was (not) found.

export function parseAgentList(result: unknown): AgentRecord[] {
  return toAgentRecords(result);
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
export function buildAgentList(agents: AgentRecord[]): string {
  if (!Array.isArray(agents)) return "(none discovered)";
  // The display labels: either spelling spends (admission matches id or name), so the
  // list shows the human one. The ROUTING key stays the id — see `AgentRecord`.
  const names = agents.map((a) => a.name);
  if (names.length === 0) return "(none discovered)";
  return names.join(", ");
}

export async function fetchAgents<C extends AgentCaller>(host: AgentLister<C>, cacheTtlMs: number = CACHE_TTL): Promise<AgentRecord[]> {
  return (await fetchAgentListing(host, cacheTtlMs)).agents;
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

/**
 * The dispatchable agent NAMES, or null when the host could not be asked.
 *
 * Two processes need this and neither can see the other's answer: the tool that
 * renders `task_list` and the TUI that renders the cap screen are separate modules in
 * separate processes, and both must ask "what could this project delegate to" the same
 * way. `null` is carried rather than collapsed into an empty list because the two
 * render differently and mean opposite things — no agents means this project cannot
 * delegate at all, a failed read means we do not know — and a caller that cannot tell
 * them apart will report a fleet it never observed.
 */
export async function dispatchableAgentNamesOrNull<C extends AgentCaller>(
  host: AgentLister<C>,
  config: DynamicTaskConfig,
): Promise<string[] | null> {
  const listing = await fetchAgentsOrUnknown(host, config.agentCacheTtlMs);
  return listing.known ? dispatchableAgentNames(listing.agents, config) : null;
}

export async function fetchAgentsOrUnknown<C extends AgentCaller>(
  host: AgentLister<C>,
  cacheTtlMs: number = CACHE_TTL,
): Promise<AgentListing> {
  return fetchAgentListing(host, cacheTtlMs);
}

async function fetchAgentListing<C extends AgentCaller>(host: AgentLister<C>, cacheTtlMs: number = CACHE_TTL): Promise<AgentListing> {
  // Keyed on the OPAQUE HOST, never on the `{ host }` wrapper: callers build that
  // wrapper per call, so keying on it gave every read a fresh cache. Non-object
  // clients (the host's probes) can't key a WeakMap; they also can't serve a
  // successful fetch, so they simply never cache.
  const inner = host?.host;
  const cacheKey: object | null = typeof inner === "object" && inner !== null ? inner : null;
  const now = Date.now();
  const cached = cacheKey ? agentCaches.get(cacheKey) : undefined;
  // `length > 0` is a guard against the SETUP RACE, not against caching hygiene, and
  // it is the reason the empty answer is never served from cache.
  //
  // A host that answers `app.agents()` with an empty list while it is still
  // registering its agents is a real behaviour — the same race the retry below
  // exists for, and that retry fires on a THROW, so it does not cover an empty
  // result. Cached, that empty list would be the answer for the whole TTL, and
  // `[]` is not a neutral value here: `dispatchableAgentNamesOrNull` returns it
  // as a KNOWN answer, `resolveAdmission` refuses every dispatch against it, and
  // the cap screen renders no agents. So a momentary empty list would spend the
  // TTL refusing work this project can do.
  //
  // The cost is one `app.agents()` per read in a project with no dispatchable
  // agents at all — a narrow, bounded cost — against a stale answer that is
  // neither bounded nor narrow. Deliberate, and now written down, because the
  // guard reads as an oversight and gets proposed for removal as one.
  if (cached && cached.epoch === agentCacheEpoch && cached.agents.length > 0 && now - cached.at < cacheTtlMs) {
    return { agents: cached.agents, known: true };
  }

  // One immediate retry: setup races and transient blips often clear on
  // re-dial; persistent failure keeps the warn-and-stale behavior below.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Bounded like every other read: a timeout becomes a THROW, so a host that
      // accepts the call and never answers lands on the same warn-and-serve-stale
      // path as a host that refuses it. Both facts are "the list is unknown".
      const listed = await callHost(host?.host, READ_BOUNDS.agents, (c) => c.agent.list(), () => undefined);
      if (listed.timedOut) throw new Error(`agent list unanswered after ${READ_BOUNDS.agents}ms`);
      const result: unknown = listed.value;
      const entry: AgentCacheEntry = {
        agents: parseAgentList(result).filter((a) => isDispatchableAgent(a)),
        at: Date.now(),
        epoch: agentCacheEpoch,
      };
      if (cacheKey) agentCaches.set(cacheKey, entry);
      return { agents: entry.agents, known: true };
    } catch (error: unknown) {
      // `errorMessage`, not a narrowing guard. A throw that is not an `Error` still
      // has something to say, and using the same narrowing as the CONDITION meant the
      // one log that reports the agent list could not be read stayed SILENT for
      // exactly the throws the host is most likely to make — and silence is the
      // failure this plugin's whole claim is about. The funnel decides even when its
      // answer is thin. (The banned idiom is named in DOC_TYPES' own rule rather than
      // quoted here, so that this comment does not trip the very scan it explains.)
      if (attempt === 1) {
        // safeLog, not a raw app.log: the client itself may be unusable
        // (host probes entry exports outside the plugin lifecycle) and a
        // throw here fails the entire plugin boot.
        void safeLog("warn", `Failed to fetch agents: ${errorMessage(error)}`);
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
