import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

// Tenet 12: pin the real production contract via dist/ — never local copies.
import {
  buildAgentList,
  fetchAgents,
  resetAgentCache,
} from "../../dist/shared/admission.js";
import {
  validateSessionResult,
  resolveParentSessionId,
} from "../../dist/shared/session-lifecycle.js";
import * as pluginEntry from "../../dist/index.js";
import {
  invokePrompt,
  classifyPromptError,
  extractTextFromParts,

  getLatestAssistantText,
  hydrateLatestOutcome,
  parseModelOverride,
  isTextPart,
  isMessage,
  messageRoleOf,
  messageErrorDetail,
  extractSessionStatus,
} from "../../dist/shared/prompt.js";

// --- Tests ---
describe("buildAgentList", () => {
  it("returns agent names joined by comma", () => {
    const agents = [
      { name: "explore", description: "test" },
      { name: "general" },
    ];
    assert.strictEqual(buildAgentList(agents), "explore, general");
  });

  it("returns '(none discovered)' for empty array", () => {
    assert.strictEqual(buildAgentList([]), "(none discovered)");
  });

  // Total on malformed input: the host probes named exports during load and
  // a throw here fails the entire plugin boot (field: agents.map on a
  // non-array while the default export never ran). Never throw; degrade.
  it("returns '(none discovered)' for non-array input instead of throwing", () => {
    assert.strictEqual(buildAgentList(undefined), "(none discovered)");
    assert.strictEqual(buildAgentList(null), "(none discovered)");
    assert.strictEqual(buildAgentList({ agents: [] }), "(none discovered)");
    assert.strictEqual(buildAgentList("general"), "(none discovered)");
  });

  it("drops non-record entries instead of printing undefined", () => {
    assert.strictEqual(buildAgentList([{ name: "general" }, { nope: 1 }, "x", null]), "general");
    assert.strictEqual(buildAgentList([{ nope: 1 }]), "(none discovered)");
  });
});

describe("validateSessionResult", () => {
  it("extracts id from flat result", () => {
    assert.strictEqual(validateSessionResult({ id: "ses_123" }), "ses_123");
  });

  it("extracts id from body wrapper", () => {
    assert.strictEqual(
      validateSessionResult({ body: { id: "ses_456" } }),
      "ses_456"
    );
  });

  it("extracts id from data wrapper", () => {
    assert.strictEqual(
      validateSessionResult({ data: { id: "ses_789" } }),
      "ses_789"
    );
  });

  it("returns null for invalid result", () => {
    assert.strictEqual(validateSessionResult(null), null);
    assert.strictEqual(validateSessionResult({ noId: true }), null);
  });
});

describe("extractTextFromParts", () => {
  it("joins text parts", () => {
    const parts = [
      { type: "text", text: "Hello " },
      { type: "text", text: "World" },
    ];
    assert.strictEqual(extractTextFromParts(parts), "Hello \nWorld");
  });

  it("filters non-text parts", () => {
    const parts = [
      { type: "text", text: "Hello" },
      { type: "file", url: "http://example.com" },
    ];
    assert.strictEqual(extractTextFromParts(parts), "Hello");
  });

  it("handles empty array", () => {
    assert.strictEqual(extractTextFromParts([]), "");
  });

  it("handles null/undefined in parts", () => {
    const parts = [
      { type: "text", text: "Hello" },
      null,
      undefined,
      { type: "text", text: "World" },
    ];
    assert.strictEqual(extractTextFromParts(parts), "Hello\nWorld");
  });
});

describe("resolveParentSessionId", () => {
  it("prefers explicit sessionID", () => {
    const ctx = { sessionID: "ses_parent_1", sessionId: "ses_parent_2" };
    assert.strictEqual(resolveParentSessionId(ctx), "ses_parent_1");
  });

  it("falls back through known keys", () => {
    assert.strictEqual(
      resolveParentSessionId({ sessionId: "ses_parent_2" }),
      "ses_parent_2"
    );
    assert.strictEqual(
      resolveParentSessionId({ session: { id: "ses_parent_3" } }),
      "ses_parent_3"
    );
    assert.strictEqual(resolveParentSessionId({ id: "ses_parent_4" }), "ses_parent_4");
  });

  it("returns null when no usable id exists", () => {
    assert.strictEqual(resolveParentSessionId({}), null);
    assert.strictEqual(resolveParentSessionId(null), null);
    assert.strictEqual(resolveParentSessionId({ sessionID: "   " }), null);
  });
});

describe("fetchAgents", () => {
  beforeEach(() => {
    resetAgentCache();
  });

  function clientWith(agents, log = async () => {}) {
    return {
      app: {
        agents: async () => agents,
        log,
      },
    };
  }

  it("dispatches subagent and all modes, rejects primary", async () => {
    const mockClient = clientWith([
      { name: "explore", mode: "subagent" },
      { name: "architect", mode: "all" },
      { name: "unannotated" },
      { name: "build", mode: "primary" },
    ]);

    const result = await fetchAgents(mockClient);
    assert.deepStrictEqual(
      result.map((a) => a.name).sort(),
      ["architect", "explore", "unannotated"]
    );
  });

  it("handles error gracefully", async () => {
    const mockClient = {
      app: {
        agents: async () => {
          throw new Error("Network error");
        },
        log: async () => {},
      },
    };

    const result = await fetchAgents(mockClient);
    assert.strictEqual(result.length, 0);
  });

  // The host probes entry exports outside the plugin lifecycle; the
  // final-failure warn path must not throw when the client itself is
  // unusable, or the whole plugin boot fails (field: client.app.log).
  it("returns [] without throwing when the client is unusable", async () => {
    const result = await fetchAgents(undefined);
    assert.deepStrictEqual(result, []);
  });

  it("retries once after a transient failure", async () => {
    let calls = 0;
    const mockClient = {
      app: {
        agents: async () => {
          calls++;
          if (calls === 1) throw new Error("blip");
          return [{ name: "explore", mode: "subagent" }];
        },
        log: async () => {},
      },
    };

    const result = await fetchAgents(mockClient);
    assert.strictEqual(calls, 2, "one immediate retry");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "explore");
  });

  it("handles wrapped response (result.data)", async () => {
    const mockClient = clientWith({
      data: [
        { name: "general", mode: "subagent" },
        { name: "plan", mode: "primary" },
      ],
    });

    const result = await fetchAgents(mockClient);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "general");
  });

  it("handles wrapped response (result.agents)", async () => {
    const mockClient = clientWith({
      agents: [
        { name: "review", mode: "subagent" },
        { name: "build", mode: "primary" },
      ],
    });

    const result = await fetchAgents(mockClient);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "review");
  });
});

// The host invokes every entry-module export as a candidate plugin
// function, so the entry exposes exactly one: the default plugin function.
// Domain readers live in shared modules (this test failed the boot before
// the move — probe calls against entry exports failed the plugin load).
describe("plugin entry: exposes only the default plugin function", () => {
  it("has no named function exports for the host to probe", () => {
    const named = Object.entries(pluginEntry).filter(
      ([name, value]) => name !== "default" && typeof value === "function",
    );
    assert.deepStrictEqual(named.map(([name]) => name), []);
  });
});

// --- Shared Session Lifecycle Helpers (Task 1) ---
// These import from the shared module to verify extraction works
import {
  normalizeStatus,
  getSessionIdFromEvent,
  getEventLifecycleStatus,
  isTerminalSessionEvent,

} from "../../dist/shared/session-lifecycle.js";

describe("normalizeStatus", () => {
  it("returns lowercase string status", () => {
    assert.strictEqual(normalizeStatus("IDLE"), "idle");
  });

  it("extracts status.type objects", () => {
    assert.strictEqual(normalizeStatus({ type: "error" }), "error");
  });

  it("returns empty string for unsupported values", () => {
    assert.strictEqual(normalizeStatus({ nope: true }), "");
  });

  it("returns empty string for null", () => {
    assert.strictEqual(normalizeStatus(null), "");
  });

  it("returns empty string for undefined", () => {
    assert.strictEqual(normalizeStatus(undefined), "");
  });

  it("returns empty string for number input", () => {
    assert.strictEqual(normalizeStatus(123), "");
  });
});

describe("getSessionIdFromEvent", () => {
  it("extracts sessionID from properties", () => {
    const event = { properties: { sessionID: "ses_123" } };
    assert.strictEqual(getSessionIdFromEvent(event), "ses_123");
  });

  it("extracts sessionId from data", () => {
    const event = { data: { sessionId: "ses_456" } };
    assert.strictEqual(getSessionIdFromEvent(event), "ses_456");
  });

  it("extracts from aggregateID fallback", () => {
    const event = { aggregateID: "ses_789" };
    assert.strictEqual(getSessionIdFromEvent(event), "ses_789");
  });

  it("extracts from top-level id fallback", () => {
    const event = { id: "ses_top_level" };
    assert.strictEqual(getSessionIdFromEvent(event), "ses_top_level");
  });

  it("returns null for no match", () => {
    assert.strictEqual(getSessionIdFromEvent({}), null);
    assert.strictEqual(getSessionIdFromEvent(null), null);
  });

  it("returns null for whitespace-only id", () => {
    assert.strictEqual(getSessionIdFromEvent({ id: "  " }), null);
  });
});

