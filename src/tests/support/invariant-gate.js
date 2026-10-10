/**
 * The gate machinery every Choke Point invariant is written against.
 *
 * A rule is DATA — the dangerous primitive, the modules allowed to hold it, the
 * corpus, the owning doc — and this file is the one funnel that turns that data
 * into an assertion, so a rule cannot be declared badly.
 *
 * Two invariants make that true. A rule resolving to an empty corpus FAILS, since a
 * renamed path or a typo in a sanction suffix would otherwise leave it scanning
 * nothing while reporting green — the README gate had already gone stale that way.
 * And the count, the sanction list and the failure text come from one shape, so no
 * rule can quietly assert a different thing than it documents.
 */

import { readFileSync } from "node:fs";
import { listProdFiles, siteOf } from "./corpus.js";
import { assert, it } from "./runner.js";

/** The skip marker for comment/prose lines, for rules about code rather than text. */
export const PROSE = Symbol("prose");

/**
 * The timer primitives: any wall-clock wait in production.
 *
 * A file whitelist grants an exemption, not an open door.
 */
export const TIMER_PRIMITIVE = /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/;

/**
 * Tenet 9: prompt.ts owns child prompts (Task 03 dance), notify.ts owns parent
 * writes (Task 05 gate). The legacy index-level helper is gone — no sanctioned
 * spans remain.
 */
export const PROMPT_CALL = /client\.session\.prompt\s*\(/;

/** The owning task doc for each gate family, so a red run names the argument to read. */
export const DOC_LIFECYCLE = "docs/tasks/01-lifecycle-choke-point.md";
export const DOC_SETTLEMENT = "docs/tasks/09-non-blocking-settlement.md";
export const DOC_NOTIFY = "docs/tasks/05-notification-gate.md";
export const DOC_QUESTIONS = "docs/tasks/04-question-gate.md";
export const DOC_PERSISTENCE = "docs/tasks/06-persistence-and-observability.md";
export const DOC_ADMISSION = "docs/tasks/07-admission-gate.md";
export const DOC_TYPES = "docs/tasks/08-strong-types.md";
export const DOC_FIDELITY = "docs/tasks/00-fidelity-ground-truth.md (Tenet 12)";

/**
 * A banned spelling, with the doctrine note and the claim it enforces.
 *
 * The three travel together because they are one gate: a rule answering to the wrong
 * note sends a reader of a red run to the wrong argument, and 14 rows were each
 * re-typing which note they answered to. What a rule still has to say is WHERE it is
 * read — the scope, the only part that genuinely varies.
 */
export const gate = (patterns, doc, why, extra = {}) => ({ doc, patterns, why, ...extra });

/**
 * Non-global regexes per line, since `lastIndex` makes a global pattern stateful.
 *
 * A line matching any pattern is a hit unless a skip claims it first.
 */
export function scanLines(file, patterns, skips = []) {
  const lines = readFileSync(file, "utf8").split("\n");
  const hits = [];
  lines.forEach((content, i) => {
    const claimed = content.trimStart().startsWith("//") || content.trimStart().startsWith("*") || content.trimStart().startsWith("/*");
    if (claimed && skips.includes(PROSE)) return;
    if (skips.some((s) => s !== PROSE && s.test(content))) return;
    if (patterns.some((p) => p.test(content))) {
      hits.push(`${siteOf(file)}:${i + 1} :: ${content.trim()}`);
    }
  });
  return hits;
}

function formatViolations(finding, hits) {
  return (
    `${finding.why}\n` +
    `Owning doc: ${finding.doc}\n` +
    `Expected ${finding.expect ?? 0} hit(s), found ${hits.length}.\n${
    hits.length ? `Sites (${hits.length}):\n` + hits.map((h) => `  - ${h}`).join("\n") : ""}`
  );
}

/**
 * The scan-and-assert funnel, declared as data.
 *
 * @param rule.name      what a newcomer would break
 * @param rule.patterns  the banned source shapes (any one is a hit)
 * @param rule.sanctioned path suffixes allowed to hold the primitive
 * @param rule.only      scan exactly these path suffixes, nothing else
 * @param rule.expect    permitted hit count; 0 for "no side doors"
 * @param rule.corpus    the file set to scan (production by default)
 * @param rule.skip      patterns whose lines are not violations (PROSE for comments)
 * @param rule.doc       the task doc that owns this funnel
 * @param rule.why       the one sentence that names the failure
 * @param rule.also      further banned shapes, joined onto `patterns`, for a rule
 *                       whose banned set is COMPUTED from the production enums rather
 *                       than written out — so the declaration stays one shape and the
 *                       corpus check and failure text still come from here.
 */
export function rule({ name, patterns, also = [], sanctioned = [], only = null, expect = 0, corpus = listProdFiles, skip = [], doc, why }) {
  it(name, () => {
    const files = corpus();
    const targets = only
      ? files.filter((f) => only.some((s) => f.endsWith(s)))
      : files.filter((f) => !sanctioned.some((s) => f.endsWith(s)));
    assert.ok(targets.length > 0, `rule "${name}" resolves to an empty corpus — a stale path or a typo in a sanction suffix`);
    const hits = targets.flatMap((f) => scanLines(f, [...patterns, ...also], skip));
    assert.strictEqual(hits.length, expect, formatViolations({ doc, expect, why }, hits));
  });
}
