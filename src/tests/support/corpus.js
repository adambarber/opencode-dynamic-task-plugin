// The corpus: WHICH files a rule about source text reads.
//
// Extracted because two suites now hold source-scanning rules, and a second copy
// of the same walk is exactly the drift this repo treats as a defect: a renamed
// directory or a new gate script would leave one suite's corpus quietly empty
// while it reported green. One walk, one answer to "what counts as a file here".

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareStrings } from "./assertions.js";

// The tests directory is this module's PARENT: this file lives in support/, and
// anchoring on its own location would make SRC_DIR src/tests — a corpus that
// resolves to something real and is silently the wrong thing.
export const TESTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SRC_DIR = path.join(TESTS_DIR, "..");
export const SCRIPTS_DIR = path.join(SRC_DIR, "..", "scripts");
/**
 * The repository root — the ONE derivation, for every suite that reads a checked-in file
 * (the `tui.json` manifest, a config file's path spelled once in production).
 *
 * It lived here for the corpus alone, and two suites each spelled out the same two lines
 * of `resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")` when they needed it.
 * Three spellings of a root is three roots: a suite that resolved its own could read a
 * different tree from the one the gates scan, and the disagreement would look like a
 * passing test over the wrong files. Spelled once, from the same `TESTS_DIR` the corpus
 * uses, so every reader of a checked-in file starts from the same place.
 */
export const REPO_ROOT = path.join(TESTS_DIR, "..", "..");

/**
 * A source file's text, read the one way a corpus reads it.
 *
 * Every gate that inspects a file as its SUBJECT — the scanners, the word lists, the
 * fake's own source — wants the same two things: the text, and a name short enough to
 * name in a failure. Asking for them separately meant each module imported `node:fs`,
 * `node:path` and `REPO_ROOT` to hand-roll the same two lines, and those two lines
 * were the only thing several of those modules had in common.
 */
export function readSource(file) {
  return { file: siteOf(file), text: readFileSync(file, "utf8") };
}

/**
 * A file named the way every failure message names it: relative to the repo root.
 *
 * Four rules were each spelling `path.relative(REPO_ROOT, file)` inline, which is the
 * one line a red run has to agree on — a site reported as an absolute path is a site
 * nobody can paste into an editor.
 */
export const siteOf = (file) => path.relative(REPO_ROOT, file);

/**
 * A production source named the way `SHAPE_HOMES` names it — `shared/task-state.ts`.
 *
 * A rule that reaches for production by its repo-relative path wants the file text and
 * a short name for it, which is `readSource` with the `SRC_DIR` join already done. Rules
 * were importing `node:fs`, `node:path` and `REPO_ROOT` to spell that join themselves.
 */
export function readProductionSource(relative) {
  return readSource(path.join(SRC_DIR, relative));
}

/**
 * Every file under `dir` that `accept` claims, sorted. The ONE walk.
 *
 * A rule's corpus is a question about WHICH files, and each rule was answering it
 * with its own copy of the same recursion — so a corpus going stale was three
 * edits, and the file-size rule arrived with a fourth already duplicating an
 * existing walker. What varies between corpora is the extension and whether the
 * suite is in scope, so those are the parameters.
 */
export function walkSource(dir, accept, { skipTests = false } = {}) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (skipTests && entry === "tests") continue;
      out.push(...walkSource(full, accept, { skipTests }));
    } else if (accept(full)) {
      out.push(full);
    }
  }
  return out.toSorted(compareStrings);
}

export const isTypeScript = (file) => file.endsWith(".ts");
/**
 * The extensions the file-size rule reads, as a list rather than a chain of
 * `endsWith` calls — because a chain is a thing you extend by forgetting. The
 * repo writes `.mjs` for its own gate scripts, and a rule that skipped them was
 * a rule whose own tooling was ungated.
 */
export const SOURCE_EXTENSIONS = [".ts", ".js", ".mjs"];
export const isProductionOrSuite = (file) => SOURCE_EXTENSIONS.some((extension) => file.endsWith(extension));

/** The production sources: the .ts tree, minus the suite. */
export function listProdFiles() {
  return walkSource(SRC_DIR, isTypeScript, { skipTests: true });
}

/**
 * Production, suite and gate scripts alike — the file-size rule's corpus.
 *
 * `scripts/` is in it because the gates ARE code: a duplication detector or a
 * line counter that nothing checks is a detector that can rot the same way any
 * other code does. Stating the corpus here is what keeps the rule's name honest
 * — it used to say "every file under src/" while reading `.ts`/`.js` only.
 */
export function listSourceFiles() {
  return [...walkSource(SRC_DIR, isProductionOrSuite), ...walkSource(SCRIPTS_DIR, isProductionOrSuite)].toSorted(compareStrings);
}

export function listTestFiles() {
  return readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join(TESTS_DIR, f))
    .toSorted();
}

/**
 * The support modules beside the suites, which is where the fakes live: a client
 * handed to production in place of the host is a support file, and a fidelity gate
 * that listed only `*.test.js` would scan the suites and miss every mock in the tree.
 */
/**
 * The fake host's OWN modules, found by name. Derived rather than listed, because a
 * hand-kept list of the fake is a claim that goes stale the moment it is split — and
 * a stale claim here means a declared fault silently loses its witness.
 */
export function listFakeModules() {
  return listTestSupportFiles().filter((file) => path.basename(file).startsWith("mock-"));
}

export function listTestSupportFiles() {
  return readdirSync(path.join(TESTS_DIR, "support"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(TESTS_DIR, "support", f))
    .toSorted();
}

/**
 * How many lines a file actually has.
 *
 * `split("\n").length` counts the empty string AFTER a trailing newline, so every
 * well-formed file — every file, really — reads one line longer than it is. That
 * is not a rounding error here: it made the gate reject a file sitting exactly at
 * the limit, which is the one thing a threshold must never do. It is also the kind
 * of off-by-one that gets the THRESHOLD raised rather than the counter fixed, so
 * the arithmetic is pinned by a test instead of being left to chance.
 */
export function lineCount(source) {
  if (source.length === 0) return 0;
  const parts = source.split("\n").length;
  return source.endsWith("\n") ? parts - 1 : parts;
}
