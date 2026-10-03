import type { Agent } from "@opencode/schema/agent";

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
  readonly permissions: Agent.Info["permissions"];
}

/** The words v2 declares for an agent's dispatch role. */
const AGENT_MODES: ReadonlySet<unknown> = new Set<Agent.Info["mode"]>(["subagent", "primary", "all"]);

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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  const name = item["name"];
  if (typeof name !== "string" || name === "") return null;
  const mode = AGENT_MODES.has(item["mode"]) ? (item["mode"] as Agent.Info["mode"]) : DEFAULT_AGENT_MODE;
  const id = item["id"];
  return {
    id: typeof id === "string" && id !== "" ? id : name,
    name,
    mode,
    permissions: permissionRules(item["permissions"]),
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
  if (raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>)["data"])) {
    return (raw as Record<string, unknown>)["data"];
  }
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
  if (!Array.isArray(raw)) return [];
  const rules: Agent.Info["permissions"][number][] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rule = entry as Record<string, unknown>;
    if (typeof rule["action"] !== "string") continue;
    if (typeof rule["resource"] !== "string") continue;
    if (!PERMISSION_EFFECTS.has(rule["effect"])) continue;
    rules.push({
      action: rule["action"],
      resource: rule["resource"],
      effect: rule["effect"] as Agent.Info["permissions"][number]["effect"],
    });
  }
  return rules;
}

const PERMISSION_EFFECTS: ReadonlySet<unknown> = new Set<Agent.Info["permissions"][number]["effect"]>([
  "allow",
  "deny",
  "ask",
]);

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
 * An agent with NO rules is the one unknown — the host substitutes a deny-all
 * ruleset for an absent field, so a payload that reaches here empty is a host that
 * has not, and absence of knowledge must never blind a child to its own voice.
 */
export function agentCanNotify(agent: AgentRecord, tool: string): boolean {
  if (agent.permissions.length === 0) return true;
  // Last match wins, so the walk runs backwards and stops at the first hit. Read it
  // forwards and the answer belongs to whichever rule the author happened to put first.
  for (let i = agent.permissions.length - 1; i >= 0; i -= 1) {
    const rule = agent.permissions[i];
    if (!rule) continue;
    if (wildcardMatches(tool, rule.action) && wildcardMatches("*", rule.resource)) {
      return rule.effect !== "deny";
    }
  }
  // No match at all is `ask` on the host: the tool exists, the user is consulted.
  return true;
}

/**
 * The host's own matcher: `*` is a wildcard, and everything else is literal.
 *
 * A substring match would answer differently from the host on a partially-spelled
 * rule, and a rule that matches nothing the host would match makes every question
 * asked about that agent wrong.
 */
function wildcardMatches(value: string, pattern: string): boolean {
  return pattern === "*" || pattern === value;
}