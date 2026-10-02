/**
 * The support surface, as one import.
 *
 * Every suite needs the runner, the harness, the mock host and the assertions;
 * spelling those four imports out in each file made the import block the most
 * duplicated region in the test tree — the duplication gate named eleven of them,
 * which is the gate working. This module is the single place that knows what the
 * support layer offers, so adding a helper makes it available without touching
 * twenty files, and a suite's import list stays short enough to read.
 */

export * from "./runner.js";
export * from "./assertions.js";
export * from "./harness.js";
export * from "./mock-host.js";
export * from "./integration.js";
export * from "./dispatch-wait-scenario.js";
export * from "./gate-world.js";
export * from "./stop-scenarios.js";
