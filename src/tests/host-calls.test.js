import assert from 'node:assert';
import path from 'node:path';

import { REPO_ROOT, readSource } from './support/corpus.js';
import { hostCallSites } from './support/host-calls.js';
import { createMockClient, hostCallArgs, hostSaid, isSDKEnvelope } from './support/mock-host.js';
import { describe, it } from './support/runner.js';

/**
 * The outbound call contract, in two halves that share one enumeration.
 *
 * BOUNDEDNESS is a property of the source, so it is read off the source. It was
 * found by WAITING — a suite raced each tool against a deadline and four of them
 * lost — which is the wrong instrument for a structural property and the right
 * one only by luck. A new outbound call is unbounded the moment it is written.
 *
 * ANSWWERING is a property of the fake, so it is asked of the fake: the fake must
 * answer every call production makes, or the case that needs that seam cannot be
 * written and nobody finds out until a test mysteriously proves nothing.
 *
 * Both halves read `hostCallSites()`, on purpose. Two copies of that enumeration
 * would let a call site pass one gate and fail the other, and each file would
 * read green while describing the wrong production.
 *
 * WHAT THE TEXT SCAN CANNOT SEE, stated here because it is the limit of the
 * instrument: it matches a LITERAL `client.<ns>.<method>(` receiver. The one
 * defect it missed was reached through `hostLogCall(client)` — the log write had
 * no `client.` in it at all, and an unbounded `safeLog` stopped the plugin from
 * ever finishing init, with no symptom and no log line to explain it. An indirect
 * receiver is therefore not covered here, and the coverage for it is
 * BEHAVIOURAL: hostile-host.test.js boots against a host that never answers, which
 * is the only instrument that does not care how the call was spelled.
 */
describe("invariant: every host call is bounded (Tenet 2)", () => {

  /**
   * Two sites whose bound lives one layer above the call, each for a reason the
   * layer makes necessary rather than convenient.
   */
  const BOUND_UPSTREAM = {
    "prompt.ts:session.prompt":
      "fire-and-forget by contract: no caller awaits a child prompt, so nothing can be held open by it",
    "notify.ts:session.prompt":
      "the gate bounds the HELD write deliberately — a write that may still deliver must not be retried",
    "question-handling.ts:question.reply":
      "sendQuestionSettlement owns the bound for every question write, so no caller can skip it",
    "question-handling.ts:question.reject":
      "sendQuestionSettlement owns the bound for every question write, so no caller can skip it",
  };

  /**
   * The call forms that put a host call inside a bound. A list rather than one name,
   * because a bound is a claim the scanner cannot verify — it reads a shape and believes
   * it — so the belief has to be written down in one place. Add a bounding function
   * without adding it here and every site that uses it goes red, which is the safe
   * direction: the scanner cannot tell an unbounded call from one bound by a function
   * it has never heard of.
   */
  const BOUNDS_A_CALL = ["withBound(", "boundedRead("];

  it("every host call site is inside a bound, or names the layer that bounds it", () => {
    const unbounded = [];
    for (const site of hostCallSites()) {
      // The bound is one or two lines above the call — `withBound(BOUND, () => call())`
      // is written that way everywhere, and a bound that needed its own paragraph of
      // explaining where it started is a bound worth moving.
      const above = readSource(site.file).text
        .split("\n")
        .slice(Math.max(0, site.line - 3), site.line)
        .join("\n");
      if (BOUNDS_A_CALL.some((bound) => above.includes(bound))) continue;
      if (BOUND_UPSTREAM[site.where] !== undefined) continue;
      unbounded.push(`${path.relative(REPO_ROOT, site.file)}:${site.line} :: ${site.content}`);
    }
    assert.deepStrictEqual(
      unbounded,
      [],
      `Every host call must be bounded. Unbounded sites:\n${unbounded.join("\n")}\n\n` +
        `Or add it to BOUND_UPSTREAM with the reason the bound lives elsewhere.`,
    );
  });

  it("the upstream registry names every exception and no more", () => {
    const registered = Object.keys(BOUND_UPSTREAM);
    assert.ok(registered.length > 0, "the registry exists, so a reader can see what is exempt");
    for (const entry of registered) {
      const reason = BOUND_UPSTREAM[entry];
      assert.match(reason, /\S/, `${entry} must say why its bound lives elsewhere`);
    }
  });

  it("every fake answer carries the SDK envelope, so tolerance in production cannot hide a wrong reader", async () => {
    // Production reads some answers through a deliberately tolerant helper, so a fake
    // answering a BARE payload would keep every case green while the reader behind it
    // got quietly wrong. Fidelity is the direction that matters: the fake answers what
    // the host answers, and the tolerance stays a property of the reader.
    const client = createMockClient({});
    // A session that EXISTS, with a transcript behind it: asked about a session the
    // host has never heard of, an endpoint answers 404 — so the probe would skip it
    // and the pin would judge only the endpoints that answer regardless. Arguments come
    // from the fake because the host's route shape is the fake's fact, not this pin's.
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

    assert.ok(sites.length > 0, "the scan found no client calls — the scanner is broken, not the fake");
    const missing = sites.filter(({ ns, method }) => typeof client[ns]?.[method] !== "function");

    assert.deepStrictEqual(
      missing.map(({ ns, method, file, line }) => `${ns}.${method} (${path.basename(file)}:${line})`),
      [],
      "the fake has no seam for these calls; a case needing them cannot be written",
    );
  });
});