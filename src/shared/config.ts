// src/shared/config.ts
// Normalizes plugin options and environment overrides into one typed record.
// Durable-state bounds live here (retention TTL, entry cap). There are no
// wait budgets to own: the plugin arms no timers — settlement is event-driven.
//
// This module owns PRECEDENCE — which of the places a config comes from wins — and
// nothing else. What a cap MEANS, which agent it belongs to, and whether a dispatch
// may spend one are `caps.ts`, which imports the shape from here. The split is the
// point: a config that also judged its own numbers had two answers to "how many of
// this agent may run", and the one that happened to be called first was the one the
// operator saw.
import { readFileSync } from "node:fs";
import type { PluginOptions } from "@opencode-ai/plugin";
import { agentKey, parseAgentCaps, type AgentCaps } from "./caps.js";
import { isPlainRecord } from "./host-shape.js";

export interface DynamicTaskConfig {
  maxDepth: number;
  maxConcurrent: number;
  /**
   * Per-agent caps, by agent name. Empty means "no agent is capped separately", not
   * "no agents" — the keys are the HOST's registered agents, so this is a set of
   * exceptions to the two numbers above, never a second vocabulary of the
   * operator's own. See `resolveAgentCaps`.
   */
  agents: Record<string, AgentCaps>;
  agentCacheTtlMs: number;
  retainedTaskTtlMs: number;
  retainedTaskMaxEntries: number;
  blockedAgents: string[];
  allowSameAgentRecursion: boolean;
}

/**
 * A fresh default set, BY CONSTRUCTION rather than by copying.
 *
 * A normalized config is built by writing into a mutable object, and the obvious
 * seed — `{ ...DEFAULT_CONFIG }` — copies only the top level. The first nested
 * field added to the config is then written THROUGH into the process-wide
 * default, so every config normalized in the process permanently inherits every
 * value anyone declared: two plugins in one process, or one plugin reconfigured
 * between boots, would each see the other's lanes, and `DEFAULT_CONFIG` itself
 * would stop being the default. Nothing about the mistake is visible at the call
 * site, so the fix is to remove the trap rather than to remember the copy: a
 * factory makes aliasing unrepresentable, because a nested field added inside it
 * is fresh by definition.
 */
function buildDefaultConfig(): DynamicTaskConfig {
  return {
    maxDepth: 2,
    maxConcurrent: 4,
    agents: {},
    agentCacheTtlMs: 300_000,
    retainedTaskTtlMs: 3_600_000,
    retainedTaskMaxEntries: 100,
    // Any agent dispatches by default — lineage, depth, and recursion policy
    // bound the real hazards (self-spawning loops), not the agent name.
    // Operators who want names barred keep the blocklist as policy.
    blockedAgents: [],
    allowSameAgentRecursion: false,
  };
}

export const DEFAULT_CONFIG: DynamicTaskConfig = buildDefaultConfig();

function envValue(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return undefined;
  return Math.floor(parsed);
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return undefined;
}

function trimStringList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}



function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

// Shape-checked merge of one untyped config source (tuple options or parsed
// file) onto the target — invalid fields are ignored, never coerced.
function applyKnownFields(target: DynamicTaskConfig, src: unknown): void {
  if (!isPlainRecord(src)) return;
  const s = src;
  if (positiveInt(s.maxDepth) !== undefined) target.maxDepth = positiveInt(s.maxDepth) as number;
  if (positiveInt(s.maxConcurrent) !== undefined) target.maxConcurrent = positiveInt(s.maxConcurrent) as number;
  if (positiveInt(s.agentCacheTtlMs) !== undefined) target.agentCacheTtlMs = positiveInt(s.agentCacheTtlMs) as number;
  if (positiveInt(s.retainedTaskTtlMs) !== undefined) target.retainedTaskTtlMs = positiveInt(s.retainedTaskTtlMs) as number;
  if (positiveInt(s.retainedTaskMaxEntries) !== undefined) target.retainedTaskMaxEntries = positiveInt(s.retainedTaskMaxEntries) as number;
  if (Array.isArray(s.blockedAgents)) {
    // An explicit empty list is a real setting ("block nothing"), not an
    // absent one — it must override the default blocklist.
    target.blockedAgents = s.blockedAgents.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
  }
  if (typeof s.allowSameAgentRecursion === "boolean") target.allowSameAgentRecursion = s.allowSameAgentRecursion;
  if (!isPlainRecord(s.agents)) return;
  for (const [rawName, rawBody] of Object.entries(s.agents)) {
    // `agentKey` and `parseAgentCaps` are the caps module's, deliberately: this is the
    // WRITE side of the same two questions the resolver asks on the read side, and an
    // answer to each that lived on both sides is an answer that can disagree. A cap
    // written here is then guaranteed to be one `resolveAgentCaps` will find.
    const name = agentKey(rawName);
    const caps = parseAgentCaps(rawBody);
    if (!name || !caps) continue;
    target.agents[name] = { ...target.agents[name], ...caps };
  }
}


