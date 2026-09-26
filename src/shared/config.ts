// src/shared/config.ts
// Normalizes plugin options and environment overrides into one typed record.
// Durable-state bounds live here (retention TTL, entry cap). There are no
// wait budgets to own: the plugin arms no timers — settlement is event-driven.
import { readFileSync } from "node:fs";
import type { PluginOptions } from "@opencode-ai/plugin";

/**
 * One lane's own limits. Both fields are optional because a lane may set only
 * one of them and inherit the rest from the top level — the resolved value
 * (LanePolicy) is the one that has both.
 */
export type LaneConfig = { maxConcurrent?: number; maxDepth?: number };

export interface DynamicTaskConfig {
  maxDepth: number;
  maxConcurrent: number;
  /** Named concurrency lanes. Empty means "no lanes declared", not "no lanes". */
  lanes: Record<string, LaneConfig>;
  agentCacheTtlMs: number;
  retainedTaskTtlMs: number;
  retainedTaskMaxEntries: number;
  blockedAgents: string[];
  allowSameAgentRecursion: boolean;
}

/** The lane every dispatch lands in when it does not name one. */
export const DEFAULT_LANE = "default";

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
    lanes: {},
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

// Shape-checked merge of one untyped config source (tuple options or parsed
// file) onto the target — invalid fields are ignored, never coerced.
function applyKnownFields(target: DynamicTaskConfig, src: unknown): void {
  if (!isRecord(src)) return;
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
  if (!isRecord(s.lanes)) return;
  for (const [rawName, rawLane] of Object.entries(s.lanes)) {
    const name = normalizeLaneName(rawName);
    // A lane carrying no usable number is not a lane. Keeping it would make
    // "declared" and "actually constrained" two different sets, and a lane the
    // operator can see in the UI but that constrains nothing is worse than one
    // that was never declared.
    const lane = parseLane(rawLane);
    if (!name || !lane) continue;
    target.lanes[name] = { ...target.lanes[name], ...lane };
  }
}

/**
 * A lane's declared overrides, or null when the lane does not exist.
 *
 * Two ways to write a body mean different things, and conflating them is a
 * silent wrong answer in both directions:
 *
 * - A body that names NO knob (`{}`) is a declaration with no overrides — the
 *   only spelling available for "a lane of its own, on the same budget", which
 *   is the point of declaring a lane for concurrency accounting alone. Inheriting
 *   the top-level numbers is what it means.
 * - A body that names a knob and gets an unusable value (`{maxDepth: -2}`) is a
 *   lane the operator tried to size and we cannot honour. It is DROPPED, and
 *   dropping is the loud option among the silent ones: standing in the top-level
 *   numbers instead would answer a question the operator did not ask, by quietly
 *   spending a depth they explicitly overrode.
 */
function parseLane(raw: unknown): LaneConfig | null {
  if (!isRecord(raw)) return null;
  const maxConcurrent = positiveInt(raw.maxConcurrent);
  const maxDepth = positiveInt(raw.maxDepth);
  if ("maxConcurrent" in raw || "maxDepth" in raw) {
    if (maxConcurrent === undefined && maxDepth === undefined) return null;
    return {
      ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
      ...(maxDepth !== undefined ? { maxDepth } : {}),
    };
  }
  return {};
}

function normalizeLaneName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** The lane a value denotes. Total: anything unusable is the default lane. */
export function resolveLaneName(value: unknown): string {
  return normalizeLaneName(value) || DEFAULT_LANE;
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
    lanes: merged.lanes,
    agentCacheTtlMs: merged.agentCacheTtlMs,
    retainedTaskTtlMs: merged.retainedTaskTtlMs,
    retainedTaskMaxEntries: merged.retainedTaskMaxEntries,
    blockedAgents: merged.blockedAgents,
    allowSameAgentRecursion: merged.allowSameAgentRecursion,
  };
}

/** The only part of the config a lane decision reads. */
export type LaneConfigSource = Pick<DynamicTaskConfig, "maxConcurrent" | "maxDepth" | "lanes">;

export interface LanePolicy {
  name: string;
  maxConcurrent: number;
  maxDepth: number;
}

/** The lane a name resolves to, with every number filled in. */
export function resolveLane(config: LaneConfigSource, name: string): LanePolicy {
  const lane = config.lanes[name] ?? {};
  return {
    name,
    maxConcurrent: lane.maxConcurrent ?? config.maxConcurrent,
    maxDepth: lane.maxDepth ?? config.maxDepth,
  };
}

/** Every declared lane, in declaration order. Empty means none were declared. */
export function knownLaneNames(config: LaneConfigSource): string[] {
  return Object.keys(config.lanes);
}

/**
 * Every lane name admission will accept: the default lane, always, plus the
 * declared ones. The default is unconditional on purpose — it is where every
 * dispatch lands when it does not name a lane, so making it conditional means
 * that declaring ONE lane silently invalidates every dispatch that omits it, and
 * an operator's first `lanes` block would break their existing calls.
 *
 * One definition, because the gate's accept-set and the UI's list of lanes to
 * offer are the same rule. Two derivations of it would drift, and the drift
 * would be a lane the UI offers that admission then refuses.
 */
export function admissibleLaneNames(config: LaneConfigSource): string[] {
  return [DEFAULT_LANE, ...knownLaneNames(config).filter((name) => name !== DEFAULT_LANE)];
}

export interface LaneCapacity {
  /** Running tasks in the lane being admitted. */
  laneActive: number;
  /** Running tasks in the whole store, every lane. */
  totalActive: number;
}

/**
 * The one capacity judgment, and it answers two questions in two different
 * words.
 *
 * A lane cap and the cross-lane ceiling are separate refusals: telling an
 * operator "4 active" when their own lane is empty and someone else's fleet
 * filled the ceiling is the case this split exists for, because the knob that
 * fixes it is not the one the message would otherwise name.
 *
 * Lanes partition concurrency, they never multiply it — the ceiling is the
 * top-level maxConcurrent regardless of how many lanes exist, so declaring
 * eight lanes of four cannot spend more than four.
 */
export function checkLaneCapacity(capacity: LaneCapacity, lane: LanePolicy, ceiling: number): string | null {
  const hint =
    "Wait for a completion notification to arrive, or raise the cap. Use task_list to see the slot holders; task_interrupt frees a slot, and reviving a settled task needs a free slot too.";
  if (capacity.laneActive >= lane.maxConcurrent) {
    return `ConcurrencyLimitExceeded: lane "${lane.name}" cannot run more than ${counted(lane.maxConcurrent)} (current: ${capacity.laneActive}). ${hint}`;
  }
  if (capacity.totalActive >= ceiling) {
    return `ConcurrencyLimitExceeded: the total ceiling of ${counted(ceiling)} is reached across all lanes (current: ${capacity.totalActive}), so a free slot in lane "${lane.name}" cannot be used. ${hint}`;
  }
  return null;
}

/** "1 active task", "4 active tasks" — a cap's own number, read as English. */
function counted(n: number): string {
  return `${n} active ${n === 1 ? "task" : "tasks"}`;
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
