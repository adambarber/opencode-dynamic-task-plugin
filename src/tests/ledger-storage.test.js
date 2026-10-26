/**
 * The durable ledger on the host's own per-key storage.
 *
 * The subject is the real `ledger-storage` module over the real facade and the real
 * store; only the host's storage — a disk boundary — is faked.
 *
 * The claims here are the ones the whole per-key migration rests on. They are not
 * round-trip coverage: the file it replaced was round-tripped to death and still let
 * two processes erase each other's running children (#3078), because the defect was
 * the SHAPE of the write, not the fidelity of the read. So the cases below are about
 * what a write touches, in what order, and what a partial application degrades into.
 */

import { LedgerChangeKind } from "../../dist/shared/ledger-change.js";
import { LEDGER_KEYS } from "../../dist/shared/ledger-storage.js";
import { NotifyKind } from "../../dist/shared/notification-text.js";
import { owedIdentity } from "../../dist/shared/notify-queue.js";
import { TaskState } from "../../dist/shared/task-records.js";
import { assert, describe, durable, it, WORLD_DIRECTORY } from "./support/index.js";

/** A record as the ledger holds it: JSON text, because `Storage.set` has no undefined. */
const stored = (record) => JSON.stringify(record);

/**
 * The project directory these worlds live under — the reader is scoped by one, so
 * the keys a case spells must be the WRITER's keys for THIS directory, taken from
 * the support world rather than spelled, so a fixture cannot address another project.
 */
const DIRECTORY = WORLD_DIRECTORY;

const CHILD = "ses_ledger1";
const OTHER = "ses_ledger2";

/** A record the writer will accept: complete at birth, in the state it is written. */
function active(child = CHILD, state = TaskState.Active) {
  return {
    agentName: "general",
    childSessionId: child,
    description: "a ledger record",
    lineage: [child],
    parentSessionId: "ses_parent",
    startedAt: 1,
    state,
  };
}

function settled(child = CHILD) {
  return { ...active(child, TaskState.Completed), retainedAt: 2 };
}

function owed(text, attempts = 0) {
  return { attempts, childSessionId: CHILD, kind: NotifyKind.Notice, parentSessionId: "ses_parent", text };
}

/** One debt as a host row: the key the writer would use, and the value behind it. */
const debt = (text, owedAt) => [LEDGER_KEYS.pending(DIRECTORY, owedIdentity(owed(text))), stored({ ...owed(text), owedAt })];

/** The change that puts this child in that half — the one move every claim below is about. */
const moveTo = (half) => (half === "settled" ? changes.settled(settled()) : changes.running(active()));

/** A ledger world whose host will not answer a read. */
const heldLedger = () => {
  const world = durable.ledger();
  world.client.holdStorageReads();
  return world;
};

/** Two notices owed for one child: the queue most of the claims below are about. */
const twoOwed = async () => {
  const world = await durable.ledgerAfter(changes.owed(owed("first")), changes.owed(owed("second")));
  return { read: await world.read(), world };
};

const changes = {
  delivered: (record) => ({ kind: LedgerChangeKind.Delivered, record }),
  owed: (record) => ({ kind: LedgerChangeKind.Owed, record }),
  running: (record) => ({ id: record.childSessionId, kind: LedgerChangeKind.Running, record }),
  settled: (record) => ({ id: record.childSessionId, kind: LedgerChangeKind.Settled, record }),
};

