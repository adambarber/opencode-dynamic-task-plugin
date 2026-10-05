/**
 * The duplicate-detection frontier, measured rather than guessed.
 *
 * jscpd reports a clone when its duplicated run satisfies BOTH floors, so the
 * count should fall monotonically as either floor rises. It does not, and this
 * script exists to find out why instead of assuming. For every (minLines,
 * minTokens) pair in the grid it records the exact clones reported, which makes
 * three things visible:
 *
 *   1. the count matrix, so the real frontier is a measurement not a story;
 *   2. any clone reported ABOVE its own token count — the anomaly that says the
 *      filter is not the AND we assume;
 *   3. the boundary partition: production↔production, test↔test, and
 *      production↔test. That last class is the one that matters most, because a
 *      test that hand-builds a production shape duplicates it in the only place
 *      where the copy can be edited without the compiler noticing.
 *
 * Usage: node scripts/clone-frontier.mjs [outDir]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const OUT = process.argv[2] ?? "/tmp/clone-frontier";

const LINE_FLOORS = [2, 3, 4, 5];
const TOKEN_FLOORS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22];

/** Is this path test-side? jscpd scans `src`, so the tests live inside it. */
const isTest = (name) => name.includes("/tests/");

/** A stable identity for a clone, independent of which floors surfaced it. */
const key = (c) =>
  [
    c.firstFile.name,
    c.firstFile.start,
    c.secondFile.name,
    c.secondFile.start,
  ].join(":");

const run = (minLines, minTokens) => {
  const dir = join(OUT, `${minLines}x${minTokens}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync("npx", ["--yes", "jscpd", "--min-lines", String(minLines), "--min-tokens", String(minTokens), "src", "--reporters", "json", "--output", dir], {
      cwd: REPO,
      stdio: "ignore",
    });
  } catch {
    // jscpd exits nonzero over threshold; the report is what we came for.
  }
  const path = join(dir, "jscpd-report.json");
  try {
    const report = JSON.parse(readFileSync(path, "utf8"));
    if (!report.duplicates?.length && !seen.size) console.error(`no report at ${path}`);
    return report.duplicates ?? [];
  } catch {
    console.error(`unreadable report: ${path}`);
    return [];
  }
};

const matrix = [];
const seen = new Map();
const anomalies = [];

for (const minLines of LINE_FLOORS) {
  const row = { minLines, cells: [] };
  for (const minTokens of TOKEN_FLOORS) {
    const clones = run(minLines, minTokens);
    row.cells.push({ minTokens, count: clones.length });
    for (const c of clones) {
      const k = key(c);
      if (!seen.has(k)) {
        seen.set(k, { ...c, at: [] });
        const classes = [isTest(c.firstFile.name) ? "test" : "prod", isTest(c.secondFile.name) ? "test" : "prod"];
        seen.get(k).boundary = classes[0] === classes[1] ? `${classes[0]}↔${classes[0]}` : "prod↔test";
      }
      seen.get(k).at.push(`${minLines}/${minTokens}`);
      // The anomaly: reported while the token floor sat above its own count.
      for (const floor of TOKEN_FLOORS) {
        if (floor > c.tokens && seen.get(k).at.includes(`${minLines}/${floor}`)) {
          anomalies.push({ clone: k, tokens: c.tokens, lines: c.lines, reportedAt: `${minLines}/${floor}` });
        }
      }
    }
  }
  matrix.push(row);
}

const all = [...seen.values()];
const byBoundary = (pred) => all.filter(pred);
const prodProd = byBoundary((c) => c.boundary === "prod↔prod");
const testTest = byBoundary((c) => c.boundary === "test↔test");
const cross = byBoundary((c) => c.boundary === "prod↔test");

console.log("=== count matrix (rows = minLines, cols = minTokens) ===");
console.log(["lines\\tok", ...TOKEN_FLOORS.map(String)].join("\t"));
for (const row of matrix) {
  console.log([String(row.minLines), ...row.cells.map((c) => (c.count === 0 ? "." : String(c.count)))].join("\t"));
}

console.log(`\n=== distinct clones seen anywhere in the grid: ${all.length} ===`);
const tally = { "prod↔prod": prodProd.length, "test↔test": testTest.length, "prod↔test": cross.length };
console.log("by boundary:", JSON.stringify(tally));

// What the 2/2 view is made of: the widest lens, grouped by file.
const byPair = new Map();
for (const c of all) {
  const k = `${c.firstFile.name} ↔ ${c.secondFile.name}`;
  byPair.set(k, (byPair.get(k) ?? 0) + 1);
}
console.log("\n=== file pairs (widest lens, 2/8) ===");
for (const [k, n] of [...byPair].toSorted((a, b) => b[1] - a[1])) console.log(`  ${n}\t${k}`);

if (anomalies.length) {
  console.log(`\n=== anomalies: ${anomalies.length} clone/floor reports above the clone's own token count ===`);
  for (const a of anomalies.slice(0, 20)) {
    console.log(`  ${a.clone} has ${a.tokens}T/${a.lines}L but appeared at ${a.reportedAt}`);
  }
}

if (cross.length) {
  console.log(`\n=== production↔test pairs: ${cross.length} — a test restating a production shape ===`);
  for (const c of cross.slice(0, 30)) {
    console.log(`\n--- ${c.firstFile.name}:${c.firstFile.start} ↔ ${c.secondFile.name}:${c.secondFile.start} (${c.lines}L ${c.tokens}T) first seen at ${c.at[0]}`);
    console.log(
      c.fragment
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  }
}

writeFileSync(join(OUT, "frontier.json"), JSON.stringify({ matrix, anomalies, clones: all }, null, 2));
console.log(`\nfull data → ${join(OUT, "frontier.json")}`);
