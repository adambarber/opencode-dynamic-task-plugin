/**
 * src/tui/agent-editor.ts
 * What the cap screen shows and what it writes, with no host in sight.
 *
 * The screen is a list of the HOST'S OWN agents and nothing else. It used to be a
 * list of lanes, and the reason it was a list of lanes is the reason this file is
 * thin: a lane was a name the operator had to invent, declare in the config before it
 * was admissible, and then pass on every dispatch meant to spend it. So the screen
 * had to offer "add a lane", a name prompt, a delete, and a default — four affordances
 * that exist only because the key space was invented rather than given. Keying caps by
 * agent removes the vocabulary, and with it every affordance that was compensating for
 * it. What is left is one row per registered agent, and the only question a row asks
 * is the value of a cap.
 *
 * Pure, so all of it is checkable with no host at all: the read is an ARGUMENT here
 * rather than a side effect of opening. That is what lets the props be asserted on
 * directly, with no stand-in for the host's widgets.
 */
import {
  AGENT_CAP_NAMES,
  agentKey,
  applyAgentOverlay,
  readAgentOverlayCaps,
  resolveAgentCaps,
  type AgentCapName,
  type AgentCapSource,
  type AgentCaps,
  type AgentOverlay,
} from "../shared/caps.js";

/**
 * How each cap reads in a cell.
 *
 * A `Record` over `AgentCapName` rather than an array of pairs, so a cap added to
 * `AGENT_CAP_NAMES` is a TYPE ERROR here until it gets a name to show. A list would
 * let the new cap arrive with no label and render as an empty cell — a row that reads
 * `explore · 1 at once ·` and looks like a truncation bug.
 */
export const CAP_LABEL: Record<AgentCapName, string> = {
  maxConcurrent: "at once",
  maxDepth: "depth",
};

/** The numbers a cap can be set to, per cap. The picker's whole content. */
export const CAP_CHOICES: Record<AgentCapName, readonly number[]> = {
  // A list rather than a text box, because typing "2" is three keystrokes and an
  // opportunity to type "2k". The cap an operator sets is almost always one of a
  // handful, and a list makes the whole legal range visible instead of asking them
  // to already know it.
  maxConcurrent: [1, 2, 3, 4, 6, 8, 12, 16, 24, 32],
  // Depth is a small number by nature — it is bounded by the agent set whatever the
  // cap says — so a list up to 8 covers every value that can be reached and stops
  // offering ones that cannot.
  maxDepth: [1, 2, 3, 4, 5, 6, 7, 8],
};

/** The two cap numbers in force for one agent, with the config file's fallbacks applied. */
export type ResolvedCaps = { maxConcurrent: number; maxDepth: number };

/** One agent, as the screen holds it. */
export interface AgentEntry {
  /** The agent, in the HOST's spelling — what a dispatch names. */
  name: string;
  /** The caps in force, with the config file's fallbacks applied. */
  resolved: ResolvedCaps;
  /** The caps the overlay states for this agent, which may be none of them. */
  stated: AgentCaps;
}

/** What the screen shows and where it writes back. */
export interface AgentDialog {
  rows: AgentEntry[];
  /** Set when the file said something unusable, so the screen can say so too. */
  problem: string | null;
}

/**
 * The screen's content, from the overlay and the base config.
 *
 * `agentNames` is the HOST's registered agents, or null when they could not be read.
 * The two render differently and mean opposite things: null shows only the agents the
 * overlay itself mentions, under a warning, where an empty list would claim the
 * project has no agents — a claim the plugin has no way to support when it simply
 * could not ask. When the set IS known the rows are exactly it, every agent getting a
 * row whether or not it is capped, because a screen that lists only the capped ones
 * cannot answer "how many of `explore` may run" for an agent nobody has capped yet, and
 * an operator asked to create an entry to read a number is doing bookkeeping to get
 * information.
 */
export function agentDialogFrom(
  raw: unknown,
  base: AgentCapSource,
  agentNames: readonly string[] | null,
  problem: string | null,
): AgentDialog {
  // Stated caps come from the overlay through the caps module's OWN reader, so an
  // edit written on top of them is a body the dispatch path will accept. A value that
  // arrived as `{"maxConcurrent": "four"}` is read as absent, and the edit replaces
  // the garbage rather than preserving it beside a new number.
  const stated = statedByAgent(raw);
  const names = agentNames ?? Object.keys(stated);
  // The numbers in force are resolved against the base config WITH the overlay
  // applied — by the caps module's own function, which is the one the dispatch path
  // resolves against. Resolving against `base` alone made a stated cap render the
  // CONFIG's number marked as the operator's own, which is the one confusion the
  // stated/inherited pair exists to prevent, arriving through the pair itself.
  const inForce = applyAgentOverlay(base, raw) ?? base;
  return {
    rows: names.map((name) => ({
      name,
      stated: stated[agentKey(name)] ?? {},
      resolved: capsOf(resolveAgentCaps(inForce, name)),
    })),
    problem,
  };
}

