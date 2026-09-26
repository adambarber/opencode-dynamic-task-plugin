/**
 * A block of text: the lines in order, joined by newlines.
 *
 * Every report this plugin writes is one — a notification, a fleet view, a status
 * detail, a refusal, a background prompt — and each renderer was assembling it by
 * hand: an array literal, a `push` per conditional section, and a `join("\n")`
 * epilogue that six renderers between them spelled out. That epilogue is a
 * chokepoint: how a report ends is decided in one place, and the parts a renderer
 * does not have are named in the shape of its own call rather than smuggled in as
 * an empty array or a blank line.
 *
 * A section that is not there is not a blank line — an absent section is
 * `undefined`, and a blank line is a line the caller asked for, spelled `""`.
 */
export const textBlock = (...parts: (string | string[] | undefined)[]): string =>
  parts.flat().filter((part): part is string => part !== undefined).join("\n");

/**
 * The same absence rule for a renderer that builds an ARRAY of lines instead of
 * handing them straight to textBlock: a section that is not there contributes no
 * line, and the array keeps its shape either way.
 *
 * `...(cond ? [line] : [])` was the hand-rolled spelling, four times in
 * task-formatting alone. Each one is the same decision — this section may be
 * absent — restated as a conditional array literal, which is a shape a reader
 * has to parse to learn is a decision at all.
 */
export const present = (...lines: (string | undefined)[]): string[] =>
  lines.filter((line): line is string => line !== undefined);
