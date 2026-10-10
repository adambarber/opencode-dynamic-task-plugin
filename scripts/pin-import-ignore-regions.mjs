#!/usr/bin/env node
//jscpd:ignore-start
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
//jscpd:ignore-end
/**
 * Mark every import declaration as outside the duplicate-code gate, and PROVE that
 * nothing else is.
 *
 * WHY THIS EXISTS. `eslint/sort-imports` demands one canonical order for every import
 * block in the tree, and that order MAXIMISES how alike two unrelated files' import
 * blocks look: two suites that both need `TaskState` will place that line in the same
 * position. jscpd then reports the two or three adjacent lines that happen to coincide
 * as a clone.
 *
 * Those findings are not duplication. There is no code being copied: each file is
 * DECLARING which modules it needs, and the declarations are genuinely different —
 * `caps.test.js` and `agent-editor.test.js` share two adjacent lines and disagree on
 * every other one. There is no funnel to build, because ESM has none that does not
 * cost a reviewer the provenance of every import in the tree.
 *
 * So the gate is told, in jscpd's own vocabulary, that import declarations are
 * intentional: `//jscpd:ignore-start` / `//jscpd:ignore-end`. Those markers were NOT
 * chosen over the config's `ignorePattern`, which reads better but is inert in
 * @jscpd/tokenizer 4.2.6 — `setupIgnorePatterns` registers its patterns AFTER the file
 * has already been tokenized (tokenizer/dist/index.js: `createTokenMapBasedOnCode`
 * calls `tokenize2` and only then `setupIgnorePatterns`), so nothing it registers can
 * affect the file it was meant to filter. The inline markers are checked into the text
 * and cannot be out of order.
 *
 * WHAT KEEPS THIS HONEST. Markers are the gate's only escape hatch, so the second half
 * of this file is the part that matters: `--check` fails if any file under `src/` has
 * an unmarked import, an unbalanced marker pair, or a marked region containing anything
 * other than import declarations. A marker cannot be stretched over real logic without
 * turning that check red, which is what makes the exemption safe to hold.
 *
 * Run with `--check` to verify, with no flag to apply.
 */
import { join, relative } from "node:path";

const START = "//jscpd:ignore-start";
const END = "//jscpd:ignore-end";
const ROOT = new URL("..", import.meta.url).pathname;

/** An import declaration, however it is wrapped. */
const IMPORT_DECLARATION = /^import\b/;

/**
 * How deep in unclosed braces a line ends.
 *
 * Braces inside comments and strings are stripped first: a doc comment that mentions
 * `{` would otherwise leave the count permanently raised, and every line after it
 * would read as a continuation of something.
 */
function braceDepth(line) {
  const code = line
    .replace(/\/\*.*?\*\//g, " ")
    .replace(/\/\/.*$/, " ")
    .replace(/<quote>[^<quote>]*<quote>/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
  let depth = 0;
  for (const character of code) {
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
  }
  return depth;
}

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...sourceFiles(full));
    else if (/\.(?:ts|js|mjs)$/.test(entry)) found.push(full);
  }
  return found;
}

/**
 * The line range covering this file's import declarations, as [start, end) indexes.
 *
 * One region, not one per import: a block broken up by comments is still one block,
 * and marking it in pieces would make the pin below harder to read than the thing it
 * pins. Null when the file declares no imports.
 */
function importRegion(lines) {
  let start = -1;
  let end = -1;
  let depth = 0;
  for (const [index, line] of lines.entries()) {
    // Only an `import` may OPEN a region. Depth alone may extend one, and never
    // start one: a module with no imports at all still has a function body, and
    // reading that as a region marked a file that declares nothing.
    const inside = start !== -1 && depth > 0;
    depth += braceDepth(line);
    const isImport = IMPORT_DECLARATION.test(line);
    if (isImport && start === -1) start = index;
    if (isImport || (start !== -1 && (inside || line.trim() === ""))) end = index + 1;
    else if (start !== -1) break;
  }
  return start === -1 ? null : [start, end];
}

/** Every marker line in the file, as `[index, isStart]` pairs, in source order. */
function markerLines(lines) {
  return lines.flatMap((line, index) => {
    if (line.trim() === START) return [[index, true]];
    return line.trim() === END ? [[index, false]] : [];
  });
}

