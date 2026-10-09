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
//jscpd:ignore-start
import {
  AGENT_CAP_NAMES,
  type AgentCapName,
  type AgentCapSource,
  type AgentCaps,
  type AgentOverlay,
  type OverlayAgents,
  applyAgentOverlay,
  readAgentOverlayCaps,
  resolveAgentCaps,
} from "../shared/caps.js";
import { agentKey } from "../shared/agent-key.js";
import { type ModelOverride, isModelOverride, spellModel } from "../shared/model-choice.js";
import type { DepthBound} from "../shared/task-policy.js";
import { depthHeldBy, depthLimits } from "../shared/task-policy.js";

//jscpd:ignore-end
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

/**
 * How each cap reads as a thing you COUNT, on a row of figures.
 *
 * A second vocabulary beside `CAP_LABEL`, and the two are not interchangeable — they are
 * different registers of the same noun, and conflating them produces either a bad menu
 * or a bad sentence.
 *
 * `CAP_LABEL` is what the cap is CALLED, and it appears inside sentences where the cap is
 * the subject: `explore refused, already at once 2`. Read as a count — `2 at once` — it
 * is idiomatic, because the word is an adverb there and the number counts it.
 *
 * `CAP_NOUN` is what the number is a count OF, and it appears where a figure stands
 * alone: `Explore: 4 concurrency * 2 depth`. That is a table of quantities, and a table
 * wants a noun, so `at once` becomes `concurrency` and `depth` stays `depth`.
 *
 * So this is not a rename of `CAP_LABEL` and does not replace it. Both are looked up by
 * cap name, so a cap added to `AGENT_CAP_NAMES` without a noun here is a type error
 * rather than a row reading `Explore: 4  * 2 depth`.
 */
export const CAP_NOUN: Record<AgentCapName, string> = {
  maxConcurrent: "concurrency",
  maxDepth: "depth",
};

/**
 * The word for the model setting, in the register a label sits in.
 *
 * Beside `CAP_LABEL` rather than inside it: a model is not a cap, and the caps module's
 * vocabulary is a list of names a `Record` over `AgentCapName` types to. A model added
 * to that list would be a number type with a string in it.
 */
export const MODEL_LABEL = "model";

/**
 * What the screen says when nothing is configured and the parent's own model is used.
 *
 * A WORD and not `(default)`, because the ladder's bottom layer is a live fact about
 * the dispatching parent rather than a stored value, and "default" would name a setting
 * nobody can open. `(default)` is what the cap rows use for an absent number, and the
 * two answers are different: one reads a config, the other reads the parent.
 */
export const FROM_PARENT = "parent's model";

/**
 * What the screen says when the model is the config file's rather than the operator's.
 *
 * The same claim `INHERITED` makes for a cap figure, in the register a full cell sits
 * in, and it is separate rather than shared because a cell reads as a sentence `4 from
 * config` and a figure does not.
 */
export const MODEL_FROM_CONFIG = "from config file";

/**
 * An agent's name as a menu item's leading word, and NOT as a route.
 *
 * Capitalised because a list of names is a list of ITEMS, and a column of lower-case
 * identifiers is a column of keys — the eye reads a lowercase run as a machine name
 * rather than as a thing you can choose. It is display only: the host's spelling is what
 * the row's `value` carries and what every write is addressed to, so nothing here can
 * turn a press on `Explore` into a write against an agent that does not exist.
 */
export const displayName = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1);

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
export interface ResolvedCaps { maxConcurrent: number; maxDepth: number }

/**
 * A model, as a cell: the qualified id in force, and whether the operator stated it.
 *
 * A PAIR for the same reason a cap cell is one — "is this mine?" is a question the
 * screen has to answer rather than leave the operator to work out from a string. `model`
 * is null only when nothing is configured anywhere and the ladder's bottom layer reads
 * the dispatching parent, which is a live fact and not a stored value.
 */
export interface ModelCell {
  /** The model in force, or null to inherit the parent's own. A pair, like every other model in the plugin. */
  model: ModelOverride | null;
  /** False when the config file or the layer above supplies it rather than this body. */
  stated: boolean;
}


