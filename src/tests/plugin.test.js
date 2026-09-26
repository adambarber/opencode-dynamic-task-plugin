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
  describeModelShapeError,
  isTransientOutcomeError,
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

  it("ignores the legacy ambient test var — callers resolve explicitly", async () => {
    await withEnv("DYNAMIC_TASK_TEST_SESSION_ID", "ses_phantom", async () => {
      assert.strictEqual(resolveParentSessionId({}), null);
    });
  });
});

describe("fetchAgents", () => {
  beforeEach(() => {
    resetAgentCache();
  });

  /**
   * A client whose app.agents() answers `respond` — a list, a wrapped host
   * response ({data}/{agents}), or a function of the call number, which is how
   * a test scripts a failure-then-success without a hand-kept counter that can
   * drift from the assertion that reads it. `client.agentCalls` is the count
   * those assertions actually want.
   */
  function clientWith(respond, log = async () => {}) {
    const client = {
      agentCalls: 0,
      app: {
        agents: async () => {
          client.agentCalls++;
          return typeof respond === "function" ? respond(client.agentCalls) : respond;
        },
        log,
      },
    };
    return client;
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
    const mockClient = clientWith(() => {
      throw new Error("Network error");
    });

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
    const mockClient = clientWith((calls) => {
      if (calls === 1) throw new Error("blip");
      return [{ name: "explore", mode: "subagent" }];
    });

    const result = await fetchAgents(mockClient);
    assert.strictEqual(mockClient.agentCalls, 2, "one immediate retry");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "explore");
  });

  // One hypothesis: whichever envelope the host wraps the list in, exactly the
  // dispatchable agents come back — the server answers all three shapes.
  const envelopes = [
    ["handles wrapped response (result.data)", "data", "general"],
    ["handles wrapped response (result.agents)", "agents", "review"],
  ];
  for (const [name, key, kept] of envelopes) {
    it(name, async () => {
      const mockClient = clientWith({ [key]: [
        { name: kept, mode: "subagent" },
        { name: "excluded", mode: "primary" },
      ] });

      const result = await fetchAgents(mockClient);
      assert.strictEqual(result.length, 1, "primary agents are not dispatchable");
      assert.strictEqual(result[0].name, kept);
    });
  }

  // The cache is process-global state; scoping it per client means one
  // plugin instance (or the host's entry-export probes) can never serve
  // another client's agent list.
  it("caches per client: two clients keep distinct agent lists", async () => {
    const clientA = clientWith([{ name: "alpha", mode: "subagent" }]);
    const clientB = clientWith([{ name: "beta", mode: "subagent" }]);

    // These reads are a TIMELINE, not three assertions: A, then B, then A again.
    // Declared as data so the order is the spec — the third read is the whole
    // point, since only a per-client cache can answer it without refetching.
    const timeline = [
      [clientA, ["alpha"]],
      [clientB, ["beta"]],
      [clientA, ["alpha"]],
    ];
    for (const [client, expected] of timeline) {
      assert.deepStrictEqual((await fetchAgents(client)).map((a) => a.name), expected);
    }
    assert.strictEqual(clientA.agentCalls, 1, "client A's second read is served from its own cache");
    assert.strictEqual(clientB.agentCalls, 1, "client B's fetch never touched client A's cache");
  });

  it("stale entries refetch — TTL still bounds each client's cache", async () => {
    const mockClient = clientWith((calls) =>
      calls === 1
        ? [{ name: "first", mode: "subagent" }]
        : [{ name: "second", mode: "subagent" }]);

    assert.strictEqual((await fetchAgents(mockClient, 60000))[0].name, "first");
    assert.strictEqual((await fetchAgents(mockClient, 0))[0].name, "second", "expired TTL forces a fresh fetch");
    assert.strictEqual(mockClient.agentCalls, 2);
  });

  it("resetAgentCache invalidates every client's cache", async () => {
    const mockClient = clientWith([{ name: "explore", mode: "subagent" }]);
    await fetchAgents(mockClient, 60000);
    resetAgentCache();
    await fetchAgents(mockClient, 60000);
    assert.strictEqual(mockClient.agentCalls, 2, "reset must not leave any client's entry fresh");
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

describe("isTransientOutcomeError", () => {
  it("marks provider and network blips transient", () => {
    assert.strictEqual(isTransientOutcomeError("429 rate limit exceeded, retry shortly"), true);
    assert.strictEqual(isTransientOutcomeError("Upstream overloaded, please try again"), true);
    assert.strictEqual(isTransientOutcomeError("fetch failed: socket hang up"), true);
    assert.strictEqual(isTransientOutcomeError("Request timeout after 120s"), true);
  });

  it("treats auth, permission, and empty details as fatal-or-unknown", () => {
    assert.strictEqual(isTransientOutcomeError("permission denied for model"), false);
    assert.strictEqual(isTransientOutcomeError("authentication required"), false);
    assert.strictEqual(isTransientOutcomeError(""), false);
    assert.strictEqual(isTransientOutcomeError(undefined), false);
  });
});

describe("maxConcurrent default", () => {
  // One hypothesis: an absent or unusable env value yields the default. `undefined`
  // is the "not set" case, which withEnv understands as unset.
  const unusable = [
    ["defaults to 4 when env is not set", undefined],
    ["ignores non-numeric env maxConcurrent", "bogus"],
  ];
  for (const [name, value] of unusable) {
    it(name, async () => {
      await withEnv("DYNAMIC_TASK_MAX_CONCURRENT", value, async () => {
        assert.strictEqual(normalizeDynamicTaskConfig({}).maxConcurrent, 4);
      });
    });
  }
});

describe("isTerminalSessionEvent", () => {
  // One hypothesis, one arrangement: which event SHAPES end a turn. Each case
  // keeps its own name because the shape is what a reader needs to see.
  const shapes = [
    ["treats sync session.updated idle as terminal", {
      type: "sync",
      name: "session.updated.1",
      data: { info: { status: "idle" } },
    }, true],
    ["treats sync session.updated error as terminal", {
      type: "sync",
      name: "session.updated.1",
      data: { info: { status: { type: "error" } } },
    }, true],
    ["treats sync session.deleted.1 as terminal", {
      type: "sync",
      name: "session.deleted.1",
    }, true],
    ["treats session.idle event as terminal", { type: "session.idle" }, true],
    ["treats session.error event as terminal", { type: "session.error" }, true],
    ["does not treat session.status with unknown status as terminal", { type: "session.status", properties: { status: "running" } }, false],
  ];
  for (const [name, event, expected] of shapes) {
    it(name, () => {
      assert.strictEqual(isTerminalSessionEvent(event), expected);
    });
  }
});

// --- Shared Task Formatting Helpers (Task 2) ---
import {
  buildBackgroundPrompt,
  formatTaskResultSummary,
  formatTaskListSummary,
  formatTaskStatusDetail,
} from "../../dist/shared/task-formatting.js";
import { hostTurnRunning, statusFromHostState } from "../../dist/shared/liveness.js";
import { hostPayload } from "../../dist/shared/session-lifecycle.js";
import { formatParentNotification, truncateText, noticeDedupKey } from "../../dist/shared/notify.js";
import { TASK_CONTINUE_DESCRIPTION } from "../../dist/shared/voice.js";

describe("operator voice: continue description", () => {
  it("warns that mid-steer settles and stalls are possible", () => {
    assert.match(TASK_CONTINUE_DESCRIPTION, /mid-steer/);
    assert.match(TASK_CONTINUE_DESCRIPTION, /stalled/);
  });
});

describe("describeModelShapeError", () => {
  it("rejects bare ids with the qualified form", () => {
    assert.match(describeModelShapeError("GLM-5.3-Flash"), /providerID\/modelID/);
    assert.match(describeModelShapeError("GLM-5.3-Flash"), /GLM-5\.3-Flash/);
  });

  it("accepts qualified, absent, and blank inputs", () => {
    assert.strictEqual(describeModelShapeError("nvidia/z-ai/glm-5.3"), null);
    assert.strictEqual(describeModelShapeError(undefined), null);
    assert.strictEqual(describeModelShapeError("   "), null);
  });
});

describe("buildBackgroundPrompt", () => {
  it("adds explicit background instructions before user prompt", () => {
    const result = buildBackgroundPrompt("Return COMPLETED_OK when done.");
    assert.match(result, /You are running as a background child task\./);
    assert.match(result, /Return a final, self-contained answer\./);
    assert.match(result, /preempts your current turn/);
    assert.match(result, /never wait/);
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

  it("formats a child notice under its own tag with the reply path", () => {
    const noticeMessage = formatParentNotification(state, "notice", "blocked on credentials");
    assert.match(noticeMessage, /dynamic-task-notice/);
    assert.match(noticeMessage, /Message from a running child task:/);
    assert.match(noticeMessage, /blocked on credentials/);
    assert.match(noticeMessage, /task_continue/);
  });

  it("keeps settlements under the settlement tag", () => {
    assert.match(formatParentNotification(state, "completed", "ok"), /dynamic-task-notify/);
    assert.match(formatParentNotification(state, "error", "bad"), /dynamic-task-notify/);
    assert.ok(!formatParentNotification(state, "notice", "x").includes("[dynamic-task-notify]"));
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

// The record the view formatters read. Defaults are the boring truth (one
// completed, tracked turn with a short latest output); a test states only the
// field it is actually about.
function resultRecord(overrides = {}) {
  return { sessionId: "s", status: "completed", messageCount: 1, latestText: "hi", tracked: true, ...overrides };
}

// The persistence signal a retained mutation must emit. Wiring the counter to
// the store here means no test hand-rolls the callback and then has to read the
// same counter it wrote.
function countRetainedChanges(store) {
  const counter = { calls: 0 };
  store.onRetainedChange = () => { counter.calls++; };
  return counter;
}

// The active-task record the fleet views read. Every field the renders read is
// present, because a fixture that omits a required one renders as NaN and the
// test then asserts on nonsense.
function taskRecord(overrides = {}) {
  return {
    childSessionId: "ses_1", parentSessionId: "p", agentName: "a", description: "d",
    lineage: [], state: "active", startedAt: Date.now(), retainedAt: Date.now(),
    ...overrides,
  };
}

// The server's own status vocabulary, as the read tools speak it. The words are
// the host's, never ours: a status the server did not state cannot be rendered
// as one, so this mapping is the whole of what an untracked session can say.
// The channel's value is a SessionStatus — busy | retry | idle — and the last
// row is a word it cannot send, which must read as unknown rather than be
// coerced into an outcome.
describe("liveness vocabulary", () => {
  const cases = [
    ["busy", "busy", true],
    ["retry", "busy", true],
    ["idle", "completed", false],
    ["error", "unknown", false],
    [null, "unknown", false],
  ];
  for (const [host, expected, running] of cases) {
    it(`reads the server's "${host}" as ${expected}`, () => {
      assert.strictEqual(statusFromHostState(host), expected);
      assert.strictEqual(hostTurnRunning({ hostState: host, lastMessageAt: null }), running);
    });
  }
});

// The envelope every host read is routed through. The wrapped case is the one
// production takes (the SDK client resolves to { data, request, response }) and
// the one a reader cannot detect on its own: looking a field up at the top
// level finds nothing rather than throwing.
describe("hostPayload", () => {
  it("unwraps the transport envelope", () => {
    const map = { ses_1: { type: "busy" } };
    assert.deepStrictEqual(hostPayload({ data: map, request: {}, response: {} }), map);
  });
  it("passes a bare payload through", () => {
    const map = { ses_1: { type: "busy" } };
    assert.strictEqual(hostPayload(map), map);
  });
  it("leaves a non-record alone", () => {
    assert.deepStrictEqual(hostPayload([1, 2]), [1, 2]);
    assert.strictEqual(hostPayload(undefined), undefined);
  });
});

describe("formatTaskResultSummary", () => {
  it("includes next action guidance for running tasks", () => {
    const result = formatTaskResultSummary({
      sessionId: "ses_123", status: "busy", messageCount: 4,
      latestText: "Still working", tracked: true,
    });
    assert.match(result, /Recommended next action: use task_status for settleability/);
    assert.match(result, /Tracked: yes/);
  });

  it("renders the store state for active tasks with the sourced liveness beside it", () => {
    const result = formatTaskResultSummary({
      sessionId: "ses_123", status: "active", messageCount: 4,
      latestText: "Still working", tracked: true, task: taskRecord(),
      liveness: { hostState: "busy", lastMessageAt: Date.now() - 1000 },
    });
    assert.match(result, /Status: active/);
    assert.match(result, /Server status: busy/);
    assert.match(result, /Last child message: 1s ago/);
    assert.match(result, /Last plugin event: 0s ago/);
    // A working child carries no warning: silence is a claim the sources do not
    // support, and a store that says active is the authority on settleability.
    assert.ok(!result.includes("Warning"), `no warning while the server says busy. got: ${result}`);
  });

  it("never infers a status the sources did not state", () => {
    const result = formatTaskResultSummary({
      sessionId: "ses_123", status: "completed", messageCount: 4,
      latestText: "Done", tracked: true, task: taskRecord({ state: "completed" }),
      liveness: { hostState: null, lastMessageAt: null },
    });
    assert.match(result, /Status: completed/);
    assert.ok(!result.includes("suggests"), `a guess must never render. got: ${result}`);
    // A settled record with a quiet server has no liveness question left, so
    // the block is absent rather than reporting the absence as a reading.
    assert.ok(!result.includes("Server status"), `no question, no block. got: ${result}`);
  });

  it("renders read failures in the same voice with the error as data", () => {
    const result = formatTaskResultSummary({
      sessionId: "ses_gone", status: "error", messageCount: 0,
      latestText: "(See error above)", tracked: false, error: "boom (not retryable)",
    });
    assert.match(result, /^## Task Result/);
    assert.match(result, /Status: error/);
    assert.match(result, /Error: boom \(not retryable\)/);
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

  it("reads the blocklist at call time and honors every entry", async () => {
    await withEnv("DYNAMIC_TASK_DEBUG_BLOCKLIST", "alpha,beta,gamma,delta,epsilon", async () => {
      assert.ok(!("alpha" in safeDebugPayload({ alpha: "x" })));
      assert.ok(!("epsilon" in safeDebugPayload({ epsilon: "x", ok: 1 })), "the fifth entry must also block");
    });
  });

  it("rejects array payloads instead of indexing them", () => {
    assert.deepStrictEqual(safeDebugPayload(["a", "b"]), {});
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

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

// A scratch file in the OS temp dir, cleaned up including the `.tmp` sidecar.
// Named for intent at the call site: inLedgerFile for the ledger's own
// on-disk shape, inTempFile for a fixture the parser reads.
const inLedgerFile = (fn) => withTempFile(tmpLedgerPath(), fn);
// inLedgerFile, with one record already saved. Durability is checked in two
// places — what comes back out, and what is left on disk — and both start here.
const withSavedLedger = (fn) =>
  inLedgerFile((file) => {
    saveTaskLedger(new Map([["ses_1", retainedEntry()]]), file);
    return fn(file);
  });
const inTempFile = (fn) => withTempFile(tmpFilePath("dt-cfg"), fn);

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
  // Every case here owns a temp ledger for the duration of one assertion. The
  // old hand-rolled cleanup unlinked the file but not the ledger dance's `.tmp`
  // sidecar in the two sites that mattered, and the missing-file site skipped
  // cleanup entirely — withTempFile owns the whole lifetime.
  it("round-trips retained records through an injectable path", () =>
    withSavedLedger(async (file) => {
      const loaded = loadTaskLedger(file);
      assert.strictEqual(loaded.size, 1);
      assert.strictEqual(loaded.get("ses_1").agentName, "explore");
      assert.strictEqual(loaded.get("ses_1").state, "completed");
      assert.strictEqual(loaded.get("ses_1").timeoutNotified, undefined, "the reader strips transient fields");
    }));

  it("returns empty for missing, corrupt, and unknown-version files", async () => {
    assert.strictEqual(loadTaskLedger(`${tmpdir()}/dt-nope-${Date.now()}.json`).size, 0);
    await withTempFile(tmpLedgerPath(), async (bad) => {
      writeFileSync(bad, "{ nope");
      assert.strictEqual(loadTaskLedger(bad).size, 0);
    });
    await withTempFile(tmpLedgerPath(), async (future) => {
      writeFileSync(future, JSON.stringify({ version: 999, tasks: {} }));
      assert.strictEqual(loadTaskLedger(future).size, 0);
    });
  });

  it("save writes atomically via rename — no .tmp residue", () =>
    withSavedLedger(async (file) => {
      assert.strictEqual(existsSync(`${file}.tmp`), false, "tmp must be renamed away, not left behind");
      assert.strictEqual(loadTaskLedger(file).size, 1, "renamed content intact");
    }));

  // One hypothesis: an entry survives only if it is well-formed AND agrees with
  // its map key. A divergent or malformed entry is corrupt, not relabeled, so
  // each case declares the tasks it writes and exactly which keys must return.
  const survived = [
    ["rejects entries disagreeing with their map key",
      { ses_a: { ...retainedEntry(), childSessionId: "ses_b" } }, []],
    ["drops entries with unknown states or invalid ids", {
      ses_ok: { ...retainedEntry(), childSessionId: "ses_ok" },
      ses_bad: { ...retainedEntry(), childSessionId: "ses_bad", state: "flying" },
      ses_noid: { ...retainedEntry(), childSessionId: 42 },
    }, ["ses_ok"]],
  ];
  for (const [name, tasks, keepers] of survived) {
    it(name, async () => {
      await inLedgerFile(async (file) => {
        writeFileSync(file, JSON.stringify({ version: 2, tasks }));
        assert.deepStrictEqual([...loadTaskLedger(file).keys()], keepers);
      });
    });
  }

  it("rejects non-finite timestamps and mixed lineage wholesale", async () => {
    await inLedgerFile(async (file) => {
      const nanEntry = { ...retainedEntry(), startedAt: NaN };
      const mixedLineage = { ...retainedEntry(), childSessionId: "ses_mix", lineage: ["x", 42] };
      saveTaskLedger(new Map([["ses_nan", nanEntry], ["ses_mix", mixedLineage]]), file);
      const loaded = loadTaskLedger(file);
      assert.strictEqual(loaded.has("ses_nan"), false, "NaN does not survive the durability boundary");
      assert.strictEqual(loaded.has("ses_mix"), false, "mixed lineage is rejected, not silently shortened");
    });
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
    assert.deepStrictEqual(config.blockedAgents, []);
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

  it("lets env override tuple options", async () => {
    await withEnv("DYNAMIC_TASK_MAX_CONCURRENT", "7", async () => {
      assert.strictEqual(normalizeDynamicTaskConfig({ maxConcurrent: 2 }).maxConcurrent, 7);
    });
  });

  it("treats empty-string env var as 'not set' and falls through to the next level", async () => {
    await withEnv("DYNAMIC_TASK_MAX_CONCURRENT", "", async () => {
      assert.strictEqual(normalizeDynamicTaskConfig({ maxConcurrent: 5 }).maxConcurrent, 5);
    });
  });

  it("empty-string env var falls through to the default blocklist", async () => {
    await withEnv("DYNAMIC_TASK_FORBIDDEN_AGENTS", "", async () => {
      const config = normalizeDynamicTaskConfig({});
      assert.deepStrictEqual(config.blockedAgents, []);
    });
  });

  it("explicit env forbidden agents overrides blockedAgents", async () => {
    await withEnv("DYNAMIC_TASK_FORBIDDEN_AGENTS", "coder,reviewer", async () => {
      const config = normalizeDynamicTaskConfig({});
      assert.deepStrictEqual(config.blockedAgents, ["coder", "reviewer"]);
    });
  });

  it("a comma-only forbidden-agents env does not clear the blocklist", async () => {
    for (const junk of [",", " , ", ",,"]) {
      await withEnv("DYNAMIC_TASK_FORBIDDEN_AGENTS", junk, async () => {
        assert.deepStrictEqual(normalizeDynamicTaskConfig({}).blockedAgents, [], `env=${JSON.stringify(junk)}`);
      });
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

  it("returns null for empty or non-object payloads", async () => {
    assert.strictEqual(parseDynamicTaskJsonc(""), null);
    await inTempFile(async (file) => {
      writeFileSync(file, "[1, 2]");
      assert.strictEqual(parseDynamicTaskJsonc(file), null);
    });
  });

  it("strips comments and parses objects", async () => {
    await withTempFile(`${tmpdir()}/dt-ok-${Date.now()}.jsonc`, async (file) => {
      writeFileSync(file, '{ /* block */ "maxDepth": 3 } // trailing\n');
      assert.deepStrictEqual(parseDynamicTaskJsonc(file), { maxDepth: 3 });
    });
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
  const config = normalizeDynamicTaskConfig({ blockedAgents: ["general"] });

  it("rejects a configured blocked agent", () => {
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
  noteActivity,
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
  normalizeQuestionAnswers,
  resolveQuestionSession,
  decideQuestion,
  rememberQuestionSession,
  forgetQuestionSession,
  resetQuestionSessions,
} from "../../dist/shared/question-handling.js";
import { tmpdir } from "node:os";
import { checkConcurrencyLimit } from "../../dist/shared/config.js";
import { tmpFilePath, withEnv, withTempFile } from './support/harness.js';

describe("task-state: createTaskStore", () => {
  it("creates empty active and retained maps", () => {
    const store = createTaskStore();
    assert.strictEqual(store.activeTasks.size, 0);
    assert.strictEqual(store.retainedTasks.size, 0);
  });
});

// Shared test-harness funnels: one way to build common fixtures.
// The registration literal — the input every task-state test builds — has five
// fields and only the child id usually matters. This names the shape once, so
// a test states its intent ("a second agent") instead of a field list whose
// defaults could drift from the production param type.
function childParams({ id, parent = "parent_1", agent = "explore", description = "test", lineage = [] } = {}) {
  return { childSessionId: id, parentSessionId: parent, agentName: agent, description, lineage };
}

function fillBackgroundTasks(store, config, ids) {  for (const id of ids) {
    registerActiveTask(store, childParams({ id, agent: id, description: id }), config);
  }
}

function seedSesActive(store, config) {
  registerActiveTask(store, childParams({ id: "ses_active", agent: "reviewer" }), config);
}

describe("task-state: registerActiveTask", () => {
  const config = normalizeDynamicTaskConfig({ maxConcurrent: 3 });

  it("registers an active record for the session", () => {
    const store = createTaskStore();
    const task = registerActiveTask(store, childParams({ id: "ses_1", agent: "reviewer", description: "test task", lineage: ["explore"] }), config);
    assert.strictEqual(task.state, "active");
    assert.strictEqual(store.activeTasks.size, 1);
  });

  it("throws ConcurrencyLimitExceeded when at the limit", () => {
    const store = storeAtLimit(config);
    assert.throws(() => {
      registerActiveTask(store, childParams({ id: "ses_4", agent: "a4" }), config);
    }, /Concurrency/);
  });

  it("settlement frees the slot for the next registration", () => {
    const store = storeAtLimit(config);
    transitionState(store, "ses_1", "completed");
    const task = registerActiveTask(store, childParams({ id: "ses_4", agent: "a4" }), config);
    assert.strictEqual(task.state, "active");
  });
});

/** A store already holding the configured maximum of active children. */
function storeAtLimit(cfg) {
  const store = createTaskStore();
  fillBackgroundTasks(store, cfg, ["ses_1", "ses_2", "ses_3"]);
  return store;
}

/**
 * A store whose one task has already been retained in the given state. The
 * settled-record invariant is guarded from two entry points — transitionState
 * and noteLateOutcome — so the arrangement needs a name, not a state.
 */
function storeSettledAs(state, cfg) {
  const store = createTaskStore();
  seedSesActive(store, cfg);
  transitionState(store, "ses_active", state);
  return store;
}

/** formatTaskResultSummary over a settled record carrying this notification. */
function summaryWith(notification) {
  return formatTaskResultSummary({ ...resultRecord(), notification });
}

describe("task-state: transitionState", () => {
  const config = normalizeDynamicTaskConfig({});
  let store;

  beforeEach(() => {
    store = createTaskStore();
    seedSesActive(store, config);
  });

  it("settles active → completed into retention", () => {
    const result = transitionState(store, "ses_active", "completed");
    assert.strictEqual(result.state, "completed");
    assert.strictEqual(result.completed, true);
    assert.strictEqual(store.activeTasks.has("ses_active"), false);
    assert.strictEqual(store.retainedTasks.has("ses_active"), true);
  });

  it("transitions active → error and active → interrupted", () => {
    assert.strictEqual(transitionState(store, "ses_active", "error").state, "error");
    const store2 = createTaskStore();
    seedSesActive(store2, config);
    assert.strictEqual(transitionState(store2, "ses_active", "interrupted").state, "interrupted");
  });

  it("settle is exactly-once: a second settlement throws and cannot regress retention", () => {
    transitionState(store, "ses_active", "completed");
    assert.throws(() => transitionState(store, "ses_active", "error"), /terminal|invalid|not found/i);
    assert.strictEqual(store.retainedTasks.get("ses_active").state, "completed");
  });

  it("settlement strips advisory activity metadata — the ledger carries no heartbeat", () => {
    noteActivity(store, "ses_active");
    assert.ok(store.activeTasks.get("ses_active").lastActivityAt, "the event funnel stamps the active record");
    transitionState(store, "ses_active", "completed");
    assert.ok(!("lastActivityAt" in store.retainedTasks.get("ses_active")));
  });

  it("settlement strips advisory notice metadata", () => {
    annotateNotice(store, "ses_active", "interim");
    transitionState(store, "ses_active", "completed");
    assert.ok(!("lastNotice" in store.retainedTasks.get("ses_active")));
  });

  it("retained task remains visible to findTask", () => {
    transitionState(store, "ses_active", "completed");
    const found = findTask(store, "ses_active");
    assert.ok(found, "Retained task must be findable");
    assert.strictEqual(found?.state, "completed");
  });

  it("unknown session ID transition throws", () => {
    assert.throws(() => transitionState(store, "nonexistent", "completed"), /not found|invalid|not active/i);
  });
});

describe("task-state: revival and annotations", () => {
  const config = normalizeDynamicTaskConfig({});

  function retained(store, state = "completed") {
    seedSesActive(store, config);
    transitionState(store, "ses_active", state);
  }

  // The subject of every withdrawInterruptClaim test: one task holding a
  // speculative interrupt claim in the retained ledger, with the persistence
  // signal already wired. Naming the arrangement is what lets each test state
  // only the rule it is about.
  function interruptClaim(cfg = config) {
    const store = createTaskStore();
    const changes = countRetainedChanges(store);
    seedSesActive(store, cfg);
    transitionState(store, "ses_active", "interrupted", cfg);
    return { store, changes };
  }

  it("withdrawInterruptClaim persists the ledger via emitRetainedChange", () => {
    const { store, changes } = interruptClaim();
    const before = changes.calls;
    withdrawInterruptClaim(store, "ses_active", Date.now(), config);
    assert.strictEqual(changes.calls, before + 1, "withdraw is a retained mutation and must persist");
    assert.strictEqual(store.activeTasks.get("ses_active")?.state, "active");
  });

  it("withdrawInterruptClaim refuses when full or superseded", () => {
    const limited = normalizeDynamicTaskConfig({ maxConcurrent: 1 });
    const { store } = interruptClaim(limited);
    fillBackgroundTasks(store, limited, ["ses_other"]);
    assert.strictEqual(
      withdrawInterruptClaim(store, "ses_active", Date.now(), limited), false,
      "no slot accounting bypass past maxConcurrent",
    );
    assert.ok(store.retainedTasks.has("ses_active"), "stays retained when full");

    const { store: store2 } = interruptClaim();
    store2.retainedTasks.get("ses_active").lastAbortAt = Date.now();
    assert.strictEqual(
      withdrawInterruptClaim(store2, "ses_active", 0, config), false,
      "a newer abort landing supersedes the stale claim",
    );
  });

  it("withdrawInterruptClaim refuses when the abort landed in the same millisecond", () => {
    // Same-ms success is still knowledge: a withdraw stamped at the instant of
    // a successful abort must lose to it (>=, not >).
    const { store } = interruptClaim();
    const sameInstant = Date.now();
    store.retainedTasks.get("ses_active").lastAbortAt = sameInstant;
    assert.strictEqual(
      withdrawInterruptClaim(store, "ses_active", sameInstant, config), false,
      "a same-millisecond successful abort supersedes the withdraw",
    );
    assert.ok(store.retainedTasks.has("ses_active"), "refused withdraw leaves the record retained");
  });

  it("withdrawInterruptClaim returns a fresh speculative claim to active", () => {
    const store = createTaskStore();
    assert.strictEqual(withdrawInterruptClaim(store, "ses_nope"), false);
    seedSesActive(store, config);
    transitionState(store, "ses_active", "completed");
    assert.strictEqual(withdrawInterruptClaim(store, "ses_active"), false, "only interrupted claims withdraw");
    const store2 = createTaskStore();
    seedSesActive(store2, config);
    transitionState(store2, "ses_active", "interrupted");
    assert.strictEqual(withdrawInterruptClaim(store2, "ses_active", Date.now(), config), true);
    assert.strictEqual(store2.activeTasks.get("ses_active")?.state, "active");
    assert.strictEqual(store2.retainedTasks.has("ses_active"), false);
    assert.strictEqual(withdrawInterruptClaim(store2, "ses_active", Date.now(), config), false, "second withdrawal refuses");
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
    registerActiveTask(store, childParams({ id: "ses_other", agent: "a2" }), limited);
    assert.throws(() => reviveRetainedTask(store, "ses_active", limited), /Concurrency/);
    assert.strictEqual(store.retainedTasks.get("ses_active").state, "completed", "rejected revival leaves the record untouched");
  });

  it("annotateNotice records the latest child message on active tasks only", () => {
    const store = createTaskStore();
    seedSesActive(store, config);
    assert.strictEqual(annotateNotice(store, "ses_active", "blocked on credentials"), true);
    assert.strictEqual(store.activeTasks.get("ses_active").lastNotice.message, "blocked on credentials");
    assert.strictEqual(annotateNotice(store, "ses_nope", "x"), false);
    transitionState(store, "ses_active", "completed");
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
    registerActiveTask(store, childParams({ id: "ses_run" }), config);
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
    const blockedConfig = normalizeDynamicTaskConfig({ blockedAgents: ["general"] });
    const result = resolveAdmission([{ name: "general" }], "general", [], blockedConfig);
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
    if (state !== "active") transitionState(store, childSessionId, state);
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

  it("refuses with the blocking set and names each dep state", () => {
    const active = storeWith("s1", "active");
    assert.deepStrictEqual(resolveDependencies(active, ["s1"]), { ok: false, pending: [{ id: "s1", state: "active" }] });
    const failed = storeWith("s2", "error");
    assert.deepStrictEqual(resolveDependencies(failed, ["s2"]), { ok: false, pending: [{ id: "s2", state: "error" }] });
  });

  it("settled-waits admit failed and interrupted deps but still block actives", () => {
    const failed = storeWith("s2", "error");
    assert.deepStrictEqual(resolveDependencies(failed, undefined, ["s2"]), { ok: true });
    const halted = storeWith("s3", "interrupted");
    assert.deepStrictEqual(resolveDependencies(halted, undefined, ["s3"]), { ok: true });
    const active = storeWith("s1", "active");
    assert.deepStrictEqual(resolveDependencies(active, undefined, ["s1"]), { ok: false, pending: [{ id: "s1", state: "active" }] });
  });

  it("strict wins when an id sits in both lists", () => {
    const failed = storeWith("s2", "error");
    assert.deepStrictEqual(
      resolveDependencies(failed, ["s2"], ["s2"]),
      { ok: false, pending: [{ id: "s2", state: "error" }] },
    );
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

  // One hypothesis: what replyToQuestion's outcome IS, given how the transport
  // behaved. Only the "already resolved" throw is absorbed — any other failure
  // is the caller's problem to see, with its message intact.
  const outcomes = [
    ["reply succeeds", { reply: async () => {} }, { succeeded: true }],
    ["reply absorbs already-resolved as success",
      { reply: async () => { throw new Error("already resolved"); } },
      { succeeded: true, reason: "already_resolved" }],
    ["reply reports transport failures",
      { reply: async () => { throw new Error("nope"); } },
      { succeeded: false, reason: "nope" }],
  ];
  for (const [name, transport, expected] of outcomes) {
    it(name, async () => {
      assert.deepStrictEqual(
        await replyToQuestion(questionClient({ ...transport, reject: async () => {} }), "q1", "yes"),
        expected,
      );
    });
  }

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

  it("normalizeQuestionAnswers flattens answer shapes", () => {
    assert.deepStrictEqual(
      normalizeQuestionAnswers(["a", { text: "b" }, { value: "c" }, "", null]),
      ["a", "b", "c"]
    );
    assert.deepStrictEqual(normalizeQuestionAnswers("nope"), []);
    assert.deepStrictEqual(normalizeQuestionAnswers(undefined), []);
  });
});

describe("task formatting: truncate + delivery records", () => {
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
    const result = formatTaskResultSummary(resultRecord({ latestText: body }));
    assert.ok(result.includes(body), "operator-pulled output must be complete");
  });

  it("formatTaskResultSummary surfaces delivery records", () => {
    const base = resultRecord();
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

  it("formatTaskResultSummary renders a suppressed duplicate as Suppressed, never FAILED", () => {
    const out = summaryWith({ kind: "notice", parentSessionId: "p1", delivered: false, attempts: 0, suppressed: true });
    assert.ok(out.includes("Suppressed (duplicate — already delivered)"), `got: ${out}`);
    assert.ok(!out.includes("FAILED"), `suppression is not failure. got: ${out}`);
  });

  it("formatTaskResultSummary renders a parentless non-delivery honestly", () => {
    const out = summaryWith({ kind: "completed", parentSessionId: "unknown", delivered: false, attempts: 0 });
    assert.ok(out.includes("Not delivered (no parent session)"), `got: ${out}`);
    assert.ok(!out.includes("FAILED"), `nowhere to dial is not a failed dial. got: ${out}`);
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
    const store = storeSettledAs("completed", config);
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
  it("parseDynamicTaskJsonc returns null for malformed JSON", async () => {
    await withTempFile(`${tmpdir()}/dt-malformed-${Date.now()}.jsonc`, async (file) => {
      writeFileSync(file, "{ not json,");
      assert.strictEqual(parseDynamicTaskJsonc(file), null);
    });
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

  it("reads the latest assistant text, skipping empties", () => {
    assert.strictEqual(getLatestAssistantText([assistant("old"), assistant("new")]), "new");
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

  it("escalates a completed record to error — the one retained rewrite edge", () => {
    const store = storeSettledAs("completed", config);
    assert.strictEqual(noteLateOutcome(store, "ses_active", "error"), true);
    assert.strictEqual(store.retainedTasks.get("ses_active").state, "error");
    assert.ok(store.retainedTasks.has("ses_active"), "stays retained");
  });

  it("refuses to rewrite interrupted or errored records", () => {
    const store = storeSettledAs("interrupted", config);
    assert.strictEqual(noteLateOutcome(store, "ses_active", "error"), false);
  });

  it("refuses non-edges and unknown sessions", () => {
    const store = storeSettledAs("completed", config);
    assert.strictEqual(noteLateOutcome(store, "ses_active", "completed"), false);
    assert.strictEqual(noteLateOutcome(store, "ses_nope", "error"), false);
  });
});

describe("question gate: resolveQuestionSession", () => {
  const config = normalizeDynamicTaskConfig({});

  function trackedStore() {
    const store = createTaskStore();
    registerActiveTask(store, childParams({ id: "ses_child", description: "t" }), config);
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

  it("resetQuestionSessions drops remembered linkage", () => {
    const store = trackedStore();
    rememberQuestionSession("q-reset-me", "ses_child");
    resetQuestionSessions();
    assert.deepStrictEqual(
      resolveQuestionSession({ type: "question.created", properties: { request_id: "q-reset-me" } }, store),
      { questionId: "q-reset-me", childSessionId: null }
    );
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
    transitionState(store, "ses_child", "completed");
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
    registerActiveTask(store, childParams({ id: id }), config);
  }

  it("notifies on retained writes, silent on active-only writes", () => {
    const store = createTaskStore();
    const changes = countRetainedChanges(store);
    seedActive(store, "s1");
    assert.strictEqual(changes.calls, 0, "active-only writes stay silent");
    transitionState(store, "s1", "completed");
    assert.strictEqual(changes.calls, 1);
    noteLateOutcome(store, "s1", "error");
    assert.strictEqual(changes.calls, 2);
    reviveRetainedTask(store, "s1", config);
    assert.strictEqual(changes.calls, 3, "revival leaves the retained ledger");
  });

  it("pruning emits the change signal when entries expire", () => {
    const store = createTaskStore();
    const changes = { calls: 0 };
    store.onRetainedChange = () => { changes.calls++; };
    seedActive(store, "s1");
    transitionState(store, "s1", "completed");
    store.retainedTasks.get("s1").retainedAt = 0;
    assert.strictEqual(pruneRetainedTasks(store, { retainedTaskTtlMs: 1000, retainedTaskMaxEntries: 100 }), 1);
    assert.strictEqual(changes.calls, 2);
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

  it("formatTaskStatusDetail warns on a stalled active turn, stays factual on fresh ones", () => {
    const base = taskRecord();
    const stale = formatTaskStatusDetail({ ...base, startedAt: Date.now() - 20 * 60 * 1000 }, null);
    assert.match(stale, /Last plugin event: 20m ago/);
    assert.match(stale, /stalled/);
    assert.match(stale, /task_interrupt/);
    const fresh = formatTaskStatusDetail({ ...base, startedAt: Date.now() }, null);
    assert.match(fresh, /Last plugin event:/);
    assert.ok(!fresh.includes("stalled"), `fresh turns carry no warning. got: ${fresh}`);
  });

  it("formatTaskStatusDetail reads activity from observed events, not from the spawn", () => {
    const base = taskRecord();
    // 20m since spawn, an event 2s ago: the child is demonstrably working, so
    // the stall line is a false alarm and must not render.
    const working = formatTaskStatusDetail(
      { ...base, startedAt: Date.now() - 20 * 60 * 1000, lastActivityAt: Date.now() - 2000 }, null);
    assert.match(working, /Last plugin event: 2s ago/);
    assert.ok(!working.includes("stalled"), `observed activity suppresses the stall line. got: ${working}`);
    // No heartbeat yet (plugin booted after the spawn): the spawn stays the
    // honest floor and the silence stays visible.
    const unheard = formatTaskStatusDetail({ ...base, startedAt: Date.now() - 20 * 60 * 1000 }, null);
    assert.match(unheard, /Last plugin event: 20m ago/);
    assert.match(unheard, /stalled/);
  });

  it("formatTaskListSummary names pruned expiries when told", () => {
    const pruned = formatTaskListSummary({ active: [], retained: [], maxConcurrent: 4, pruned: 1 });
    assert.ok(pruned.includes("Pruned: 1 expired"), `got: ${pruned}`);
    const clean = formatTaskListSummary({ active: [], retained: [], maxConcurrent: 4, pruned: 0 });
    assert.ok(!clean.includes("Pruned:"), `silence when nothing expired. got: ${clean}`);
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
    for (const [id, age] of [["ses_a", 5], ["ses_b", 3], ["ses_c", 0]]) {
      store.retainedTasks.set(id, retainedEntry({ childSessionId: id, agentName: id, description: id, retainedAt: now - age }));
    }

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
    registerActiveTask(store, childParams({ id: "ses_dup", description: "t" }), normalizeDynamicTaskConfig({}));
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

