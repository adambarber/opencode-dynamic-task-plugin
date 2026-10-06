/**
 * The cross-boundary detector, for a human: what the gate enforces, on demand, and
 * at whatever threshold you want to look at. `node scripts/cross-boundary-clones.mjs`
 * prints the floor; `node scripts/cross-boundary-clones.mjs 20 4` prints a stricter
 * view, which is how the floor in scripts/cross-boundary.mjs was measured rather
 * than guessed.
 */
import { FLOOR_LINES, FLOOR_TOKENS, corpus, findCrossBoundaryClones, shortPath } from "./cross-boundary.mjs";
import { readFileSync } from "node:fs";

const minTokens = Number(process.argv[2] ?? FLOOR_TOKENS);
const minLines = Number(process.argv[3] ?? FLOOR_LINES);
const { tests, production } = corpus();
const findings = findCrossBoundaryClones(minTokens, minLines);

console.log(
  `cross-boundary: ${findings.length} shared runs of >=${minTokens} tokens / >=${minLines} lines `
  + `between ${tests} test files and ${production} production files\n`,
);

for (const finding of findings.slice(0, 24)) {
  const src = readFileSync(finding.test, "utf8").split("\n");
  console.log(`── ${finding.tokens}T / ${finding.lines}L   ${shortPath(finding.test)}:${finding.lineA}  ↔  ${shortPath(finding.prod)}:${finding.lineB}`);
  for (const line of src.slice(finding.lineA - 1, finding.lineA - 1 + finding.lines)) console.log(`     ${line}`);
  console.log();
}

if (findings.length > 24) console.log(`… ${findings.length - 24} more`);
process.exitCode = findings.length > 0 ? 1 : 0;