/** One agent, as the screen holds it. */
export interface AgentEntry {
  /** The agent, in the HOST's spelling — what a dispatch names. */
  name: string;
  /** The caps in force, with the config file's fallbacks applied. */
  resolved: ResolvedCaps;
  /** The caps the overlay states for this agent, which may be none of them. */
  stated: AgentCaps;
  /**
   * The nesting depth that is actually reachable, and what holds it there.
   *
   * `resolved.maxDepth` is the cap the operator SET, which is not always the depth they
   * can reach: with distinct-agent recursion off, the agent set binds first, so a cap of
   * 4 over three agents permits 3 and not 4. This is the screen the cap is set ON, so a
   * row that printed only the cap would let the operator type a number that does not
   * take effect and leave them to discover it in `task_list`. Carried per row rather
   * than derived at the cell because `depthLimits` is the resolver — the same one
   * `task_list` reads through — and a cell that worked it out itself would be a second
   * answer to a question the screen already has an answer to.
   */
  depth: DepthBinding;
  /**
   * The model this agent's children run on, as a cell.
   *
   * The ladder's per-agent layer, resolved: the agent's own stated model, else the global
   * one, else the parent. Carried resolved rather than as a stated pair, because the row
   * has to show what a dispatch will USE and not merely what the operator typed — the
   * same reason the caps ride resolved with `stated` beside them.
   */
  model: ModelCell;
}

/** The reachable depth, the cap that was set, and the constraint that binds. */
export interface DepthBinding {
  readonly configured: number;
  /** null when the dispatchable agents are unknown, so no depth can be claimed. */
  readonly effective: number | null;
  readonly boundBy: DepthBound | null;
}

/** What the screen shows and where it writes back. */
export interface AgentDialog {
  rows: AgentEntry[];
  /**
   * The cross-agent total, as a cell.
   *
   * A `CapCell` and not a number, for the reason every other cell on this screen is a
   * cell: the number in force and whether the operator wrote it are two different
   * answers to "did I do that?", and a bare integer cannot carry both. `bounded` is
   * always null — nothing holds a total down but the total.
   *
   * It is the cap the dispatch path refuses on FIRST (`checkAgentCapacity` asks the
   * ceiling before the agent's own cap), and it is the one number an operator raising
   * every per-agent cap to twenty will still hit, which is why it earns a row of its
   * own rather than living in a cell somewhere it has to be looked up from.
   */
  ceiling: CapCell;
  /**
   * The global model, as a cell — the layer every agent falls back to before the
   * dispatching parent's own model is read.
   *
   * Beside `ceiling` rather than elsewhere on this shape because it is the same kind of
   * thing: one setting that applies to every agent, held where the ceiling is held, and
   * stated/inherited in exactly the same way.
   */
  model: ModelCell;
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
  allowSameAgentRecursion: boolean,
  problem: string | null,
): AgentDialog {
  // Stated caps come from the overlay through the caps module's OWN reader, so an
  // edit written on top of them is a body the dispatch path will accept. A value that
  // arrived as `{"maxConcurrent": "four"}` is read as absent, and the edit replaces
  // the garbage rather than preserving it beside a new number.
  const stated = readStated(raw);
  const names = agentNames ?? Object.keys(stated.agents);  // The numbers in force are resolved against the base config WITH the overlay
  // applied — by the caps module's own function, which is the one the dispatch path
  // resolves against. Resolving against `base` alone made a stated cap render the
  // CONFIG's number marked as the operator's own, which is the one confusion the
  // stated/inherited pair exists to prevent, arriving through the pair itself.
  const inForce = applyAgentOverlay(base, raw) ?? base;
  return {
    ceiling: { bounded: null, stated: stated.maxConcurrent !== undefined, value: inForce.maxConcurrent },
    // The overlay's own statement, else the config file's, else the parent. The stated
    // half is the overlay's answer alone, so the cell can say which of the two files a
    // model came from.
    model: { model: inForce.model ?? null, stated: stated.model !== undefined },
    problem,
    rows: names.map((name) => {
      const policy = resolveAgentCaps(inForce, name);
      const own = stated.agents[agentKey(name)] ?? {};
      return {
        depth: depthBindingFor(policy.maxDepth, allowSameAgentRecursion, agentNames),
        // The agent's own model wins over the global one, by the ladder's own order, and
        // the cell says whose it is: an agent showing the global model is not the same
        // answer as one showing its own.
        model: { model: own.model ?? inForce.model ?? null, stated: own.model !== undefined },
        name,
        resolved: capsOf(policy),
        stated: own,
      };
    }),
  };
}

