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
 *
 * The scan-and-assert funnel every rule below is written against lives in
 * `support/invariant-gate.js`; this file is the rules themselves.
 */

import path from "node:path";
import {
  DOC_ADMISSION,
  DOC_FIDELITY,
  DOC_LIFECYCLE,
  DOC_NOTIFY,
  DOC_PERSISTENCE,
  DOC_QUESTIONS,
  DOC_SETTLEMENT,
  DOC_TYPES,
  PROMPT_CALL,
  PROSE,
  TIMER_PRIMITIVE,
  gate,
  rule,
  scanLines,
} from "./support/invariant-gate.js";
import { REPO_ROOT, SRC_DIR, TESTS_DIR, listProdFiles, listTestSupportFiles } from "./support/corpus.js";
import { assert, describe, it } from "./support/runner.js";
import { buildToolMap } from "../../dist/tools/index.js";
import { readFileSync } from "node:fs";

// (?!=) excludes == / === reads: only real assignments are bypasses. Lifecycle
// fields (state/abortError/lastAbortAt/lastNotice/lastActivityAt/replacedAt/
// turnLiveAt) belong to the state machine alone: outside task-state.ts they may
// be read, never written.
//
// The rule used to ban `activeTasks.set` and `retainedTasks.delete` here too, and
// that half is GONE — not relaxed, gone. TaskStore is a class now (src/shared/
// store.ts) with `#private` maps, so a direct write to either is a type error
// rather than a spelling, and src/tests/type-invariants.ts asserts exactly that
// with @ts-expect-error: reopen a map and `npx tsc --noEmit` fails on the unused
// directive. A regex could not tell a write from a mention of one — it had already
// fired on a docblock quoting the shape — and it only ever guarded this file
// boundary, so inside the file that owned the funnel nothing was enforced. What
// remains is the half no type system reaches: reassigning a field ON a record
// that was read out of the store.
const LIFECYCLE_MUTATION = gate(
  [
    /\.\s*completed\s*=(?!=)|\.\s*timeoutNotified\s*=(?!=)|\.(state|abortError|lastAbortAt|lastNotice|lastActivityAt|replacedAt|turnLiveAt)\s*=(?!=)/,
  ],
  DOC_LIFECYCLE,
  "Direct task-state mutation bypasses transitionState's matrix.",
);
// An unknown throwable becomes words through `errorMessage` and NOWHERE ELSE.
// Three sites had answered that question themselves: two hand-rolled
// `error instanceof Error ? … : String(…)`, and one that used the same narrowing
// as its CONDITION and so stayed silent for every throw that was not an `Error` —
// the agent-list fetch, whose one log is how an uncapped or unlistable agent gets
// diagnosed at all. The two coercions agreed with the funnel for everything their
// own catches can see (JSON.parse and fs throw Errors), so this was latent rather
// than live, which is exactly the kind of defect a rule exists to retire in place
// of a fix somebody has to remember.
//
// Token-shape deterrence, not structural containment (see the standing note on
// regex invariants): a site that renames its binding or reaches for a different
// coercing helper would pass. The type system cannot reach this one — narrowing
// an `unknown` to `Error` is legal, correct TypeScript, which is why the rule is
// the only place it can be closed.
const ERROR_TO_WORDS = gate(
  [/instanceof\s+Error/, /String\(\s*error\s*\)/],
  DOC_TYPES,
  "A throwable becomes words outside errorMessage, so the answer is a second opinion.",
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
const PERSISTENCE_DANCES = ["task-ledger.ts", "debug-logger.ts"];
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

// --- Task 01: lifecycle funnel -------------------------------------------
// Primitive: task-state mutation. Funnel: src/shared/task-state.ts owns every
// Map write and every completed/timeoutNotified assignment (Tenets 1, 3, 5).
describe("invariant: lifecycle mutations funnel through task-state (Task 01)", () => {
  rule({
    name: "an unknown becomes words only through errorMessage",
    ...ERROR_TO_WORDS,
    sanctioned: ["host-shape.ts"],
  });
  rule({
    name: "no raw record mutation outside the settlement funnels",
    ...LIFECYCLE_MUTATION,
    // The files that OWN the funnel, not exemptions. `task-state.ts` holds the
    // lifecycle matrix, `settled-record.ts` the settled amendment, and
    // `notice-claim.ts` the advisory writers — and those writers assign ONLY
    // inside lambdas handed to the funnel (`annotateActive`), never directly.
    // The corpus is every production file, so a fourth sanctioned file would
    // have to be added on purpose.
    sanctioned: ["task-state.ts", "settled-record.ts", "notice-claim.ts"],
  });
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
  rule({ name: "each clock owner keeps exactly one timer-shaped call site", ...CLOCK_OWNER_COUNT, expect: 2, only: CLOCK_OWNERS });

  // Tenet 9: create lives in the spawn executor — the ONLY site, because a
  // created session nobody registered runs unmonitored. Abort is funnelled
  // in session-abort: the await stays at the call site that orders it
  // (steer beside its claim, interrupt beside its settle, spawn beside its
  // cleanup), but what a failure MEANS is decided once.
  rule({ name: "child sessions are created only by the spawn executor", ...CHILD_SESSION_CREATE, sanctioned: ["tools/spawn.ts"] });
  rule({ name: "child sessions are aborted only via abortSession", ...CHILD_SESSION_ABORT, sanctioned: ["shared/session-abort.ts"] });

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
    assert.ok(hits[0].startsWith("src/shared/host-events.ts:"), `hostPayload owns the envelope: ${hits[0]}`);
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
  rule({ name: "no direct client.session.prompt outside prompt.ts and notify.ts", ...PARENT_OR_CHILD_WRITE, sanctioned: ["prompt.ts", "notify.ts"] });
  rule({ name: "the gate holds exactly one parent-write call", ...THE_ONLY_PARENT_WRITE, expect: 1, only: ["notify.ts"] });
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
// Primitive: durable file writes. Funnel: task-ledger.ts owns the
// atomic ledger dance; debug-logger.ts owns diagnostics appends (Tenet 6).
// No other module may write files.
describe("invariant: file writes funnel through ledger/logger dances (Task 06)", () => {
  rule({ name: "no writeFileSync/renameSync/appendFileSync outside sanctioned dances", ...RAW_FILE_WRITE });
});

// The file era's collision, closed by construction (#3078): every durable write was a
// whole-file rewrite, so two opencode processes on one project each persisted the file
// from their own in-memory maps and alternately destroyed each other's running-task
// records — 10 of 800 renames raced away with ENOENT, and the pid-qualified temp path
// that papered over it made the loss QUIETER rather than rarer. Per-key storage removes
// the shared name: there is no file, no temp sidecar, and no key two processes mean
// differently, because a key ends in the record's own identity.
//
// Pinned as a source property, because the proof needs two processes and this suite
// stays fast. The direction matters: this is a "must be built through" invariant, so it
// cannot use `rule()` — that helper asserts a BANNED shape, and a positive pattern read
// through it fails precisely when the code is right.
describe("invariant: every durable ledger write is addressed through one key layout", () => {
  const LEDGER = readFileSync(path.join(SRC_DIR, "shared", "ledger-storage.ts"), "utf8");

  it("builds every key through LEDGER_KEYS, which ends in the record's own identity", () => {
    const writes = [...LEDGER.matchAll(/facade\.(put|drop)\((?<args>[^;]*?)\);/gs)]
      .map((match) => match.groups.args.trim())
      .filter((args) => !args.startsWith("LEDGER_KEYS."));
    assert.deepEqual(
      writes,
      [],
      "a durable write that spells its own key is a second key layout, and the whole claim\n" +
        "of per-key storage is that two processes cannot address one key for two records.\n" +
        `Spelled out here: ${writes.join(" | ")}`,
    );
  });

  it("names no ledger key by anything but the child, or the notice's own digest", () => {
    assert.equal(
      [...LEDGER.matchAll(/`\$\{ROOT\}/g)].length,
      3,
      "the root belongs to the three prefixes and nowhere else. A fourth use means a key is\n" +
        "being built somewhere other than LEDGER_PREFIXES, and that is the drift this pin is for.",
    );
    assert.match(LEDGER, /digest\("hex"\)/, "a notice key must be a digest of the notice itself, not of its child");
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
    const map = buildToolMap({});
    const registered = new Set(Object.keys(map));
    for (const [name, info] of Object.entries(map)) {
      assert.strictEqual(info.options?.codemode, false, `${name} must be a direct tool: a catalog-only tool answers a direct call with "No tool named", which silenced a live child`);
    }
    const readme = readFileSync(path.join(REPO_ROOT, "README.md"), "utf8").split("\n");
    const headerIdx = readme.findIndex((l) => l.startsWith("| Tool |"));
    const documented = new Set();
    for (let i = headerIdx + 2; i < readme.length; i++) {
      const m = readme[i].match(/^\|\s*`(?<tool>\w+)`/);
      if (!m) break;
      documented.add(m.groups.tool);
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
      `README ↔ dist/tools/index.js capability drift.\nOwning doc: docs/tasks/00-fidelity-ground-truth.md\n${ 
        drift.map((d) => `  - ${d}`).join("\n")}`,
    );
  });
});

describe("invariant: the TUI reads agents from the host data store, never client.agent", () => {
  // Observed at the runtime, against the types: the TUI plugin client's `agent`
  // namespace is undefined (`Cannot read properties of undefined (reading 'list')`
  // in .dynamic-task-debug/plugin.log), while the generated types still declare
  // `agent.list`. The host's own screens read `data.location.agent` instead, so
  // this plugin does too — and the double models the store, not the fiction.
  rule({
    doc: "docs/tasks/07-admission-gate.md",
    name: "no client.agent read in the TUI entry",
    only: ["tui/index.ts"],
    patterns: [/client\.agent/],
    why:
      "The TUI runtime client has no `agent` namespace, so a `client.agent.list()` reader\n" +
      "throws on every call and the menu renders no agents — while the suite stays green\n" +
      "if the double answers the same fictional call. Read the data store instead.",
  });
  rule({
    corpus: listTestSupportFiles,
    doc: "docs/tasks/07-admission-gate.md",
    name: "the TUI double answers the data store, not a fictional client namespace",
    only: ["support/limits-screen.js"],
    patterns: [/client:\s*\{/, /client\.agent/],
    skip: [PROSE],
    why:
      "A double that answers `client.agent.list()` proves a reader the host cannot run.\n" +
      "The double carries `data.location.agent` because that is what production reads.",
  });
});


// A BANNED shape, so the pin holds on every platform. The behavioural pins cannot:
// off Windows every flag choice gives the same answers, which is how a hardcoded
// "s" survived a green suite on darwin.
describe("invariant: the permission matcher is handed the host's platform", () => {
  it("reads process.platform at the call site instead of pinning the flags", () => {
    const source = readFileSync(path.join(SRC_DIR, "shared", "agent-record.ts"), "utf8");
    const arg = /(?<!function )wildcardMatches\((?<platform>[^,)]+),/g;
    const args = [...source.matchAll(arg)].map((m) => (m.groups?.platform ?? "").trim());
    assert.ok(args.length > 0, "could not find a wildcardMatches call in agent-record.ts");
    const pinned = args.filter((a) => !a.includes("process.platform"));
    assert.deepEqual(pinned, [], `hardcoded flags make a rule match by machine, not by rule: ${pinned.join(", ")}`);
  });
});
