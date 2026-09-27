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
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT, listSourceFiles, lineCount } from "./support/corpus.js";
import { readMinTokens, sharedRunBetween } from "../../scripts/measure.mjs";

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
  // what this gate's own header used to claim. What is true, and what the gate
  // actually rests on, is containment — jscpd's match holds no comments and no
  // line breaks, so it sits contiguously in this stream and a run measured here is
  // at least as long. That is why a real clone cannot be discarded, and it is
  // checked here as a property rather than asserted as a reason.
  it("measures at least as long a run as jscpd reported for the same code", () => {
    // A block jscpd reports as 28 tokens: five identical code lines. The gate's
    // stream adds line breaks, which jscpd does not count, so the gate's own
    // count is higher — the two numbers are not compared anywhere in the gate, so
    // the gap between them is information, not a disagreement.
    const fiveLines = `function one(alpha: number) {
  const out = [];
  out.push(alpha);
  return out.length;
}`;
    const gate_ = sharedRunBetween(fiveLines, fiveLines);
    assert.ok(gate_ > 28,
      `the gate measures ${gate_} shared tokens for a block jscpd reports as 28, so the stream no\n` +
        "longer contains the line breaks jscpd's does not — which is fine and must not change,\n" +
        "because the gate judges against minTokens and never against jscpd's count. If this\n" +
        "starts failing, the finding is that the two are being compared somewhere.");
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

  it(`keeps every source and gate script within ${MAX_LINES} lines`, () => {
    const files = listSourceFiles();
    assert.ok(files.length > 0, "the corpus resolved to nothing — a stale path");
    const over = files
      .map((f) => ({ file: path.relative(REPO_ROOT, f), lines: lineCount(readFileSync(f, "utf8")) }))
      .filter(({ lines }) => lines > MAX_LINES)
      .sort((a, b) => b.lines - a.lines)
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

