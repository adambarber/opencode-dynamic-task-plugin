/**
 * The cap overlay — the file that edits policy without a restart.
 *
 * Every case here is a claim about WHEN a cap takes effect, because that is the
 * whole feature: a frozen config is the thing being replaced. The cases are
 * written against the real store and the real admission gate rather than against
 * the overlay's own functions, because the failure this guards is a cap that the
 * overlay accepts and the gate ignores — which a unit test of the parser alone
 * would report green through.
 */

//jscpd:ignore-start
import { TaskState, activeByAgent, createTaskStore, registerActiveTask, reviveRetainedTask, transitionState } from "../../dist/shared/task-state.js";
import {
  agentKey,
  agentOccupancy,
  applyAgentOverlay,
  checkAgentCapacity,
  installLiveAgentCaps,
  liveAgentCaps,
  readAgentOverlayCaps,
  resetLiveAgentCaps,
  resolveAgentCaps,
  retiredLaneOverlayPath,
  retiredOverlayPresent,
} from "../../dist/shared/caps.js";
import { assert, beforeEach, describe, it } from "./support/runner.js";
import { bothCaps, defaultConfig, tempProject } from "./support/fixtures.js";
import { normalizeDynamicTaskConfig } from "../../dist/shared/config.js";
import { overlayChannel } from "./support/overlay-channel.js";
import { overlayKey } from "../../dist/shared/overlay-store.js";
import { resolveAdmission } from "../../dist/shared/admission.js";
import { toAgentRecords } from "../../dist/shared/agent-record.js";
import { writeFileSync } from "node:fs";

//jscpd:ignore-end
/**
 * A project whose caps live in the HOST'S TABLE, the way they do now, and the wiring
 * boot does: the document is read through the store and applied over the config. A case
 * cannot pass by seeding policy somewhere the plugin never reads it from.
 */
async function projectWith(overlay) {
  const dir = tempProject();
  if (overlay !== undefined) await channel(dir).seed(overlay);
  return dir;
}

const channel = (dir) => overlayChannel(dir, defaultConfig);

/**
 * A document the channel would refuse to write, put in the table anyway.
 *
 * The refusal belongs to the payload reader, so the only way to hold a document the
 * reader rejected is to write the host's table underneath it — which is exactly the
 * situation a later hand-edited or corrupted row describes.
 */
async function storedButRefused(text) {
  const dir = tempProject();
  channel(dir).kv.set(overlayKey(dir), text);
  return live(dir);
}

/**
 * Boot's composition, minus the logging: read the store ONCE and install the answer.
 *
 * Resolved before installing, because that is what `state.ts:97` does — the policy the
 * dispatch path reads is a value, not a reader that would have to be a host call on a
 * path that cannot express one.
 */
async function live(dir) {
  const stored = await channel(dir).read();
  installLiveAgentCaps(applyAgentOverlay(defaultConfig, stored.caps));
}

/** A registration for one agent, so a case can say which budget it is spending. */
function registration(childSessionId, agent = "general") {
  return { agentName: agent, childSessionId, description: "d", lineage: [], parentSessionId: "p" };
}

/**
 * A store holding the named tasks, all charged to one agent.
 *
 * Named because four cases below want the same four lines and the difference between
 * them is the CLAIM, not the arrangement: what the gate reads, what the count folds,
 * and what the view shows are three answers about one store, and spelling the store
 * out at each of them is how the three drift into testing three different stores.
 */
/**
 * A cap wide enough that a fixture never refuses a registration it was not asked
 * to. Named once, because the claim it protects is "the gate did not refuse" and a
 * per-test copy of this number is a literal free to drift toward a value that
 * makes the gate refuse — the fixture would then test the refusal while the case
 * above it claims the registration.
 */
const WIDE = normalizeDynamicTaskConfig({ maxConcurrent: 9 });

function storeRunning(agent, ...ids) {
  const store = createTaskStore();
  for (const id of ids) registerActiveTask(store, registration(id, agent), WIDE);
  return store;
}

