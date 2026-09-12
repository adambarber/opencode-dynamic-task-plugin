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
    // (?!=) excludes == / === reads: only real assignments are bypasses.
    const pattern = /activeTasks\s*\.\s*(set|delete)|retainedTasks\s*\.\s*(set|delete)|\.\s*completed\s*=(?!=)|\.\s*timeoutNotified\s*=(?!=)/;
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

// --- Task 09: non-blocking settlement -------------------------------------
// Primitive: waiting on child work / per-call execution bounds. The cutover
// deleted the timer funnel; the ONLY sanctioned wall-clock wait in production
// is the notification gate's fixed retry backoff (notify.ts). Everything else
// is unrepresentable by invariance, and the deleted vocabulary may not return.
describe("invariant: settlement is event-driven, no per-call clocks (Task 09)", () => {
  it("no bare setTimeout outside the notification retry", () => {
    // Negative lookbehind exempts timerProvider.* and globalThis.* call shapes.
    const pattern = /(?<!timerProvider\.)(?<!globalThis\.)\bsetTimeout\s*\(/;
    const hits = listProdFiles()
      .filter((f) => !f.endsWith("notify.ts"))
      .flatMap((f) => scanLines(f, pattern));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/09-non-blocking-settlement.md",
        "A wall-clock wait returned outside the notification gate.",
        hits,
      ),
    );
  });

  it("deleted timer vocabulary never returns", () => {
    const pattern = /\btimeout_ms\b|\btimeoutBehavior\b|\bawait_response\b|\btimed_out_retained\b|\bcompleted_after_timeout\b|\bDYNAMIC_TASK_TIMEOUT\b|\bcreateTimerProvider\b|\bstealTimeoutHandle\b/;
    const hits = listProdFiles().flatMap((f) => scanLines(f, pattern));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/09-non-blocking-settlement.md",
        "Pre-cutover timer vocabulary reappeared in production source.",
        hits,
      ),
    );
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
  it("no direct client.session.prompt outside prompt.ts and notify.ts", () => {
    const pattern = /client\.session\.prompt\s*\(/;
    const hits = listProdFiles()
      .filter((f) => !f.endsWith("prompt.ts") && !f.endsWith("notify.ts"))
      .flatMap((f) => scanLines(f, pattern));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/05-notification-gate.md",
        "Direct session.prompt call sites (child prompts via invokePrompt, parent writes via notifyParent).",
        hits,
      ),
    );
  });

  it("the gate holds exactly one parent-write call", () => {
    const gate = path.join(SRC_DIR, "shared", "notify.ts");
    const hits = scanLines(gate, /client\.session\.prompt\s*\(/);
    assert.strictEqual(hits.length, 1, `Expected 1 parent-write call, found ${hits.length}.`);
  });

  it("no legacy notifyParentSession helper remains", () => {
    const hits = listProdFiles().flatMap((f) => scanLines(f, /notifyParentSession/));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/05-notification-gate.md",
        "Legacy helper (notify via the gate).",
        hits,
      ),
    );
  });
});

// --- Task 04: question gate ------------------------------------------------
// Primitive: answering child questions. Funnel: question-handling.ts owns the
// only client.question.reply/reject calls (Tenets 1, 4).
describe("invariant: question reply/reject funnel through question-handling (Task 04)", () => {
  it("linkage map lives in the gate module only", () => {
    const pattern = /questionIdToSessionId|questionSessions/;
    const hits = listProdFiles()
      .filter((f) => !f.endsWith("question-handling.ts"))
      .flatMap((f) => scanLines(f, pattern));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/04-question-gate.md",
        "Question linkage state outside the gate module.",
        hits,
      ),
    );
  });

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
// --- Task 06 amendment (2026-09-11 smoke finding): state scoping -----------
// The poisoned repo ledger came from state paths resolved against the
// process CWD. tsc now forces every caller to pass a path, but string
// literals can re-establish CWD roots silently — the names belong to the
// two persistence dances, nowhere else.
describe("invariant: durable state paths derive from the project directory", () => {
  it("no bare state-file/dir literals outside the ledger/logger dances", () => {
    const pattern = /"\.dynamic-task-(ledger|logs)/;
    const hits = listProdFiles()
      .filter((f) => !f.endsWith("session-lifecycle.ts") && !f.endsWith("debug-logger.ts"))
      .flatMap((f) => scanLines(f, pattern));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/06-persistence-and-observability.md",
        "State-path literal outside the dances (resolve via the host directory instead).",
        hits,
      ),
    );
  });
});

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
    const pattern = /^\s*(async\s+)?function\s+(buildAgentList|validateSessionResult|extractTextFromParts|extractTextFromPromptResult|resolveParentSessionId|fetchAgents|getMessageCount|readSessionMessages|truncateText|registerBackgroundTask|handleChildLifecycleEvent)\s*\(/;
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
    // Both tool shells count: tool({...}) and the sessionReadTool funnel.
    const registered = new Set(
      [...indexSrc.matchAll(/^\s{6}(\w+):\s*(?:tool\s*\(\{|sessionReadTool\s*\()/gm)].map((m) => m[1]),
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


// --- Task 08: strong types ----------------------------------------------------
// Primitive: `any` — the missing choke point. Every typed boundary uses
// `unknown` + narrowing (isEventRecord/eventField/errorMessage). A sanctioned
// exemption needs a named reason inline (Tenet 9); the list starts and stays
// empty — the whole point of the task is that it can.
describe("invariant: production code has no `any` (Task 08)", () => {
  const sanctioned = []; // file-suffix → reason; none sanctioned.
  const anyPattern = /:\s*any\b|\bas\s+any\b|<any>|\bany\[\]/;
  const isProseLine = (content) => {
    const t = content.trimStart();
    return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
  };

  it("no any annotation, cast, or generic in production sources", () => {
    const hits = listProdFiles()
      .filter((f) => !sanctioned.some((s) => f.endsWith(s)))
      .flatMap((f) => scanLines(f, anyPattern))
      .filter((h) => !isProseLine(h.split(" :: ")[1] ?? ""));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/08-strong-types.md",
        "`any` reopens an unvalidated boundary — take `unknown` and narrow it.",
        hits,
      ),
    );
  });

  it("catch variables are never typed any", () => {
    const pattern = /catch\s*\([^)]*:\s*any\s*\)/;
    const hits = listProdFiles().flatMap((f) => scanLines(f, pattern));
    assert.strictEqual(
      hits.length,
      0,
      formatViolations(
        "docs/tasks/08-strong-types.md",
        "`catch (e: any)` opts out of useUnknownInCatchVariables — narrow unknown instead.",
        hits,
      ),
    );
  });
});
