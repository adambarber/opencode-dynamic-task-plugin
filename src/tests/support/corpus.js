// The corpus: WHICH files a rule about source text reads.
//
// Extracted because two suites now hold source-scanning rules, and a second copy
// of the same walk is exactly the drift this repo treats as a defect: a renamed
// directory or a new gate script would leave one suite's corpus quietly empty
// while it reported green. One walk, one answer to "what counts as a file here".

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The tests directory is this module's PARENT: this file lives in support/, and
// anchoring on its own location would make SRC_DIR src/tests — a corpus that
// resolves to something real and is silently the wrong thing.
export const TESTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SRC_DIR = path.join(TESTS_DIR, "..");
export const SCRIPTS_DIR = path.join(SRC_DIR, "..", "scripts");
export const REPO_ROOT = path.join(TESTS_DIR, "..", "..");

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
  return out.sort();
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
  return [...walkSource(SRC_DIR, isProductionOrSuite), ...walkSource(SCRIPTS_DIR, isProductionOrSuite)].sort();
}

export function listTestFiles() {
  return readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join(TESTS_DIR, f))
    .sort();
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
