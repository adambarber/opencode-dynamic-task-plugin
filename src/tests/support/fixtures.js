import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * The fixtures every module's suite needs: a config, and a registration literal.
 *
 * Both used to be re-derived per test file, which is how a change to the defaults
 * became a nine-file edit and how one suite ended up admitting a case for the
 * wrong reason — a case that copied the wrong config was refused by a rule it was
 * not about. Named for the refusals they carry so a case says which one it means.
 */

import { normalizeDynamicTaskConfig } from "../../../dist/shared/config.js";

/**
 * The config a case means when it does not care: the machine's own defaults,
 * normalized once. Describing the need for something else is theirs to declare.
 */
export const defaultConfig = normalizeDynamicTaskConfig({});

/**
 * Admission refuses @general under this one, so every case that is about a
 * different rule needs it spelled out — two describes were each building it, and a
 * case that copied the wrong one would be refused for the wrong reason.
 */
export const blockingConfig = () => normalizeDynamicTaskConfig({ blockedAgents: ["general"] });

/** A config that permits exactly one running child — the concurrency gate, in one option. */
export const singleSlotConfig = () => normalizeDynamicTaskConfig({ maxConcurrent: 1 });

/**
 * A lane body declaring both caps, which is the shape most lane fixtures want.
 *
 * It was spelled open in sixteen places across four files, which is a hand-kept
 * mirror of `LaneConfig` that could drift from it silently — and the duplicate gate
 * correctly reported two of the copies as the same code. One name for the shape is
 * the whole of the fix: the caps themselves are named by `config.ts`, and this says
 * only which two a fixture happens to set.
 */
export const bothCaps = (maxConcurrent, maxDepth) => ({ maxConcurrent, maxDepth });

/**
 * The registration literal — the input every task-state and admission test builds
 * — has five fields and only the child id usually matters. This names the shape
 * once, so a test states its intent ("a second agent") instead of a field list
 * whose defaults could drift from the production param type.
 */
export const childParams = ({ id, parent = "parent_1", agent = "explore", description = "test", lineage = [] } = {}) =>
  ({ childSessionId: id, parentSessionId: parent, agentName: agent, description, lineage });

/**
 * A fresh directory under the OS temp dir, for a case that needs a real path.
 *
 * One helper because the idiom is four imports and a join: every suite that
 * needed it spelled the sequence out, and the duplication gate correctly reported
 * the shared import block as a clone twice over. A suite that needs a project
 * directory says `tempProject()`; a suite that needs a bare temp dir says
 * `tempDir()`.
 */
export const tempDir = (prefix = "dynamic-task-") => mkdtempSync(join(tmpdir(), prefix));

/**
 * `tempDir`, with the removal attached.
 *
 * The creation and the cleanup are one decision, and splitting them across two
 * `it` bodies is how a failing assertion leaves a directory behind for the next
 * case to trip over — a leak that shows up as an unrelated failure much later.
 *
 * Async, always, rather than in a sync and an async twin: almost every caller
 * awaits something inside, and a sync variant would only be right for the cases
 * that do not, which is not a distinction worth encoding twice.
 */
export const withTempDir = async (work, prefix = "dynamic-task-") => {
  const directory = tempDir(prefix);
  try {
    return await work(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

/** A temp dir standing in for a project directory, which is what the host supplies. */
export const tempProject = (prefix = "lane-project-") => tempDir(prefix);
