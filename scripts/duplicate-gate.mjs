/**
 * The duplicate-code gate: jscpd, with every finding re-taken before it fails
 * the build.
 *
 * jscpd 4.2.6 misreports. Measured, not assumed: on a suite of 15 test files it
 * reported five findings of which one was real; the other four paired ONE real
 * range against four ranges whose bytes have nothing to do with it. A report that
 * says "tests/foo.test.js:343-346 duplicates tests/bar.test.js:340-342" while
 * those two spans hold different sentences is not a weak finding, it is a wrong
 * one — and a gate that fails the build on it trains everyone to reach for
 * `--config` overrides, which is how a duplication gate stops meaning anything.
 *
 * So this gate re-measures. For each reported pair it re-reads BOTH ranges with
 * jscpd's OWN tokenizer (the same devDependency, pinned to the version jscpd
 * itself resolves, so the semantics are the gate's semantics rather than a
 * lookalike) and compares the token streams. Equal streams means a real clone and
 * the build fails. Different streams means jscpd paired the wrong coordinates and
 * the finding is discarded.
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

/** The lines an import declaration occupies — see cross-boundary.mjs for why. */
const importLines = (source) => {
  const lines = new Set();
  const pattern = /import[\s\S]{0,400}?from\s*["'][^"']*["']|import\s*["'][^"']*["']/g;
  for (const match of source.matchAll(pattern)) {
    const end = match.index + match[0].length;
    for (let line = 1, at = 0; at < end; line++, at = source.indexOf("\n", at) + 1) lines.add(line);
  }
  return lines;
};

/** Every significant token in the file, tagged with the line it starts on. */
const stream = (path) => {
  const source = readFileSync(path, "utf8");
  const imports = importLines(source);
  return tokenize(source, "typescript")
    .filter((t) => t.type !== "empty" && t.type !== "new_line" && !imports.has(t.loc.start.line))
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
 */
const reproduces = (first, second, tokens) => {
  let a, b;
  try {
    a = tokensIn(first.name, first.start, first.end);
    b = tokensIn(second.name, second.start, second.end);
  } catch {
    return null;
  }
  if (a.length === 0 || b.length === 0) return null;
  return longestSharedRun(a, b) >= tokens;
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
const checked = findings.map((d) => ({ d, ok: reproduces(d.firstFile, d.secondFile, d.tokens) }));
const verified = checked.filter(({ ok }) => ok !== false);
const unchecked = checked.filter(({ ok }) => ok === null);

for (const { d, ok } of checked) {
  if (ok === false) continue;
  const { firstFile: a, secondFile: b, lines, tokens } = d;
  console.error(
    `clone: ${a.name}:${a.start}-${a.end} duplicates ${b.name}:${b.start}-${b.end} (${lines} lines, ${tokens} tokens)`,
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
