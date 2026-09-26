// src/shared/config.ts
// Normalizes plugin options and environment overrides into one typed record.
// Durable-state bounds live here (retention TTL, entry cap). There are no
// wait budgets to own: the plugin arms no timers — settlement is event-driven.
import { readFileSync } from "node:fs";
import type { PluginOptions } from "@opencode-ai/plugin";

export interface DynamicTaskConfig {
  maxDepth: number;
  maxConcurrent: number;
  agentCacheTtlMs: number;
  retainedTaskTtlMs: number;
  retainedTaskMaxEntries: number;
  blockedAgents: string[];
  allowSameAgentRecursion: boolean;
}

export const DEFAULT_CONFIG: DynamicTaskConfig = {
  maxDepth: 2,
  maxConcurrent: 4,
  agentCacheTtlMs: 300_000,
  retainedTaskTtlMs: 3_600_000,
  retainedTaskMaxEntries: 100,
  // Any agent dispatches by default — lineage, depth, and recursion policy
  // bound the real hazards (self-spawning loops), not the agent name.
  // Operators who want names barred keep the blocklist as policy.
  blockedAgents: [],
  allowSameAgentRecursion: false,
};

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

// Shape-checked merge of one untyped config source (tuple options or parsed
// file) onto the target — invalid fields are ignored, never coerced.
function applyKnownFields(target: DynamicTaskConfig, src: unknown): void {
  if (!src || typeof src !== "object" || Array.isArray(src)) return;
  const s = src as Record<string, unknown>;
  const positive = (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
  if (positive(s.maxDepth)) target.maxDepth = Math.floor(s.maxDepth);
  if (positive(s.maxConcurrent)) target.maxConcurrent = Math.floor(s.maxConcurrent);
  if (positive(s.agentCacheTtlMs)) target.agentCacheTtlMs = Math.floor(s.agentCacheTtlMs);
  if (positive(s.retainedTaskTtlMs)) target.retainedTaskTtlMs = Math.floor(s.retainedTaskTtlMs);
  if (positive(s.retainedTaskMaxEntries)) target.retainedTaskMaxEntries = Math.floor(s.retainedTaskMaxEntries);
  if (Array.isArray(s.blockedAgents)) {
    // An explicit empty list is a real setting ("block nothing"), not an
    // absent one — it must override the default blocklist.
    target.blockedAgents = s.blockedAgents.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
  }
  if (typeof s.allowSameAgentRecursion === "boolean") target.allowSameAgentRecursion = s.allowSameAgentRecursion;
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
  const base: DynamicTaskConfig = { ...DEFAULT_CONFIG };
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
    agentCacheTtlMs: merged.agentCacheTtlMs,
    retainedTaskTtlMs: merged.retainedTaskTtlMs,
    retainedTaskMaxEntries: merged.retainedTaskMaxEntries,
    blockedAgents: merged.blockedAgents,
    allowSameAgentRecursion: merged.allowSameAgentRecursion,
  };
}

// The only part of the config a concurrency decision reads. Named so that both
// the limit's own signature and the registration that enforces it agree on what
// "the limit" is made of, instead of two `Pick<DynamicTaskConfig, "maxConcurrent">`
// spellings that a second limit field would have to reach separately.
export type ConcurrencyConfig = Pick<DynamicTaskConfig, "maxConcurrent">;

export function checkConcurrencyLimit(activeCount: number, config: ConcurrencyConfig): string | null {
  if (activeCount >= config.maxConcurrent) {
    return `ConcurrencyLimitExceeded: Cannot run more than ${config.maxConcurrent} active tasks (current: ${activeCount}). Wait for a completion notification to arrive, or raise maxConcurrent in the dynamic-task config. Use task_list to see the slot holders; task_interrupt frees a slot, and reviving a settled task needs a free slot too.`;
  }
  return null;
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
