/**
 * The duplicate-code gate: jscpd, with every finding re-taken before it fails the
 * build.
 *
 * WHAT IT DOES, in one line: jscpd says WHERE two regions match, and this measures
 * how much code they actually share, failing the build if the answer clears the
 * same bar jscpd used. The re-measurement exists because jscpd's reported ranges
 * are BOUNDING BOXES, and because it pairs some coordinates wrongly — but it is a
 * check on jscpd's COORDINATES, never a licence to re-count its tokens.
 *
 * The rule that makes that safe: ONE tokenizer, ONE threshold, on the coordinates
 * jscpd pointed at. A finding is judged by the longest run of shared tokens this
 * script measures, against `minTokens` READ FROM `.jscpd.json`. No two token counts
 * are ever compared, so no disagreement between two measurements can discard
 * anything.
 *
 * That rule was arrived at by getting it wrong twice, and both failures were the
 * same shape — a private arithmetic that quietly disagreed with jscpd's:
 *
 *   1. The stream dropped `new_line`, and nine findings were discarded, five of
 *      them real, including `LedgerChangeKind.Settled` and `.Forgotten` in
 *      session-lifecycle.ts, whose three-line bodies are byte-identical. The gate
 *      printed "Found 0 clones" and exited 0 over them. Note what the reason
 *      turned out NOT to be: this header used to say jscpd counts line breaks in
 *      a clone's token total, and it does not. Dropping a token from both sides
 *      shortens a shared run whenever that token sat inside the match, which is
 *      what actually happened — see `measure.mjs`, where the measurement and the
 *      real safety argument are both written down.
 *
 *   2. The stream KEPT `comment`, and it hid the same defect again:
 *      `lane-occupancy.ts` and `task-formatting.ts` declare the same three
 *      fields with the same names, types and nullability, one a
 *      hand-maintained mirror of the other's interface, measured at 8 shared
 *      tokens because the two doc comments were not worded identically. The
 *      declaration was the duplicate; only the prose about it differed.
 *
 * WHAT IS SAFE, measured rather than argued, and NOT by the argument this header
 * used to give. That argument was containment — jscpd's own match contains no
 * comments and no line breaks, so it sits contiguously in the stream and the run
 * measured here is at least as long as the one jscpd reported, and therefore
 * "the gate cannot be made to miss one by changing the filter policy, because
 * the policy only decides what it catches EXTRA". Every clause of that is wrong,
 * and the tree falsified it 11 times out of 11: every reported finding measures
 * 2 to 11 tokens BELOW the count jscpd reported for it. It is also
 * self-contradictory — the same header argues the reported ranges are bounding
 * boxes, and a run measured over two boxes that each contain an N-token match
 * cannot come out shorter than N. The pin that claimed to check this compared a
 * block to ITSELF, so it was green for any tokenizer whatsoever.
 *
 * What holds is arithmetic, and it is in `measure.mjs` because it is that
 * module's measurement. On a byte-identical pair this gate reads jscpd's count
 * plus one token per line, across 44 reported findings, and jscpd reports
 * nothing below 4 lines and 17 tokens on this config — so the smallest thing that
 * can reach this measurement reads 21 against a bar of 14. A seven-token margin
 * means a real clone is caught, and it also means a fixture that asserts one
 * cannot be made to fail: dropping `new_line` and shifting the range by a line
 * both leave such a fixture green, and both were tried. So the coarse property
 * is settled by the margin and the fine one is a pin: `gate-invariants.test.js`
 * asks the exact boundary question, in both directions and with no slack.
 * Agreement with jscpd's count is neither guaranteed nor wanted — the 11 findings
 * discarded here are near-matches whose reported count is looser than any
 * contiguous run, which is the discrimination the gate exists to make.
 *
 * Two properties make the gate safe in the direction that matters. A real clone
 * still fails: shared code at the reported coordinates is the definition of a clone.
 * And a finding that CANNOT be re-read is treated as real, so an unreadable report
 * fails the build rather than passing it. The raw count is always printed beside
 * the verified count, so a report that is mostly phantoms stays visible instead of
 * being silently absorbed.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { longestSharedRun, readMinTokens, stream, tokensInRange } from "./measure.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const SCAN = "src";

const minTokens = readMinTokens(join(REPO, ".jscpd.json"));

// One policy, and it is not this file's: `stream`, `tokensInRange` and
// `longestSharedRun` come from measure.mjs, which is also what the test suite
// measures with. There is deliberately no filter line below and no private
// reading of a reported range — a second measurement here is a second answer to
// the same question, and the pin that forbids one exists because the two
// decisions this file used to own privately are how it was wrong twice.
const streams = new Map();
const tokensIn = (repoPath, from, to) => {
  if (!streams.has(repoPath)) {
    const text = readFileSync(join(REPO, "src", repoPath), "utf8");
    streams.set(repoPath, stream(text));
  }
  return tokensInRange(streams.get(repoPath), from, to);
};

/**
 * Whether the reported clone is really in the code. `null` means the claim could
 * not be re-taken — an unreadable file or an empty range — and the caller treats
 * that as a clone, because a finding nobody can check is not a finding anyone may
 * dismiss.
 *
 * The bar is `minTokens` from the config, NOT the token count jscpd reported.
 * Comparing a run measured here against a count measured there asks two
 * tokenizers to agree about a number, and when they disagree the finding is
 * discarded — which is how a real clone in `cross-boundary.test.js` came to be
 * reported as 36 tokens and dismissed at 21. One tokenizer, one threshold, applied
 * to the coordinates jscpd pointed at: then a counting disagreement cannot discard
 * anything, because no two counts are being compared.
 */
