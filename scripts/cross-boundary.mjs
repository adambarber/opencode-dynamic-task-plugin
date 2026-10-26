/**
 * Duplication ACROSS the test/production boundary, which jscpd cannot see.
 *
 * jscpd pools tokens per format: two `.js` files are compared, two `.ts` files
 * are compared, and a `.js` file is never compared to a `.ts` file. In this repo
 * that means the gate has never once compared a test to the code it tests —
 * measured, not assumed: over 786 clones spanning the whole threshold grid, zero
 * had mixed extensions, and a hand-built probe of one `.js` and one `.ts` file with
 * identical bodies reports 0 clones while the same pair within a single format
 * reports 1. So the class that bites hardest — a test that re-derives a production
 * shape instead of importing it — is exactly the class the gate is blind to. A
 * re-derived predicate still passes when production changes its mind, because the
 * test is asserting about the copy. Two of those were live in this tree.
 *
 * This closes that gap using jscpd's OWN tokenizer, so the semantics are the gate's
 * semantics rather than a lookalike implementation. Both sides are tokenized as
 * `typescript` (which parses JavaScript too), because a comparable stream is the
 * whole point: the TS type annotations in production act as a filter, so this
 * reports FEWER cross-boundary clones than the shapes deserve, never more.
 *
 * Import statements are excluded, and that is a judgement worth stating rather than
 * a convenience. An import list is a list of NAMES, so two files importing the same
 * four names from the same module tokenize to an identical run no matter what else
 * they do — and there is nothing to factor: the alternative to importing a name is
 * not importing it. Measured, that exclusion is the whole of what remained at 14
 * tokens: every hit in this tree was an import list. What the detector is for — a
 * test that re-derives production's logic — is all still there behind the exclusion.
 *
 * The measured floor is FLOOR_TOKENS / FLOOR_LINES: 12 tokens over 3 lines is
 * clean, 10 is not, and the 10 is `try { return <call> } catch { return null }` —
 * the shortest two unrelated pieces of code can match, since the call inside is
 * each side's own. That is a structural idiom, not a shared decision, so the floor
 * sits above it. It is a measurement, not a preference, and the suite asserts it
 * rather than assuming it.
 *
 * The tokenizer is a declared devDependency, pinned to the version jscpd itself
 * resolves, so the gate's semantics are the gate's semantics. It used to be dug out
 * of the npx cache, which meant the detector worked only on a machine that had run
 * jscpd by hand and would have failed with a filesystem error rather than a finding.
 * If jscpd is ever upgraded past its 4.x tokenizer, this pin is what to revisit: the
 * floor is a measurement of THAT tokenizer and is not automatically still true of a
 * different one.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;
const SRC = join(REPO, "src");
const TESTS = join(SRC, "tests");

/** The measured floor, and the pair of constants that must be re-measured together. */
export const FLOOR_TOKENS = 12;
export const FLOOR_LINES = 3;

const require = createRequire(import.meta.url);
const { tokenize } = require("@jscpd/tokenizer");

/** Every source file under `src`, tagged by which side of the boundary it is on. */
const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith(".ts") || path.endsWith(".js") ? [path] : [];
  });

/**
 * The lines an import declaration occupies. An import is a list of names, so two
 * files importing the same names match on the import alone; that is a fact about
 * names, not about logic, and no refactor removes it.
 *
 * The line span is measured FROM THE MATCH, not from the top of the file. It used
 * to walk forward from offset 0 and collect every line above the import as well,
 * which meant each file's entire header docblock was thrown away as "imports" —
 * 246 tokens across src/, including the one describing the fake server. That
 * quietly shrank every per-file measurement, so the floor below was calibrated on
 * a stream that had already discarded real text.
 */
export const importLines = (source) => {
  const lines = new Set();
  const pattern = /import[\s\S]{0,400}?from\s*["'][^"']*["']|import\s*["'][^"']*["']/g;
  for (const match of source.matchAll(pattern)) {
    // slice(0, index).split("\n").length is the 1-based line the match starts on:
    // an empty prefix is line 1, and a match after n newlines is on line n+1.
    const first = source.slice(0, match.index).split("\n").length;
    const last = source.slice(0, match.index + match[0].length).split("\n").length;
    for (let line = first; line <= last; line++) lines.add(line);
  }
  return lines;
};

/**
 * The comparable stream: significant tokens only.
 *
 * A string token's key CARRIES ITS CONTENT — `string:"alpha"` and `string:"one"`
 * are different tokens, the same way `alpha` and `one` are different identifiers.
 * This used to collapse every literal to a bare `string`, on the argument that a
 * test copying production's format strings should keep matching after the format
 * changes. That argument was answering a question this detector does not have to
 * answer, and the cost of buying it was that unrelated code matched: two files
 * holding `["alpha","beta","gamma","delta"]` and `["one","two","three","four"]`
 * shared a 14-token, 6-line run, over a floor of 12 tokens and 3 lines, and were
 * reported as duplicated. The only thing those two files had in common was being
 * arrays of four strings. That is not duplication, and a gate that reports it is a
 * gate whose findings have to be re-argued one at a time.
 *
 * The `scripts/measure.mjs` policy is the OPPOSITE and deliberately so. There, a
 * string collapses to a bare `string`, because that stream CONFIRMS a match jscpd
 * has already reported: both sides hold the same literal, so the collapse cannot
 * break contiguity, and it costs nothing. Here, the stream has to DISCOVER a match
 * nobody has found yet, and the two sides may hold different literals — so content
 * is the only thing distinguishing "the same constant" from "the same shape". One
 * measures a known run, the other looks for an unknown one, and that is the whole
 * reason the two policies differ.
 */
