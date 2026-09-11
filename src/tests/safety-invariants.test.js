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

// Non-global regex per line (avoids lastIndex statefulness).
function scanLines(file, regex) {
  const lines = readFileSync(file, "utf8").split("\n");
  const hits = [];
  lines.forEach((content, i) => {
    if (regex.test(content)) {
      hits.push(`${path.relative(REPO_ROOT, file)}:${i + 1} :: ${content.trim()}`);
    }
  });
  return hits;
}

function formatViolations(taskDoc, why, hits) {
  return (
    `${why}\n` +
    `Owning doc: ${taskDoc}\n` +
    `Bypass sites (${hits.length}):\n` +
    hits.map((h) => `  - ${h}`).join("\n")
  );
}

// --- Task 01: lifecycle funnel -------------------------------------------
// Primitive: task-state mutation. Funnel: src/shared/task-state.ts owns every
// Map write and every completed/timeoutNotified assignment (Tenets 1, 3, 5).
describe("invariant: lifecycle mutations funnel through task-state (Task 01)", () => {
  it("no raw store/flag mutation outside task-state.ts", () => {
    const sanctioned = `task-state.ts`;
    const pattern = /activeTasks\s*\.\s*(set|delete)|retainedTasks\s*\.\s*(set|delete)|\.\s*completed\s*=|\.\s*timeoutNotified\s*=/;
    const hits = listProdFiles()
      .filter((f) => !f.endsWith(sanctioned))
      .flatMap((f) => scanLines(f, pattern));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/01-lifecycle-choke-point.md",
        "Direct task-state mutation bypasses transitionState's matrix.",
        hits,
      ),
    );
  });
});

// --- Task 02: execution bound ---------------------------------------------
// Primitive: waiting on child work. Shape rule: every wait goes through the
// injected TimerProvider — bare global setTimeout is unrepresentable outside
// the provider definition itself (Tenets 2, 7).
describe("invariant: waits use the injected TimerProvider (Task 02)", () => {
  it("no bare setTimeout outside config.ts provider definition", () => {
    // Negative lookbehind exempts timerProvider.* and globalThis.* call shapes.
    const pattern = /(?<!timerProvider\.)(?<!globalThis\.)\bsetTimeout\s*\(/;
    const hits = listProdFiles()
      .filter((f) => !f.endsWith("config.ts"))
      .flatMap((f) => scanLines(f, pattern));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/02-execution-bound.md",
        "Bare setTimeout escapes the named-budget funnel.",
        hits,
      ),
    );
  });
});

// --- Task 03: prompt/hydration dance ---------------------------------------
// Primitive: client.session.prompt. Until the Task 03 dance module exists
// there is no sanctioned caller — every site is reported so the migration
// has a complete list (Tenets 1, 6).
describe("invariant: session.prompt flows through one dance (Task 03)", () => {
  it("no direct client.session.prompt outside the dance module", () => {
    // Sanctioned set is intentionally empty: the dance module does not exist
    // yet. index.ts:notifyParentSession is the Task 05 gate, not this dance —
    // it is listed here so the split is explicit when both gates land.
    const pattern = /client\.session\.prompt\s*\(/;
    const hits = listProdFiles().flatMap((f) => scanLines(f, pattern));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/03-prompt-hydration-dance.md",
        "Direct session.prompt call sites (each must route via runPrompt).",
        hits,
      ),
    );
  });
});

// --- Task 04: question gate ------------------------------------------------
// Primitive: answering child questions. Funnel: question-handling.ts owns the
// only client.question.reply/reject calls (Tenets 1, 4).
describe("invariant: question reply/reject funnel through question-handling (Task 04)", () => {
  it("no direct client.question.reply/reject outside question-handling.ts", () => {
    const pattern = /client\.question\s*\.\s*(reply|reject)\s*\(/;
    const hits = listProdFiles()
      .filter((f) => !f.endsWith("question-handling.ts"))
      .flatMap((f) => scanLines(f, pattern));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/04-question-gate.md",
        "Direct question reply/reject bypasses the resolve-then-validate gate.",
        hits,
      ),
    );
  });
});

