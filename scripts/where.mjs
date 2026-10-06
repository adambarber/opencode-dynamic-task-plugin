/**
 * Print `file:line  rule  message` for one lint rule.
 *
 * The JSON reporter gives byte offsets, not lines, and a rule spread over twenty files
 * cannot be worked from offsets. This is the diff between "here are 7 findings" and
 * "here are 7 places".
 *
 * Usage: node scripts/where.mjs <rule> [<rule> ...]
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Accepts `eslint/sort-imports` or `eslint(sort-imports)` — the reporter uses the second. */
const wanted = process.argv
  .slice(2)
  .map((rule) => (rule.includes("/") ? rule.replace("/", "(") + ")" : rule));
if (wanted.length === 0) {
  process.stderr.write("usage: node scripts/where.mjs <rule> [...]\n");
  process.exit(2);
}

const report = spawnSync("npx", ["oxlint", "--type-aware", "--format=json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
let findings = [];
try {
  findings = JSON.parse(report.stdout).diagnostics ?? [];
} catch {
  process.stderr.write(`could not parse the report: ${report.stderr}\n`);
  process.exit(2);
}

const lines = new Map();
for (const finding of findings) {
  if (wanted.includes(finding.code)) {
    const file = finding.filename.split("dynamic-task-plugin/").pop();
    const label = finding.labels?.[0]?.span;
    // The reporter usually carries the line itself. Fall back to counting newlines
    // only when it does not, so the offset path stays a fact rather than a guess.
    if (label?.line) {
      process.stdout.write(`${file}:${label.line}  ${finding.code}  ${finding.message}\n`);
    } else {
      if (!lines.has(file)) lines.set(file, readFileSync(file, "utf8").split("\n"));
      const text = lines.get(file);
      let line = 1;
      for (let at = 0; at < (label?.offset ?? 0) && at < text.length; at++) {
        if (text[at] === "\n") line++;
      }
      process.stdout.write(`${file}:${line}  ${finding.code}  ${finding.message}\n`);
    }
  }
}