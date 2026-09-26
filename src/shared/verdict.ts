/**
 * The plugin's one answer shape.
 *
 * Every gate here — prompt admission, the prompt-carrying tools' own input gate,
 * agent policy, session scope, the interrupt scope — answers `{ ok: false, error }`
 * and nothing else, so a caller's early return is one line it already writes and
 * no gate can invent a spelling the others do not use. Six modules were each
 * declaring the arm inline, which is six places for a caller to learn the wrong
 * one from.
 *
 * `Verdict` is the same refusal beside a resolved input. The two gates that name
 * their success arm `input` use it; the ones that answer something else (a
 * session scope) name their own success arm and borrow only the refusal.
 */

/** A gate that said no, and why — the answer a tool reports verbatim. */
export type Refusal = { ok: false; error: string };

/** A gate that answered with a resolved input, or refused. */
export type Verdict<T> = { ok: true; input: T } | Refusal;
