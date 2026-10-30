// fireAndForget must not let a synchronous throw escape as an uncaught
// exception — work() is deferred into the promise chain so sync throws become
// rejections the .catch can handle.

import { asOpaqueHost, fireAndForget } from "../../dist/shared/client.js";
import { assert, describe, it } from "./support/index.js";

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

  it("contains a throwing onFailure instead of surfacing an unhandled rejection", async () => {
    // work throws AND onFailure throws: the .catch's promise must not reject
    // with nobody to handle it. An unhandledRejection is the process-level
    // symptom — register an observer (append, never replace) and assert it
    // never fires, so a regression surfaces as a test failure, not a crash.
    const unhandled = [];
    const onUnhandled = (reason) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      assert.doesNotThrow(() => {
        fireAndForget(
          host,
          () => {
            throw new Error("sync boom");
          },
          () => {
            throw new Error("reporter boom");
          },
        );
      });
      // Both the deferred work and the reporter run in microtasks; drain them.
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepStrictEqual(unhandled, [], "a throwing onFailure is contained, not an unhandled rejection");
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
