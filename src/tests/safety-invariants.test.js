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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildToolMap } from "../../dist/tools/index.js";
import { ASSISTANT_ROLE } from "../../dist/shared/prompt.js";
import { FLOOR_LINES, FLOOR_TOKENS, corpus, findCrossBoundaryClones, shortPath } from "../../scripts/cross-boundary.mjs";

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
 * assertion that a role reads back as `"assistant"` pins the value, and a status
 * table's `"unknown"` is a host turn state, not the unnamed-parent sentinel those
 * two constants happen to share a spelling with. A site is added here by someone
 * who has read why it is not a restatement.
 */
describe("invariant: a test never retypes a bound production value (Tenet 12)", () => {
  const SANCTIONED = [
    // The value IS the claim: this asserts the role reads back as the literal.
    'messageRoleOf({ info: { role: ASSISTANT_ROLE }, parts: [] }), "assistant"',
    // A host turn state, not the unnamed-parent sentinel. Different vocabulary,
    // same spelling — which is exactly why a spelling-based rule needs a sanction.
    '["error", "unknown", false]',
    '["idle", "unknown", false]',
    '[null, "unknown", false]',
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
  it("every binding form is reported, and neither prose nor a vocabulary is", () => {
    const constants = boundValues();
    const reported = (source) => retypeFindings(source, constants);
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
    assert.deepStrictEqual(reported("const n = 1;", constants), [], "an unrelated source has nothing to report");
  });
});

/**
 * The gate jscpd structurally cannot be: duplication ACROSS the test/production
 * boundary. jscpd pools tokens per format, so a `.js` test is never compared to the
 * `.ts` it tests — measured, not assumed, in scripts/cross-boundary.mjs. That is
 * the class that bit twice in this tree, and it is why the rule above exists as a
 * separate scanner rather than as a lower jscpd threshold.
 *
 * In-process and no spawn, for the reason the earlier jscpd-spawning attempt did not
 * survive: a test that shells out is slow, exits on a signal, and reports a number
 * instead of a finding. This imports the same module the CLI prints from, so the
 * number a human reads and the number this fails on cannot come from two
 * implementations.
 */
describe("invariant: no duplication across the test/production boundary (Tenet 12)", () => {
  it("a test and the production it tests share no run at or above the measured floor", () => {
    // "Zero findings" is only a result if there was something to find, so the
    // corpus is proved non-empty first. A renamed directory or a tokenizer that
    // started returning nothing would otherwise turn this gate green by removing
    // its own subject, which is the failure mode a passing assertion invites.
    const { tests, production, tokens } = corpus();
    assert.ok(tests > 0 && production > 0, `the corpus is empty — ${tests} test files, ${production} production files`);
    assert.ok(tokens > 10_000, `only ${tokens} comparable tokens found — the tokenizer is not reading the tree`);

    const findings = findCrossBoundaryClones();
    const sites = findings.map(
      (f) => `  - ${f.tokens}T / ${f.lines}L  ${shortPath(f.test)}:${f.lineA}  ↔  ${shortPath(f.prod)}:${f.lineB}`,
    );
    assert.deepStrictEqual(sites, [], `a test shares code with production above ${FLOOR_TOKENS} tokens / ${FLOOR_LINES} lines:\n${sites.join("\n")}`);
  });

  // A floor is only meaningful if the detector can still see. This pins the
  // detection, not the cleanliness: two files on opposite sides of the boundary
  // holding the same body must be reported, whatever the floor is. The probe lives
  // in a temp directory and is passed in as the corpus, so the tree is never
  // touched and the detector's own default corpus is never what is being tested.
  it("the detector still reports a shared body across the boundary", () => {
    const body = [
      "export const probe = (record) => {",
      "  const a = record.childSessionId;",
      "  const b = record.parentSessionId;",
      "  return a.length > b.length ? a : b;",
      "};",
    ].join("\n");
    const dir = mkdtempSync(path.join(tmpdir(), "dt-cross-boundary-"));
    const prod = path.join(dir, "probe.ts");
    const test = path.join(dir, "probe.js");
    try {
      writeFileSync(prod, body);
      writeFileSync(test, body);
      const findings = findCrossBoundaryClones({ tests: [test], production: [prod] });
      assert.ok(findings.length > 0, "identical bodies on opposite sides of the boundary must be reported");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("enforces zero tolerance at 3 lines / 14 tokens", () => {
    const loosened = [
      ["threshold", 0],
      ["minLines", 3],
      ["minTokens", 14],
    ].filter(([key, expected]) => config[key] !== expected);
    assert.deepStrictEqual(
      loosened.map(([key, expected]) => `${key} is ${config[key]}, not ${expected}`),
      [],
      `duplicate gate loosened. The history is one of eliminating clones, never of\n` +
        `moving the bar to hide them: 3/20 reported 43 real clones when it was adopted,\n` +
        `3/15 reported 67, 3/12 reported 10, and 2/20 reported 86 more arrangements\n` +
        `below the line floor — including 26 hand-rolled queries into the test\n` +
        `harness's recorded state, now behind named readers. 3/16 was the tree's clean\n` +
        `level at the time it was measured; 3/14 is the tree's clean level now, after\n` +
        `the record shapes were built by production instead of by hand. The number is\n` +
        `a MEASUREMENT, so it has to be re-measured and re-pinned when it stops holding\n` +
        `rather than left to drift: 3/13 is not clean, and the 13 it reports is two\n` +
        `type-predicate preambles — \`function isX(v: unknown): v is Y { if (!isEventRecord(v))\n` +
        `return false; }\` — a structural idiom whose remainder is each predicate's own\n` +
        `fields. Factoring that would mean inventing a generic type-guard combinator,\n` +
        `which is the helper-per-expression this rule exists to prevent.`,
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
