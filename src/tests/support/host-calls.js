import { readFileSync } from "node:fs";
import path from "node:path";

import { REPO_ROOT, listProdFiles } from "./corpus.js";

/**
 * Every outbound host call in production, as sites — the enumeration both halves of the
 * outbound contract hang off: is the call bounded, and does the fake answer it. Kept in
 * one module so the two can never describe different production; see host-calls.test.js
 * for why one of them is read off the source and the other is asked of the fake.
 */export const HOST_CALL = /client\.(app|session|question)\.([a-zA-Z]+)\s*\(/;

/** One entry per call site: what it calls, and where it is written. */
export function hostCallSites() {
  const sites = [];
  for (const file of listProdFiles()) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((content, i) => {
        const match = HOST_CALL.exec(content);
        if (!match) return;
        sites.push({
          ns: match[1],
          method: match[2],
          line: i + 1,
          content: content.trim(),
          file,
          where: `${path.basename(file)}:${match[1]}.${match[2]}`,
        });
      });
  }
  return sites;
}
