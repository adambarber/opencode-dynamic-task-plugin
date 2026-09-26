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

// The smallest shapes the reader tests are about, stated once: a text part, and
// a message carrying one. A case should be able to say what it means ("an
// assistant turn that said X") instead of the envelope that carries it — the
// envelope is an implementation detail of the host, and restating it per case
// is how two cases end up asserting different things under the same name.
const textPart = (text) => ({ type: "text", text });
const said = (role, text) => ({ role, parts: [textPart(text)] });

/**
 * The safe config defaults, asserted as a set. They are one contract — two
 * limits, a blocklist, a flag and three positive TTLs — and the ladder was
 * hand-written at each site that cared, so a new default could be added without
 * any of them noticing. Reused by the cases that feed garbage in and expect
 * exactly these values back.
 */
function assertSafeDefaults(config) {
  assert.strictEqual(config.maxDepth, 2);
  assert.strictEqual(config.maxConcurrent, 4);
  assert.deepStrictEqual(config.blockedAgents, []);
  assert.strictEqual(config.allowSameAgentRecursion, false);
  assert.ok(config.agentCacheTtlMs > 0);
  assert.ok(config.retainedTaskTtlMs > 0);
  assert.ok(config.retainedTaskMaxEntries > 0);
}

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
    assertNothing(validateSessionResult(null), "no result at all");
    assertNothing(validateSessionResult({ noId: true }), "a result carrying no id");
  });
});

describe("extractTextFromParts", () => {
  it("joins text parts", () => {
    assert.strictEqual(extractTextFromParts([textPart("Hello "), textPart("World")]), "Hello \nWorld");
  });

  it("filters non-text parts", () => {
    assert.strictEqual(extractTextFromParts([textPart("Hello"), { type: "file", url: "http://example.com" }]), "Hello");
  });

  it("handles empty array", () => {
    assert.strictEqual(extractTextFromParts([]), "");
  });

  it("handles null/undefined in parts", () => {
    assert.strictEqual(extractTextFromParts([textPart("Hello"), null, undefined, textPart("World")]), "Hello\nWorld");
  });
});

/**
 * The refusals a session-id reader owes, as one claim: no field at all, no event,
 * or an id that is only whitespace. Two cases state it — one on its own, one with
 * the legacy ambient var set, where a reader that consulted it would answer with
 * the phantom instead of nothing.
 */
const noUsableSessionId = () => {
  assertNothing(resolveParentSessionId({}), "an event with no session field");
  assertNothing(resolveParentSessionId(null), "no event at all");
  assertNothing(resolveParentSessionId({ sessionID: "   " }), "a blank session id");
};

/** The same refusals with the legacy ambient var set: a reader that consulted it would answer the phantom. */
const noUsableSessionIdUnderThePhantomVar = async () => {
  await withEnv("DYNAMIC_TASK_TEST_SESSION_ID", "ses_phantom", noUsableSessionId);
};

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
    noUsableSessionId();
  });

  it("ignores the legacy ambient test var — callers resolve explicitly", noUsableSessionIdUnderThePhantomVar);
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

  /**
   * The dispatchable agent names a client yields — the answer every case here
   * actually asserts on, in one expression. Spelled three ways in this file
   * (`result.length`, `result[0].name`, `result.map(...)`), so which of those
   * was the actual contract was ambiguous; now it is names, always.
   */
  const agentNames = async (client) => (await fetchAgents(client)).map((a) => a.name);

  it("dispatches subagent and all modes, rejects primary", async () => {
    const mockClient = clientWith([
      { name: "explore", mode: "subagent" },
      { name: "architect", mode: "all" },
      { name: "unannotated" },
      { name: "build", mode: "primary" },
    ]);

    assert.deepStrictEqual(
      (await agentNames(mockClient)).sort(),
      ["architect", "explore", "unannotated"]
    );
  });

  it("handles error gracefully", async () => {
    const mockClient = clientWith(() => {
      throw new Error("Network error");
    });

    assert.deepStrictEqual(await agentNames(mockClient), []);
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

    const names = await agentNames(mockClient);
    assert.strictEqual(mockClient.agentCalls, 2, "one immediate retry");
    assert.deepStrictEqual(names, ["explore"]);
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

      assert.deepStrictEqual(await agentNames(mockClient), [kept], "primary agents are not dispatchable");
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
    assertEmpty(normalizeStatus(123), "a number is not a status word");
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
    assertNothing(getSessionIdFromEvent({}), "an event with no id");
    assertNothing(getSessionIdFromEvent(null), "no event at all");
  });

  it("returns null for whitespace-only id", () => {
    assertNothing(getSessionIdFromEvent({ id: "  " }), "a whitespace-only id");
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
  // event is an error regardless of payload shape, which is why the map is a
  // table: a new host event type is a new row, not a fourth copy of the same
  // three lines.
  for (const [why, event, expected] of [
    ["a session.error event with no status field", { type: "session.error", properties: { sessionID: "s1", error: { name: "APIError", data: { message: "Too Many Requests" } } } }, "error"],
    ["a sync-wrapped session.error envelope", { type: "sync", name: "session.error.1", properties: { sessionID: "s1" } }, "error"],
    ["a non-error event still reads its own status", { type: "session.idle", properties: { sessionID: "s1", status: "idle" } }, "idle"],
  ]) {
    it(`${why} reads as ${expected || "(nothing)"}`, () => {
      assertIs(getEventLifecycleStatus(event), expected, why);
    });
  }
});