describe("durable ledger on host storage", () => {
  it("holds a record under a key that names the CHILD, not a collection", async () => {
    const world = await durable.ledgerAfter(changes.running(active()));

    assert.deepEqual([...world.kv.keys()], [LEDGER_KEYS.active(DIRECTORY, CHILD)]);
  });

  it("restores what it wrote, for both halves", async () => {
    const world = await durable.ledgerAfter(changes.running(active()), changes.settled(settled(OTHER)));
    const read = await world.read();

    assert.equal(read.active.get(CHILD).agentName, "general");
    assert.equal(read.retained.get(OTHER).state, TaskState.Completed);
    assert.equal(read.retained.get(OTHER).retainedAt, 2);
  });

  it("moves a child by PUTTING the new half before dropping the old one, in both directions", async () => {
    const world = await durable.ledgerMoved(changes.running(active()), changes.settled(settled()));

    world.assertHalfGone("active", CHILD, "a settled child must not stay running");
    assert.deepEqual(
      world.client.storageWriteKeys().slice(-2),
      [`set ${LEDGER_KEYS.retained(DIRECTORY, CHILD)}`, `del ${LEDGER_KEYS.active(DIRECTORY, CHILD)}`],
      "the put must land before the drop, so a refused drop leaves the child in both halves",
    );

    await world.persist([moveTo("running")]);
    world.assertHalfGone("retained", CHILD, "a running child must not stay settled");
  });

  it("leaves a child recoverable when the WRITE half of a move is refused", async () => {
    const read = await durable.whileRefused(async () => {
      const { held, world } = await durable.ledgerHeldAfter(changes.running(active()));

      world.ledger.persist([moveTo("settled")]);
      held.release();
      await world.store.settled();

      return world.read();
    });

    assert.equal(read.retained.get(CHILD).state, TaskState.Completed);
  });

  it("keeps two notices for one child as two debts", async () => {
    const { read } = await twoOwed();

    assert.equal(read.pending.length, 2, "two notices for one child are two debts");
    assert.deepEqual(read.pending.map((entry) => entry.text).toSorted(), ["first", "second"]);
  });

  it("settles one debt without settling the other", async () => {
    const { world } = await twoOwed();

    const read = await world.persist([changes.delivered(owed("first"))]);
    assert.deepEqual(read.pending.map((entry) => entry.text), ["second"]);
  });

  it("keeps a retried debt its AGE, so a retry cannot jump the queue", async () => {
    const world = await durable.ledgerAfter(changes.owed(owed("the text", 0)));

    const read = await world.persist([changes.owed(owed("the text", 1))]);
    assert.equal(read.pending[0].attempts, 1, "the attempt is spent");
    assert.equal(world.kv.size, 1, "a retry must not add a second debt");
  });

  it("delivers owed notices oldest first, whatever order the host hands them back", async () => {
    // Seeded directly, with a clock the case owns: the order a queue is paid in must
    // come from the record, not from whichever key the host scanned first.
    const { read } = await durable.ledgerReading(...["newest", "oldest", "middle"].map((text, index) => debt(text, [30, 10, 20][index])));

    assert.deepEqual(read.pending.map((entry) => entry.text), ["oldest", "middle", "newest"]);
  });

  it("orders two notices owed in the SAME millisecond the same way on every boot", async () => {
    const { read, world } = await durable.ledgerReading(debt("b", 7), debt("a", 7));
    const again = await world.read();

    assert.equal(read.pending.length, 2);
    assert.deepEqual(read.pending.map((entry) => entry.text), again.pending.map((entry) => entry.text));
  });

  it("refuses a record filed under ANOTHER child's key rather than restoring it", async () => {
    const { read } = await durable.ledgerReading([LEDGER_KEYS.active(DIRECTORY, OTHER), stored(active(CHILD))]);

    assert.equal(read.active.size, 0, "a record filed under someone else's id is corrupt");
    assert.equal(read.dropped, 1, "and it is counted, so the boot can say so");
  });

  it("resolves a child in both halves to RUNNING, and says it dropped one", async () => {
    const { read } = await durable.ledgerReading(
      [LEDGER_KEYS.active(DIRECTORY, CHILD), stored(active())],
      [LEDGER_KEYS.retained(DIRECTORY, CHILD), stored(settled())],
    );

    assert.equal(read.retained.has(CHILD), false, "the older settled fact must lose");
    assert.equal(read.active.has(CHILD), true);
    assert.equal(read.dropped, 1);
  });

  it("calls an unanswered read PARTIAL, so a boot cannot mistake it for an empty one", async () => {
    await durable.whileRefused(async () =>
      durable.assertNothingAnswered(await heldLedger().read(), (read) => read.active.size, "the ledger reader"));
  });

  it("never writes a key that names a collection, so two processes cannot share one", async () => {
    const world = durable.ledger();
    await world.persist([
      changes.running(active()),
      changes.settled(settled(OTHER)),
      changes.owed(owed("a notice")),
    ]);

    for (const key of world.kv.keys()) {
      assert.ok(key.includes("/"), `a collection key is what the collision was: ${key}`);
      assert.notEqual(key.endsWith("/"), true);
    }
    assert.equal(world.kv.size, 3, "one child, one half, and one notice — three keys");
  });
});
/**
 * What the reader does with a value it cannot vouch for. The file this replaced was
 * round-tripped to death and these were its proudest cases, so retiring its reader
 * without them would have left the migration looking cheaper than it is: the writer
 * changed shape, but a corrupt value still arrives from the host's own disk.
 */
