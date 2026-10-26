// The event pump is the one loop every settlement, notice and gate rides. Per-event
// errors are contained at the handler (see index.ts), but the ITERATOR itself had
// no catch: a rejection was an unhandled rejection — Node >= 15 kills the host
// process — and a silent stream end left the plugin deaf with no trace at all.
// This suite pins both: the process survives a failing stream and says so, and a
// closed stream is named on the operator's log.

import { assert, describe, events, it, setupHarness, waitFor } from "./support/index.js";

describe("the event pump", () => {
  it("survives a rejecting event stream and names the failure on the operator's log", async () => {
    const hooks = {};
    const h = await setupHarness({ hooks });
    hooks.eventStreamThrows = true;
    // The generator is parked between events, so the fault is reached only on the
    // next pull — a live event wakes it and the NEXT iteration fails, the way a
    // real stream dies mid-life rather than before its first event.
    await h.fireEvent(events.working("pump-warmup"));

    // The pump must NOT die as an unhandled rejection: this process IS the case,
    // and an unhandled rejection ends it. Surviving to the log assertion is the
    // process-liveness claim; the prose is the observability one.
    await waitFor(() => h.prose().includes("event stream"), "the stream failure on the operator's log");
    assert.ok(h.prose().includes("event stream"), "the operator is told the stream died");
  });

  it("a stream that ends cleanly is named, because deafness must be observable", async () => {
    const hooks = {};
    const h = await setupHarness({ hooks });
    hooks.eventStreamEnd = true;
    await h.fireEvent(events.working("pump-warmup"));

    // The iterator RETURNS rather than throws — the plugin keeps running but can
    // never see another event. Silence here is the defect: the log is the only
    // place an operator learns the plugin stopped listening.
    await waitFor(() => h.prose().includes("deaf"), "the end-of-stream warning on the operator's log");
  });
});
