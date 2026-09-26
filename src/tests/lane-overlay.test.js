/**
 * The lane overlay — the file that edits policy without a restart.
 *
 * Every case here is a claim about WHEN a cap takes effect, because that is the
 * whole feature: a frozen config is the thing being replaced. The cases are
 * written against the real store and the real admission gate rather than against
 * the overlay's own functions, because the failure this guards is a cap that the
 * overlay accepts and the gate ignores — which a unit test of the parser alone
 * would report green through.
 */

import { describe, it, beforeEach, assert } from "./support/runner.js";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  LANE_OVERLAY_FILE,
  applyLaneOverlay,
  installLiveLanes,
  laneOverlayPath,
  liveLanes,
  readLaneOverlay,
  resetLiveLanes,
} from "../../dist/shared/lane-overlay.js";
import { resolveAdmission } from "../../dist/shared/admission.js";
import { createTaskStore, registerActiveTask, reviveRetainedTask, transitionState } from "../../dist/shared/task-state.js";
import { normalizeDynamicTaskConfig } from "../../dist/shared/config.js";
import { defaultConfig, tempProject } from "./support/fixtures.js";

// A project directory with an overlay in it, and the wiring production's boot
// does — so a case cannot pass by reading policy from somewhere the plugin never
// reads it.
function projectWith(overlay) {
  const dir = tempProject();
  if (overlay !== undefined) {
    writeFileSync(path.join(dir, LANE_OVERLAY_FILE), typeof overlay === "string" ? overlay : JSON.stringify(overlay));
  }
  return dir;
}

/** What initPluginState installs, minus the logging: same composition, no client. */
function live(dir) {
  installLiveLanes(() => {
    const { raw, problem } = readLaneOverlay(dir);
    return { source: applyLaneOverlay(defaultConfig, raw).source, problem };
  });
}

function registration(childSessionId, lane) {
  return { childSessionId, parentSessionId: "p", agentName: "general", description: "d", lineage: [], lane };
}

describe("lane overlay: the file", () => {
  beforeEach(resetLiveLanes);

  it("lives beside the ledger, in the directory the host provides", () => {
    assert.strictEqual(laneOverlayPath("/repo"), path.join("/repo", LANE_OVERLAY_FILE));
  });

  it("an absent file is not a problem — it is the normal case", () => {
    assert.deepStrictEqual(readLaneOverlay(tempProject()), { raw: null, problem: null });
  });

  it("reports WHY a file was unusable rather than failing silently", () => {
    assert.match(readLaneOverlay(projectWith("{ not json")).problem, /not valid JSON/);
    const list = projectWith([1, 2]);
    assert.match(applyLaneOverlay(defaultConfig, readLaneOverlay(list).raw).problem, /not a JSON object/);
    const lanesNotObject = projectWith({ lanes: 7 });
    assert.match(applyLaneOverlay(defaultConfig, readLaneOverlay(lanesNotObject).raw).problem, /`lanes` is not an object/);
  });

  it("an overlay that names no cap is the same as no overlay", () => {
    const outcome = applyLaneOverlay(defaultConfig, {});
    assert.strictEqual(outcome.source, null);
    assert.match(outcome.problem, /names no cap/);
  });
});

describe("lane overlay: what a cap has to be", () => {
  // The refusals that matter are the ones that would otherwise LOOK like a
  // working plugin: a zero refuses every dispatch, a negative never refuses.
  const rejected = [0, -1, 1.5, Number.NaN, "8", true, null];

  for (const value of rejected) {
    it(`drops ${JSON.stringify(value)} rather than acting on it`, () => {
      const outcome = applyLaneOverlay(defaultConfig, { maxConcurrent: value });
      assert.strictEqual(outcome.source, null, "an unusable cap must not become policy");
    });
  }

  it("accepts a whole positive number", () => {
    const { source } = applyLaneOverlay(defaultConfig, { maxConcurrent: 7 });
    assert.strictEqual(source.maxConcurrent, 7);
  });

  it("a lane body with no knobs survives — that is the spelling of 'same budget, separately accounted'", () => {
    const { source } = applyLaneOverlay(defaultConfig, { lanes: { explore: {} } });
    assert.deepStrictEqual(Object.keys(source.lanes), ["explore"]);
    assert.strictEqual(source.lanes.explore.maxConcurrent, undefined, "no cap of its own is the claim");
  });

  it("a lane the overlay does not mention keeps the config file's numbers", () => {
    const base = normalizeDynamicTaskConfig({}, { lanes: { build: { maxConcurrent: 3, maxDepth: 2 } } });
    const { source } = applyLaneOverlay(base, { lanes: { explore: { maxConcurrent: 9 } } });
    assert.strictEqual(source.lanes.build.maxConcurrent, 3, "an overlay is an edit, not a replacement");
    assert.strictEqual(source.lanes.explore.maxConcurrent, 9);
  });

  it("an overlay that sets only one knob leaves the other at the config's value", () => {
    const { source } = applyLaneOverlay(defaultConfig, { maxConcurrent: 5 });
    assert.strictEqual(source.maxConcurrent, 5);
    assert.strictEqual(source.maxDepth, defaultConfig.maxDepth);
  });
});

