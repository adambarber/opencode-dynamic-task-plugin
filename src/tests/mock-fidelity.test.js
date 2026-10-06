//jscpd:ignore-start
import assert from "node:assert";

import { ARMERS, FAULTS, unengagedFaults } from "./support/faults.js";
import { createMockClient, setHostTurn } from "./support/mock-host.js";
import { describe, it } from "./support/runner.js";
import { listFakeModules, listTestSupportFiles, readSource } from "./support/corpus.js";
import { hostOutcomeWords } from "./support/sdk-contract.js";
import { sleep } from "./support/harness.js";

//jscpd:ignore-end
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
    const source = listFakeModules()
      .map((file) => readSource(file).text)
      .join("\n");
    const unwitnessed = FAULTS.filter((name) => !source.includes(`"${name}"`));

    assert.deepStrictEqual(unwitnessed, [], "these faults are declared but no branch names them");
  });

  it("names every fault a test can arm, so no armer skips the accounting", () => {
    const unknown = Object.values(ARMERS).filter((fault) => !FAULTS.includes(fault));

    assert.deepStrictEqual(unknown, [], "an armer points at a fault that is not declared");
  });

  it("reports nothing fired against a host that is answering, so a witness means something", async () => {
    const client = createMockClient({});
    await client.agent.list();
    const made = await client.session.create({ title: "probe" });
    await client.session.context({ sessionID: made.id });

    assert.deepStrictEqual(Object.fromEntries(client.testState.faults), {});
  });

  it("counts a fault once per application, so a witness cannot be satisfied by one call for many", async () => {
    const client = createMockClient({ silentHost: true });
    const swallowed = [];
    client.agent.list().then(() => swallowed.push("a"));
    client.session.create({ title: "probe" }).then(() => swallowed.push("b"));
    await sleep(20);

    assert.strictEqual(client.testState.faults.get("silentHost"), 2, "one count per swallowed call");
    assert.deepStrictEqual(swallowed, [], "a silent host answers nothing");
  });

  it("reports an armed fault that never fired, which is what a passing case about nothing looks like", async () => {
    const client = createMockClient({ presenceHang: true });

    assert.deepStrictEqual(unengagedFaults(client.testState), ["presenceHang"], "armed, never engaged");

    client.silenceHost();
    client.agent.list();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepStrictEqual(unengagedFaults(client.testState), ["presenceHang"], "the silent host engaged");
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
 * v2 deleted the status channel a plugin could read, so this whole file's subject is
 * gone and its replacement is the transcript: a turn is an assistant message with no
 * `completed`. The gate is therefore restated as what the record can actually hold —
 * one word, two states — because a fake able to say a third thing is still a fake
 * inventing vocabulary, and inventing vocabulary is how a gate certifies a host that
 * does not exist.
 */
describe("invariant: only the host's own words can describe a turn", () => {
  // Both cases start from the same empty turn record and differ only in the
  // word they write through the funnel.
  const emptyTurnState = () => ({ transcripts: new Map(), turns: new Map() });

  it("refuses a word the host does not declare, through the one funnel every write uses", () => {
    const state = emptyTurnState();

    assert.throws(
      () => setHostTurn(state, "ses_x", "compacting"),
      /is not a v2 turn state/,
      `a fake may not describe a turn with a word the host lacks. declared: open, ${hostOutcomeWords().join(", ")}`,
    );
    assert.strictEqual(state.transcripts.size, 0, "and the refusal left nothing behind");
  });

  it("describes an open turn by no verdict and a settled one by a completed one", () => {
    const state = emptyTurnState();

    setHostTurn(state, "ses_x", "open");
    assert.strictEqual(state.turns.get("ses_x").outcome, undefined, "a turn with no verdict is a turn still open");

    setHostTurn(state, "ses_x", "succeeded");
    assert.strictEqual(state.turns.get("ses_x").outcome, "succeeded", "the verdict the turn ended with is the one production reads");
    const last = state.transcripts.get("ses_x").at(-1);
    assert.notStrictEqual(last.time?.completed, undefined, "and the message it was writing is finished");
  });

  it("finds no fake holding a turn word anywhere but that one funnel", () => {
    // Found by reading the support modules as the subject rather than trusting a registry
    // of them: a registry is a list someone has to remember to add to, and the whole
    // failure here was a fake nobody had listed anywhere. A private status map is the
    // thing this catches, because it is a SECOND copy of the fact production reads.
    const secondCopies = listTestSupportFiles()
      .map(readSource)
      .filter((source) => /hostStatus\.set\(|statusMap\.set\(/.test(source.text))
      .map((source) => source.file);

    assert.deepStrictEqual(secondCopies, [], "these fakes keep a second copy of the turn instead of writing the transcript");
  });
});