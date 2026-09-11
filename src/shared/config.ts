// src/shared/config.ts
// Configuration normalization for dynamic-task-plugin.
// Config precedence: defaults → file → env → plugin tuple options → per-call args.
// Resolved once at plugin initialization. Env changes mid-session are ignored.
// Invalid values fall back to safe defaults — never reaches setTimeout.

import { readFileSync, existsSync } from "node:fs";

// ─── TimerProvider ────────────────────────────────────────────────
// Dependency injection for timers. Production uses REAL_TIMERS.
// Tests inject createMockTimers() for deterministic race verification.

export interface TimerProvider {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

export const REAL_TIMERS: TimerProvider = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
};

// ─── DynamicTaskConfig ─────────────────────────────────────────────

export interface DynamicTaskConfig {
  defaultTimeoutMs: number;       // default 120000
  maxTimeoutMs: number;           // default 3_600_000
  minTimeoutMs: number;           // default 1000
  maxDepth: number;               // default 2
  maxConcurrent: number;          // default 4 — only background tasks count
  retainedTaskTtlMs: number;      // default 3_600_000 (1 hour)
  retainedTaskMaxEntries: number; // default 100
  blockedAgents: string[];        // default ["general"]
  allowSameAgentRecursion: boolean; // default false
  defaultAwaitResponse: boolean;  // default false (async by default)
  timerProvider: TimerProvider;   // injected timer implementation
  timeoutBehavior: "interrupt" | "notify" | "notify_untrack"; // default "interrupt"
}

// ─── Defaults ──────────────────────────────────────────────────────

const DEFAULTS: DynamicTaskConfig = {
  defaultTimeoutMs: 120000,
  maxTimeoutMs: 3_600_000,
  minTimeoutMs: 1000,
  maxDepth: 2,
  maxConcurrent: 4,
  retainedTaskTtlMs: 3_600_000,
  retainedTaskMaxEntries: 100,
  blockedAgents: ["general"],
  allowSameAgentRecursion: false,
  defaultAwaitResponse: false,
  timerProvider: REAL_TIMERS,
  timeoutBehavior: "interrupt",
};

// ─── Helpers ───────────────────────────────────────────────────────

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function parseCommaList(value: unknown): string[] | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return null; // empty or unset → "not set"
}

function parseTimeoutBehavior(value: unknown): "interrupt" | "notify" | "notify_untrack" {
  if (value === "interrupt" || value === "notify" || value === "notify_untrack") {
    return value;
  }
  return DEFAULTS.timeoutBehavior;
}

// ─── resolveTimeoutMs ──────────────────────────────────────────────
// Validates, clamps, and normalizes a per-call timeout value.
// Returns a finite positive integer within [minTimeoutMs, maxTimeoutMs].
// Handles minTimeoutMs > maxTimeoutMs by swapping the bounds.

export function resolveTimeoutMs(value: unknown, config: DynamicTaskConfig): number {
  const safeMin = Math.min(config.minTimeoutMs, config.maxTimeoutMs);
  const safeMax = Math.max(config.minTimeoutMs, config.maxTimeoutMs);

  let parsed: number;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    parsed = Math.floor(value);
    if (parsed <= 0) {
      parsed = config.defaultTimeoutMs; // e.g. 0.5 floors to 0
    }
  } else if (typeof value === "string") {
    const n = Number(value);
    parsed = Number.isFinite(n) && n > 0 ? Math.floor(n) : config.defaultTimeoutMs;
  } else {
    parsed = config.defaultTimeoutMs;
  }

  return Math.max(safeMin, Math.min(safeMax, parsed));
}

// ─── envValue ──────────────────────────────────────────────────────
// Reads an env var. Returns the value if non-empty, null if unset/empty.
// This implements "empty-string env var = not set" — prevents accidental
// override of file/tuple config with an empty value.

function envValue(key: string): string | null {
  const val = process.env[key];
  if (typeof val === "string" && val.trim().length > 0) return val.trim();
  return null;
}

// ─── normalizeDynamicTaskConfig ────────────────────────────────────
// Merges plugin tuple options with env vars, file config, and defaults.
// Priority: defaults < file < env < tuple options
// Env vars only override if non-empty (avoids "" obliterating file config).