describe("getEventLifecycleStatus", () => {
  it("prefers event.properties.status when present", () => {
    assert.strictEqual(
      getEventLifecycleStatus({ properties: { status: { type: "completed" } } }),
      "completed"
    );
  });

  it("falls back to sync event data.info.status", () => {
    assert.strictEqual(
      getEventLifecycleStatus({ data: { info: { status: "error" } } }),
      "error"
    );
  });

  it("returns empty string for no status anywhere", () => {
    assert.strictEqual(getEventLifecycleStatus({}), "");
  });

  // A provider failure (429/auth/overload) is delivered as a session.error
  // event whose payload rides properties.error — there is NO status field, so
  // the status-path candidates return "" and the task was misreported as a
  // clean completion (field log 2026-09-11T19:30:00.485Z). An error-typed
  // event is an error regardless of payload shape.
  it("returns error for session.error events (no status field)", () => {
    assert.strictEqual(
      getEventLifecycleStatus({
        type: "session.error",
        properties: { sessionID: "s1", error: { name: "APIError", data: { message: "Too Many Requests" } } },
      }),
      "error",
    );
  });

  it("returns error for sync-wrapped session.error envelopes", () => {
    assert.strictEqual(
      getEventLifecycleStatus({ type: "sync", name: "session.error.1", properties: { sessionID: "s1" } }),
      "error",
    );
  });

  it("still reads status for non-error events", () => {
    assert.strictEqual(
      getEventLifecycleStatus({ type: "session.idle", properties: { sessionID: "s1", status: "idle" } }),
      "idle",
    );
  });
});

// The real 429 signal lives on the message INFO (AssistantMessage.error ->
// ApiError.data.message), never as a part type or a message role: a failed
// turn still has role "assistant" with empty text. The reader must dig the
// info envelope (dual-era, like messageRoleOf) and surface a human detail.
describe("messageErrorDetail", () => {
  it("extracts ApiError.data.message from the info envelope", () => {
    assert.strictEqual(
      messageErrorDetail({
        info: { role: "assistant", error: { name: "APIError", data: { message: "Too Many Requests", statusCode: 429 } } },
        parts: [],
      }),
      "Too Many Requests",
    );
  });

  it("falls back to the error name when no message", () => {
    assert.strictEqual(
      messageErrorDetail({ info: { role: "assistant", error: { name: "MessageAbortedError" } }, parts: [] }),
      "MessageAbortedError",
    );
  });

  it("returns empty for a clean assistant message", () => {
    assert.strictEqual(
      messageErrorDetail({ info: { role: "assistant" }, parts: [{ type: "text", text: "done" }] }),
      "",
    );
  });

  it("reads the legacy flat error role from its text parts", () => {
    assert.strictEqual(
      messageErrorDetail({ role: "error", parts: [{ type: "text", text: "provider exploded" }] }),
      "provider exploded",
    );
  });

  it("returns empty for non-message values", () => {
    assert.strictEqual(messageErrorDetail(null), "");
    assert.strictEqual(messageErrorDetail("junk"), "");
    assert.strictEqual(messageErrorDetail({ role: "assistant" }), "");
  });
});

describe("extractSessionStatus: message-level error", () => {
  it("reports error when the latest assistant message carries info.error", () => {
    assert.strictEqual(
      extractSessionStatus({}, [
        { info: { role: "user" }, parts: [] },
        { info: { role: "assistant", error: { name: "APIError", data: { message: "Too Many Requests" } } }, parts: [] },
      ]),
      "error",
    );
  });

  it("still reports completed for a clean latest assistant message", () => {
    assert.strictEqual(
      extractSessionStatus({}, [
        { info: { role: "user" }, parts: [] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "ok" }] },
      ]),
      "completed",
    );
  });
});

describe("maxConcurrent default", () => {
  it("defaults to 4 when env is not set", () => {
    assert.strictEqual(normalizeDynamicTaskConfig({}).maxConcurrent, 4);
  });
});

describe("isTerminalSessionEvent", () => {
  it("treats sync session.updated idle as terminal", () => {
    assert.strictEqual(
      isTerminalSessionEvent({
        type: "sync",
        name: "session.updated.1",
        data: { info: { status: "idle" } },
      }),
      true
    );
  });

  it("treats sync session.updated error as terminal", () => {
    assert.strictEqual(
      isTerminalSessionEvent({
        type: "sync",
        name: "session.updated.1",
        data: { info: { status: { type: "error" } } },
      }),
      true
    );
  });

  it("treats sync session.deleted.1 as terminal", () => {
    assert.strictEqual(
      isTerminalSessionEvent({
        type: "sync",
        name: "session.deleted.1",
      }),
      true
    );
  });

  it("treats session.idle event as terminal", () => {
    assert.strictEqual(
      isTerminalSessionEvent({ type: "session.idle" }),
      true
    );
  });

  it("treats session.error event as terminal", () => {
    assert.strictEqual(
      isTerminalSessionEvent({ type: "session.error" }),
      true
    );
  });

  it("does not treat session.status with unknown status as terminal", () => {
    assert.strictEqual(
      isTerminalSessionEvent({ type: "session.status", properties: { status: "running" } }),
      false
    );
  });
});

// --- Shared Task Formatting Helpers (Task 2) ---
import {
  buildBackgroundPrompt,
  formatTaskResultSummary,
  formatTaskListSummary,
  formatTaskStatusDetail,
} from "../../dist/shared/task-formatting.js";
import { formatParentNotification, truncateText, noticeDedupKey } from "../../dist/shared/notify.js";

describe("buildBackgroundPrompt", () => {
  it("adds explicit background instructions before user prompt", () => {
    const result = buildBackgroundPrompt("Return COMPLETED_OK when done.");
    assert.match(result, /You are running as a background child task\./);
    assert.match(result, /Return a final, self-contained answer\./);
    assert.match(result, /Return COMPLETED_OK when done\./);
  });
});

describe("formatParentNotification", () => {
  const state = { childSessionId: "ses_1", description: "Quick task" };

  it("formats completion with the wire marker and output", () => {
    const message = formatParentNotification(state, "completed", "COMPLETED_OK");
    assert.match(message, /^\[dynamic-task-notify\]/);
    assert.match(message, /Background task completed successfully\./);
    assert.match(message, /Session: ses_1/);
    assert.match(message, /Latest output: COMPLETED_OK/);
  });

  it("formats error with recovery guidance", () => {
    const message = formatParentNotification(state, "error", "Something failed");
    assert.match(message, /Background task ended with an error\./);
    assert.match(message, /Something failed/);
    assert.match(message, /task_result or task_continue/);
  });

  it("formats a child notice with the reply path", () => {
    const message = formatParentNotification(state, "notice", "blocked on credentials");
    assert.match(message, /Message from a running child task:/);
    assert.match(message, /blocked on credentials/);
    assert.match(message, /task_continue/);
  });

  it("renders the empty-output placeholder", () => {
    assert.match(formatParentNotification(state, "completed", "   "), /\(No text output\)/);
  });

  it("passes mid-size payloads through whole — no silent cliff", () => {
    const body = "x".repeat(3000);
    const message = formatParentNotification(state, "completed", body);
    assert.ok(message.includes(body), "3000-char output must survive the push path intact");
  });

  it("bounds huge payloads but points at task_result for the rest", () => {
    const message = formatParentNotification(state, "completed", "x".repeat(9000));
    assert.ok(message.length < 9000, "push path stays bounded");
    assert.match(message, /task_result/, "truncation names the full-text recovery path");
    assert.match(message, /ses_1/, "pointer names the session");
  });
});

