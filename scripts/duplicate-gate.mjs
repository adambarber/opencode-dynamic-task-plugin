/**
 * The duplicate-code gate: jscpd, with every finding re-taken before it fails
 * the build.
 *
 * jscpd 4.2.6 misreports SOME findings, and this gate re-measures every one of
 * them. It is not, however, entitled to disagree with jscpd's arithmetic: what has
 * to reproduce is a shared run at least as long as the one jscpd REPORTED, and a
 * run cannot be compared across two different tokenizations.
 *
 * The first version of this gate filtered `new_line` out of its stream, on the
 * reasoning that a line break is not code. It is not — and jscpd COUNTS those
 * tokens, so the filter made every shared run shorter than the number it was being
 * compared against. Nine findings were discarded that way, every one of them real:
 * `LedgerChangeKind.Settled` and `.Forgotten` in session-lifecycle.ts have
 * byte-identical three-line bodies, and the gate printed "Found 0 clones" and
 * exited 0 over them. A verification step that discards findings because it
 * measured them differently from the thing it verifies is not a verification step.
 * So the stream is jscpd's stream: same tokenizer, same devDependency, same
 * accounting, and `new_line` kept because jscpd keeps it.
 *
 * The re-measurement still earns its keep — it is what distinguishes a real clone
 * from a pair of coordinates jscpd paired wrongly, and it is how a bounding box is
 * compared against a match inside it. But it is a check on jscpd's COORDINATES, not
 * a licence to re-count its tokens.
 *
 * This cannot make the gate weaker in the direction that matters. A real clone
 * still fails: the same tokens at the reported coordinates are the definition of
 * the clone, and anything the report cannot reproduce at its own coordinates is
 * not a claim about the code. A range that cannot be read is treated as REAL, so
 * an unreadable finding fails the build rather than passing it. The raw count is
 * always printed next to the verified count, so a report that is mostly phantoms
 * is visible rather than silently absorbed — the same judgement
 * `cross-boundary.mjs` makes about import lists, reached here by measurement
 * instead.
 *
 * `safety-invariants.test.js` pins the accounting: the stream must keep every token
 * type jscpd keeps, and the boundary case that proves it is a clone whose two
 * copies sit on DIFFERENT line counts. A filter that drops a token class looks
 * harmless on a clone that happens to keep its line structure aligned, and only
 * diverges once the code is edited — so the pin has to be a clone that fails under
 * the wrong filter, or it is not testing the thing it claims to.
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
 * Every token jscpd counts, tagged with the line it starts on.
 *
 * `new_line` is KEPT. jscpd counts line breaks in a clone's token total, so
 * dropping them here does not make the comparison stricter, it makes it
 * incomparable.
 */
const stream = (path) => {
  const source = readFileSync(path, "utf8");
  return tokenize(source, "typescript")
    .filter((t) => t.type !== "empty")
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
