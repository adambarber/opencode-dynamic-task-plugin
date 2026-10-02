import assert from "node:assert";

import { createMockClient, FAKE_SOURCE, putHostStatus } from "./support/mock-host.js";
import { listTestSupportFiles, readSource } from "./support/corpus.js";
import { busyWord, hostStatusWords, idleWord } from "./support/sdk-contract.js";
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

/**
 * The half of fidelity that is about VOCABULARY rather than shape: may a fake put a
 * word in the host's status map that the host never says?
 *
 * It could not before, and nothing noticed. The word `idle` was the live example —
 * tests published `session.status idle` and the fake STORED it, while the real host
 * publishes `idle` and deletes the key. A fake that can hold a word the host cannot
 * say is not a smaller claim about the host, it is a different host: absence from the
 * map stopped meaning "nothing running", and every read of absence with it.
 *
 * Two gates, and the pairing is the point. The funnel's own teeth are behavioural
 * (below): an undeclared word is refused and `idle` deletes. The scan beside it is
 * what keeps those teeth load-bearing — a fake that wrote its own map would be a
 * perfectly good test and a lie, and only a scan finds it.
 */
describe("invariant: only the host's own words can go in a fake's status map", () => {
  it("refuses a word the host does not declare, through the one funnel every write uses", () => {
    const map = new Map();

    assert.throws(
      () => putHostStatus(map, "ses_x", "compacting"),
      /is not a host status word/,
      `a fake may not answer with vocabulary the host lacks. declared: ${hostStatusWords().join(", ")}`,
    );
    assert.strictEqual(map.size, 0, "and the refusal left nothing behind");
  });

  it("answers `idle` by DELETING, the way the host's status map does", () => {
    const map = new Map();

    putHostStatus(map, "ses_x", busyWord());
    assert.deepStrictEqual([...map.keys()], ["ses_x"], "a running turn is listed");

    putHostStatus(map, "ses_x", idleWord());
    assert.strictEqual(map.size, 0, "and idle is answered by removing it, never by storing idle");
  });

  it("finds no fake putting a word into a status map any other way", () => {
    // A direct SET, in any spelling: it is the only way a fake can end up holding a word
    // the host never said, or an `idle` entry the real map can never have. A delete is not
    // in scope and cannot be — removing a key cannot invent vocabulary, and two of these
    // are the host's own (a deleted session leaves the map; so does `forgetHostStatus`).
    //
    // Found by reading the support modules as the subject rather than by trusting a
    // registry of them: a registry is a list someone has to remember to add to, and the
    // whole failure here was a fake nobody had listed anywhere.
    const direct = listTestSupportFiles()
      .map(readSource)
      .filter((source) => /hostStatus\.set\(/.test(source.text))
      .map((source) => source.file);

    assert.deepStrictEqual(direct, [], "these fakes write a status word directly instead of through putHostStatus");
  });
});