describe("agent overlay: what the store holds", () => {
  beforeEach(resetLiveAgentCaps);

  it("is keyed by the directory the host reports, never the process CWD", () => {
    const one = tempProject();
    const two = tempProject();
    assert.notEqual(overlayKey(one), overlayKey(two), "two projects are two documents");
    assert.equal(overlayKey(one), overlayKey(one), "one project is one document");
  });

  it("an absent document is not a problem — it is the normal case", async () => {
    assert.deepStrictEqual(await channel(tempProject()).read(), { caps: null, present: false, problem: null });
  });

  it("reports WHY a stored document was unusable rather than failing silently", async () => {
    assert.strictEqual(applyAgentOverlay(defaultConfig, [1, 2]), null, "an array is not an overlay");
    assert.strictEqual(applyAgentOverlay(defaultConfig, { agents: 7 }), null, "`agents` must be an object");
    // Written into the table directly, because the refusal has to happen BELOW the
    // payload reader: a document the table holds that no longer parses is the case, and
    // only the table can produce one.
    const dir = tempProject();
    channel(dir).kv.set(overlayKey(dir), "{ truncated");
    const read = await channel(dir).read();
    assert.equal(read.caps, null, "an unreadable document states no caps");
    assert.ok(read.problem, "and it SAYS so, rather than reading as a project with no caps");
  });

  it("an overlay that names no cap is the same as no overlay", () => {
    assert.strictEqual(applyAgentOverlay(defaultConfig, {}), null);
    assert.strictEqual(applyAgentOverlay(defaultConfig, { agents: {} }), null);
  });

  it("a RETIRED lane file is reported, never read", async () => {
    // The file this feature replaced. Reporting rather than reading is the point:
    // its keys were operator-invented lane names, and a map from lane to agent is
    // exactly what was deleted, so any mapping would be a guess the plugin cannot
    // justify. Silence would leave an operator whose cap worked yesterday watching it
    // not apply, with no way to tell that from a mis-set number.
    const dir = await projectWith(undefined);
    assert.strictEqual(retiredOverlayPresent(dir), false, "a project that never had lanes is clean");
    writeFileSync(retiredLaneOverlayPath(dir), JSON.stringify({ lanes: { build: bothCaps(3, 2) } }));
    assert.strictEqual(retiredOverlayPresent(dir), true, "the leftover is detectable");
    // And it changes nothing: the live policy is the base config, untouched.
    await live(dir);
    assert.strictEqual(liveAgentCaps(defaultConfig), defaultConfig, "a retired file is not policy");
  });
});

describe("agent overlay: what a cap has to be", () => {
  // The refusals that matter are the ones that would otherwise LOOK like a
  // working plugin: a zero refuses every dispatch, a negative never refuses.
  const rejected = [0, -1, 1.5, Number.NaN, "8", true, null];

  for (const value of rejected) {
    it(`drops ${JSON.stringify(value)} rather than acting on it`, () => {
      assert.strictEqual(applyAgentOverlay(defaultConfig, { maxConcurrent: value }), null, "an unusable cap must not become policy");
    });
  }

  it("accepts a whole positive number", () => {
    const source = applyAgentOverlay(defaultConfig, { maxConcurrent: 7 });
    assert.strictEqual(source?.maxConcurrent, 7);
  });

  it("an agent body with no usable knob does not become an agent", () => {
    // Under lanes an empty body was the only spelling of "a name of its own on the
    // shared budget". With caps keyed by agent, an agent is already counted on its
    // own by the occupancy view without being asked to be — so there is nothing left
    // for the entry to say, and `knownCappedAgents` must not report a cap that does
    // not exist.
    const source = applyAgentOverlay(defaultConfig, { agents: { explore: {} } });
    assert.deepStrictEqual(source, null, "an empty body constrains nothing and says nothing");
  });

  it("REPORTS the knobs it had to throw away, so a reader can name them", () => {
    // The reader is the only place that knows. A dialog that cannot say what it
    // ignored shows a cap the dispatch path will not honour as though it applied.
    const { dropped } = readAgentOverlayCaps({ agents: { explore: { maxConcurrent: 0, maxDepth: 2 } } });
    assert.deepStrictEqual(dropped, { explore: ["maxConcurrent"] });
  });

  it("an agent the overlay does not mention keeps the config file's numbers", () => {
    const base = normalizeDynamicTaskConfig({}, { agents: { build: bothCaps(3, 2) } });
    const source = applyAgentOverlay(base, { agents: { explore: { maxConcurrent: 9 } } });
    assert.strictEqual(source?.agents.build.maxConcurrent, 3, "an overlay is an edit, not a replacement");
    assert.strictEqual(source?.agents.explore.maxConcurrent, 9);
  });

  it("an overlay that sets only one knob leaves the other at the config's value", () => {
    const source = applyAgentOverlay(defaultConfig, { maxConcurrent: 5 });
    assert.strictEqual(source?.maxConcurrent, 5);
    assert.strictEqual(source?.maxDepth, defaultConfig.maxDepth);
  });
});

