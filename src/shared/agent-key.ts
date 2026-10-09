/**
 * The one spelling of an agent name: case-folded and trimmed, which is the match the
 * admission gate has always used to find an agent by name.
 *
 * A dispatch supplies the HOST's name, whose case is the host's business, while a
 * config key is whatever the operator typed. Folding only one side is the bug: the
 * write is folded and the read is not, so the cap an operator set applies to no agent
 * at all, and nothing reports that — no error, no refusal, just an agent running
 * uncapped under a cap they can see. So the fold happens HERE, on both sides, and
 * every lookup and every write in the plugin goes through this function.
 *
 * Its own module rather than `caps`' own, because two owners now share it: the caps
 * and the model choice both key an agent's own settings off it. An owner that has to
 * borrow a rule from its sibling is an import cycle, and the fold is used by enough
 * neighbours that the key space belongs to neither of them.
 */
export function agentKey(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}
