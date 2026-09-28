/**
 * How this repo measures a clone: one tokenizer, one stream policy, one
 * comparison. It lives here, apart from the gate, for one reason — the gate
 * SPAWNS jscpd when it is loaded, so nothing could import it to ask a question
 * without starting a process scan. That is why a pin once re-implemented this
 * arithmetic with the filter policy as an argument, and asserted only that its
 * own fixture straddled the bar: the pin and the gate were two claims with
 * nothing connecting them, and a filter could drift in the gate while the pin
 * stayed green. One owner, imported by both, is the fix; a pin that calls this
 * module is asking the gate's real question.
 *
 * There is no policy argument anywhere in this file, and that is the design.
 * "Which tokens count" is a decision, not a preference of the caller, and the
 * moment a caller can pass it, the pin and the thing it pins stop being one
 * measurement.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { tokenize } = require("@jscpd/tokenizer");

/**
 * Every token of CODE, tagged with the line it starts on, in one form that can
 * be compared: a string token is its own kind, and every other token is its
 * type and value. The string collapse is inherited from jscpd — two different
 * literals compare equal — and it is why this file is about arithmetic rather
 * than about being right about literals.
 *
 * Two classes are excluded, each for a reason MEASURED rather than argued, and
 * neither for the reason the gate's header used to give:
 *
 *   `comment`  DROPPED. Measured: five identical code lines report 28 tokens,
 *              and the same five lines with a byte-identical 40-word comment
 *              block added still report 28. jscpd contributes ZERO for comments,
 *              so a comment can neither create a match there nor lengthen one.
 *              Here it would break a shared run at the first reworded sentence
 *              and hide the real clone whose two docblocks differ — which is how
 *              `lane-occupancy.ts` and `task-formatting.ts` declare the same
 *              three fields with the same names, types and nullability and were
 *              measured at 8 shared tokens because their prose differed.
 *
 *   `new_line`  KEPT — but NOT because jscpd counts line breaks. It does not;
 *              the measurement above is the same counterexample (5 lines, 28
 *              tokens, and the added comment changed nothing). It is kept because
 *              removing a token from BOTH sides can SHORTEN the common run when
 *              that token sat inside the match, and the gate measured 50 → 49
 *              on a real run when it dropped one. "Dropping a token can only
 *              lengthen a run" is false: 1,830,000 of the 1,920,000 token pairs
 *              on the two five-line fixtures shorten, and only the 90,000 whose
 *              deletion is a boundary match leave it unchanged. Nothing grows.
 *
 * The safety claim this module actually rests on is NEITHER of those, and it is
 * not the one this file used to make. That one was CONTAINMENT — jscpd's match
 * holds no comments and no line breaks, so it sits contiguously here and a run
 * measured here is at least as long as the one jscpd reported — and it is
 * FALSE, falsified 11 times out of 11 on this tree, every finding measuring 2 to
 * 11 tokens BELOW the count jscpd reported for it. It also could not be true:
 * the same header argued the reported ranges are bounding boxes, and a longest
 * shared run over two boxes that each contain an N-token match cannot be shorter
 * than N. The pin that supposedly checked it was a block compared to ITSELF,
 * which is the one case where a range covers a maximal run, so it passed with
 * any tokenizer at all.
 *
 * What holds instead is measured, and it is arithmetic rather than a claim about
 * where jscpd's tokens land. On a byte-identical pair the gate reads jscpd's
 * count PLUS ONE TOKEN PER LINE, every time, across 44 reported findings
 * (17→21, 21→26, 93→116). And jscpd will not report a clone below 4 lines and 17
 * tokens on this config at all, so the smallest thing that can ever reach this
 * measurement reads at least 21 against a bar of 14. That seven-token margin is
 * structural, which is why a byte-identical clone cannot be discarded here and
 * why a fixture asserting one CANNOT be made to fail: dropping `new_line` and
 * shifting the range by a line both leave such a fixture green, and both were
 * tried.
 *
 * So the two questions are separate, and the pin suite is where each is asked.
 * Whether a real clone is CAUGHT is settled by that margin and by the mapping
 * being exact — `gate-invariants.test.js` pins the mapping with no slack, in
 * both directions, because a range is where a boundary error hides. What is NOT
 * guaranteed is agreement with jscpd's number, and it is not wanted: the findings
 * this gate discards are near-matches whose reported count is looser than any
 * contiguous shared run, and all 11 on this tree are code that shares a prefix
 * with itself. That is the discrimination the gate is for, so the count is never
 * compared to jscpd's — one tokenizer, one threshold, and the coordinates jscpd
 * chose.
 */
export const stream = (source) =>
  tokenize(source, "typescript")
    .filter((t) => t.type !== "empty" && t.type !== "comment")
    .map((t) => ({
      key: t.type === "string" ? "string" : `${t.type}:${t.value}`,
      line: t.loc.start.line,
    }));

/**
 * The tokens one REPORTED range covers, as comparable keys.
 *
 * This is the gate's reading of jscpd's `start`/`end`, and it lives here so the
 * gate and the test that pins the gate cannot each hold a private copy of what
 * those coordinates mean. That duplication is not hypothetical: the pin this
 * replaced compared a block to ITSELF, which is the single case where a range
 * covers a maximal run, so it could not observe the coordinate mapping at all.
 *
 * The mapping is the whole risk, and it is not neutral. jscpd's `start`/`end`
 * are BOUNDING BOXES around a match, and tokens are tagged with the line they
 * START on, so a box that opens mid-statement carries that statement's leading
 * tokens and a box that closes before a statement's end drops its trailing ones.
 * The two sides of one finding therefore arrive with different amounts of
 * overhang, and a run has to survive that to be seen at all.
 */
export const tokensInRange = (tokens, from, to) =>
  tokens.filter((t) => t.line >= from && t.line <= to).map((t) => t.key);

/**
 * The longest run of tokens the two ranges share, contiguously.
 *
 * jscpd's reported `start`/`end` are the BOUNDING BOXES of a match, not its
 * extent: a 16-token match inside a 37-token, 4-line box reports the box. So
 * comparing the boxes would call a real clone a phantom, which is the failure
 * the gate exists to prevent. What has to reproduce is the claim — a shared
 * contiguous run at least as long as the one reported.
 */
export const longestSharedRun = (a, b) => {
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
 * The bar, read from the config rather than restated anywhere. Restating it is
 * how two numbers drift apart, and the drift is silent in the direction that
 * matters: this is the one threshold every finding is judged against, and jscpd
 * judges its own report against the same file, so a change to the bar is one
 * edit in one place.
 */
export const readMinTokens = (configPath) => JSON.parse(readFileSync(configPath, "utf8")).minTokens;

/** The run two sources share, measured the way the gate measures it. */
export const sharedRunBetween = (a, b) => longestSharedRun(stream(a).map((t) => t.key), stream(b).map((t) => t.key));
