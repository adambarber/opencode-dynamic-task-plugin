// src/shared/admission.ts
// Spawn admission gate (Task 07) — the ONLY module that resolves agents,
// applies policy, and registers tasks. Callers render errors; this module
// decides. Lineage resolution (parentID chains) and dependency readiness
// land here in Task 07 proper; the funnel exists now so no new spawn path
// can bypass it.

import type { DynamicTaskConfig } from "./config.js";
import {
  validateAgent,
  validateLineage,
  buildTaskLineage,
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
// Readiness gate: every dependency must have completed — straightforwardly
// or after an earlier timeout. Running, failed, timed-out, and interrupted
// deps block with the pending set. Unknown ids pass: they may have
// completed and aged out of the bounded retained history, and blocking
// forever on garbage-collected history would deadlock planners.

const SATISFIED_DEPENDENCY_STATES: readonly string[] = [
  "completed",
  "completed_after_timeout",
];

export function resolveDependencies(
  store: TaskStore,
  dependsOn: string[] | undefined,
): { ok: true } | { ok: false; pending: string[] } {
  if (!dependsOn || dependsOn.length === 0) return { ok: true };
  const pending = dependsOn.filter((id) => {
    const task = findTask(store, id);
    if (!task) return false;
    return !SATISFIED_DEPENDENCY_STATES.includes(task.state);
  });
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
  isBackground: boolean;
  requestedModel?: string;
  dependsOn?: string[];
}

export function registerAdmittedTask(
  store: TaskStore,
  params: RegistrationParams,
  config: DynamicTaskConfig,
): ActiveTaskState {
  return registerActiveTask(store, params, config);
}
