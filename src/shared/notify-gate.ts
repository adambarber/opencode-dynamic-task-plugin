// src/shared/notify-gate.ts — who has been told what, once.
// Notification decisions are process memory; durable task state is the ledger.
// Tenet 8: one place to grep for "who got told what, once". dedupKey defaults to kind
// (settle-once); "notice" callers pass a message-derived key. Session ids are globally
// unique, so entries outlive their usefulness once a child leaves the retained ledger
// — FIFO-bounded to stay honest about exactly-once without growing without limit.
// Every key is bound to a per-child generation: forgetChild (revival) bumps it and
// clears the child's pending claims, so an in-flight commit from a previous turn emits
// history but can never reserve the revived turn's key.
import { evictOldest } from "./bounded-map.js";

/**
 * What a claim IS: which notice of which child, bound to the generation it was taken
 * under. Named because four of the five methods take exactly this triple, and both ids
 * are strings — as positional arguments a transposition compiled.
 */
export interface Claim {
  childSessionId: string;
  dedupKey: string;
  generation: number;
}

export interface GateLedger {
  record(claim: Claim): boolean;
  /**
   * Write off a debt whose redelivery budget is spent. Idempotent, and takes the
   * generation it retires AT, so every claim up to and including that one is dead.
   */
  retire(claim: Claim): void;
  /**
   * Whether a claim is dead because its debt was written off. Separate from `retire`
   * because a commit can arrive long after the write-off and asks only this question.
   */
  isRetired(claim: Claim): boolean;
  /**
   * Revival resets settle-dedup: a continued task is a fresh settlement subject. The
   * generation bump is what makes that safe against claims still in flight.
   */
  forgetChild(childSessionId: string): void;
  /**
   * In-flight claim: closes the check-then-act race between concurrent same-key
   * writers. Synchronous; the winner dials, losers are suppressed before transport.
   * Returns the generation bound (null = refused), or null when the key is taken.
   */
  claim(childSessionId: string, dedupKey: string): number | null;
  /** Released on delivery failure so a failed settlement stays redeliverable. */
  release(claim: Claim): void;
  /** Test-only isolation: the gate is process-global by design. */
  clear(): void;
}

const GATE_MAX_CHILDREN = 1000;

function duplicateOf(map: Map<string, Set<string>>, childSessionId: string, dedupKey: string): boolean {
  return map.get(childSessionId)?.has(dedupKey) ?? false;
}

function currentGeneration(generations: Map<string, number>, childSessionId: string): number {
  return generations.get(childSessionId) ?? 0;
}

const drop = (map: Map<string, Set<string>>, childSessionId: string, dedupKey: string): void => {
  const keys = map.get(childSessionId);
  if (!keys) return;
  keys.delete(dedupKey);
  if (keys.size === 0) map.delete(childSessionId);
};

function createGateLedger(): GateLedger {
  const delivered = new Map<string, Set<string>>();
  const inFlight = new Map<string, Set<string>>();
  const generations = new Map<string, number>();
  // Debts WRITTEN OFF, keyed to the debt and not to the claim: a commit is a
  // statement ABOUT a debt, so once the obligation ended no late answer is a delivery.
  // The generation comparison is what makes it tight — a later generation is a new
  // subject with a new obligation. forgetChild also clears entries, which bounds the map.
  const retired = new Map<string, Map<string, number>>();
  return {
    claim(childSessionId, dedupKey) {
      if (duplicateOf(delivered, childSessionId, dedupKey) || duplicateOf(inFlight, childSessionId, dedupKey)) return null;
      const pending = inFlight.get(childSessionId) ?? new Set();
      pending.add(dedupKey);
      inFlight.set(childSessionId, pending);
      return currentGeneration(generations, childSessionId);
    },
    clear() {
      delivered.clear();
      inFlight.clear();
      generations.clear();
      retired.clear();
    },
    forgetChild(childSessionId) {
      const next = currentGeneration(generations, childSessionId) + 1;
      generations.set(childSessionId, next);
      if (generations.size > GATE_MAX_CHILDREN) {
        const oldest = generations.keys().next();
        if (!oldest.done) generations.delete(oldest.value);
      }
      delivered.delete(childSessionId);
      inFlight.delete(childSessionId);
      retired.delete(childSessionId);
    },
    isRetired({ childSessionId, dedupKey, generation }) {
      const at = retired.get(childSessionId)?.get(dedupKey);
      return at !== undefined && generation <= at;
    },
    record({ childSessionId, dedupKey, generation }) {
      if (currentGeneration(generations, childSessionId) !== generation) return false;
      const kinds = delivered.get(childSessionId) ?? new Set();
      if (kinds.has(dedupKey)) return false;
      kinds.add(dedupKey);
      delivered.set(childSessionId, kinds);
      evictOldest(delivered, GATE_MAX_CHILDREN);
      return true;
    },
    release({ childSessionId, dedupKey, generation }) {
      // A stale generation's entry was already cleared by forgetChild; dropping here
      // could only hit the current generation's claim.
      if (currentGeneration(generations, childSessionId) !== generation) return;
      drop(inFlight, childSessionId, dedupKey);
    },
    retire({ childSessionId, dedupKey, generation }) {
      const keys = retired.get(childSessionId) ?? new Map<string, number>();
      keys.set(dedupKey, generation);
      retired.set(childSessionId, keys);
    },
  };
}

export const gateLedger = createGateLedger();

// Bumped by every reset. A claim remembers the epoch it was issued under, so an answer
// arriving after a reset cannot land in the new world — where the same child id may
// belong to a different child. The per-child generation cannot catch this: a reset
// restarts those at zero.
let gateEpoch = 0;

/** The world a claim was taken in, so a reset can invalidate every late answer. */
export function currentGateEpoch(): number {
  return gateEpoch;
}

export function clearGate(): void {
  gateLedger.clear();
  gateEpoch++;
}