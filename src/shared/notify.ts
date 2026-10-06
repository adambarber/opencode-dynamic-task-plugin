// The gate itself: one parent-write primitive and the receipts it writes down.
// Who has been told what, once, is notify-gate; the durable queue of owed writes is
// notify-queue; the log funnel the warnings go to is notify-log. Kinds:
// completed/error settle a task once (the lifecycle event drives them), and
// "notice" is the child's general mid-flight voice — progress, findings, or a
// block needing parent input — deduped by message text so verbatim repeats land
// once while new information always passes.
// The plugin arms no timers of its own; every deadline it does have is owned by
// execution-bound, including the one on the parent prompt itself — the host
// holds a write to a mid-turn parent rather than refusing it, so "slow" and
// "never" are the same call from inside the gate.

//jscpd:ignore-start
import { type Claim, clearGate, currentGateEpoch, gateLedger } from "./notify-gate.js";
import {
  type DeliveryOutcome,
  type NotificationRecord,
  clearDeliveryLedger,
  notifyRecord,
  recordNotification,
} from "./notify-records.js";
import { type OpaqueHost, callHost } from "./client.js";
import { type SettlementVerdict, TaskState } from "./task-state.js";
import {
  announceDropped,
  dropPending,
  getPendingDeliveries,
  owedDelivery,
  queuePending,
} from "./notify-queue.js";
import { hostTurnRunning, readLiveness } from "./liveness.js";
import { NotifyKind } from "./notification-text.js";
import { WRITE_BOUNDS } from "./execution-bound.js";
import { safeLog } from "./notify-log.js";

//jscpd:ignore-end
export { announceDropped, dropPending, getPendingDeliveries, owedDelivery, queuePending } from "./notify-queue.js";
export { configurePendingPersistence, owedIdentity, restorePendingDeliveries } from "./notify-queue.js";
export { clearDeliveryLedger, notifyRecord, recordNotification } from "./notify-records.js";
export { getLatestNotification, getTurnNotification } from "./notify-records.js";
export { currentGateEpoch, gateLedger } from "./notify-gate.js";
export { containFailure, safeLog } from "./notify-log.js";
export { NOTIFY_KINDS } from "./notification-text.js";
export type { DeliveryOutcome, NotificationRecord } from "./notify-records.js";
export type { DeliveryTarget, PendingDelivery } from "./notify-queue.js";
export type { GateLedger } from "./notify-gate.js";
export type { LogLevel } from "./notify-log.js";


/**
 * The one place a settlement's verdict and its notification kind meet.
 *
 * They are the same three words, and they are two types because they are two
 * different facts: the verdict is what the RECORD says happened, the kind is
 * what the PARENT is told. A switch rather than a lookup table so adding a
 * verdict is a compile error here, in the one function that has to answer for
 * it — a table would default and let a new ending be announced as something it
 * is not, which is the false-success claim this plugin exists to avoid.
 */
export function settlementKind(verdict: SettlementVerdict): NotifyKind {
  switch (verdict) {
    case TaskState.Completed:
      return NotifyKind.Completed;
    case TaskState.Error:
      return NotifyKind.Error;
    case TaskState.Blocked:
      return NotifyKind.Blocked;
    // The union is closed, so this arm is unreachable — and that is the point:
    // a fourth verdict must fail loudly here, not fall through as undefined.
    default: throw new Error(`unhandled settlement verdict: ${JSON.stringify(verdict satisfies never)}`);
  }
}