/**
 * The environment variable each knob is read from, named once.
 *
 * A test has to spell these names to set them, so a name written in a test is a
 * restatement of production's — and the failure mode is silent rather than loud:
 * a renamed variable leaves the test setting an environment nothing reads, so it
 * configures nothing and still passes. Six of them were spelled out on both sides.
 */
export const ENV = {
  maxDepth: "DYNAMIC_TASK_MAX_DEPTH",
  maxConcurrent: "DYNAMIC_TASK_MAX_CONCURRENT",
  agentCacheTtlMs: "DYNAMIC_TASK_CACHE_TTL",
  retainedTaskTtlMs: "DYNAMIC_TASK_RETAINED_TTL_MS",
  retainedTaskMaxEntries: "DYNAMIC_TASK_RETAINED_MAX_ENTRIES",
  blockedAgents: "DYNAMIC_TASK_FORBIDDEN_AGENTS",
  allowSameAgentRecursion: "DYNAMIC_TASK_ALLOW_SAME_AGENT_RECURSION",
} as const;

export function normalizeDynamicTaskConfig(
  options: PluginOptions | null | undefined,
  fileConfig?: unknown,
): DynamicTaskConfig {
  // Precedence: env > tuple options > file config > defaults.
  const base: DynamicTaskConfig = buildDefaultConfig();
  applyKnownFields(base, fileConfig);
  applyKnownFields(base, options);

  const env: Partial<Record<keyof DynamicTaskConfig, () => number | string[] | boolean | undefined>> = {
    maxDepth: () => parsePositiveInt(envValue(ENV.maxDepth)),
    maxConcurrent: () => parsePositiveInt(envValue(ENV.maxConcurrent)),
    agentCacheTtlMs: () => parsePositiveInt(envValue(ENV.agentCacheTtlMs)),
    retainedTaskTtlMs: () => parsePositiveInt(envValue(ENV.retainedTaskTtlMs)),
    retainedTaskMaxEntries: () => parsePositiveInt(envValue(ENV.retainedTaskMaxEntries)),
    blockedAgents: () => {
      const raw = envValue(ENV.blockedAgents);
      if (!raw) return undefined;
      // A separator-only value (",", " , ") is absence, not an explicit
      // empty blocklist — only tuple/file arrays can deliberately clear it.
      const list = trimStringList(raw);
      return list.length > 0 ? list : undefined;
    },
    allowSameAgentRecursion: () => parseBoolean(envValue(ENV.allowSameAgentRecursion)),
  };

  const merged: DynamicTaskConfig = { ...base };
  for (const key of Object.keys(env) as (keyof DynamicTaskConfig)[]) {
    const override = env[key]?.();
    if (override !== undefined) {
      (merged[key] as number | string[] | boolean) = override;
    }
  }

  return {
    maxDepth: merged.maxDepth,
    maxConcurrent: merged.maxConcurrent,
    agents: merged.agents,
    agentCacheTtlMs: merged.agentCacheTtlMs,
    retainedTaskTtlMs: merged.retainedTaskTtlMs,
    retainedTaskMaxEntries: merged.retainedTaskMaxEntries,
    blockedAgents: merged.blockedAgents,
    allowSameAgentRecursion: merged.allowSameAgentRecursion,
  };
}

// File config (.opencode/dynamic-task-plugin.jsonc) parsed leniently and
// total on failure: a missing, empty, or malformed file yields null and the
// defaults win. Strips // and /* */ comments before JSON.parse; the comment
// regex keeps :// urls intact, and the whole read is best-effort.
export function parseDynamicTaskJsonc(filePath: string): Record<string, unknown> | null {
  if (!filePath) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const parsed = JSON.parse(stripped) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
