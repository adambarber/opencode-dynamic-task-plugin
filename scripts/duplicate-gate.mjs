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
 * WHAT IS SAFE, measured rather than argued: jscpd's own match contains no
 * comments and no line breaks, so it sits contiguously in this stream and the run
 * measured here is at least as long. Every clone jscpd reports at or above the
 * bar therefore reproduces here — the gate cannot be made to miss one by
 * changing the filter policy, because the policy only decides what it catches
 * EXTRA. And the policy lives in `measure.mjs`, not here, so
 * `gate-invariants.test.js` can ask this script's real question without starting
 * a process scan — which is the whole reason it can now pin anything at all.
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
import { longestSharedRun, readMinTokens, stream } from "./measure.mjs";

const REPO = new URL("..", import.meta.url).pathname;
const SCAN = "src";

const minTokens = readMinTokens(join(REPO, ".jscpd.json"));

// One policy, and it is not this file's: `stream` and `longestSharedRun` come
// from measure.mjs, which is also what the test suite measures with. There is
// deliberately no filter line below — a second `.filter` here is a second
// measurement, and the pin that forbids one exists because the two decisions
// this file used to own privately are how it was wrong twice.
const streams = new Map();
const tokensIn = (repoPath, from, to) => {
  if (!streams.has(repoPath)) streams.set(repoPath, stream(readFileSync(join(REPO, "src", repoPath), "utf8")));
  return streams.get(repoPath).filter((t) => t.line >= from && t.line <= to).map((t) => t.key);
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
  let a, b;
  try {
    a = tokensIn(first.name, first.start, first.end);
    b = tokensIn(second.name, second.start, second.end);
  } catch {
    return null;
  }
  if (a.length === 0 || b.length === 0) return null;
  return longestSharedRun(a, b) >= minTokens;
};

const out = mkdtempSync(join(tmpdir(), "dt-jscpd-"));
let report;
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
  rmSync(out, { recursive: true, force: true });
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
  `Found ${verified.length} clones` +
  (discarded ? ` (${discarded} of ${findings.length} reported ranges did not reproduce and were discarded)` : "") +
  ".",
);

if (unchecked.length > 0) {
  console.error("a reported clone could not be re-read; failing rather than dismissing it");
}
process.exit(verified.length > 0 ? 1 : 0);
