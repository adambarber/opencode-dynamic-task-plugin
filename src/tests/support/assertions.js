/**
 * The shared assertion vocabulary — what a reader in this suite ANSWERS with, and
 * the one assertion per answer shape.
 *
 * These were scattered through the two grab-bag suites, which is why those files
 * grew past 2000 lines: every subject's suite carried its own copy of the claim
 * helpers, so the helpers were neither one thing nor anywhere in particular. A
 * reader here answers with a word, an empty string, nothing at all, a boolean, a
 * list, a verdict, or a block of prose — and an assertion that does not say which
 * claim it is making is the same assertion to the reader of a red run, however
 * different the function under it. So the claim IS the assertion, and there is
 * one per answer shape.
 *
 * Dependency-free on purpose: this module is what everything else asserts with, so
 * it asserts with nothing.
 */

import { notificationKindOf } from "../../../dist/shared/notification-text.js";
import { assert } from "./runner.js";

/**
 * The failure line every claim helper here shares: the case's own claim, then
 * what the reader actually answered.
 */
const claimFailure = (why, found) => `${why}. got: ${JSON.stringify(found)}`;

/**
 * The ordering every sorted claim shares, once.
 *
 * Paths, session ids and agent names all sort as plain strings, and a bare
 * `toSorted()` hides that from the next reader — so the comparator is named here
 * rather than spelled five ways.
 */
export const compareStrings = (a, b) => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/**
 * The two comparisons every claim here shares, once each.
 *
 * A claim helper is a NAME for a claim, not a comparison: "nothing", "empty" and
 * "absent" are different claims that happen to compare the same two ways. Written
 * out five times, the comparison was written out five times, and the rule this
 * file's own header states — the answer rides in the failure — held only because
 * every copy remembered to obey it. Here it cannot be forgotten: a new claim names
 * a claim and gets the failure line for free.
 */
const sameValue = (found, expected, why) => assert.strictEqual(found, expected, claimFailure(why, found));
const sameShape = (found, expected, why) => assert.deepStrictEqual(found, expected, claimFailure(why, found));

/** "The answer is nothing" — the claim behind a free slot and an unknown session. */
export const assertNothing = (found, why) => sameValue(found, null, why);

/** "The answer is an empty answer" — a slot allocated and left unfilled. */
export const assertEmpty = (found, why) => sameValue(found, "", why);

export const assertAbsent = (found, why) => sameValue(found, undefined, why);

export const assertIs = (found, expected, why) => sameValue(found, expected, why);

/** "Nothing usable in it" — the claim behind a parser handed garbage, a list or nothing. */
export const assertNoAgents = (found, why) => sameShape(found, [], why);

/** A reader's whole answer — the identity it read off a question, or the decision it made. */
export const assertAnswer = (answer, expected, why) => sameShape(answer, expected, why);

/**
 * A gate's verdict, with the refusal's own words in the failure. A gate answers
 * in a result object whose only field worth reading is `ok`, and cases were
 * asserting that field alone — so a refusal that came back saying nothing at all
 * read the same as one that explained itself.
 */
function verdict(result, expected, why) {
  sameValue(result.ok, expected, why);
  return result;
}

export const refuses = (result, why) => verdict(result, false, why);
export const admits = (result, why) => verdict(result, true, why);

/**
 * Prose the caller will actually read, with the word that makes it actionable in
 * the failure. A refusal is only useful if it says what to change, so every gate
 * test states the remedy and this checks the remedy SURVIVED into the text — a
 * refusal that is a correct decision in an empty string still fails here.
 */
export function said(text, needle, why) {
  assert.ok(text.includes(needle), claimFailure(`${why} — must name ${JSON.stringify(needle)}`, text));
  return text;
}

// --- Claims whose subject is a running harness -------------------------------
// The integration suites assert against prose a live tool returned, so their
// claims carry the same rule: the answer rides in the failure. These read a
// harness or a bound child, which is why they live apart from the pure claims
// above — the subject decides, not the assertion.

/**
 * The failure line every prose claim shares: the case's own claim, then the
 * answer as the only evidence there is. Composed once so a new kind of claim
 * cannot leave the answer out of its own failure.
 */
const proseFailure = (note, answer, extra = "") => `${note ? `${note}. ` : ""}${extra}got: ${answer}`;

export function answerSays(answer, reason, note) {
  assert.ok(answer.includes(reason), proseFailure(note, answer));
}

/**
 * As `answerSays`, for a claim that is a shape rather than a word. Same reason:
 * the answer is the only evidence there is, so it rides in the failure.
 */
export function answerMatches(answer, pattern, note) {
  assert.match(answer, pattern, proseFailure(note, answer));
}

/**
 * As `answerSays`, for the claim that is a word that must NOT be there — no
 * resume hint on a fatal error, no success claim on a vanished child. An absence
 * is a claim too, and it is the one a notification bug makes invisible, so the
 * whole text is in the failure rather than a bare false.
 */
export function answerOmits(answer, reason, note) {
  assert.ok(!answer.includes(reason), proseFailure(note, answer, `must not say ${reason}. `));
}

/**
 * How many notices reached the parent. The count is the whole claim in these
 * cases — told once, told twice, told nothing — and it is the one claim a
 * notification bug cannot make visible by its own wording: a settlement that
 * fires twice says exactly the right thing twice. So the count is read through
 * one place, and the notice bodies ride in the failure, because "told twice" and
 * "told the wrong thing twice" are different bugs wearing the same symptom.
 */
