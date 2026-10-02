import assert from 'node:assert';
import path from 'node:path';

import { REPO_ROOT, readSource } from './support/corpus.js';
import { hostCallSites } from './support/host-calls.js';
import { createMockClient, hostCallArgs, hostSaid, isSDKEnvelope } from './support/mock-host.js';
import { describe, it } from './support/runner.js';

/**
 * The fake's fidelity to the host — the half of the outbound contract a TYPE cannot
 * check. Boundedness used to be read off the source and is now a BUILD FAILURE:
 * production holds an `OpaqueHost`, which has no namespaces, so naming one does not
 * compile (`type-invariants-host.ts` pins it, falsified by an inserted unbounded
 * call). The scanner that made that claim matched a LITERAL receiver, so it never saw
 * the defect it existed to prevent — an unbounded `safeLog` behind an indirect one.
 * See docs/tasks/18-opaque-host-boundedness.md.
 *
 * What remains is about the fake, and the compiler is silent on all of it: a mock that
 * cannot answer a call the plugin makes, or answers it in a shape the host never sends,
 * leaves every case green while testing nothing.
 */
describe("invariant: the fake answers the host", () => {
  it("every fake answer carries the SDK envelope, so tolerance in production cannot hide a wrong reader", async () => {
    // Production reads some answers through a deliberately tolerant helper, so a fake
    // answering a BARE payload keeps every case green while the reader behind it goes
    // quietly wrong. The fake answers what the host answers; tolerance is the reader's.
    const client = createMockClient({});
    // A session that EXISTS, with a transcript behind it: asked about a session the
    // host has never heard of, an endpoint answers 404 — so the probe would skip it and
    // judge only the endpoints that answer regardless. Arguments come from the fake,
    // because the host's route shape is the fake's fact, not this pin's.
    const PROBE = "ses_shape_probe";
    client._state.sessions.add(PROBE);
    client._state.transcripts.set(PROBE, [hostSaid("PROBE_DONE")]);

    const wrong = [];
    for (const { ns, method, where } of hostCallSites()) {
      const answer = await client[ns][method](hostCallArgs(ns, method, PROBE)).then(
        (value) => value,
        (error) => `THREW ${error.message.split(" (got")[0]}`,
      );
      if (!isSDKEnvelope(answer)) wrong.push(`${where} -> ${JSON.stringify(answer)}`);
    }

    assert.deepStrictEqual(wrong, [], "these endpoints answer something the SDK never sends");
  });

  it("the fake answers every call the plugin makes, so no production call lands on a missing seam", () => {
    const client = createMockClient({});
    const sites = hostCallSites();

    assert.ok(sites.length > 0, "the enumeration found no client calls — it is broken, so this pin proves nothing");
    const missing = sites.filter(({ ns, method }) => typeof client[ns]?.[method] !== "function");

    assert.deepStrictEqual(
      missing.map(({ ns, method, file, line }) => `${ns}.${method} (${path.basename(file)}:${line})`),
      [],
      "the fake has no seam for these calls; a case needing them cannot be written",
    );
  });
});