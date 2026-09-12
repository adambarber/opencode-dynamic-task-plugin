import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";

// Tenet 12: pin the real production contract via dist/ — never local copies.
import {
  buildAgentList,
  validateSessionResult,
  resolveParentSessionId,
  fetchAgents,
  resetAgentCache,
  extractSessionStatus,
} from "../../dist/index.js";
import * as pluginEntry from "../../dist/index.js";
import {
  invokePrompt,
  classifyPromptError,
  extractTextFromParts,
  extractTextFromPromptResult,
  getLatestAssistantText,
  hydrateLatestOutcome,
  parseModelOverride,
  isTextPart,
  isMessage,
  messageRoleOf,
  messageErrorDetail,
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

// The host invokes the entry's named exports outside the plugin lifecycle
// (observed during boot: buildAgentList with a non-array, fetchAgents with
// an unusable client) and any throw fails the whole plugin load. This
// invariant pins totality for every named function export so the next probe
// victim is caught here, not in a field log.
describe("plugin entry: named exports are total on host probe input", () => {
  it("no named function export throws on undefined", async () => {
    resetAgentCache();
    const failures = [];
    for (const [name, value] of Object.entries(pluginEntry)) {
      if (name === "default" || typeof value !== "function") continue;
      try {
        await value(undefined);
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    resetAgentCache();
    assert.deepStrictEqual(failures, []);
  });
});

// --- Shared Session Lifecycle Helpers (Task 1) ---
// These import from the shared module to verify extraction works
import {
  normalizeStatus,
  getSessionIdFromEvent,
  getEventLifecycleStatus,
  isTerminalSessionEvent,
  MAX_CONCURRENT_TASKS,
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

describe("MAX_CONCURRENT_TASKS", () => {
  it("defaults to 4 when env var is not set", () => {
    assert.strictEqual(MAX_CONCURRENT_TASKS, 4);
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
  formatParentNotification,
  formatTaskResultSummary,
  formatTaskListSummary,
  formatTaskStatusDetail,
  truncateText,
} from "../../dist/shared/task-formatting.js";

describe("buildBackgroundPrompt", () => {
  it("adds explicit background instructions before user prompt", () => {
    const result = buildBackgroundPrompt("Return COMPLETED_OK when done.");
    assert.match(result, /You are running as a background child task\./);
    assert.match(result, /Return a final, self-contained answer\./);
    assert.match(result, /Return COMPLETED_OK when done\./);
  });
});

describe("formatParentNotification", () => {
  it("formats timeout with next-step guidance", () => {
    const message = formatParentNotification(
      { childSessionId: "ses_1", description: "Quick task", timeoutMs: 30000 },
      "timeout"
    );
    assert.match(message, /Background task did not report completion before timeout/);
    assert.match(message, /Use task_result to inspect the latest state\./);
  });

  it("formats error with recovery guidance", () => {
    const message = formatParentNotification(
      { childSessionId: "ses_1", description: "Quick task", timeoutMs: 30000 },
      "error",
      "Something failed"
    );
    assert.match(message, /Background task ended with an error\./);
    assert.match(message, /Use task_result or task_continue to inspect or recover\./);
  });

  it("formats completed_after_timeout explicitly", () => {
    const message = formatParentNotification(
      { childSessionId: "ses_1", description: "Quick task", timeoutMs: 30000 },
      "completed_after_timeout",
      "Done late"
    );
    assert.match(message, /Background task completed after an earlier timeout notification\./);
  });

  it("formats successful completion", () => {
    const message = formatParentNotification(
      { childSessionId: "ses_1", description: "Quick task", timeoutMs: 30000 },
      "completed",
      "COMPLETED_OK"
    );
    assert.match(message, /Background task completed successfully\./);
    assert.match(message, /Latest output: COMPLETED_OK/);
  });
});

describe("formatTaskResultSummary", () => {
  it("includes next action guidance for running tasks", () => {
    const result = formatTaskResultSummary({
      sessionId: "ses_123",
      status: "busy",
      messageCount: 4,
      latestText: "Still working",
      tracked: true,
      timeoutNotified: false,
    });
    assert.match(result, /Recommended next action: use task_result again later\./);
  });

  it("includes recovery guidance for error status", () => {
    const result = formatTaskResultSummary({
      sessionId: "ses_123",
      status: "error",
      messageCount: 4,
      latestText: "Failed",
      tracked: true,
      timeoutNotified: false,
    });
    assert.match(result, /Recommended next action: inspect latest output/);
  });

  it("includes tracked and timeout metadata", () => {
    const result = formatTaskResultSummary({
      sessionId: "ses_123",
      status: "idle",
      messageCount: 4,
      latestText: "Done",
      tracked: true,
      timeoutNotified: true,
    });
    assert.match(result, /Tracked background task: yes/);
    assert.match(result, /Timeout notification sent: yes/);
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
    isBackground: true,
    startedAt: 1,
    retainedAt: 2,
    timeoutNotified: false,
    completed: true,
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

  it("drops entries with unknown states or invalid ids", () => {
    const file = tmpLedgerPath();
    writeFileSync(file, JSON.stringify({
      version: 1,
      tasks: {
        ses_ok: retainedEntry(),
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

// ============================================================
// === Task 0 Step 1: Config Normalization Tests ===
// Expected: FAIL because src/shared/config.ts does not exist yet
// ============================================================

import {
  normalizeDynamicTaskConfig,
  resolveTimeoutMs,
  parseDynamicTaskJsonc,
} from "../../dist/shared/config.js";

describe("normalizeDynamicTaskConfig", () => {
  it("returns safe defaults when given empty options", () => {
    const config = normalizeDynamicTaskConfig({});
    assert.strictEqual(config.defaultTimeoutMs, 120000);
    assert.strictEqual(config.maxTimeoutMs, 3600000);
    assert.strictEqual(config.minTimeoutMs, 1000);
    assert.strictEqual(config.maxDepth, 2);
    assert.strictEqual(config.maxConcurrent, 4);
    assert.deepStrictEqual(config.blockedAgents, ["general"]);
    assert.strictEqual(config.allowSameAgentRecursion, false);
    assert.strictEqual(config.defaultAwaitResponse, false);
    assert.strictEqual(config.timeoutBehavior, "interrupt");
  });

  it("returns safe defaults when given null/undefined options", () => {
    const configNull = normalizeDynamicTaskConfig(null);
    assert.strictEqual(configNull.defaultTimeoutMs, 120000);
    const configUndef = normalizeDynamicTaskConfig(undefined);
    assert.strictEqual(configUndef.defaultTimeoutMs, 120000);
  });

  it("respects plugin tuple options overriding defaults", () => {
    const config = normalizeDynamicTaskConfig({
      defaultTimeoutMs: 60000,
      maxConcurrent: 8,
      blockedAgents: ["general", "coder"],
      timeoutBehavior: "notify",
    });
    assert.strictEqual(config.defaultTimeoutMs, 60000);
    assert.strictEqual(config.maxConcurrent, 8);
    assert.deepStrictEqual(config.blockedAgents, ["general", "coder"]);
    assert.strictEqual(config.timeoutBehavior, "notify");
  });

  it("respects env vars overriding file config", () => {
    const originalTimeout = process.env.DYNAMIC_TASK_TIMEOUT;
    process.env.DYNAMIC_TASK_TIMEOUT = "300000";
    try {
      // Pass file config as second arg (fileConfig), env should override
      const config = normalizeDynamicTaskConfig({}, {
        defaultTimeoutMs: 120000, // from "file"
      });
      assert.strictEqual(config.defaultTimeoutMs, 300000); // env wins over file
    } finally {
      if (originalTimeout !== undefined) {
        process.env.DYNAMIC_TASK_TIMEOUT = originalTimeout;
      } else {
        delete process.env.DYNAMIC_TASK_TIMEOUT;
      }
    }
  });

  it("treats empty-string env var as 'not set' — falls through to next level", () => {
    const originalTimeout = process.env.DYNAMIC_TASK_TIMEOUT;
    process.env.DYNAMIC_TASK_TIMEOUT = "";
    try {
      const config = normalizeDynamicTaskConfig({
        defaultTimeoutMs: 45000, // from "file"
      });
      // empty env string must fall through to file value, not default
      assert.strictEqual(config.defaultTimeoutMs, 45000);
    } finally {
      if (originalTimeout !== undefined) {
        process.env.DYNAMIC_TASK_TIMEOUT = originalTimeout;
      } else {
        delete process.env.DYNAMIC_TASK_TIMEOUT;
      }
    }
  });

  it("empty env forbidden agents does NOT unblock general", () => {
    const original = process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS;
    process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS = "";
    try {
      const config = normalizeDynamicTaskConfig({});
      // general must STAY blocked — empty env is treated as 'not set'
      assert.ok(config.blockedAgents.includes("general"));
    } finally {
      if (original !== undefined) {
        process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS = original;
      } else {
        delete process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS;
      }
    }
  });

  it("explicit env forbidden agents overrides blockedAgents", () => {
    const original = process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS;
    process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS = "coder,reviewer";
    try {
      const config = normalizeDynamicTaskConfig({});
      assert.deepStrictEqual(config.blockedAgents, ["coder", "reviewer"]);
    } finally {
      if (original !== undefined) {
        process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS = original;
      } else {
        delete process.env.DYNAMIC_TASK_FORBIDDEN_AGENTS;
      }
    }
  });

  it("does not read custom root-level opencode.jsonc keys", () => {
    // The function signature accepts plugin options, not opencode.jsonc root keys.
    // Custom root keys are never passed to the plugin — this is enforced at the
    // OpenCode schema level (additionalProperties: false).
    // Test that the function gracefully handles unknown config shapes.
    const config = normalizeDynamicTaskConfig({ unknownField: "should be ignored" });
    assert.strictEqual(config.defaultTimeoutMs, 120000, "Unknown fields must not corrupt defaults");
  });
});

describe("resolveTimeoutMs", () => {
  it("returns the value when within bounds", () => {
    const config = normalizeDynamicTaskConfig({});
    const resolved = resolveTimeoutMs(30000, config);
    assert.strictEqual(resolved, 30000);
  });

  it("clamps to minTimeoutMs when value is too low", () => {
    const config = normalizeDynamicTaskConfig({});
    const resolved = resolveTimeoutMs(500, config);
    assert.strictEqual(resolved, 1000); // clamped to minTimeoutMs
  });

  it("clamps to maxTimeoutMs when value is too high", () => {
    const config = normalizeDynamicTaskConfig({});
    const resolved = resolveTimeoutMs(9999999, config);
    assert.strictEqual(resolved, 3600000); // clamped to maxTimeoutMs
  });

  it("falls back to defaultTimeoutMs for invalid values", () => {
    const config = normalizeDynamicTaskConfig({ defaultTimeoutMs: 120000 });
    assert.strictEqual(resolveTimeoutMs(NaN, config), 120000, "NaN → default");
    assert.strictEqual(resolveTimeoutMs(0, config), 120000, "0 → default");
    assert.strictEqual(resolveTimeoutMs(-1, config), 120000, "-1 → default");
    assert.strictEqual(resolveTimeoutMs(Infinity, config), 120000, "Infinity → default");
    assert.strictEqual(resolveTimeoutMs(-Infinity, config), 120000, "-Infinity → default");
    assert.strictEqual(resolveTimeoutMs("30s", config), 120000, "non-numeric string → default");
    assert.strictEqual(resolveTimeoutMs(null, config), 120000, "null → default");
    assert.strictEqual(resolveTimeoutMs(undefined, config), 120000, "undefined → default");
    assert.strictEqual(resolveTimeoutMs(0.5, config), 120000, "float < 1 → default");
  });

  it("handles minTimeoutMs > maxTimeoutMs inversion gracefully", () => {
    const config = normalizeDynamicTaskConfig({
      minTimeoutMs: 5000,
      maxTimeoutMs: 1000, // inverted
    });
    // Must not NaN or throw; use min(max,min) for safe bounds
    const resolved = resolveTimeoutMs(2000, config);
    assert.ok(Number.isFinite(resolved), "Must return finite number");
    assert.ok(resolved >= 1000 && resolved <= 5000,
      `Expected ${resolved} to be within [1000, 5000]`);
  });
});

describe("parseDynamicTaskJsonc", () => {
  it("exists as an exported function", () => {
    assert.strictEqual(typeof parseDynamicTaskJsonc, "function");
  });

  it("returns null for non-existent file path", () => {
    const result = parseDynamicTaskJsonc("/nonexistent/path/config.jsonc");
    assert.strictEqual(result, null);
  });

  it("returns null for undefined/empty path", () => {
    assert.strictEqual(parseDynamicTaskJsonc(""), null);
    assert.strictEqual(parseDynamicTaskJsonc(null), null);
    assert.strictEqual(parseDynamicTaskJsonc(undefined), null);
  });
});

describe("normalizeDynamicTaskConfig — edge case parsing fields", () => {
  it("sets retainedTaskMaxEntries from plugin options", () => {
    const config = normalizeDynamicTaskConfig({ retainedTaskMaxEntries: 50 });
    assert.strictEqual(config.retainedTaskMaxEntries, 50);
  });

  it("sets allowSameAgentRecursion when boolean true", () => {
    const config = normalizeDynamicTaskConfig({ allowSameAgentRecursion: true });
    assert.strictEqual(config.allowSameAgentRecursion, true);
  });

  it("ignores non-boolean allowSameAgentRecursion", () => {
    const config = normalizeDynamicTaskConfig({ allowSameAgentRecursion: "yes" });
    assert.strictEqual(config.allowSameAgentRecursion, false);
  });

  it("accepts valid timerProvider", () => {
    const timerProvider = { setTimeout: () => 1, clearTimeout: () => {} };
    const config = normalizeDynamicTaskConfig({ timerProvider });
    assert.strictEqual(config.timerProvider, timerProvider);
  });

  it("rejects invalid timerProvider (missing clearTimeout)", () => {
    const config = normalizeDynamicTaskConfig({ timerProvider: { setTimeout: () => 1 } });
    // Should fall back to default (REAL_TIMERS or undefined)
    assert.ok(config.timerProvider, "TimerProvider should be set");
  });

  it("handles all timeoutBehavior values", () => {
    assert.strictEqual(normalizeDynamicTaskConfig({ timeoutBehavior: "notify" }).timeoutBehavior, "notify");
    assert.strictEqual(normalizeDynamicTaskConfig({ timeoutBehavior: "notify_untrack" }).timeoutBehavior, "notify_untrack");
    assert.strictEqual(normalizeDynamicTaskConfig({ timeoutBehavior: "interrupt" }).timeoutBehavior, "interrupt");
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
  resolveAwaitResponse,
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

describe("resolveAwaitResponse", () => {
  const config = normalizeDynamicTaskConfig({ defaultAwaitResponse: false });

  it("defaults to config.defaultAwaitResponse when arg is undefined", () => {
    assert.strictEqual(resolveAwaitResponse(undefined, config), false);
    assert.strictEqual(resolveAwaitResponse(null, config), false);
  });

  it("return true for explicit true", () => {
    assert.strictEqual(resolveAwaitResponse(true, config), true);
  });

  it("return false for explicit false", () => {
    assert.strictEqual(resolveAwaitResponse(false, config), false);
  });

  it("honors config.defaultAwaitResponse when set to true", () => {
    const syncConfig = normalizeDynamicTaskConfig({ defaultAwaitResponse: true });
    assert.strictEqual(resolveAwaitResponse(undefined, syncConfig), true);
  });

  it("coerces string 'true' to boolean true", () => {
    assert.strictEqual(resolveAwaitResponse("true", config), true);
    assert.strictEqual(resolveAwaitResponse("True", config), true);
    assert.strictEqual(resolveAwaitResponse("TRUE", config), true);
    assert.strictEqual(resolveAwaitResponse("  true  ", config), true);
  });

  it("coerces string 'false' to boolean false", () => {
    assert.strictEqual(resolveAwaitResponse("false", config), false);
    assert.strictEqual(resolveAwaitResponse("False", config), false);
    assert.strictEqual(resolveAwaitResponse("FALSE", config), false);
    assert.strictEqual(resolveAwaitResponse("  false  ", config), false);
  });

  it("unrecognized strings fall back to config default", () => {
    assert.strictEqual(resolveAwaitResponse("yes", config), false); // falls to default
    assert.strictEqual(resolveAwaitResponse("maybe", config), false);
  });

  it("coerces numbers: non-zero = true, 0 = false", () => {
    assert.strictEqual(resolveAwaitResponse(1, config), true);
    assert.strictEqual(resolveAwaitResponse(42, config), true);
    assert.strictEqual(resolveAwaitResponse(0, config), false);
    assert.strictEqual(resolveAwaitResponse(-1, config), true); // non-zero = true
  });
});

// ============================================================
// === Task 0 Step 5: State Tests ===
// Expected: FAIL because src/shared/task-state.ts does not exist
// ============================================================

import {
  createStateStore,
  registerActiveTask,
  transitionState,
  findTask,
  pruneRetainedTasks,
  noteTimeoutFired,
  markActiveCompleted,
  forceRetain,
  discardRetained,
  stealTimeoutHandle,
  noteLateOutcome,
  restoreRetained,
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

describe("task-state: createStateStore", () => {
  it("creates empty active and retained maps", () => {
    const store = createStateStore();
    assert.strictEqual(store.activeTasks.size, 0);
    assert.strictEqual(store.retainedTasks.size, 0);
  });
});

// Shared test-harness funnels: one way to build common fixtures.
function fillBackgroundTasks(store, config, ids) {
  for (const id of ids) {
    registerActiveTask(store, {
      childSessionId: id, parentSessionId: "parent_1",
      agentName: id, description: id, lineage: [], isBackground: true,
    }, config);
  }
}

function seedSesActive(store, config) {
  registerActiveTask(store, {
    childSessionId: "ses_active", parentSessionId: "parent_1",
    agentName: "reviewer", description: "test", lineage: [], isBackground: true,
  }, config);
}

describe("task-state: registerActiveTask", () => {
  const config = normalizeDynamicTaskConfig({ maxConcurrent: 3 });

  it("increments active count when registering", () => {
    const store = createStateStore();
    const task = registerActiveTask(store, {
      childSessionId: "ses_1",
      parentSessionId: "parent_1",
      agentName: "reviewer",
      description: "test task",
      lineage: ["explore"],
      isBackground: true,  // counts toward concurrency
    }, config);
    assert.ok(task, "Should return the task state");
    assert.strictEqual(store.activeTasks.size, 1);
  });

  it("throws ConcurrencyLimitExceededError when at limit (background tasks only)", () => {
    const store = createStateStore();
    // Fill up with 3 background tasks
    fillBackgroundTasks(store, config, ["ses_1", "ses_2", "ses_3"]);

    // 4th background task should throw
    assert.throws(() => {
      registerActiveTask(store, {
        childSessionId: "ses_4", parentSessionId: "parent_1",
        agentName: "a4", description: "t4", lineage: [], isBackground: true,
      }, config);
    }, /Concurrency|concurrency|exceeded/);
  });

  it("sync tasks (isBackground=false) do NOT count toward concurrency limit", () => {
    const store = createStateStore();
    // Fill to limit with background
    fillBackgroundTasks(store, config, ["ses_1", "ses_2", "ses_3"]);

    // Sync task should succeed even though at background limit
    const syncTask = registerActiveTask(store, {
      childSessionId: "ses_sync", parentSessionId: "parent_1",
      agentName: "sync", description: "sync task", lineage: [], isBackground: false,
    }, config);
    assert.ok(syncTask);
    assert.strictEqual(store.activeTasks.size, 4); // 3 bg + 1 sync
  });
});

describe("task-state: transitionState", () => {
  const config = normalizeDynamicTaskConfig({});
  let store;

  beforeEach(() => {
    store = createStateStore();
    seedSesActive(store, config);
  });

  it("transitions active → completed", () => {
    const result = transitionState(store, "ses_active", "completed", config);
    assert.strictEqual(result.state, "completed");
    assert.strictEqual(store.activeTasks.has("ses_active"), false);
  });

  it("transitions active → timeout_interrupting → timed_out_retained", () => {
    transitionState(store, "ses_active", "timeout_interrupting", config);
    const result = transitionState(store, "ses_active", "timed_out_retained", config);
    assert.strictEqual(result.state, "timed_out_retained");
    assert.strictEqual(store.activeTasks.has("ses_active"), false);
    assert.strictEqual(store.retainedTasks.has("ses_active"), true);
  });

  it("transitions active → error", () => {
    const result = transitionState(store, "ses_active", "error", config);
    assert.strictEqual(result.state, "error");
    assert.strictEqual(store.activeTasks.has("ses_active"), false);
  });

  it("idempotent: same transition twice throws on terminal state", () => {
    transitionState(store, "ses_active", "completed", config);
    // A second transition from completed (terminal state) must throw
    assert.throws(() => {
      transitionState(store, "ses_active", "completed", config);
    }, /terminal|invalid|transition/i);
  });

  it("rejects invalid transition (completed → active)", () => {
    transitionState(store, "ses_active", "completed", config);
    assert.throws(() => {
      transitionState(store, "ses_active", "active", config);
    }, /invalid|transition/i);
  });

  it("retained task remains visible to findTask", () => {
    transitionState(store, "ses_active", "timed_out_retained", config);
    const found = findTask(store, "ses_active");
    assert.ok(found, "Retained task must be findable");
    assert.strictEqual(found?.state, "timed_out_retained");
  });

  it("unknown session ID transition throws", () => {
    assert.throws(() => {
      transitionState(store, "nonexistent", "completed", config);
    }, /not found|unknown/i);
  });
});

describe("task-state: flag operations (funnel for Task 01 bypasses)", () => {
  const config = normalizeDynamicTaskConfig({});
  let store;

  beforeEach(() => {
    store = createStateStore();
    seedSesActive(store, config);
  });

  it("noteTimeoutFired sets flags and keeps the task active", () => {
    const task = noteTimeoutFired(store, "ses_active");
    assert.strictEqual(task.timeoutNotified, true);
    assert.strictEqual(task.completed, true);
    assert.strictEqual(store.activeTasks.has("ses_active"), true);
  });

  it("noteTimeoutFired throws for unknown session", () => {
    assert.throws(() => noteTimeoutFired(store, "ses_nope"), /not active/);
  });

  it("markActiveCompleted returns previous value and sets the flag", () => {
    assert.strictEqual(markActiveCompleted(store, "ses_active"), false);
    assert.strictEqual(markActiveCompleted(store, "ses_active"), true);
  });

  it("markActiveCompleted throws for unknown session", () => {
    assert.throws(() => markActiveCompleted(store, "ses_nope"), /not active/);
  });

  it("forceRetain moves an active task to retained with the patch", () => {
    const retained = forceRetain(store, "ses_active", {
      state: "timed_out_retained",
      timeoutNotified: true,
      completed: true,
    });
    assert.strictEqual(retained.state, "timed_out_retained");
    assert.strictEqual(store.activeTasks.has("ses_active"), false);
    assert.strictEqual(store.retainedTasks.get("ses_active").description, "test");
  });

  it("forceRetain overwrites an already-retained entry (timeout/completion race)", () => {
    transitionState(store, "ses_active", "completed", config);
    const retained = forceRetain(store, "ses_active", {
      state: "timed_out_retained",
      timeoutNotified: true,
      completed: true,
    });
    assert.strictEqual(retained.state, "timed_out_retained");
    assert.strictEqual(retained.completed, true);
  });

  it("forceRetain throws for unknown session", () => {
    assert.throws(() => forceRetain(store, "ses_nope", { state: "timed_out_retained" }), /not found/);
  });

  it("discardRetained removes retained entries and reports presence", () => {
    transitionState(store, "ses_active", "completed", config);
    assert.strictEqual(discardRetained(store, "ses_active"), true);
    assert.strictEqual(store.retainedTasks.has("ses_active"), false);
    assert.strictEqual(discardRetained(store, "ses_active"), false);
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
    const store = createStateStore();
    registerActiveTask(store, {
      childSessionId, parentSessionId: "p", agentName: "a",
      description: "d", lineage: [], isBackground: true,
    }, config);
    if (state !== "active") transitionState(store, childSessionId, state, config);
    return store;
  }

  it("admits with no dependencies", () => {
    assert.deepStrictEqual(
      resolveDependencies(createStateStore(), undefined),
      { ok: true }
    );
  });

  it("admits when deps completed (including after timeout)", () => {
    const store = storeWith("s1", "completed");
    const s2 = createStateStore();
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
    assert.deepStrictEqual(resolveDependencies(createStateStore(), ["ses_gone"]), { ok: true });
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
    const store = createStateStore();
    const task = registerAdmittedTask(store, {
      childSessionId: "ses_1", parentSessionId: "parent_1",
      agentName: "explore", description: "t1", lineage: [], isBackground: true,
    }, limited);
    assert.strictEqual(task.agentName, "explore");
    assert.throws(() => registerAdmittedTask(store, {
      childSessionId: "ses_2", parentSessionId: "parent_1",
      agentName: "explore", description: "t2", lineage: [], isBackground: true,
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

describe("prompt dance: extractTextFromPromptResult", () => {
  it("extracts text from parts shapes", () => {
    const result = { parts: [{ type: "text", text: "hello" }] };
    assert.strictEqual(extractTextFromPromptResult(result), "hello");
  });

  it("extracts text from message-content shapes", () => {
    assert.strictEqual(extractTextFromPromptResult({ content: "world" }), "world");
  });

  it("returns empty string when no text is present", () => {
    assert.strictEqual(extractTextFromPromptResult({}), "");
    assert.strictEqual(extractTextFromPromptResult(null), "");
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
  it("truncateText caps long output", () => {
    const out = truncateText("x".repeat(1300));
    assert.strictEqual(out.length, 1203);
    assert.ok(out.endsWith("..."));
    assert.strictEqual(truncateText("short"), "short");
  });

  it("formatTaskResultSummary surfaces delivery records", () => {
    const base = {
      sessionId: "s", status: "completed", messageCount: 1,
      latestText: "hi", tracked: true, timeoutNotified: false,
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
      latestText: "hi", tracked: true, timeoutNotified: false, debugShape: "SHAPE",
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

  it("allows active -> completed_after_timeout when the timeout fired first", () => {
    // The timeout-vs-completion race: noteTimeoutFired keeps the task active
    // (flags only), so a completion event landing before handleTimeout
    // retains it must transition active -> completed_after_timeout. This edge
    // was absent, the transition threw, the outer catch swallowed it, and the
    // parent never learned the real outcome.
    const store = createStateStore();
    seedSesActive(store, config);
    noteTimeoutFired(store, "ses_active");
    const retained = transitionState(store, "ses_active", "completed_after_timeout", config);
    assert.strictEqual(retained.state, "completed_after_timeout");
    assert.strictEqual(store.activeTasks.has("ses_active"), false);
    assert.strictEqual(store.retainedTasks.get("ses_active").state, "completed_after_timeout");
  });

  it("forceRetain records abort errors", () => {
    const store = createStateStore();
    seedSesActive(store, config);
    const retained = forceRetain(store, "ses_active", {
      state: "timed_out_retained",
      abortError: "boom",
    });
    assert.strictEqual(retained.abortError, "boom");
  });
});

describe("prompt dance: extractor shape coverage", () => {
  it("reads data/body/message wrapper variants", () => {
    const text = [{ type: "text", text: "v" }];
    assert.strictEqual(extractTextFromPromptResult({ data: { parts: text } }), "v");
    assert.strictEqual(extractTextFromPromptResult({ body: { message: { parts: text } } }), "v");
    assert.strictEqual(extractTextFromPromptResult({ message: { parts: text } }), "v");
    assert.strictEqual(extractTextFromPromptResult({ body: { text: "bt" } }), "bt");
    assert.strictEqual(extractTextFromPromptResult({ data: { content: "dc" } }), "dc");
  });

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

describe("task-state: stealTimeoutHandle", () => {
  const config = normalizeDynamicTaskConfig({});

  it("removes and returns the armed handle", () => {
    const store = createStateStore();
    seedSesActive(store, config);
    const task = store.activeTasks.get("ses_active");
    let cancelled = false;
    task.timeoutHandle = { cancel: () => { cancelled = true; } };
    const stolen = stealTimeoutHandle(store, "ses_active");
    assert.ok(stolen, "must return the handle");
    assert.strictEqual(task.timeoutHandle, undefined, "must detach from the task");
    stolen.cancel();
    assert.strictEqual(cancelled, true);
  });

  it("returns undefined when absent or unknown", () => {
    const store = createStateStore();
    seedSesActive(store, config);
    assert.strictEqual(stealTimeoutHandle(store, "ses_active"), undefined);
    assert.strictEqual(stealTimeoutHandle(store, "ses_nope"), undefined);
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

  function seedTimedOut(store) {
    seedSesActive(store, config);
    return forceRetain(store, "ses_active", { state: "timed_out_retained" });
  }

  it("advances timed_out_retained to completed_after_timeout", () => {
    const store = createStateStore();
    seedTimedOut(store);
    const updated = noteLateOutcome(store, "ses_active", "completed_after_timeout");
    assert.strictEqual(updated.state, "completed_after_timeout");
    assert.ok(store.retainedTasks.has("ses_active"), "stays retained");
  });

  it("advances timed_out_retained to error", () => {
    const store = createStateStore();
    seedTimedOut(store);
    assert.strictEqual(noteLateOutcome(store, "ses_active", "error").state, "error");
  });

  it("allows error observations on other terminal states", () => {
    const store = createStateStore();
    seedSesActive(store, config);
    transitionState(store, "ses_active", "completed", config);
    assert.strictEqual(noteLateOutcome(store, "ses_active", "error").state, "error");
  });

  it("rejects non-edges and unknown sessions", () => {
    const store = createStateStore();
    seedSesActive(store, config);
    transitionState(store, "ses_active", "completed", config);
    assert.throws(
      () => noteLateOutcome(store, "ses_active", "completed_after_timeout"),
      /Invalid late outcome/
    );
    assert.throws(() => noteLateOutcome(store, "ses_nope", "error"), /not retained/);
  });
});

describe("question gate: resolveQuestionSession", () => {
  const config = normalizeDynamicTaskConfig({});

  function trackedStore() {
    const store = createStateStore();
    registerActiveTask(store, {
      childSessionId: "ses_child", parentSessionId: "parent_1",
      agentName: "explore", description: "t", lineage: [], isBackground: true,
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

  it("retained rejects with timeout guidance", () => {
    const decision = decideQuestion("retained", ["yes"]);
    assert.strictEqual(decision.action, "reject");
    assert.ok(decision.reason.includes("timed out"));
  });
});

describe("task store: retained-change callback and bounds", () => {
  const config = normalizeDynamicTaskConfig({});

  function seedActive(store, id) {
    registerActiveTask(store, {
      childSessionId: id, parentSessionId: "p",
      agentName: "a", description: "d", lineage: [], isBackground: true,
    }, config);
  }

  it("notifies on retained writes, silent on active-only writes", () => {
    const store = createStateStore();
    let calls = 0;
    store.onRetainedChange = () => { calls++; };
    seedActive(store, "s1");
    assert.strictEqual(calls, 0, "active-only writes stay silent");
    transitionState(store, "s1", "completed", config);
    assert.strictEqual(calls, 1);
    noteLateOutcome(store, "s1", "error");
    assert.strictEqual(calls, 2);
    discardRetained(store, "s1");
    assert.strictEqual(calls, 3);
  });

  it("forceRetain notifies", () => {
    const store = createStateStore();
    let calls = 0;
    store.onRetainedChange = () => { calls++; };
    seedActive(store, "s1");
    forceRetain(store, "s1", { state: "timed_out_retained" });
    assert.strictEqual(calls, 1);
  });

  it("prunes internally when bounds are set", () => {
    const store = createStateStore({ retainedTaskTtlMs: 3600000, retainedTaskMaxEntries: 1 });
    seedActive(store, "s1");
    transitionState(store, "s1", "completed", config);
    seedActive(store, "s2");
    transitionState(store, "s2", "completed", config);
    assert.strictEqual(store.retainedTasks.size, 1);
    assert.ok(store.retainedTasks.has("s2"));
  });

  it("skips internal pruning without bounds (backward compatible)", () => {
    const store = createStateStore();
    seedActive(store, "s1");
    transitionState(store, "s1", "completed", config);
    seedActive(store, "s2");
    transitionState(store, "s2", "completed", config);
    assert.strictEqual(store.retainedTasks.size, 2);
  });
});

describe("task formatting: fleet views", () => {
  it("formatTaskListSummary counts and rows active plus retained", () => {
    const now = Date.now();
    const summary = formatTaskListSummary({
      active: [{
        childSessionId: "ses_a", agentName: "explore", description: "A task",
        state: "active", isBackground: true, startedAt: now - 65000,
      }],
      retained: [{
        childSessionId: "ses_r", agentName: "reviewer", description: "R task",
        state: "completed", isBackground: true, startedAt: now - 5000,
      }],
      maxConcurrent: 4,
    });
    assert.ok(summary.includes("Active background: 1/4"), `got: ${summary}`);
    assert.ok(summary.includes("ses_a") && summary.includes("ses_r"));
    assert.ok(summary.includes("65s"), `ages render. got: ${summary}`);
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
      isBackground: true,
      startedAt: 1,
      timeoutNotified: false,
      completed: false,
      requestedModel: "prov/model",
    }, null);
    assert.ok(detail.includes("ses_1"));
    assert.ok(detail.includes("planner"));
    assert.ok(detail.includes("prov/model"));
  });

  it("formatTaskStatusDetail surfaces delivery records", () => {
    const detail = formatTaskStatusDetail({
      childSessionId: "ses_1", parentSessionId: "p", agentName: "a",
      description: "d", lineage: [], state: "completed", isBackground: true,
      startedAt: 1, retainedAt: 2, timeoutNotified: true, completed: true,
    }, { kind: "timeout", delivered: false, attempts: 2 });
    assert.ok(detail.includes("FAILED"), `got: ${detail}`);
  });
});

describe("task-state: restoreRetained", () => {
  const config = normalizeDynamicTaskConfig({});

  function ledgerEntry(id, state = "completed") {
    return {
      childSessionId: id, parentSessionId: "p", agentName: "a",
      description: "d", lineage: [], state, isBackground: true,
      startedAt: 1, retainedAt: 2, timeoutNotified: false, completed: true,
    };
  }

  it("restores unknown ids and skips live state", () => {
    const store = createStateStore();
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
    assert.strictEqual(restoreRetained(createStateStore(), []), 0);
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
    assert.ok(result.includes("Cannot register"));
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
    const store = createStateStore();
    // Add a retained task with a past retainedAt
    const oldTask = {
      childSessionId: "ses_old", parentSessionId: "parent_1", agentName: "reviewer",
      description: "old", lineage: [], isBackground: true, completed: false,
      timeoutNotified: false, timeoutHandle: null, startedAt: 0,
      state: "timed_out_retained" , retainedAt: Date.now() - 100000,
    };
    store.retainedTasks.set("ses_old", oldTask );

    const pruned = pruneRetainedTasks(store, config);
    assert.strictEqual(pruned, 1, "Should prune 1 expired entry");
    assert.strictEqual(store.retainedTasks.size, 0);
  });

  it("evicts oldest entries when over max", () => {
    const store = createStateStore();
    // Add 3 retained tasks (max is 2) — all within TTL window (retainedAt near now)
    const now = Date.now();
    store.retainedTasks.set("ses_a", {
      childSessionId: "ses_a", parentSessionId: "p", agentName: "a",
      description: "a", lineage: [], isBackground: false,
      state: "timed_out_retained", retainedAt: now - 5,
    });
    store.retainedTasks.set("ses_b", {
      childSessionId: "ses_b", parentSessionId: "p", agentName: "b",
      description: "b", lineage: [], isBackground: false,
      state: "timed_out_retained", retainedAt: now - 3,
    });
    store.retainedTasks.set("ses_c", {
      childSessionId: "ses_c", parentSessionId: "p", agentName: "c",
      description: "c", lineage: [], isBackground: false,
      state: "timed_out_retained", retainedAt: now,
    });

    const pruned = pruneRetainedTasks(store, config);
    assert.strictEqual(pruned, 1, "Should evict 1 oldest entry");
    assert.strictEqual(store.retainedTasks.size, 2);
    // Oldest (ses_a) should be gone
    assert.ok(!store.retainedTasks.has("ses_a"));
  });

  it("prunes nothing when under limits", () => {
    const store = createStateStore();
    const now = Date.now();
    store.retainedTasks.set("ses_1", {
      childSessionId: "ses_1", parentSessionId: "p", agentName: "a",
      description: "1", lineage: [], isBackground: false,
      state: "timed_out_retained", retainedAt: now,
    } );

    const pruned = pruneRetainedTasks(store, config);
    assert.strictEqual(pruned, 0);
    assert.strictEqual(store.retainedTasks.size, 1);
  });
});

describe("findTask — edge cases", () => {
  it("returns null for unknown session ID", () => {
    const store = createStateStore();
    const result = findTask(store, "nonexistent");
    assert.strictEqual(result, null);
  });

  it("finds active task before retained task", () => {
    const store = createStateStore();
    registerActiveTask(store, {
      childSessionId: "ses_dup", parentSessionId: "p",
      agentName: "a", description: "t", lineage: [], isBackground: true,
    }, normalizeDynamicTaskConfig({}));
    // Add same key to retained (should not happen in practice but test priority)
    store.retainedTasks.set("ses_dup", {
      childSessionId: "ses_dup", parentSessionId: "p", agentName: "a",
      description: "t", lineage: [], isBackground: false,
      state: "timed_out_retained", retainedAt: Date.now(),
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

