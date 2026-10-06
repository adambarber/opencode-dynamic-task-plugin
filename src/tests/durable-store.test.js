/**
 * Durable state: the store that writes it and the facade that reads it.
 *
 * Both layers are the real production modules; only the host's storage — a disk
 * boundary — is faked. Every case here is a claim the plugin's whole durability
 * story rests on, and each one is written so that breaking a layer breaks its case.
 *
 * The store and the facade live in ONE file because they are one subsystem: the
 * duplicate gate found two files reproducing each other's arrangement, because a
 * case against either is built from the same world, the same write, and the same
 * refusal. Each case therefore takes a world built for it, from `durable`.
 */

//jscpd:ignore-start
import { assert, describe, it } from "./support/runner.js";
import { durable } from "./support/durable-world.js";

//jscpd:ignore-end
describe("durable store", () => {
  durable.tightBounds();

  it("puts a record where the host can be relied on to have it", async () => {
    const world = durable.build();

    await durable.written(world, "ses_a", { state: "completed" });
    world.assertDurable("ses_a", { state: "completed" });

    world.store.drop(durable.key("ses_a"));
    await world.store.settled();
    world.assertNotHeld("ses_a");
  });


  it("reads past the first page by following the host's cursor", async () => {
    const { sizes, world } = durable.paged(12);

    const found = await durable.loaded(world);

    assert.equal(found.complete, true);
    assert.equal(found.entries.size, 12, "every record must be read, not just the first page");
    assert.ok(sizes.length > 1, "the cursor must actually be followed");
    assert.ok(sizes.every((size) => size <= 5));
  });

  it("reads only its own prefix", async () => {
    // The plugin keeps several documents in one namespace. A scan that returned the
    // overlay's keys would hand the ledger a record it has no way to read.
    const found = await durable.loaded(durable.besideAForeignKey({ ses_mine: { n: 1 } }));

    assert.deepEqual([...found.entries.keys()], [durable.key("ses_mine")]);
  });

  it("reports a storage failure instead of swallowing it", async () => {
    const world = durable.failing();

    await durable.written(world, "ses_boom", { n: 1 });

    world.assertRefused(/refused the write to ledger\/v3\/task\/ses_boom: storage unavailable/);
  });
});

describe("durable state facade", () => {
  durable.tightBounds();

  it("returns only records that are records, in every form the host may hold", async () => {
    // A previous boot left JSON text; the host may hold a value it never stringified;
    // one record is not a record at all; one is half-written. A reader that handled
    // only the first would lose the second and throw on the fourth.
    const read = await durable.everyShape().readAll();

    assert.deepEqual([...read.records.keys()], [durable.key("ses_object"), durable.key("ses_text")]);
    assert.equal(read.dropped, 2, "what fails the guard is counted, never handed over");
    assert.equal(read.incomplete, false);
    assert.equal(durable.isTaskRecord({ state: "active" }), true, "the guard the case relied on");
  });

  it("says a read came back empty because nothing answered", async () => {
    durable.assertNothingAnswered(await durable.held().readAll(), (read) => read.records.size, "the store's own reader");
  });

  it("routes its writes through the store, and surfaces what the store refused", async () => {
    // One queue, not two. A facade with its own could report `settled` while a staged
    // write was still in flight, and the operator would be told a record was durable
    // when the host had not answered.
    const world = durable.held();

    world.facade.put(durable.key("ses_one"), { state: "active" });
    await world.facade.settled();
    world.assertRefused(/refused the write to .*ses_one/);

    world.gate.release();
    await durable.written(world, "ses_two", { state: "settled" });
    world.store.put(durable.key("ses_three"), { state: "completed" });
    await world.facade.settled();

    assert.equal(world.kv.size, 3, "the refused call lands once the host answers, and the facade waits on all three");
  });
});