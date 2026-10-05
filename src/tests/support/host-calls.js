// Src/tests/support/host-calls.js
//
// Every outbound host call in production, as sites — the list the fake is checked
// Against, so no production call can land on a seam the fake never built.
//
// Three earlier versions of this file were wrong in three different ways, and all three
// Failed the same way: silently. It matched a hand-written namespace list (`app|session|
// Question`), which v2 invalidated when `question` became `permission` and `agent`
// Appeared. It matched the literal receiver `client`, so `(c) => c.agent.list()` was
// Invisible. It scanned line by line, so the dial of a multi-line `callHost` was invisible
// Too — it found 3 of 8 calls and reported itself complete. A gate that cannot see the
// Defect it exists to prevent is worse than no gate, because it is believed.
//
// So nothing here is hand-written and nothing is positional. What drives the enumeration is
// The FAKE'S OWN SURFACE: for each namespace the fake answers, find every
// `<recv>.<ns>.<method>(` production writes, and require the fake to answer it. Guessing
// The namespaces instead — from a hand list, or from the real `Context`, whose 26 domains
// Include ones the fake rightly does not implement — was what put `model.trim` (a string
// Trim) in the list. A namespace nobody answers cannot produce a false positive, because
// There is no list to be wrong about.

import path from "node:path";

import { listProdFiles, readSource } from "./corpus.js";

const ANY_CALL = /([a-zA-Z_$][\w$]*)\.([a-zA-Z]+)\.([a-zA-Z]+)\s*\(/g;
export const HOST_CALL = ANY_CALL;

/** The namespaces the fake answers — the enumeration is driven by these, and only these. */
export function hostCallSites(fake) {
  const namespaces = new Set(Object.keys(fake).filter((ns) => fake[ns] && typeof fake[ns] === "object")),
   sites = [];
  for (const file of listProdFiles()) {
    const { text } = readSource(file);
    for (const match of text.matchAll(ANY_CALL)) {
      if (!namespaces.has(match[2])) {continue;}
      sites.push({
        content: match[0].trim(),
        file,
        line: text.slice(0, match.index).split("\n").length,
        method: match[3],
        ns: match[2],
        where: `${path.basename(file)}:${match[2]}.${match[3]}`,
      });
    }
  }
  assertNotEmpty(sites);
  return sites;
}

/**
 * An empty list makes every gate below vacuously true, so it is a throw rather than a
 * default — the same rule `sdk-contract` applies to a parse that comes back empty.
 */
function assertNotEmpty(sites) {
  if (sites.length === 0) {
    throw new Error("host-calls found no outbound call in production — the scanner is broken, so nothing below it would mean anything");
  }
}
