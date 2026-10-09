/**
 * Strong types — Task 08 and the Tenet 12 rules about how a TEST may speak.
 *
 * Two failure families, one subject: `any` reopens an unvalidated boundary in
 * production, and a test that retypes a bound value is a copy that drifts silently.
 * Neither is visible to a green type check, which is what makes each worth a gate.
 *
 * Scanners read source text and report file:line. They never mock the contract
 * (Tenet 12): the production files on disk are the subject.
 */
//jscpd:ignore-start
import path from "node:path";
import { DOC_FIDELITY, DOC_TYPES, PROSE, gate, rule } from "./support/invariant-gate.js";
import { TESTS_DIR, listTestFiles, prodSources, readSource, siteOf } from "./support/corpus.js";
import { assert, describe, it } from "./support/runner.js";
import { InterruptScope } from "../../dist/tools/interrupt.js";
import { LedgerChangeKind } from "../../dist/shared/ledger-change.js";
import { NoticeClaim } from "../../dist/shared/notice-claim.js";
import { NotifyKind } from "../../dist/shared/notification-text.js";
import { TaskState } from "../../dist/shared/task-state.js";
import { LifecycleStatus } from "../../dist/shared/host-events.js";

//jscpd:ignore-end
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
  { corpus: listTestFiles, sanctioned: ["safety-invariants.test.js"] },
);

describe("invariant: tests import production, never redefine it (Tenet 12)", () => {
  rule({ name: "no production-function copies in test files", ...TEST_LOCAL_PRODUCTION_COPY });
  rule({ name: "no stale subagent-only dispatch filter in tests", ...STALE_DISPATCH_FILTER });
});

describe("invariant: production code has no `any` (Task 08)", () => {
  // sanctioned: [] — file-suffix → reason; none sanctioned.
  rule({ name: "no any annotation, cast, or generic in production sources", ...ANY_ANNOTATION });
  rule({ name: "catch variables are never typed any", ...CATCH_ANY });
});

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
  ...Object.values(LifecycleStatus),
  ...Object.values(TaskState),
  ...Object.values(NotifyKind),
  ...Object.values(NoticeClaim),
  ...Object.values(LedgerChangeKind),
  ...Object.values(InterruptScope),
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
    doc: DOC_TYPES,
    name: "no raw wire-string comparison against an invented vocabulary",
    patterns: RAW_TAG_COMPARISON,
    skip: [PROSE],
    why:
      "A discriminant compared as a raw string compiles clean under a rename and lets a new\n" +
      "member fall through to whatever the final `else` was. Compare the enum member, or let\n" +
      "the value carry its own words (see AdmissionDenial, which has no discriminant at all).",
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
      if (literal.length > 1 && !bound.has(literal)) bound.set(literal, { file, name });
    };
    // The names production puts on its own FIELDS, read off the tree before any
    // constant is. `MODEL_LABEL = "model"` and the `"model"` a test asserts is absent
    // from a create body are the same six characters and different claims: one is a
    // word the plugin invented for a row, the other is the name of a property the host
    // declares. Exempting the field names is not a special case for one word — it is
    // the distinction the two exemptions above already draw, applied to the one family
    // of literal it missed. Without it a label names a field, and the gate reports two
    // sites for something no decision can drift: a gate that cries wolf gets switched
    // off, and then nothing watches the ones that matter.
    const fieldNames = new Set();
    for (const { source } of prodSources()) {
      // Property access (`session.model`, `raw.maxConcurrent`) and quoted keys
      // (`{"model": ...}`, `input["model"]`) — the two spellings a field has in source.
      for (const m of source.matchAll(/\.(?<field>[A-Za-z_$][\w$]*)/g)) fieldNames.add(m.groups.field);
      for (const m of source.matchAll(/["'](?<field>[A-Za-z_$][\w$]*)["']\s*:/g)) fieldNames.add(m.groups.field);
      for (const m of source.matchAll(/\[["'](?<field>[A-Za-z_$][\w$]*)["']\]/g)) fieldNames.add(m.groups.field);
    }
    for (const { file, source } of prodSources()) {
      const forms = [
        // (1) and (2): a const bound to a bare string literal, exported or not.
        /(?:export\s+)?const\s+(?<constName>[A-Z_0-9]+)\s*(?::[^=]+)?=\s*"(?<literal>(?:[^"\\\n]|\\.)+)"/g,
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
    // A literal that names a field is dropped last, so the decision literals it would
    // otherwise displace are still collected — the map keeps only the FIRST binding,
    // and dropping before adding would let a later decision claim the name instead.
    for (const literal of fieldNames) bound.delete(literal);
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
      for (const finding of retypeFindings(readSource(file).text, constants)) {
        findings.push(`${siteOf(file)}: ${finding}`);
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
    const bareExport = byForm((name) => name === "PERMISSION_ASKED");
    const bareLocal = byForm((name) => name === "DEBUG_DIR");
    const tableRow = byForm((name) => name.endsWith(".tag"));
    assert.ok(bareExport && bareLocal && tableRow, `expected all three binding forms in production, got ${[bareExport, bareLocal, tableRow].map(String).join(", ")}`);
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
