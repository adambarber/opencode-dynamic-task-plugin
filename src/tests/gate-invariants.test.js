// The gates that watch the TREE rather than the code: how much duplication this
// repo tolerates, and how long a file may get.
//
// Their own suite because their subject is the corpus, not any one module's
// doctrine. Every other rule here answers "may this source say that?"; these two
// answer "how big is the tree allowed to get", which is a question about the set
// of files and not about any of them. They also share nothing with the text
// rules except the corpus walk, which is why that walk is the one thing imported
// from support/corpus.js rather than repeated.

import { describe, it, assert } from "./support/runner.js";
import { compareStrings } from "./support/assertions.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPO_ROOT, listSourceFiles, lineCount } from "./support/corpus.js";
import { longestSharedRun, readMinTokens, sharedRunBetween, stream, tokensInRange } from "../../scripts/measure.mjs";

// --- the duplicate-detection gate ------------------------------------------------
// The thresholds are not taste. 3 lines / 16 tokens is the strictest level this
// tree passes, and it passes because every clone it reported was ELIMINATED
// rather than tolerated: 43 at 3/20 when that level was adopted (7 in
// production, 36 in tests), 67 at 3/15 when that one was (16 production, 51
// tests), 10 more at 3/12, and 86 more at 2/20. Every one of them was a
// restated decision, and the three declarations of ChildRef, the two
// hand-written copies of a question's rejection classification, the four
// spellings of a retained record in the test suites, and 21 invariant rules
// that each re-typed which doctrine note they answer to were each one place to
// change a shape that had a single owner. The shape of the fixes is the point: a
// clone is eliminated by giving the repeated idea ONE home, never by rewording a
// line until the tokenizer stops matching. So the gate is pinned here: loosening
// it is a deliberate edit to a test that says what re-opens, not a quiet edit to
// a config file.
//
// 16 is the frontier, not a round number, and it is a TOKEN floor for a reason.
// Measured on this tree: 3/10 reports 142 hits, 3/12 reports 10, 3/15 reports 67
// at 2 lines... the climb is not monotone in either axis, because the two axes
// are measuring different things. The LINE axis is what caught real
// duplication: the 86 clones at 2/20 were arrangements of two lines that the
// 3-line floor was blind to, and among them were 26 sites each hand-rolling a
// query into the test harness's private recorded state
// (`filter((p) => p.to === id)`, `p.body.parts[0].text`, `aborted.includes(id)`)
// — 26 places to keep in step with one body shape, and a wrong predicate that
// still passes because the common assertion is "this did NOT happen". That is
// the level the gate exists to demand, and it is now behind named readers on
// the harness. Below 16 TOKENS the tokenizer matches expression SHAPE rather
// than a decision (`return out.timedOut ? X : Y`, a ternary over two record
// fields, two readers composed with the same named predicate), and eliminating
// those means inventing a helper per expression — the opposite of naming a
// decision once.
describe("invariant: the duplicate-detection gate stays where the tree passes", () => {
  const config = JSON.parse(readFileSync(path.join(REPO_ROOT, ".jscpd.json"), "utf8"));

  it("enforces zero tolerance at 3 lines / 14 tokens", () => {
    const loosened = [
      ["threshold", 0],
      ["minLines", 3],
      ["minTokens", 14],
    ].filter(([key, expected]) => config[key] !== expected);
    assert.deepStrictEqual(
      loosened.map(([key, expected]) => `${key} is ${config[key]}, not ${expected}`),
      [],
      `duplicate gate loosened. The history is one of eliminating clones, never of\n` +
        `moving the bar to hide them: 3/20 reported 43 real clones when it was adopted,\n` +
        `3/15 reported 67, 3/12 reported 10, and 2/20 reported 86 more arrangements\n` +
        `below the line floor — including 26 hand-rolled queries into the test\n` +
        `harness's recorded state, now behind named readers. 3/16 was the tree's clean\n` +
        `level at the time it was measured; 3/14 is the tree's clean level now, after\n` +
        `the record shapes were built by production instead of by hand. The number is\n` +
        `a MEASUREMENT, so it has to be re-measured and re-pinned when it stops holding\n` +
        `rather than left to drift: 3/13 is not clean, and the 13 it reports is two\n` +
        `type-predicate preambles — \`function isX(v: unknown): v is Y { if (!isEventRecord(v))\n` +
        `return false; }\` — a structural idiom whose remainder is each predicate's own\n` +
        `fields. Factoring that would mean inventing a generic type-guard combinator,\n` +
        `which is the helper-per-expression this rule exists to prevent.`,
    );
  });

  it("ignores build artifacts but keeps every test file in scope", () => {
    // dist/** is a build output and cannot be de-duplicated. An extension-wide
    // *.js ignore would be the tempting way to quiet test clones — and it would
    // silently un-check src/tests entirely, which is the regression this gate
    // exists to prevent.
    assert.ok(config.ignore.includes("dist/**"), "build artifacts stay out of the scan");
    const blind = config.ignore.filter((pattern) => pattern.replace(/^\*\*\//, "") === "*.js");
    assert.deepStrictEqual(
      blind,
      [],
      `a *.js ignore removes every test file from duplicate detection.\nGot: ${JSON.stringify(blind)}`,
    );
  });

  // The scan itself runs in the gate `npm test` performs, ahead of the suite —
  // see the test script. A threshold pinned here and never executed is a
  // comment; the script is what makes duplication a failing run.
});

// --- The gate's own measurement -------------------------------------------------
// A threshold pin says the bar. These say the gate is capable of SEEING the bar,
// which is a different and stronger claim. Two token classes have each been
// filtered wrongly, in opposite directions, and both times the gate's private
// arithmetic disagreed with jscpd's and silently discarded real clones:
//
//   1. `new_line` was dropped, on the reasoning that a line break is not code.
//      Nine findings were discarded that way, five of them real — including
//      `LedgerChangeKind.Settled` and `.Forgotten` in session-lifecycle.ts, whose
//      three-line bodies are byte-identical. It printed "Found 0 clones", exit 0.
//      The reasoning that justified dropping it was itself false: this comment
//      used to say jscpd counts line breaks in a clone's token total, and it does
//      not. What actually happened is duller — removing a token from both sides
//      shortens a shared run when that token sat inside the match.
//
//   2. `comment` was KEPT, on the reasoning that dropping anything jscpd counts
//      must be unsafe. But jscpd's own tokenizer emits comments as tokens too, so
//      a reworded doc comment breaks a shared run at the first sentence that
//      differs. `lane-occupancy.ts` and `task-formatting.ts` declared the same
//      three fields with the same names, types and nullability — one a
//      hand-maintained mirror of the other's interface, already drifted — and the
//      gate measured 8 shared tokens there, because the doc comments above them
//      were not worded identically. The declarations were duplicated; the prose
//      was not. That is what a clone is made of.
//
// The lesson is not a filter list. It is that the script re-measures, so it has a
describe("invariant: the duplicate gate measures what it claims to measure", () => {
  const gate = readFileSync(path.join(REPO_ROOT, "scripts", "duplicate-gate.mjs"), "utf8");
  const minTokens = readMinTokens(path.join(REPO_ROOT, ".jscpd.json"));

  // The same two declarations the second regression was found in, at the shape
  // they had: three fields, identical names, types and nullability, and doc
  // comments worded DIFFERENTLY above them — which is the whole point, since
  // differing prose is what broke the shared run the second time. Written as
  // TypeScript source rather than as an array of line fragments, because it IS
  // TypeScript source — and an array of string literals is a shape production has
  // plenty of (RETRYABLE_FRAGMENTS and friends in prompt.ts), which the
  // cross-boundary gate cannot tell from this fixture's content since it compares
  // the string token, not the string.
  const DECLARED_TWICE = `interface A {
  /** The depth cap as configured. */
  depthConfigured: number;
  /** \`null\` when the set could not be read — an unknown, not a zero. */
  depthEffective: number | null;
  /** Which constraint caps the depth. */
  depthBoundBy: Bound | null;
}`;
  const DECLARED_TWICE_AGAIN = `interface B {
  depthConfigured: number;
  /** \`null\` when the set could not be read. */
  depthEffective: number | null;
  depthBoundBy: Bound | null;
}`;

  // The regression, stated as the OUTCOME rather than as the arithmetic. The pin
  // used to re-implement the comparison here and pass the filter policy in as a
  // boolean, which made it a claim about its own fixture and not about the gate:
  // the policy the gate used was a separate assertion, matched by regex against
  // the script's source text, so a filter could change from `comment` to something
  // else and every pin here would stay green while the gate got quieter. Asking
  // `measure.mjs` is what makes this the gate's question — the gate has no filter
  // of its own to disagree with, and this module is imported by both.
  it("catches a declaration duplicated behind differently-worded doc comments", () => {
    const shared = sharedRunBetween(DECLARED_TWICE, DECLARED_TWICE_AGAIN);
    assert.ok(shared >= minTokens,
      `the lane-occupancy/task-formatting clone now measures ${shared} shared tokens, below the bar of\n` +
        `${minTokens}, so a reworded doc comment is breaking the run again and the gate can no\n` +
        "longer see a mirrored interface. Re-derive it before changing the stream policy — do\n" +
        "not relax it until it passes.");
  });

  // The regression in the other direction. Keeping comments is not a matter of
  // taste and the arithmetic above is not the argument: dropping a token from
  // both sides shortens a run whenever that token sat inside the match, so
  // "removing non-matching elements can only lengthen a run" is false and was
  // what this gate's own header used to claim.
  //
  // The pin below is the gate's real safety property, asked end to end: a clone
  // jscpd REPORTS must also be found by the gate's own measurement at the
  // coordinates jscpd gave for it. The one it replaced could not ask that
  // question, because it measured a block against ITSELF — the single case where
  // a range covers a maximal run, and the single case where the coordinate
  // mapping is invisible.
  //
  // It is also a COARSE net, and the slack is structural rather than accidental.
  // Measured on this config: jscpd will not report a clone smaller than 4 lines
  // and 17 tokens, and this stream adds a token per line on top, so anything
  // byte-identical that jscpd reports measures at least 21 against a bar of 14.
  // A seven-token margin means this test cannot be made to fail by narrowing the
  // stream — verified, not assumed: dropping `new_line` and shifting the range
  // by a line both leave it green. The fine net for the mapping is the case
  // below, which has no slack; this one earns its keep by being the only place
  // the real chain — jscpd's coordinates through the real policy — is walked at
  // all, and it is what would catch the coordinate mapping losing a match
  // outright rather than by a token.
  it("catches a byte-identical block at the coordinates jscpd actually reports", () => {
    // Real by construction, so the outcome is not a matter of taste about what
    // counts as a clone: the two files are the same bytes, which is the one
    // answer to that question nobody can argue with.
    const CLONE = `function gatePlantProbe(alpha, beta) {
  const rows = [alpha, beta].filter((value) => typeof value === "string" && value.length > 0);
  return rows.reduce((total, value) => total + value.length, 0) + rows.indexOf(beta);
}
`;
    const dir = mkdtempSync(path.join(tmpdir(), "dt-gate-pin-"));
    try {
      writeFileSync(path.join(dir, "plant_a.ts"), CLONE);
      writeFileSync(path.join(dir, "plant_b.ts"), CLONE);
      const out = path.join(dir, "report");
      // The repo's own config, because the coordinates jscpd reports are a
      // function of it — minLines and minTokens decide what is reported at all,
      // and a fixture scanned under different settings reports a different box.
      const run = spawnSync("npx", ["jscpd", dir, "--config", path.join(REPO_ROOT, ".jscpd.json"), "--reporters", "json", "--output", out], {
        encoding: "utf8",
      });
      // jscpd exits non-zero whenever it reports anything, so its status is not
      // the verdict — its coordinates are the input, and they are the thing that
      // must arrive.
      // Interpolated, not retyped: naming a fallback string here is how a test
      // ends up restating a production constant's VALUE, which the Tenet 12
      // scan rightly refuses and which would be a lie anyway — the error is the
      // only thing that should be in this message.
      assert.ok(!run.error, `jscpd could not be run, and a pin that skips its own subject is worse than no pin: ${run.error}`);
      const report = JSON.parse(readFileSync(path.join(out, "jscpd-report.json"), "utf8"));
      const found = report.duplicates ?? [];
      assert.ok(found.length > 0, "jscpd did not report a byte-identical pair, so there are no coordinates to ask the gate about");

      // The gate's own question, at the coordinates jscpd chose — which is the
      // whole claim, because a clone is only ever caught if the reported box
      // still contains it once the stream policy has had its say.
      const read = (file) => stream(readFileSync(path.join(dir, path.basename(file.name)), "utf8"));
      const missed = found
        .map((d) => ({
          at: `${d.firstFile.name}:${d.firstFile.start}-${d.firstFile.end} vs ${d.secondFile.name}:${d.secondFile.start}-${d.secondFile.end}`,
          shared: longestSharedRun(
            tokensInRange(read(d.firstFile), d.firstFile.start, d.firstFile.end),
            tokensInRange(read(d.secondFile), d.secondFile.start, d.secondFile.end),
          ),
        }))
        .filter(({ shared }) => shared < minTokens)
        .map(({ at, shared }) => `${at} measures ${shared}, below ${minTokens}`);

      assert.deepStrictEqual(
        missed,
        [],
        `a byte-identical block was reported by jscpd and then DISCARDED by the gate's own\n` +
          `measurement, at the coordinates jscpd gave for it. That is the gate silently\n` +
          `passing a real clone — the failure both regressions above were the same shape as,\n` +
          `and the reason this is measured end to end rather than on a fixture. Discarded:\n  - ${missed.join("\n  - ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The fine net, in both directions, with no slack in either.
  //
  // Safety here is not a matter of judgement about what a clone is, so the two
  // cases are chosen to be DECISIVE rather than near the bar. `MARK` is one
  // identifier: a mapping that reads the wrong lines, or a range that is
  // exclusive at either end, changes these answers and cannot leave them equal.
  // And a near-miss is discarded decisively, which is the direction a gate that
  // had stopped discriminating would fail — a gate that reported everything
  // would pass a "catches a clone" test forever.
  it("reads a reported range as exactly the lines it names", () => {
    const SOURCE = "const MARK = 1;\nconst OTHER = 2;\nconst THIRD = 3;\nconst FOURTH = 4;\n";
    // Keyed on the token's VALUE, not its type: the tokenizer calls a plain
    // const binding `constant` and an arrow binding `function-variable`, so a
    // test that named a type would be asserting a tokenizer implementation
    // detail and would go red on a jscpd upgrade for a reason that has nothing
    // to do with the gate. Each name occurs on exactly one line, which is what
    // makes a boundary error visible instead of merely different.
    const NAMES = ["MARK", "OTHER", "THIRD", "FOURTH"];
    const namesIn = (keys) =>
      keys
        .filter((k) => NAMES.some((name) => k.endsWith(`:${name}`)))
        .map((k) => k.slice(k.lastIndexOf(":") + 1))
        .join(",");

    assert.strictEqual(namesIn(tokensInRange(stream(SOURCE), 1, 1)), "MARK", "one line is that line and no other");
    assert.strictEqual(namesIn(tokensInRange(stream(SOURCE), 2, 3)), "OTHER,THIRD", "a closed range includes both ends");
    assert.strictEqual(namesIn(tokensInRange(stream(SOURCE), 3, 4)), "THIRD,FOURTH", "and the last line named is included");

    // The off-by-one a range is actually prone to, in both directions. A gate
    // that shifted its window by one would silently drop a match's leading
    // tokens, and the coarse case above has too much slack to notice.
    const all = namesIn(tokensInRange(stream(SOURCE), 1, 4));
    assert.strictEqual(all, "MARK,OTHER,THIRD,FOURTH", `the whole range, all four: got ${all}`);
    assert.notStrictEqual(namesIn(tokensInRange(stream(SOURCE), 2, 4)), all, "an exclusive start drops a name, and must be visible");
    assert.notStrictEqual(namesIn(tokensInRange(stream(SOURCE), 1, 3)), all, "an exclusive end drops a name, and must be visible");
  });

  it("discards a near-miss decisively rather than reporting everything", () => {
    // Two helpers of the same shape that share an opening and then diverge. This
    // is the class both recorded regressions actually hid, and the class the 11
    // real discards on this tree are: code that shares a prefix with itself.
    const NEAR_ONE = "const nearOne = (alpha, beta) => {\n  return alpha + beta;\n};\n";
    const NEAR_TWO = "const nearTwo = (alpha, gamma) => {\n  return alpha * gamma;\n};\n";
    const shared = sharedRunBetween(NEAR_ONE, NEAR_TWO);
    assert.ok(shared < minTokens,
      `the near-miss now measures ${shared} shared tokens, at or above the bar of ${minTokens}, so it is no\n` +
        "longer the discriminating fixture this case needs: a gate that reported everything would\n" +
        "pass it. Make the two helpers diverge sooner, or the assertion above has stopped proving\n" +
        "that the gate can still tell a clone from a coincidence.");
  });

  it("keeps its threshold in the config and its tokenizer policy in one module", () => {
    assert.ok(!/\bminTokens\s*=\s*\d/.test(gate),
      "the gate's threshold is a copy of .jscpd.json's minTokens, which is how the two\n" +
        "drift apart. Read it; a change to the bar is then one edit in one file.");
    assert.ok(!/\.filter\(\(?t\)?\s*=>\s*t\.type/.test(gate),
      "the gate filters its own token stream. A second filter is a second measurement, and\n" +
        "the two decisions this file used to own privately are exactly how it discarded real\n" +
        "clones twice. The policy is measure.mjs's, and the test above measures with it.");
  });

  it("judges a finding by the shared run it measures, not by the count jscpd reported", () => {
    assert.ok(
      !/longestSharedRun\([^)]*\)\s*>=\s*\w+\.tokens/.test(gate),
      "the gate compares its own token count against jscpd's, so a disagreement between\n" +
        "two tokenizers silently discards a finding. One tokenizer, one threshold.",
    );
  });
});

// --- The size the tree passes -------------------------------------------------
// Not a style preference, and the measurement is what makes it one. Every file
// that broke this line was long for the SAME reason — it had no subject:
//
//   2604  one unit-test file, 62 describes spread across every module in src/
//   2023  one integration file covering seven tools
//   1113  one harness holding both the fake host AND the driver that uses it
//
// All three were fixed by naming a boundary that already existed (the module, the
// tool, the client interface) — none by cutting anything. So length here is a
// SYMPTOM of a missing seam, and the remedy is always a split along a real
// boundary. A file that is merely long because it does one thing well is not
// something this rule can see, which is the honest limit of it: the number is a
// tripwire for "a newcomer cannot tell what this file is about", not a claim
// about complexity.
//
// The escape hatch, stated rather than implied: raise MAX_LINES here and the gate
// reads the new value, so the change is one line and shows up in the diff that
// makes it. Do it when a split would be dishonest — when there is genuinely no
// seam — and say so in the commit that raises it. Never to fit a file you have
// not finished splitting.
const MAX_LINES = 1000;

/**
 * Every file under src/, production and suite alike. The file-size rule is the
 * one invariant here that applies to both, because a grab-bag test file and a
 * grab-bag module fail the same way: neither has a subject a reader can hold.
 */
describe("invariant: no file outgrows the point where a reader stops finding things", () => {
  it("counts a file's lines, not its trailing newline", () => {
    const body = "a\nb\nc";
    assert.strictEqual(lineCount(body), 3, "no trailing newline");
    assert.strictEqual(lineCount(body + "\n"), 3, "a trailing newline is not a line");
    assert.strictEqual(lineCount(""), 0, "an empty file has no lines");
    assert.strictEqual(lineCount("\n"), 1, "a lone newline is one empty line");
    assert.strictEqual(lineCount(`\n${body}\n`), 4, "leading blank lines count");
  });

  it("keeps the cast rules denied so no assertion compiles back in", () => {
    // The rules are the enforcement: oxlint runs in `npm run lint`, and this
    // pin keeps the config from silently weakening underneath it.
    const config = JSON.parse(readFileSync(path.join(REPO_ROOT, ".oxlintrc.json"), "utf8"));
    for (const rule of [
      "typescript/no-explicit-any",
      "typescript/no-unsafe-type-assertion",
      "typescript/no-unnecessary-type-assertion",
      "typescript/no-non-null-assertion",
    ]) {
      assert.strictEqual(config.rules[rule], "deny", `${rule} must stay denied`);
    }
  });

  it("lints PRODUCTION at full strictness, and says which rules the tests waive", () => {
    // The whole point is production: the test tree is JavaScript and
    // untyped, so every type-aware rule about it is a guess. Those waivers are
    // listed here by name because an unlisted one is a silent hole, and this
    // pin fails the moment a new rule is waived to make something pass.
    const config = JSON.parse(readFileSync(path.join(REPO_ROOT, ".oxlintrc.json"), "utf8"));
    const production = config.rules;
    for (const rule of [
      "typescript/no-explicit-any",
      "typescript/no-unsafe-type-assertion",
      "typescript/no-unnecessary-type-assertion",
      "typescript/no-non-null-assertion",
    ]) {
      assert.strictEqual(production[rule], "deny", `${rule} must stay denied in production`);
    }
    // Nothing is waived for production beyond the two the code documents.
    const waivedInProduction = Object.entries(production)
      .filter(([, setting]) => setting === "off")
      .map(([rule]) => rule)
      .toSorted(compareStrings);
    assert.deepStrictEqual(waivedInProduction, ["no-await-in-loop", "typescript/no-meaningless-void-operator"]);

    const waived = Object.entries(config.overrides[0].rules)
      .filter(([, setting]) => setting === "off")
      .map(([rule]) => rule)
      .toSorted(compareStrings);
    assert.deepStrictEqual(waived, [
      "no-shadow",
      "no-unused-vars",
      "typescript/await-thenable",
      "typescript/no-base-to-string",
      "typescript/no-floating-promises",
      "typescript/no-unnecessary-type-conversion",
      "typescript/restrict-template-expressions",
      "typescript/no-unsafe-enum-comparison",
      "unicorn/no-array-reverse",
      "unicorn/no-array-sort",
      "unicorn/no-new-array",
      "unicorn/no-useless-fallback-in-spread",
      "unicorn/prefer-set-has",
      "unicorn/prefer-string-starts-ends-with",
      "unicorn/require-array-sort-compare",
    ]);
  });

  it("keeps exactly two documented exemptions in production, no more", () => {
    // Two rules fight deliberate repo doctrine, so they stay off BY NAME:
    // `no-await-in-loop` — host dials are sequential on purpose (ledger
    // ordering, claim-then-abort, serial retries, dialog turns); parallelizing
    // them would be a correctness bug, not a speedup. `void` is the
    // acknowledgment operator for `no-floating-promises`: removing it would
    // trade a marked intentional no-await for a silent floating promise. Any
    // third exemption is scope creep and fails here until it is justified.
    const config = JSON.parse(readFileSync(path.join(REPO_ROOT, ".oxlintrc.json"), "utf8"));
    assert.strictEqual(config.rules["no-await-in-loop"], "off", "serial host dials stay legal");
    assert.strictEqual(
      config.rules["typescript/no-meaningless-void-operator"],
      "off",
      "the void marker stays legal",
    );
    const off = Object.entries(config.rules)
      .filter(([, setting]) => setting === "off")
      .map(([rule]) => rule)
      .toSorted();
    assert.deepStrictEqual(off, ["no-await-in-loop", "typescript/no-meaningless-void-operator"]);
  });

  it(`keeps every source and gate script within ${MAX_LINES} lines`, () => {
    const files = listSourceFiles();
    assert.ok(files.length > 0, "the corpus resolved to nothing — a stale path");
    const over = files
      .map((f) => ({ file: path.relative(REPO_ROOT, f), lines: lineCount(readFileSync(f, "utf8")) }))
      .filter(({ lines }) => lines > MAX_LINES)
      .toSorted((a, b) => b.lines - a.lines)
      .map(({ file, lines }) => `${file} (${lines} lines)`);
    assert.deepStrictEqual(
      over,
      [],
      `files over ${MAX_LINES} lines. Length means the file has no subject: split it along the\n` +
      `boundary that already exists (the module, the tool, the interface it talks to) rather\n` +
      `than cutting content. Over:\n  - ${over.join("\n  - ")}`,
    );
  });
});

