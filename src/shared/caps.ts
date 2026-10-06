// src/shared/caps.ts
// The cap concept, whole: what a cap IS, which agent it belongs to, whether a
// dispatch may spend one, what the operator sees, and where the edit is stored.
//
// It is ONE module because those five questions have to change together, and while
// they lived in five the concept had no owner: config held the shape, an overlay
// held the file, a third module held the view, the store held the count, and the
// gate held the judgment. Every one of them knew a slice, so changing the KEY — one
// lookup — meant changing all five, and nothing in the type system said so. A
// concept without an owner is a change with a fan-out instead of a seam.
//
// It imports nothing but `node:fs` and `task-policy`, and that is load-bearing
// rather than tidy. The store needs `checkAgentCapacity` to judge a claim, so
// `caps -> task-state` would be a cycle, which is why the count arrives as a MAP of
// numbers instead of the store itself: this module can judge occupancy without
// knowing what a task is, and every consumer that does know builds the map the one
// way `agentKey` says to.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainRecord } from "./host-shape.js";
import type { DepthBound} from "./task-policy.js";
import { depthLimits } from "./task-policy.js";

// ─── the vocabulary ──────────────────────────────────────────────────────────

/**
 * A cap, BY NAME. This list is the source and `AgentCaps` is derived from it, which
 * is the only reason the list is a value.
 *
 * A cap reaches the plugin through two paths — the config file at boot and the
 * overlay file while running — and both are read field by field, by a reader that had
 * no way to learn a field existed. Adding a cap to the type therefore did nothing:
 * the reader still ignored it, every overlay dropped it, and the build stayed green
 * because a type the reader never mentions cannot be violated. `readAgentCapBody`
 * iterates THIS list, so a cap that is declared is a cap that is read, and the one
 * that has to be remembered is the one nobody can add quietly.
 *
 * A cap is a positive integer, which is what makes the derived shape uniform: a new
 * cap is a new name here, never a new type to widen the union below.
 */
export const AGENT_CAP_NAMES = ["maxConcurrent", "maxDepth"] as const;

/** One cap. Named so a reader can iterate it; see `AGENT_CAP_NAMES`. */
export type AgentCapName = (typeof AGENT_CAP_NAMES)[number];

/**
 * One agent's own caps. Every field is optional because an agent may set only some of
 * them and inherit the rest from the top level — `AgentCapPolicy` is the resolved
 * shape, the one that has all of them.
 */
export type AgentCaps = Partial<Record<AgentCapName, number>>;

/**
 * The caps in force, and the only part of a config this module reads.
 *
 * STRUCTURAL, and deliberately not `Pick<DynamicTaskConfig, ...>`: naming the config
 * here would make `caps -> config`, and `config` needs this module for the shape, so
 * the pair would be a cycle over a type that costs nothing to write out. `config`
 * owns precedence between the places a config comes from; this owns what a cap means.
 */
export interface AgentCapSource {
  readonly maxConcurrent: number;
  readonly maxDepth: number;
  readonly agents: Readonly<Record<string, AgentCaps>>;
}

/** An agent's caps with every number filled in. */
export interface AgentCapPolicy {
  /** The agent, in the host's own spelling — the name a dispatch supplies. */
  agent: string;
  maxConcurrent: number;
  maxDepth: number;
}

// ─── the key space ───────────────────────────────────────────────────────────

/**
 * The one spelling of an agent name: case-folded and trimmed, which is the match the
 * admission gate has always used to find an agent by name.
 *
 * A dispatch supplies the HOST's name, whose case is the host's business, while a
 * config key is whatever the operator typed. Folding only one side is the bug: the
 * write is folded and the read is not, so the cap an operator set applies to no agent
 * at all, and nothing reports that — no error, no refusal, just an agent running
 * uncapped under a cap they can see. So the fold happens HERE, on both sides, and
 * every lookup and every write in the plugin goes through this function.
 */
