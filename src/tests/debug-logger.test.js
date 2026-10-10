/**
 * debug-logger.ts — what may be written down, and where.
 *
 * A debug log is a file on disk that an operator reads after the fact, so the
 * contract is two-sided: the blocked fields must never reach it, and everything
 * that does must be there. The blocklist is read at CALL time, not at boot, so
 * the cases that change it say so — a fixture that set it before boot would be
 * asserting against a value nothing reads.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { debugLog, getDebugLogPath, LOG_CAP_BYTES, safeDebugPayload } from "../../dist/debug-logger.js";
import { SESSION_IDLE } from "../../dist/shared/host-events.js";
import { afterEach, assert, beforeEach, describe, it, withEnv } from "./support/index.js";

describe("safeDebugPayload", () => {
  it("keeps event metadata but removes blocked fields (prompt, fullPrompt)", () => {
    const payload = safeDebugPayload({
      eventType: SESSION_IDLE,
      latestText: "done",
      prompt: "x".repeat(5000),
    });
    assert.strictEqual(payload.eventType, SESSION_IDLE);
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
    const result = safeDebugPayload({ latestText: "done", prompt: "x", token: "secret" });
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

  it("handles null/undefined payloads", () => {
    assert.deepStrictEqual(safeDebugPayload(null), {});
    assert.deepStrictEqual(safeDebugPayload(undefined), {});
  });
});

describe("getDebugLogPath", () => {
  it("creates a stable per-parent-child path", () => {
    const logPath = getDebugLogPath("parent_1", "child_2");
    assert.match(logPath, /parent-parent_1__child-child_2\.log$/);
  });

  it("sanitizes session IDs to prevent path traversal", () => {
    const path = getDebugLogPath("../etc", "../../passwd");
    assert.ok(!path.includes(".."), "Path must not contain parent directory references");
    assert.match(path, /etc/);
    assert.match(path, /passwd/);
  });
});

describe("debugLog — closed to 100% coverage", () => {
  // The log directory, derived from the writer's own path helper rather than spelled
  // out: this suite never boots the plugin, so the debug root is the default relative
  // one, and hardcoding it here is a second declaration of a path production creates.
  const LOG_DIR = dirname(getDebugLogPath("p", "c"));

  beforeEach(() => {
    // Clean up any logs from previous runs
    try { rmSync(LOG_DIR, { force: true, recursive: true }); } catch { /* ok */ }
    process.env.DYNAMIC_TASK_DEBUG = "1";
  });

  afterEach(() => {
    delete process.env.DYNAMIC_TASK_DEBUG;
    try { rmSync(LOG_DIR, { force: true, recursive: true }); } catch { /* ok */ }
  });

  it("writes a log file when DYNAMIC_TASK_DEBUG=1", () => {
    debugLog("parent_1", "child_1", "test-event", { key: "value" });

    const logPath = getDebugLogPath("parent_1", "child_1");
    assert.ok(existsSync(logPath), `Log not found at ${logPath}`);
    const content = readFileSync(logPath, "utf8");
    assert.match(content, /test-event/);
    assert.match(content, /"key":"value"/);
  });

  it("keeps the most recent lines once a log passes the cap", () => {
    const logPath = getDebugLogPath("parent_cap", "child_cap");
    // Enough lines to pass the cap several times over.
    for (let i = 0; i < 30_000; i += 1) {
      debugLog("parent_cap", "child_cap", `event-${i}`, { i });
    }
    const content = readFileSync(logPath, "utf8");
    assert.ok(
      content.length <= LOG_CAP_BYTES + 200,
      `the log must stay near the cap, was ${content.length} bytes`,
    );
    assert.match(content, /"eventName":"event-29999"/, "the most recent lines are the ones kept");
    assert.doesNotMatch(content, /"eventName":"event-0"/, "the oldest lines are the ones dropped");
  });

  it("logs nothing when DYNAMIC_TASK_DEBUG is not 1", () => {
    delete process.env.DYNAMIC_TASK_DEBUG;
    debugLog("parent_2", "child_2", "silent-event", { data: "should not appear" });

    const logPath = getDebugLogPath("parent_2", "child_2");
    assert.ok(!existsSync(logPath), "Log should NOT exist when debug is off");
  });
});