describe("lane overlay: a cap takes effect without a restart", () => {
  beforeEach(resetLiveLanes);

  it("with no overlay installed, policy is the frozen config, by identity", () => {
    assert.strictEqual(liveLanes(defaultConfig), defaultConfig);
  });

  it("a raised cap admits a dispatch the boot cap refused", () => {
    // Both directions matter and only one of them is safe by accident: a cap that
    // is RAISED looks like it worked if the boot cap simply had room. So the boot
    // cap here is one, the slot is taken, and the overlay is the only thing that
    // can let the third task in.
    const store = createTaskStore();
    const bootCap = normalizeDynamicTaskConfig({ maxConcurrent: 1 });
    registerActiveTask(store, registration("ses_a"), bootCap);
    assert.throws(() => registerActiveTask(store, registration("ses_refused"), bootCap),
      /cannot run more than 1 active task/, "the boot cap refuses this before the overlay exists");

    live(projectWith({ maxConcurrent: 5 }));
    registerActiveTask(store, registration("ses_c"), bootCap);
    assert.ok(store.activeTasks.has("ses_c"), "a raised cap is a raised cap");
  });

  it("a LOWERED cap refuses the next dispatch, and the refusal names the lane's own cap", () => {
    const store = createTaskStore();
    live(projectWith({ lanes: { build: { maxConcurrent: 1 } } }));
    registerActiveTask(store, registration("ses_a", "build"), defaultConfig);
    assert.throws(
      () => registerActiveTask(store, registration("ses_b", "build"), defaultConfig),
      /lane "build" cannot run more than 1 active task/,
    );
  });

  it("a lane created in the overlay is admissible by name on the very next dispatch", () => {
    // The refusal here is the feature's worst outcome if it regresses: a lane the
    // operator just made, refused by name, with the remedy "declare it in the
    // config" — advice that is already stale.
    live(projectWith({ lanes: { explore: { maxConcurrent: 2 } } }));
    const admitted = resolveAdmission([{ name: "explore" }], "explore", [], defaultConfig, "explore");
    assert.strictEqual(admitted.ok, true);
  });

  it("a revived task re-claims against the LIVE cap, not the one frozen at boot", () => {
    // The inconsistency this pins: a revival is a claim on a slot, and judging it
    // against the boot cap means raising a cap in the UI does nothing for the one
    // action an operator reaches for when a fleet is full.
    const store = createTaskStore();
    const bootCap = normalizeDynamicTaskConfig({ maxConcurrent: 1 });
    // Settled FIRST, so the single boot slot is free for the holder: the store
    // reaches one active task the same way a real fleet does.
    registerActiveTask(store, registration("ses_settled"), bootCap);
    transitionState(store, "ses_settled", "completed");
    registerActiveTask(store, registration("ses_holder"), bootCap);
    assert.throws(() => reviveRetainedTask(store, "ses_settled", bootCap), /cannot run more than 1 active task/,
      "the boot cap is what refuses this before the overlay exists");

    live(projectWith({ maxConcurrent: 4 }));
    const revived = reviveRetainedTask(store, "ses_settled", bootCap);
    assert.strictEqual(revived.childSessionId, "ses_settled", "the live cap freed the slot the boot cap held shut");
  });

  // One claim, two ways to break the reader. A policy source that cannot be read
  // must not become a dispatch refusal: the boot config answers, and the work
  // proceeds under caps the operator can see in their own config file.
  for (const [name, breakIt] of [
    ["an overlay that is not valid JSON", () => live(projectWith("{ truncated"))],
    ["a reader that throws", () => installLiveLanes(() => { throw new Error("the overlay reader is broken"); })],
  ]) {
    it(`${name} degrades to the boot config rather than refusing work`, () => {
      breakIt();
      assert.strictEqual(liveLanes(defaultConfig), defaultConfig, "the boot config is the answer");
      const store = createTaskStore();
      registerActiveTask(store, registration("ses_a"), defaultConfig);
      assert.ok(store.activeTasks.has("ses_a"), "work proceeds under the config's own caps");
    });
  }
});
