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

// The timer primitives: any wall-clock wait in production. A file whitelist
// grants an exemption, not an open door.
const TIMER_PRIMITIVE = /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/;

// Tenet 9: prompt.ts owns child prompts (Task 03 dance), notify.ts owns parent
// writes (Task 05 gate). The legacy index-level helper is gone — no sanctioned
// spans remain.
const PROMPT_CALL = /client\.session\.prompt\s*\(/;

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

/**
 * A banned spelling, with the doctrine note and the claim it enforces. The three
 * travel together because they are one gate: a rule that answers to the wrong
 * note sends a reader of a red run to the wrong argument, and 14 rows were each
 * re-typing which note they answered to. What a rule still has to say is WHERE
 * it is read — the scope, which is the only part that genuinely varies.
 */
const gate = (patterns, doc, why, extra = {}) => ({ patterns, doc, why, ...extra });

// (?!=) excludes == / === reads: only real assignments are bypasses. Lifecycle
// fields (state/abortError/lastAbortAt/lastNotice/lastActivityAt/replacedAt/
// turnLiveAt) belong to the state machine alone: outside task-state.ts they may
// be read, never written.
const LIFECYCLE_MUTATION = gate(
  [
    /activeTasks\s*\.\s*(set|delete)|retainedTasks\s*\.\s*(set|delete)|\.\s*completed\s*=(?!=)|\.\s*timeoutNotified\s*=(?!=)|\.(state|abortError|lastAbortAt|lastNotice|lastActivityAt|replacedAt|turnLiveAt)\s*=(?!=)/,
  ],
  DOC_LIFECYCLE,
  "Direct task-state mutation bypasses transitionState's matrix.",
);
const CLOCK_OWNERS = ["notify.ts", "execution-bound.ts"];
const WALL_CLOCK_WAIT = gate(
  [TIMER_PRIMITIVE],
  DOC_SETTLEMENT,
  "A wall-clock wait returned outside a bound funnel.",
  { sanctioned: CLOCK_OWNERS },
);
// Two owners, one timer each: the notification retry's backoff and the deadline
// in withBound. A second timer-shaped call in either means a new clock entered
// the settlement layer.
const CLOCK_OWNER_COUNT = gate(
  [TIMER_PRIMITIVE],
  DOC_SETTLEMENT,
  "The clock owners hold exactly one wall-clock wait apiece (defaultSleep, withBound).",
);
const CHILD_SESSION_CREATE = gate(
  [/client\.session\.create\s*\(/],
  DOC_SETTLEMENT,
  "Child sessions must be created only by the spawn executor.",
);
const CHILD_SESSION_ABORT = gate(
  [/client\.session\.abort\s*\(/],
  DOC_SETTLEMENT,
  "Abort only via abortSession, so 404-versus-transport failure cannot drift between the steer and interrupt paths.",
);
const DELETED_TIMER_VOCABULARY = gate(
  [/\btimeout_ms\b|\btimeoutBehavior\b|\bawait_response\b|\btimed_out_retained\b|\bcompleted_after_timeout\b|\bDYNAMIC_TASK_TIMEOUT\b|\bcreateTimerProvider\b|\bstealTimeoutHandle\b/],
  DOC_SETTLEMENT,
  "Pre-cutover timer vocabulary reappeared in production source.",
);
const PARENT_OR_CHILD_WRITE = gate(
  [PROMPT_CALL],
  DOC_NOTIFY,
  "Direct session.prompt call sites (child prompts via invokePrompt, parent writes via notifyParent).",
);
const THE_ONLY_PARENT_WRITE = gate(
  [PROMPT_CALL],
  DOC_NOTIFY,
  "The notification gate owns exactly one parent write.",
);
const LEGACY_NOTIFY_HELPER = gate([/notifyParentSession/], DOC_NOTIFY, "Legacy helper (notify via the gate).");
const THE_ONLY_NOTIFY_OWNER = gate(
  [/function\s+notifyParent\w*\s*\(/],
  DOC_NOTIFY,
  "Exactly one parent-notification owner.",
);
const PERSISTENCE_DANCES = ["session-lifecycle.ts", "debug-logger.ts"];
const RAW_FILE_WRITE = gate(
  [/writeFileSync|renameSync|appendFileSync/],
  DOC_PERSISTENCE,
  "File write outside the atomic-write dances.",
  { sanctioned: PERSISTENCE_DANCES },
);
const STATE_PATH_LITERAL = gate(
  [/"\.dynamic-task-(ledger|logs)/],
  DOC_PERSISTENCE,
  "State-path literal outside the dances (resolve via the host directory instead).",
  { sanctioned: PERSISTENCE_DANCES },
);
const ADMISSION_BYPASS = gate(
  [/registerActiveTask\s*\(|validateAgent\s*\(|validateLineage\s*\(|\bagents\s*\.\s*find\s*\(/],
  DOC_ADMISSION,
  "Direct admission calls (each must route via admitSpawn).",
  { skip: [/function\s+(registerActiveTask|validateAgent|validateLineage)\s*\(/] },
);
const ANY_ANNOTATION = gate(
  [/:\s*any\b|\bas\s+any\b|<any>|\bany\[\]/],
  DOC_TYPES,
  "`any` reopens an unvalidated boundary — take `unknown` and narrow it.",
  { sanctioned: [], skip: [PROSE] },
);
const CATCH_ANY = gate(
  [/catch\s*\([^)]*:\s*any\s*\)/],
  DOC_TYPES,
  "`catch (e: any)` opts out of useUnknownInCatchVariables — narrow unknown instead.",
);
const HARNESS_EVENT_NAME = gate(
  [/\btype:\s*"(session|question|message|permission|file|storage|project|install)\./],
  DOC_FIDELITY,
  "A fixture that invents a host event name certifies a gate that listens for it.",
  { corpus: () => [path.join(TESTS_DIR, "support", "harness.js")], skip: [PROSE] },
);
const PRODUCTION_EVENT_NAME = gate(
  [/\btype:\s*"(session|question|message|permission|file|storage|project|install)\./],
  DOC_FIDELITY,
  "A host event name spelled in production bypasses the chokepoint that makes it checkable.",
  { skip: [PROSE] },
);
// question-handling.ts owns the linkage state AND the two endpoints, so both
// question gates sanction the same file: it is a fact about the module, not a
// choice either rule makes for itself.
const QUESTION_GATE_OWNER = ["question-handling.ts"];
const QUESTION_LINKAGE_OWNER = gate(
  [/questionIdToSessionId|questionSessions/],
  DOC_QUESTIONS,
  "Question linkage state outside the gate module.",
  { sanctioned: QUESTION_GATE_OWNER },
);
const QUESTION_ENDPOINT_FUNNEL = gate(
  [/client\.question\s*\.\s*(reply|reject)\s*\(/],
  DOC_QUESTIONS,
  "Direct question reply/reject bypasses the resolve-then-validate gate.",
  { sanctioned: QUESTION_GATE_OWNER },
);
const TEST_LOCAL_PRODUCTION_COPY = gate(
  [/^\s*(async\s+)?function\s+(buildAgentList|validateSessionResult|extractTextFromParts|resolveParentSessionId|fetchAgents|getMessageCount|readSessionMessages|truncateText|registerBackgroundTask|handleChildLifecycleEvent)\s*\(/],
  DOC_FIDELITY,
  "Test-local copies of production functions — import from dist/ instead.",
  { corpus: listTestFiles },
);
const STALE_DISPATCH_FILTER = gate(
  [/===\s*["']subagent["']/],
  DOC_FIDELITY,
  "Stale dispatch filter — production accepts 'subagent'+'all' (isDispatchableAgent); import it instead.",
  // Self-exclusion: this file discusses the banned pattern in prose.
  { sanctioned: ["safety-invariants.test.js"], corpus: listTestFiles },
);

// --- Task 01: lifecycle funnel -------------------------------------------
// Primitive: task-state mutation. Funnel: src/shared/task-state.ts owns every
// Map write and every completed/timeoutNotified assignment (Tenets 1, 3, 5).
describe("invariant: lifecycle mutations funnel through task-state (Task 01)", () => {
  rule({ name: "no raw store/flag mutation outside task-state.ts", ...LIFECYCLE_MUTATION, sanctioned: ["task-state.ts"] });
});

// --- Task 09: non-blocking settlement -------------------------------------
// Primitive: waiting on child work / per-call execution bounds. The cutover
// deleted the timer funnel; the ONLY sanctioned wall-clock wait in production
// is the notification gate's fixed retry backoff (notify.ts). Everything else
// is unrepresentable by invariance, and the deleted vocabulary may not return.
describe("invariant: settlement is event-driven, no per-call clocks (Task 09)", () => {
  // No lookbehind exemptions: any setTimeout-shaped call fails outside the two
  // clock owners — including globalThis.*. The two gates are one banned spelling
  // read two ways: zero outside the owners, exactly one apiece inside them.
  rule({ name: "no bare wall-clock waits outside the bound funnels", ...WALL_CLOCK_WAIT });
  rule({ name: "each clock owner keeps exactly one timer-shaped call site", ...CLOCK_OWNER_COUNT, only: CLOCK_OWNERS, expect: 2 });

  // Tenet 9: create lives in the spawn executor — the ONLY site, because a
  // created session nobody registered runs unmonitored. Abort is funnelled
  // in session-lifecycle: the await stays at the call site that orders it
  // (steer beside its claim, interrupt beside its settle, spawn beside its
  // cleanup), but what a failure MEANS is decided once.
  rule({ name: "child sessions are created only by the spawn executor", ...CHILD_SESSION_CREATE, sanctioned: ["tools/spawn.ts"] });
  rule({ name: "child sessions are aborted only via abortSession", ...CHILD_SESSION_ABORT, sanctioned: ["shared/session-lifecycle.ts"] });

  // The SDK client resolves to { data, request, response }, so unwrapping it is
  // a transport fact, and a reader that reads a level too high fails by
  // finding nothing rather than by throwing — three readers had three private
  // ladders for it before hostPayload existed. The ladder must live in exactly
  // one place, so this rule scans the WHOLE tree and then checks where the one
  // hit is: a whitelist alone would filter a reader's own ladder out of the
  // corpus and report green.
  it("the host response envelope is unwrapped in exactly one place", () => {
    const hits = listProdFiles().flatMap((f) => scanLines(f, [/\[\s*"(data|body|agents)"\s*,\s*"(data|body|agents)"/], [PROSE]));
    assert.strictEqual(hits.length, 1, `Expected 1 envelope ladder, found ${hits.length}.\n${hits.join("\n")}`);
    assert.ok(hits[0].startsWith("src/shared/session-lifecycle.ts:"), `hostPayload owns the envelope: ${hits[0]}`);
  });

  rule({
    name: "deleted timer vocabulary never returns",
    ...DELETED_TIMER_VOCABULARY,
  });
});

// Tenet 12. The question gate shipped matching `question.created`, an event no
// host version publishes, and the suite stayed green because a FIXTURE invented
// it: the fixture asserted the gate answered, the gate answered the fixture, and
// neither party had ever spoken to a host. That failure is not a typo — it is a
// missing chokepoint, and the chokepoint in production (host-events.ts, every
// name `satisfies Event["type"]`) cannot reach a name the suite invents for
// itself.
//
// So the harness draws its event types from production. Scoped to the fixture
// layer on purpose, because the asymmetry is real: a fixture name that no host
// publishes makes a BROKEN gate look covered, which is the failure that shipped,
// while a unit test's hand-written input to a pure reader can only fail loudly —
// the reader it feeds is production code keyed on the pinned constant, so a
// divergent literal returns "" and the assertion breaks. The fixture is the only
// place where both halves of the assertion are under the test's own control.
describe("invariant: the host model invents no event names (Tenet 12)", () => {
  // One spelling, two readers, and the asymmetry is the reason both exist: a
  // fixture name that no host publishes makes a BROKEN gate look covered, which
  // is the failure that shipped, while production is a chokepoint everyone must go
  // through. The pattern is identical; what differs is who is being read.
  rule({ name: "the harness spells no host event type — it imports the pinned ones", ...HARNESS_EVENT_NAME });
  rule({ name: "production pins every host event name against the SDK union", ...PRODUCTION_EVENT_NAME });
});

// --- Task 03: prompt/hydration dance ---------------------------------------
// Primitive: client.session.prompt. Until the Task 03 dance module exists
// there is no sanctioned caller — every site is reported so the migration
// has a complete list (Tenets 1, 6).
describe("invariant: session.prompt flows through funnels (Tasks 03/05)", () => {
  // The same call site, read two ways: nothing but the two funnels, and exactly
  // one write inside the notification gate — which is the only parent write the
  // plugin is allowed to make.
  rule({ name: "no direct client.session.prompt outside prompt.ts and notify.ts", ...PARENT_OR_CHILD_WRITE, sanctioned: ["prompt.ts", "notify.ts"] });  rule({ name: "the gate holds exactly one parent-write call", ...THE_ONLY_PARENT_WRITE, only: ["notify.ts"], expect: 1 });
  rule({ name: "no legacy notifyParentSession helper remains", ...LEGACY_NOTIFY_HELPER });
});

// --- Task 04: question gate ------------------------------------------------
// Primitive: answering child questions. Funnel: question-handling.ts owns the
// only client.question.reply/reject calls (Tenets 1, 4).
describe("invariant: question reply/reject funnel through question-handling (Task 04)", () => {
  // One decision over two subjects: question-handling.ts owns the linkage state
  // AND the two endpoints, so both gates sanction the same file and answer to the
  // same doctrine note.
  rule({ name: "linkage map lives in the gate module only", ...QUESTION_LINKAGE_OWNER });
  rule({ name: "no direct client.question.reply/reject outside question-handling.ts", ...QUESTION_ENDPOINT_FUNNEL });
});

// --- Task 05: notification gate --------------------------------------------
// Primitive: parent-directed writes. Structure rule: exactly one function
// owns them (notifyParentSession) until the Task 05 gate subsumes it
// (Tenets 1, 6).
describe("invariant: one parent-notification owner (Task 05)", () => {
  rule({ name: "exactly one notifyParent* function exists", ...THE_ONLY_NOTIFY_OWNER, expect: 1 });
});

// --- Task 06: persistence dance --------------------------------------------
// Primitive: durable file writes. Funnel: session-lifecycle.ts owns the
// atomic ledger dance; debug-logger.ts owns diagnostics appends (Tenet 6).
// No other module may write files.
describe("invariant: file writes funnel through ledger/logger dances (Task 06)", () => {
  rule({ name: "no writeFileSync/renameSync/appendFileSync outside sanctioned dances", ...RAW_FILE_WRITE });
});

// --- Task 06 amendment (2026-09-11 smoke finding): state scoping -----------
// The poisoned repo ledger came from state paths resolved against the
// process CWD. tsc now forces every caller to pass a path, but string
// literals can re-establish CWD roots silently — the names belong to the
// two persistence dances, nowhere else.
describe("invariant: durable state paths derive from the project directory", () => {
  rule({ name: "no bare state-file/dir literals outside the ledger/logger dances", ...STATE_PATH_LITERAL });
});

// --- Task 07: admission gate ------------------------------------------------
// Primitive: spawn admission. Until the Task 07 gate exists there is no
// sanctioned caller of registration/validation — every site is reported
// (Tenets 3, 4).
describe("invariant: spawn admission flows through one gate (Task 07)", () => {
  // Tenet 9: admission.ts IS the gate — its own definitions are the funnel, so
  // they are skipped rather than sanctioned: this rule is about CALLS.
  rule({ name: "no direct register/validate/agent-find outside the admission gate", ...ADMISSION_BYPASS, sanctioned: ["admission.ts"] });
});

// --- Tenet 12: pin contracts with the real primitive ------------------------
// Tests must import production code from dist/, never re-define it. Copies
// drift — plugin.test.js carries its own agent-mode filter that contradicts
// the eed3a04 dispatchability fix it should pin.
describe("invariant: tests import production, never redefine it (Tenet 12)", () => {
  rule({ name: "no production-function copies in test files", ...TEST_LOCAL_PRODUCTION_COPY });
  rule({ name: "no stale subagent-only dispatch filter in tests", ...STALE_DISPATCH_FILTER });
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
// The thresholds are not taste. 3 lines / 16 tokens is the strictest level this
// tree passes, and it passes because every clone it reported was ELIMINATED
// rather than tolerated: 43 at 3/20 when that level was adopted (7 in
// production, 36 in tests), 67 at 3/15 when that one was (16 production, 51
// tests), 10 more at 3/12, and 86 more at 2/20. Every one of them was a
// restated decision, and the three declarations of ChildRef, the two
// hand-written copies of a question's rejection classification, the four
// spellings of a retained record in the test suites, and 21 invariant rules
// that each re-typed which doctrine note they answer to were each one place to
// change a shape that had a single owner. The shape of the fixes is the point: a
// clone is eliminated by giving the repeated idea ONE home, never by rewording a
// line until the tokenizer stops matching. So the gate is pinned here: loosening
// it is a deliberate edit to a test that says what re-opens, not a quiet edit to
// a config file.
//
// 16 is the frontier, not a round number, and it is a TOKEN floor for a reason.
// Measured on this tree: 3/10 reports 142 hits, 3/12 reports 10, 3/15 reports 67
// at 2 lines... the climb is not monotone in either axis, because the two axes
// are measuring different things. The LINE axis is what caught real
// duplication: the 86 clones at 2/20 were arrangements of two lines that the
// 3-line floor was blind to, and among them were 26 sites each hand-rolling a
// query into the test harness's private recorded state
// (`filter((p) => p.to === id)`, `p.body.parts[0].text`, `aborted.includes(id)`)
// — 26 places to keep in step with one body shape, and a wrong predicate that
// still passes because the common assertion is "this did NOT happen". That is
// the level the gate exists to demand, and it is now behind named readers on
// the harness. Below 16 TOKENS the tokenizer matches expression SHAPE rather
// than a decision (`return out.timedOut ? X : Y`, a ternary over two record
// fields, two readers composed with the same named predicate), and eliminating
// those means inventing a helper per expression — the opposite of naming a
// decision once.
describe("invariant: the duplicate-detection gate stays where the tree passes", () => {
  const config = JSON.parse(readFileSync(path.join(REPO_ROOT, ".jscpd.json"), "utf8"));

  it("enforces zero tolerance at 3 lines / 16 tokens", () => {
    const loosened = [
      ["threshold", 0],
      ["minLines", 3],
      ["minTokens", 16],
    ].filter(([key, expected]) => config[key] !== expected);
    assert.deepStrictEqual(
      loosened.map(([key, expected]) => `${key} is ${config[key]}, not ${expected}`),
      [],
      `duplicate gate loosened. 3/20 reported 43 real clones when it was adopted,\n` +
        `3/15 reported 67, 3/12 reported 10, and 2/20 reported 86 more arrangements\n` +
        `below the line floor — including 26 hand-rolled queries into the test\n` +
        `harness's recorded state, now behind named readers. 3/16 is the tree's\n` +
        `actual clean level, reached by eliminating the clones, never by moving the\n` +
        `bar to hide them. At 3/10 the 142 hits are expression shapes, not restated\n` +
        `decisions: below 16 tokens the gate would demand a helper per expression,\n` +
        `which is the thing this rule exists to prevent.`,
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

  // The scan itself runs in the gate `npm test` performs, ahead of the suite —
  // see the test script. A threshold pinned here and never executed is a
  // comment; the script is what makes duplication a failing run.
});

// --- Task 08: strong types ----------------------------------------------------
// Primitive: `any` — the missing choke point. Every typed boundary uses
// `unknown` + narrowing (isEventRecord/eventField/errorMessage). A sanctioned
// exemption needs a named reason inline (Tenet 9); the list starts and stays
// empty — the whole point of the task is that it can.
describe("invariant: production code has no `any` (Task 08)", () => {
  // sanctioned: [] — file-suffix → reason; none sanctioned.
  rule({ name: "no any annotation, cast, or generic in production sources", ...ANY_ANNOTATION });
  rule({ name: "catch variables are never typed any", ...CATCH_ANY });
});
