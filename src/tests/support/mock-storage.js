// src/tests/support/mock-storage.js
// The fake host's durable plugin table: the ONE place in the fake that is a disk.
//
// It is separated from the transport because durable state has its own hazards —
// ordering, late landings, partial reads — and none of them belong to the seam
// that answers sessions and events.

import { armedFlag, fault } from "./faults.js";

/** A promise nobody resolves, and the resolver that says so: the shape of "not yet". */
const NOOP = () => {};

/**
 * A count of things that happened, and a promise for when at least `n` have. Waiting
 * for the host by COUNT rather than by clock is what lets a case watch a store repair
 * itself: the repair is a real write, so there is a real count to wait on.
 */
function counter() {
  const waiters = [];
  let count = 0;
  const bump = () => {
    count += 1;
    for (const report of waiters.splice(0)) report(count);
  };
  const at = (n) =>
    count >= n
      ? Promise.resolve(count)
      : new Promise((resolve) => waiters.push((seen) => seen >= n && resolve(seen)));
  return { at, bump };
}

/**
 * The order the host hands rows back in: code-unit order on the key. Spelled out
 * rather than left to `sort()` on a tuple, because a bare sort stringifies the whole
 * row and orders by a value the caller never asked about.
 */
function byKey([left], [right]) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** The gate a case arms to hold the FIRST call: a write accepted and never stored. */
async function passGate(state) {
  const gate = state.storageGate;
  if (!gate || gate.used) return;
  fault(state, "storageGate");
  gate.used = true;
  await gate.promise;
}

/**
 * The host's durable plugin table, answering the v2 storage contract against the
 * live `kv` map. `holdNext` is what lets a case watch a write land LATE, which is
 * the only way to see that a bound reports without cancelling.
 */
export function createMockStorage(state, hooks) {
  const queuedDelays = Array.isArray(hooks.storageDelays) ? [...hooks.storageDelays] : [];
  const landings = counter();
  const afterHeld = [];
  let heldWrite = null;

  /** The armed-throw fault: a host that refuses rather than answers. */
  function passThrowFault() {
    if (!armedFlag(state, hooks, "storageThrows")) return;
    fault(state, "storageThrows");
    throw new Error("storage unavailable");
  }

  // Returns the hold THIS call consumed, so the caller announces this write's own
  // landing rather than whichever write happened to finish first.
  async function storageFault() {
    await passGate(state);
    passThrowFault();
    // A per-CALL delay queue, because that is the only way two writes to one key can
    // land out of ORDER: the earlier write has to be the slower one. A uniform delay
    // preserves order by luck, so a fake offering only that would let an unfunnelled
    // store pass a suite about ordering, and would never expose a late landing.
    const delay = queuedDelays.shift();
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    // Held BEFORE the delay, so a case can watch a write the store has already given
    // up on finally arrive, which is the only way to observe a late landing.
    const held = heldWrite;
    heldWrite = null;
    if (held) await held.gated;
    return held;
  }

  // One write's whole shape: pass the fault, pass the landing. `remove` and `set`
  // are the same event with different effects, so writing the shape twice is how
  // one of them quietly stops announcing that its write landed.
  const settleWrite = async (land) => {
    const held = await storageFault();
    land();
    landings.bump();
    // A held write reports its OWN landing, and does not also count as the write
    // that follows it — the follow-up has not been asked for yet.
    if (held) held.landed();
    else for (const report of afterHeld.splice(0)) report();
  };

  const storage = {
    get: async (key) => {
      await storageFault();
      return state.kv.get(key);
    },
    remove: (key) => settleWrite(() => state.kv.delete(key)),
    // The host's own rules, not this fake's idea of them: the limit is clamped to
    // 1..1000 and defaults to 100, the range is a prefix, and the cursor is
    // exclusive. A fake that invented its own pagination let a reader be written
    // against a contract the host never had.
    async scan({ prefix, after, limit }) {
      await storageFault();
      const take = Math.min(Math.max(limit ?? 100, 1), 1000);
      const cursor = after ?? "";
      const rows = [...state.kv]
        .filter(([key]) => key.startsWith(prefix) && key > cursor)
        .toSorted(byKey);
      const entries = rows.slice(0, take).map(([key, value]) => ({ key, value }));
      // The host names the last row it sent as the cursor, and omits it when the
      // page was not full — so a reader that loops on `next` terminates.
      const next = entries.length === take ? entries[entries.length - 1].key : undefined;
      return { entries, next };
    },
    set: (key, value) => settleWrite(() => state.kv.set(key, value)),
  };

  /**
   * Hold ONE write until released, and name the two events a case needs without
   * sleeping for them: `applied` is that write landing, and `next` is the write
   * the store issues after it, armed only once it has landed.
   */
  function holdNext() {
    let letGo = NOOP;
    let reportThis = NOOP;
    let reportFollowing = NOOP;
    const gated = new Promise((resolve) => {
      letGo = resolve;
    });
    const applied = new Promise((resolve) => {
      reportThis = resolve;
    });
    const next = new Promise((resolve) => {
      reportFollowing = resolve;
    });
    heldWrite = {
      gated,
      landed: () => {
        reportThis();
        afterHeld.push(reportFollowing);
      },
    };
    return { applied, next, release: () => letGo() };
  }

  /** Resolve once `n` durable writes have LANDED, however many calls refused to. */
  return { holdNext, storage, untilWrites: landings.at };
}