/**
 * Wait until the notification stream has gone QUIESCENT — no new notice for two
 * polls, longer than the durable claim's 20ms window plus its chain settle. The
 * primitive beneath `assertNoticeCount`: a test that needs a BASELINE (not an
 * assertion) calls this first, so whatever the arrangement legitimately delivered
 * has landed before the count is snapshotted.
 */
/** Wait for the notice count to go quiet (two polls, same value), up to 2s. */
async function awaitQuiescent(h) {
  let stable = 0;
  const deadline = Date.now() + 2000;
  while (stable < 2 && Date.now() < deadline) {
    const seen = h.notices().length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    stable = h.notices().length === seen ? stable + 1 : 0;
  }
}

export async function drainNotices(h) {
  await awaitQuiescent(h);
}

export async function assertNoticeCount(h, count, why) {
  await drainNotices(h);
  await awaitQuiescent(h);
  // Delivery rides the durable claim's bounded window now, so a count read at
  // time zero is the PREVIOUS settlements' total — it fails by arithmetic, not
  // by behavior. The count is SETTLED, not read: two quiescence waits give
  // late-arriving notices time to land before the count is snapshotted.
  const notices = h.notices();
  const bodies = notices.map((n) => n.message.split("\n")[1] ?? n.message);
  assert.strictEqual(notices.length, count, `${why}. notices: ${bodies.join(" | ")}`);
}

/**
 * What the nth notice says. The count is `assertNoticeCount`; this is the prose,
 * read from the same ledger in the same way, because "notified once" and
 * "notified the right thing" are the two halves of a settlement's claim.
 */

/**
 * What KIND the nth notice declared. The count is `assertNoticeCount`; the kind is
 * how a settlement case says which of the four it is — so the tests that care
 * "this is an error, not a success" claim THAT, and the prose that expresses it
 * belongs to the payload's own honesty pins.
 */
/**
 * That a delivered text DECLARES the kind the case is about — the claim, not a
 * sentence about it.
 *
 * Settlement cases used to say "must report success" and pin the phrase that used
 * to mean it, so every honest rewording of the payload turned twenty behavioural
 * cases red while none of them was about the words. The kind is a field on the
 * payload now, so these cases claim the field and the payload's own pins own the
 * prose.
 */
export function textDeclaresKind(text, kind, note) {
  const got = notificationKindOf(text);
  assert.strictEqual(got, kind, proseFailure(note, String(got), `wanted ${kind}. `));
}

/**
 * The state line and nothing else. The status view also names the last
 * notification's kind, which is history, so a substring over the whole report
 * cannot tell a state claim from a mention of one. One reader, because every
 * settlement test asks the same question of the same view.
 */
export const stateOf = async (child) => {
  const text = await child.status();
  return text.split("\n").find((line) => line.startsWith("State: ")) ?? "(no state line)";
};

/**
 * The claim a child's status view makes, and the view itself handed back.
 *
 * Reading the status view and asserting a word over it was spelled inline at a
 * dozen sites across the tool suites — `const status = await c.status();
 * answerSays(status, …)` — which is a dozen chances to assert against a different
 * view than the case set up, and the state line is the one place a settlement's
 * outcome is legible. The view comes back because a caller usually asks something
 * else of it too.
 */
const statusClaim = (claim) => async (child, reason, note) => {
  const status = await child.status();
  claim(status, reason, note);
  return status;
};

export const statusSays = statusClaim(answerSays);

/**
 * As `statusSays`, for the claim that is a word the status view must NOT carry —
 * no resume hint on a fatal settlement, no liveness block when nothing was read.
 * An absence is a claim too, and it is the one a notification bug makes invisible.
 */
export const statusOmits = statusClaim(answerOmits);

/**
 * The claim a task that has not settled still carries. A mid-flight notice and a
 * failed abort are different events, and both end in the same question — "does
 * the record still say active?" — asked by reading the one view.
 */
export const stillActive = (child, why) => statusSays(child, "active", why);

/**
 * A tool that acts on a named child, asked to act on nothing. The refusal is the
 * same shape from every one of them, so the check is one: a case that called a
 * tool with no id and asserted its own substring was one string away from a case
 * that silently accepted the call.
 */
export async function assertNeedsSessionId(toolUnderTest) {
  const answer = await toolUnderTest.execute({});
  answerSays(answer, "required", "a session-scoped tool refuses without an id");
}

/**
 * Assert that the gate settled a question by rejecting it exactly once, and
 * return the recorded host call.
 *
 * It asserts; it does not fire. Firing is the caller's job, through
 * `withAskedChild` or a hand-built event for the cases a plain ask cannot express
 * (a settled child, a multi-part ask) — so the one assertion every refusal needs
 * lives in one place and a new caller cannot quietly skip it.
 *
 * It returns no rejection REASON: the host's reject endpoint takes no body, so
 * there is no channel from the gate to the asking session, and a reason asserted
 * on the wire would be asserting something the contract makes impossible. The
 * reason is asserted where it lands instead — the operator's block claim, or the
 * debug log.
 */
export function assertPermissionDenied(h) {
  const calls = h.permissionCalls();
  assert.strictEqual(calls.length, 1, "one denial, never a silent stall");
  assert.strictEqual(calls[0].decision, "reject", "v2 answers a whole request with one decision word");
  return calls[0];
}