/**
 * The depth an agent can reach, or the honest "not claimable".
 *
 * The agent set is `agentNames` and NOT `names`: when the host's agent list could not be
 * read, `names` falls back to the agents the overlay caps so the screen still has rows to
 * draw — but that is a DISPLAY decision, and a set of one capped agent would report a
 * reachable depth of 1 over a project that dispatches to twenty. So the depth is claimed
 * only from the real set, and an unreadable one claims nothing.
 *
 * An EMPTY set is emphatically not the unknown answer: `depthLimits` reads one as depth
 * 0 with the agent set binding, and "nothing may nest" is a harder claim than "we could
 * not find out", printed on a screen whose whole job is telling the operator what will
 * happen to their dispatches.
 */
function depthBindingFor(configured: number, allowSameAgentRecursion: boolean, agentNames: readonly string[] | null): DepthBinding {
  if (agentNames === null) return { boundBy: null, configured, effective: null };
  const limits = depthLimits({ allowSameAgentRecursion, maxDepth: configured }, agentNames);
  return { boundBy: limits.boundBy, configured, effective: limits.effective };
}

/**
 * What the file STATES, read once for both the screen and the write-back.
 *
 * The two halves of the overlay in one read, because a caller that asked for them
 * separately was two readers of one untrusted file — and the second reader is the one
 * that goes stale the moment a rule changes in the first.
 */
interface StatedOverlay {
  /** The stated per-agent caps, by folded agent key, minus the bodies that state none. */
  agents: Record<string, AgentCaps>;
  /** The stated cross-agent total, or undefined when the file states none. */
  maxConcurrent: number | undefined;
  /** The stated top-level model, or undefined when the file states none. */
  model: ModelOverride | undefined;
}