/**
 * Every marked region in a file, as [start, end) line indexes.
 *
 * The pairs are read off as a strictly alternating sequence rather than tracked with
 * an open/close cursor, because "strictly alternating" is the whole property: one
 * unbalanced marker anywhere is then a single count, not a branch per line.
 */
function markedRegions(lines, where) {
  const markers = markerLines(lines);
  const odd = markers.filter(([, isStart], at) => isStart !== (at % 2 === 0));
  if (odd.length > 0) {
    throw new Error(`${where}: ${odd.length} unbalanced jscpd marker(s), first at line ${odd[0][0] + 1}`);
  }
  return markers.filter((_, at) => at % 2 === 0).map(([start], at) => [start, markers[at * 2 + 1][0]]);
}

/** The first line in `lines[start, end)` that is not part of an import, or -1. */
function regionIsOnlyImports(lines, start, end) {
  let depth = 0;
  let opened = false;
  for (let at = start; at < end; at += 1) {
    const line = lines[at];
    const inside = opened && depth > 0;
    depth += braceDepth(line);
    const isImport = IMPORT_DECLARATION.test(line);
    if (isImport) opened = true;
    else if (!opened || (!inside && line.trim() !== "")) return at;
  }
  return -1;
}

/**
 * One file's three problems, named: a region over something that is not an import,
 * more than one region, and a region that does not cover the imports.
 */
function checkMarks(where, lines, { marked, region }) {
  const found = [];
  if (marked.length > 1) found.push(`${where}: ${marked.length} marked regions; expected exactly one`);
  for (const [start, end] of marked) {
    // The marked body is everything between the markers. Every line of it must be
    // part of an import declaration — that is the whole claim this file makes.
    const offender = regionIsOnlyImports(lines, start + 1, end);
    if (offender !== -1) {
      found.push(`${where}: line ${offender + 1} inside a marked region is not an import — ${lines[offender].trim()}`);
    }
  }
  // The marked region must actually COVER the imports, or the exemption claims more
  // than it delivers: an import outside the markers is still reported, still unfixed.
  const [[start, end]] = marked;
  if (start + 1 > region[0] || end < region[1] - 1) {
    found.push(`${where}: the marked region does not cover every import declaration`);
  }
  return found;
}

/** Everything wrong with one file's marks, in the words the check will print. */
function checkFile(where, lines) {
  const region = importRegion(lines);
  const marked = markedRegions(lines, where);
  if (region === null) {
    const found = marked.length > 0 ? [`${where}: marked regions but no imports at all`] : [];
    return { found, marked };
  }
  if (marked.length === 0) return { found: [], marked };
  return { found: checkMarks(where, lines, { marked, region }), marked };
}

const problems = [];
const unmarked = [];

// `scripts/` is scanned for the same reason `src/` is: the gate scripts carry the
// same import preludes, and a checker that only read `src/` would exempt itself.
for (const file of [...sourceFiles(join(ROOT, "src")), ...sourceFiles(join(ROOT, "scripts"))]) {
  const where = relative(ROOT, file);
  const lines = readFileSync(file, "utf8").split("\n");
  const { found, marked } = checkFile(where, lines);
  problems.push(...found);
  if (found.length === 0 && marked.length === 0 && importRegion(lines) !== null) unmarked.push(where);
}

if (problems.length > 0) {
  process.stderr.write(`${problems.length} import-region problem(s):\n`);
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.exit(1);
}

if (process.argv.includes("--check")) {
  if (unmarked.length > 0) {
    process.stderr.write(`${unmarked.length} file(s) declare imports outside the marked region:\n`);
    for (const file of unmarked) process.stderr.write(`  ${file}\n`);
    process.exit(1);
  }
  process.stdout.write("every import declaration is marked, and nothing else is\n");
} else {
  for (const file of unmarked) {
    const where = relative(ROOT, file);
    const lines = readFileSync(file, "utf8").split("\n");
    const [start, end] = importRegion(lines);
    lines.splice(end, 0, END);
    lines.splice(start, 0, START);
    writeFileSync(file, lines.join("\n"));
    process.stdout.write(`marked ${where}\n`);
  }
  process.stdout.write(`${unmarked.length} file(s) marked; ${problems.length} problem(s)\n`);
}
