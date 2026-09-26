/**
 * Duplication ACROSS the test/production boundary, which jscpd cannot see.
 *
 * jscpd pools tokens per format: two `.js` files are compared, two `.ts` files
 * are compared, and a `.js` file is never compared to a `.ts` file. In this repo
 * that means the gate has never once compared a test to the code it tests —
 * measured, not assumed: over 786 clones spanning the whole threshold grid,
 * zero had mixed extensions, and a hand-built probe of one `.js` and one `.ts`
 * file with identical bodies reports 0 clones while the same pair within a
 * single format reports 1. So the class that bites hardest — a test that
 * re-derives a production shape instead of importing it — is exactly the class
 * the gate is blind to. A re-derived predicate still passes when production
 * changes its mind, because the test is asserting about the copy.
 *
 * This closes that gap using jscpd's OWN tokenizer, so the semantics are the
 * gate's semantics rather than a lookalike implementation. Both sides are
 * tokenized as `typescript` (which parses JavaScript too), because a comparable
 * stream is the whole point: the TS type annotations in production act as a
 * filter, so this reports FEWER cross-boundary clones than the shapes deserve,
 * never more.
 *
 * Usage: node scripts/cross-boundary-clones.mjs [minTokens] [minLines]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { homedir } from "node:os";

const REPO = new URL("..", import.meta.url).pathname;
const SRC = join(REPO, "src");
const MIN_TOKENS = Number(process.argv[2] ?? 20);
const MIN_LINES = Number(process.argv[3] ?? 3);

const require = createRequire(import.meta.url);

/** jscpd is npx-invoked, not installed, so its tokenizer has to be found. A gate
 * that depends on this needs @jscpd/tokenizer as a declared devDependency. */
const loadTokenizer = () => {
  try {
    return require("@jscpd/tokenizer");
  } catch {
    const root = join(homedir(), ".npm", "_npx");
    let found = null;
    const walk = (dir) => {
      if (found) return;
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry);
        if (entry === "tokenizer" && dir.endsWith("@jscpd")) {
          found = path;
          return;
        }
        try {
          if (statSync(path).isDirectory()) walk(path);
        } catch {
          /* unreadable entry */
        }
      }
    };
    walk(root);
    if (!found) throw new Error("@jscpd/tokenizer not found — install it or run npx jscpd once");
    return require(found);
  }
};

const { tokenize } = loadTokenizer();

/** Every source file under `src`, tagged by which side of the boundary it is on. */
const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith(".ts") || path.endsWith(".js") ? [path] : [];
  });

/**
 * The comparable stream: significant tokens only, with string CONTENTS erased.
 * Erasing the contents is the point — a test that copies production's format
 * strings verbatim matches even when the format later changes, which is the
 * drift this is looking for.
 */
const stream = (path) => {
  const tokens = tokenize(readFileSync(path, "utf8"), "typescript");
  return tokens
    .filter((t) => t.type !== "empty" && t.type !== "new_line")
    .map((t) => ({
      key: t.type === "string" ? "string" : `${t.type}:${t.value}`,
      line: t.loc.start.line,
    }));
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
        runs.push({ startA, startB, tokens: n, lines: lines.size, lineA: a[startA].line, lineB: b[startB].line });
      }
    }
  }
  return runs;
};

const files = walk(SRC);
const tests = files.filter((f) => f.includes(`${join("src", "tests")}`));
const production = files.filter((f) => !f.includes(`${join("src", "tests")}`));

const streams = new Map(files.map((f) => [f, stream(f)]));
const findings = [];

for (const test of tests) {
  for (const prod of production) {
    for (const run of sharedRuns(streams.get(test), streams.get(prod), MIN_TOKENS)) {
      if (run.tokens >= MIN_TOKENS && run.lines >= MIN_LINES) {
        findings.push({ test, prod, ...run });
      }
    }
  }
}

findings.sort((x, y) => y.tokens - x.tokens || y.lines - x.lines);

const short = (p) => relative(REPO, p);
console.log(
  `cross-boundary: ${findings.length} shared runs of >=${MIN_TOKENS} tokens / >=${MIN_LINES} lines ` +
    `between ${tests.length} test files and ${production.length} production files\n`,
);

for (const f of findings.slice(0, 24)) {
  const src = readFileSync(f.test, "utf8").split("\n");
  console.log(`── ${f.tokens}T / ${f.lines}L   ${short(f.test)}:${f.lineA}  ↔  ${short(f.prod)}:${f.lineB}`);
  for (const line of src.slice(f.lineA - 1, f.lineA - 1 + f.lines)) console.log(`     ${line}`);
  console.log();
}

if (findings.length > 24) console.log(`… ${findings.length - 24} more`);
