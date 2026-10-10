/**
 * One claim: a write the store gave up on may still land, and the store must not
 * leave the OLDER value durable afterwards.
 *
 * This is its own file because it is its own subject. A bound reports expiry; it
 * cannot cancel the call it gave up on. So the abandoned write can arrive AFTER the
 * newer one, and only a store that remembers each key's intent can repair it. The
 * case sits alone because its scenario — a refusal, a second write, then the first
 * landing late — shares no arrangement with the other durable cases, and folding it
 * in reproduced the same sequence in both, which the duplicate gate reads as code
 * duplicated rather than as a fixture reused.
 */

//jscpd:ignore-start
import { durable } from "./support/durable-world.js";
import { assert, it } from "./support/runner.js";

//jscpd:ignore-end
durable.tightBounds();

it("repairs a late landing rather than leaving the older value durable", async () => {
  const world = await durable.refusing("ses_race", { n: 1 });

  world.store.put(durable.key("ses_race"), { n: 2 });
  await world.store.settled();
  assert.deepEqual(world.kv.get(durable.key("ses_race")), { n: 2 });

  world.gate.release();
  await world.gate.applied;
  assert.deepEqual(
    world.kv.get(durable.key("ses_race")),
    { n: 1 },
    "the abandoned write lands late, and it lands the OLDER value",
  );

  await world.client.untilStorageWrites(3);
  world.assertDurable("ses_race", { n: 2 });
});