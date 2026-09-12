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
  blockedAgents: ["general"],
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

export function normalizeDynamicTaskConfig(
  options: PluginOptions | null | undefined,
  fileConfig?: unknown,
): DynamicTaskConfig {
  // Precedence: env > tuple options > file config > defaults.
  const base: DynamicTaskConfig = { ...DEFAULT_CONFIG };
  applyKnownFields(base, fileConfig);
  applyKnownFields(base, options);

  const env: Partial<Record<keyof DynamicTaskConfig, () => number | string[] | boolean | undefined>> = {
    maxDepth: () => parsePositiveInt(envValue("DYNAMIC_TASK_MAX_DEPTH")),
    maxConcurrent: () => parsePositiveInt(envValue("DYNAMIC_TASK_MAX_CONCURRENT")),
    agentCacheTtlMs: () => parsePositiveInt(envValue("DYNAMIC_TASK_CACHE_TTL")),
    retainedTaskTtlMs: () => parsePositiveInt(envValue("DYNAMIC_TASK_RETAINED_TTL_MS")),
    retainedTaskMaxEntries: () => parsePositiveInt(envValue("DYNAMIC_TASK_RETAINED_MAX_ENTRIES")),
    blockedAgents: () => {
      const raw = envValue("DYNAMIC_TASK_FORBIDDEN_AGENTS");
      return raw ? trimStringList(raw) : undefined;
    },
    allowSameAgentRecursion: () => parseBoolean(envValue("DYNAMIC_TASK_ALLOW_SAME_AGENT_RECURSION")),
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

export function checkConcurrencyLimit(
  activeCount: number,
  config: Pick<DynamicTaskConfig, "maxConcurrent">,
): string | null {
  if (activeCount >= config.maxConcurrent) {
    return `ConcurrencyLimitExceeded: Cannot run more than ${config.maxConcurrent} active tasks (current: ${activeCount}). Wait for a completion notification to arrive, or raise maxConcurrent in the dynamic-task config.`;
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
