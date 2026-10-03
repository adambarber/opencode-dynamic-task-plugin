import assert from 'node:assert';
import path from 'node:path';

import { REPO_ROOT, readSource } from './support/corpus.js';
import { hostCallSites } from './support/host-calls.js';
import { createMockClient } from './support/mock-host.js';
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
 * cannot answer a call the plugin makes leaves every case green while testing nothing.
 *
 * The envelope case that used to live here is gone: v2's client has no envelope — it
 * returns bare payloads and rejects on failure — so the check was policing a shape the
 * host does not produce. Its real subject survives as a compile-time pin instead
 * (`type-invariants-fake.ts`): the fake is typed against the real domains, so a field
 * production reads cannot be missing from it without the build saying so.
 */
describe("invariant: the fake answers the host", () => {
  it("the fake answers every call the plugin makes, so no production call lands on a missing seam", () => {
    const client = createMockClient({});
    const sites = hostCallSites(client);

    assert.ok(sites.length > 0, "the enumeration found no client calls — it is broken, so this pin proves nothing");
    const missing = sites.filter(({ ns, method }) => typeof client[ns]?.[method] !== "function");

    assert.deepStrictEqual(
      missing.map(({ ns, method, file, line }) => `${ns}.${method} (${path.basename(file)}:${line})`),
      [],
      "the fake has no seam for these calls; a case needing them cannot be written",
    );
  });
});