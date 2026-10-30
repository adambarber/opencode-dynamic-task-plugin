// fireAndForget must not let a synchronous throw escape as an uncaught
// exception — work() is deferred into the promise chain so sync throws become
// rejections the .catch can handle.

import { assert, describe, it } from "./support/index.js";
import { asOpaqueHost, fireAndForget } from "../../dist/shared/client.js";

const fakeClient = { session: { prompt: async () => {} } };
const host = asOpaqueHost(fakeClient);

describe("fireAndForget", () => {
  it("converts a synchronous throw into a rejection instead of escaping it", () => {
    // work throws before any await — without the fix this escapes uncaught.
    assert.doesNotThrow(() => {
      fireAndForget(host, () => {
        throw new Error("sync boom");
      });
    });
  });

  it("reports a synchronous throw to onFailure", async () => {
    let reported = null;
    fireAndForget(
      host,
      () => {
        throw new Error("sync boom");
      },
      (error) => {
        reported = error;
      },
    );
    // The throw happens in a microtask, so wait for the queue to drain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(reported instanceof Error, "onFailure received the sync throw");
    assert.strictEqual(reported.message, "sync boom", "the reported error is the thrown one");
  });
});
