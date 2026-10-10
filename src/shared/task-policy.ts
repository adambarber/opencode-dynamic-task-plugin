// src/shared/task-policy.ts
// Pure policy functions for agent validation, lineage tracking, and async-default resolution.
// No OpenCode client calls, no task-map mutation, no environment reads.
// All config is passed in via the DynamicTaskConfig parameter.

import type { DynamicTaskConfig } from "./config.js";
import type { AgentRecord } from "./host-shape.js";
import type { Refusal } from "./verdict.js";

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
    return { error: "Invalid agent name: must be a non-empty string.", ok: false };
  }

  for (const blocked of config.blockedAgents) {
    const normalizedBlocked = normalizeAgentName(blocked);
    if (normalizedBlocked && normalizedBlocked === name) {
      return {
        error: `Agent "${name}" is blocked by this plugin's configuration. ` +
          `Blocked agents: ${config.blockedAgents.join(", ")}. ` +
          "Use a different subagent or update the blockedAgents config.",
        ok: false,
      };
    }
  }

  return { ok: true };
}

// ─── isDispatchableAgent ───────────────────────────────────────────
// Whether an agent may be invoked as a subagent by dynamic_task.
//
// v2 declares `mode` as the exact tri-state "subagent" | "primary" | "all":
//   - "subagent": only ever invokable as a child → dispatchable.
//   - "all": usable as primary OR subagent → dispatchable.
//   - "primary": main-loop only → NOT dispatchable.
//
// The v1 fallbacks are gone because the constructor normalised them: `mode` is either
// a declared word or the one default stated beside the constructor, and the legacy
// `type` field a v1 payload carried is not a field this plugin can see any more.

export function isDispatchableAgent(agent: AgentRecord): boolean {
  // The host's own filter excludes hidden agents alongside primary-mode ones;
  // offering one is promising a dispatch the host's listing suppresses.
  return (agent.mode === "subagent" || agent.mode === "all") && !agent.hidden;
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
 * The part of a depth binding that decides whether a value is reachable.
 *
 * Structural and not `DepthLimits`, because the two callers hold DIFFERENT widths of
 * the same thing and a parameter typed as the resolver's return would refuse the one
 * that has to carry "unknown": the dispatch path always knows its agent set, while a
 * TUI process that could not ask the host knows nothing and must say so rather than
 * claim a depth. Naming the two fields keeps the predicate honest about being the only
 * place that asks.
 */
interface DepthFacts { effective: number | null; boundBy: DepthBound | null }

/**
 * The depth in force when the agent set holds `depth` below it, else null.
 *
 * One predicate for one fact, and it is why the two screens that show a depth cap agree
 * with each other and with the dispatch path. It answers per CANDIDATE value on
 * purpose: the caps screen asks about the value in force, the picker asks about each
 * value it offers, and a caller that needed a second value used to re-derive the
 * binding itself — which is how a screen ends up offering a depth the resolver would
 * refuse.
 *
 * Three conditions, and each refuses a different claim: a cap the operator set is not
 * held down by anything, a binding whose agent set could not be read must not claim a
 * depth it could not compute, and a ceiling at or above the value changes nothing — so
 * `4/4` would be a second number to read for no information.
 */
export function depthHeldBy(facts: DepthFacts, depth: number): number | null {
  if (facts.boundBy !== DepthBound.AgentSet) return null;
  const {effective} = facts;
  if (effective === null || !isFinite(effective) || effective >= depth) return null;
  return effective;
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
    return { boundBy: DepthBound.AgentCap, configured: policy.maxDepth, effective: policy.maxDepth };
  }
  const distinct = new Set(agentNames.map(normalizeAgentName).filter((name): name is string => name !== null));
  const byAgentSet = distinct.size;
  // A negative cap is "no limit", and no number of agents makes one reachable
  // depth — so the agent set does not bind and the cap is the whole answer.
  if (policy.maxDepth < 0) {
    return { boundBy: DepthBound.AgentCap, configured: policy.maxDepth, effective: Number.POSITIVE_INFINITY };
  }
  return policy.maxDepth <= byAgentSet
    ? { boundBy: DepthBound.AgentCap, configured: policy.maxDepth, effective: policy.maxDepth }
    : { boundBy: DepthBound.AgentSet, configured: policy.maxDepth, effective: byAgentSet };
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
    return { error: "Invalid child agent name.", ok: false };
  }

  // Rule 1: Same-agent recursion check (runs before depth check) —
  // skipped only when the operator explicitly allows re-delegation.
  if (!policy.allowSameAgentRecursion) {
    for (const ancestor of lineage) {
      if (isSameAgent(ancestor, childName)) {
        return {
          error: `Recursive delegation blocked: agent "${childAgent}" ` +
            `is already present in the task lineage. ` +
            "Same-agent delegation is not allowed at any depth.",
          ok: false,
        };
      }
    }
  }

  // Rule 2: Depth, against the LANE's cap and with the binding constraint named.
  const limits = depthLimits(policy, agentNames);
  if (limits.effective <= lineage.length) {
    return { error: depthRefusal(childAgent, limits, lineage), ok: false };
  }

  return { ok: true };
}

// ─── buildTaskLineage ──────────────────────────────────────────────
// Appends the child agent to the parent's lineage for the new session.
// Returns a NEW array — does not mutate the input.

export function buildTaskLineage(parentLineage: string[], childAgent: string): string[] {
  return [...parentLineage, childAgent];
}
