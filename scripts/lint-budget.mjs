/** The lint budget: findings are measured, recorded per rule in lint-budget.json, and ratcheted. */

//jscpd:ignore-start
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

//jscpd:ignore-end
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE_SOURCE = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));
const BUDGET_PATH = path.join(REPO_ROOT, "lint-budget.json");
const WRITE_FLAG = "--write";
const REPORT_LIMIT = 400;

/** oxlint reports `eslint(sort-imports)`; the config spells it `eslint/sort-imports`. */
export const ruleName = (code) => code.replace("(", "/").replace(")", "");

/** oxlint filenames are repo-relative with `/`; this file's own path is native. */
const nativePath = (relative) => relative.split("/").join(path.sep);

const sum = (values) => values.reduce((total, count) => total + count, 0);

function readFindings(oxlint) {
  try {
    return JSON.parse(oxlint.stdout).diagnostics ?? [];
  } catch {
    const detail = (oxlint.stderr ?? "").slice(0, REPORT_LIMIT);
    throw new Error(`oxlint did not answer with JSON (exit ${oxlint.status}): ${detail}`);
  }
}

function spawnLint() {
  const oxlint = spawnSync("npx", ["oxlint", "--type-aware", "--format=json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // Findings make oxlint exit 1 by design, so its status is not the verdict.
  if (oxlint.error) throw new Error(`could not run oxlint: ${oxlint.error.message}`);
  return readFindings(oxlint);
}

/** The gate's own findings are held to zero; only the rest of the tree is debt. */
function partition(findings) {
  const self = [];
  const ratcheted = [];
  for (const finding of findings) {
    const bucket = nativePath(finding.filename) === GATE_SOURCE ? self : ratcheted;
    bucket.push(finding);
  }
  return { ratcheted, self };
}

function countByRule(findings) {
  const rules = {};
  for (const { code } of findings) rules[ruleName(code)] = (rules[ruleName(code)] ?? 0) + 1;
  return rules;
}

/** Measure the tree the way `npm run lint` lints it. Empty output is a failure, not zero debt. */
export function measure() {
  const { ratcheted, self } = partition(spawnLint());
  return { ratcheted: { rules: countByRule(ratcheted), total: ratcheted.length }, self: { count: self.length } };
}

/**
 * Per rule, not just in total: a total ceiling is purchasable, since fixing thirty
 * findings anywhere buys thirty additions anywhere. A per-rule ceiling is not.
 */
export function compareBudget({ budget, measured }) {
  const over = [];
  const unbudget = [];
  for (const [rule, count] of Object.entries(measured.ratcheted.rules)) {
    const recorded = budget.rules[rule];
    if (recorded === undefined) unbudget.push({ count, rule });
    else if (count > recorded) over.push({ count, recorded, rule });
  }
  const stale = Object.entries(budget.rules)
    .filter(([rule, recorded]) => (measured.ratcheted.rules[rule] ?? 0) < recorded)
    .map(([rule, recorded]) => ({ count: measured.ratcheted.rules[rule] ?? 0, recorded, rule }));
  return { allowed: sum(Object.values(budget.rules)), over, stale, unbudget };
}

const gateNotClean = (count) => `${GATE_SOURCE}: ${count} finding(s) — the lint gate must stay at zero`;

/** Every way the measurement falls short of the baseline, one actionable line each. */
export function budgetFailures({ diff, measured }) {
  const lines = measured.self.count > 0 ? [gateNotClean(measured.self.count)] : [];
  for (const { count, rule } of diff.unbudget) {
    lines.push(`${rule}: ${count} finding(s), and the baseline has no entry for this rule`);
  }
  for (const { count, recorded, rule } of diff.over) {
    lines.push(`${rule}: ${count} finding(s), baseline allows ${recorded} (+${count - recorded})`);
  }
  for (const { count, recorded, rule } of diff.stale) {
    lines.push(`${rule}: ${count} finding(s), baseline still allows ${recorded} — run npm run lint:budget`);
  }
  if (measured.ratcheted.total > diff.allowed) {
    lines.push(`total: ${measured.ratcheted.total} finding(s), baseline allows ${diff.allowed} (+${measured.ratcheted.total - diff.allowed})`);
  }
  return lines;
}

/** The baseline as the file spells it: rules sorted, so a diff is one line per rule. */
export function renderBudget(measured) {
  const rules = Object.fromEntries(Object.entries(measured.ratcheted.rules).toSorted(([a], [b]) => (a < b ? -1 : 1)));
  const { total } = measured.ratcheted;
  const file = { $comment: `${total} findings. Regenerate with: npm run lint:budget`, rules, total };
  return `${JSON.stringify(file, null, 2)}\n`;
}

function report(failures, measured) {
  if (failures.length === 0) {
    process.stdout.write(`lint budget: ${measured.ratcheted.total} finding(s), within baseline\n`);
    return 0;
  }
  process.stderr.write(`lint budget: ${failures.length} problem(s) against lint-budget.json\n`);
  for (const line of failures) process.stderr.write(`  ${line}\n`);
  process.stderr.write("\nFix the findings, or run npm run lint:budget when the tree got better.\n");
  return 1;
}

export function run(argv) {
  const measured = measure();
  if (!argv.includes(WRITE_FLAG)) {
    const diff = compareBudget({ budget: readBudget(), measured });
    return report(budgetFailures({ diff, measured }), measured);
  }
  // --write still refuses when the gate is dirty: the exemption keeps this file
  // out of the debt, not as a licence to publish a baseline that ratifies it.
  if (measured.self.count > 0) return report([gateNotClean(measured.self.count)], measured);
  writeFileSync(BUDGET_PATH, renderBudget(measured));
  const rules = Object.keys(measured.ratcheted.rules).length;
  process.stdout.write(`lint budget: ${measured.ratcheted.total} finding(s) across ${rules} rules\n`);
  return 0;
}

const readBudget = () => JSON.parse(readFileSync(BUDGET_PATH, "utf8"));

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)));