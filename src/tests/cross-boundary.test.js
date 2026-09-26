/**
 * The gate jscpd structurally cannot be, and the import filter it measures with.
 *
 * Its own subject, its own file. These cases sat in the shared invariant scanner
 * until the 1000-line gate caught that file for holding something that is not
 * production source text — a scanner for a scanner. The boundary that already
 * existed was the subject, not the line count.
 */

import { describe, it, assert } from "./support/runner.js";
import { readFileSync } from "node:fs";
import { FLOOR_LINES, FLOOR_TOKENS, corpus, findCrossBoundaryClones, importLines, shortPath, withProbeCorpus } from "../../scripts/cross-boundary.mjs";

/**
 * The gate jscpd structurally cannot be: duplication ACROSS the test/production
 * boundary. jscpd pools tokens per format, so a `.js` test is never compared to the
 * `.ts` it tests — measured, not assumed, in scripts/cross-boundary.mjs. That is
 * the class that bit twice in this tree, and it is why the rule above exists as a
 * separate scanner rather than as a lower jscpd threshold.
 *
 * In-process and no spawn, for the reason the earlier jscpd-spawning attempt did not
 * survive: a test that shells out is slow, exits on a signal, and reports a number
 * instead of a finding. This imports the same module the CLI prints from, so the
 * number a human reads and the number this fails on cannot come from two
 * implementations.
 */
describe("invariant: no duplication across the test/production boundary (Tenet 12)", () => {
  it("a test and the production it tests share no run at or above the measured floor", () => {
    // "Zero findings" is only a result if there was something to find, so the
    // corpus is proved non-empty first. A renamed directory or a tokenizer that
    // started returning nothing would otherwise turn this gate green by removing
    // its own subject, which is the failure mode a passing assertion invites.
    const { tests, production, tokens } = corpus();
    assert.ok(tests > 0 && production > 0, `the corpus is empty — ${tests} test files, ${production} production files`);
    assert.ok(tokens > 10_000, `only ${tokens} comparable tokens found — the tokenizer is not reading the tree`);

    const findings = findCrossBoundaryClones();
    const sites = findings.map(
      (f) => `  - ${f.tokens}T / ${f.lines}L  ${shortPath(f.test)}:${f.lineA}  ↔  ${shortPath(f.prod)}:${f.lineB}`,
    );
    assert.deepStrictEqual(sites, [], `a test shares code with production above ${FLOOR_TOKENS} tokens / ${FLOOR_LINES} lines:\n${sites.join("\n")}`);
  });

  // A floor is only meaningful if the detector can still see. This pins the
  // detection, not the cleanliness: two files on opposite sides of the boundary
  // holding the same body must be reported, whatever the floor is. The probe lives
  // in a temp directory and is passed in as the corpus, so the tree is never
  // touched and the detector's own default corpus is never what is being tested.
  // A template literal, not an array of strings joined: the detector erases
  // string CONTENTS, so an array of strings tokenizes as bare punctuation and
  // this probe matched a production array literal on bracket structure alone —
  // twelve tokens of shape with nothing in common. A probe that trips the gate
  // on its own scaffolding teaches the gate to be ignored. The corpus is built
  // by the detector itself, which owns the question of what a test file and a
  // production file are.
  it("the detector still reports a shared body across the boundary", () => {
    const body = `export const probe = (record) => {
  const a = record.childSessionId;
  const b = record.parentSessionId;
  return a.length > b.length ? a : b;
};`;
    const findings = withProbeCorpus(body, (probe) => findCrossBoundaryClones(probe));
    assert.ok(findings.length > 0, "identical bodies on opposite sides of the boundary must be reported");
  });
});

// The import filter the measurement rests on. It had an off-by-one that walked
// forward from offset 0 instead of from the match, so every line ABOVE an import
// was discarded as if it were one — which is every module's header docblock, 246
// tokens across src/. FLOOR_TOKENS above was calibrated against a stream that had
// already thrown away real text, so the floor was measuring the wrong thing.
describe("the cross-boundary import filter", () => {
  /**
   * The one claim both cases make: given these source lines, the filter claims
   * exactly these of them.
   *
   * Written out per case they were the same assertion over the same array-shaped
   * fixture in two layouts, and the fixture was the only thing they had in common —
   * so `[...importLines(source)].sort(...)` became duplicated text rather than a
   * decision stated twice. The numbered comments stay at the call site on purpose:
   * every case here asserts on LINE NUMBERS, so the source has to stay readable
   * against the numbers it is asserting.
   */
  const claimsOnly = (expected, why, ...lines) =>
    assert.deepStrictEqual([...importLines(lines.join("\n"))].sort((x, y) => x - y), expected, why);

  it("claims the import's own lines and nothing before them", () => {
    claimsOnly([5], "an import is one line of names; the four lines above it are not",
      "/**",                          // 1
      " * The header a reader needs.",  // 2
      " */",                          // 3
      "",                             // 4
      'import { a } from "./a.js";',   // 5
      "",                             // 6
      "export const x = 1;",          // 7
    );
  });

  it("claims every line of an import that wraps", () => {
    claimsOnly([1, 2, 3, 4], "a wrapped import is four lines, not one",
      "import {",             // 1
      "  a,",                 // 2
      "  b,",                 // 3
      '} from "./a.js";',      // 4
      "export const x = 1;",  // 5
    );
  });

  it("leaves a real module's header in the comparison", () => {
    const lines = importLines(readFileSync(new URL("support/mock-host.js", import.meta.url), "utf8"));
    assert.ok(!lines.has(1), "line 1 of a real module is a header, not an import");
  });
});
