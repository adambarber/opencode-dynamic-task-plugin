/**
 * What a parent is TOLD, measured against what the plugin OBSERVED.
 *
 * Every case is a real parent misreading from the 2026-09 corpus, reproduced with
 * synthetic text. The plugin's facts are about a TURN; its payload spoke about
 * the JOB, and the gap between the two is where the hours went.
 */

//jscpd:ignore-start
import {
  NOTIFICATION_MAX_CHARS,
  NotifyKind,
  formatParentNotification,
  notificationKindOf,
} from "../../dist/shared/notification-text.js";
import { assert, describe, it } from "./support/index.js";

//jscpd:ignore-end
const CHILD = "ses_child0123456789";
const state = { childSessionId: CHILD, description: "Fix all 4 P0 issues" };
const say = (kind, resultText) => formatParentNotification(state, kind, resultText);

describe("a settlement must not claim the plugin cannot observe", () => {
  it("never says the work is done", () => {
    // The corpus: a turn that ended 46s in was announced "completed successfully".
    const payload = say(NotifyKind.Completed, "");
    assert.ok(!/completed successfully/i.test(payload), "no observation supports a success claim");
    assert.ok(!/\bthe task (is )?(done|complete)/i.test(payload), "a turn ending is not the job finishing");
  });

  it("names the turn, so the parent's read has an object", () => {
    // Every kind, not just a settlement: the fact the gate holds is about a turn,
    // and a kind that said otherwise would be the same misreading in a new costume.
    for (const kind of Object.values(NotifyKind)) {
      assert.ok(/\bturn\b/i.test(say(kind, "child words")), `${kind} must name the turn it observed`);
    }
  });

  it("puts a child utterance where a status name was, and marks it unverified", () => {
    // "Latest output:" invited reading prose as a heartbeat; corpus parents built a
    // five-instance death pattern out of the literal string "(completed)".
    const payload = say(NotifyKind.Completed, "No venv in package root. Let me locate an environment.");
    assert.ok(!/Latest output:/.test(payload), "the status-named field is gone");
    assert.ok(/child/i.test(payload), "the words are attributed to the child");
    assert.ok(/not verified|unverified|claims/i.test(payload), "a child's claim is not a finding");
  });

  it("says where the truth lives, so a settlement is not the last word", () => {
    assert.ok(/task_result/.test(say(NotifyKind.Completed, "")), "the parent needs a reader, not a verdict");
    assert.ok(/task_result/.test(say(NotifyKind.Error, "")), "an error needs one too");
    assert.ok(/task_result/.test(say(NotifyKind.Blocked, "")), "a block names its reader too");
  });
});

describe("a placeholder must not stand where a report should be", () => {
  for (const [label, kind] of [["success", NotifyKind.Completed], ["failure", NotifyKind.Error]]) {
    it(`names the reader when the ${label} settled with no text`, () => {
      const payload = say(kind, "");
      assert.ok(!/\(completed\)/.test(payload), "a bare placeholder reads as content");
      assert.ok(!/\(No text output\)/.test(payload), "so does the other one");
      assert.ok(!/\(error — no detail\)/.test(payload), "and the failure placeholder");
      assert.ok(/task_result/.test(payload), "silence must name the reader instead");
    });
  }

  it("marks a cut preview and names the session to fetch", () => {
    const payload = say(NotifyKind.Completed, "x".repeat(NOTIFICATION_MAX_CHARS * 3));
    assert.ok(/truncated/i.test(payload), "a cut preview must look cut");
    assert.ok(payload.includes(CHILD), "the reader is told which child");
    assert.ok(payload.includes("task_result"), "and where to read it");
  });
});

describe("a parent must be able to classify a notification without reading prose", () => {
  for (const kind of [NotifyKind.Completed, NotifyKind.Error, NotifyKind.Blocked, NotifyKind.Notice]) {
    it(`${kind} declares its own kind`, () => {
      const payload = say(kind, "out");
      assert.ok(payload.includes(`Kind: ${kind}`), "the kind is a field, not a tone");
      assert.strictEqual(notificationKindOf(payload), kind, "and it reads back");
    });
  }

  it("gives no kind for a text that declares none", () => {
    // The falsification the other four depend on: a reader that answered for every
    // text would make them pass while classifying nothing.
    assert.strictEqual(notificationKindOf("a child wrote this, no kind field here"), undefined);
  });
});
