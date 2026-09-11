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