describe("the key space", () => {
  it("folds case and whitespace on BOTH the read and the write", () => {
    // The bug this pins: a host names an agent `Explore` and the operator writes the
    // cap under `explore`. Folding only the write means the cap applies to no agent
    // at all, with no error and no refusal — just an agent running uncapped under a
    // cap they can see in the file.
    const base = normalizeDynamicTaskConfig({}, { agents: { " explore ": bothCaps(2, 1) } });
    const resolved = resolveAgentCaps(base, "Explore");
    assert.strictEqual(resolved.maxConcurrent, 2, "a host's spelling must find a folded key");
    assert.strictEqual(agentKey("  EXPLORE "), "explore");
  });

  it("a count keyed by the host's spelling is folded too", () => {
    // The direction of error that never announces itself: an unfound name counts
    // zero, so a busy agent reads as idle and its cap looks unspent.
    const store = storeRunning("Explore", "ses_a");
    assert.strictEqual(activeByAgent(store).get("explore"), 1);
    assert.strictEqual(activeByAgent(store).get("Explore"), undefined, "one key, not two spellings");
  });

  it("folds the POLICY KEY, not the record — the pair, because either half alone proves nothing", () => {
    // The record is what routing and every read tool display, so a folded name
    // there is a name the host never gave us: sent back to the host on a revive,
    // and shown to the operator as the agent they did not configure. The fold
    // belongs to the policy key.
    //
    // Asserted as a PAIR because each half can pass for the wrong reason. The
    // spelling alone would pass against a cap lookup that had quietly stopped
    // folding — the record reads right and every agent runs uncapped. The cap
    // alone would pass against the fold simply being left where it was, which is
    // the bug. What makes it a claim about WHERE the fold lives is that both
    // hold at once.
    const config = normalizeDynamicTaskConfig({ maxConcurrent: 4 }, { agents: { explore: { maxConcurrent: 1 } } });
    const store = createTaskStore();
    const record = registerActiveTask(store, registration("ses_a", "Explore"), config);

    assert.strictEqual(record.agentName, "Explore", "the record is the host's own spelling");
    assert.throws(
      () => registerActiveTask(store, registration("ses_b", "Explore"), config),
      /cannot run more than 1 active task/,
      "and the cap written under a folded key still finds the unfolded record",
    );
  });

  it("a registration that names no agent is still a record the durable reader accepts", () => {
    // The type requires the field and every JavaScript caller is free to omit it.
    // An omitted name used to be folded to itself, which left `undefined` on the
    // record — and `isValidLedgerEntry` requires a string, so the whole entry was
    // DROPPED at load: a child the store was tracking, invisible to the next boot,
    // with the ledger reporting a count of records that "failed validation" for a
    // reason no operator could act on. The boundary is where the field becomes the
    // string the reader requires, because four consumers downstream rely on it.
    const store = createTaskStore();
    const record = registerActiveTask(store, { childSessionId: "ses_a", description: "d", lineage: [], parentSessionId: "p" });
    assert.strictEqual(typeof record.agentName, "string", "the field the durable validator checks is present");
  });
});

describe("the capacity judgment", () => {
  const policy = { agent: "explore", maxConcurrent: 2, maxDepth: 1 };
  /** The refusal for one store reading, or null. The judgment, as the gate calls it. */
  const refusalFor = (agentActive, totalActive, ceiling) => checkAgentCapacity({ agentActive, totalActive }, policy, ceiling);

  it("an idle agent is admitted, and the refusal never mentions a lane", () => {
    assert.strictEqual(checkAgentCapacity({ agentActive: 0, totalActive: 0 }, policy, 8), null);
  });

  it("an agent at its own cap is refused by name, with its own number", () => {
    const refusal = refusalFor(2, 2, 8);
    assert.match(refusal, /agent "explore" cannot run more than 2 active tasks/);
    assert.doesNotMatch(refusal, /lane/i, "the vocabulary is the operator's, and lanes are gone");
  });

  it("a full cross-agent ceiling is a DIFFERENT refusal, naming the ceiling", () => {
    // The knob that fixes it is not the one the per-agent message would name, so
    // conflating them sends the operator to edit a cap that was never the constraint.
    const refusal = refusalFor(0, 8, 8);
    assert.match(refusal, /total ceiling of 8 active tasks is reached across all agents/);
    assert.match(refusal, /agent "explore"/, "it still says whose dispatch was blocked");
  });

  it("per-agent caps partition concurrency, they never multiply it", () => {
    // Eight agents at four cannot spend more than four.
    assert.match(refusalFor(0, 4, 4), /total ceiling/);
  });

  it("a cap of one reads as one task, not one tasks", () => {
    assert.match(
      checkAgentCapacity({ agentActive: 1, totalActive: 1 }, { agent: "explore", maxConcurrent: 1, maxDepth: 1 }, 8),
      /cannot run more than 1 active task of its own \(current: 1\)/,
    );
  });
});