export function agentKey(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

/**
 * An agent's caps, with every number filled in.
 *
 * Keyed by the agent a dispatch already names, which is the entire reason the caps
 * are keyed this way. A lane was a second name the operator had to invent, declare
 * before it was admissible, and then pass on every call that should spend it — and
 * then the two of them had to be explained, because a screen showing both looked
 * like two settings where one was a default and the other a departure from it.
 *
 * `maxDepth` is a PLACEMENT limit: the deepest generation at which THIS agent may be
 * dispatched, so an `explore` capped at 1 is a direct child and never nested. It
 * replaces one global number with one per agent, which is only meaningful because it
 * is scoped — a depth printed on a row that in fact applied to every row would be a
 * number the operator could edit in one place and have change everywhere.
 */
export function resolveAgentCaps(source: AgentCapSource, agent: string): AgentCapPolicy {
  const caps = source.agents[agentKey(agent)] ?? {};
  return {
    agent,
    maxConcurrent: caps.maxConcurrent ?? source.maxConcurrent,
    maxDepth: caps.maxDepth ?? source.maxDepth,
  };
}

/** Every agent with caps of its own, in declaration order. Empty means none are. */
export function knownCappedAgents(source: AgentCapSource): string[] {
  return Object.keys(source.agents);
}

// ─── the judgment ────────────────────────────────────────────────────────────

export interface AgentCapacity {
  /** Running tasks charged to the agent being admitted. */
  agentActive: number;
  /** Running tasks in the whole store, every agent. */
  totalActive: number;
}

/**
 * The one capacity judgment, and it answers two questions in two different words.
 *
 * An agent's cap and the cross-agent ceiling are separate refusals: telling an
 * operator "4 active" when the agent they asked for is idle and someone else's fleet
 * filled the ceiling is the case this split exists for, because the knob that fixes
 * it is not the one the message would otherwise name.
 *
 * Per-agent caps partition concurrency, they never multiply it — the ceiling is the
 * top-level `maxConcurrent` regardless of how many agents are capped, so capping eight
 * agents at four cannot spend more than four.
 */
export function checkAgentCapacity(capacity: AgentCapacity, policy: AgentCapPolicy, ceiling: number): string | null {
  const hint =
    "Wait for a completion notification to arrive, or raise the cap. Use task_list to see the slot holders; task_interrupt frees a slot, and reviving a settled task needs a free slot too.";
  if (capacity.agentActive >= policy.maxConcurrent) {
    return `ConcurrencyLimitExceeded: agent "${policy.agent}" cannot run more than ${counted(policy.maxConcurrent)} of its own (current: ${capacity.agentActive}). ${hint}`;
  }
  if (capacity.totalActive >= ceiling) {
    return `ConcurrencyLimitExceeded: the total ceiling of ${counted(ceiling)} is reached across all agents (current: ${capacity.totalActive}), so a free slot for agent "${policy.agent}" cannot be used. ${hint}`;
  }
  return null;
}

/** "1 active task", "4 active tasks" — a cap's own number, read as English. */
function counted(n: number): string {
  return `${n} active ${n === 1 ? "task" : "tasks"}`;
}

// ─── reading an agent's caps out of untrusted JSON ────────────────────────────

/**
 * A cap the plugin will act on: a whole positive number, and nothing else.
 *
 * A zero, a negative, a fraction, or a string is not a cap — they are a hand-mangled
 * file or a writer with a bug, and honouring one would mean either running nothing
 * (`maxConcurrent: 0` refuses every dispatch with no way to name why) or running
 * without limit (`-1` never refuses). Both read as a broken plugin, so the value is
 * dropped and the underlying config answers instead.
 *
 * EXPORTED, and the one place the question is asked, because the dialog that WRITES
 * caps used to answer it separately and the two disagreed. It accepted a zero, wrote
 * it, told the operator it was "in force on the next dispatch" — and the next read
 * dropped it, so the agent fell through to the top-level default. A cap an operator
 * typed to make an agent TIGHTER came back four times LOOSER, under a success
 * message. Nothing about that is a reader bug: the reader was right and the writer
 * was wrong, and the only fix is for there to be one rule both ask.
 */
export function isAgentCap(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Whether two overlays state the SAME caps.
 *
 * Key order is not a statement: two spellings of one overlay compare equal, because the
 * question asked here is whether the caps the operator chose are the caps now in force.
 * The alternative — asking only whether a document is present — is not a weaker version
 * of this question, it is a different one, and a refused write answers it yes.
 */
export function sameOverlay(left: AgentOverlay, right: unknown): boolean {
  return spelling(left) === spelling(right);
}

/** One document's spelling, keys in order, so two documents can be compared as text. */
function spelling(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(spelling).join(",")}]`;
  if (!isPlainRecord(value)) return JSON.stringify(value) ?? "null";
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${spelling(value[key])}`).join(",")}}`;
}

/**
 * The cap names a body STATED that are not caps, so a caller can tell the operator
 * which of their own numbers were ignored rather than leaving "unset" to be read as
 * "inherited".
 *
 * Named because the same question is asked twice — once to fold them out of the body,
 * once to name them — and two inline answers to one question drift the first time a
 * cap is added.
 */
export function unusableCapNames(raw: unknown): AgentCapName[] {
  if (!isPlainRecord(raw)) return [];
  return AGENT_CAP_NAMES.filter((name) => raw[name] !== undefined && cap(raw[name]) === undefined);
}

function cap(value: unknown): number | undefined {
  return isAgentCap(value) ? value : undefined;
}

/** The two top-level knobs, read off any body that carries them. `undefined` means absent. */
function readTopLevelCaps(body: Record<string, unknown>): { maxConcurrent?: number; maxDepth?: number } {
  const maxConcurrent = cap(body.maxConcurrent);
  const maxDepth = cap(body.maxDepth);
  return {
    ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  };
}

/**
 * The knobs an agent body may set. Nothing else in it is a policy statement.
 *
 * Iterated over `AGENT_CAP_NAMES` rather than written out per field, so that a cap
 * added there is read by this function without anyone editing it. Written out, this
 * is a list of the caps someone remembered, and the cap they did not is dropped from
 * every overlay the plugin ever applies — silently, because a field a reader never
 * mentions cannot be a type error against it.
 */
export function readAgentCapBody(raw: unknown): AgentCaps {
  if (!isPlainRecord(raw)) return {};
  const body = raw;
  const out: AgentCaps = {};
  for (const name of AGENT_CAP_NAMES) {
    const value = cap(body[name]);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * An agent's declared caps, or null when there is nothing to honour.
 *
 * Null covers both ways a body can be worthless, and both are DROPPED because
 * dropping is the loud option among the silent ones: standing in the top-level
 * numbers instead would answer a question the operator did not ask, by quietly
 * spending a budget they explicitly overrode. An empty body (`{}`) used to be a way
 * to say something — under lanes it was the only spelling of "a name of its own on
 * the shared budget" — and it is not any more, because an agent is already counted on
 * its own by `agentOccupancy` without being asked to be. There is nothing left for
 * the entry to say, so it says nothing.
 */
export function parseAgentCaps(raw: unknown): AgentCaps | null {
  if (!isPlainRecord(raw)) return null;
  const caps = readTopLevelCaps(raw);
  return Object.keys(caps).length === 0 ? null : caps;
}

// ─── the overlay: the operator's edit, as a document ─────────────────────────
//
// It USED to be a file beside the ledger, and the reason it is not is the TUI: a
// dialog that could not reach the same store the dispatch path reads was a dialog
// whose "saved" meant nothing to the next dispatch. The document's shape is
// unchanged — only where it lives, and who is allowed to write it.

/**
 * The agents of an untrusted overlay, and what it had to throw away to get them.
 *
 * The report travels with the read because the reader is the ONLY place that knows:
 * asking anything else to work out which caps were dropped means a second reader of
 * the same untrusted file, which is the disagreement this module exists to prevent. A
 * dialog that cannot say what it ignored shows a cap the dispatch path will not
 * honour as though it applied.
 */
export interface OverlayAgents {
  agents: Record<string, AgentCaps>;
  dropped: Record<string, string[]>;
  /**
   * The cross-agent ceiling the file STATES, or undefined when it states none.
   *
   * Carried beside the agents so a screen can say whether the total it shows is the
   * operator's own number or the config file's — the same stated/inherited pair the
   * per-agent cells carry, and read by the same `cap` rule so the two cannot disagree
   * about what counts as a number. A reader of this field anywhere else is a second
   * rule for the same untrusted file, which is the thing this module exists to prevent.
   */
  maxConcurrent?: number;
}

export interface AgentOverlay {
  /** The cross-agent ceiling. Agent caps never multiply it, so this is the total. */
  maxConcurrent?: number;
  /** The fallback depth for any agent that does not cap one of its own. */
  maxDepth?: number;
  agents?: Record<string, AgentCaps>;
}

/**
 * The agents of an untrusted overlay, and what it had to throw away to get them.
 *
 * The report travels with the read because the reader is the ONLY place that knows:
 * asking anything else to work out which caps were dropped means a second reader of
 * the same untrusted file, which is the disagreement this module exists to prevent. A
 * dialog that cannot say what it ignored shows a cap the dispatch path will not
 * honour as though it applied.
 */
export function readAgentOverlayCaps(raw: unknown): OverlayAgents {
  const { agents, dropped, usable } = readOverlayAgents(raw);
  const stated = usable ? cap(overlayBody(raw)?.maxConcurrent) : undefined;
  // `exactOptionalPropertyTypes` is on, so an absent key and a key holding
  // `undefined` are different values. Spreading would write the latter and the
  // dialog's `!== undefined` check would be answering a question about presence that
  // the object no longer describes.
  return stated === undefined ? { agents, dropped } : { agents, dropped, maxConcurrent: stated };
}

/**
 * An overlay document that may be STORED, or null when it may not.
 *
 * Stricter than a read on purpose, and it is the same rules: a read folds an unusable
 * body out and says which one it dropped, because a screen would rather show a cap
 * without its neighbour than refuse the whole screen. A write has no such luxury — a
 * document stored half-understood is caps the operator never wrote — so the ONE place
 * those rules live answers this question too, and a caller that wants to write holds a
 * second opinion by construction.
 */
export function parseAgentOverlay(raw: unknown): AgentOverlay | null {
  if (!isPlainRecord(raw)) return null;
  const { agents, dropped, usable } = readOverlayAgents(raw);
  if (!usable || Object.keys(dropped).length > 0) return null;
  const stated = readTopLevelCaps(raw);
  // Absent keys stay absent: `exactOptionalPropertyTypes` is on, so spreading would
  // store an `undefined` and the reader on the other side would be answering a
  // question about presence that the document no longer describes.
  return { ...stated, agents };
}

/**
 * The overlay's agents, folded and with the unusable bodies left out.
 *
 * THE read, and both of its callers come through here: `applyAgentOverlay` is what a
 * dispatch is judged against and this is what a dialog shows. When they were separate
 * loops over the same untrusted map they agreed by luck, and the two answers were free
 * to diverge the moment a rule changed in one of them — which is a production clone,
 * and the duplication gate was right to call it.
 *
 * `usable` is false when the file's `agents` is present and is not an object, which is
 * a different answer from "present and empty" and from "absent": it is a file that said
 * something the reader cannot act on, and the two callers each report it in their own
 * words (a refusal and a warning) because the words are for different audiences.
 */
function readOverlayAgents(raw: unknown): OverlayAgents & { usable: boolean } {
  const empty = { agents: {} as Record<string, AgentCaps>, dropped: {} as Record<string, string[]>, usable: true };
  const body = overlayBody(raw);
  if (!body) return { ...empty, usable: false };
  const rawAgents = body.agents;
  if (rawAgents === undefined) return empty;
  if (!isPlainRecord(rawAgents)) return { ...empty, usable: false };

  const agents: Record<string, AgentCaps> = {};
  const dropped: Record<string, string[]> = {};
  for (const [name, entry] of Object.entries(rawAgents)) {
    const key = agentKey(name);
    if (!key) continue;
    const caps = readAgentCapBody(entry);
    const ignored = unusableCapNames(entry);
    // A named agent with nothing left to honour is dropped LOUDLY: it said something
    // the reader cannot use, and vanishing quietly leaves a screen where the operator's
    // agent is simply not capped.
    if (AGENT_CAP_NAMES.every((field) => caps[field] === undefined)) {
      dropped[key] = ignored.length > 0 ? ignored : [...AGENT_CAP_NAMES];
      continue;
    }
    agents[key] = caps;
    if (ignored.length > 0) dropped[key] = ignored;
  }
  return { agents, dropped, usable: true };
}

/**
 * The overlay as policy, or null when there is nothing to layer.
 *
 * Null is distinct from `{}`: null means "no overlay, or one that said nothing
 * usable", and the caller then keeps the base config by identity rather than
 * rebuilding it — so a tree with no overlay resolves exactly as it did before this
 * file existed, which is the claim the whole feature rests on.
 */
export function applyAgentOverlay(base: AgentCapSource, raw: unknown): AgentCapSource | null {
  const body = overlayBody(raw);
  if (!body) return null;
  const { agents, usable } = readOverlayAgents(raw);
  if (!usable) return null;
  const caps = readTopLevelCaps(body);
  if (Object.keys(caps).length === 0 && Object.keys(agents).length === 0) return null;
  return {
    maxConcurrent: caps.maxConcurrent ?? base.maxConcurrent,
    maxDepth: caps.maxDepth ?? base.maxDepth,
    // An agent the overlay does not mention keeps the base file's numbers: the
    // overlay is an EDIT, not a replacement, so an operator who capped one agent does
    // not silently reset the rest to the top-level defaults.
    agents: { ...base.agents, ...agents },
  };
}

/** The object an overlay is, or null when it is not one. */
function overlayBody(raw: unknown): Record<string, unknown> | null {
  return isPlainRecord(raw) ? raw : null;
}

/**
 * The overlay of the feature this one replaced. Named only so it can be reported.
 *
 * Nothing reads this file and nothing ever will — it is here to be named in a warning
 * at boot, because an operator who had caps working last week and finds them silently
 * not applying deserves to be told which file stopped being read.
 */
export const RETIRED_LANE_FILE = ".dynamic-task-lanes.json";

/** The retired overlay's path, so a stale file can be named rather than ignored. */
export function retiredLaneOverlayPath(directory: string | undefined): string {
  return join(directory || "", RETIRED_LANE_FILE);
}
/** Whether a project still carries the retired lane overlay, so it can be named. */
export function retiredOverlayPresent(directory: string | undefined): boolean {
  try {
    readFileSync(retiredLaneOverlayPath(directory), "utf8");
    return true;
  } catch {
    return false;
  }
}

// ─── the live policy ──────────────────────────────────────────────────────────
//
// One installer, one getter, no arguments to thread: the chokepoint has to sit where
// a cap decision is actually made, and cap decisions are made deep in the store by
// callers (a spawn, a revival) that know nothing about a project directory. Tenet9's
// process-global shape is the same one the notification ledger and the pending-queue
// writer already use, for the same reason: the thing being held is per-process policy,
// and a boot installs it exactly once.

/**
 * The policy a cap decision is made against RIGHT NOW, in force for the process.
 *
 * A VALUE and not a reader, and that is the change that made the dispatch path
 * synchronous again: the reader used to re-read a file on every cap decision so an
 * operator's edit applied without a restart. The store cannot be read on that path —
 * it is a bounded host call, and a cap decision has no way to represent "the host did
 * not answer" without either refusing a dispatch or judging it against the wrong
 * numbers. So the change is PUSHED instead: the boot reads the store, and the write
 * path installs the new policy in the process that accepted it. A cap decision is
 * then a field read, and "the number changes without a restart" is still true.
 *
 * Falls back to the boot config when nothing is installed, so a project with no
 * overlay degrades to exactly the frozen behaviour that shipped before per-agent caps.
 */
let inForce: AgentCapSource | null = null;

/** Boot installs the policy; a write installs the operator's new one. */
export function installLiveAgentCaps(caps: AgentCapSource | null): void {
  inForce = caps;
}

/** Test seam: forget the installed policy and return to boot-only policy. */
export function resetLiveAgentCaps(): void {
  inForce = null;
}

export function liveAgentCaps(base: AgentCapSource): AgentCapSource {
  return inForce ?? base;
}

// ─── the view: what the operator sees ─────────────────────────────────────────

/** One agent, as the operator sees it. */
export interface AgentOccupancy {
  /** The agent, in the host's spelling. */
  agent: string;
  /** Running tasks charged to this agent. */
  active: number;
  /** The cap in force, with the fallback applied. What a dispatch would be judged against. */
  maxConcurrent: number;
  /**
   * The caps this agent STATES in the overlay, which may be none of them.
   *
   * Carried beside the resolved numbers rather than instead of them, because the
   * difference is the one an operator cannot otherwise see: `maxConcurrent` says
   * what applies, and this says whether they wrote it. An agent showing the top-level
   * four because nothing was set for it looks identical to one deliberately set to
   * four, and those are the two answers a screen must not confuse.
   */
  stated: AgentCaps;
  /** The depth cap as configured, and the depth actually reachable. */
  depthConfigured: number;
  /** `null` when the dispatchable set could not be read — an unknown, not a zero. */
  depthEffective: number | null;
  /** Which constraint caps the reachable depth. `null` alongside a null effective. */
  depthBoundBy: DepthBound | null;
}

/**
 * Every agent worth a row, with the numbers filled in.
 *
 * `agentNames` is the HOST's registered agents, or null when they could not be read.
 * That null is carried into the result rather than collapsed into an empty list,
 * because the two render identically and mean opposite things: no agents means this
 * project cannot delegate at all, and a failed read means we do not know. A view
 * that reported the second as the first tells an operator their fleet is gone.
 *
 * When the set IS known the rows are exactly it — every dispatchable agent gets a
 * row whether or not it is capped, because a screen that lists only the capped ones
 * cannot answer "how many of `explore` may run" for an agent nobody capped yet, and
 * an operator who has to create an entry to find out the answer has been asked to do
 * bookkeeping to read a screen.
 *
 * `activeByAgent` is a COUNT, never the store. `task-state` needs `checkAgentCapacity`
 * to judge a claim, so this module may not depend on the store; passing the count keeps
 * the judgment here and the knowledge of what a task is there.
 */
export function agentOccupancy(
  source: AgentCapSource,
  agentNames: readonly string[] | null,
  activeByAgent: ReadonlyMap<string, number>,
  allowSameAgentRecursion: boolean,
): AgentOccupancy[] {
  // Fall back to the capped agents when the host's set is unreadable: those are the
  // only ones known to exist, and showing the caps we can vouch for beats an empty
  // screen that reads as "this project has no agents".
  const names = agentNames ?? knownCappedAgents(source);
  return names.map((agent) => {
    const policy = resolveAgentCaps(source, agent);
    const limits = depthLimits({ allowSameAgentRecursion, maxDepth: policy.maxDepth }, agentNames ?? []);
    return {
      active: activeByAgent.get(agentKey(agent)) ?? 0,
      agent,
      depthBoundBy: agentNames === null ? null : limits.boundBy,
      depthConfigured: policy.maxDepth,
      depthEffective: agentNames === null ? null : finiteDepth(limits.effective),
      maxConcurrent: policy.maxConcurrent,
      stated: source.agents[agentKey(agent)] ?? {},
    };
  });
}

/** An unbounded depth has no number to show; -1 is what the config spells. */
function finiteDepth(effective: number): number {
  return Number.isFinite(effective) ? effective : -1;
}
