
//jscpd:ignore-start
import type { Agent } from "@opencode/schema/agent";
import { includesWord, isEventRecord } from "./host-shape.js";

//jscpd:ignore-end
/**
 * An agent, as the ONE shape this plugin is allowed to hold.
 *
 * Every field is derived from the v2 schema rather than restated, so a change to
 * `Agent.Info` is a build error here instead of a silent drift. The v1 record was
 * `{ name, [key: string]: unknown }`: an index signature that let any caller read
 * any field, which is why `mode` and a legacy `type` both had to be probed at
 * runtime and why `tools` — a field v2 deleted — was read by a function whose
 * parameter type said nothing about what it held.
 *
 * `name` is unbranded on purpose. The schema brands it `Agent.Name`; a plain string
 * is what every comparison in this codebase does, and a brand here would buy a cast
 * per call site and no safety at all.
 */
type Unbrand<T> = T extends string ? string : T;

export interface AgentRecord {
  // The registry key the host routes by — `Agent.ID`, NOT the display label. Live
  // dispatch once sent `name` ("General") to `switchAgent` and the host answered
  // `Agent not found`, because resolution is by id ("general") and case-sensitive.
  // Absent only on payloads older than the field; the fallback keeps those routable.
  readonly id: Unbrand<Agent.Info["id"]>;
  readonly name: Unbrand<Agent.Info["name"]>;
  readonly mode: Agent.Info["mode"];
  // The host substitutes deny-all for an ABSENT field
  // (`agent?.permissions ?? missingAgentPermissions`), so the constructor does
  // the same: absent or malformed arrives here already denied. An explicit `[]`
  // stays empty, which the host reads as no-match → `ask` → available.
  readonly permissions: Agent.Info["permissions"];
  readonly hidden: boolean;
}

/** The words v2 declares for an agent's dispatch role. */
const AGENT_MODE_LIST = ["subagent", "primary", "all"] as const;
function isAgentMode(value: unknown): value is Agent.Info["mode"] {
  return includesWord(AGENT_MODE_LIST, value);
}

/**
 * The mode an unannotated agent gets.
 *
 * v2 makes `mode` REQUIRED, so a payload without one is not a v2 agent — but the
 * plugin must not go silent on a host that has not caught up, and "all" is the role
 * that dispatches. Stated here so the choice is one line in one place rather than a
 * fallback spelled at each read.
 */
export const DEFAULT_AGENT_MODE: Agent.Info["mode"] = "all";

/**
 * The one place an agent is built. Everything else consumes the result.
 *
 * `null` for anything the host would not call an agent, which is the only invalid
 * input there is: the constructor normalises `mode` and drops entries the host
 * could not have sent, so downstream readers compare against the declared union and
 * never re-check for shape. Two spellings of "an agent, unvalidated" meant two
 * places for a field to be forgotten, and the second one was anonymous.
 */
export function toAgentRecord(raw: unknown): AgentRecord | null {
  if (!isEventRecord(raw)) return null;
  const item = raw;
  const {name} = item;
  if (typeof name !== "string" || name === "") return null;
  const mode = isAgentMode(item.mode) ? item.mode : DEFAULT_AGENT_MODE;
  const {id} = item;
  return {
    hidden: item.hidden === true,
    id: typeof id === "string" && id !== "" ? id : name,
    mode,
    name,
    permissions: permissionRules(item.permissions),
  };
}

/** Every agent in a payload the host built, in the order it published them. */
export function toAgentRecords(raw: unknown): AgentRecord[] {
  return toAgentRecordsFrom(listEntries(raw));
}

// The v2 client answers `agent.list` with its `AgentListOutput` envelope —
// `{ location, data }` — and not a bare array, which an earlier comment here
// claimed. The TUI store reader answers a bare array. The constructor takes both,
// because both are shapes the plugin actually receives; anything else is nothing.
function listEntries(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw;
  if (isEventRecord(raw) && Array.isArray(raw.data)) return raw.data;
  return [];
}

function toAgentRecordsFrom(entries: unknown): AgentRecord[] {
  if (!Array.isArray(entries)) return [];
  const records: AgentRecord[] = [];
  for (const item of entries) {
    const agent = toAgentRecord(item);
    if (agent) records.push(agent);
  }
  return records;
}