// One reset for the whole notification world: receipts, gate and epoch together. A
// reset that cleared the gate but kept the receipts would still answer "was it told?"
// from the world just discarded — the question a revived child id makes a live parent
// ask, and the one a test asks after a reset.
export function clearNotifyLedger(): void {
  clearDeliveryLedger();
  clearGate();
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

const NOTIFY_RETRY_DELAY_MS = 250;

/**
 * The bound a caller that names none gets. Deliberately NOT the same constant as
 * the configured `pendingMaxAttempts`, and deliberately not tracking it: this is
 * a funnel safety, not policy, and it exists for the caller who forgot to pass
 * one. Only a restored debt carries a non-zero count, so only the boot redelivery
 * can reach it — and the boot loop always names the operator's value, which is
 * what makes an unbounded loop impossible rather than merely unlikely. Keep it
 * small, keep it finite, and let the config own the number that means anything.
 */
const DEFAULT_PENDING_MAX_ATTEMPTS = 3;

interface NotifyParentOptions {
  sleep?: (ms: number) => Promise<void>;
  record?: (entry: NotificationRecord) => void;
  childSessionId: string;
  kind: NotifyKind;
  dedupKey?: string;
  // Attempts earlier boots already spent on this exact write, restored from the
  // durable queue. Counting from there is what makes a redelivery that keeps
  // getting held escalate visibly instead of looking like a fresh first try.
  carriedAttempts?: number;
  /**
   * How many redeliveries this debt is owed before it is written off.
   *
   * A BACKSTOP, not the policy channel: only a restored debt carries a
   * non-zero `carriedAttempts`, so only the boot redelivery can reach the
   * bound, and the boot loop is the one caller that sets it from the project's
   * config. The default therefore has to be the terminating one — a caller that
   * forgets to pass it must expire a notice rather than re-offer it forever,
   * because the two failure modes are not symmetric. An unnoticed write-off
   * loses one notice; an unbounded loop wedges the project it is owed to, since
   * redelivering IS `session.prompt` and every attempt starts a parent turn.
   */
  maxAttempts?: number;
}

// Per-child serialization: detached deliveries of one child execute in claim
// order, so a stale retry can never land after a newer turn's message. Only
// transport is serialized — claims stay synchronous, and the chain is dropped
// once its tail settles so child ids never leak. Bounded to the same 1000-child
// window as the dedup gate: an evicted child keeps delivery but loses ordering
// against a re-spawn after 1000 other children chained first.
const notifyChains = new Map<string, Promise<unknown>>();
const NOTIFY_CHAIN_MAX = 1000;

// Pay every owed notification, oldest first, one pass and no waiting.
/**
 * Pay every owed notification, oldest first, one pass and no waiting.
 *
 * This is the ONLY re-offer of the queue, and it is a function rather than a
 * loop at the boot site because a loop there has to be re-read to be trusted: a
 * caller can add an option to `notifyParent` and forget to pass it through, and
 * the debt policy then depends on which caller remembered. Named, it has one
 * reader and it is the one that owns the debt, so the budget cannot be dropped
 * by omission — the cross-boundary gate is what proved the point, by catching a
 * test that had re-implemented this loop to stand in for a boot.
 *
 * The write goes back through the gate because there is no second parent-write
 * path, so a redelivery the host HOLDS re-arms its own entry and waits for the
 * next boot, one that lands is retired before the receipt is written, and one
 * whose budget is spent is written off. The count rides along because only here
 * does a debt get redelivered; the gate is where the bound is SPENT.
 *
 * `batch` bounds how many this ONE boot offers, and it exists because the bound
 * above was the only budget in this path: a re-offer is `session.prompt`, a real
 * user turn in the parent's session, in a session that may hold an entire
 * context, so paying the whole queue at once does not cost one turn per debt, it
 * costs one turn per debt simultaneously, out of a process whose operator has
 * not finished logging in. Measured 2026-09-28: one boot against a coda ledger
 * wrote 240 parents. `pendingMaxAttempts` bounds how long ONE debt may live and
 * this bounds how many one boot dials — two questions, and only one of them was
 * being asked.
 *
 * The remainder is charged nothing, re-queued nowhere, and written off nowhere:
 * it is left exactly as it was read, so the next boot offers the next batch, the
 * queue drains in order, and no clock is needed. A debt is billed for a write it
 * actually attempted, which is what stops a deferred debt from ageing out
 * without ever having been tried.
 */
export function redeliverOwedNotifications(host: OpaqueHost, maxAttempts: number, batch = 1): void {
  const owed = getPendingDeliveries();
  const offered = owed.slice(0, Math.max(1, batch));
  for (const debt of offered) {
    void notifyParent(host, debt.parentSessionId, debt.text, {
      carriedAttempts: debt.attempts,
      childSessionId: debt.childSessionId,
      kind: debt.kind,
      maxAttempts,
    });
  }
  if (owed.length > offered.length) {
    const held = owed.length - offered.length;
    void safeLog("warn", `Dynamic task plugin: ${owed.length} notification(s) are owed and this boot is offering ${offered.length} of them — one batch, bounded by the concurrency cap, because each is a real turn in a parent session. The other ${held} stay owed and unchanged, and the next boot offers the next ${offered.length}.`);
  }
}

/**
 * Why this parent will not take a write right now, or null when it will.
 *
 * Two refusals, one word, one order. Mid-turn comes first because the host HOLDS
 * a write to a busy session and delivers it when the turn ends — a wait, and the
 * debt is right to survive it. Wedged comes second because there is no later: a
 * turn the host opened and never closed makes every write to that session a
 * silent no-op, forever, and a debt offered into one dials a call that will never
 * answer while holding the claim for it. Measured 2026-09-28 on coda, where 82
 * turns across 67 sessions were pinned that way.
 *
 * A refusal is never inferred from a failed read, only from the host's own
 * words, so a flaky channel defers nothing and loses nothing.
 */
async function parentRefusal(host: OpaqueHost, sessionId: string): Promise<string | null> {
  // One read for the one question. A refusal is an open turn the host DESCRIBED — a
  // clock with no completion. A host that described nothing (no clock at all) refused
  // nothing, and reading that as a refusal declares every undescribed parent dead.
  const reading = await readLiveness(host, sessionId);
  if (!hostTurnRunning(reading) || reading.lastMessageAt === null) return null;
  return "mid-turn";
}

export async function notifyParent(
  host: OpaqueHost,
  parentSessionId: string,
  message: string,
  opts: NotifyParentOptions,
): Promise<boolean> {
  const {kind} = opts;
  const sleep = opts.sleep ?? defaultSleep;
  const record = opts.record ?? recordNotification;
  const dedupKey = opts.dedupKey ?? opts.kind;
  // The key the GATE keeps, which is not the caller's: a notice is owed to a
  // PARENT, so the recipient is part of what makes it the same notice. Without
  // it two parents waiting on one edge share (child, kind), the first release
  // reserves the key, and the second parent is never told its dispatch can go —
  // silently, and for the life of the process.
  const gateKey = `${parentSessionId}|${dedupKey}`;
  const emit = (outcome: DeliveryOutcome): void =>
    record(notifyRecord({ childSessionId: opts.childSessionId, kind, parentSessionId }, message, outcome));
  const generation = gateLedger.claim(opts.childSessionId, gateKey);
  const epoch = currentGateEpoch();
  if (generation === null) {
    emit({ attempts: 0, delivered: false, suppressed: true });
    return Promise.resolve(false);
  }
  // The claim, as one value: the generation is bound to the notice and the child
  // it was taken for, so nothing downstream can pass the right pieces in the
  // wrong order, and a revival that bumps the generation makes every later use
  // of this value visibly stale.
  const claim: Claim = { childSessionId: opts.childSessionId, dedupKey: gateKey, generation };
  // The one write, and the ONE bound on it. The bound REPORTS a hold rather than
  // throwing: "has not answered yet" and "refused" are different outcomes with
  // different records, and the answer may still arrive, so the caller needs the
  // in-flight promise to attach the late commit to. Two bounds here made a held
  // write arrive as a refusal.
  type Attempt =
    | { held: true; request: Promise<unknown> }
    | { held: false; result: unknown };
  const attempt = (): Promise<Attempt> => {
    // The IN-FLIGHT request, kept beside the bounded read. The bound answers "has it
    // answered yet", never "will it answer" — so a hold needs the unbounded promise
    // to learn the answer when it lands, and the bound is what stops the caller
    // waiting for it.
    let inFlight: Promise<unknown> | undefined;
    const request = callHost(host, WRITE_BOUNDS.parentPrompt, (client) => {
      inFlight = client.session.prompt({ sessionID: parentSessionId, text: message });
      return inFlight;
    }, undefined);
    return request.then((bounded) => {
      // A HELD write is not a refusal and not an answer: the bound returned, the
      // request did not. The caller commits the pending record and attaches the
      // late commit to `inFlight`, so the record turns truthful whenever the host
      // finally answers.
      // `inFlight` is set by the lambda above on every path that reached the
      // host; a timeout that predates it would be the bound firing before the
      // request was ever made, and `request` is the honest stand-in.
      if (bounded.timedOut) return { held: true, request: inFlight ?? request };
      // A REFUSED write arrives as a REJECTION, not as an answer carrying an error:
      // every v2 client method returns Promise<T> and rejects on an API error, so
      // there is no envelope here to inspect. It travels out of this promise and is
      // caught where the retry already lives — which is what keeps a refusal from
      // retiring the debt and reading as delivered.
      return { held: false, result: bounded.value };
    });
  };
  // The owed write, built once: the queue holds the exact text, so a boot that
  // redelivers it has nothing to reconstruct and no way to say something else.
  // Attempts count from the last boot's, so the record and the queue agree on
  // how many times this parent has already been dialed for this write.
  const carried = opts.carriedAttempts ?? 0;
  const owed = owedDelivery({ childSessionId: opts.childSessionId, kind, parentSessionId }, message, carried);
  // The budget, checked in the GATE and not at the boot loop that offers these
  // debts. `session.prompt` is the only parent-write path there is, so the gate
  // is the only place a debt is ever offered — a check at the boot loop would be
  // a policy decision at one call site, and the in-process re-offer would stay
  // unchecked. After the claim, deliberately: a debt whose write is still in
  // flight is claimed, so it is suppressed rather than expired, and a parent
  // being slow is never written off underneath a request it may still answer.
  const maxAttempts = opts.maxAttempts ?? DEFAULT_PENDING_MAX_ATTEMPTS;
  if (carried >= maxAttempts) {
    // Written off rather than dialed. This is the only branch in the gate that
    // ends a debt WITHOUT asking the host anything, and it is the whole point:
    // redelivering is `session.prompt`, so an attempt is not a free retry — it
    // is a real user turn in the parent's session, which is why a host that
    // holds one write per boot wedged the project instead of merely falling
    // behind. The debt is retired, the claim is released so a genuinely new
    // notice for this child is not suppressed by a write-off, and the record
    // says EXPIRED so the parent is not told a failure that will be retried.
    gateLedger.retire(claim);
    gateLedger.release(claim);
    dropPending(owed);
    if (epoch === currentGateEpoch()) emit({ attempts: carried, delivered: false, expired: true });
    // The host log, for the same reason every other durable-state loss goes
    // there: the notification ledger is in-memory, so this record dies with the
    // process, and the parent may never open a status view. This is the only
    // channel an operator is guaranteed to have without setting an environment
    // variable before the process started, and the fact being reported is one
    // they have to act on — the parent session is not accepting writes, and
    // nothing will be retried.
    void safeLog("warn", `Dynamic task plugin: a ${kind} notification to parent ${parentSessionId} for task ${opts.childSessionId ?? "(root)"} ` +
      `was given up on after ${carried} attempt(s) and will not be retried. The parent session is not accepting writes. ` +
      `The parent has NOT been told — read this task's status from the parent session to see the write-off.`);
    return Promise.resolve(false);
  }
  // Owed BEFORE the dial, every attempt: the debt must be on disk while the
  // request is in flight, because that window is the crash this exists for.
  // A dropped debt is a notice the operator will never be told exists, so it is
  // said out loud here rather than only in the queue's shape: the one channel an
  // operator has without setting an environment variable first is the host log.
  const dial = (attempts: number): Promise<Attempt> => {
    announceDropped(queuePending({ ...owed, attempts: carried + attempts }));
    return attempt();
  };
  const commit = (outcome: DeliveryOutcome) => {
    // Three kinds of staleness, checked before anything is written.
    //
    // Retired: this debt spent its redelivery budget and has been written off.
    // A host can answer a write whose obligation has already ended — the
    // request outlives the budget whenever it outlives the process that made
    // it, and a revival frees the claim so a second entry can spend the budget
    // while the first request is still on the wire. That answer is not a
    // delivery: the debt is gone and a newer generation owns the key. Emitting
    // here would tell the operator a notice arrived that the plugin has
    // already written off, and would be the last word on the record.
    if (gateLedger.isRetired(claim)) return outcome.delivered;
    // Generation-bound: a revival (forgetChild) between this claim and this
    // commit makes the generation stale — history is emitted, the key is not
    // reserved, and the revived turn's claim stays intact.
    // Epoch-bound: a whole-gate reset between the claim and this commit means
    // the gate no longer knows this child at all, and the record belongs to a
    // world that is gone. Nothing is emitted and nothing is reserved.
    if (epoch !== currentGateEpoch()) return outcome.delivered;
    gateLedger.release(claim);
    if (outcome.delivered) gateLedger.record(claim);
    // Retire the debt, then write the receipt: a crash in between costs a
    // redelivery the operator can see, never a record with no notice behind it.
    dropPending({ ...owed, attempts: outcome.attempts });
    emit(outcome);
    return outcome.delivered;
  };
  const run = async (): Promise<boolean> => {
    // A debt that has ALREADY been refused once, offered to a parent that is
    // mid-turn, is DEFERRED rather than written. Measured 2026-09-28: a parent
    // was admitted a turn that never reached the model and never exited, so the
    // host held every prompt after it and the whole project became un-typeable.
    // Both of those turns were this line re-offering one owed debt into a
    // session that had already refused one — a boot-time write compounding a
    // wedge on every restart, which is why it read as a bug that kept coming
    // back. A held write is not evidence a notice is undeliverable, so the debt
    // is kept and offered again.
    //
    // Gated on `carried > 0` on purpose, and that asymmetry is the whole design:
    // 46 notices in that same session each drew a completed turn, most written
    // while the parent was busy, because the host HOLDS a write to a mid-turn
    // session and delivers it when the turn ends. A first attempt must keep
    // making itself, or every settlement that lands during a parent's own turn
    // would wait for a restart to be heard. Only a debt the parent has already
    // refused is evidence it cannot take one.
    //
    // The attempt is SPENT, and that is the second half of the decision. A
    // deferral is a boot that offered the debt and did not deliver it, so it
    // costs the debt the same as a held write did; a deferral that cost it
    // nothing was a debt the bound could never reach, because `carried` was
    // carried into itself and the write-off above stayed forever out of range.
    // That is not hypothetical: it re-armed at its own count in a live project
    // whose debt re-injected a synthetic user turn at every boot forever
    // (attempts 6→7 across six boots) and made it un-typeable. The bound is the
    // only thing standing between one wedged parent and an infinite retry, so
    // every path that does not deliver spends toward it — including this one.
    if (carried > 0) {
      const refusal = await parentRefusal(host, parentSessionId);
      if (refusal !== null) {
        // Still queued, because the debt must outlive this process either way: the
        // window where a notification exists in memory and on no disk is the crash
        // the queue exists for, and a refusal is not a reason to lose it. The
        // re-armed count is the one this boot spent.
        const dropped = queuePending({ ...owed, attempts: carried + 1 });
        if (epoch === currentGateEpoch()) emit({ attempts: carried + 1, delivered: false, pending: true });
        void safeLog("warn", `Dynamic task plugin: ${parentSessionId} will not take this notification — it is ${refusal}. The write was not attempted, and the debt is still owed (attempt ${carried + 1} of ${maxAttempts}); it is written off when that bound is crossed.`);
        announceDropped(dropped);
        // The claim goes back, because nothing was written and the debt is still
        // live: holding it would make every LATER obligation for this child and
        // kind permanently unwritable, because this is a refusal rather than a
        // delivery and no revival is coming to clear it.
        if (epoch === currentGateEpoch()) gateLedger.release(claim);
        return false;
      }
    }
    // The request is made ONCE and kept, because "slow" and "never" are the
    // same call from here: its answer may arrive long after this returns, and
    // the ledger must be able to say so rather than guess which it was.
    let outcome: Attempt;
    try {
      outcome = await dial(1);
    } catch {
      // A REFUSED write — the caller is told the attempt failed and the gate's
      // one retry is the answer, which is what this has always done.
      await sleep(NOTIFY_RETRY_DELAY_MS);
      try {
        await dial(2);
        return commit({ attempts: carried + 2, delivered: true });
      } catch {
        return commit({ attempts: carried + 2, delivered: false });
      }
    }
    if (outcome.held) {
      const { request } = outcome;
      // Same epoch rule as commit(): the held write is recorded only while the
      // gate still knows the child it belongs to.
      if (epoch === currentGateEpoch()) emit({ attempts: carried + 1, delivered: false, pending: true });
      // A held write is NOT retried — the host may still deliver it, and a
      // second copy of the same kind is the duplicate this gate exists to
      // prevent. The claim stays held while the request is outstanding, so
      // nothing slips in behind it, and the record ends up truthful whenever
      // the host finally answers.
      void request.then(
        () => commit({ attempts: carried + 1, delivered: true }),
        // ONE write was made, so ONE attempt is billed: the second dial never
        // happened, and a record that counts it is a record that spends the
        // parent's budget on attempts that were not made.
        () => commit({ attempts: carried + 1, delivered: false }),
      );
      return false;
    }
return commit({ attempts: carried + 1, delivered: true });
  };
  const prev = notifyChains.get(opts.childSessionId) ?? Promise.resolve();
  const cur: Promise<boolean> = prev.then(run, run);
  notifyChains.set(opts.childSessionId, cur);
  if (notifyChains.size > NOTIFY_CHAIN_MAX) {
    const oldest = notifyChains.keys().next();
    if (!oldest.done) notifyChains.delete(oldest.value);
  }
  void cur.then(
    () => { if (notifyChains.get(opts.childSessionId) === cur) notifyChains.delete(opts.childSessionId); },
    () => { if (notifyChains.get(opts.childSessionId) === cur) notifyChains.delete(opts.childSessionId); },
  );
  return cur;
}

/** Test seam: current per-child delivery chain count. Production never calls this. */
export function notifyChainCount(): number {
  return notifyChains.size;
}

// Notice dedup keys hash the FULL message: a fixed prefix slice collides
// distinct long notices sharing a prefix. FNV-1a, no dependency; length is
// folded in so equal hashes with different lengths still separate.
export function noticeDedupKey(message: string): string {
  let hash = 0x811C9DC5;
  for (let i = 0; i < message.length; i++) {
    hash ^= message.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `notice:${(hash >>> 0).toString(36)}:${message.length}`;
}

// Wire format the parent actually sees. Notification text is owned by the
// gate; task-formatting only renders store reads. One renderer, params
// everywhere the kinds differ: tag, header, body label, tail hint.
export function truncateText(text: string, maxChars = 1200): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}
