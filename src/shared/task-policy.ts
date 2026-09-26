// src/shared/task-policy.ts
// Pure policy functions for agent validation, lineage tracking, and async-default resolution.
// No OpenCode client calls, no task-map mutation, no environment reads.
// All config is passed in via the DynamicTaskConfig parameter.

import type { DynamicTaskConfig } from "./config.js";
import type { Refusal } from "./verdict.js";
import type { AgentRecord } from "./host-shape.js";

// ─── PolicyResult ──────────────────────────────────────────────────

export type PolicyResult = { ok: true } | Refusal;

// ─── normalizeAgentName ────────────────────────────────────────────
// Normalizes agent name: lowercases, strips @ prefix, trims whitespace.
// Returns null for invalid/empty values.

export function normalizeAgentName(agentName: unknown): string | null {
  if (typeof agentName !== "string") return null;
  const trimmed = agentName.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  // Strip leading @
  return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

// ─── validateAgent ─────────────────────────────────────────────────
// Checks if an agent is in the blocked list. Returns ok:false with message if blocked.

export function validateAgent(agentName: unknown, config: DynamicTaskConfig): PolicyResult {
  const name = normalizeAgentName(agentName);
  if (!name) {
    return { ok: false, error: "Invalid agent name: must be a non-empty string." };
  }

  for (const blocked of config.blockedAgents) {
    const normalizedBlocked = normalizeAgentName(blocked);
    if (normalizedBlocked && normalizedBlocked === name) {
      return {
        ok: false,
        error: `Agent "${agentName}" is blocked by this plugin's configuration. ` +
          `Blocked agents: ${config.blockedAgents.join(", ")}. ` +
          "Use a different subagent or update the blockedAgents config.",
      };
    }
  }

  return { ok: true };
}

// ─── isDispatchableAgent ───────────────────────────────────────────
// Whether an agent may be invoked as a subagent by dynamic_task.
// OpenCode's Agent.mode is a tri-state: "primary" | "subagent" | "all".
// - "subagent": only ever invokable as a child → dispatchable.
// - "all": usable as primary OR subagent → dispatchable.
// - "primary": main-loop only → NOT dispatchable.
// An absent/empty mode falls back to "all" (OpenCode's own default), so
// unannotated agents remain dispatchable. A legacy `type` field is honored
// when `mode` is absent to survive older API response shapes.

export function isDispatchableAgent(agent: AgentRecord): boolean {
  const raw = agent?.mode || agent?.type || "all";
  const mode = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return mode === "subagent" || mode === "all";
}

// ─── agentCanNotify ──────────────────────────────────────────────
// Whether a child of this agent can reach the plugin at all.
//
// Tool provisioning is per-AGENT on the host side and the plugin cannot change
// it: a read-only agent's children get the default map, which carries no
// task_notify. The background opening used to offer that channel to every child
// regardless, and a live smoke test caught what that costs — an @explore child,
// told to call task_notify, replied that the tool was not in its toolset and
// "I will not fabricate a call to it". The worse half is the quiet one: a child
// that is genuinely stuck has no way to declare needs_input, so it settles
// `completed` and the parent is handed a success that never happened.
//
// The load-bearing claim is that a PRESENT tool map is a COMPLETE enumeration of
// that agent's tools, so "present, no task_notify" means the tool is absent. The
// SDK's Agent type declares it as a full `{ [key]: boolean }` map, and the live
// read agrees: an @explore agent's map lists bash/glob/grep/read/webfetch/
// websearch and nothing else. Reading a partial map as complete would produce the
// same false negative this function exists to remove.
//
// ABSENT map is the only unknown, and it fails SAFE TOWARD THE CHANNEL: the
// child is assumed to have the tool. Absence of knowledge must never blind a
// child to its own voice — that would break the common case to fix the rare one.
export function agentCanNotify(agent: AgentRecord, tool: string = "task_notify"): boolean {
  const tools: unknown = agent?.tools;
  if (tools === null || typeof tools !== "object" || Array.isArray(tools)) return true;
  const entries = Object.entries(tools as Record<string, unknown>);
  // Exact key first: the host may namespace the tool, and a loose match found
  // first would otherwise let iteration order decide the answer.
  const named = entries.find(([name]) => name === tool) ?? entries.find(([name]) => name.includes(tool));
  return named ? named[1] !== false : false;
}

// ─── isSameAgent ───────────────────────────────────────────────────
// Checks if parent and child agent names refer to the same agent.
// Normalizes both names before comparison.

export function isSameAgent(parentAgent: unknown, childAgent: unknown): boolean {
  const parentNormalized = normalizeAgentName(parentAgent);
  const childNormalized = normalizeAgentName(childAgent);
  if (!parentNormalized || !childNormalized) return false;
  return parentNormalized === childNormalized;
}

// ─── validateLineage ───────────────────────────────────────────────
// Checks if a new child agent would violate lineage rules:
// 1. Same-agent recursion anywhere in lineage → block (absolute)
// 2. Next depth exceeds maxDepth → block
// Does NOT mutate the lineage array.

export function validateLineage(
  lineage: string[],
  childAgent: string,
  config: DynamicTaskConfig,
): PolicyResult {
  const childName = normalizeAgentName(childAgent);
  if (!childName) {
    return { ok: false, error: "Invalid child agent name." };
  }

  // Rule 1: Same-agent recursion check (runs before depth check) —
  // skipped only when the operator explicitly allows re-delegation.
  if (!config.allowSameAgentRecursion) {
    for (const ancestor of lineage) {
      if (isSameAgent(ancestor, childName)) {
        return {
          ok: false,
          error: `Recursive delegation blocked: agent "${childAgent}" ` +
            `is already present in the task lineage. ` +
            "Same-agent delegation is not allowed at any depth.",
        };
      }
    }
  }

  // Rule 2: Depth check (applies to different-agent chains only)
  if (config.maxDepth >= 0 && lineage.length >= config.maxDepth) {
    return {
      ok: false,
      error: `Max delegation depth (${config.maxDepth}) exceeded. ` +
        `Current lineage: [${lineage.join(", ")}]. ` +
        "Increase maxDepth in config or delegate to a shorter chain.",
    };
  }

  return { ok: true };
}

// ─── buildTaskLineage ──────────────────────────────────────────────
// Appends the child agent to the parent's lineage for the new session.
// Returns a NEW array — does not mutate the input.

export function buildTaskLineage(parentLineage: string[], childAgent: string): string[] {
  return [...parentLineage, childAgent];
}
