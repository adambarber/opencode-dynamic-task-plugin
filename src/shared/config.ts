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
import { join } from "node:path";
import type { PluginOptions } from "@opencode/plugin";
import { agentKey } from "./agent-key.js";
import { type AgentCaps, parseAgentCaps } from "./caps.js";
import { isPlainRecord } from "./host-shape.js";
import { type ModelOverride, readModelSetting } from "./model-choice.js";

export interface DynamicTaskConfig {
  maxDepth: number;
  maxConcurrent: number;
  /**
   * The model every child runs on unless the agent or the dispatch says otherwise —
   * layer 2 of the model ladder. Absent is the default, and the default is the layer
   * below it: the dispatching parent's own model. See `model-choice.ts`.
   */
  model?: ModelOverride;
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
  /**
   * How many times a owed parent notification is re-offered across restarts
   * before it is written off. Three is the default: enough to ride out an
   * operator who left a terminal open or a laptop that slept through two boots,
   * few enough that a parent which is gone is written off rather than
   * re-offered forever.
   */
  pendingMaxAttempts: number;
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
    // An owed notice is re-offered at every boot, and redelivering it IS
    // `session.prompt` — a real user turn in the parent's session. So an
    // unbounded retry is not a notice that arrives late, it is a parent that can
    // never be idle. Three ends it, which is enough to ride out an operator who
    // left a terminal open or a laptop that slept through two boots, and few
    // enough that a parent which is gone is written off rather than re-offered
    // forever. The gate has its own smaller backstop for a caller that names no
    // bound; that is a funnel safety and is deliberately not this number.
    pendingMaxAttempts: 3,
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

/**
 * One field off an untyped source, read ONCE, into the target if it is a positive int.
 *
 * The read used to be written twice per field — `positiveInt(s.x) !== undefined ?
 * target.x = positiveInt(s.x) : nothing` — so a key off an untyped record was indexed
 * twice and validated twice for one decision. A helper is the fix rather than a `const`
 * per field, because it also puts the field name in exactly one place: the key is a
 * literal here, so the absence of this key is a compile error rather than an
 * `undefined` at runtime, which is the whole reason the key space is a `const` union.
 */
function takePositiveInt(target: DynamicTaskConfig, src: Record<string, unknown>, key: PositiveIntField): void {
  const value = positiveInt(src[key]);
  if (value !== undefined) target[key] = value;
}

/**
 * The numeric fields `takePositiveInt` may write, so a typo cannot reach `target`.
 *
 * `Exclude` because a homomorphic mapped type keeps a key's optionality, so an optional
 * field's value is `never | undefined` and its union poisons the key space with an
 * `undefined` that cannot index a record at all.
 */
type PositiveIntField = Exclude<
  {
    [K in keyof DynamicTaskConfig]: DynamicTaskConfig[K] extends number ? K : never;
  }[keyof DynamicTaskConfig],
  | undefined
>;

// Shape-checked merge of one untyped config source (tuple options or parsed
// file) onto the target — invalid fields are ignored, never coerced.
function applyKnownFields(target: DynamicTaskConfig, src: unknown): void {
  if (!isPlainRecord(src)) return;
  const s = src;
  takePositiveInt(target, s, "maxDepth");
  takePositiveInt(target, s, "maxConcurrent");
  takePositiveInt(target, s, "agentCacheTtlMs");
  takePositiveInt(target, s, "retainedTaskTtlMs");
  takePositiveInt(target, s, "retainedTaskMaxEntries");
  takePositiveInt(target, s, "pendingMaxAttempts");
  if (Array.isArray(s.blockedAgents)) {
    // An explicit empty list is a real setting ("block nothing"), not an
    // absent one — it must override the default blocklist.
    target.blockedAgents = s.blockedAgents.filter((a): a is string => typeof a === "string" && a.trim().length > 0);
  }
  if (typeof s.allowSameAgentRecursion === "boolean") target.allowSameAgentRecursion = s.allowSameAgentRecursion;
  // The global model, by the model module's own rule. A stated model the rule drops is a
  // stated model that routes nowhere, so leaving the field absent lets the layer below
  // answer rather than poisoning the ladder with a pair whose provider is empty.
  const model = readModelSetting(s.model);
  if (model !== undefined) target.model = model;
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
  agentCacheTtlMs: "DYNAMIC_TASK_CACHE_TTL",
  allowSameAgentRecursion: "DYNAMIC_TASK_ALLOW_SAME_AGENT_RECURSION",
  blockedAgents: "DYNAMIC_TASK_FORBIDDEN_AGENTS",
  maxConcurrent: "DYNAMIC_TASK_MAX_CONCURRENT",
  maxDepth: "DYNAMIC_TASK_MAX_DEPTH",
  model: "DYNAMIC_TASK_MODEL",
  pendingMaxAttempts: "DYNAMIC_TASK_PENDING_MAX_ATTEMPTS",
  retainedTaskMaxEntries: "DYNAMIC_TASK_RETAINED_MAX_ENTRIES",
  retainedTaskTtlMs: "DYNAMIC_TASK_RETAINED_TTL_MS",
} as const;

// A knob the defaults actually carry: env can never name a typo, and a new
// field is covered by defaults with no second spelling to drift.
function isConfigKey(name: string): name is keyof DynamicTaskConfig {
  return name in buildDefaultConfig();
}
// One generic assignment keeps each env reader paired with its own field;
// a union-keyed write would need a cast, and this does not.
function assignEnvOverride<K extends keyof DynamicTaskConfig>(
  config: DynamicTaskConfig,
  key: K,
  value: DynamicTaskConfig[K],
): void {
  config[key] = value;
}
export function normalizeDynamicTaskConfig(
  options: PluginOptions | null | undefined,
  fileConfig?: unknown,
): DynamicTaskConfig {
  // Precedence: env > tuple options > file config > defaults.
  const base: DynamicTaskConfig = buildDefaultConfig();
  applyKnownFields(base, fileConfig);
  applyKnownFields(base, options);

  // The readers' own return type, and `string` is no longer in it: the model reader
  // answers the PAIR rather than the text a document spelled it in, so the only values
  // env can produce are the ones its fields hold.
  const env: Partial<Record<keyof DynamicTaskConfig, () => number | boolean | string[] | ModelOverride | undefined>> = {
    agentCacheTtlMs: () => parsePositiveInt(envValue(ENV.agentCacheTtlMs)),
    allowSameAgentRecursion: () => parseBoolean(envValue(ENV.allowSameAgentRecursion)),
    blockedAgents: () => {
      const raw = envValue(ENV.blockedAgents);
      if (!raw) return undefined;
      // A separator-only value (",", " , ") is absence, not an explicit
      // empty blocklist — only tuple/file arrays can deliberately clear it.
      const list = trimStringList(raw);
      return list.length > 0 ? list : undefined;
    },
    maxConcurrent: () => parsePositiveInt(envValue(ENV.maxConcurrent)),
    maxDepth: () => parsePositiveInt(envValue(ENV.maxDepth)),
    // Read by the model module's rule, like the file's, so a variable that names a bare
    // id configures nothing rather than a pair with an empty provider.
    model: () => readModelSetting(envValue(ENV.model)),
    pendingMaxAttempts: () => parsePositiveInt(envValue(ENV.pendingMaxAttempts)),
    retainedTaskMaxEntries: () => parsePositiveInt(envValue(ENV.retainedTaskMaxEntries)),
    retainedTaskTtlMs: () => parsePositiveInt(envValue(ENV.retainedTaskTtlMs)),
  };

  const merged: DynamicTaskConfig = { ...base };
  // The keys env can override. Each key pairs with its own reader below,
  // so a reader never fills a field it was not written for.
  const envKeys = Object.keys(env).filter(isConfigKey);
  for (const key of envKeys) {
    const override = env[key]?.();
    if (override !== undefined) assignEnvOverride(merged, key, override);
  }

  return {
    agentCacheTtlMs: merged.agentCacheTtlMs,
    agents: merged.agents,
    allowSameAgentRecursion: merged.allowSameAgentRecursion,
    blockedAgents: merged.blockedAgents,
    maxConcurrent: merged.maxConcurrent,
    maxDepth: merged.maxDepth,
    // Absent stays absent rather than being spread as `undefined`: an absent key and a
    // key holding nothing are different statements, and "no global model" has to
    // survive normalization so the ladder can tell it from one that said something.
    ...(merged.model === undefined ? {} : { model: merged.model }),
    pendingMaxAttempts: merged.pendingMaxAttempts,
    retainedTaskMaxEntries: merged.retainedTaskMaxEntries,
    retainedTaskTtlMs: merged.retainedTaskTtlMs,
  };
}

/**
 * The hand-authored config file, relative to the project root.
 *
 * Named HERE, once, because there are two readers that must agree on where it is and
 * a path spelled in both is a path that can drift: the plugin resolves its policy from
 * it at boot, and the TUI resolves the same policy to show the operator what is in
 * force. A screen that read a different file than the dispatch path would render the
 * defaults while the dispatch path enforced the file — a claim the screen cannot support.
 */
export const DYNAMIC_TASK_FILE = ".opencode/dynamic-task-plugin.jsonc";

/**
 * The policy in force for a project: the file's own caps, over the defaults, over env.
 *
 * The ONE derivation of "what is in force", for the boot path and the TUI alike. It
 * resolves no per-agent overlay — that is layered on top by `applyAgentOverlay`, per
 * dispatch, because the overlay is edited while the host runs and this is read once.
 *
 * `options` is the plugin's registration tuple, which the TUI genuinely cannot see: a
 * host that configures caps in the tuple rather than the file gets a screen that shows
 * the file-and-defaults answer. That is the one divergence, it is the TUI's side, and it
 * is stated here rather than discovered later. Everything else — the file, the defaults,
 * the environment — both readers resolve identically, because they call this.
 */
export function readDynamicTaskPolicy(directory: string | undefined, options: PluginOptions | null): DynamicTaskConfig {
  const fileConfig = directory ? parseDynamicTaskJsonc(join(directory, DYNAMIC_TASK_FILE)) : null;
  return normalizeDynamicTaskConfig(options, fileConfig);
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
    const parsed: unknown = JSON.parse(stripped);
    if (isPlainRecord(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}
