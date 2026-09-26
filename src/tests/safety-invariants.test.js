/**
 * Safety invariants — Choke Point Theory, Tenet 8 enforcement.
 *
 * Each suite names ONE dangerous primitive and the single funnel it must pass
 * through (see docs/tasks/01-07). A newcomer who reintroduces the unsafe path
 * turns this file red — review vigilance is not required.
 *
 * Convention notes (repo has no eslint/prettier; node:test IS the build check):
 * - Plain JS, node:test describe/it, zero new dependencies. Runs inside the
 *   existing `node --test src/tests/*.test.js` glob — no script changes needed
 *   to enforce it.
 * - Scanners read source text and report file:line. They never mock the
 *   contract (Tenet 12): the production files on disk are the subject.
 * - Tenet 9: sanctioned modules are named inline with their reason. A suite
 *   that fails today measures distance to its task doc — the failure message
 *   names the owning doc and every bypass site. Commit stays red until the
 *   funnel it describes exists.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildToolMap } from "../../dist/tools/index.js";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(TESTS_DIR, "..");
const REPO_ROOT = path.join(TESTS_DIR, "..", "..");

function listProdFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "tests") continue;
        walk(full);
      } else if (full.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  walk(SRC_DIR);
  return out.sort();
}

function listTestFiles() {
  return readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join(TESTS_DIR, f))
    .sort();
}

// Non-global regexes per line (avoids lastIndex statefulness). A line that
// matches any pattern is a hit unless a skip pattern claims it first.
function scanLines(file, patterns, skips = []) {
  const lines = readFileSync(file, "utf8").split("\n");
  const hits = [];
  lines.forEach((content, i) => {
    const claimed = content.trimStart().startsWith("//") || content.trimStart().startsWith("*") || content.trimStart().startsWith("/*");
    if (claimed && skips.includes(PROSE)) return;
    if (skips.some((s) => s !== PROSE && s.test(content))) return;
    if (patterns.some((p) => p.test(content))) {
      hits.push(`${path.relative(REPO_ROOT, file)}:${i + 1} :: ${content.trim()}`);
    }
  });
  return hits;
}

// The skip marker for comment/prose lines, for rules about code rather than
// about text that merely discusses code.
const PROSE = Symbol("prose");

function formatViolations(rule, hits) {
  return (
    `${rule.why}\n` +
    `Owning doc: ${rule.doc}\n` +
    `Expected ${rule.expect ?? 0} hit(s), found ${hits.length}.\n` +
    (hits.length ? `Sites (${hits.length}):\n` + hits.map((h) => `  - ${h}`).join("\n") : "")
  );
}

/**
 * The scan-and-assert funnel. Every rule in this file is DATA — the dangerous
 * primitive, the modules allowed to hold it, the corpus, and the owning doc.
 *
 * Two invariants make a rule impossible to declare badly:
 * - a rule that resolves to an empty corpus FAILS. A renamed path or a typo in
 *   a sanction suffix would otherwise leave the rule scanning nothing while
 *   reporting green (the README gate had already gone stale exactly that way).
 * - the count, the sanction list, and the failure text come from one shape, so
 *   no rule can quietly assert a different thing than it documents.
 *
 * @param rule.name      what a newcomer would break
 * @param rule.patterns  the banned source shapes (any one is a hit)
 * @param rule.sanctioned path suffixes allowed to hold the primitive
 * @param rule.only      scan exactly these path suffixes, nothing else
 * @param rule.expect    permitted hit count; 0 for "no side doors"
 * @param rule.corpus    the file set to scan (production by default)
 * @param rule.skip      patterns whose lines are not violations (PROSE for comments)
 * @param rule.doc       the task doc that owns this funnel
 * @param rule.why       the one sentence that names the failure
 */