describe("formatTaskResultSummary", () => {
  it("includes next action guidance for running tasks", () => {
    const result = formatTaskResultSummary({
      sessionId: "ses_123", status: "busy", messageCount: 4,
      latestText: "Still working", tracked: true,
    });
    assert.match(result, /Recommended next action: use task_result again later\./);
    assert.match(result, /Tracked: yes/);
  });

  it("includes recovery guidance for error status", () => {
    const result = formatTaskResultSummary({
      sessionId: "ses_123", status: "error", messageCount: 4,
      latestText: "Failed", tracked: false,
    });
    assert.match(result, /Recommended next action: inspect latest output/);
    assert.match(result, /Tracked: no/);
  });

  it("surfaces delivery attempts when provided", () => {
    const result = formatTaskResultSummary({
      sessionId: "ses_123", status: "idle", messageCount: 4,
      latestText: "Done", tracked: true,
      notification: { kind: "completed", delivered: true, attempts: 2 },
    });
    assert.match(result, /Last notification: completed \(delivered in 2 attempt/);
  });
});

// --- Debug Logger (Task 3) ---
import { debugLog, getDebugLogPath, safeDebugPayload } from "../../dist/debug-logger.js";

describe("safeDebugPayload", () => {
  it("keeps event metadata but removes blocked fields (prompt, fullPrompt)", () => {
    const payload = safeDebugPayload({
      eventType: "session.status",
      prompt: "x".repeat(5000),
      latestText: "done",
    });
    assert.strictEqual(payload.eventType, "session.status");
    assert.ok(!("prompt" in payload));
    assert.strictEqual(payload.latestText, "done");
  });

  it("caps logged fields at MAX_DEBUG_FIELDS (4)", () => {
    const payload = safeDebugPayload({
      a: 1, b: 2, c: 3, d: 4, e: 5, f: 6,
    });
    assert.strictEqual(Object.keys(payload).length, 4, "Must not log more than 4 fields");
  });

  it("respects DYNAMIC_TASK_DEBUG_BLOCKLIST env var", () => {
    const result = safeDebugPayload({ prompt: "x", token: "secret", latestText: "done" });
    assert.ok(!("prompt" in result), "prompt must be blocked by default blocklist");
  });
});

describe("getDebugLogPath", () => {
  it("creates a stable per-parent-child path", () => {
    const logPath = getDebugLogPath("parent_1", "child_2");
    assert.match(logPath, /parent-parent_1__child-child_2\.log$/);
  });
});

describe("safeDebugPayload fallback parsing", () => {
  it("handles null/undefined payloads", () => {
    assert.deepStrictEqual(safeDebugPayload(null), {});
    assert.deepStrictEqual(safeDebugPayload(undefined), {});
  });
});

// --- Task ledger persistence (Task 6): versioned full-record ledger ---
import {
  saveTaskLedger,
  loadTaskLedger,
} from "../../dist/shared/session-lifecycle.js";

import { readFileSync, unlinkSync, writeFileSync, existsSync, rmSync } from "node:fs";

function retainedEntry(overrides = {}) {
  return {
    childSessionId: "ses_1",
    parentSessionId: "parent_1",
    agentName: "explore",
    description: "t",
    lineage: [],
    state: "completed",
    startedAt: 1,
    retainedAt: 2,
    timeoutNotified: true,
    ...overrides,
  };
}

function tmpLedgerPath() {
  return `${tmpdir()}/dt-ledger-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;
}

describe("task ledger persistence", () => {
  it("round-trips retained records through an injectable path", () => {
    const file = tmpLedgerPath();
    try {
      saveTaskLedger(new Map([["ses_1", retainedEntry()]]), file);
      const loaded = loadTaskLedger(file);
      assert.strictEqual(loaded.size, 1);
      assert.strictEqual(loaded.get("ses_1").agentName, "explore");
      assert.strictEqual(loaded.get("ses_1").state, "completed");
      assert.strictEqual(loaded.get("ses_1").timeoutNotified, undefined, "the reader strips transient fields");
    } finally {
      if (existsSync(file)) unlinkSync(file);
    }
  });

  it("returns empty for missing, corrupt, and unknown-version files", () => {
    assert.strictEqual(loadTaskLedger(`${tmpdir()}/dt-nope-${Date.now()}.json`).size, 0);
    const bad = tmpLedgerPath();
    writeFileSync(bad, "{ nope");
    try {
      assert.strictEqual(loadTaskLedger(bad).size, 0);
    } finally {
      unlinkSync(bad);
    }
    const future = tmpLedgerPath();
    writeFileSync(future, JSON.stringify({ version: 999, tasks: {} }));
    try {
      assert.strictEqual(loadTaskLedger(future).size, 0);
    } finally {
      unlinkSync(future);
    }
  });

  it("save writes atomically via rename — no .tmp residue", () => {
    const file = tmpLedgerPath();
    try {
      saveTaskLedger(new Map([["ses_1", retainedEntry()]]), file);
      assert.strictEqual(existsSync(`${file}.tmp`), false, "tmp must be renamed away, not left behind");
      assert.strictEqual(loadTaskLedger(file).size, 1, "renamed content intact");
    } finally {
      if (existsSync(file)) unlinkSync(file);
      if (existsSync(`${file}.tmp`)) unlinkSync(`${file}.tmp`);
    }
  });

  it("rejects entries disagreeing with their map key", () => {
    const file = tmpLedgerPath();
    writeFileSync(file, JSON.stringify({
      version: 2,
      tasks: { ses_a: { ...retainedEntry(), childSessionId: "ses_b" } },
    }));
    try {
      const loaded = loadTaskLedger(file);
      assert.strictEqual(loaded.has("ses_a"), false, "a divergent entry is corrupt, not relabeled");
    } finally {
      unlinkSync(file);
    }
  });

  it("rejects non-finite timestamps and mixed lineage wholesale", () => {
    const file = tmpLedgerPath();
    const nanEntry = { ...retainedEntry(), startedAt: NaN };
    const mixedLineage = { ...retainedEntry(), childSessionId: "ses_mix", lineage: ["x", 42] };
    saveTaskLedger(new Map([["ses_nan", nanEntry], ["ses_mix", mixedLineage]]), file);
    try {
      const loaded = loadTaskLedger(file);
      assert.strictEqual(loaded.has("ses_nan"), false, "NaN does not survive the durability boundary");
      assert.strictEqual(loaded.has("ses_mix"), false, "mixed lineage is rejected, not silently shortened");
    } finally {
      if (existsSync(file)) unlinkSync(file);
      if (existsSync(`${file}.tmp`)) unlinkSync(`${file}.tmp`);
    }
  });

  it("drops entries with unknown states or invalid ids", () => {
    const file = tmpLedgerPath();
    writeFileSync(file, JSON.stringify({
      version: 2,
      tasks: {
        ses_ok: { ...retainedEntry(), childSessionId: "ses_ok" },
        ses_bad: { ...retainedEntry(), childSessionId: "ses_bad", state: "flying" },
        ses_noid: { ...retainedEntry(), childSessionId: 42 },
      },
    }));
    try {
      const loaded = loadTaskLedger(file);
      assert.strictEqual(loaded.size, 1);
      assert.ok(loaded.has("ses_ok"));
    } finally {
      unlinkSync(file);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// src/tests/plugin.test.js — Task 01-08 + cutover-era units:
// config precedence, policy, session/prompt/notify/state contracts.
// ═════════════════════════════════════════════════════════════════════

import {
  normalizeDynamicTaskConfig,
  parseDynamicTaskJsonc,
} from "../../dist/shared/config.js";

describe("normalizeDynamicTaskConfig", () => {
  it("returns safe defaults when given empty options", () => {
    const config = normalizeDynamicTaskConfig({});
    assert.strictEqual(config.maxDepth, 2);
    assert.strictEqual(config.maxConcurrent, 4);
    assert.deepStrictEqual(config.blockedAgents, ["general"]);
    assert.strictEqual(config.allowSameAgentRecursion, false);
    assert.ok(config.agentCacheTtlMs > 0);
    assert.ok(config.retainedTaskTtlMs > 0);
    assert.ok(config.retainedTaskMaxEntries > 0);
  });

  it("returns safe defaults when given null/undefined options", () => {
    assert.strictEqual(normalizeDynamicTaskConfig(null).maxDepth, 2);
    assert.strictEqual(normalizeDynamicTaskConfig(undefined).maxDepth, 2);
  });

  it("respects plugin tuple options overriding defaults", () => {
    const config = normalizeDynamicTaskConfig({
      maxDepth: 3,
      maxConcurrent: 8,
      blockedAgents: ["general", "coder"],
    });
    assert.strictEqual(config.maxDepth, 3);
    assert.strictEqual(config.maxConcurrent, 8);
    assert.deepStrictEqual(config.blockedAgents, ["general", "coder"]);
  });

  it("ignores unknown, malformed, or hostile option fields", () => {
    const config = normalizeDynamicTaskConfig({ unknownField: "ignored", maxConcurrent: "8" });
    assert.strictEqual(config.maxConcurrent, 4, "string numbers must not slip in");
    assert.ok(!("unknownField" in config));
  });

  it("lets env override tuple options", () => {
    const prev = process.env.DYNAMIC_TASK_MAX_CONCURRENT;
    process.env.DYNAMIC_TASK_MAX_CONCURRENT = "7";
    try {
      assert.strictEqual(normalizeDynamicTaskConfig({ maxConcurrent: 2 }).maxConcurrent, 7);
    } finally {
      if (prev !== undefined) process.env.DYNAMIC_TASK_MAX_CONCURRENT = prev;
      else delete process.env.DYNAMIC_TASK_MAX_CONCURRENT;
    }
  });

  it("treats empty-string env var as 'not set' and falls through to the next level", () => {
    const prev = process.env.DYNAMIC_TASK_MAX_CONCURRENT;
    process.env.DYNAMIC_TASK_MAX_CONCURRENT = "";
    try {
      assert.strictEqual(normalizeDynamicTaskConfig({ maxConcurrent: 5 }).maxConcurrent, 5);
    } finally {
      if (prev !== undefined) process.env.DYNAMIC_TASK_MAX_CONCURRENT = prev;
      else delete process.env.DYNAMIC_TASK_MAX_CONCURRENT;
    }
  });

  it("empty env forbidden agents does NOT unblock 'general'", () => {
    const prev = process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS;
    process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS = "";
    try {
      const config = normalizeDynamicTaskConfig({});
      assert.ok(config.blockedAgents.includes("general"));
    } finally {
      if (prev !== undefined) process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS = prev;
      else delete process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS;
    }
  });

  it("explicit env forbidden agents overrides blockedAgents", () => {
    const prev = process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS;
    process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS = "coder,reviewer";
    try {
      const config = normalizeDynamicTaskConfig({});
      assert.deepStrictEqual(config.blockedAgents, ["coder", "reviewer"]);
    } finally {
      if (prev !== undefined) process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS = prev;
      else delete process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS;
    }
  });

  it("a comma-only forbidden-agents env does not clear the blocklist", () => {
    const prev = process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS;
    for (const junk of [",", " , ", ",,"]) {
      process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS = junk;
      try {
        assert.deepStrictEqual(normalizeDynamicTaskConfig({}).blockedAgents, ["general"], `env=${JSON.stringify(junk)}`);
      } finally {
        if (prev !== undefined) process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS = prev;
        else delete process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS;
      }
    }
  });
});

describe("config file layer", () => {
  it("file config fills gaps below tuple options", () => {
    const config = normalizeDynamicTaskConfig({ maxConcurrent: 3 }, { maxDepth: 5, maxConcurrent: 9 });
    assert.strictEqual(config.maxDepth, 5, "file value survives");
    assert.strictEqual(config.maxConcurrent, 3, "tuple options win over file");
  });

  it("garbage file config is ignored", () => {
    for (const junk of [null, undefined, "nope", 42, [1], {}]) {
      assert.strictEqual(normalizeDynamicTaskConfig({}, junk).maxDepth, 2);
    }
  });
});

describe("parseDynamicTaskJsonc", () => {
  it("returns null for a missing file", () => {
    assert.strictEqual(parseDynamicTaskJsonc("/nonexistent/path/config.jsonc"), null);
  });

  it("returns null for empty or non-object payloads", () => {
    assert.strictEqual(parseDynamicTaskJsonc(""), null);
    const file = `${tmpdir()}/dt-array-${Date.now()}.jsonc`;
    writeFileSync(file, "[1, 2]");
    try {
      assert.strictEqual(parseDynamicTaskJsonc(file), null);
    } finally {
      unlinkSync(file);
    }
  });

  it("strips comments and parses objects", () => {
    const file = `${tmpdir()}/dt-ok-${Date.now()}.jsonc`;
    writeFileSync(file, '{ /* block */ "maxDepth": 3 } // trailing\n');
    try {
      assert.deepStrictEqual(parseDynamicTaskJsonc(file), { maxDepth: 3 });
    } finally {
      unlinkSync(file);
    }
  });
});

describe("config field parsing edges", () => {
  it("agentCacheTtlMs comes from options", () => {
    const config = normalizeDynamicTaskConfig({ agentCacheTtlMs: 1500 });
    assert.strictEqual(config.agentCacheTtlMs, 1500);
  });

  it("rejects non-positive numbers everywhere", () => {
    const config = normalizeDynamicTaskConfig({ maxDepth: 0, maxConcurrent: -3, agentCacheTtlMs: NaN });
    assert.strictEqual(config.maxDepth, 2);
    assert.strictEqual(config.maxConcurrent, 4);
  });

  it("ignores non-boolean allowSameAgentRecursion", () => {
    assert.strictEqual(normalizeDynamicTaskConfig({ allowSameAgentRecursion: "yes" }).allowSameAgentRecursion, false);
    assert.strictEqual(normalizeDynamicTaskConfig({ allowSameAgentRecursion: true }).allowSameAgentRecursion, true);
  });
});

// ============================================================
// === Task 0 Step 3: Policy Tests ===
// Expected: FAIL because src/shared/task-policy.ts does not exist
// ============================================================

import {
  normalizeAgentName,
  validateAgent,
  isSameAgent,
  validateLineage,
  buildTaskLineage,

} from "../../dist/shared/task-policy.js";

describe("normalizeAgentName", () => {
  // type PolicyResult is type-only, imported via the functions' return types
  it("lowercases and trims agent names", () => {
    assert.strictEqual(normalizeAgentName("General"), "general");
    assert.strictEqual(normalizeAgentName("  REVIEWER "), "reviewer");
  });

  it("strips @ prefix", () => {
    assert.strictEqual(normalizeAgentName("@general"), "general");
    assert.strictEqual(normalizeAgentName("@Reviewer"), "reviewer");
  });

  it("returns null for unsupported types", () => {
    assert.strictEqual(normalizeAgentName(null), null);
    assert.strictEqual(normalizeAgentName(undefined), null);
    assert.strictEqual(normalizeAgentName(123), null);
    assert.strictEqual(normalizeAgentName(""), null);
  });
});

describe("validateAgent", () => {
  const config = normalizeDynamicTaskConfig({});

  it("rejects 'general' by default", () => {
    const result = validateAgent("general", config);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.error, /general/i);
  });

  it("rejects @General (normalized)", () => {
    const result = validateAgent("@General", config);
    assert.strictEqual(result.ok, false);
  });

  it("allows non-blocked agents", () => {
    const result = validateAgent("reviewer", config);
    assert.strictEqual(result.ok, true);
  });

  it("allows agents not in blockedAgents", () => {
    const customConfig = normalizeDynamicTaskConfig({ blockedAgents: ["coder"] });
    assert.strictEqual(validateAgent("reviewer", customConfig).ok, true);
    assert.strictEqual(validateAgent("coder", customConfig).ok, false);
    assert.strictEqual(validateAgent("general", customConfig).ok, true); // general is NOT blocked here
  });
});

describe("isSameAgent", () => {
  it("detects same agent ignoring @ prefix and case", () => {
    assert.strictEqual(isSameAgent("reviewer", "reviewer"), true);
    assert.strictEqual(isSameAgent("Reviewer", "reviewer"), true);
    assert.strictEqual(isSameAgent("@reviewer", "reviewer"), true);
    assert.strictEqual(isSameAgent("@Reviewer", "reviewer"), true);
  });

  it("rejects different agents", () => {
    assert.strictEqual(isSameAgent("reviewer", "coder"), false);
    assert.strictEqual(isSameAgent("explore", "general"), false);
  });
});

describe("validateLineage", () => {
  const config = normalizeDynamicTaskConfig({ maxDepth: 2 });

  it("rejects same-agent anywhere in lineage", () => {
    const result = validateLineage(["reviewer"], "reviewer", config);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.error, /recursion|same-agent|already present/i);
  });

  it("rejects same-agent deep in lineage", () => {
    const result = validateLineage(["general", "coder", "explore"], "general", config);
    assert.strictEqual(result.ok, false);
  });

  it("rejects when next depth exceeds maxDepth", () => {
    const result = validateLineage(["general", "coder"], "explore", config);
    assert.strictEqual(result.ok, false);
    if (!result.ok) assert.match(result.error, /depth/i);
  });

  it("allows different-agent chain within depth limit", () => {
    const result = validateLineage(["general"], "coder", config);
    assert.strictEqual(result.ok, true);
  });

  it("does not mutate lineage arrays", () => {
    const lineage = ["general", "coder"];
    const copy = [...lineage];
    validateLineage(lineage, "explore", config); // should fail — exceeds depth
    assert.deepStrictEqual(lineage, copy, "Lineage must not be mutated");
  });
});

describe("buildTaskLineage", () => {
  it("appends child agent to parent lineage", () => {
    const result = buildTaskLineage(["general", "coder"], "explore");
    assert.deepStrictEqual(result, ["general", "coder", "explore"]);
  });

  it("handles empty parent lineage", () => {
    const result = buildTaskLineage([], "reviewer");
    assert.deepStrictEqual(result, ["reviewer"]);
  });
});



// ============================================================
// === Task 0 Step 5: State Tests ===
// Expected: FAIL because src/shared/task-state.ts does not exist
// ============================================================

import {
  createTaskStore,
  registerActiveTask,
  transitionState,
  findTask,
  listTasks,
  pruneRetainedTasks,
  noteLateOutcome,
  restoreRetained,
  reviveRetainedTask,
  withdrawInterruptClaim,
  annotateNotice,
  recordAbortError,
  oldestRetainedId,
} from "../../dist/shared/task-state.js";
import {
  resolveAdmission,
  registerAdmittedTask,
  resolveDependencies,
  formatAdmissionError,
  parseAgentList,
} from "../../dist/shared/admission.js";
import {
  replyToQuestion,
  rejectQuestion,
  getRequestIdFromQuestion,
  isValidQuestionEvent,
  normalizeQuestionAnswers,
  resolveQuestionSession,
  decideQuestion,
  rememberQuestionSession,
  forgetQuestionSession,
} from "../../dist/shared/question-handling.js";
import { tmpdir } from "node:os";
import { checkConcurrencyLimit } from "../../dist/shared/config.js";

describe("task-state: createTaskStore", () => {
  it("creates empty active and retained maps", () => {
    const store = createTaskStore();
    assert.strictEqual(store.activeTasks.size, 0);
    assert.strictEqual(store.retainedTasks.size, 0);
  });
});

// Shared test-harness funnels: one way to build common fixtures.
function fillBackgroundTasks(store, config, ids) {
  for (const id of ids) {
    registerActiveTask(store, {
      childSessionId: id, parentSessionId: "parent_1",
      agentName: id, description: id, lineage: [],
    }, config);
  }
}

function seedSesActive(store, config) {
  registerActiveTask(store, {
    childSessionId: "ses_active", parentSessionId: "parent_1",
    agentName: "reviewer", description: "test", lineage: [],
  }, config);
}

describe("task-state: registerActiveTask", () => {
  const config = normalizeDynamicTaskConfig({ maxConcurrent: 3 });

  it("registers an active record for the session", () => {
    const store = createTaskStore();
    const task = registerActiveTask(store, {
      childSessionId: "ses_1",
      parentSessionId: "parent_1",
      agentName: "reviewer",
      description: "test task",
      lineage: ["explore"],
    }, config);
    assert.strictEqual(task.state, "active");
    assert.strictEqual(store.activeTasks.size, 1);
  });

  it("throws ConcurrencyLimitExceeded when at the limit", () => {
    const store = createTaskStore();
    fillBackgroundTasks(store, config, ["ses_1", "ses_2", "ses_3"]);
    assert.throws(() => {
      registerActiveTask(store, {
        childSessionId: "ses_4", parentSessionId: "parent_1",
        agentName: "a4", description: "t4", lineage: [],
      }, config);
    }, /Concurrency/);
  });

  it("settlement frees the slot for the next registration", () => {
    const store = createTaskStore();
    fillBackgroundTasks(store, config, ["ses_1", "ses_2", "ses_3"]);
    transitionState(store, "ses_1", "completed", config);
    const task = registerActiveTask(store, {
      childSessionId: "ses_4", parentSessionId: "parent_1",
      agentName: "a4", description: "t4", lineage: [],
    }, config);
    assert.strictEqual(task.state, "active");
  });
});

describe("task-state: transitionState", () => {
  const config = normalizeDynamicTaskConfig({});
  let store;

  beforeEach(() => {
    store = createTaskStore();
    seedSesActive(store, config);
  });

  it("settles active → completed into retention", () => {
    const result = transitionState(store, "ses_active", "completed", config);
    assert.strictEqual(result.state, "completed");
    assert.strictEqual(result.completed, true);
    assert.strictEqual(store.activeTasks.has("ses_active"), false);
    assert.strictEqual(store.retainedTasks.has("ses_active"), true);
  });

  it("transitions active → error and active → interrupted", () => {
    assert.strictEqual(transitionState(store, "ses_active", "error", config).state, "error");
    const store2 = createTaskStore();
    seedSesActive(store2, config);
    assert.strictEqual(transitionState(store2, "ses_active", "interrupted", config).state, "interrupted");
  });

  it("settle is exactly-once: a second settlement throws and cannot regress retention", () => {
    transitionState(store, "ses_active", "completed", config);
    assert.throws(() => transitionState(store, "ses_active", "error", config), /terminal|invalid|not found/i);
    assert.strictEqual(store.retainedTasks.get("ses_active").state, "completed");
  });

  it("settlement strips advisory notice metadata", () => {
    annotateNotice(store, "ses_active", "interim");
    transitionState(store, "ses_active", "completed", config);
    assert.ok(!("lastNotice" in store.retainedTasks.get("ses_active")));
  });

  it("retained task remains visible to findTask", () => {
    transitionState(store, "ses_active", "completed", config);
    const found = findTask(store, "ses_active");
    assert.ok(found, "Retained task must be findable");
    assert.strictEqual(found?.state, "completed");
  });

  it("unknown session ID transition throws", () => {
    assert.throws(() => transitionState(store, "nonexistent", "completed", config), /not found|invalid|not active/i);
  });
});

describe("task-state: revival and annotations", () => {
  const config = normalizeDynamicTaskConfig({});

  function retained(store, state = "completed") {
    seedSesActive(store, config);
    transitionState(store, "ses_active", state, config);
  }

  it("withdrawInterruptClaim returns a fresh speculative claim to active", () => {
    const store = createTaskStore();
    assert.strictEqual(withdrawInterruptClaim(store, "ses_nope"), false);
    seedSesActive(store, config);
    transitionState(store, "ses_active", "completed", config);
    assert.strictEqual(withdrawInterruptClaim(store, "ses_active"), false, "only interrupted claims withdraw");
    const store2 = createTaskStore();
    seedSesActive(store2, config);
    transitionState(store2, "ses_active", "interrupted", config);
    assert.strictEqual(withdrawInterruptClaim(store2, "ses_active"), true);
    assert.strictEqual(store2.activeTasks.get("ses_active")?.state, "active");
    assert.strictEqual(store2.retainedTasks.has("ses_active"), false);
    assert.strictEqual(withdrawInterruptClaim(store2, "ses_active"), false, "second withdrawal refuses");
  });

  it("reviveRetainedTask moves a settled task back to active", () => {
    const store = createTaskStore();
    retained(store);
    const revived = reviveRetainedTask(store, "ses_active", config);
    assert.strictEqual(revived.state, "active");
    assert.strictEqual(store.activeTasks.has("ses_active"), true);
    assert.strictEqual(store.retainedTasks.has("ses_active"), false);
  });

  it("interrupted tasks are not revived — that takes a fresh spawn", () => {
    const store = createTaskStore();
    retained(store, "interrupted");
    assert.throws(() => reviveRetainedTask(store, "ses_active", config), /interrupt/i);
  });

  it("revival passes through the concurrency gate", () => {
    const limited = normalizeDynamicTaskConfig({ maxConcurrent: 1 });
    const store = createTaskStore();
    seedSesActive(store, limited);
    transitionState(store, "ses_active", "completed", limited);
    registerActiveTask(store, {
      childSessionId: "ses_other", parentSessionId: "parent_1",
      agentName: "a2", description: "t2", lineage: [],
    }, limited);
    assert.throws(() => reviveRetainedTask(store, "ses_active", limited), /Concurrency/);
    assert.strictEqual(store.retainedTasks.get("ses_active").state, "completed", "rejected revival leaves the record untouched");
  });

  it("annotateNotice records the latest child message on active tasks only", () => {
    const store = createTaskStore();
    seedSesActive(store, config);
    assert.strictEqual(annotateNotice(store, "ses_active", "blocked on credentials"), true);
    assert.strictEqual(store.activeTasks.get("ses_active").lastNotice.message, "blocked on credentials");
    assert.strictEqual(annotateNotice(store, "ses_nope", "x"), false);
    transitionState(store, "ses_active", "completed", config);
    assert.strictEqual(annotateNotice(store, "ses_active", "late"), false, "settled tasks take no notices");
  });

  it("recordAbortError annotates retained records and is silent otherwise", () => {
    const store = createTaskStore();
    retained(store, "interrupted");
    recordAbortError(store, "ses_active", "boom");
    assert.strictEqual(store.retainedTasks.get("ses_active").abortError, "boom");
    recordAbortError(store, "ses_nope", "boom"); // no throw
  });

  it("oldestRetainedId reads retention order", () => {
    const store = createTaskStore();
    assert.strictEqual(oldestRetainedId(store), null);
    retained(store);
    assert.strictEqual(oldestRetainedId(store), "ses_active");
  });

  it("listTasks splits the fleet by state", () => {
    const store = createTaskStore();
    retained(store);
    registerActiveTask(store, {
      childSessionId: "ses_run", parentSessionId: "parent_1",
      agentName: "a", description: "d", lineage: [],
    }, config);
    const { active, retained: settled } = listTasks(store);
    assert.deepStrictEqual(active.map((t) => t.childSessionId), ["ses_run"]);
    assert.deepStrictEqual(settled.map((t) => t.childSessionId), ["ses_active"]);
  });
});

describe("admission gate: resolveAdmission", () => {
  const config = normalizeDynamicTaskConfig({});
  const agents = [
    { name: "explore" },
    { name: "architect", mode: "all" },
  ];

  it("admits a known agent with extended lineage", () => {
    const result = resolveAdmission(agents, "explore", ["planner"], config);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.agent.name, "explore");
    assert.deepStrictEqual(result.newLineage, ["planner", "explore"]);
  });

  it("does not mutate the input lineage", () => {
    const lineage = ["planner"];
    resolveAdmission(agents, "explore", lineage, config);
    assert.deepStrictEqual(lineage, ["planner"]);
  });

  it("denies missing names", () => {
    for (const bad of [undefined, null, "", "   "]) {
      const result = resolveAdmission(agents, bad, [], config);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason.kind, "missing-name");
    }
  });

  it("denies unknown agents", () => {
    const result = resolveAdmission(agents, "nope", [], config);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason.kind, "unknown-agent");
  });

  it("denies blocked agents", () => {
    const result = resolveAdmission([{ name: "general" }], "general", [], config);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason.kind, "blocked");
  });

  it("denies lineage violations", () => {
    const result = resolveAdmission(agents, "explore", ["explore"], config);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason.kind, "lineage");
  });
});

describe("admission gate: allowSameAgentRecursion", () => {
  const strict = normalizeDynamicTaskConfig({});
  const lenient = normalizeDynamicTaskConfig({ allowSameAgentRecursion: true });

  it("blocks same-agent recursion by default", () => {
    const result = resolveAdmission([{ name: "explore" }], "explore", ["explore"], strict);
    assert.strictEqual(result.ok, false);
  });

  it("honors the recursion flag", () => {
    const result = resolveAdmission([{ name: "explore" }], "explore", ["explore"], lenient);
    assert.strictEqual(result.ok, true);
  });

  it("still enforces depth when recursion is allowed", () => {
    const shallow = normalizeDynamicTaskConfig({ allowSameAgentRecursion: true, maxDepth: 1 });
    const result = resolveAdmission([{ name: "explore" }], "explore", ["a", "b"], shallow);
    assert.strictEqual(result.ok, false);
  });
});

describe("admission gate: resolveDependencies", () => {
  const config = normalizeDynamicTaskConfig({});

  function storeWith(childSessionId, state) {
    const store = createTaskStore();
    registerActiveTask(store, {
      childSessionId, parentSessionId: "p", agentName: "a",
      description: "d", lineage: [],
    }, config);
    if (state !== "active") transitionState(store, childSessionId, state, config);
    return store;
  }

  it("admits with no dependencies", () => {
    assert.deepStrictEqual(
      resolveDependencies(createTaskStore(), undefined),
      { ok: true }
    );
  });

  it("admits when deps completed", () => {
    const store = storeWith("s1", "completed");
    const s2 = createTaskStore();
    for (const [id, task] of store.retainedTasks) s2.retainedTasks.set(id, task);
    assert.deepStrictEqual(resolveDependencies(s2, ["s1"]), { ok: true });
  });

  it("refuses with the pending set for running or failed deps", () => {
    const active = storeWith("s1", "active");
    assert.deepStrictEqual(resolveDependencies(active, ["s1"]), { ok: false, pending: ["s1"] });
    const failed = storeWith("s2", "error");
    assert.deepStrictEqual(resolveDependencies(failed, ["s2"]), { ok: false, pending: ["s2"] });
  });

  it("treats unknown ids as satisfied (aged-out tolerance)", () => {
    assert.deepStrictEqual(resolveDependencies(createTaskStore(), ["ses_gone"]), { ok: true });
  });
});

describe("admission gate: formatAdmissionError", () => {
  it("renders all refusal kinds with remedy", () => {
    assert.ok(
      formatAdmissionError({ kind: "missing-name" }, "explore", undefined).includes("No subagent_type")
    );
    assert.ok(
      formatAdmissionError({ kind: "unknown-agent", requested: "nope" }, "explore", "nope").includes('"nope" not found')
    );
    assert.ok(
      formatAdmissionError({ kind: "blocked", message: "blocked msg" }, "explore", "general").includes("blocked msg")
    );
    assert.ok(
      formatAdmissionError({ kind: "lineage", message: "depth msg" }, "explore", "explore").includes("depth msg")
    );
  });
});

describe("admission gate: parseAgentList", () => {
  it("accepts bare arrays and drops nameless records", () => {
    const records = parseAgentList([
      { name: "explore", mode: "subagent" },
      { noName: true },
      null,
    ]);
    assert.deepStrictEqual(records.map((a) => a.name), ["explore"]);
  });

  it("accepts data and agents envelopes", () => {
    assert.deepStrictEqual(
      parseAgentList({ data: [{ name: "a" }] }).map((a) => a.name),
      ["a"]
    );
    assert.deepStrictEqual(
      parseAgentList({ agents: [{ name: "b" }] }).map((a) => a.name),
      ["b"]
    );
  });

  it("prefers the first non-empty list", () => {
    assert.deepStrictEqual(
      parseAgentList({ agents: [], data: [{ name: "c" }] }).map((a) => a.name),
      ["c"]
    );
  });

  it("rejects garbage", () => {
    for (const bad of [null, undefined, "str", 42, {}, { agents: "x" }, [{ noName: 1 }]]) {
      assert.deepStrictEqual(parseAgentList(bad), [], JSON.stringify(bad));
    }
  });
});

describe("admission gate: registerAdmittedTask", () => {
  const config = normalizeDynamicTaskConfig({});

  it("registers through the funnel and enforces the concurrency limit", () => {
    const limited = normalizeDynamicTaskConfig({ maxConcurrent: 1 });
    const store = createTaskStore();
    const task = registerAdmittedTask(store, {
      childSessionId: "ses_1", parentSessionId: "parent_1",
      agentName: "explore", description: "t1", lineage: [],
    }, limited);
    assert.strictEqual(task.agentName, "explore");
    assert.throws(() => registerAdmittedTask(store, {
      childSessionId: "ses_2", parentSessionId: "parent_1",
      agentName: "explore", description: "t2", lineage: [],
    }, limited), /Concurrency/);
  });
});

describe("prompt dance: invokePrompt", () => {
  it("sends the single payload shape and resolves with the client result", async () => {
    let captured;
    const client = {
      session: {
        prompt: async (args) => {
          captured = args;
          return { parts: [{ type: "text", text: "hi" }] };
        },
      },
    };
    const result = await invokePrompt(client, "ses_1", "hello");
    assert.deepStrictEqual(captured, {
      path: { id: "ses_1" },
      body: { parts: [{ type: "text", text: "hello" }] },
    });
    assert.deepStrictEqual(result, { parts: [{ type: "text", text: "hi" }] });
  });

  it("rejects with the raw client error (callers classify)", async () => {
    const failure = new Error("boom");
    const client = { session: { prompt: async () => { throw failure; } } };
    await assert.rejects(() => invokePrompt(client, "ses_1", "hello"), /boom/);
  });
});

describe("prompt dance: parseModelOverride", () => {
  it("splits provider and model on the first slash", () => {
    assert.deepStrictEqual(parseModelOverride("prov/model-x"), { providerID: "prov", modelID: "model-x" });
    assert.deepStrictEqual(parseModelOverride("a/b/c"), { providerID: "a", modelID: "b/c" });
  });

  it("keeps providerless models with an empty provider", () => {
    assert.deepStrictEqual(parseModelOverride("lonely"), { providerID: "", modelID: "lonely" });
  });

  it("rejects empty and non-string overrides", () => {
    assert.strictEqual(parseModelOverride(""), undefined);
    assert.strictEqual(parseModelOverride("   "), undefined);
    assert.strictEqual(parseModelOverride(null), undefined);
    assert.strictEqual(parseModelOverride(undefined), undefined);
    assert.strictEqual(parseModelOverride(42), undefined);
  });
});

describe("prompt dance: classifyPromptError", () => {
  it("marks transport failures retryable", () => {
    for (const msg of ["ECONNREFUSED", "request ETIMEDOUT", "fetch failed", "network error"]) {
      const classified = classifyPromptError(new Error(msg));
      assert.strictEqual(classified.retryable, true, msg);
      assert.strictEqual(classified.message, msg);
    }
  });

  it("marks application errors non-retryable", () => {
    const classified = classifyPromptError(new Error("session not found"));
    assert.strictEqual(classified.retryable, false);
    assert.strictEqual(classified.message, "session not found");
  });

  it("handles non-Error values", () => {
    assert.strictEqual(classifyPromptError("plain string").message, "plain string");
    assert.strictEqual(classifyPromptError(null).retryable, false);
  });
});

describe("message/part family guards (Task 08)", () => {
  it("isTextPart accepts only parts that declare themselves text with string content", () => {
    assert.ok(isTextPart({ type: "text", text: "hi" }));
    assert.ok(isTextPart({ type: "text", text: "" }));
    assert.ok(!isTextPart({ type: "text" }));
    assert.ok(!isTextPart({ type: "text", text: 42 }));
    assert.ok(!isTextPart({ type: "image", url: "x" }));
    assert.ok(!isTextPart({ text: "legacy, untyped" }));
    assert.ok(!isTextPart("text"));
    assert.ok(!isTextPart(null));
  });

  it("isMessage is a record with an array parts field", () => {
    assert.ok(isMessage({ parts: [] }));
    assert.ok(isMessage({ role: "assistant", parts: [{ type: "text", text: "x" }] }));
    assert.ok(!isMessage({ parts: "nope" }));
    assert.ok(!isMessage({}));
    assert.ok(!isMessage(null));
    assert.ok(!isMessage([]));
  });

  it("messageRoleOf reads nested info first, falls back to top level, empty when neither", () => {
    assert.strictEqual(messageRoleOf({ info: { role: "assistant" }, parts: [] }), "assistant");
    assert.strictEqual(messageRoleOf({ role: "user", parts: [] }), "user");
    assert.strictEqual(messageRoleOf({ parts: [] }), "");
    assert.strictEqual(messageRoleOf({ info: "junk", role: "system", parts: [] }), "system");
    assert.strictEqual(messageRoleOf({ info: { role: 42 }, parts: [] }), "");
  });

  it("the extraction group is built on the guards: same answers through either door", () => {
    const parts = [{ type: "text", text: "a" }, { type: "tool", x: 1 }, { type: "text", text: "b" }];
    assert.strictEqual(extractTextFromParts(parts), "a\nb");
    const messages = [{ info: { role: "user" }, parts: [] }, { role: "assistant", parts: [{ type: "text", text: "final" }] }];
    assert.strictEqual(getLatestAssistantText(messages), "final");
    // Non-message entries are skipped by the guard, never thrown on.
    assert.strictEqual(getLatestAssistantText([null, "junk", ...messages]), "final");
  });
});



describe("question gate: reply/reject settlement", () => {
  function questionClient(behavior) {
    return { question: { reply: behavior.reply, reject: behavior.reject } };
  }
  const okClient = () => questionClient({ reply: async () => {}, reject: async () => {} });

  it("reply succeeds", async () => {
    assert.deepStrictEqual(await replyToQuestion(okClient(), "q1", "yes"), { succeeded: true });
  });

  it("reply absorbs already-resolved as success", async () => {
    const client = questionClient({ reply: async () => { throw new Error("already resolved"); }, reject: async () => {} });
    assert.deepStrictEqual(
      await replyToQuestion(client, "q1", "yes"),
      { succeeded: true, reason: "already_resolved" }
    );
  });

  it("reply reports transport failures", async () => {
    const client = questionClient({ reply: async () => { throw new Error("nope"); }, reject: async () => {} });
    assert.deepStrictEqual(
      await replyToQuestion(client, "q1", "yes"),
      { succeeded: false, reason: "nope" }
    );
  });

  it("reply rejects missing id/answer", async () => {
    assert.strictEqual((await replyToQuestion(okClient(), "", "yes")).succeeded, false);
    assert.strictEqual((await replyToQuestion(okClient(), "q1", "")).succeeded, false);
  });

  it("reject succeeds and absorbs 409 conflicts", async () => {
    assert.deepStrictEqual(await rejectQuestion(okClient(), "q1", "busy"), { succeeded: true });
    const conflicted = questionClient({
      reply: async () => {},
      reject: async () => { const e = new Error("gone"); e.status = 409; throw e; },
    });
    assert.deepStrictEqual(
      await rejectQuestion(conflicted, "q1", "busy"),
      { succeeded: true, reason: "already_resolved" }
    );
  });

  it("reject rejects missing id", async () => {
    assert.strictEqual((await rejectQuestion(okClient(), "", "busy")).succeeded, false);
  });
});

describe("question handling: event helpers", () => {
  it("getRequestIdFromQuestion follows the priority chain", () => {
    const props = (p) => ({ type: "question.created", properties: p });
    assert.strictEqual(getRequestIdFromQuestion(props({ id: "a", request_id: "b" })), "a");
    assert.strictEqual(getRequestIdFromQuestion(props({ request_id: "b" })), "b");
    assert.strictEqual(getRequestIdFromQuestion(props({ task_id: "c" })), "c");
    assert.strictEqual(getRequestIdFromQuestion(props({ requestID: "d" })), "d");
    assert.strictEqual(getRequestIdFromQuestion(props({})), null);
  });

  it("isValidQuestionEvent guards shapes", () => {
    assert.strictEqual(isValidQuestionEvent({ type: "question.created" }), true);
    assert.strictEqual(isValidQuestionEvent({ type: "question.replied" }), true);
    assert.strictEqual(isValidQuestionEvent({ type: "question.rejected" }), true);
    assert.strictEqual(isValidQuestionEvent({ type: "nope" }), false);
    assert.strictEqual(isValidQuestionEvent(null), false);
  });

  it("normalizeQuestionAnswers flattens answer shapes", () => {
    assert.deepStrictEqual(
      normalizeQuestionAnswers(["a", { text: "b" }, { value: "c" }, "", null]),
      ["a", "b", "c"]
    );
    assert.deepStrictEqual(normalizeQuestionAnswers("nope"), []);
    assert.deepStrictEqual(normalizeQuestionAnswers(undefined), []);
  });
});

describe("task formatting: truncate + debug shape", () => {
  it("noticeDedupKey separates distinct long messages sharing a prefix", () => {
    const first = noticeDedupKey("a".repeat(200) + "1");
    const second = noticeDedupKey("a".repeat(200) + "2");
    assert.notStrictEqual(first, second, "full content keys the dedup, not a prefix");
    assert.strictEqual(noticeDedupKey("same"), noticeDedupKey("same"), "deterministic");
  });

  it("truncateText caps long output", () => {
    const out = truncateText("x".repeat(1300));
    assert.strictEqual(out.length, 1203);
    assert.ok(out.endsWith("..."));
    assert.strictEqual(truncateText("short"), "short");
  });

  it("formatTaskResultSummary never truncates latest output — pull path is full text", () => {
    const body = "y".repeat(5000);
    const result = formatTaskResultSummary({
      sessionId: "s", status: "completed", messageCount: 1,
      latestText: body, tracked: true,
    });
    assert.ok(result.includes(body), "operator-pulled output must be complete");
  });

  it("formatTaskResultSummary surfaces delivery records", () => {
    const base = {
      sessionId: "s", status: "completed", messageCount: 1,
      latestText: "hi", tracked: true,
    };
    assert.ok(
      formatTaskResultSummary({ ...base, notification: { kind: "completed", delivered: true, attempts: 1 } })
        .includes("delivered in 1 attempt")
    );
    assert.ok(
      formatTaskResultSummary({ ...base, notification: { kind: "timeout", delivered: false, attempts: 2 } })
        .includes("FAILED after 2 attempt")
    );
    assert.ok(!formatTaskResultSummary(base).includes("notification:"));
  });

  it("formatTaskResultSummary includes debug shape when provided", () => {
    const summary = formatTaskResultSummary({
      sessionId: "s", status: "completed", messageCount: 1,
      latestText: "hi", tracked: true, debugShape: "SHAPE",
    });
    assert.ok(summary.includes("SHAPE"));
  });

  it("isTerminalSessionEvent matches the broad catch-all", () => {
    assert.strictEqual(
      isTerminalSessionEvent({ type: "session.custom", properties: { sessionID: "s1", status: "idle" } }),
      true
    );
  });
});

describe("task policy: invalid inputs", () => {
  const config = normalizeDynamicTaskConfig({});

  it("validateAgent rejects empty names", () => {
    assert.strictEqual(validateAgent("", config).ok, false);
    assert.strictEqual(validateAgent(null, config).ok, false);
  });

  it("validateLineage rejects empty child names", () => {
    assert.strictEqual(validateLineage([], "", config).ok, false);
  });

  it("a second settlement attempt cannot regress the first outcome", () => {
    // The timeout-era races are structurally gone: settlement is exactly once
    // (active -> terminal), so a late error after a reported completion can
    // only arrive through noteLateOutcome, never through transitionState.
    const store = createTaskStore();
    seedSesActive(store, config);
    transitionState(store, "ses_active", "completed");
    assert.throws(() => transitionState(store, "ses_active", "error"), /terminal|invalid/i);
    assert.strictEqual(store.retainedTasks.get("ses_active").state, "completed");
  });
});

describe("prompt dance: extractor shape coverage", () => {

  it("classifyPromptError handles odd shapes", () => {
    assert.strictEqual(classifyPromptError({ message: 42 }).message, "42");
    assert.strictEqual(classifyPromptError(undefined).message, "undefined");
    assert.strictEqual(classifyPromptError(undefined).retryable, false);
  });
});

describe("config: file and env edges", () => {
  it("parseDynamicTaskJsonc returns null for malformed JSON", () => {
    const file = `${tmpdir()}/dt-malformed-${Date.now()}.jsonc`;
    writeFileSync(file, "{ not json,");
    try {
      assert.strictEqual(parseDynamicTaskJsonc(file), null);
    } finally {
      unlinkSync(file);
    }
  });

  it("parseDynamicTaskJsonc returns null for non-object JSON", () => {
    const file = `${tmpdir()}/dt-array-${Date.now()}.jsonc`;
    writeFileSync(file, "[1, 2]");
    try {
      assert.strictEqual(parseDynamicTaskJsonc(file), null);
    } finally {
      unlinkSync(file);
    }
  });

  it("ignores non-numeric env maxConcurrent", () => {
    const prev = process.env.DYNAMIC_TASK_MAX_CONCURRENT;
    process.env.DYNAMIC_TASK_MAX_CONCURRENT = "bogus";
    try {
      assert.strictEqual(normalizeDynamicTaskConfig({}).maxConcurrent, 4);
    } finally {
      if (prev === undefined) delete process.env.DYNAMIC_TASK_MAX_CONCURRENT;
      else process.env.DYNAMIC_TASK_MAX_CONCURRENT = prev;
    }
  });
});



describe("prompt dance: getLatestAssistantText", () => {
  const assistant = (text) => ({ role: "assistant", parts: [{ type: "text", text }] });
  const user = (text) => ({ role: "user", parts: [{ type: "text", text }] });

  it("returns the newest assistant text", () => {
    assert.strictEqual(
      getLatestAssistantText([assistant("first"), user("q"), assistant("second")]),
      "second"
    );
  });

  it("skips messages before startIndex and empty parts", () => {
    assert.strictEqual(getLatestAssistantText([assistant("old"), assistant("new")], 1), "new");
    assert.strictEqual(getLatestAssistantText([assistant(""), user("q")]), "");
    assert.strictEqual(getLatestAssistantText([]), "");
    assert.strictEqual(getLatestAssistantText(null), "");
  });
});

describe("prompt dance: hydrateLatestOutcome", () => {
  it("reads the latest assistant text from the session", async () => {
    const client = {
      session: {
        messages: async () => [{ role: "assistant", parts: [{ type: "text", text: "CHILD_SAYS" }] }],
      },
    };
    assert.deepStrictEqual(await hydrateLatestOutcome(client, "ses_1"), { text: "CHILD_SAYS", errorDetail: "" });
  });

  it("surfaces the message-level error detail from the same read", async () => {
    const client = {
      session: {
        messages: async () => [{
          info: { role: "assistant", error: { name: "APIError", data: { message: "Too Many Requests" } } },
          parts: [],
        }],
      },
    };
    assert.deepStrictEqual(await hydrateLatestOutcome(client, "ses_1"), { text: "", errorDetail: "Too Many Requests" });
  });

  it("falls back to empty fields when messages fail", async () => {
    const client = { session: { messages: async () => { throw new Error("gone"); } } };
    assert.deepStrictEqual(await hydrateLatestOutcome(client, "ses_1"), { text: "", errorDetail: "" });
  });
});

describe("task-state: noteLateOutcome", () => {
  const config = normalizeDynamicTaskConfig({});

  function seedCompleted(store) {
    seedSesActive(store, config);
    transitionState(store, "ses_active", "completed");
  }

  it("escalates a completed record to error — the one retained rewrite edge", () => {
    const store = createTaskStore();
    seedCompleted(store);
    assert.strictEqual(noteLateOutcome(store, "ses_active", "error"), true);
    assert.strictEqual(store.retainedTasks.get("ses_active").state, "error");
    assert.ok(store.retainedTasks.has("ses_active"), "stays retained");
  });

  it("refuses to rewrite interrupted or errored records", () => {
    const store = createTaskStore();
    seedSesActive(store, config);
    transitionState(store, "ses_active", "interrupted");
    assert.strictEqual(noteLateOutcome(store, "ses_active", "error"), false);
  });

  it("refuses non-edges and unknown sessions", () => {
    const store = createTaskStore();
    seedCompleted(store);
    assert.strictEqual(noteLateOutcome(store, "ses_active", "completed"), false);
    assert.strictEqual(noteLateOutcome(store, "ses_nope", "error"), false);
  });
});

describe("question gate: resolveQuestionSession", () => {
  const config = normalizeDynamicTaskConfig({});

  function trackedStore() {
    const store = createTaskStore();
    registerActiveTask(store, {
      childSessionId: "ses_child", parentSessionId: "parent_1",
      agentName: "explore", description: "t", lineage: [],
    }, config);
    return store;
  }

  it("resolves via remembered linkage first", () => {
    const store = trackedStore();
    rememberQuestionSession("q1", "ses_child");
    try {
      const resolved = resolveQuestionSession({ type: "question.created", properties: { id: "q1" } }, store);
      assert.deepStrictEqual(resolved, { questionId: "q1", childSessionId: "ses_child" });
    } finally {
      forgetQuestionSession("q1");
    }
  });

  it("resolves ownership from session id fields validated against the store", () => {
    const store = trackedStore();
    for (const key of ["sessionID", "sessionId", "session_id"]) {
      const resolved = resolveQuestionSession(
        { type: "question.created", properties: { id: "q2", [key]: "ses_child" } },
        store
      );
      assert.deepStrictEqual(resolved, { questionId: "q2", childSessionId: "ses_child" }, key);
    }
  });

  it("resolves task ids validated against retained tasks", () => {
    const store = trackedStore();
    transitionState(store, "ses_child", "completed", config);
    const resolved = resolveQuestionSession(
      { type: "question.created", properties: { id: "q3", task_id: "ses_child" } },
      store
    );
    assert.deepStrictEqual(resolved, { questionId: "q3", childSessionId: "ses_child" });
  });

  it("refuses to guess: unknown ids resolve unattributed, missing ids null", () => {
    const store = trackedStore();
    assert.deepStrictEqual(
      resolveQuestionSession({ type: "question.created", properties: { id: "q4", sessionID: "ses_stranger" } }, store),
      { questionId: "q4", childSessionId: null }
    );
    assert.deepStrictEqual(
      resolveQuestionSession({ type: "question.created", properties: { sessionID: "ses_child" } }, store),
      null
    );
  });
});

describe("question gate: decideQuestion", () => {
  it("active with answers replies first", () => {
    assert.deepStrictEqual(decideQuestion("active", ["yes", "no"]), { action: "reply", answer: "yes" });
  });

  it("active without answers rejects with follow-up guidance", () => {
    const decision = decideQuestion("active", []);
    assert.strictEqual(decision.action, "reject");
    assert.ok(decision.reason.includes("task_continue"));
  });

  it("retained rejects with settled guidance", () => {
    const decision = decideQuestion("retained", ["yes"]);
    assert.strictEqual(decision.action, "reject");
    assert.ok(decision.reason.includes("settled"));
  });
});

describe("task store: retained-change callback", () => {
  const config = normalizeDynamicTaskConfig({});

  function seedActive(store, id) {
    registerActiveTask(store, {
      childSessionId: id, parentSessionId: "p",
      agentName: "a", description: "d", lineage: [],
    }, config);
  }

  it("notifies on retained writes, silent on active-only writes", () => {
    const store = createTaskStore();
    let calls = 0;
    store.onRetainedChange = () => { calls++; };
    seedActive(store, "s1");
    assert.strictEqual(calls, 0, "active-only writes stay silent");
    transitionState(store, "s1", "completed", config);
    assert.strictEqual(calls, 1);
    noteLateOutcome(store, "s1", "error");
    assert.strictEqual(calls, 2);
    reviveRetainedTask(store, "s1", config);
    assert.strictEqual(calls, 3, "revival leaves the retained ledger");
  });

  it("pruning emits the change signal when entries expire", () => {
    const store = createTaskStore();
    let calls = 0;
    store.onRetainedChange = () => { calls++; };
    seedActive(store, "s1");
    transitionState(store, "s1", "completed", config);
    store.retainedTasks.get("s1").retainedAt = 0;
    assert.strictEqual(pruneRetainedTasks(store, { retainedTaskTtlMs: 1000, retainedTaskMaxEntries: 100 }), 1);
    assert.strictEqual(calls, 2);
  });
});

describe("task formatting: fleet views", () => {
  it("formatTaskListSummary counts and rows active plus retained", () => {
    const now = Date.now();
    const summary = formatTaskListSummary({
      active: [{
        childSessionId: "ses_a", agentName: "explore", description: "A task",
        state: "active", startedAt: now - 45000,
      }],
      retained: [{
        childSessionId: "ses_r", agentName: "reviewer", description: "R task",
        state: "completed", startedAt: now - 5000,
      }],
      maxConcurrent: 4,
    });
    assert.ok(summary.includes("Active: 1/4"), `got: ${summary}`);
    assert.ok(summary.includes("ses_a") && summary.includes("ses_r"));
    assert.ok(summary.includes("45s"), `ages render. got: ${summary}`);
  });

  it("formatTaskListSummary names empty states", () => {
    const summary = formatTaskListSummary({ active: [], retained: [], maxConcurrent: 4 });
    assert.ok(summary.includes("(none)"));
  });

  it("formatTaskStatusDetail renders tracked metadata offline", () => {
    const detail = formatTaskStatusDetail({
      childSessionId: "ses_1",
      parentSessionId: "parent_1",
      agentName: "explore",
      description: "Deep dive",
      lineage: ["planner"],
      state: "active",
      startedAt: 1,
      requestedModel: { providerID: "prov", modelID: "model" },
      dependsOn: ["ses_dep"],
      lastNotice: { message: "blocked on credentials", at: Date.now() },
    }, null);
    assert.ok(detail.includes("ses_1"));
    assert.ok(detail.includes("planner"));
    assert.ok(detail.includes("prov/model"));
    assert.ok(detail.includes("ses_dep"));
    assert.ok(detail.includes("blocked on credentials"));
  });

  it("formatTaskStatusDetail surfaces delivery records", () => {
    const detail = formatTaskStatusDetail({
      childSessionId: "ses_1", parentSessionId: "p", agentName: "a",
      description: "d", lineage: [], state: "completed",
      startedAt: 1, retainedAt: 2,
    }, { kind: "error", delivered: false, attempts: 2 });
    assert.ok(detail.includes("FAILED"), `got: ${detail}`);
  });
});

describe("task-state: restoreRetained", () => {
  const config = normalizeDynamicTaskConfig({});

  function ledgerEntry(id, state = "completed") {
    return {
      childSessionId: id, parentSessionId: "p", agentName: "a",
      description: "d", lineage: [], state,
      startedAt: 1, retainedAt: 2,
    };
  }

  it("restores unknown ids and skips live state", () => {
    const store = createTaskStore();
    seedSesActive(store, config);
    const restored = restoreRetained(store, [
      ["ses_ledger", ledgerEntry("ses_ledger")],
      ["ses_active", ledgerEntry("ses_active")],
    ]);
    assert.strictEqual(restored, 1);
    assert.ok(store.retainedTasks.has("ses_ledger"));
    assert.ok(store.activeTasks.has("ses_active"), "live state wins");
  });

  it("returns zero for empty input", () => {
    assert.strictEqual(restoreRetained(createTaskStore(), []), 0);
  });
});

describe("task-state: concurrency helper", () => {
  const config = normalizeDynamicTaskConfig({ maxConcurrent: 2 });

  it("returns null when under limit", () => {
    const result = checkConcurrencyLimit(1, config);
    assert.strictEqual(result, null);
  });

  it("returns error message when at limit", () => {
    const result = checkConcurrencyLimit(2, config);
    assert.ok(result.includes("Cannot run more than"));
    assert.ok(result.includes("2"));
  });

  it("returns error message when over limit", () => {
    const result = checkConcurrencyLimit(3, config);
    assert.ok(result);
  });
});

// ═════════════════════════════════════════════════════════════════════
// Coverage gap tests — Closing gaps to 90%+ coverage
// ═════════════════════════════════════════════════════════════════════


describe("pruneRetainedTasks — TTL and max entry eviction", () => {
  const config = normalizeDynamicTaskConfig({ retainedTaskTtlMs: 50, retainedTaskMaxEntries: 2 });

  it("removes expired retained tasks by TTL", async () => {
    const store = createTaskStore();
    // Add a retained task with a past retainedAt
    const oldTask = {
      childSessionId: "ses_old", parentSessionId: "parent_1", agentName: "reviewer",
      description: "old", lineage: [], timeoutHandle: null, startedAt: 0,
      state: "completed" , retainedAt: Date.now() - 100000,
    };
    store.retainedTasks.set("ses_old", oldTask );

    const pruned = pruneRetainedTasks(store, config);
    assert.strictEqual(pruned, 1, "Should prune 1 expired entry");
    assert.strictEqual(store.retainedTasks.size, 0);
  });

  it("evicts oldest entries when over max", () => {
    const store = createTaskStore();
    // Add 3 retained tasks (max is 2) — all within TTL window (retainedAt near now)
    const now = Date.now();
    store.retainedTasks.set("ses_a", {
      childSessionId: "ses_a", parentSessionId: "p", agentName: "a",
      description: "a", lineage: [],
      state: "completed", retainedAt: now - 5,
    });
    store.retainedTasks.set("ses_b", {
      childSessionId: "ses_b", parentSessionId: "p", agentName: "b",
      description: "b", lineage: [],
      state: "completed", retainedAt: now - 3,
    });
    store.retainedTasks.set("ses_c", {
      childSessionId: "ses_c", parentSessionId: "p", agentName: "c",
      description: "c", lineage: [],
      state: "completed", retainedAt: now,
    });

    const pruned = pruneRetainedTasks(store, config);
    assert.strictEqual(pruned, 1, "Should evict 1 oldest entry");
    assert.strictEqual(store.retainedTasks.size, 2);
    // Oldest (ses_a) should be gone
    assert.ok(!store.retainedTasks.has("ses_a"));
  });

  it("prunes nothing when under limits", () => {
    const store = createTaskStore();
    const now = Date.now();
    store.retainedTasks.set("ses_1", {
      childSessionId: "ses_1", parentSessionId: "p", agentName: "a",
      description: "1", lineage: [],
      state: "completed", retainedAt: now,
    } );

    const pruned = pruneRetainedTasks(store, config);
    assert.strictEqual(pruned, 0);
    assert.strictEqual(store.retainedTasks.size, 1);
  });
});

describe("findTask — edge cases", () => {
  it("returns null for unknown session ID", () => {
    const store = createTaskStore();
    const result = findTask(store, "nonexistent");
    assert.strictEqual(result, null);
  });

  it("finds active task before retained task", () => {
    const store = createTaskStore();
    registerActiveTask(store, {
      childSessionId: "ses_dup", parentSessionId: "p",
      agentName: "a", description: "t", lineage: [],
    }, normalizeDynamicTaskConfig({}));
    // Add same key to retained (should not happen in practice but test priority)
    store.retainedTasks.set("ses_dup", {
      childSessionId: "ses_dup", parentSessionId: "p", agentName: "a",
      description: "t", lineage: [],
      state: "completed", retainedAt: Date.now(),
    } );

    const result = findTask(store, "ses_dup");
    assert.strictEqual(result?.state, "active", "Should find active before retained");
  });
});

describe("debugLog — closed to 100% coverage", () => {
  const LOG_DIR = ".dynamic-task-logs";

  beforeEach(() => {
    // Clean up any logs from previous runs
    try { rmSync(LOG_DIR, { recursive: true, force: true }); } catch { /* ok */ }
    process.env.DYNAMIC_TASK_DEBUG = "1";
  });

  afterEach(() => {
    delete process.env.DYNAMIC_TASK_DEBUG;
    try { rmSync(LOG_DIR, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it("writes a log file when DYNAMIC_TASK_DEBUG=1", () => {
    debugLog("parent_1", "child_1", "test-event", { key: "value" });

    const logPath = getDebugLogPath("parent_1", "child_1");
    assert.ok(existsSync(logPath), `Log not found at ${logPath}`);
    const content = readFileSync(logPath, "utf8");
    assert.match(content, /test-event/);
    assert.match(content, /"key":"value"/);
  });

  it("logs nothing when DYNAMIC_TASK_DEBUG is not 1", () => {
    delete process.env.DYNAMIC_TASK_DEBUG;
    debugLog("parent_2", "child_2", "silent-event", { data: "should not appear" });

    const logPath = getDebugLogPath("parent_2", "child_2");
    assert.ok(!existsSync(logPath), "Log should NOT exist when debug is off");
  });

  it("sanitizes session IDs to prevent path traversal", () => {
    const path = getDebugLogPath("../etc", "../../passwd");
    assert.ok(!path.includes(".."), "Path must not contain parent directory references");
    assert.match(path, /etc/);
    assert.match(path, /passwd/);
  });
});