export function normalizeDynamicTaskConfig(
  options?: Partial<DynamicTaskConfig> | Record<string, unknown> | null,
  fileConfig?: Partial<DynamicTaskConfig> | Record<string, unknown> | null,
): DynamicTaskConfig {
  const merged: DynamicTaskConfig = { ...DEFAULTS };

  // Step 1: Apply file config (if loaded)
  if (fileConfig && typeof fileConfig === "object") {
    applyPartial(merged, fileConfig);
  }

  // Step 2: Apply env vars (only if non-empty — 12-factor: env > file)
  const envTimeout = envValue("DYNAMIC_TASK_TIMEOUT");
  if (envTimeout !== null) {
    const parsed = Number(envTimeout);
    if (Number.isFinite(parsed) && parsed > 0) {
      merged.defaultTimeoutMs = Math.floor(parsed);
    }
  }

  const envMaxConcurrent = envValue("DYNAMIC_TASK_MAX_CONCURRENT");
  if (envMaxConcurrent !== null) {
    const parsed = Number(envMaxConcurrent);
    if (Number.isFinite(parsed) && parsed > 0) {
      merged.maxConcurrent = Math.floor(parsed);
    }
  }

  const envBlocked = parseCommaList(envValue("DYNAMIC_TASK_FORBIDDEN_AGENTS"));
  if (envBlocked !== null) {
    merged.blockedAgents = envBlocked;
  }

  // Step 3: Apply plugin tuple options (highest non-per-call priority)
  if (options && typeof options === "object") {
    applyPartial(merged, options as Record<string, unknown>);
  }

  // Enforce invariant: accept the round 3 reviewer's suggestion on min/max swap
  if (merged.minTimeoutMs > merged.maxTimeoutMs) {
    const tmp = merged.minTimeoutMs;
    merged.minTimeoutMs = merged.maxTimeoutMs;
    merged.maxTimeoutMs = tmp;
  }

  return merged;
}

function applyPartial(target: DynamicTaskConfig, source: Record<string, unknown>): void {
  for (const [key, raw] of Object.entries(source)) {
    if (raw === undefined || raw === null) continue;
    switch (key) {
      case "defaultTimeoutMs":
        target.defaultTimeoutMs = parsePositiveInt(raw, DEFAULTS.defaultTimeoutMs);
        break;
      case "maxTimeoutMs":
        target.maxTimeoutMs = parsePositiveInt(raw, DEFAULTS.maxTimeoutMs);
        break;
      case "minTimeoutMs":
        target.minTimeoutMs = parsePositiveInt(raw, DEFAULTS.minTimeoutMs);
        break;
      case "maxDepth":
        target.maxDepth = parsePositiveInt(raw, DEFAULTS.maxDepth);
        break;
      case "maxConcurrent":
        target.maxConcurrent = parsePositiveInt(raw, DEFAULTS.maxConcurrent);
        break;
      case "retainedTaskTtlMs":
        target.retainedTaskTtlMs = parsePositiveInt(raw, DEFAULTS.retainedTaskTtlMs);
        break;
      case "retainedTaskMaxEntries":
        target.retainedTaskMaxEntries = parsePositiveInt(raw, DEFAULTS.retainedTaskMaxEntries);
        break;
      case "blockedAgents":
        if (Array.isArray(raw)) {
          target.blockedAgents = raw.filter((a): a is string => typeof a === "string");
        }
        break;
      case "allowSameAgentRecursion":
        if (typeof raw === "boolean") {
          target.allowSameAgentRecursion = raw;
        }
        break;
      case "defaultAwaitResponse":
        if (typeof raw === "boolean") {
          target.defaultAwaitResponse = raw;
        }
        break;
      case "timeoutBehavior":
        target.timeoutBehavior = parseTimeoutBehavior(raw);
        break;
      case "timerProvider":
        if (raw && typeof raw === "object" && "setTimeout" in (raw as object) && "clearTimeout" in (raw as object)) {
          const tp = raw as TimerProvider;
          if (typeof tp.setTimeout === "function" && typeof tp.clearTimeout === "function") {
            target.timerProvider = tp;
          }
        }
        break;
      // Unknown keys are silently ignored (matches OpenCode schema behavior)
    }
  }
}

// ─── parseDynamicTaskJsonc ─────────────────────────────────────────
// Reads the dedicated project config file if it exists.
// Malformed file returns null (falls through to defaults/env/tuple).
// Returns null if the file does not exist.

export function parseDynamicTaskJsonc(filePath: string): Record<string, unknown> | null {
  if (!filePath || !existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf8");
    // Basic JSON5-like parsing: strip trailing commas and comments
    const cleaned = raw
      .replace(/\/\/.*$/gm, "")   // remove // comments
      .replace(/,\s*([}\]])/g, "$1"); // remove trailing commas
    const parsed = JSON.parse(cleaned);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    // Malformed file — log warning but don't crash
    console.warn(`[dynamic-task] Warning: malformed config in ${filePath}, using defaults`);
    return null;
  }
}

// ─── config tuple helpers —───────────
/**
 * @deprecated Check if maxConcurrent is exceeded. Returns error string or null.
 */
export function checkConcurrencyLimit(activeBgCount: number, config: DynamicTaskConfig): string | null {
  if (activeBgCount >= config.maxConcurrent) {
    return `Cannot register more than ${config.maxConcurrent} active background tasks ` +
      `(current: ${activeBgCount}). Update dynamic-task config to increase or wait for tasks to complete.`;
  }
  return null;
}