function rule({ name, patterns, sanctioned = [], only = null, expect = 0, corpus = listProdFiles, skip = [], doc, why }) {
  it(name, () => {
    const files = corpus();
    const targets = only
      ? files.filter((f) => only.some((s) => f.endsWith(s)))
      : files.filter((f) => !sanctioned.some((s) => f.endsWith(s)));
    assert.ok(targets.length > 0, `rule "${name}" resolves to an empty corpus — a stale path or a typo in a sanction suffix`);
    const hits = targets.flatMap((f) => scanLines(f, patterns, skip));
    assert.strictEqual(hits.length, expect, formatViolations({ doc, why, expect }, hits));
  });
}

const DOC_LIFECYCLE = "docs/tasks/01-lifecycle-choke-point.md";
const DOC_SETTLEMENT = "docs/tasks/09-non-blocking-settlement.md";
const DOC_NOTIFY = "docs/tasks/05-notification-gate.md";
const DOC_QUESTIONS = "docs/tasks/04-question-gate.md";
const DOC_PERSISTENCE = "docs/tasks/06-persistence-and-observability.md";
const DOC_ADMISSION = "docs/tasks/07-admission-gate.md";
const DOC_TYPES = "docs/tasks/08-strong-types.md";
const DOC_FIDELITY = "docs/tasks/00-fidelity-ground-truth.md (Tenet 12)";

// The timer primitives: any wall-clock wait in production. A file whitelist
// grants an exemption, not an open door.
const TIMER_PRIMITIVE = /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/;

// --- Task 01: lifecycle funnel -------------------------------------------
// Primitive: task-state mutation. Funnel: src/shared/task-state.ts owns every
// Map write and every completed/timeoutNotified assignment (Tenets 1, 3, 5).
describe("invariant: lifecycle mutations funnel through task-state (Task 01)", () => {
  rule({
    name: "no raw store/flag mutation outside task-state.ts",
    // (?!=) excludes == / === reads: only real assignments are bypasses.
    // Lifecycle fields (state/abortError/lastAbortAt/lastNotice/lastActivityAt/
    // replacedAt/turnLiveAt) belong to the state machine alone: outside
    // task-state.ts they may be read, never written.
    patterns: [
      /activeTasks\s*\.\s*(set|delete)|retainedTasks\s*\.\s*(set|delete)|\.\s*completed\s*=(?!=)|\.\s*timeoutNotified\s*=(?!=)|\.(state|abortError|lastAbortAt|lastNotice|lastActivityAt|replacedAt|turnLiveAt)\s*=(?!=)/,
    ],
    sanctioned: ["task-state.ts"],
    doc: DOC_LIFECYCLE,
    why: "Direct task-state mutation bypasses transitionState's matrix.",
  });
});

