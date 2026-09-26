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
 *   1. The stream dropped `new_line`. jscpd counts line breaks in a clone's token
 *      total, so every shared run came out shorter than the count it was compared
 *      against. Nine findings were discarded; five were real, including
 *      `LedgerChangeKind.Settled` and `.Forgotten` in session-lifecycle.ts, whose
 *      three-line bodies are byte-identical. The gate printed "Found 0 clones" and
 *      exited 0 over them.
 *
 *   2. The stream KEPT `comment`. A doc comment is prose about the code, and prose
 *      worded differently between two declarations is evidence they were written
 *      independently — not evidence the declarations differ. Keeping comments
 *      breaks a shared run at the first reworded sentence, which hid the same
 *      defect again: `lane-occupancy.ts` and `task-formatting.ts` declare the same
 *      three fields with the same names, types and nullability, one a
 *      hand-maintained mirror of the other's interface, and the gate measured 8
 *      shared tokens there because the doc comments were not worded identically.
 *
 * A verification step that discards findings because it measured them differently
 * from the thing it verifies is not a verification step. So the two decisions are
 * written down where they are made — see `stream` below — and `gate-invariants.test.js`
 * pins both by name, along with the threshold and the comparison's shape. A
 * re-treading of either is a failing test rather than a silent narrowing.
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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { tokenize } = require("@jscpd/tokenizer");

const REPO = new URL("..", import.meta.url).pathname;
const SCAN = "src";

/**
 * The bar a shared run has to clear, read from the config rather than restated.
 *
 * Restating it is how the two numbers drift apart, and a drift here is silent in
 * the one direction that matters: a threshold the gate holds itself to, never
 * compared against jscpd's own count, means the same code is judged by the same
 * number jscpd used to decide it was worth reporting.
 */
const minTokens = JSON.parse(readFileSync(join(REPO, ".jscpd.json"), "utf8")).minTokens;

/**
 * Every token of CODE jscpd counts, tagged with the line it starts on.
 *
 * Two classes are excluded, and each for its own stated reason.
 *
 * `new_line` is KEPT. jscpd counts line breaks in a clone's token total, so
 * dropping them does not make the comparison stricter, it makes it incomparable.
 *
 * `comment` is DROPPED. A doc comment is prose about the code, and prose worded
 * differently between two declarations is evidence they were written
 * independently — not evidence that the declarations differ. Keeping comments
 * breaks a shared run at the first reworded sentence, which is what hid the
 * lane-occupancy/task-formatting clone the second time this gate was wrong:
 * three fields with the same names, types and nullability, measured at 8 shared
 * tokens because the two doc comments were not worded identically, and it really
 * is 14. Excluding comments is the only change in this file that can make a run
 * LONGER, so it can only ever catch more, never fewer.
 */
const stream = (path) => {
  const source = readFileSync(path, "utf8");
  return tokenize(source, "typescript")
    .filter((t) => t.type !== "empty" && t.type !== "comment")
    .map((t) => ({
      key: t.type === "string" ? "string" : `${t.type}:${t.value}`,
      line: t.loc.start.line,
    }));
};

const streams = new Map();
const tokensIn = (repoPath, from, to) => {
  if (!streams.has(repoPath)) streams.set(repoPath, stream(join(REPO, "src", repoPath)));
  return streams.get(repoPath).filter((t) => t.line >= from && t.line <= to).map((t) => t.key);
};

/**
 * The longest run of tokens the two ranges share, contiguously.
 *
 * jscpd's reported `start`/`end` are the BOUNDING BOXES of a match, not its
 * extent: a 16-token match inside a 37-token, 4-line box reports the box. So
 * comparing the boxes would call a real clone a phantom, which is the failure
 * this gate exists to prevent. What has to reproduce is the claim — a shared
 * contiguous run at least as long as the one reported.
 */
const longestSharedRun = (a, b) => {
  let best = 0;
  let previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      row[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : 0;
      if (row[j] > best) best = row[j];
    }
    previous = row;
  }
  return best;
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
