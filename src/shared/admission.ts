// src/shared/admission.ts
// Spawn admission gate (Task 07) — the ONLY module that resolves agents,
// applies policy, and registers tasks. Callers render errors; this module
// decides. Lineage resolution (parentID chains) and dependency readiness
// land here in Task 07 proper; the funnel exists now so no new spawn path
// can bypass it.

import type { DynamicTaskConfig } from "./config.js";
import type { OpenCodeClient } from "./client.js";
import { safeLog } from "./notify.js";
import {
  validateAgent,
  validateLineage,
  buildTaskLineage,
  isDispatchableAgent,
} from "./task-policy.js";
import {
  registerActiveTask,
  findTask,
  type ActiveTaskState,
  type TaskStore,
} from "./task-state.js";

export interface AgentRecord {
  name: string;
  [key: string]: unknown;
}

export type AdmissionDeniedReason =
  | { kind: "missing-name" }
  | { kind: "unknown-agent"; requested: string }
  | { kind: "blocked"; message: string }
  | { kind: "lineage"; message: string };

export type Admission =
  | { ok: true; agent: AgentRecord; newLineage: string[] }
  | { ok: false; reason: AdmissionDeniedReason };

// ─── resolveAdmission ──────────────────────────────────────────────
// Pre-create check: find the agent by name (case-insensitive, trimmed —
// same matching the orchestrator has always used), then apply blocked-agent
// and lineage policy. Pure wrt the store: no mutation, no client calls.

export function resolveAdmission(
  agents: AgentRecord[],
  requestedName: unknown,
  lineage: string[],
  config: DynamicTaskConfig,
): Admission {
  const normalized =
    typeof requestedName === "string" ? requestedName.toLowerCase().trim() : "";
  if (!normalized) {
    return { ok: false, reason: { kind: "missing-name" } };
  }

  const agent = agents.find((a) => a.name.toLowerCase() === normalized);
  if (!agent) {
    return { ok: false, reason: { kind: "unknown-agent", requested: String(requestedName) } };
  }

  const agentCheck = validateAgent(agent.name, config);
  if (!agentCheck.ok) {
    return { ok: false, reason: { kind: "blocked", message: agentCheck.error } };
  }

  const lineageCheck = validateLineage(lineage, agent.name, config);
  if (!lineageCheck.ok) {
    return { ok: false, reason: { kind: "lineage", message: lineageCheck.error } };
  }

  return { ok: true, agent, newLineage: buildTaskLineage(lineage, agent.name) };
}

// ─── resolveDependencies ───────────────────────────────────────────
// Readiness gate: strict dependencies must have completed; settled-wait
// dependencies must have left active (any terminal state satisfies). Running
// deps block under both lists. Unknown ids pass: they may have completed and
// aged out of the bounded retained history, and blocking forever on
// garbage-collected history would deadlock planners.

const SATISFIED_DEPENDENCY_STATES: readonly string[] = ["completed"];
const SETTLED_DEPENDENCY_STATES: readonly string[] = ["completed", "error", "interrupted"];

export interface DependencyBlock {
  id: string;
  state: string;
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
  const check = (id: string, states: readonly string[]): void => {
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

// ─── formatAdmissionError ──────────────────────────────────────────
// Single rendering for every refusal (Tenet 1 for error text): the gate
// decides, this formats, callers return verbatim.

export function formatAdmissionError(
  reason: AdmissionDeniedReason,
  available: string,
  requestedName: unknown,
): string {
  if (reason.kind === "missing-name") {
    return `ERROR: No subagent_type provided.\n\nAvailable: ${available}`;
  }
  if (reason.kind === "unknown-agent") {
    return `ERROR: Agent "${String(requestedName)}" not found.\n\nAvailable: ${available}`;
  }
  return `ERROR: ${reason.message}`;
}

// ─── parseAgentList ────────────────────────────────────────────────
// Turns an untyped registry response into agent records. The 1.18 client
// returns a { data } envelope; older servers and tests use bare arrays or
// { agents } wrappers — the first non-empty list wins, anything else yields
// []. Records are validated minimally ({name: string}); mode policy stays
// in isDispatchableAgent.

export function parseAgentList(result: unknown): AgentRecord[] {
  const groups: unknown[] = [];
  if (Array.isArray(result)) {
    groups.push(result);
  } else if (result && typeof result === "object") {
    const envelope = result as { agents?: unknown; data?: unknown };
    if (envelope.agents !== undefined) groups.push(envelope.agents);
    if (envelope.data !== undefined) groups.push(envelope.data);
    if (groups.length === 0) groups.push(Object.values(envelope));
  }
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

export interface RegistrationParams {
  childSessionId: string;
  parentSessionId: string;
  agentName: string;
  description: string;
  lineage: string[];
  requestedModel?: { providerID: string; modelID: string } | undefined;
  dependsOn?: string[] | undefined;
  dependsOnSettled?: string[] | undefined;
}

export function registerAdmittedTask(
  store: TaskStore,
  params: RegistrationParams,
  config: DynamicTaskConfig,
): ActiveTaskState {
  return registerActiveTask(store, params, config);
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

export function buildAgentList(agents: unknown): string {
  // Total on malformed input: the host may invoke named exports outside the
  // default-export lifecycle (observed: called with a non-array while the
  // plugin entry never ran), and a throw here fails the entire plugin boot.
  // Never throw; degrade to the empty-list marker.
  if (!Array.isArray(agents)) return "(none discovered)";
  const names = agents.filter(isAgentRecord).map((a) => a.name);
  if (names.length === 0) return "(none discovered)";
  return names.join(", ");
}

export async function fetchAgents(client: OpenCodeClient, cacheTtlMs: number = CACHE_TTL): Promise<AgentRecord[]> {
  // Non-object clients (the host's probes) can't key a WeakMap; they also
  // can't serve a successful fetch, so they simply never cache.
  const cacheKey: object | null = typeof client === "object" && client !== null ? client : null;
  const now = Date.now();
  const cached = cacheKey ? agentCaches.get(cacheKey) : undefined;
  if (cached && cached.epoch === agentCacheEpoch && cached.agents.length > 0 && now - cached.at < cacheTtlMs) {
    return cached.agents;
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
      return entry.agents;
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
  if (cached && cached.epoch === agentCacheEpoch) return cached.agents;
  return [];
}

/** Test seam: invalidates every client's cached agent list. Production code never calls this. */
export function resetAgentCache(): void {
  agentCacheEpoch++;
}