// --- Task 09: non-blocking settlement -------------------------------------
// Primitive: waiting on child work / per-call execution bounds. The cutover
// deleted the timer funnel; the ONLY sanctioned wall-clock wait in production
// is the notification gate's fixed retry backoff (notify.ts). Everything else
// is unrepresentable by invariance, and the deleted vocabulary may not return.
describe("invariant: settlement is event-driven, no per-call clocks (Task 09)", () => {
  rule({
    name: "no bare wall-clock waits outside the notification retry",
    // No lookbehind exemptions: any setTimeout-shaped call fails outside
    // notify.ts — including globalThis.*.
    patterns: [TIMER_PRIMITIVE],
    sanctioned: ["notify.ts"],
    doc: DOC_SETTLEMENT,
    why: "A wall-clock wait returned outside the notification gate.",
  });

  rule({
    name: "the notify gate keeps exactly one timer-shaped call site",
    // The exemption is the retry backoff's sleep, nothing more. A second
    // timer-shaped call means a new clock entered the settlement layer.
    patterns: [TIMER_PRIMITIVE],
    only: ["notify.ts"],
    expect: 1,
    doc: DOC_SETTLEMENT,
    why: "The notification gate holds exactly one wall-clock wait (defaultSleep).",
  });

  // Tenet 9: create lives in the spawn executor — the ONLY site, because a
  // created session nobody registered runs unmonitored. Abort is funnelled
  // in session-lifecycle: the await stays at the call site that orders it
  // (steer beside its claim, interrupt beside its settle, spawn beside its
  // cleanup), but what a failure MEANS is decided once.
  rule({
    name: "child sessions are created only by the spawn executor",
    patterns: [/client\.session\.create\s*\(/],
    sanctioned: ["tools/spawn.ts"],
    doc: DOC_SETTLEMENT,
    why: "Child sessions must be created only by the spawn executor.",
  });

  rule({
    name: "child sessions are aborted only via abortSession",
    patterns: [/client\.session\.abort\s*\(/],
    sanctioned: ["shared/session-lifecycle.ts"],
    doc: DOC_SETTLEMENT,
    why: "Abort only via abortSession, so 404-versus-transport failure cannot drift between the steer and interrupt paths.",
  });

  rule({
    name: "deleted timer vocabulary never returns",
    patterns: [/\btimeout_ms\b|\btimeoutBehavior\b|\bawait_response\b|\btimed_out_retained\b|\bcompleted_after_timeout\b|\bDYNAMIC_TASK_TIMEOUT\b|\bcreateTimerProvider\b|\bstealTimeoutHandle\b/],
    doc: DOC_SETTLEMENT,
    why: "Pre-cutover timer vocabulary reappeared in production source.",
  });
});

// --- Task 03: prompt/hydration dance ---------------------------------------
// Primitive: client.session.prompt. Until the Task 03 dance module exists
// there is no sanctioned caller — every site is reported so the migration
// has a complete list (Tenets 1, 6).
describe("invariant: session.prompt flows through funnels (Tasks 03/05)", () => {
  // Tenet 9: prompt.ts owns child prompts (Task 03 dance), notify.ts owns
  // parent writes (Task 05 gate). The legacy index-level helper is gone —
  // no sanctioned spans remain.
  const PROMPT_CALL = /client\.session\.prompt\s*\(/;

  rule({
    name: "no direct client.session.prompt outside prompt.ts and notify.ts",
    patterns: [PROMPT_CALL],
    sanctioned: ["prompt.ts", "notify.ts"],
    doc: DOC_NOTIFY,
    why: "Direct session.prompt call sites (child prompts via invokePrompt, parent writes via notifyParent).",
  });

  rule({
    name: "the gate holds exactly one parent-write call",
    patterns: [PROMPT_CALL],
    only: ["notify.ts"],
    expect: 1,
    doc: DOC_NOTIFY,
    why: "The notification gate owns exactly one parent write.",
  });

  rule({
    name: "no legacy notifyParentSession helper remains",
    patterns: [/notifyParentSession/],
    doc: DOC_NOTIFY,
    why: "Legacy helper (notify via the gate).",
  });
});

// --- Task 04: question gate ------------------------------------------------
// Primitive: answering child questions. Funnel: question-handling.ts owns the
// only client.question.reply/reject calls (Tenets 1, 4).
describe("invariant: question reply/reject funnel through question-handling (Task 04)", () => {
  rule({
    name: "linkage map lives in the gate module only",
    patterns: [/questionIdToSessionId|questionSessions/],
    sanctioned: ["question-handling.ts"],
    doc: DOC_QUESTIONS,
    why: "Question linkage state outside the gate module.",
  });

  rule({
    name: "no direct client.question.reply/reject outside question-handling.ts",
    patterns: [/client\.question\s*\.\s*(reply|reject)\s*\(/],
    sanctioned: ["question-handling.ts"],
    doc: DOC_QUESTIONS,
    why: "Direct question reply/reject bypasses the resolve-then-validate gate.",
  });
});

// --- Task 05: notification gate --------------------------------------------
// Primitive: parent-directed writes. Structure rule: exactly one function
// owns them (notifyParentSession) until the Task 05 gate subsumes it
// (Tenets 1, 6).
describe("invariant: one parent-notification owner (Task 05)", () => {
  rule({
    name: "exactly one notifyParent* function exists",
    patterns: [/function\s+notifyParent\w*\s*\(/],
    expect: 1,
    doc: DOC_NOTIFY,
    why: "Exactly one parent-notification owner.",
  });
});

// --- Task 06: persistence dance --------------------------------------------
// Primitive: durable file writes. Funnel: session-lifecycle.ts owns the
// atomic ledger dance; debug-logger.ts owns diagnostics appends (Tenet 6).
// No other module may write files.
describe("invariant: file writes funnel through ledger/logger dances (Task 06)", () => {
  const PERSISTENCE_SANCTIONED = ["session-lifecycle.ts", "debug-logger.ts"];

  rule({
    name: "no writeFileSync/renameSync/appendFileSync outside sanctioned dances",
    patterns: [/writeFileSync|renameSync|appendFileSync/],
    sanctioned: PERSISTENCE_SANCTIONED,
    doc: DOC_PERSISTENCE,
    why: "File write outside the atomic-write dances.",
  });
});

// --- Task 06 amendment (2026-09-11 smoke finding): state scoping -----------
// The poisoned repo ledger came from state paths resolved against the
// process CWD. tsc now forces every caller to pass a path, but string
// literals can re-establish CWD roots silently — the names belong to the
// two persistence dances, nowhere else.
describe("invariant: durable state paths derive from the project directory", () => {
  rule({
    name: "no bare state-file/dir literals outside the ledger/logger dances",
    patterns: [/"\.dynamic-task-(ledger|logs)/],
    sanctioned: ["session-lifecycle.ts", "debug-logger.ts"],
    doc: DOC_PERSISTENCE,
    why: "State-path literal outside the dances (resolve via the host directory instead).",
  });
});

// --- Task 07: admission gate ------------------------------------------------
// Primitive: spawn admission. Until the Task 07 gate exists there is no
// sanctioned caller of registration/validation — every site is reported
// (Tenets 3, 4).
describe("invariant: spawn admission flows through one gate (Task 07)", () => {
  rule({
    name: "no direct register/validate/agent-find outside the admission gate",
    patterns: [/registerActiveTask\s*\(|validateAgent\s*\(|validateLineage\s*\(|\bagents\s*\.\s*find\s*\(/],
    // Tenet 9: admission.ts IS the gate — its own definitions are the funnel.
    skip: [/function\s+(registerActiveTask|validateAgent|validateLineage)\s*\(/],
    sanctioned: ["admission.ts"],
    doc: DOC_ADMISSION,
    why: "Direct admission calls (each must route via admitSpawn).",
  });
});

// --- Tenet 12: pin contracts with the real primitive ------------------------
// Tests must import production code from dist/, never re-define it. Copies
// drift — plugin.test.js carries its own agent-mode filter that contradicts
// the eed3a04 dispatchability fix it should pin.
describe("invariant: tests import production, never redefine it (Tenet 12)", () => {
  rule({
    name: "no production-function copies in test files",
    patterns: [/^\s*(async\s+)?function\s+(buildAgentList|validateSessionResult|extractTextFromParts|resolveParentSessionId|fetchAgents|getMessageCount|readSessionMessages|truncateText|registerBackgroundTask|handleChildLifecycleEvent)\s*\(/],
    corpus: listTestFiles,
    doc: DOC_FIDELITY,
    why: "Test-local copies of production functions — import from dist/ instead.",
  });

  rule({
    name: "no stale subagent-only dispatch filter in tests",
    patterns: [/===\s*["']subagent["']/],
    // Self-exclusion: this file discusses the banned pattern in prose.
    sanctioned: ["safety-invariants.test.js"],
    corpus: listTestFiles,
    doc: DOC_FIDELITY,
    why: "Stale dispatch filter — production accepts 'subagent'+'all' (isDispatchableAgent); import it instead.",
  });
});

// --- Task 00: documented capability inventory --------------------------------
// Primitive: the documented capability set. README's tool table must match
// exactly the tools registered in the tool map (fidelity gate).
describe("invariant: README tool inventory matches registered tools (Task 00)", () => {
  it("every documented tool is registered and vice versa", () => {
    // Ground truth, not text shape: ask the tool map for its keys. A regex
    // over index.ts could not survive a builder being renamed or a tool being
    // registered by a helper the scan does not know — and the previous version
    // of this gate had already gone stale that way, matching a funnel name
    // that no longer existed. The map's construction never touches deps.
    const registered = new Set(Object.keys(buildToolMap({})));
    const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8").split("\n");
    const headerIdx = readme.findIndex((l) => l.startsWith("| Tool |"));
    const documented = new Set();
    for (let i = headerIdx + 2; i < readme.length; i++) {
      const m = readme[i].match(/^\|\s*`(\w+)`/);
      if (!m) break;
      documented.add(m[1]);
    }
    const phantom = [...documented].filter((t) => !registered.has(t));
    const undocumented = [...registered].filter((t) => !documented.has(t));
    const drift = [
      ...phantom.map((t) => `documented but not registered: ${t}`),
      ...undocumented.map((t) => `registered but not documented: ${t}`),
    ];
    assert.strictEqual(
      drift.length,
      0,
      `README ↔ dist/tools/index.js capability drift.\nOwning doc: docs/tasks/00-fidelity-ground-truth.md\n` +
        drift.map((d) => `  - ${d}`).join("\n"),
    );
  });
});

// --- the duplicate-detection gate ------------------------------------------------
// The thresholds are not taste. Measured on this tree: 3 lines / 25 tokens is the
// strictest level that reports 0 clones. One notch down is real duplication, not
// tokenizer noise — 3/20 finds 37 clones and 3/15 finds 86, headed by duplicated
// interface declarations and duplicated steer-claim blocks, with zero of them
// import-shaped. So the gate is pinned here: loosening it is a deliberate edit
// to a test that says what re-opens, not a quiet edit to a config file.
describe("invariant: the duplicate-detection gate stays where the tree passes", () => {
  const config = JSON.parse(readFileSync(path.join(REPO_ROOT, ".jscpd.json"), "utf8"));

  it("enforces zero tolerance at 3 lines / 25 tokens", () => {
    const loosened = [
      ["threshold", 0],
      ["minLines", 3],
      ["minTokens", 25],
    ].filter(([key, expected]) => config[key] !== expected);
    assert.deepStrictEqual(
      loosened.map(([key, expected]) => `${key} is ${config[key]}, not ${expected}`),
      [],
      `duplicate gate loosened. 3/20 reports 37 real clones and 3/15 reports 86,\n` +
        `so these thresholds are the tree's actual clean level, not a preference.`,
    );
  });

  it("ignores build artifacts but keeps every test file in scope", () => {
    // dist/** is a build output and cannot be de-duplicated. An extension-wide
    // *.js ignore would be the tempting way to quiet test clones — and it would
    // silently un-check src/tests entirely, which is the regression this gate
    // exists to prevent.
    assert.ok(config.ignore.includes("dist/**"), "build artifacts stay out of the scan");
    const blind = config.ignore.filter((pattern) => pattern.replace(/^\*\*\//, "") === "*.js");
    assert.deepStrictEqual(
      blind,
      [],
      `a *.js ignore removes every test file from duplicate detection.\nGot: ${JSON.stringify(blind)}`,
    );
  });
});

// --- Task 08: strong types ----------------------------------------------------
// Primitive: `any` — the missing choke point. Every typed boundary uses
// `unknown` + narrowing (isEventRecord/eventField/errorMessage). A sanctioned
// exemption needs a named reason inline (Tenet 9); the list starts and stays
// empty — the whole point of the task is that it can.
describe("invariant: production code has no `any` (Task 08)", () => {
  rule({
    name: "no any annotation, cast, or generic in production sources",
    patterns: [/:\s*any\b|\bas\s+any\b|<any>|\bany\[\]/],
    sanctioned: [], // file-suffix → reason; none sanctioned.
    skip: [PROSE],
    doc: DOC_TYPES,
    why: "`any` reopens an unvalidated boundary — take `unknown` and narrow it.",
  });

  rule({
    name: "catch variables are never typed any",
    patterns: [/catch\s*\([^)]*:\s*any\s*\)/],
    doc: DOC_TYPES,
    why: "`catch (e: any)` opts out of useUnknownInCatchVariables — narrow unknown instead.",
  });
});
