/**
 * Record shapes are built, not re-declared (Tenet 12).
 *
 * Split out of safety-invariants.test.js because the record rule has its own subject —
 * what a test may not spell — while the rest of that file names primitives and their
 * funnels. Both are Tenet 12, both read production on disk, neither needed the other.
 */
import { recordShapeRestatements } from "./support/record-scan.js";
import { assert, describe, it } from "./support/runner.js";

describe("invariant: record shapes are built, not re-declared (Tenet 12)", () => {
  it("a test that spells out a whole record is rebuilding production's shape by hand", () => {
    const findings = recordShapeRestatements();
    assert.deepStrictEqual(findings, [], `a record shape restated by hand:\n${findings.join("\n")}`);
  });
});