describe("the occupancy view", () => {
  it("one row per REGISTERED agent, capped or not", () => {
    // A view listing only the capped agents cannot answer "how many of `explore` may
    // run" for an agent nobody has capped yet, and an operator asked to create an
    // entry to read a number is doing bookkeeping to get information.
    const base = normalizeDynamicTaskConfig({ maxConcurrent: 4, maxDepth: 2 }, { agents: { explore: { maxConcurrent: 1 } } });
    const rows = agentOccupancy(base, ["explore", "general", "review"], new Map(), false);
    assert.deepStrictEqual(rows.map((row) => row.agent), ["explore", "general", "review"]);
  });

  it("carries the STATED caps beside the resolved ones", () => {
    // The two answers an operator cannot otherwise tell apart: an agent at 4 because
    // the config says so, and one deliberately set to 4.
    const base = normalizeDynamicTaskConfig({ maxConcurrent: 4 }, { agents: { general: { maxConcurrent: 4 } } });
    const rows = agentOccupancy(base, ["explore", "general"], new Map(), false);
    assert.deepStrictEqual(rows[0].stated, {}, "nothing stated for explore");
    assert.deepStrictEqual(rows[1].stated, { maxConcurrent: 4 }, "general stated its own");
    assert.strictEqual(rows[0].maxConcurrent, 4, "and both resolve to the same number");
  });

  it("a failed read of the agent set is an UNKNOWN depth, never zero", () => {
    // Reporting 0 reads as "this agent cannot delegate at all" — a claim about the
    // project that the plugin has no way to support when it simply could not ask.
    const base = normalizeDynamicTaskConfig({ maxDepth: 4 }, { agents: { explore: { maxDepth: 1 } } });
    const [row] = agentOccupancy(base, null, new Map(), false);
    assert.strictEqual(row.depthEffective, null);
    assert.strictEqual(row.depthBoundBy, null);
    assert.strictEqual(row.depthConfigured, 1, "the cap is still known — only its reach is not");
  });

  it("falls back to the capped agents when the set is unreadable, rather than to nothing", () => {
    const base = normalizeDynamicTaskConfig({}, { agents: { explore: { maxConcurrent: 1 } } });
    assert.deepStrictEqual(agentOccupancy(base, null, new Map(), false).map((row) => row.agent), ["explore"]);
  });

  it("counts the running set into the rows", () => {
    const store = storeRunning("explore", "ses_a", "ses_b");
    registerActiveTask(store, registration("ses_c", "general"), WIDE);
    const rows = agentOccupancy(WIDE, ["explore", "general"], activeByAgent(store), false);
    assert.deepStrictEqual(rows.map((row) => [row.agent, row.active]), [["explore", 2], ["general", 1]]);
  });
});

