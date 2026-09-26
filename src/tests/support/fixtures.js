import { mkdtempSync } from "node:fs";
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

/** A temp dir standing in for a project directory, which is what the host supplies. */
export const tempProject = (prefix = "lane-project-") => tempDir(prefix);
