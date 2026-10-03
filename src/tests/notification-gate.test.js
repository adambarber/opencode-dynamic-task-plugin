/**
 * The notification gate's honesty under conditions it cannot see: a parent owed
 * the same notice twice, a write the gate declined, a write that answers late
 * and wrongly, and a queue that has to stop growing.
 *
 * Every case here is a way a parent is told nothing while the plugin's own
 * records say it was told, which is the only failure this plugin must not have.
 */

import { opaqueHost } from "./support/opaque-host.js";
import {
  afterEach,
  assert,
  beforeEach,
  bounded,
  deferred,
  describe,
  isolatedGate,
  settled,
  it,
  PARENT,
  recordingClient,
  refuseDispatch,
  setupHarness,
} from "./support/index.js";
import { getLatestNotification, getPendingDeliveries, notifyParent } from "../../dist/shared/notify.js";
import { missingSessionError } from "./support/sdk-contract.js";
// The host's own not-found name, read from production rather than retyped: a literal
// here would pass on a day the host renames it and fail on no day at all.

const NO_SLEEP = async () => {};
/** The gate's inputs with no real backoff — the retry count is never under test here. */
const gate = (childSessionId, kind, extra = {}) => ({
  childSessionId,
  kind,
  sleep: NO_SLEEP,
  ...extra,
});

describe("a parent owed the same notice twice", () => {
  let h;

  beforeEach(async () => {
    h = await setupHarness();
  });

  afterEach(() => {
    h = undefined;
  });

  it("releases the wait of EVERY parent that is holding it", async () => {
    const edge = await h.spawn({ description: "edge work" });
    await refuseDispatch(h, "downstream A", [edge.id], undefined);
    // The second waiter is a DIFFERENT session asking about the same edge, so
    // its refusal is asserted too: a fixture that quietly dispatched would leave
    // this case testing a wait that was never held.
    const second = await h.trySpawn(
      { description: "downstream B", prompt: "go", subagent_type: "general", depends_on: [edge.id] },
      { sessionID: "p2" },
    );
    assert.match(second, /Dependencies pending/, "the second parent is holding a wait of its own");

    await h.settle(edge.id);
    await new Promise((resolve) => setTimeout(resolve, 40));

    const heard = h.notices().filter((n) => n.message.includes("can go now"));
    const parents = heard.map((n) => n.to).sort();
    assert.deepStrictEqual(
      parents,
      ["p1", "p2"],
      `both waiting parents hear their dispatch can go. got: ${JSON.stringify(h.noticeBodies())}`,
    );
  });
});

describe("a write the gate declined", () => {
  const world = isolatedGate();

  it("gives its key back, so a LATER obligation for the same child is still writable", async () => {
    const child = "ses_refused";
    world.setStatus(PARENT, "open");
    await notifyParent(opaqueHost(world.client), PARENT, "owed from an earlier boot", gate(child, "completed", { carriedAttempts: 1 }));
    assert.strictEqual(world.calls.length, 0, "a mid-turn parent is not dialed at all");

    // The parent goes idle, and a NEW obligation for this same child arises.
    world.setStatus(PARENT, "succeeded");
    const delivered = await notifyParent(opaqueHost(world.client), PARENT, "a different obligation", gate(child, "completed"));

    assert.strictEqual(delivered, true, "the second obligation is written");
    assert.deepStrictEqual(
      world.calls.map((call) => call.text),
      ["a different obligation"],
      "and the refused one never became a write",
    );
  });
});

describe("a write that answers late", () => {
  it("is billed ONE attempt when the host fails it after the bound has passed", async () => {
    const child = "ses_late";
    const late = deferred();
    const lateWorld = recordingClient(() => late.promise);

    const delivered = await bounded(5, () =>
      notifyParent(opaqueHost(lateWorld.client), PARENT, "owed", gate(child, "error")),
    );
    assert.strictEqual(delivered, false, "the bound gave up before the host answered");

    late.reject(new Error("host finally answered, badly"));
    await settled();

    const record = getLatestNotification(child);
    assert.strictEqual(record.delivered, false, "and the late failure is not a delivery");
    assert.strictEqual(record.attempts, 1, "one write was attempted, so one attempt is billed");
  });

  it("is not a delivery when the host answers with a REFUSAL envelope", async () => {
    const child = "ses_refused_envelope";
    // v2 has no error envelope: a refusal is a rejection carrying the ClientError
    // shape, and the 404 is what distinguishes "no such session" from a transport
    // fault. A fixture that resolved instead of rejecting would test nothing.
    const refusing = recordingClient(async () => {
      throw missingSessionError();
    });

    const delivered = await notifyParent(opaqueHost(refusing.client), PARENT, "owed", gate(child, "completed"));

    assert.strictEqual(delivered, false, "a host that says no is not a delivery");
    assert.strictEqual(getLatestNotification(child).delivered, false, "and the record says so");
    assert.strictEqual(
      getLatestNotification(child).attempts,
      2,
      "one attempt is billed per dial, and the refusal is retried once",
    );
  });
});

describe("the queue of undelivered debts", () => {
  const world = isolatedGate({ status: "open" });

  it("stops growing, and the newest debt is the one it keeps", async () => {
    const offered = 260;
    for (let i = 0; i < offered; i++) {
      await notifyParent(opaqueHost(world.client), PARENT, `owed ${i}`, gate(`ses_child_${i}`, "completed", { carriedAttempts: 1 }));
    }

    const owed = getPendingDeliveries();
    assert.ok(
      owed.length < offered,
      `an undeliverable queue is bounded rather than growing one debt per debt. got ${owed.length} of ${offered}`,
    );
    assert.ok(
      owed.some((entry) => entry.childSessionId === `ses_child_${offered - 1}`),
      "a fresh debt is not evicted to make room for another fresh debt",
    );
  });
});