describe("agent overlay: a cap takes effect without a restart", () => {
  beforeEach(resetLiveAgentCaps);

  /**
   * The two starting states below, named.
   *
   * They were one helper plus ad-hoc setup, which left both cases opening with the
   * same three lines and the duplication gate right to call it: the states are not
   * the same, and saying so is also what makes each case's claim legible at its
   * first line. A store full at the boot cap is what a RAISED cap has to unblock; a
   * settled task beside a holder is what a REVIVAL has to wait on.
   */
  const oneSlot = () => {
    const store = createTaskStore();
    return { cap: normalizeDynamicTaskConfig({ maxConcurrent: 1 }), store };
  };

  /** The one-slot store with `id` already occupying it. */
  const slotHeldBy = (id) => {
    const { store, cap } = oneSlot();
    registerActiveTask(store, registration(id), cap);
    return { cap, store };
  };

  /** A store whose single boot slot is already taken. */
  const fullAtBootCap = (id) => slotHeldBy(id);

  /** A store holding a settled task and a live holder, so the one slot is full. */
  const withASettledTask = () => {
    const { store, cap } = oneSlot();
    // Settled FIRST, so the single boot slot is free for the holder: the store
    // reaches one active task the same way a real fleet does.
    registerActiveTask(store, registration("ses_settled"), cap);
    transitionState(store, "ses_settled", TaskState.Completed);
    registerActiveTask(store, registration("ses_holder"), cap);
    return { cap, store };
  };

  it("with no overlay installed, policy is the frozen config, by identity", () => {
    assert.strictEqual(liveAgentCaps(defaultConfig), defaultConfig);
  });

  it("a raised cap admits a dispatch the boot cap refused", async () => {
    // Both directions matter and only one of them is safe by accident: a cap that
    // is RAISED looks like it worked if the boot cap simply had room. So the boot
    // cap here is one, the slot is taken, and the overlay is the only thing that
    // can let the third task in.
    const { store, cap: bootCap } = fullAtBootCap("ses_a");
    assert.throws(() => registerActiveTask(store, registration("ses_refused"), bootCap),
      /cannot run more than 1 active task/, "the boot cap refuses this before the overlay exists");

    await live(await projectWith({ agents: { general: { maxConcurrent: 5 } } }));
    registerActiveTask(store, registration("ses_c"), bootCap);
    assert.ok(store.activeTasks.has("ses_c"), "a raised cap is a raised cap");
  });

  it("a PER-AGENT cap refuses only that agent, and the refusal names it", async () => {
    // The whole point of keying by agent: a cap on `explore` must not spend `general`'s
    // budget, which is what a single shared pool made impossible to express.
    const store = createTaskStore();
    await live(await projectWith({ agents: { explore: { maxConcurrent: 1 } } }));
    registerActiveTask(store, registration("ses_a", "explore"), defaultConfig);
    assert.throws(
      () => registerActiveTask(store, registration("ses_b", "explore"), defaultConfig),
      /agent "explore" cannot run more than 1 active task/,
    );
    registerActiveTask(store, registration("ses_c", "general"), defaultConfig);
    assert.ok(store.activeTasks.has("ses_c"), "another agent's cap is not this one's ceiling");
  });

  it("depth is judged against the DISPATCHING agent's cap, live", async () => {
    // The per-agent depth cap is a PLACEMENT limit, and the reason it is only
    // meaningful is that it is scoped: read against a global number, every row would
    // claim to apply to every row and the screen would be a lie in six places.
    // `maxDepth: 1` counts TOTAL generations, so it admits a direct child and refuses
    // a grandchild — which is the whole meaning of a per-agent depth as a placement
    // limit: `explore` may be sent work, and may not be sent work that itself has work.
    await live(await projectWith({ agents: { explore: { maxDepth: 1 } } }));
    assert.strictEqual(resolveAdmission(toAgentRecords([{ name: "explore" }]), "explore", [], defaultConfig).ok, true,
      "a depth of 1 admits a direct child");
    const refusal = resolveAdmission(toAgentRecords([{ name: "explore" }]), "explore", ["general"], defaultConfig);
    assert.strictEqual(refusal.ok, false, "and refuses it one generation down, which is the placement work");
    assert.match(refusal.reason.refusal, /for agent "explore"/, "the refusal names the agent, not a lane");
    // The cap is the AGENT's, so the same dispatch of a different agent is unaffected.
    assert.strictEqual(resolveAdmission(toAgentRecords([{ name: "explore" }, { name: "general" }]), "general", ["explore"], defaultConfig).ok, true,
      "a depth cap on one agent does not spend another's");
  });

  it("a revived task re-claims against the LIVE cap, not the one frozen at boot", async () => {
    // The inconsistency this pins: a revival is a claim on a slot, and judging it
    // against the boot cap means raising a cap in the UI does nothing for the one
    // action an operator reaches for when a fleet is full.
    const { store, cap: bootCap } = withASettledTask();
    assert.throws(() => reviveRetainedTask(store, "ses_settled", bootCap), /cannot run more than 1 active task/,
      "the boot cap is what refuses this before the overlay exists");

    await live(await projectWith({ agents: { general: { maxConcurrent: 4 } } }));
    const revived = reviveRetainedTask(store, "ses_settled", bootCap);
    assert.strictEqual(revived.childSessionId, "ses_settled", "the live cap freed the slot the boot cap held shut");
  });

  // One claim, two ways the stored document can be unusable. A policy that cannot be
  // read must not become a dispatch refusal: the boot config answers, and the work
  // proceeds under caps the operator can see in their own config file.
  for (const [name, breakIt] of [
    ["a document that is not valid JSON", () => storedButRefused("{ truncated")],
    ["a document that is not an overlay at all", () => storedButRefused("[1, 2]")],
  ]) {
    it(`${String(name)} degrades to the boot config rather than refusing work`, async () => {
      await breakIt();
      assert.strictEqual(liveAgentCaps(defaultConfig), defaultConfig, "the boot config is the answer");
      const store = createTaskStore();
      registerActiveTask(store, registration("ses_a"), defaultConfig);
      assert.ok(store.activeTasks.has("ses_a"), "work proceeds under the config's own caps");
    });
  }
});
