/**
 * The shared assertion vocabulary — what a reader in this suite ANSWERS with, and
 * the one assertion per answer shape.
 *
 * These were scattered through `plugin.test.js`, which is why that file grew to
 * 2600 lines: every module's suite carried its own copy of the claim helpers, so
 * the helpers were neither one thing nor anywhere in particular. A reader here
 * answers with a word, an empty string, nothing at all, a boolean, a list, or a
 * verdict object — and an assertion that does not say which claim it is making is
 * the same assertion to the reader of a red run, however different the function
 * under it. So the claim IS the assertion, and there is one per answer shape.
 *
 * Every failure line carries the answer. A claim whose failure message leaves out
 * what the reader actually said is a claim nobody can diagnose.
 */

import assert from "node:assert";

/**
 * The failure line every claim helper here shares: the case's own claim, then
 * what the reader actually answered.
 */
export const claimFailure = (why, found) => `${why}. got: ${JSON.stringify(found)}`;

/** "The answer is nothing" — the claim behind a free slot and an unknown session. */
export function assertNothing(found, why) {
  assert.strictEqual(found, null, claimFailure(why, found));
}

export function assertEmpty(found, why) {
  assert.strictEqual(found, "", claimFailure(why, found));
}

export function assertAbsent(found, why) {
  assert.strictEqual(found, undefined, claimFailure(why, found));
}

export function assertIs(found, expected, why) {
  assert.strictEqual(found, expected, claimFailure(why, found));
}

/** "Nothing usable in it" — the claim behind a parser handed garbage, a list or nothing. */
export function assertNoAgents(found, why) {
  assert.deepStrictEqual(found, [], claimFailure(why, found));
}

/** A reader's whole answer — the identity it read off a question, or the decision it made. */
export function assertAnswer(answer, expected, why) {
  assert.deepStrictEqual(answer, expected, claimFailure(why, answer));
}

/**
 * A gate's verdict, with the refusal's own words in the failure. A gate answers
 * in a result object whose only field worth reading is `ok`, and cases were
 * asserting that field alone — so a refusal that came back saying nothing at all
 * read the same as one that explained itself.
 */
export function verdict(result, expected, why) {
  assert.strictEqual(result.ok, expected, claimFailure(why, result));
  return result;
}

export const refuses = (result, why) => verdict(result, false, why);
export const admits = (result, why) => verdict(result, true, why);