describe("a ledger value the reader cannot vouch for", () => {
  it("drops a field this build does not know, rather than carrying it forward", async () => {
    const { read } = await durable.ledgerReading([
      LEDGER_KEYS.retained(DIRECTORY, CHILD),
      stored({ ...settled(), retiredByTheNextBuild: { at: 1 } }),
    ]);

    const record = read.retained.get(CHILD);
    assert.equal("retiredByTheNextBuild" in record, false, "a field no reader validates must not ride along");
    assert.equal(record.agentName, "general", "and the record it does vouch for still comes back");
  });

  it("refuses a running record missing ONE base field, whole rather than in part", async () => {
    const { startedAt: _absent, ...clockless } = active();
    const { read } = await durable.ledgerReading([LEDGER_KEYS.active(DIRECTORY, CHILD), stored(clockless)]);

    assert.equal(read.active.size, 0, "half a record is not a running child");
    assert.equal(read.dropped, 1, "and the refusal is counted, so the boot can say so");
  });

  it("refuses a notice missing any field, so the queue never holds half a debt", async () => {
    // Each carries the clock, so the only thing that can refuse it is the field its
    // own name says is missing. A fixture refused for a DIFFERENT reason is a test
    // that passes with the guard it names deleted.
    const broken = [
      { ...owed("kept"), owedAt: 1, parentSessionId: "" },
      { ...owed("kept"), owedAt: 2, text: "" },
      { ...owed("kept"), kind: "shout", owedAt: 3 },
      { ...owed("kept"), attempts: "twice", owedAt: 4 },
      { ...owed("kept"), childSessionId: "not-a-session", owedAt: 5 },
    ];
    const { read } = await durable.ledgerReading(
      ...broken.map((record, index) => [LEDGER_KEYS.pending(DIRECTORY, `broken-${index}`), stored(record)]),
      debt("intact", 6),
    );

    assert.deepEqual(read.pending.map((entry) => entry.text), ["intact"], "only the whole debt returns");
    assert.equal(read.dropped, broken.length, "each refusal is counted");
  });

  it("refuses a clock of the wrong SHAPE, in either half", async () => {
    const { read } = await durable.ledgerReading(
      [LEDGER_KEYS.active(DIRECTORY, OTHER), stored({ ...active(OTHER), startedAt: "1" })],
      [LEDGER_KEYS.retained(DIRECTORY, CHILD), stored({ ...settled(), retainedAt: null })],
    );

    assert.equal(read.active.size, 0, "a start that sorts lexically orders nothing");
    assert.equal(read.retained.size, 0, "a settle with no clock cannot be pruned against one");
    assert.equal(read.dropped, 2);
  });

  it("holds the SAME notice owed twice as one debt, not two", async () => {
    const world = await durable.ledgerAfter(changes.owed(owed("settled once")), changes.owed(owed("settled once")));

    const read = await world.read();
    assert.equal(world.kv.size, 1, "the identity is the key, so a re-owes cannot add a second");
    assert.deepEqual(read.pending.map((entry) => entry.text), ["settled once"]);
  });
});
