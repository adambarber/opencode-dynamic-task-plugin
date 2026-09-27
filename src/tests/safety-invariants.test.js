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

import { describe, it, assert } from "./support/runner.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TESTS_DIR,
  REPO_ROOT,
  SRC_DIR,
  listProdFiles,
  listSourceFiles,
  listTestFiles,
  isTypeScript,
  isProductionOrSuite,
  walkSource,
  SOURCE_EXTENSIONS,
} from "./support/corpus.js";
import { buildToolMap } from "../../dist/tools/index.js";
import { ASSISTANT_ROLE } from "../../dist/shared/prompt.js";
import { TaskState, NoticeClaim } from "../../dist/shared/task-state.js";
import { NotifyKind } from "../../dist/shared/notify.js";
import { LedgerChangeKind } from "../../dist/shared/ledger-change.js";
import { InterruptScope } from "../../dist/tools/interrupt.js";
import { QuestionAction } from "../../dist/shared/question-handling.js";
import { FLOOR_LINES, FLOOR_TOKENS, corpus, findCrossBoundaryClones, importLines, shortPath } from "../../scripts/cross-boundary.mjs";

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
 * @param rule.also      further banned shapes, joined onto `patterns`. For a rule
 *                       whose banned set is COMPUTED (a list derived from the
 *                       production enums) rather than written out, so the
 *                       declaration stays one shape and the corpus check and the
 *                       failure text still come from here.
 */