const stream = (path) => {
  const source = readFileSync(path, "utf8");
  const imports = importLines(source);
  return tokenize(source, "typescript")
    .filter((t) => t.type !== "empty" && t.type !== "new_line" && !imports.has(t.loc.start.line))
    .map((t) => ({ key: `${t.type}:${t.value}`, line: t.loc.start.line }));
};

/** Maximal runs shared by two streams, found by window hash then extension. */
const sharedRuns = (a, b, window) => {
  const windowsOf = (s) => {
    const index = new Map();
    for (let i = 0; i + window <= s.length; i++) {
      const k = s.slice(i, i + window).map((t) => t.key).join(" ");
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(i);
    }
    return index;
  };
  const inA = windowsOf(a);
  const inB = windowsOf(b);
  const runs = [];
  const claimed = new Set();
  for (const [key, startsA] of inA) {
    const startsB = inB.get(key);
    if (!startsB) continue;
    for (const startA of startsA) {
      for (const startB of startsB) {
        const id = `${startA}:${startB}`;
        if (claimed.has(id)) continue;
        let n = window;
        while (startA + n < a.length && startB + n < b.length && a[startA + n].key === b[startB + n].key) n++;
        claimed.add(id);
        const lines = new Set();
        for (let k = startA; k < startA + n; k++) lines.add(a[k].line);
        runs.push({ lineA: a[startA].line, lineB: b[startB].line, lines: lines.size, startA, startB, tokens: n });
      }
    }
  }
  return runs;
};

const sourceFiles = walk(SRC);
const testFiles = sourceFiles.filter((f) => f.includes(TESTS));
const productionFiles = sourceFiles.filter((f) => !f.includes(TESTS));

/** Streams keyed by path and mtime, so a second query over an unchanged tree re-reads nothing. */
const streamCache = new Map();

const cachedStream = (path) => {
  const {mtimeMs} = statSync(path);
  const hit = streamCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.tokens;
  const tokens = stream(path);
  streamCache.set(path, { mtimeMs, tokens });
  return tokens;
};

/**
 * Every run of >= minTokens tokens spanning >= minLines lines that a test file and a
 * production file share, longest first. This is the query; the CLI and the suite both
 * call it, so the number a human reads and the number the gate fails on cannot come
 * from two implementations.
 *
 * The corpora are arguments rather than a module-level walk for one reason: a gate
 * that enumerates its corpus at import time cannot be pointed at a corpus of its own,
 * which is what would make it untestable. With them as inputs the detection is
 * PROVABLE — two files on opposite sides holding the same body must be reported —
 * and that is the one property of a duplicate detector which is not the absence of
 * findings.
 */
export function findCrossBoundaryClones({
  minTokens = FLOOR_TOKENS,
  minLines = FLOOR_LINES,
  tests = testFiles,
  production = productionFiles,
} = {}) {
  const findings = [];
  for (const test of tests) {
    for (const prod of production) {
      for (const run of sharedRuns(cachedStream(test), cachedStream(prod), minTokens)) {
        if (run.tokens >= minTokens && run.lines >= minLines) findings.push({ prod, test, ...run });
      }
    }
  }
  return findings.toSorted((x, y) => y.tokens - x.tokens || y.lines - x.lines);
}

export const corpus = () => ({
  production: productionFiles.length,
  tests: testFiles.length,
  /** Total comparable tokens, so a gate can prove it is not passing on an empty tree. */
  tokens: [...testFiles, ...productionFiles].reduce((sum, f) => sum + cachedStream(f).length, 0),
});
export const shortPath = (p) => relative(REPO, p);

/**
 * A two-file corpus for proving what the detector does and does not report. The
 * corpus shape is this module's own, so it is this module that builds one: a test
 * that assembles a probe out of mkdtempSync and a hand-written join re-declares
 * what a production file and a test file are, in the one place whose subject is
 * exactly that question.
 *
 * `testBody` defaults to `body`, which is the right default for the question this
 * was built for — can the detector still SEE a match? — because that needs two
 * identical files. Answering the other question, does it report a match that is not
 * there, needs two files that are genuinely different, and the one-argument form
 * silently cannot express that: it writes the same body twice and reports the
 * result, which looks like a passing answer to a question it never asked.
 */
export const withProbeCorpus = (body, fn, testBody = body) => {
  const dir = mkdtempSync(join(tmpdir(), "dt-cross-boundary-"));
  const prod = join(dir, "probe.ts");
  const test = join(dir, "probe.js");
  try {
    writeFileSync(prod, body);
    writeFileSync(test, testBody);
    return fn({ production: [prod], tests: [test] });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};
