import { setupHarness } from "./support/harness.js";
import { waitFor } from "./support/integration.js";
import { assert, describe, it } from "./support/runner.js";

describe("cross-project isolation", () => {
  it("a boot in project B restores zero records written by project A", async () => {
    const first = await setupHarness({ options: {} });
    const { id: childA } = await first.spawn({ description: "A's task", subagent_type: "general" });
    assert.ok(childA, "A's dispatch must return a session id");

    // Project A persists running, settled, and owed records through its boot.
    await first.settle(childA);

    // A second project boots against the SAME host-wide namespace: graft A's
    // KV map into B's, which is what one shared opencode service means.
    const second = await setupHarness({ directory: `${first.directory}-sibling`, options: {} });
    for (const [key, value] of first.kv) second.kv.set(key, value);

    const ledgerB = await second.readLedger();
    assert.equal(
      ledgerB.active.size,
      0,
      `project B restored project A's active tasks: ${[...ledgerB.active.keys()].join(", ")}`,
    );
    assert.equal(
      ledgerB.retained.size,
      0,
      `project B restored project A's settled tasks: ${[...ledgerB.retained.keys()].join(", ")}`,
    );
  });

  it("capacity in project B is unaffected by project A's running tasks", async () => {
  // ONE host-wide namespace, both boots reading it — what one shared opencode
  // service means. B boots AFTER A's child is registered, so B's restore must
  // actively refuse A's record; a graft after the boot would prove nothing.
  const shared = new Map();
  const first = await setupHarness({ domain: { kv: shared } });
  const { id: childA } = await first.spawn({ description: "A's long task", subagent_type: "general" });
  assert.ok(childA, "A's child must be running");
  // The durable write is an async chain, and the FIRST key to land is the create
  // intent — a digest that does not name the child. The witness is a key that
  // carries the child's id, which only the active (or, after settle, retained)
  // ledger record does: B's boot is only a valid witness once THAT has landed.
  await waitFor(() => [...shared.keys()].some((key) => key.includes(childA)), "A's active record to land in the shared namespace");

  // B's global cap is 1, so ONE foreign active task saturates it — the exact
  // production signature that blocked dispatches on 2026-10-26.
  const second = await setupHarness({
    directory: `${first.directory}-sibling`,
    domain: { kv: shared },
    hooks: { hostTurnSeed: { [childA]: undefined } },
    options: { maxConcurrent: 1 },
  });

  const listB = await second.tool.task_list.execute({});
  assert.ok(
    !listB.includes("A's long task"),
    `project B's task_list shows project A's task: ${listB.slice(0, 400)}`,
  );

  const { out: spawnB } = await second.spawn({ description: "B's task", subagent_type: "general" });
  assert.ok(
    !spawnB.includes("ConcurrencyLimitExceeded"),
      `project B's dispatch blocked by project A's task: ${spawnB.slice(0, 400)}`,
    );
  });
});