// The real 429 signal lives on the message INFO (AssistantMessage.error ->
// ApiError.data.message), never as a part type or a message role: a failed
// turn still has role "assistant" with empty text. The reader must dig the
// info envelope (dual-era, like messageRoleOf) and surface a human detail.
// The envelope the reader must dig. A failed turn still has role
// "assistant", and the human detail is one level down inside info.error — no
// part carries it. Stated once so two cases cannot pass for different reasons.
describe("messageErrorDetail", () => {
  const assistantTurn = (error, parts = []) => ({
    info: error === undefined ? { role: "assistant" } : { role: "assistant", error },
    parts,
  });

  it("extracts ApiError.data.message from the info envelope", () => {
    assert.strictEqual(
      messageErrorDetail(assistantTurn({ name: "APIError", data: { message: "Too Many Requests", statusCode: 429 } })),
      "Too Many Requests",
    );
  });

  it("falls back to the error name when no message", () => {
    assert.strictEqual(
      messageErrorDetail(assistantTurn({ name: "MessageAbortedError" })),
      "MessageAbortedError",
    );
  });

  it("returns empty for a clean assistant message", () => {
    assert.strictEqual(
      messageErrorDetail(assistantTurn(undefined, [textPart("done")])),
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
    assertEmpty(messageErrorDetail({ role: "assistant" }), "an assistant message carrying no error part");
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
    assertIs(isTransientOutcomeError(undefined), false, "a non-error is not a transient host error");
  });
});

// One hypothesis: an absent or unusable env value yields the default. `undefined`
// is the "not set" case, which withEnv understands as unset.
describe("maxConcurrent default", () => {
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

// One hypothesis, one arrangement: which event SHAPES end a turn. Each case
// keeps its own name because the shape is what a reader needs to see.
describe("isTerminalSessionEvent", () => {
  const shapes = [
    ["treats sync session.updated idle as terminal", sessionUpdatedEnvelope("idle"), true],
    ["treats sync session.updated error as terminal", sessionUpdatedEnvelope({ type: "error" }), true],
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
    assertNothing(describeModelShapeError("nvidia/z-ai/glm-5.3"), "a well-formed override");
    assertNothing(describeModelShapeError(undefined), "no model named");
    assertNothing(describeModelShapeError("   "), "a blank model");
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
    assertAbsent(hostPayload(undefined), "no envelope, no payload");
  });
});

describe("formatTaskResultSummary", () => {
  it("includes next action guidance for running tasks", () => {
    const result = formatTaskResultSummary(resultRecord({ status: "busy" }));
    assert.match(result, /Recommended next action: use task_status for settleability/);
    assert.match(result, /Tracked: yes/);
  });

  it("renders the store state for active tasks with the sourced liveness beside it", () => {
    const result = formatTaskResultSummary(resultRecord({
      status: "active",
      task: taskRecord(),
      liveness: { hostState: "busy", lastMessageAt: Date.now() - 1000 },
    }));
    assert.match(result, /Status: active/);
    assert.match(result, /Server status: busy/);
    assert.match(result, /Last child message: 1s ago/);
    assert.match(result, /Last plugin event: 0s ago/);
    // A working child carries no warning: silence is a claim the sources do not
    // support, and a store that says active is the authority on settleability.
    assert.ok(!result.includes("Warning"), `no warning while the server says busy. got: ${result}`);
  });

  it("never infers a status the sources did not state", () => {
    const result = formatTaskResultSummary(resultRecord({
      status: "completed",
      task: taskRecord({ state: "completed" }),
      liveness: { hostState: null, lastMessageAt: null },
    }));
    assert.match(result, /Status: completed/);
    assert.ok(!result.includes("suggests"), `a guess must never render. got: ${result}`);
    // A settled record with a quiet server has no liveness question left, so
    // the block is absent rather than reporting the absence as a reading.
    assert.ok(!result.includes("Server status"), `no question, no block. got: ${result}`);
  });

  it("renders read failures in the same voice with the error as data", () => {
    const result = formatTaskResultSummary(resultRecord({
      sessionId: "ses_gone", status: "error", messageCount: 0,
      latestText: "(See error above)", tracked: false, error: "boom (not retryable)",
    }));
    assert.match(result, /^## Task Result/);
    assert.match(result, /Status: error/);
    assert.match(result, /Error: boom \(not retryable\)/);
  });

  it("includes recovery guidance for error status", () => {
    const result = formatTaskResultSummary(resultRecord({ status: "error", tracked: false }));
    assert.match(result, /Recommended next action: inspect latest output/);
    assert.match(result, /Tracked: no/);
  });

  it("surfaces delivery attempts when provided", () => {
    const result = formatTaskResultSummary(resultRecord({
      status: "idle",
      notification: { kind: "completed", delivered: true, attempts: 2 },
    }));
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
// inLedgerFile, with one record and one owed notice already saved. Durability is
// checked in two places — what comes back out, and what is left on disk — and
// both start here.
const withSavedLedger = (fn) =>
  inLedgerFile((file) => {
    saveTaskLedger({ retained: new Map([["ses_1", retainedEntry()]]), active: new Map([["ses_2", activeEntry()]]), pending: [owedEntry()] }, file);
    return fn(file);
  });

/** withRawLedger's middle, for the case that already holds the file. */
const withRawLedgerSync = (document, file) => {
  writeFileSync(file, JSON.stringify({ version: 3, ...document }));
  return loadTaskLedger(file);
};

/**
 * A ledger file holding a document the case composed by hand, read back. These
 * cases are about files the plugin has to survive — corrupt, partial, or written
 * by a past it cannot read — and `saveTaskLedger` cannot produce any of them, so
 * going through it would test the writer instead of the reader.
 */
const withRawLedger = (document, fn) =>
  inLedgerFile((file) => fn(withRawLedgerSync(document, file), file));

/**
 * The load of a raw ledger the case wrote: the document in, what the loader made
 * of it. The all-or-nothing and version cases are the same arrangement with a
 * different document, so it is named once and each case states only the document
 * and the claim — the alternative was a reader of a red run having to guess which
 * of three near-identical bodies failed.
 */
const loadRaw = async (document) => {
  let loaded;
  await inLedgerFile(async (file) => {
    loaded = withRawLedgerSync(document, file);
  });
  return loaded;
};

const inTempFile = (fn) => withTempFile(tmpFilePath("dt-cfg"), fn);

/**
 * A .jsonc file the parser must refuse. One idea with several spellings — the
 * wrong shape, malformed JSON — so the temp file, the write and the refusal are
 * one helper. A case that hand-rolls it is a case that can quietly assert
 * against a file that was never written, or through a second temp-file idiom
 * that is not the one the rest of the file cleans up after.
 */
const assertJsoncRejected = async (contents) => {
  assertNothing(await jsoncRead(contents), `must refuse ${JSON.stringify(contents)}`);
};

/**
 * A .jsonc file the parser must read, and what it read out of it. The mirror of
 * the helper above, and it exists for the same reason: the temp file, the write
 * and the parse are one arrangement, so a case that hand-rolls the accepted side
 * is a case that can assert against a file that was never written, or through a
 * second temp-file idiom the rest of the file does not clean up after.
 */
const jsoncRead = async (contents) => {
  let parsed;
  await inTempFile(async (file) => {
    writeFileSync(file, contents);
    parsed = parseDynamicTaskJsonc(file);
  });
  return parsed;
};

function tmpLedgerPath() {
  return `${tmpdir()}/dt-ledger-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;
}

// Every case here owns a temp ledger for the duration of one assertion. The
// old hand-rolled cleanup unlinked the file but not the ledger dance's `.tmp`
// sidecar in the two sites that mattered, and the missing-file site skipped
// cleanup entirely — withTempFile owns the whole lifetime.
describe("task ledger persistence", () => {
  const itRoundTrips = (name, check) => it(name, () => withSavedLedger((file) => check(loadTaskLedger(file))));

  itRoundTrips("round-trips retained records through an injectable path", (loaded) => {
    const record = loaded.retained.get("ses_1");
    assert.strictEqual(loaded.retained.size, 1);
    assert.strictEqual(record.agentName, "explore");
    assert.strictEqual(record.state, "completed");
    assert.strictEqual(record.timeoutNotified, undefined, "the reader strips transient fields");
  });

  itRoundTrips("round-trips the owed-notice queue, exact write and attempt count intact", (loaded) => {
    assert.deepStrictEqual(loaded.pending, [owedEntry()], "the owed write survives verbatim");
  });

  it("round-trips a running task, and strips every advisory field from it", () =>
    withSavedLedger(async (file) => {
      const loaded = loadTaskLedger(file);
      const restored = loaded.active.get("ses_2");
      assert.ok(restored, "the running task comes back");
      assert.deepStrictEqual(
        { ...restored, lastNotice: undefined, lastActivityAt: undefined, turnLiveAt: undefined, replacedAt: undefined },
        { ...activeEntry(), lastNotice: undefined, lastActivityAt: undefined, turnLiveAt: undefined, replacedAt: undefined },
        "identity and routing survive; the advisory fields do not",
      );
      for (const advisory of ["lastNotice", "lastActivityAt", "turnLiveAt", "replacedAt"]) {
        assert.strictEqual(JSON.parse(readFileSync(file, "utf8")).active.ses_2[advisory], undefined,
          `${advisory} must never be written to the ledger`);
      }
    }));

  // One hypothesis: a record is restored whole or not at all. An active entry
  // missing a base field would be settled by reconciliation with no clock, no
  // lineage and no parent to tell, i.e. a record invented from a corrupt file.
  it("an active entry missing a base field is dropped, not half-restored", async () => {
    const { startedAt: _noClock, ...clockless } = activeEntry({ childSessionId: "ses_nostart" });
    const loaded = await loadRaw({
      tasks: {},
      pending: [],
      active: { ses_ok: activeEntry({ childSessionId: "ses_ok" }), ses_nostart: clockless },
    });
    assert.deepStrictEqual([...loaded.active.keys()], ["ses_ok"], "only the whole entry returns");
  });

  // The same hypothesis for the queue: a queued write missing any of its fields
  // cannot be redelivered (no parent, no text, or an unknown kind), and half of
  // one is worse than none — the boot would dial a message nobody can account for.
  it("drops a queue entry missing any field, never half of it", async () => {
    const loaded = await loadRaw({ tasks: {}, ...{ pending: [
      owedEntry({ childSessionId: "ses_noparent", parentSessionId: undefined }),
      owedEntry({ childSessionId: "ses_notext", text: "" }),
      owedEntry({ childSessionId: "ses_badkind", kind: "shout" }),
      owedEntry({ childSessionId: "ses_noid", childSessionId: 42 }),
      owedEntry(),
    ] } });
    assert.deepStrictEqual(loaded.pending, [owedEntry()], "only the whole entry returns");
  });

  it("returns empty for missing, corrupt, and unknown-version files", async () => {
    const empty = (file) => {
      const loaded = loadTaskLedger(file);
      assert.strictEqual(loaded.retained.size, 0);
      assert.deepStrictEqual(loaded.pending, []);
    };
    empty(`${tmpdir()}/dt-nope-${Date.now()}.json`);
    await withTempFile(tmpLedgerPath(), async (bad) => {
      writeFileSync(bad, "{ nope");
      empty(bad);
    });
    await withTempFile(tmpLedgerPath(), async (future) => {
      writeFileSync(future, JSON.stringify({ version: 999, tasks: {}, pending: [owedEntry()] }));
      empty(future);
    });
  });

  it("save writes atomically via rename — no .tmp residue", () =>
    withSavedLedger(async (file) => {
      assert.strictEqual(existsSync(`${file}.tmp`), false, "tmp must be renamed away, not left behind");
      assert.strictEqual(loadTaskLedger(file).retained.size, 1, "renamed content intact");
      assert.strictEqual(loadTaskLedger(file).active.size, 1, "the running task is written, not dropped");
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
        writeFileSync(file, JSON.stringify({ version: 3, tasks, active: {}, pending: [] }));
        assert.deepStrictEqual([...loadTaskLedger(file).retained.keys()], keepers);
      });
    });
  }

  it("rejects non-finite timestamps and mixed lineage wholesale", async () => {
    await inLedgerFile(async (file) => {
      const nanEntry = { ...retainedEntry(), startedAt: NaN };
      const mixedLineage = { ...retainedEntry(), childSessionId: "ses_mix", lineage: ["x", 42] };
      saveTaskLedger({ retained: new Map([["ses_nan", nanEntry], ["ses_mix", mixedLineage]]), active: new Map(), pending: [] }, file);
      const loaded = loadTaskLedger(file).retained;
      assert.strictEqual(loaded.has("ses_nan"), false, "NaN does not survive the durability boundary");
      assert.strictEqual(loaded.has("ses_mix"), false, "mixed lineage is rejected, not silently shortened");
    });
  });

  // The version policy, stated once: a past this reader cannot fully understand
  // is discarded wholesale, because a partially-restored past is worse than a
  // clean boot — a retained history that silently lost entries reads as history.
  it("a v2 ledger is discarded whole, retained records and owed notices alike", async () => {
    const loaded = await loadRaw({ version: 2, tasks: { ses_1: retainedEntry() }, pending: [owedEntry()] });
    assert.strictEqual(loaded.retained.size, 0, "no half-restored history");
    assert.strictEqual(loaded.active.size, 0, "and no running task from a past this build cannot read");
    assert.deepStrictEqual(loaded.pending, [], "no debt from a world this reader cannot describe");
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
    assertSafeDefaults(normalizeDynamicTaskConfig({}));
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
    assertNothing(parseDynamicTaskJsonc("/nonexistent/path/config.jsonc"), "a config that is not there");
  });

  it("returns null for empty or non-object payloads", async () => {
    assertNothing(parseDynamicTaskJsonc(""), "an empty config");
    await assertJsoncRejected("[1, 2]");
  });

  it("strips comments and parses objects", async () => {
    assertAnswer(
      await jsoncRead('{ /* block */ "maxDepth": 3 } // trailing\n'),
      { maxDepth: 3 },
      "a commented config parses to the object it describes",
    );
  });
});

describe("config field parsing edges", () => {
  it("agentCacheTtlMs comes from options", () => {
    const config = normalizeDynamicTaskConfig({ agentCacheTtlMs: 1500 });
    assert.strictEqual(config.agentCacheTtlMs, 1500);
  });

  // NaN is the interesting one: it is a number, and a `<= 0` guard would let it
  // through, so the whole "safe" claim would rest on a TTL of NaN.
  it("rejects non-positive numbers everywhere", () => {
    assertSafeDefaults(normalizeDynamicTaskConfig({ maxDepth: 0, maxConcurrent: -3, agentCacheTtlMs: NaN }));
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

// type PolicyResult is type-only, imported via the functions' return types
describe("normalizeAgentName", () => {
  it("lowercases and trims agent names", () => {
    assert.strictEqual(normalizeAgentName("General"), "general");
    assert.strictEqual(normalizeAgentName("  REVIEWER "), "reviewer");
  });

  it("strips @ prefix", () => {
    assert.strictEqual(normalizeAgentName("@general"), "general");
    assert.strictEqual(normalizeAgentName("@Reviewer"), "reviewer");
  });

  it("returns null for unsupported types", () => {
    assertNothing(normalizeAgentName(null), "no name at all");
    assertNothing(normalizeAgentName(undefined), "an absent name");
    assertNothing(normalizeAgentName(123), "a name that is not a string");
    assertNothing(normalizeAgentName(""), "an empty name");
  });
});

/**
 * Admission refuses @general in this file, so every case that is about a different
 * rule needs the same config spelled out. One declaration, named for the refusal
 * it carries, because two describes were each building it and a case that copied
 * the wrong one would be refused for the wrong reason.
 */
const blockingConfig = () => normalizeDynamicTaskConfig({ blockedAgents: ["general"] });

describe("validateAgent", () => {
  const config = blockingConfig();

  // Admission is one decision over one input, so the cases are a table: a new
  // spelling of "blocked" is a new row, not a fourth copy of the same three
  // lines. The optional pattern is for the message a refusal carries — the one
  // thing an `ok: false` alone does not pin down.
  const admissions = [
    ["rejects a configured blocked agent", "general", false, /general/i],
    ["rejects @General (normalized)", "@General", false],
    ["allows non-blocked agents", "reviewer", true],
  ];
  for (const [name, agent, ok, refusedWith] of admissions) {
    it(name, () => {
      const result = validateAgent(agent, config);
      assert.strictEqual(result.ok, ok);
      if (refusedWith) assert.match(result.error, refusedWith);
    });
  }

  it("allows agents not in blockedAgents", () => {
    const customConfig = normalizeDynamicTaskConfig({ blockedAgents: ["coder"] });
    assert.strictEqual(validateAgent("reviewer", customConfig).ok, true);
    assert.strictEqual(validateAgent("coder", customConfig).ok, false);
    admits(validateAgent("general", customConfig), "general is NOT blocked here");
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
    assertIs(isSameAgent("explore", "general"), false, "two different agents are two agents");
  });
});

describe("validateLineage", () => {
  const config = normalizeDynamicTaskConfig({ maxDepth: 2 });

  it("rejects same-agent anywhere in lineage", () => {
    const result = refuses(validateLineage(["reviewer"], "reviewer", config), "the agent is already in the lineage");
    assert.match(result.error, /recursion|same-agent|already present/i);
  });

  it("rejects same-agent deep in lineage", () => {
    refuses(validateLineage(["general", "coder", "explore"], "general", config), "presence anywhere in the lineage counts");
  });

  it("rejects when next depth exceeds maxDepth", () => {
    const result = refuses(validateLineage(["general", "coder"], "explore", config), "the next step is past maxDepth");
    assert.match(result.error, /depth/i);
  });

  it("allows different-agent chain within depth limit", () => {
    admits(validateLineage(["general"], "coder", config), "a different agent within the depth limit");
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
  decideQuestion,
} from "../../dist/shared/question-handling.js";
import { readAskedQuestion } from "../../dist/shared/host-events.js";
import { tmpdir } from "node:os";
import { checkConcurrencyLimit } from "../../dist/shared/config.js";
import { tmpFilePath, withEnv, withTempFile, sessionUpdatedEnvelope } from './support/harness.js';
import { retainedEntry, activeEntry, owedEntry } from './support/records.js';

describe("task-state: createTaskStore", () => {
  it("creates empty active and retained maps", () => {
    assertStoreEmpty(createTaskStore(), "a fresh store");
  });
});

// Shared test-harness funnels: one way to build common fixtures.
// The registration literal — the input every task-state test builds — has five
// fields and only the child id usually matters. This names the shape once, so
// a test states its intent ("a second agent") instead of a field list whose
// defaults could drift from the production param type.
/**
 * The config a case means when it does not care: the machine's own defaults,
 * normalized once. Nine describes were each deriving it, and a change to the
 * defaults meant nine edits. Describes that need something else keep their own
 * derivation, and the name is theirs to shadow.
 */
const config = normalizeDynamicTaskConfig({});

/** A store holding one running child named ses_active — where most state cases start. */
function storeWithActive(cfg = config) {
  const store = createTaskStore();
  seedSesActive(store, cfg);
  return store;
}

/** The same store with the retained-change signal counted: the callback cases' subject. */
function countingStore(cfg = config) {
  const store = storeWithActive(cfg);
  return { store, changes: countRetainedChanges(store) };
}

/**
 * A gate's verdict, with the refusal's own words in the failure. A gate answers
 * in a result object whose only field worth reading is `ok`, and each case was
 * asserting that field alone — so a refusal that came back saying nothing at all
 * read the same as one that explained itself.
 */
function verdict(result, expected, why) {
  assert.strictEqual(result.ok, expected, claimFailure(why, result));
  return result;
}
const refuses = (result, why) => verdict(result, false, why);
const admits = (result, why) => verdict(result, true, why);

/**
 * The failure line every claim helper in this file shares: the case's own claim,
 * then what the reader actually answered. Composed once, because a claim whose
 * failure message leaves out the answer is a claim nobody can diagnose.
 */
const claimFailure = (why, found) => `${why}. got: ${JSON.stringify(found)}`;

/** "The answer is nothing" — the claim behind a free slot and an unknown session. */
function assertNothing(found, why) {
  assert.strictEqual(found, null, claimFailure(why, found));
}

/**
 * The rest of that family, because these are the whole of it: a reader in this
 * file answers with a word, an empty string, nothing at all, or a boolean — and
 * an assertion that does not say which claim it is making is the same assertion
 * to the reader of a red run, however different the function under it.
 */
function assertEmpty(found, why) {
  assert.strictEqual(found, "", claimFailure(why, found));
}
function assertAbsent(found, why) {
  assert.strictEqual(found, undefined, claimFailure(why, found));
}
function assertIs(found, expected, why) {
  assert.strictEqual(found, expected, claimFailure(why, found));
}
/** "Nothing usable in it" — the claim behind a parser handed garbage, a list or nothing. */
function assertNoAgents(found, why) {
  assert.deepStrictEqual(found, [], claimFailure(why, found));
}
/** A reader's whole answer — the identity it read off a question, or the decision it made. */
function assertAnswer(answer, expected, why) {
  assert.deepStrictEqual(answer, expected, claimFailure(why, answer));
}

/** A store holding nothing — the claim behind a fresh store, a filter, and a prune. */
function assertStoreEmpty(store, why) {
  assert.strictEqual(store.activeTasks.size, 0, `${why}: nothing running`);
  assert.strictEqual(store.retainedTasks.size, 0, `${why}: nothing retained`);
}

/**
 * The advisory fields a settlement must not carry into retention. A heartbeat and
 * a mid-flight notice are the two the event funnel writes, and neither survives a
 * restart — the claim is one, so the check is one.
 */
function assertNotRetainedFrom(store, field) {
  assert.ok(!(field in store.retainedTasks.get("ses_active")), `${field} must not reach the retained record`);
}

/**
 * The classifier is total: whatever it is handed, it reports that value back and
 * calls nothing but a refusal retryable. Two describes were each asserting a
 * couple of these by hand, which is how "handles non-Error values" came to be
 * split from "handles odd shapes".
 */
function assertClassifiedAs(thrown, said) {
  const classified = classifyPromptError(thrown);
  assert.strictEqual(classified.message, said, `reported value. got: ${JSON.stringify(classified)}`);
  assert.strictEqual(classified.retryable, false, "a value that is not a transient host error is not retryable");
}

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
  const store = storeWithActive(cfg);
  transitionState(store, "ses_active", state);
  return store;
}

/** A config that permits exactly one running child — the gate, in one option. */
function singleSlotConfig() {
  return normalizeDynamicTaskConfig({ maxConcurrent: 1 });
}

/**
 * The exactly-once claim about a settled record, asserted once: a second
 * settlement throws, and the record still holds the outcome that landed first.
 * Two sites guarded this with slightly different patterns, which is two chances
 * to accept a weaker pattern than the sentence claims.
 */
function assertSettlementIsFinal(store) {
  assert.throws(() => transitionState(store, "ses_active", "error"), /terminal|invalid|not found/i);
  assert.strictEqual(store.retainedTasks.get("ses_active").state, "completed");
}

/** formatTaskResultSummary over a settled record carrying this notification. */
function summaryWith(notification) {
  return formatTaskResultSummary({ ...resultRecord(), notification });
}

describe("task-state: transitionState", () => {
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
    const store2 = storeWithActive(config);
    assert.strictEqual(transitionState(store2, "ses_active", "interrupted").state, "interrupted");
  });

  it("settle is exactly-once: a second settlement throws and cannot regress retention", () => {
    transitionState(store, "ses_active", "completed");
    assertSettlementIsFinal(store);
  });

  it("settlement strips advisory activity metadata — the ledger carries no heartbeat", () => {
    noteActivity(store, "ses_active");
    assert.ok(store.activeTasks.get("ses_active").lastActivityAt, "the event funnel stamps the active record");
    transitionState(store, "ses_active", "completed");
    assertNotRetainedFrom(store, "lastActivityAt");
  });

  it("settlement strips advisory notice metadata", () => {
    annotateNotice(store, "ses_active", "interim");
    transitionState(store, "ses_active", "completed");
    assertNotRetainedFrom(store, "lastNotice");
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

  /** A store whose one child has already been retained in the given state. */
  const retained = (state = "completed", cfg = config) => storeSettledAs(state, cfg);

  // The subject of every withdrawInterruptClaim test: one task holding a
  // speculative interrupt claim in the retained ledger, with the persistence
  // signal already wired. Naming the arrangement is what lets each test state
  // only the rule it is about.
  function interruptClaim(cfg = config) {
    const counted = countingStore(cfg);
    transitionState(counted.store, "ses_active", "interrupted", cfg);
    return counted;
  }

  it("withdrawInterruptClaim persists the ledger via emitRetainedChange", () => {
    const { store, changes } = interruptClaim();
    const before = changes.calls;
    withdrawInterruptClaim(store, "ses_active", Date.now(), config);
    assert.strictEqual(changes.calls, before + 1, "withdraw is a retained mutation and must persist");
    assert.strictEqual(store.activeTasks.get("ses_active")?.state, "active");
  });

  it("withdrawInterruptClaim refuses when full or superseded", () => {
    const limited = singleSlotConfig();
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

  // Same-ms success is still knowledge: a withdraw stamped at the instant of
  // a successful abort must lose to it (>=, not >).
  it("withdrawInterruptClaim refuses when the abort landed in the same millisecond", () => {
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
    const store2 = storeWithActive(config);
    transitionState(store2, "ses_active", "interrupted");
    assert.strictEqual(withdrawInterruptClaim(store2, "ses_active", Date.now(), config), true);
    assert.strictEqual(store2.activeTasks.get("ses_active")?.state, "active");
    assert.strictEqual(store2.retainedTasks.has("ses_active"), false);
    assert.strictEqual(withdrawInterruptClaim(store2, "ses_active", Date.now(), config), false, "second withdrawal refuses");
  });

  it("reviveRetainedTask moves a settled task back to active", () => {
    const store = retained();
    const revived = reviveRetainedTask(store, "ses_active", config);
    assert.strictEqual(revived.state, "active");
    assert.strictEqual(store.activeTasks.has("ses_active"), true);
    assert.strictEqual(store.retainedTasks.has("ses_active"), false);
  });

  it("interrupted tasks are not revived — that takes a fresh spawn", () => {
    const store = retained("interrupted");
    assert.throws(() => reviveRetainedTask(store, "ses_active", config), /interrupt/i);
  });

  it("revival passes through the concurrency gate", () => {
    const limited = singleSlotConfig();
    const store = storeSettledAs("completed", limited);
    registerActiveTask(store, childParams({ id: "ses_other", agent: "a2" }), limited);
    assert.throws(() => reviveRetainedTask(store, "ses_active", limited), /Concurrency/);
    assert.strictEqual(store.retainedTasks.get("ses_active").state, "completed", "rejected revival leaves the record untouched");
  });

  it("annotateNotice records the latest child message on active tasks only", () => {
    const store = storeWithActive();
    assert.strictEqual(annotateNotice(store, "ses_active", "blocked on credentials"), true);
    assert.strictEqual(store.activeTasks.get("ses_active").lastNotice.message, "blocked on credentials");
    assert.strictEqual(annotateNotice(store, "ses_nope", "x"), false);
    transitionState(store, "ses_active", "completed");
    assert.strictEqual(annotateNotice(store, "ses_active", "late"), false, "settled tasks take no notices");
  });

  it("recordAbortError annotates retained records and is silent otherwise", () => {
    const store = retained("interrupted");
    recordAbortError(store, "ses_active", "boom");
    assert.strictEqual(store.retainedTasks.get("ses_active").abortError, "boom");
    recordAbortError(store, "ses_nope", "boom"); // no throw
  });

  it("oldestRetainedId reads retention order", () => {
    const store = storeWithActive();
    assertNothing(oldestRetainedId(store), "a store that has retained nothing");
    transitionState(store, "ses_active", "completed");
    assert.strictEqual(oldestRetainedId(store), "ses_active");
  });

  it("listTasks splits the fleet by state", () => {
    const store = retained();
    registerActiveTask(store, childParams({ id: "ses_run" }), config);
    const { active, retained: settled } = listTasks(store);
    assert.deepStrictEqual(active.map((t) => t.childSessionId), ["ses_run"]);
    assert.deepStrictEqual(settled.map((t) => t.childSessionId), ["ses_active"]);
  });
});

describe("admission gate: resolveAdmission", () => {
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
    refuses(result, "an agent the host does not list is refused");
    assert.strictEqual(result.reason.kind, "unknown-agent");
  });

  it("denies blocked agents", () => {
    const result = resolveAdmission([{ name: "general" }], "general", [], blockingConfig());
    refuses(result, "a blocked agent is refused");
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
    refuses(resolveAdmission([{ name: "explore" }], "explore", ["explore"], strict), "the agent is already in the lineage");
  });

  it("honors the recursion flag", () => {
    admits(resolveAdmission([{ name: "explore" }], "explore", ["explore"], lenient), "recursion allowed, so the repeat is fine");
  });

  it("still enforces depth when recursion is allowed", () => {
    const shallow = normalizeDynamicTaskConfig({ allowSameAgentRecursion: true, maxDepth: 1 });
    const result = resolveAdmission([{ name: "explore" }], "explore", ["a", "b"], shallow);
    assert.strictEqual(result.ok, false);
  });
});

describe("admission gate: resolveDependencies", () => {

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
    admits(resolveDependencies(s2, ["s1"]), "a completed dependency admits");
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
    admits(resolveDependencies(createTaskStore(), ["ses_gone"]), "an unknown id is treated as satisfied");
  });
});

describe("admission gate: formatAdmissionError", () => {
  // One decision over one input, so the refusals are a table: a new refusal kind
  // is a new row, not a fourth copy of the same three lines. Each row is the
  // kind, what the gate was told, and the words the remedy has to contain.
  const refusals = [
    [{ kind: "missing-name" }, undefined, "No subagent_type"],
    [{ kind: "unknown-agent", requested: "nope" }, "nope", '"nope" not found'],
    [{ kind: "blocked", message: "blocked msg" }, "general", "blocked msg"],
    [{ kind: "lineage", message: "depth msg" }, "explore", "depth msg"],
  ];
  for (const [decision, requested, remedy] of refusals) {
    it(`a ${decision.kind} refusal carries its remedy`, () => {
      const said = formatAdmissionError(decision, "explore", requested);
      assert.ok(said.includes(remedy), `${decision.kind} must name ${JSON.stringify(remedy)}. got: ${said}`);
    });
  }
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
      assertNoAgents(parseAgentList(bad), `nothing usable in ${JSON.stringify(bad)}`);
    }
  });
});

describe("admission gate: registerAdmittedTask", () => {

  it("registers through the funnel and enforces the concurrency limit", () => {
    const limited = singleSlotConfig();
    const store = createTaskStore();
    const task = registerAdmittedTask(store, childParams({ id: "ses_1", description: "t1" }), limited);
    assert.strictEqual(task.agentName, "explore");
    assert.throws(() => registerAdmittedTask(store, childParams({ id: "ses_2", description: "t2" }), limited), /Concurrency/);
  });
});

describe("prompt dance: invokePrompt", () => {
  /**
   * A client whose only method is the prompt, answering as the case says. The
   * dance is a payload shape and a passthrough of whatever the client answered,
   * so the two cases are the same client with a different response — named once
   * here rather than re-typed per case, which is how one of them grew a second
   * prompt stub nobody was asserting against.
   */
  const clientAnswering = (respond) => ({ session: { prompt: async (args) => respond(args) } });

  it("sends the single payload shape and resolves with the client result", async () => {
    let captured;
    const client = clientAnswering((args) => {
      captured = args;
      return { parts: [{ type: "text", text: "hi" }] };
    });
    const result = await invokePrompt(client, "ses_1", "hello");
    assert.deepStrictEqual(captured, {
      path: { id: "ses_1" },
      body: { parts: [{ type: "text", text: "hello" }] },
    });
    assert.deepStrictEqual(result, { parts: [{ type: "text", text: "hi" }] });
  });

  it("rejects with the raw client error (callers classify)", async () => {
    const failure = new Error("boom");
    const client = clientAnswering(() => { throw failure; });
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
    assertAbsent(parseModelOverride(42), "a model that is not a string names no override");
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
    assertClassifiedAs(new Error("session not found"), "session not found");
  });

  it("handles non-Error values", () => {
    assertClassifiedAs("plain string", "plain string");
    assertClassifiedAs(null, "null");
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
  // is the caller's problem to see, with its message intact. A real failure is
  // reported against the question it failed on, so a log line names the subject.
  const outcomes = [
    ["reply succeeds", { reply: async () => {} }, { succeeded: true }],
    ["reply absorbs already-resolved as success",
      { reply: async () => { throw new Error("already resolved"); } },
      { succeeded: true, reason: "already_resolved" }],
    ["reply reports transport failures",
      { reply: async () => { throw new Error("nope"); } },
      { succeeded: false, reason: "q1: nope" }],
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
    assert.deepStrictEqual(await rejectQuestion(okClient(), "q1"), { succeeded: true });
    const conflicted = questionClient({
      reply: async () => {},
      reject: async () => { const e = new Error("gone"); e.status = 409; throw e; },
    });
    assert.deepStrictEqual(
      await rejectQuestion(conflicted, "q1"),
      { succeeded: true, reason: "already_resolved" }
    );
  });

  it("reject rejects missing id", async () => {
    assertIs((await rejectQuestion(okClient(), "")).succeeded, false, "a question with no id is never sent");
  });
});

// The host publishes `question.asked` carrying `questions: QuestionInfo[]`,
// each with `options: QuestionOption[]`. The suggestions live on the OPTION as
// its `label` — this gate used to read a top-level `properties.answers`, a
// field that exists only on the reply event, so every live question looked
// answerless and was rejected. These cases read the host's real shape, because
// a fixture invented to match the code certifies the code, not the host.
describe("question handling: the asked payload", () => {
  const asked = (properties) => ({ type: "question.asked", properties });
  const info = (text, labels) => ({ question: text, header: "Question", options: labels.map((label) => ({ label })) });

  it("a single-part ask with options yields the first label", () => {
    const read = readAskedQuestion(
      asked({ id: "q1", sessionID: "ses_child", questions: [info("Ship it?", ["yes", "no"])] }),
    );
    assertAnswer(read, { questionId: "q1", sessionId: "ses_child", answer: "yes" }, "the one-part ask, read whole");
  });

  // Answering the first part of a two-part ask retires the question with the
  // child never having seen the second answer: a silent loss as a success.
  it("a multi-part ask yields no answer — one entry per asked question, or none", () => {
    assert.strictEqual(
      readAskedQuestion(asked({ id: "q2", sessionID: "ses_child", questions: [info("A?", ["a1"]), info("B?", ["b1"])] })).answer,
      null,
    );
  });

  it("an ask with no options, an empty option list, or a non-string label yields no answer", () => {
    const noOptions = asked({ id: "q3", sessionID: "ses_child", questions: [info("Ship it?", [])] });
    assertNothing(readAskedQuestion(noOptions).answer, "options with nothing to choose");
    const emptyLabels = asked({ id: "q4", sessionID: "ses_child", questions: [{ question: "?", options: [] }] });
    assertNothing(readAskedQuestion(emptyLabels).answer, "options with no labels");
    const nonString = asked({ id: "q5", sessionID: "ses_child", questions: [{ question: "?", options: [{ label: 7 }] }] });
    assertNothing(readAskedQuestion(nonString).answer, "a label that is not a string");
  });

  it("refuses to read a payload it cannot identify: no id, no session, or no questions key", () => {
    assertNothing(readAskedQuestion(asked({ sessionID: "ses_child", questions: [info("?", ["y"])] })), "an ask with no question id");
    assertNothing(readAskedQuestion(asked({ id: "q6", questions: [info("?", ["y"])] })), "an ask with no session");
    assertNothing(readAskedQuestion(asked({ id: "q7", sessionID: "ses_child" })), "an ask with no questions key");
  });

  // The two answers are not the same. Unidentifiable means the gate cannot tell
  // whose question this is, so it touches nothing and leaves the question open.
  // An empty list still identifies a live child with an unanswerable question,
  // and there the fail-closed act is to REJECT it: passing on it would leave a
  // child stuck on a question that can never be answered.
  it("an EMPTY questions list is a refusal, not an unidentifiable event", () => {
    assert.deepStrictEqual(
      readAskedQuestion(asked({ id: "q8", sessionID: "ses_child", questions: [] })),
      { questionId: "q8", sessionId: "ses_child", answer: null },
    );
  });

  // The plugin reads the event the host published, not an SDK-resolved
  // response: only the client wraps. A gate that accepted both would be
  // guessing which one it is holding, and guessing is the defect class here —
  // the bare read of a wrapped event finds nothing and must say so.
  it("ignores an envelope-wrapped payload, since the host publishes it bare", () => {
    const bare = { id: "q9", sessionID: "ses_child", questions: [info("?", ["y"])] };
    assertNothing(readAskedQuestion({ type: "question.asked", data: bare }), "an envelope-wrapped payload where the host publishes it bare");
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

  it("validateAgent rejects empty names", () => {
    assert.strictEqual(validateAgent("", config).ok, false);
    refuses(validateAgent(null, config), "a dispatch that named no agent");
  });

  it("validateLineage rejects empty child names", () => {
    refuses(validateLineage([], "", config), "a lineage with an empty child name");
  });

  // The timeout-era races are structurally gone: settlement is exactly once
  // (active -> terminal), so a late error after a reported completion can
  // only arrive through noteLateOutcome, never through transitionState.
  it("a second settlement attempt cannot regress the first outcome", () => {
    const store = storeSettledAs("completed", config);
    assertSettlementIsFinal(store);
  });
});

describe("prompt dance: extractor shape coverage", () => {

  it("classifyPromptError handles odd shapes", () => {
    assertClassifiedAs({ message: 42 }, "42");
    assertClassifiedAs(undefined, "undefined");
  });
});

describe("config: file and env edges", () => {
  it("parseDynamicTaskJsonc returns null for malformed JSON", async () => {
    await assertJsoncRejected("{ not json,");
  });
});



describe("prompt dance: getLatestAssistantText", () => {
  it("returns the newest assistant text", () => {
    assert.strictEqual(
      getLatestAssistantText([said("assistant", "first"), said("user", "q"), said("assistant", "second")]),
      "second"
    );
  });

  it("reads the latest assistant text, skipping empties", () => {
    assert.strictEqual(getLatestAssistantText([said("assistant", "old"), said("assistant", "new")]), "new");
    assert.strictEqual(getLatestAssistantText([said("assistant", ""), said("user", "q")]), "");
    assert.strictEqual(getLatestAssistantText([]), "");
    assertEmpty(getLatestAssistantText(null), "no message at all");
  });
});

// The reader's one dependency is a message list, so that is the only thing
// these clients declare: a reader that grew a second dependency would have to
// be faked differently, and this is where that would show.
describe("prompt dance: hydrateLatestOutcome", () => {
  const clientReading = (read) => ({ session: { messages: async () => read() } });

  // The outcome is a fixed shape — text, errorDetail, unreadable — and a case
  // states only the part that moved. The full default is written once, so a new
  // field on the outcome is one edit here instead of a three-field literal at
  // every site, any of which could disagree about what "empty" means.
  const assertHydrated = async (read, expected) => assert.deepStrictEqual(
    await hydrateLatestOutcome(clientReading(read), "ses_1"),
    { text: "", errorDetail: "", unreadable: false, ...expected },
  );

  it("reads the latest assistant text from the session", async () => {
    await assertHydrated(() => [said("assistant", "CHILD_SAYS")], { text: "CHILD_SAYS" });
  });

  it("surfaces the message-level error detail from the same read", async () => {
    const failedTurn = [{
      info: { role: "assistant", error: { name: "APIError", data: { message: "Too Many Requests" } } },
      parts: [],
    }];
    await assertHydrated(() => failedTurn, { errorDetail: "Too Many Requests" });
  });

  // A read that could not be made is not a read that found nothing, and the
  // notification has to be able to say which one it is quoting.
  it("falls back to empty fields and admits the read failed when messages fail", async () => {
    const gone = () => {
      throw new Error("gone");
    };
    await assertHydrated(gone, { unreadable: true });
  });
});

describe("task-state: noteLateOutcome", () => {

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
    assertIs(noteLateOutcome(store, "ses_nope", "error"), false, "an untracked session has no outcome to note");
  });
});

describe("question gate: decideQuestion", () => {
  it("an active child with an answer replies with it", () => {
    assertAnswer(decideQuestion("active", "yes"), { action: "reply", answer: "yes" }, "an active child answers");
  });

  // The only reader of this text is the parent: the host's reject endpoint
  // declares `body?: never`, so it cannot reach the asking session. It used to
  // read as child advice — "call task_notify" — which the parent does not hold,
  // and it led with the diagnosis so the parent's own remedy fell past the
  // status view's 120-char truncation. Hence: the parent's tool, up front.
  it("an active child with nothing to answer is rejected with the PARENT's remedy", () => {
    const decision = decideQuestion("active", null);
    assert.strictEqual(decision.action, "reject");
    assert.ok(decision.reason.startsWith("task_continue"), `leads with what the reader can do. got: ${decision.reason}`);
    assert.ok(!decision.reason.includes("task_notify"), `never points at a child-only tool. got: ${decision.reason}`);
    assert.ok(!/when it resumes/.test(decision.reason), `never tells anyone to wait. got: ${decision.reason}`);
  });

  // The claim line is truncated to 120 chars. A reason that puts its instruction
  // last is a reason the operator never reads in full, which is the defect the
  // composition exists to prevent — asserted against the real formatter.
  it("a rejected reason survives the status view's truncation, remedy intact", () => {
    const reason = decideQuestion("active", null).reason;
    const shown = truncateText(reason, 120);
    assert.match(shown, /task_continue the child with the input it needs/);
  });

  it("a settled child is rejected with settled guidance, answer or not", () => {
    for (const answer of ["yes", null]) {
      const decision = decideQuestion("retained", answer);
      assert.strictEqual(decision.action, "reject");
      assert.ok(decision.reason.includes("settled"));
    }
  });
});

describe("task store: retained-change callback", () => {

  function seedActive(store, id) {
    registerActiveTask(store, childParams({ id: id }), config);
  }

  it("notifies on retained writes, silent on active-only writes", () => {
    const { store, changes } = countingStore();
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

// The fleet list is a tree, so a row carries its depth and — when the parent
// that spawned it is no longer tracked — the link it lost. Both are decided
// here, at the formatter, so they are pinned here.
describe("task formatting: fleet views", () => {
  const treeRow = (over = {}) => ({
    childSessionId: "ses_a", agentName: "explore", description: "A task", state: "active",
    startedAt: Date.now() - 45_000, depth: 0, parentSessionId: "p1", parentTracked: true, ...over,
  });
  const rowFor = (summary, sessionId) =>
    summary.split("\n").find((line) => line.includes(sessionId)) ?? `(no line for ${sessionId})`;
  const listOf = (over = {}) => formatTaskListSummary({ tree: [], activeCount: 0, retained: [], maxConcurrent: 4, pruned: 0, ...over });
  // The detail view's own seam, so a case states the record it is about and the
  // words it expects rather than the renderer's two arguments. `listOf` is the
  // same seam for the fleet view; a case that spelled either one out was writing
  // the fixture again.
  const detailOf = (over = {}, notification = null) => formatTaskStatusDetail(taskRecord(over), notification);
  /** The words a rendered block has to carry — the claim every case below is a list of. */
  const renders = (text, words) => {
    for (const word of words) assert.ok(text.includes(word), `${word} must be rendered. got: ${text}`);
  };

  it("formatTaskListSummary counts the running rows and indents the tree", () => {
    const now = Date.now();
    const summary = listOf({
      tree: [
        treeRow({ startedAt: now - 45_000 }),
        treeRow({ childSessionId: "ses_b", depth: 1, parentSessionId: "ses_a", startedAt: now - 5000 }),
      ],
      activeCount: 2,
      retained: [{
        childSessionId: "ses_r", agentName: "reviewer", description: "R task",
        state: "completed", startedAt: now - 5000,
      }],
    });
    assert.ok(summary.includes("Active: 2/4"), `got: ${summary}`);
    assert.ok(summary.includes("45s"), `ages render. got: ${summary}`);
    assert.ok(summary.includes("ses_r"), `history still listed. got: ${summary}`);
    assert.match(rowFor(summary, "ses_a"), /^- /, `a root sits flush. got: ${summary}`);
    assert.match(rowFor(summary, "ses_b"), /^ {2}- /, `a descendant is indented. got: ${summary}`);
  });

  // Rendered flush it would read as a root, and a root is a task whose parent
  // nobody has stopped.
  it("a row whose parent is not tracked names the link it lost", () => {
    const summary = listOf({ tree: [treeRow({ parentTracked: false, parentSessionId: "ses_gone" })], activeCount: 1 });
    assert.match(rowFor(summary, "ses_a"), /spawned by ses_gone, not tracked/, `got: ${summary}`);
  });

  it("formatTaskListSummary names empty states", () => {
    assert.ok(listOf().includes("(none)"));
  });

  it("formatTaskStatusDetail warns on a stalled active turn, stays factual on fresh ones", () => {
    const base = taskRecord();
    const stale = detailOf({ ...base, startedAt: Date.now() - 20 * 60 * 1000 });
    assert.match(stale, /Last plugin event: 20m ago/);
    assert.match(stale, /stalled/);
    assert.match(stale, /task_interrupt/);
    const fresh = detailOf({ ...base, startedAt: Date.now() });
    assert.match(fresh, /Last plugin event:/);
    assert.ok(!fresh.includes("stalled"), `fresh turns carry no warning. got: ${fresh}`);
  });

  it("formatTaskStatusDetail reads activity from observed events, not from the spawn", () => {
    const base = taskRecord();
    // 20m since spawn, an event 2s ago: the child is demonstrably working, so
    // the stall line is a false alarm and must not render.
    const working = detailOf({ ...base, startedAt: Date.now() - 20 * 60 * 1000, lastActivityAt: Date.now() - 2000 });
    assert.match(working, /Last plugin event: 2s ago/);
    assert.ok(!working.includes("stalled"), `observed activity suppresses the stall line. got: ${working}`);
    // No heartbeat yet (plugin booted after the spawn): the spawn stays the
    // honest floor and the silence stays visible.
    const unheard = detailOf({ ...base, startedAt: Date.now() - 20 * 60 * 1000 });
    assert.match(unheard, /Last plugin event: 20m ago/);
    assert.match(unheard, /stalled/);
  });

  it("formatTaskListSummary names pruned expiries when told", () => {
    assert.ok(listOf({ pruned: 1 }).includes("Pruned: 1 expired"), "the expiry is reported");
    assert.ok(!listOf({ pruned: 0 }).includes("Pruned:"), "silence when nothing expired");
  });

  it("formatTaskStatusDetail renders tracked metadata offline", () => {
    const detail = detailOf({
      description: "Deep dive",
      lineage: ["planner"],
      startedAt: 1,
      requestedModel: { providerID: "prov", modelID: "model" },
      dependsOn: ["ses_dep"],
      lastNotice: { message: "blocked on credentials", at: Date.now() },
    });
    renders(detail, ["ses_1", "planner", "prov/model", "ses_dep", "blocked on credentials"]);
  });

  it("formatTaskStatusDetail surfaces delivery records", () => {
    const detail = detailOf(
      { state: "completed", startedAt: 1, retainedAt: 2 },
      { kind: "error", delivered: false, attempts: 2 },
    );
    renders(detail, ["FAILED"]);
  });
});

describe("task-state: restoreRetained", () => {

  function ledgerEntry(id, state = "completed") {
    return {
      childSessionId: id, parentSessionId: "p", agentName: "a",
      description: "d", lineage: [], state,
      startedAt: 1, retainedAt: 2,
    };
  }

  it("restores unknown ids and skips live state", () => {
    const store = storeWithActive();
    const restored = restoreRetained(store, [
      ["ses_ledger", ledgerEntry("ses_ledger")],
      ["ses_active", ledgerEntry("ses_active")],
    ]);
    assert.strictEqual(restored, 1);
    assert.ok(store.retainedTasks.has("ses_ledger"));
    assert.ok(store.activeTasks.has("ses_active"), "live state wins");
  });

  it("returns zero for empty input", () => {
    assertIs(restoreRetained(createTaskStore(), []), 0, "a store with nothing retained restores nothing");
  });
});

describe("task-state: concurrency helper", () => {
  const config = normalizeDynamicTaskConfig({ maxConcurrent: 2 });

  it("returns null when under limit", () => {
    assertNothing(checkConcurrencyLimit(1, config), "a free slot is reported as no error at all");
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

  // Retention prunes on `retainedAt`, so an age IS the fixture, and every record
  // in a store must be aged against the same clock the prune will read. Stated
  // once, through the shared record shape: a hand-written record here could omit
  // `state` and then be asserting about pruning something that was never settled.
  const storeAged = (...agesById) => {
    const store = createTaskStore();
    const now = Date.now();
    for (const [id, age] of agesById) {
      store.retainedTasks.set(id, retainedEntry({ childSessionId: id, retainedAt: now - age }));
    }
    return store;
  };

  it("removes expired retained tasks by TTL", () => {
    const store = storeAged(["ses_old", 100000]);
    assert.strictEqual(pruneRetainedTasks(store, config), 1, "Should prune 1 expired entry");
    assertStoreEmpty(store, "only the expired entry was pruned");
  });

  // max is 2, all three within the TTL window — so only the max can prune here.
  it("evicts oldest entries when over max", () => {
    const store = storeAged(["ses_a", 5], ["ses_b", 3], ["ses_c", 0]);
    assert.strictEqual(pruneRetainedTasks(store, config), 1, "Should evict 1 oldest entry");
    assert.strictEqual(store.retainedTasks.size, 2);
    assert.ok(!store.retainedTasks.has("ses_a"), "the oldest entry is the one that goes");
  });

  it("prunes nothing when under limits", () => {
    const store = storeAged(["ses_1", 0]);
    assert.strictEqual(pruneRetainedTasks(store, config), 0);
    assert.strictEqual(store.retainedTasks.size, 1);
  });
});

describe("findTask — edge cases", () => {
  it("returns null for unknown session ID", () => {
    const store = createTaskStore();
    assertNothing(findTask(store, "nonexistent"), "an unknown session is not a task");
  });

  it("finds active task before retained task", () => {
    const store = createTaskStore();
    registerActiveTask(store, childParams({ id: "ses_dup", description: "t" }), normalizeDynamicTaskConfig({}));
    // Same key in both maps — should not happen in practice — and while the task
    // runs, the running record is the truth.
    store.retainedTasks.set("ses_dup", retainedEntry({ childSessionId: "ses_dup", description: "t" }));

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