function rule({ name, patterns, also = [], sanctioned = [], only = null, expect = 0, corpus = listProdFiles, skip = [], doc, why }) {
  it(name, () => {
    const files = corpus();
    const targets = only
      ? files.filter((f) => only.some((s) => f.endsWith(s)))
      : files.filter((f) => !sanctioned.some((s) => f.endsWith(s)));
    assert.ok(targets.length > 0, `rule "${name}" resolves to an empty corpus — a stale path or a typo in a sanction suffix`);
    const hits = targets.flatMap((f) => scanLines(f, [...patterns, ...also], skip));
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
// The cap overlay is a THIRD dance, and it is third deliberately: the other two
// write this plugin's own state, while the overlay is an operator's edit to
// policy that a dispatch path reads on every spawn. It needs the same
// write-temp-then-rename discipline, but it is a different kind of thing, and
// lumping it in with the ledger would make the exemption list claim the ledger's
// justification covers a file the ledger knows nothing about.
//
// `caps.ts`, because the overlay moved into the module that OWNS the cap concept
// when the key space changed from lanes to agents. One exemption, one file, and it
// names the concept rather than the feature that happened to be current.
const CAP_OVERLAY_DANCE = "caps.ts";
const SANCTIONED_DANCES = [...PERSISTENCE_DANCES, CAP_OVERLAY_DANCE];
const RAW_FILE_WRITE = gate(
  [/writeFileSync|renameSync|appendFileSync/],
  DOC_PERSISTENCE,
  "File write outside the atomic-write dances.",
  { sanctioned: SANCTIONED_DANCES },
);
const STATE_PATH_LITERAL = gate(
  [/"\.dynamic-task-(ledger|logs)/],
  DOC_PERSISTENCE,
  "State-path literal outside the dances (resolve via the host directory instead).",
  { sanctioned: SANCTIONED_DANCES },
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

// --- 16: the cap concept's chokepoint ---------------------------------------
//
// Primitive: the capacity judgment. Funnel: `checkAgentCapacity` in caps.ts
// answers ONE question, and `agentCapacityRefusal` in task-state.ts is the only
// thing allowed to ask it.
//
// Why it needs pinning rather than a comment. `withdrawInterruptClaim` used to
// spell the judgment out inline — same inputs, same answer, spelled a second
// time in the same file as the funnel that exists precisely so nobody spells it
// twice. It read correctly and would have kept working, and a per-agent cap would
// have been enforced by whichever of the two answers a given path happened to
// reach. This is a TOKEN gate, not containment: it sees a call by name, so a
// judgment inlined as arithmetic passes it. That is the standing limit of the
// line-scanner rules in this file and it is why the claim here is about the CALL,
// not about the arithmetic.
const CAP_JUDGMENT_CALL = /checkAgentCapacity\s*\(/;
const CAP_MODULE = "shared/caps.ts";
const CAP_FUNNEL = "shared/task-state.ts";
const THE_ONLY_CAP_JUDGMENT = gate(
  [CAP_JUDGMENT_CALL],
  "docs/tasks/16-per-agent-caps.md",
  "The cap judgment is called from exactly one place.",
);
rule({
  name: "exactly one call to the cap judgment, and it is the store's funnel",
  ...THE_ONLY_CAP_JUDGMENT,
  expect: 1,
  sanctioned: [CAP_MODULE],
});

// And the funnel itself must be the caller, not merely the count: deleting the
// funnel's call would leave the count at zero and pass the rule above, so the
// OWNERSHIP is stated rather than inferred from an arithmetic total.
const CAP_FUNNEL_BODY = /return checkAgentCapacity\(/;
it("the one call to the cap judgment is the store's capacity funnel", () => {
  const callers = listProdFiles()
    .filter((f) => !f.endsWith(CAP_MODULE))
    .filter((f) => scanLines(f, [CAP_JUDGMENT_CALL], []).length > 0);
  assert.deepEqual(callers, [listProdFiles().find((f) => f.endsWith(CAP_FUNNEL))],
    `the cap judgment is reached from ${callers.join(", ")} — every claim must ask the store, not the rule`);
  assert.ok(scanLines(listProdFiles().find((f) => f.endsWith(CAP_FUNNEL)), [CAP_FUNNEL_BODY], []).length === 1,
    "and the store must be the one calling it, not merely a file that mentions it");
});

// --- Task 06: persistence dance --------------------------------------------
// Primitive: durable file writes. Funnel: session-lifecycle.ts owns the
// atomic ledger dance; debug-logger.ts owns diagnostics appends (Tenet 6).
// No other module may write files.
describe("invariant: file writes funnel through ledger/logger dances (Task 06)", () => {
  rule({ name: "no writeFileSync/renameSync/appendFileSync outside sanctioned dances", ...RAW_FILE_WRITE });
});

// --- Task 06 amendment (2026-09-26 race finding): the temp path is shared --
// The atomic write is tmp-then-rename, which is what makes a crash leave the
// PREVIOUS complete ledger rather than a truncation. But a fixed `${file}.tmp`
// is one name shared by every writer that can see the directory, and the rename
// is where that collides: two opencode processes on one repo both write it, and
// whichever renames second finds the file already gone. Measured by racing two
// processes over 800 writes — 10 ENOENT out of the rename, against 0 of 400 in
// the single-process control.
//
// Not runtime-observable cheaply (the proof needs two processes, and this suite
// stays fast), so it is pinned as a source property instead. Note the direction:
// this is a "must contain" invariant, so it cannot use `rule()` — that helper
// asserts a BANNED shape, and a positive pattern read through it fails precisely
// when the code is right.
describe("invariant: the ledger's atomic write cannot collide between writers", () => {
  it("gives the ledger's temp path a per-process discriminator", () => {
    const source = readFileSync(path.join(SRC_DIR, "shared", "session-lifecycle.ts"), "utf8");
    const assignment = /^.*const tmpPath = .*$/m.exec(source)?.[0];
    assert.ok(assignment, "could not find the ledger's temp-path assignment in session-lifecycle.ts");
    assert.match(
      assignment,
      /process\.pid/,
      "the ledger temp path must carry a per-process discriminator. A fixed name is shared state\n" +
      "between every writer that can see the directory, and the rename is where that collides:\n" +
      "two opencode processes on one repo both write it and whichever renames second finds it\n" +
      "already gone. Measured by racing two processes over 800 writes — 10 ENOENT, against 0 of\n" +
      "400 single-process. It only misbehaves when a second process exists, so nothing in this\n" +
      `tree would notice the regression. Found: ${assignment}`,
    );
  });
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
// drift — admission.test.js carries its own agent-mode filter that contradicts
// the eed3a04 dispatchability fix it should pin.
describe("invariant: tests import production, never redefine it (Tenet 12)", () => {
  rule({ name: "no production-function copies in test files", ...TEST_LOCAL_PRODUCTION_COPY });
  rule({ name: "no stale subagent-only dispatch filter in tests", ...STALE_DISPATCH_FILTER });
});

/**
 * A record shape is declared once, in production, and the tests BUILD it there.
 *
 * This is the guard for a defect class the suite could not see. A test fixture
 * that spells a record out by hand is a second declaration of a shape with no
 * compiler over it, and it drifts in both directions at once: a fixture carrying a
 * field production deleted, and a fixture missing a field production requires.
 * Both were live here — a retained fixture kept `timeoutNotified` long after the
 * removal of `timeout_ms`, and an active fixture shipped a `lastNotice` with no
 * `claim`, which is the field the settlement reads to tell a blocked child from a
 * finished one, so a fixture used in a settlement would have settled a blocked
 * child as a success. 456 tests passed over both. jscpd cannot see either: it
 * pools TypeScript and JavaScript separately, so a test's copy of a production
 * shape is invisible to it by construction — the detector had to be written, which
 * is why it is here.
 *
 * The rule reads each interface's OWN field names out of the .ts source — required
 * ones included, `extends` followed — and then looks for an object literal in a
 * test file that spells all of them. A literal that carries every required field
 * is a restatement of the record, wherever it sits: the answer is to build it
 * through the production builder, not to have a second copy of the shape.
 */
const RECORD_SHAPES = [
  { name: "ActiveTaskState", file: "shared/task-state.ts" },
  { name: "RetainedTaskState", file: "shared/task-state.ts" },
  { name: "TaskResultRecord", file: "shared/task-formatting.ts" },
  { name: "NotificationRecord", file: "shared/notify.ts" },
  { name: "PendingDelivery", file: "shared/notify.ts" },
];

/** Every field an interface requires, following `extends` inside its own file. */
function requiredFieldsOf(file, name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const source = readFileSync(path.join(SRC_DIR, file), "utf8");
  const declaration = new RegExp(`(?:export )?interface ${name}\\b([^\\{]*)\\{`).exec(source);
  assert.ok(declaration, `${name} is not declared in ${file} — this rule reads a shape that no longer exists`);
  const open = declaration.index + declaration[0].length;
  let depth = 1;
  let close = open;
  for (let i = open; i < source.length && depth > 0; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    close = i;
  }
  const body = source.slice(open, close);
  const required = [...body.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\s*[?:]/gm)]
    .filter(([, field]) => !body.match(new RegExp(`^\\s*${field}\\s*\\?`, "m")))
    .map(([, field]) => field);
  const inherited = declaration[1].match(/extends\s+([A-Za-z][A-Za-z0-9]*)/);
  return inherited ? [...requiredFieldsOf(file, inherited[1], seen), ...required] : required;
}

/**
 * Every object literal in a source, with its top-level keys — the keys a
 * restatement of a record would spell. A key has to sit at the start of its own
 * line or just inside the brace, which is what keeps `foo.bar` from reading as a
 * key named `bar`; string keys count, because a restatement may quote them.
 */
function objectLiterals(source) {
  const KEY = /^\s*([A-Za-z][A-Za-z0-9]*|"[A-Za-z][A-Za-z0-9]*"|'[A-Za-z][A-Za-z0-9]*')\s*[:,]/;
  const literals = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "{") continue;
    let depth = 0;
    let keys = [];
    for (let j = i; j < source.length; j++) {
      const ch = source[j];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          if (keys.length > 0) literals.push({ offset: i, keys });
          i = j;
          break;
        }
      } else if (depth === 1 && "\"'`".includes(ch)) {
        for (j++; j < source.length && source[j] !== ch; j++) {
          if (source[j] === "\\") j++;
        }
      } else if (depth === 1) {
        const key = KEY.exec(source.slice(j, j + 80));
        // The character before the key has to end a token, or the "key" is the
        // tail of a longer one: in `foo.bar:` the scan reaches `bar` and must not
        // read it as a key.
        if (key && !/[\w.]/.test(j > 0 ? source[j - 1] : "")) {
          keys.push(key[1].replace(/["']/g, ""));
          j += key[0].length - 1;
        }
      }
    }
  }
  return literals;
}

describe("invariant: record shapes are built, not re-declared (Tenet 12)", () => {
  it("a test that spells out a whole record is rebuilding production's shape by hand", () => {
    const findings = [];
    for (const shape of RECORD_SHAPES) {
      const required = requiredFieldsOf(shape.file, shape.name);
      assert.ok(required.length >= 3, `${shape.name} yields only ${required.length} required field(s) — the extractor is not reading the shape`);
      for (const file of listTestFiles().concat([path.join(TESTS_DIR, "support", "records.js")])) {
        const source = readFileSync(file, "utf8");
        for (const literal of objectLiterals(source)) {
          if (!required.every((field) => literal.keys.includes(field))) continue;
          findings.push(
            `${path.relative(REPO_ROOT, file)}: ${shape.name} restated at line `
            + `${source.slice(0, literal.offset).split("\n").length} — build it with the production builder instead`,
          );
        }
      }
    }
    assert.deepStrictEqual(findings, [], `a record shape restated by hand:\n${findings.join("\n")}`);
  });
});

/**
 * A test must not spell a literal production already exports as a named constant.
 *
 * Both duplicate detectors here are blind to this by construction — the tokenizer
 * erases string contents, and the record rule looks at field names — so it needed
 * its own rule. Measured before the rule existed: twenty-two sites across four test
 * files restating `ASSISTANT_ROLE` and `UNKNOWN_PARENT`. The failure mode is the
 * quiet one in both cases. A mock message part that hardcodes `"assistant"` is a
 * message the plugin is entitled to ignore, and a test that builds one passes
 * anyway; a hardcoded env var configures nothing once it is renamed, and passes
 * anyway. Nothing goes red, which is what makes it worth a gate.
 *
 * The sanction list is the judgement, and it is deliberately short: the sites that
 * legitimately hold the literal are the ones whose SUBJECT is the literal — an
 * assertion that a role reads back as `"assistant"` pins the value, and a
 * rendered status is named (`UntrackedStatus`) rather than retyped, so a test
 * that pins one imports the name instead of the spelling. A site is added here
 * by someone who has read why it is not a restatement.
 */
describe("invariant: a test never retypes a bound production value (Tenet 12)", () => {
  const SANCTIONED = [
    // The value IS the claim: this asserts the role reads back as the literal.
    'messageRoleOf({ info: { role: ASSISTANT_ROLE }, parts: [] }), "assistant"',
    // Asserting the rendered word a parentless settlement prints.
    'answerSays(missing, "unknown")',
  ];


  /**
   * Every string production BINDS to a name, and where.
   *
   * Three forms, because the three that actually drifted were not the one this rule
   * used to read:
   *
   *   1. an exported const bound to a literal;
   *   2. a NON-exported const bound to a literal — DEBUG_DIR, the log directory, whose
   *      drift cost a reader resolving to a path that matched nothing;
   *   3. a const table row's direct string value — the notification tag, which is
   *      bound inside a declaration table rather than by a bare assignment.
   *
   * A table's ARRAY entries and quoted keys are deliberately NOT read. VALID_TRANSITIONS
   * holds `active: ["completed", "error", ...]` and that is a vocabulary, not a set of
   * decisions: a test that writes `transitionState(store, id, "completed")` is naming the
   * transition it exercises, and pinning the literal is what makes the test FAIL when the
   * vocabulary changes — routing it through a constant would leave the test unable to
   * fail at all. The same goes for a table KEY, which is a name the type declares.
   */
  function boundValues() {
    const bound = new Map();
    const add = (literal, name, file) => {
      // A literal that is a member of an invented vocabulary is a SPELLING of
      // that vocabulary, not a scalar decision — so a const over one is exempt.
      // `ERROR_ROLE = "error"` exists only to give a message role a name the
      // discriminant gate can require; it decides nothing. Without this exemption
      // every test that writes the state or notify value "error" is reported as
      // retyping it, which is the gate guessing which vocabulary a test meant —
      // and a gate that guesses is a gate that cries wolf. The comparison the
      // discriminant rule polices is unaffected: it reads the enums, not this map.
      if (DISCRIMINANT_VALUES.includes(literal)) return;
      // A literal with no distinguishing content is LAYOUT, not a decision. `CELL_GAP`
      // is two spaces, and a test that writes two spaces is writing prose — a
      // whitespace-only id, a blank-ish note — so binding it reported four unrelated
      // suites the moment the constant was introduced. Same principle as the vocabulary
      // exemption above and for the same reason: the rule exists to catch a test that
      // restates a production DECISION, and a run of spaces is not one.
      if (literal.trim() === "") return;
      if (literal.length > 1 && !bound.has(literal)) bound.set(literal, { name, file });
    };
    for (const file of listProdFiles()) {
      const source = readFileSync(file, "utf8");
      const forms = [
        // (1) and (2): a const bound to a bare string literal, exported or not.
        /(?:export\s+)?const\s+([A-Z_0-9]+)\s*(?::[^=]+)?=\s*"((?:[^"\\\n]|\\.)+)"/g,
      ];
      for (const pattern of forms) {
        for (const [, name, literal] of source.matchAll(pattern)) add(literal, name, file);
      }
      // (3): a const table's row values, located brace by brace so the scan cannot run
      // past the table into unrelated code.
      for (const m of source.matchAll(/(?:export\s+)?const\s+([A-Z_0-9]+)\s*(?::[^=]+)?=\s*\{/g)) {
        const start = m.index + m[0].length;
        let depth = 1;
        let end = start;
        while (end < source.length && depth > 0) {
          if (source[end] === "{") depth++;
          else if (source[end] === "}") depth--;
          end++;
        }
        for (const row of source.slice(start, end).matchAll(/([A-Za-z0-9_]+)\s*:\s*"((?:[^"\\\n]|\\.)+)"/g)) {
          add(row[2], `${m[1]}.${row[1]}`, file);
        }
      }
    }
    return bound;
  }

  /**
   * Every site in a test source that retypes a bound value, with the claims
   * already applied. A function rather than an inline loop so the probe below can
   * hand it a source of its own — a rule that can only ever be run on the real tree
   * cannot be shown to see anything.
   */
  function retypeFindings(source, constants) {
    const findings = [];
    const lines = source.split("\n");
    for (const [literal, owner] of constants) {
      let at = source.indexOf(`"${literal}"`);
      while (at >= 0) {
        const text = lines[source.slice(0, at).split("\n").length - 1];
        // A comment discussing the spelling is prose, not a second declaration of
        // it, and this file's rules already make that distinction everywhere else.
        const prose = /^\s*(\/\/|\*|\/\*)/.test(text);
        if (!prose && !SANCTIONED.some((reason) => text.includes(reason))) {
          findings.push(`line ${source.slice(0, at).split("\n").length} retypes ${owner.name} as "${literal}"`);
        }
        at = source.indexOf(`"${literal}"`, at + 1);
      }
    }
    return findings;
  }

  it("reports no retyped constant", () => {
    const constants = boundValues();
    assert.ok(constants.size > 20, `only ${constants.size} bound string values found — the extractor is not reading them`);
    const findings = [];
    for (const file of listTestFiles().concat([path.join(TESTS_DIR, "support", "harness.js"), path.join(TESTS_DIR, "support", "records.js")])) {
      for (const finding of retypeFindings(readFileSync(file, "utf8"), constants)) {
        findings.push(`${path.relative(REPO_ROOT, file)}: ${finding}`);
      }
    }
    assert.deepStrictEqual(findings, [], `a test retypes a production constant:\n${findings.join("\n")}`);
  });

  // A rule that cannot fail is a comment. This runs the same comparison over sources
  // written for the purpose, one per binding form, so each is shown to be reachable —
  // and the two negatives, because a rule that reads a vocabulary as a decision is
  // worse than no rule: it would push every state assertion through a constant.

  /**
   * The extracted constants, memoised, and a matcher over them.
   *
   * A FUNCTION rather than two `const`s at the describe body, because the extraction
   * reads `DISCRIMINANT_VALUES` and the describe body runs before that is initialised —
   * so calling it here is a temporal-dead-zone error, and calling it twice in two cases
   * is the copy the duplicate gate reported. Memoised on first use, the two cases below
   * read one extraction.
   */
  let extracted = null;
  const probe = () => (extracted ??= { constants: boundValues(), reported: (source) => retypeFindings(source, extracted.constants) });

  it("every binding form is reported, and neither prose nor a vocabulary is", () => {
    const { constants, reported } = probe();
    // A wire string the gate must be able to name, taken from the vocabulary
    // rather than retyped here, so this probe cannot go stale with the enums.
    const vocabularyMember = DISCRIMINANT_VALUES[0];
    // The probe values are DERIVED from what the extractor found, by the form that
    // found them — hardcoding them here would restate the very values this rule
    // exists to keep single, and a probe that copies its subject proves nothing.
    const byForm = (predicate) => [...constants].find(([, owner]) => predicate(owner.name))?.[0];
    const bareExport = byForm((name) => name === "ASSISTANT_ROLE");
    const bareLocal = byForm((name) => name === "DEBUG_DIR");
    const tableRow = byForm((name) => name.endsWith(".tag"));
    assert.ok(bareExport && bareLocal && tableRow, `expected all three binding forms in production, got ${[bareExport, bareLocal, tableRow]}`);
    // (1) exported const, (2) non-exported const, (3) a const table row value.
    assert.ok(reported(`const part = { info: { role: ${JSON.stringify(bareExport)} } };`).length > 0,
      "an exported const is reported");
    assert.ok(reported(`const dir = ${JSON.stringify(bareLocal)};`).length > 0,
      "a non-exported const is reported");
    assert.ok(reported(`const t = { tag: ${JSON.stringify(tableRow)} };`).length > 0,
      "a table row value is reported");
    // Negatives: prose about a spelling, and the state vocabulary a table enumerates.
    assert.deepStrictEqual(reported("// the reader wants the assistant turn", constants), [],
      "a comment discussing the spelling is prose, not a second declaration of it");
    assert.deepStrictEqual(reported(`const next = ["completed", "error", "blocked"];`, constants), [],
      "a table's array entries are a vocabulary a test may name, not decisions it may not restate");
    assert.deepStrictEqual(reported(`const role = ${JSON.stringify(vocabularyMember)};`, constants), [],
      `a const over an invented vocabulary's own wire string (${vocabularyMember}) is a spelling of ` +
      "that vocabulary, not a scalar decision; the discriminant gate polices the comparison instead");
    assert.deepStrictEqual(reported("const n = 1;", constants), [], "an unrelated source has nothing to report");
  });

  it("exempts a whitespace-only literal, and still reports a literal that merely CONTAINS one", () => {
    // The exemption is for layout, and it is the whole value that is exempt — so a
    // separator like `" | "` is still reported, because a test that retypes it is
    // restating a decision about how a row is drawn. Proving the boundary needs both
    // sides: exempt the pure-whitespace value, and keep a value with content in it.
    const { constants, reported: matches } = probe();
    const layout = [...constants].find(([, owner]) => owner.name === "CELL_GAP")?.[0];
    assert.equal(layout, undefined, "a whitespace-only constant is not bound at all, so it cannot cry wolf");
    const withContent = [...constants].find(([literal]) => literal.trim() !== "" && /\s/.test(literal))?.[0];
    assert.ok(withContent, "expected a bound constant whose value contains whitespace");
    assert.ok(matches(`const sep = ${JSON.stringify(withContent)};`).length > 0,
      `a value that CONTAINS whitespace is still a decision, and is reported (${JSON.stringify(withContent)})`);
    assert.deepStrictEqual(matches(`const pad = ${JSON.stringify(layout ?? "  ")};`), [],
      "and a pure-whitespace run is prose, not a restatement");
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

// --- The discriminant rule ----------------------------------------------------
// Every vocabulary this plugin INVENTS is an enum, so no call site compares a
// discriminant against a raw wire string.
//
// The reason is not style. A `reason.kind === "unknown-agent"` check compiles
// unchanged under a rename, and a newly added refusal falls through to whatever
// the final `else` was: both are defects that a green type check cannot see. The
// two failure modes this repo has already shipped — a renderer that re-derived
// what the producer knew, and a settlement announced as a success — are both
// instances of a tag compared as a string.
//
// The banned literals are read from the enums at test time rather than restated
// here, so this list cannot drift from the vocabularies it polices: add a member
// and the gate immediately covers its wire string. A tag assembled by string
// concatenation rather than a literal evades the pattern, which is the known and
// documented limit of a token-shape gate (the `any` rules above share it).
const DISCRIMINANT_VALUES = [
  ...Object.values(TaskState),
  ...Object.values(NotifyKind),
  ...Object.values(NoticeClaim),
  ...Object.values(LedgerChangeKind),
  ...Object.values(InterruptScope),
  ...Object.values(QuestionAction),
];

const RAW_TAG_COMPARISON = DISCRIMINANT_VALUES.map((value) => new RegExp(`(===|!==)\\s*"${value}"`));

describe("invariant: a discriminant is compared as a typed member, never a raw wire string", () => {
  it("covers every member of every enum this plugin invents", () => {
    assert.ok(
      DISCRIMINANT_VALUES.length >= 18,
      `the vocabulary resolved to ${DISCRIMINANT_VALUES.length} members — an import drifted and this rule is policing nothing`,
    );
  });

  rule({
    name: "no raw wire-string comparison against an invented vocabulary",
    patterns: RAW_TAG_COMPARISON,
    doc: "docs/tasks/08-strong-types.md",
    why:
      "A discriminant compared as a raw string compiles clean under a rename and lets a new\n" +
      "member fall through to whatever the final `else` was. Compare the enum member, or let\n" +
      "the value carry its own words (see AdmissionDenial, which has no discriminant at all).",
    skip: [PROSE],
  });
});
