# Lint waivers

`.oxlintrc.json` denies every category the project uses — correctness,
suspicious, performance, style — and then turns a named list of rules off.
This file is the argument for each one. The list itself is written once, in
`DOCUMENTED_WAIVERS` in `src/tests/gate-invariants.test.js`, and two pins
read it, so adding a waiver cannot be a quiet act: the list changes and the
diff shows it.

A waiver is a claim that the rule's violation is this repo's deliberate style.
If that stops being true, delete the waiver instead of reformatting the source
to satisfy it.

## Sequencing and acknowledgment

`no-await-in-loop` — host dials are sequential on purpose: ledger ordering,
claim-then-abort, serial retries, dialog turns. Parallelising them would be a
correctness bug, not a speedup.

`typescript/no-meaningless-void-operator` — `void` is the acknowledgment
operator that `typescript/no-floating-promises` asks for. Removing it trades a
marked intentional no-await for a silent floating promise.

## Shape the source writes deliberately

`eslint/func-style`, `eslint/one-var`, `eslint/curly` — the codebase uses
declarations, one `const` per binding, and braced bodies that carry a comment.
Brace-free single statements are legal here; the rule is off because it
contradicts the surrounding style rather than because it found a defect.

`eslint/no-ternary` — nested conditionals are written as early returns with a
named binding. The rule would flatten them back into the nesting they exist to
avoid.

`unicorn/switch-case-braces` — a `switch` case body that is one statement does
not repeat the `case` keyword's own braces.

## Formatting churn

`eslint/sort-keys`, `eslint/sort-imports` — enforced, not waived; they are kept
on precisely because ordering written by hand is what produces churn.

`unicorn/numeric-separators-style` — off only for literals the codebase already
writes bare. `1000` in a bound is clearer than `1_000` at a glance, and the
number is short enough that the separator adds nothing.

`eslint/capitalized-comments` — comments are sentences in the repo, so the rule
fires on continuations of a wrapped sentence that begin lowercase.

## Language-feature choices

`unicorn/no-null` — `null` carries meaning in the liveness model. It is the
value that means *unanswered*, distinct from *absent*; erasing it would erase
the distinction the reconciler is built on.

`eslint/no-magic-numbers` — off after review. The rule's complaint is well
aimed for production, where a bare `2` should be a named bound, and it is
enforced there by the constants modules. In the test tree it is the opposite of
useful: a fixture literal of `3` in a three-child tree says what the test means,
and a reader of the suite cannot invert it through a lookup table.

`eslint/id-length` — the rule forbids one- and two-character identifiers.
Positional coordinates and small count fields are clearer short.
