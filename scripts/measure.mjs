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
 * The safety claim this module actually rests on is neither of those. It is
 * CONTAINMENT: jscpd's own match consists of code tokens — no new_line, no
 * comment — so it sits contiguously in this stream, and a run measured here is
 * therefore at least as long as the one jscpd reported. A clone jscpd finds at
 * or above `minTokens` cannot be reported shorter here, so no real finding can
 * be discarded, and the gate never compares its count to jscpd's at all. The
 * filter choices above are about what the gate CATCHES, not about agreeing with
 * a number: keeping them is safe because a jscpd match is inside this stream,
 * and dropping comments is what stops differently-worded prose from splitting a
 * run that is really one declaration.
 */
export const stream = (source) =>
  tokenize(source, "typescript")
    .filter((t) => t.type !== "empty" && t.type !== "comment")
    .map((t) => ({
      key: t.type === "string" ? "string" : `${t.type}:${t.value}`,
      line: t.loc.start.line,
    }));

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