function readStated(raw: unknown): StatedOverlay {
  const overlay = readAgentOverlayCaps(raw);
  return { agents: statedByAgent(overlay), maxConcurrent: overlay.maxConcurrent, model: overlay.model };
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
function statedByAgent(overlay: OverlayAgents): Record<string, AgentCaps> {
  const { agents } = overlay;
  // An agent whose body carried nothing usable is not an agent the operator capped,
  // and keeping it here would make `knownCappedAgents` report a cap that does not
  // exist. `readAgentOverlayCaps` keeps it so the caller can SAY it was dropped; here
  // the screen has better rows to draw, so the entry goes.
  return Object.fromEntries(Object.entries(agents).filter(([, caps]) => Object.keys(caps).length > 0));
}

/**
 * A model cell as the screen prints it: the id in force, or whose it is.
 *
 * Beside `terseCell` rather than inside it, because a cap figure is a number with an
 * optional bound and a model is a string with a fallback — one is `3/4`, the other is
 * `nvidia/z-ai/glm-5.3` or `parent's model`. Folding them would make the number's two
 * shapes (`3`, `3/4`) share a branch with the model's three.
 *
 * NO provenance here: this is the spelling on the list, a column of rows where an
 * adjective on every entry is noise. The screen where the operator is DECIDING gets the
 * other one, exactly as a cap does.
 */
export function modelCell(cell: ModelCell): string {
  return cell.model === null ? FROM_PARENT : spellModel(cell.model);
}

/**
 * A model cell where the operator is deciding about it, so it says whose it is.
 *
 * The same answer `namedCell` gives a cap figure, in the register a full row sits in: an
 * agent showing the global model is a different statement from one showing its own, and
 * the operator is on the screen where that difference is what they came to change.
 */
export function namedModelCell(cell: ModelCell): string {
  if (cell.model === null) return FROM_PARENT;
  const spelled = spellModel(cell.model);
  return cell.stated ? spelled : `${spelled} ${MODEL_FROM_CONFIG}`;
}

/** The value a cell shows, and whether it is the operator's or the config file's. */
export interface CapCell {
  /** The number in force. */
  value: number;
  /** False when the number is the config file's fallback rather than a stated cap. */
  stated: boolean;
  /**
   * The depth actually reachable, when something other than this cap is what bounds it.
   *
   * A DEPTH cell only. It is the one cap whose number is not the number in force: with
   * distinct-agent recursion off the agent set binds first, so a cap of 4 over three
   * agents permits 3. Null for a concurrency cell, and null when nothing else binds — so
   * "no ceiling but this cap" and "the ceiling is unknown" stay two different answers
   * rather than both being the absence of a number.
   */
  bounded: number | null;
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
  return { bounded: ceilingOf(row.depth, cap, value), stated: row.stated[cap] !== undefined, value };
}

/**
 * The reachable depth when the agent set holds it below the cap, else null.
 *
 * The cap-shaped half of `depthHeldBy`, which is where the three conditions and the
 * reasoning live. It stays here because the CAP is this module's vocabulary — a
 * concurrency cell has no ceiling that is not its own value — and it is exported
 * because the picker needs the same answer for a value it has not chosen yet.
 */
export function ceilingOf(depth: DepthBinding, cap: AgentCapName, value: number): number | null {
  return cap === "maxDepth" ? depthHeldBy(depth, value) : null;
}

/** The resolved pair, without the agent name the row already carries. */
function capsOf(policy: { maxConcurrent: number; maxDepth: number }): ResolvedCaps {
  return { maxConcurrent: policy.maxConcurrent, maxDepth: policy.maxDepth };
}

// ─── the edit ────────────────────────────────────────────────────────────────

/** What a cap choice means. `default` removes the stated cap; a number sets it. */
export interface CapChoice { cap: AgentCapName; value: number | null }

/** The cross-agent total's label, the one word the refusal and the screen share. */
export const CEILING_LABEL = "total ceiling";

/**
 * What a ceiling choice means.
 *
 * No `cap` field, where `CapChoice` carries one: the total has exactly ONE setting, so
 * naming the cap here would be a field with one legal value that a caller could fill in
 * wrongly. The alternative — accepting a `CapChoice` and refusing the wrong cap at
 * runtime — makes "which cap is this" a question the type system could have answered.
 */
export interface CeilingChoice { value: number | null }

/**
 * What a model choice means: a qualified providerID/modelID, or null to clear it.
 *
 * The same `{ value }` shape its two siblings use, deliberately: `CapChoice` and
 * `CeilingChoice` both read `choice.value`, and a writer that had to know which of the
 * three it held before it could find the value would be a third answer to one question.
 * A model is not a number — that is `V`, not the field — so the field name stays shared
 * and only the type moves.
 */
export interface ModelChoice { value: ModelOverride | null }

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
  // What the operator will be told, and therefore what a refusal names: one string
  // that is both this cap's label and the sentence `editOutcome` builds. An agent's cap
  // and the cross-agent total are different targets, and the only thing they do not
  // share is the words the operator reads.
  const label = `${agent} ${CAP_LABEL[choice.cap]}`;
  return editOutcome({
    before: current.agents?.[key]?.[choice.cap],
    build: (value) => ({ ...current, agents: withAgentField(current, key, choice.cap, value) }),
    choice,
    label,
    fallback: "falls back to the config file",
    refuse: (value) => refuseCap(choice.cap, label, value),
  });
}

