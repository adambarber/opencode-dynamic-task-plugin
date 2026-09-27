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

export function validateAgent(agentName: unknown, config: Pick<DynamicTaskConfig, "blockedAgents">): PolicyResult {
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
// 2. Next depth exceeds the LANE's cap → block
// Does NOT mutate the lineage array.
//
// The depth rule is judged against a resolved `LineagePolicy`, not against the
// top-level config, because an agent may carry its own `maxDepth`. Taking the
// top-level number here is how an agent's depth cap becomes a field the operator
// sets, sees in their config, and watches nothing happen — a declared limit that
// does not limit is worse than no field, because it is trusted.

/**
 * How deep a dispatch may nest, and WHICH constraint actually binds.
 *
 * Two constraints, and only one of them is the number in the config. When
 * `allowSameAgentRecursion` is false a generation may not repeat an agent NAME,
 * so a chain can be no longer than the number of distinct dispatchable agents —
 * and a `maxDepth: 4` on a project with two agent types is a 2 that reads as a 4.
 * That is the whole reason this value exists: "the depth limit is 4" and the
 * refusal says "agent X is already in the lineage" is a contradiction the
 * operator cannot debug from a string, so the string names the binding
 * constraint instead.
 */
export interface LineagePolicy {
  /** The dispatching agent's cap. Negative means "no depth limit", as it always has. */
  maxDepth: number;
  allowSameAgentRecursion: boolean;
}

/**
 * Which constraint caps the reachable depth.
 *
 * An enum, like every other discriminant here, so "the agent set is what binds"
 * is a named value that cannot be misspelled at a comparison site — a raw
 * `"agent-set"` compiles against a union just fine and silently never matches if
 * the spelling drifts, which is how a depth line printed the number that was not
 * in force.
 */
export enum DepthBound {
  AgentCap = "agent-cap",
  AgentSet = "agent-set",
}

export interface DepthLimits {
  /** The cap as configured — what the operator wrote. */
  configured: number;
  /** The depth actually reachable, which may be lower. */
  effective: number;
  boundBy: DepthBound;
}

/**
 * The reachable depth, and the constraint that binds it.
 *
 * `agentNames` is the dispatchable set, not every agent the host publishes: an
 * agent this plugin would refuse cannot be used to go deeper, so counting it
 * would report a depth the operator can never reach. Distinct by NORMALIZED
 * name, because that is the comparison the recursion rule makes.
 */
export function depthLimits(policy: LineagePolicy, agentNames: readonly string[]): DepthLimits {
  if (policy.allowSameAgentRecursion) {
    return { configured: policy.maxDepth, effective: policy.maxDepth, boundBy: DepthBound.AgentCap };
  }
  const distinct = new Set(agentNames.map(normalizeAgentName).filter((name): name is string => name !== null));
  const byAgentSet = distinct.size;
  // A negative cap is "no limit", and no number of agents makes one reachable
  // depth — so the agent set does not bind and the cap is the whole answer.
  if (policy.maxDepth < 0) {
    return { configured: policy.maxDepth, effective: Number.POSITIVE_INFINITY, boundBy: DepthBound.AgentCap };
  }
  return policy.maxDepth <= byAgentSet
    ? { configured: policy.maxDepth, effective: policy.maxDepth, boundBy: DepthBound.AgentCap }
    : { configured: policy.maxDepth, effective: byAgentSet, boundBy: DepthBound.AgentSet };
}

/** The depth refusal, in words that name the constraint that produced it. */
function depthRefusal(agent: string, limits: DepthLimits, lineage: string[]): string {
  const where = `Current lineage: [${lineage.join(", ")}].`;
  if (limits.boundBy === DepthBound.AgentSet) {
    return `Max delegation depth exceeded for agent "${agent}": the cap is ${limits.configured}, but only ` +
      `${limits.effective} distinct agent(s) are dispatchable and same-agent recursion is off, so no chain ` +
      `can go deeper. ${where} Raise maxDepth once more agents are dispatchable, or set ` +
      "allowSameAgentRecursion to spend depth instead of breadth.";
  }
  return `Max delegation depth (${limits.configured}) exceeded for agent "${agent}". ${where} ` +
    "Raise that agent's maxDepth, or delegate to a shorter chain.";
}

export function validateLineage(
  lineage: string[],
  childAgent: string,
  policy: LineagePolicy,
  agentNames: readonly string[],
): PolicyResult {
  const childName = normalizeAgentName(childAgent);
  if (!childName) {
    return { ok: false, error: "Invalid child agent name." };
  }

  // Rule 1: Same-agent recursion check (runs before depth check) —
  // skipped only when the operator explicitly allows re-delegation.
  if (!policy.allowSameAgentRecursion) {
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

  // Rule 2: Depth, against the LANE's cap and with the binding constraint named.
  const limits = depthLimits(policy, agentNames);
  if (limits.effective <= lineage.length) {
    return { ok: false, error: depthRefusal(childAgent, limits, lineage) };
  }

  return { ok: true };
}

// ─── buildTaskLineage ──────────────────────────────────────────────
// Appends the child agent to the parent's lineage for the new session.
// Returns a NEW array — does not mutate the input.

export function buildTaskLineage(parentLineage: string[], childAgent: string): string[] {
  return [...parentLineage, childAgent];
}