/**
 * The overlay's own agents, read with the caps module's OWN reader.
 *
 * This is the line that makes the screen and the dispatch path agree. It used to have
 * a second copy of the cap rule a few lines down, which accepted a value the real
 * reader dropped: the dialog wrote a cap, told the operator it was in force, and the
 * next dispatch read the file and threw the cap away. So the number came back
 * different under a success message. There is one rule now and it is not in this file.
 */
function statedByAgent(raw: unknown): Record<string, AgentCaps> {
  const { agents } = readAgentOverlayCaps(raw);
  // An agent whose body carried nothing usable is not an agent the operator capped,
  // and keeping it here would make `knownCappedAgents` report a cap that does not
  // exist. `readAgentOverlayCaps` keeps it so the caller can SAY it was dropped; here
  // the screen has better rows to draw, so the entry goes.
  return Object.fromEntries(Object.entries(agents).filter(([, caps]) => Object.keys(caps).length > 0));
}

/** The value a cell shows, and whether it is the operator's or the config file's. */
export interface CapCell {
  /** The number in force. */
  value: number;
  /** False when the number is the config file's fallback rather than a stated cap. */
  stated: boolean;
}

/**
 * One cap of one agent, as a cell.
 *
 * The stated/inherited distinction is the whole reason a cell is a pair rather than a
 * string. An agent showing the top-level 4 because nothing was set for it looks
 * identical to one deliberately set to 4, and those are two different answers to "did
 * I do that?" — so the screen says which, and the picker offers the inverse.
 */
export function capCellOf(row: AgentEntry, cap: AgentCapName): CapCell {
  const value = row.resolved[cap];
  return { value, stated: row.stated[cap] !== undefined };
}

/** The resolved pair, without the agent name the row already carries. */
function capsOf(policy: { maxConcurrent: number; maxDepth: number }): ResolvedCaps {
  return { maxConcurrent: policy.maxConcurrent, maxDepth: policy.maxDepth };
}

// ─── the edit ────────────────────────────────────────────────────────────────

/** What a cap choice means. `default` removes the stated cap; a number sets it. */
export type CapChoice = { cap: AgentCapName; value: number | null };

/**
 * The outcome of an edit, or a refusal.
 *
 * A refusal is a KIND here rather than a thrown string, because a caller that has to
 * remember which outcomes are failures is a caller that will treat one as a success
 * eventually. Every writer here reports one of these and nothing else.
 */
export type EditOutcome =
  | { kind: "unchanged" }
  | { kind: "invalid"; problem: string }
  | { kind: "written"; overlay: AgentOverlay; summary: string };

/**
 * Set one cap of one agent, in the overlay.
 *
 * Returning the whole overlay rather than a patch is deliberate: the file is written
 * whole, and a caller that assembled a patch from an overlay it read earlier would be
 * writing back a value it had not re-read. This way the value that goes to disk is the
 * one that was just derived from the one that was just read.
 *
 * The agent key is FOLDED through `agentKey`, which is what keeps the write in step
 * with the read: a host name and a config key differ only in case, and only one side
 * being folded is how a cap an operator set applies to no agent at all.
 */
export function applyCapEdit(
  current: AgentOverlay,
  agent: string,
  choice: CapChoice,
): EditOutcome {
  const key = agentKey(agent);
  if (!key) return { kind: "invalid", problem: "That agent has no name, so there is no key to write the cap under." };
  const before = current.agents?.[key]?.[choice.cap];
  if (before === (choice.value ?? undefined)) return { kind: "unchanged" };
  if (choice.value !== null && !CAP_CHOICES[choice.cap].includes(choice.value)) {
    return { kind: "invalid", problem: `${choice.value} is not a value ${CAP_LABEL[choice.cap]} can take here: ${CAP_CHOICES[choice.cap].join(", ")}.` };
  }

  const next: AgentCaps = { ...current.agents?.[key] };
  const agents: Record<string, AgentCaps> = { ...current.agents, [key]: next };
  if (choice.value === null) {
    delete next[choice.cap];
    // An agent whose last stated cap is gone leaves the overlay entirely. Leaving an
    // empty body behind would have the screen keep showing the agent as "capped" with
    // nothing capped, and would make the file grow one dead entry per experiment.
    if (AGENT_CAP_NAMES.every((cap) => next[cap] === undefined)) delete agents[key];
  } else {
    next[choice.cap] = choice.value;
  }
  const overlay: AgentOverlay = { ...current, agents };
  return {
    kind: "written",
    overlay,
    summary:
      choice.value === null
        ? `${agent} ${CAP_LABEL[choice.cap]} now falls back to the config file`
        : `${agent} ${CAP_LABEL[choice.cap]} set to ${choice.value}`,
  };
}

/** The overlay as the screen will write it back, read with the caps module's reader. */
export function overlayFrom(raw: unknown): AgentOverlay {
  return { agents: statedByAgent(raw) };
}