/** The overlay as the screen will write it back, read with the caps module's reader. */
export function overlayFrom(raw: unknown): AgentOverlay {
  const stated = readStated(raw);
  // The WHOLE overlay, not just its agents. This used to build `{ agents }` and drop
  // everything else, which was invisible until the screen could also write the
  // cross-agent ceiling: setting a per-agent cap rewrote the file and DELETED the
  // ceiling, with a success toast saying the other cap had been set. The file is
  // written whole on every edit, so anything this does not carry forward is
  // destroyed — the two halves are not independent documents that happen to share a
  // file, they are one document.
  //
  // The model rides the same rule and for the same reason, at both levels: a capability
  // edit that dropped the global model would leave the file saying nothing about a
  // setting the operator had just watched work, and an agent edit would do the same to
  // the agent's own body — which is why `AgentCaps` carries `model` rather than the
  // document having a second per-agent place to hold it.
  const carried = Object.keys(stated.agents).length > 0 ? { agents: stated.agents } : {};
  const withTotal = stated.maxConcurrent === undefined ? carried : { ...carried, maxConcurrent: stated.maxConcurrent };
  return stated.model === undefined ? withTotal : { ...withTotal, model: stated.model };
}

/**
 * Set the cross-agent ceiling, in the overlay.
 *
 * The sibling of `applyCapEdit` rather than a case inside it, because the target is
 * not an agent: there is no key to fold, no agent body to merge into, and no empty
 * body to prune afterwards. The two share their OUTCOME vocabulary and one question —
 * is this a value the picker may offer? — asked by `refuseValue` rather than twice.
 */
export function applyCeilingEdit(current: AgentOverlay, choice: CeilingChoice): EditOutcome {
  return editOutcome({
    before: current.maxConcurrent,
    choice,
    label: CEILING_LABEL,
    fallback: "falls back to the config file",
    refuse: (value) => refuseCap("maxConcurrent", CEILING_LABEL, value),
    // Spread-then-delete rather than a conditional object, so clearing the ceiling
    // leaves the agents exactly as they were. The key is absent, not `undefined`:
    // `exactOptionalPropertyTypes` is on, and a file carrying `null` where a reader
    // expects a number is a file this module would have to defend against on the way in.
    build: (value) => {
      const { maxConcurrent: _dropped, ...rest } = current;
      return value === null ? rest : { ...rest, maxConcurrent: value };
    },
  });
}

/**
 * Every edit's three questions before the file is touched, in the order both ask them.
 *
 * `build` is the only part that differs between the editors, and it is a FUNCTION so
 * that difference is visible in the signature rather than buried in a branch: what the
 * target is called, and how a value is written under it. The label is the operator's
 * word for that target, and it is the same word the refusal and the success sentence
 * use — so a screen can no more call the total "at once" than the toast can.
 *
 * GENERIC over the value, and the caps are one instantiation rather than the definition:
 * a model is not a number, so the number-typed version would have had to be forked and
 * the fork is where the two would drift. `refuse` is a parameter rather than a call to
 * `CAP_CHOICES` for the same reason — a picker's offer list is the acceptance rule, and
 * a model picker's list comes from the host's own catalog.
 */
/**
 * The agent map with one field of one agent written, or removed when `value` is null.
 *
 * Both the cap and the model edit go through here, so the rule that an agent with nothing
 * left leaves the overlay lives in one place. Leaving an empty body behind would have the
 * screen keep showing the agent as "capped" with nothing capped, and would make the file
 * grow one dead entry per experiment. A model is a statement too, so it is checked with
 * the caps before the body goes.
 */
function withAgentField<F extends keyof AgentCaps>(
  current: AgentOverlay,
  key: string,
  field: F,
  value: AgentCaps[F] | null,
): Record<string, AgentCaps> {
  const next: AgentCaps = { ...current.agents?.[key] };
  const agents: Record<string, AgentCaps> = { ...current.agents, [key]: next };
  if (value === null) {
    delete next[field];
    if (AGENT_CAP_NAMES.every((c) => next[c] === undefined) && next.model === undefined) delete agents[key];
  } else {
    next[field] = value;
  }
  return agents;
}