/**
 * The ordered ruleset, with any entry the host could not have sent dropped.
 *
 * Order is the whole meaning: evaluation takes the LAST match, so reordering or
 * compacting this list changes which rule wins. Dropping is safe and compaction is
 * not, which is why one is done and the other never is.
 */
function permissionRules(raw: unknown): AgentRecord["permissions"] {
  // Mirrors the host's `?? missingAgentPermissions`: only a well-formed array is
  // the agent's real ruleset. Anything else is deny-all, never "no rules".
  if (!Array.isArray(raw)) return [{ action: "*", effect: "deny", resource: "*" }];
  const rules: Agent.Info["permissions"][number][] = [];
  for (const entry of raw) {
    if (!isEventRecord(entry)) continue;
    const rule = entry;
    if (typeof rule.action !== "string") continue;
    if (typeof rule.resource !== "string") continue;
    if (!isPermissionEffect(rule.effect)) continue;
    rules.push({ action: rule.action, effect: rule.effect, resource: rule.resource });
  }
  return rules;
}

const PERMISSION_EFFECT_LIST = ["allow", "deny", "ask"] as const;
function isPermissionEffect(value: unknown): value is Agent.Info["permissions"][number]["effect"] {
  return includesWord(PERMISSION_EFFECT_LIST, value);
}
/**
 * May a child of this agent use this tool?
 *
 * v2 replaced the `tools` map with an ORDERED ruleset and an explicit walk:
 * `rulesets.flat().findLast(r => matches(action, r.action) && matches(resource, r.resource))`,
 * both fields wildcarded, no match defaulting to `ask`. So this is a question about
 * the rules, not a lookup — and the tool name is the ACTION, because that is how
 * the host spells it.
 *
 * The load-bearing claim, the one a live smoke test once paid for: an `ask` means
 * the tool is there and the user is consulted. Reading it as "unavailable" is how a
 * genuinely stuck child lost the ability to declare `needs_input`, settled
 * `completed`, and handed its parent a success that never happened.
 *
 * Agent-side only: the host merges the child SESSION's ruleset at execution time
 * (`merge(agent?.permissions ?? missingAgentPermissions, session.permissions)`),
 * which this reader cannot see — a session-level deny closes a channel reported
 * open here. The resource is likewise fixed to `*`: per-call resources are known
 * only at the call. Both narrowings err toward the warning, never toward silence.
 */
export function agentCanNotify(agent: AgentRecord, tool: string): boolean {
  if (agent.permissions.length === 0) return true;
  // Last match wins, so the walk runs backwards and stops at the first hit. Read it
  // forwards and the answer belongs to whichever rule the author happened to put first.
  for (let i = agent.permissions.length - 1; i >= 0; i -= 1) {
    const rule = agent.permissions[i];
    if (!rule) continue;
    if (wildcardMatches(process.platform, tool, rule.action) && wildcardMatches(process.platform, "*", rule.resource)) {
      return rule.effect !== "deny";
    }
  }
  // No match at all is `ask` on the host: the tool exists, the user is consulted.
  return true;
}

// The host's own matcher (`Wildcard.match`): regex specials literal, `*` spans,
// `?` is one char, anchored both ends, backslashes normalised. Ported whole —
// including the trailing-" .*" carve-out — because a narrower grammar answers a
// different question than the host on partial-glob rules like `task_*`.

/**
 * The host's matcher, with its one platform dependence made explicit.
 *
 * `packages/core/src/util/wildcard.ts:13` builds the regex with
 * `process.platform === "win32" ? "si" : "s"`. Pinning `"s"` unconditionally made a
 * case-differing rule — `TASK_NOTIFY` against `task_notify` — deny here and match
 * there, so the answer came to depend on the machine rather than on the rule.
 *
 * `platform` is a parameter rather than a hidden read because the case-insensitive
 * branch is unreachable from a test running anywhere but Windows: on darwin every
 * flag choice yields the same answers, so a broken wiring is invisible at runtime.
 * Passing it makes both branches reachable, and a source pin holds the caller to it.
 */
export function wildcardMatches(platform: string, value: string, pattern: string): boolean {
  const normalized = value.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)  }( .*)?`;
  return new RegExp(`^${escaped}$`, platform === "win32" ? "si" : "s").test(normalized);
}