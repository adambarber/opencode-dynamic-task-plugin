import assert from "node:assert";
import { createMockClient, FAKE_SOURCE } from "./support/mock-host.js";
import { sleep } from "./support/harness.js";
import { ARMERS, FAULTS, unengagedFaults } from "./support/faults.js";
import { describe, it } from "./support/runner.js";

/**
 * The fake host is a CLAIM about the host, and nothing used to check it. That is
 * not a theoretical gap: the cases in hostile-host.test.js armed a silent host,
 * the fake never went silent, and they all passed — the seam failed in the
 * direction that makes tests easier, so the green run was the symptom.
 *
 * The SHAPE half — does the fake answer every call production makes — lives in
 * host-calls.test.js beside the boundedness gate, because both read one
 * enumeration of call sites and neither claim means much apart from the other.
 *
 * This file is the ENGAGEMENT half: a fault that is armed must be provably applied.
 * Arming is a request to the fake, the witness is the fake's answer, and it is what
 * separates "the host was hostile" from "the fake was indifferent". The rule that
 * an armed fault may not go unapplied lives in the harness teardown so no test can
 * forget it — this suite is what proves the accounting itself works.
 */
describe("invariant: the fake host engages the fault it was asked for", () => {
  it("names every fault it declares somewhere in the fake, because a witness has one writer", () => {
    // The FORM of the writing is deliberately not pinned. A fault may record through
    // `fault(state, name)` or through the `forId` funnel, and the funnel moved six
    // faults at once without any of them losing a witness. Pinning the spelling would
    // pin the arrangement; what must hold is that a declared fault is spoken in the
    // fake at all, because a name that lives only in the registry is a fault no branch
    // can ever record.
    const source = FAKE_SOURCE;
    const unwitnessed = FAULTS.filter((name) => !source.includes(`"${name}"`));

    assert.deepStrictEqual(unwitnessed, [], "these faults are declared but no branch names them");
  });

  it("names every fault a test can arm, so no armer skips the accounting", () => {
    const unknown = Object.values(ARMERS).filter((fault) => !FAULTS.includes(fault));

    assert.deepStrictEqual(unknown, [], "an armer points at a fault that is not declared");
  });

  it("reports nothing fired against a host that is answering, so a witness means something", async () => {
    const client = createMockClient({});
    await client.app.agents();
    await client.session.status();

    assert.deepStrictEqual(Object.fromEntries(client._state.faults), {});
  });

  it("counts a fault once per application, so a witness cannot be satisfied by one call for many", async () => {
    const client = createMockClient({ silentHost: true });
    const swallowed = [];
    client.app.agents().then(() => swallowed.push("a"));
    client.session.status().then(() => swallowed.push("b"));
    await sleep(20);

    assert.strictEqual(client._state.faults.get("silentHost"), 2, "one count per swallowed call");
    assert.deepStrictEqual(swallowed, [], "a silent host answers nothing");
  });

  it("reports an armed fault that never fired, which is what a passing case about nothing looks like", async () => {
    const client = createMockClient({ statusHang: true });

    assert.deepStrictEqual(unengagedFaults(client._state), ["statusHang"], "armed, never engaged");

    client.silenceHost();
    client.app.agents();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepStrictEqual(unengagedFaults(client._state), ["statusHang"], "the silent host engaged");
  });
});