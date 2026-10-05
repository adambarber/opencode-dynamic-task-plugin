/**
 * The host's session boundary, read from every side.
 *
 * The readers that take an event, an SDK result or a sync envelope and answer a
 * session id, a status word, or a payload. These were one describe among sixty in
 * a single grab-bag file, which is the only reason a reader had to hold the whole
 * plugin's contract in mind to check one function.
 *
 * The subject spans three owners now, and each import below names which one it is
 * testing: the readers in host-events.ts, the ledger in task-ledger.ts, and the
 * parentage this file is named after in session-lifecycle.ts.
 */

// The host's event vocabulary, named by the module that owns it. A test firing a
// hardcoded event name is asserting against a name it invented: rename the host
// event and the case keeps firing something the plugin correctly ignores.
import { SESSION_DELETED, SESSION_ERROR, SESSION_IDLE, getEventLifecycleStatus, getSessionIdFromEvent, hostPayload, isTerminalSessionEvent, normalizeStatus } from "../../dist/shared/host-events.js";
import { assert, describe, it } from "./support/runner.js";
import { assertAbsent, assertEmpty, assertIs, assertNothing } from "./support/assertions.js";
import { resolveParentSessionId, validateSessionResult } from "../../dist/shared/session-lifecycle.js";
import { sessionUpdatedEnvelope } from "./support/mock-host.js";
import { withEnv } from "./support/harness.js";

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
    const event = { data: { sessionID: "ses_123" } };
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
      getEventLifecycleStatus({ data: { status: { type: "completed" } } }),
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
    ["a session.error event with no status field", { data: { error: { data: { message: "Too Many Requests" }, name: "APIError" }, sessionID: "s1" }, type: SESSION_ERROR }, "error"],
    ["a failure event carrying only a session id", { data: { sessionID: "s1" }, type: SESSION_ERROR }, "error"],
    ["a non-error event still reads its own status", { data: { sessionID: "s1", status: "idle" }, type: SESSION_IDLE }, "idle"],
  ]) {
    it(`${JSON.stringify(why)} reads as ${JSON.stringify(expected) || "(nothing)"}`, () => {
      assertIs(getEventLifecycleStatus(event), expected, why);
    });
  }
});

// One hypothesis, one arrangement: which event SHAPES end a turn. Each case
// keeps its own name because the shape is what a reader needs to see.
describe("isTerminalSessionEvent", () => {
  const shapes = [
    ["treats sync session.updated idle as terminal", sessionUpdatedEnvelope("idle"), true],
    ["treats sync session.updated error as terminal", sessionUpdatedEnvelope({ type: "error" }), true],
    ["treats a bare deletion as terminal", {
      data: { sessionID: "s1" },
      type: SESSION_DELETED,
    }, true],
    ["treats session.idle event as terminal", { type: SESSION_IDLE }, true],
    ["treats session.error event as terminal", { type: SESSION_ERROR }, true],
    ["does not treat an ordinary session event as terminal", { data: { sessionID: "ses_x" }, type: "message.updated" }, false],
  ];
  for (const [name, event, expected] of shapes) {
    it(name, () => {
      assert.strictEqual(isTerminalSessionEvent(event), expected);
    });
  }

  it("matches the broad catch-all", () => {
    assert.strictEqual(
      isTerminalSessionEvent({ data: { sessionID: "s1", status: "idle" }, type: "session.custom" }),
      true
    );
  });
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