const reproduces = (first, second) => {
  const read = () => [tokensIn(first.name, first.start, first.end), tokensIn(second.name, second.start, second.end)];
  let pair = null;
  try {
    pair = read();
  } catch {
    return null;
  }
  const [a, b] = pair;
  if (a.length === 0 || b.length === 0) return null;
  return longestSharedRun(a, b) >= minTokens;
};

// Import ordering makes unrelated files' blocks byte-alike, and that travel is
// not exempted any more. An import block that always arrives as a unit names an
// abstraction that has not been extracted yet — the barrel in src/tests/support
// is what this gate named into existence once already — so the clone is the
// finding and the home is the fix. No marker, no audit of markers: the escape
// hatch is gone, so there is nothing left to stretch over real logic.

const out = mkdtempSync(join(tmpdir(), "dt-jscpd-"));
let report = null;
try {
  const run = spawnSync(
    "npx",
    ["jscpd", SCAN, "--config", ".jscpd.json", "--reporters", "json", "--output", out],
    { cwd: REPO, encoding: "utf8" },
  );
  // jscpd exits non-zero whenever it reports anything, so its status is not the
  // verdict here — the re-measurement is.
  if (run.error) throw run.error;
  report = JSON.parse(readFileSync(join(out, "jscpd-report.json"), "utf8"));
} finally {
  rmSync(out, { force: true, recursive: true });
}

const findings = report.duplicates ?? [];
const checked = findings.map((d) => ({ d, ok: reproduces(d.firstFile, d.secondFile) }));
const verified = checked.filter(({ ok }) => ok !== false);
const unchecked = checked.filter(({ ok }) => ok === null);

for (const { d, ok } of checked) {
  if (ok === false) continue;
  const { firstFile: a, secondFile: b, lines, tokens } = d;
  console.error(
    `clone: ${a.name}:${a.start}-${a.end} duplicates ${b.name}:${b.start}-${b.end} (jscpd: ${lines} lines, ${tokens} tokens)`,
  );
}

const discarded = findings.length - verified.length;
console.log(
  `Found ${verified.length} clones${ 
  discarded ? ` (${discarded} of ${findings.length} reported ranges did not reproduce and were discarded)` : "" 
  }.`,
);

if (unchecked.length > 0) {
  console.error("a reported clone could not be re-read; failing rather than dismissing it");
}
process.exit(verified.length > 0 ? 1 : 0);