// --- Task 05: notification gate --------------------------------------------
// Primitive: parent-directed writes. Structure rule: exactly one function
// owns them (notifyParentSession) until the Task 05 gate subsumes it
// (Tenets 1, 6).
describe("invariant: one parent-notification owner (Task 05)", () => {
  it("exactly one notifyParent* function exists", () => {
    const pattern = /function\s+notifyParent\w*\s*\(/;
    const hits = listProdFiles().flatMap((f) => scanLines(f, pattern));
    assert.strictEqual(
      hits.length,
      1,
      formatViolations(
        "docs/tasks/05-notification-gate.md",
        `Expected exactly 1 parent-notification owner, found ${hits.length}.`,
        hits,
      ),
    );
  });
});

// --- Task 06: persistence dance --------------------------------------------
// Primitive: durable file writes. Funnel: session-lifecycle.ts owns the
// atomic ledger dance; debug-logger.ts owns diagnostics appends (Tenet 6).
// No other module may write files.
describe("invariant: file writes funnel through ledger/logger dances (Task 06)", () => {
  it("no writeFileSync/renameSync/appendFileSync outside sanctioned dances", () => {
    const pattern = /writeFileSync|renameSync|appendFileSync/;
    const hits = listProdFiles()
      .filter((f) => !f.endsWith("session-lifecycle.ts") && !f.endsWith("debug-logger.ts"))
      .flatMap((f) => scanLines(f, pattern));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/06-persistence-and-observability.md",
        "File write outside the atomic-write dances.",
        hits,
      ),
    );
  });
});

// --- Task 07: admission gate ------------------------------------------------
// Primitive: spawn admission. Until the Task 07 gate exists there is no
// sanctioned caller of registration/validation — every site is reported
// (Tenets 3, 4).
describe("invariant: spawn admission flows through one gate (Task 07)", () => {
  it("no direct register/validate/agent-find outside the admission gate", () => {
    const callPattern = /registerActiveTask\s*\(|validateAgent\s*\(|validateLineage\s*\(|\bagents\s*\.\s*find\s*\(/;
    const defPattern = /function\s+(registerActiveTask|validateAgent|validateLineage)\s*\(/;
    // Tenet 9: admission.ts IS the gate — its internal composition is sanctioned.
    const hits = listProdFiles()
      .filter((f) => !f.endsWith("admission.ts"))
      .flatMap((f) => {
      const lines = readFileSync(f, "utf8").split("\n");
      const fileHits = [];
      lines.forEach((content, i) => {
        if (defPattern.test(content)) return; // definitions are the funnel
        if (callPattern.test(content)) {
          fileHits.push(`${path.relative(REPO_ROOT, f)}:${i + 1} :: ${content.trim()}`);
        }
      });
      return fileHits;
    });
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/07-admission-gate.md",
        "Direct admission calls (each must route via admitSpawn).",
        hits,
      ),
    );
  });
});

// --- Tenet 12: pin contracts with the real primitive ------------------------
// Tests must import production code from dist/, never re-define it. Copies
// drift — plugin.test.js carries its own agent-mode filter that contradicts
// the eed3a04 dispatchability fix it should pin.
describe("invariant: tests import production, never redefine it (Tenet 12)", () => {
  it("no production-function copies in test files", () => {
    const pattern = /^\s*(async\s+)?function\s+(buildAgentList|validateSessionResult|extractTextFromParts|extractTextFromPromptResult|resolveParentSessionId|fetchAgents|getMessageCount|readSessionMessages|truncateText)\s*\(/;
    const hits = listTestFiles().flatMap((f) => scanLines(f, pattern));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/00-fidelity-ground-truth.md (Tenet 12)",
        "Test-local copies of production functions — import from dist/ instead.",
        hits,
      ),
    );
  });

  it("no stale subagent-only dispatch filter in tests", () => {
    const pattern = /===\s*["']subagent["']/;
    // Self-exclusion: this file discusses the banned pattern in prose.
    const hits = listTestFiles()
      .filter((f) => !f.endsWith("safety-invariants.test.js"))
      .flatMap((f) => scanLines(f, pattern));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/00-fidelity-ground-truth.md (Tenet 12)",
        "Stale dispatch filter — production accepts 'subagent'+'all' (isDispatchableAgent); import it instead.",
        hits,
      ),
    );
  });
});

// --- Task 00: documented capability inventory --------------------------------
// Primitive: the documented capability set. README's tool table must match
// exactly the tools registered in src/index.ts (fidelity gate).
describe("invariant: README tool inventory matches registered tools (Task 00)", () => {
  it("every documented tool is registered and vice versa", () => {
    const indexSrc = readFileSync(path.join(SRC_DIR, "index.ts"), "utf8");
    const registered = new Set(
      [...indexSrc.matchAll(/^\s{6}(\w+):\s*tool\(\{/gm)].map((m) => m[1]),
    );
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
      `README ↔ src/index.ts capability drift.\nOwning doc: docs/tasks/00-fidelity-ground-truth.md\n` +
        drift.map((d) => `  - ${d}`).join("\n"),
    );
  });
});
