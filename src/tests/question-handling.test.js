/**
 * question-handling.ts — a child's question, and the one channel out of it.
 *
 * The host publishes `question.asked`; the gate reads it, decides reply or
 * reject, and settles the question exactly once. Both halves are here because
 * the decision is only correct against the host's real payload: a fixture
 * invented to match the code certifies the code, not the host.
 */

import { describe, it, assert } from "./support/runner.js";
import {
  decideAsk,
  denyAsk,
} from "../../dist/shared/question-handling.js";
import { opaqueHost } from "./support/opaque-host.js";
import { PERMISSION_ASKED, readHostAsk } from "../../dist/shared/host-events.js";
import { truncateText } from "../../dist/shared/notify.js";
import { NOTIFY_TOOL } from "../../dist/shared/notification-text.js";
import { assertIs, assertNothing } from "./support/assertions.js";

// One verb survives the v2 rename: the gate DENIES. `permission.reply` takes a
// decision ("once" | "always" | "reject"), so there is no answer to send and no
// separate reject call — one call, one decision.
describe("question gate: denial", () => {
  const okClient = () => opaqueHost({ permission: { reply: async () => {} } });

  // One hypothesis: what denyAsk's outcome IS, given how the transport behaved.
  // Only the "already resolved" throw is absorbed — any other failure is the
  // caller-s problem to see, reported against the ask it failed on.
  const outcomes = [
    ["denial succeeds", async () => {}, { succeeded: true }],
    ["denial absorbs already-resolved as success",
      async () => { throw new Error("already resolved"); },
      { succeeded: true, reason: "already_resolved" }],
    ["denial reports transport failures",
      async () => { throw new Error("nope"); },
      { succeeded: false, reason: "q1: nope" }],
    ["denial absorbs a 409 conflict",
      async () => { const e = new Error("gone"); e.status = 409; throw e; },
      { succeeded: true, reason: "already_resolved" }],
  ];
  for (const [name, reply, expected] of outcomes) {
    it(name, async () => {
      assert.deepStrictEqual(await denyAsk(opaqueHost({ permission: { reply } }), "ses_child", "q1"), expected);
    });
  }

  it("refuses an ask with no id or no session, without dialling", async () => {
    assertIs((await denyAsk(okClient(), "ses_child", "")).succeeded, false, "no ask id");
    assertIs((await denyAsk(okClient(), "", "q1")).succeeded, false, "no session id");
  });

  // The permission domain is a load-bearing premise, and a premise that is
  // load-bearing at runtime has to be probed. Probed per CALL, and reported as a
  // refusal rather than thrown — without this, a host that lacks the domain fails
  // inside an event handler, where nothing can report it.
  it("a host without permission.reply is refused, naming the call it lacks", async () => {
    for (const client of [{ permission: {} }, {}, { session: {} }]) {
      assert.deepStrictEqual(
        await denyAsk(opaqueHost(client), "ses_child", "q1"),
        { succeeded: false, reason: "this host's context has no permission.reply" },
        "a client without permission.reply must be a refusal, not a crash",
      );
    }
  });
});

// The host-s payload, in the host's shape. v2 ask is allow/deny: there are no
// options and no labels to read, so the only thing an ask has to carry for the gate
// to act is the pair of ids a reply quotes back.
describe("question handling: the asked payload", () => {
  const asked = (data) => ({ type: PERMISSION_ASKED, data });

  it("a one-part ask yields the id pair a denial needs", () => {
    const read = readHostAsk(asked({ id: "q1", sessionID: "ses_child" }));
    assert.deepStrictEqual(read, { askId: "q1", sessionId: "ses_child" }, "the pair, read whole");
  });

  // Both ids are load-bearing: a reply carries both, so an ask missing either
  // leaves a denial that cannot be addressed. Refusing to read it is what keeps
  // the question open instead of resolving it as nobody-s.
  it("refuses a payload missing the ask id or the session id", () => {
    assertNothing(readHostAsk(asked({ sessionID: "ses_child" })), "an ask with no request id");
    assertNothing(readHostAsk(asked({ id: "q6" })), "an ask with no session");
    assertNothing(readHostAsk(asked({})), "an ask with neither");
  });

  // The plugin reads the event the host published, not an SDK-resolved response:
  // only the client wraps. A gate that accepted both would be guessing which one
  // it holds, and the bare read of a wrapped event must find nothing and say so.
  it("ignores an envelope-wrapped payload, since the host publishes it bare", () => {
    assertNothing(readHostAsk({ type: PERMISSION_ASKED, data: { info: { id: "q9", sessionID: "ses_child" } } }), "a payload under info");
  });
});

describe("question gate: decideAsk", () => {
  // v2 has no reply-with-the-answer verb on this channel: `permission.reply` takes
  // a DECISION, and the plugin only ever denies. So the answer a child offered is
  // gone, and the reason has to carry everything the parent needs instead.
  it("an active child is denied with the PARENT-s remedy", () => {
    const reason = decideAsk("active");
    assert.ok(reason.startsWith("task_continue"), `leads with what the reader can do. got: ${reason}`);
    assert.ok(!reason.includes(NOTIFY_TOOL), `never points at a child-only tool. got: ${reason}`);
    assert.ok(!/when it resumes/.test(reason), `never tells anyone to wait. got: ${reason}`);
  });

  // The claim line is truncated to 120 chars. A reason that puts its instruction
  // last is a reason the operator never reads in full, which is the defect the
  // composition exists to prevent — asserted against the real formatter.
  it("a denied reason survives the status view-s truncation, remedy intact", () => {
    const shown = truncateText(decideAsk("active"), 120);
    assert.match(shown, /task_continue the child with the input it needs/);
  });

  it("a settled child is denied with settled guidance", () => {
    assert.ok(decideAsk("retained").includes("settled"));
  });

  it("states the consequence, because a refused question settles the turn", () => {
    assert.match(decideAsk("active"), /settles as blocked, not as a success/);
  });
});