function editOutcome<V>(spec: {
  before: V | undefined;
  choice: { value: V | null };
  label: string;
  /** What a cleared value falls back to, as the clause that finishes the sentence. */
  fallback: string;
  /** Why a value is not one the picker may offer, or null when it is. */
  refuse: (value: V) => string | null;
  build: (value: V | null) => AgentOverlay;
}): EditOutcome {
  if (spec.before === (spec.choice.value ?? undefined)) return { kind: "unchanged" };
  const problem = spec.choice.value === null ? null : spec.refuse(spec.choice.value);
  if (problem) return { kind: "invalid", problem };
  return {
    kind: "written",
    overlay: spec.build(spec.choice.value),
    summary:
      spec.choice.value === null
        ? `${spec.label} now ${spec.fallback}`
        : `${spec.label} set to ${spec.choice.value}`,
  };
}

/**
 * Why a value the picker offers would be refused, or null when it is one of them.
 *
 * A list rather than "any positive integer" because the list IS the picker's content:
 * a screen that offers eight numbers and accepts a ninth it never showed is a screen
 * whose file can hold a value its own UI cannot reproduce. The label travels with the
 * check so each writer's refusal names ITS OWN cap — `at once` for an agent's
 * concurrency, `total ceiling` for the total — instead of both naming the cap the
 * vocabulary happens to be keyed by.
 */
function refuseCap(cap: AgentCapName, label: string, value: number): string | null {
  if (CAP_CHOICES[cap].includes(value)) return null;
  return `${value} is not a value ${label} can take here: ${CAP_CHOICES[cap].join(", ")}.`;
}

/**
 * Why a model the picker offers would be refused, or null when it is one of them.
 *
 * The model module's OWN rule, asked by the writer so the two cannot be two: a screen
 * that offered a bare id would write a pair with an empty provider and then tell the
 * operator it was in force. The host's catalog is the picker's content, so a value the
 * catalog does not hold is the only thing this can still catch — and it catches it
 * rather than writing a model the dispatch path would route nowhere.
 */
function refuseModel(label: string, value: ModelOverride): string | null {
  return isModelOverride(value) ? null : `"${JSON.stringify(value)}" is not a providerID/modelID pair, which is the only form ${label} can take.`;
}

/**
 * Set the global model, in the overlay — layer 2 of the ladder, for every agent that does
 * not choose one of its own.
 *
 * The sibling of `applyCeilingEdit` for the same reason and in the same shape: the target
 * is the document rather than an agent body, so there is no key to fold and no body to
 * prune. Clearing it hands every agent without its own model back to the layer below —
 * the dispatching parent's own model, which is a live read and not a stored value, so the
 * sentence says so rather than naming a file.
 */
export function applyGlobalModelEdit(current: AgentOverlay, choice: ModelChoice): EditOutcome {
  return editOutcome({
    before: current.model,
    choice,
    label: MODEL_LABEL,
    fallback: "falls back to each agent's own model, then the parent's own",
    refuse: (value) => refuseModel(MODEL_LABEL, value),
    build: (value) => {
      const { model: _dropped, ...rest } = current;
      return value === null ? rest : { ...rest, model: value };
    },
  });
}

/**
 * Set one agent's own model, in the overlay — layer 3, which beats the global one.
 *
 * The sibling of `applyCapEdit`: one key folded, one body merged, and the same pruning
 * rule afterwards, because an agent whose last statement of any kind is gone has nothing
 * left for the overlay to say about it.
 */
export function applyAgentModelEdit(current: AgentOverlay, agent: string, choice: ModelChoice): EditOutcome {
  const key = agentKey(agent);
  if (!key) return { kind: "invalid", problem: "That agent has no name, so there is no key to write the model under." };
  const label = `${agent} ${MODEL_LABEL}`;
  return editOutcome({
    before: current.agents?.[key]?.model,
    choice,
    label,
    fallback: "falls back to the global model",
    refuse: (value) => refuseModel(label, value),
    build: (value) => ({ ...current, agents: withAgentField(current, key, "model", value) }),
  });
}
