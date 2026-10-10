/**
 * The record shapes the tests seed — every one of them built by the production
 * function that builds the real one. A fixture that hand-rolls a record is a
 * second declaration of a shape with no compiler over it, and this file is where
 * that cost had already been paid: a retained fixture carried `timeoutNotified`, a
 * field production deleted along with the removal of `timeout_ms`, and an active
 * fixture shipped a `lastNotice` without the `claim` the settlement reads to tell a
 * blocked child from a finished one — so a fixture used in a settlement would have
 * settled a blocked child as a success. A green suite reported neither. That is the
 * argument for building fixtures out of the production builders rather than beside
 * them: a fixture that cannot disagree with production is the only kind that needs
 * no test to watch it.
 *
 * What is left here is each case's SCENARIO — which session, which agent, what the
 * claim is about — and never a field list. Overrides go last, so a case still
 * states the one fact it is about.
 */

import {annotateNotice, markTurnReplacement} from "../../../dist/shared/notice-claim.js";
import { notifyRecord, owedDelivery } from "../../../dist/shared/notify.js";
import { UNKNOWN_PARENT } from "../../../dist/shared/session-lifecycle.js";
import {
  activeRecord,
  createTaskStore,
  noteActivity,
  registerActiveTask,
  retainedRecord,
  withoutAdvisory,
} from "../../../dist/shared/task-state.js";

/** The registration a spawn hands the store. No `state`: production adds that. */
const registration = (overrides = {}) => ({
  agentName: "explore",
  childSessionId: "ses_1",
  description: "t",
  lineage: [],
  parentSessionId: "parent_1",
  ...overrides,
});

// Fixed clocks rather than Date.now(), so a fixture that lands on disk reads the
// same on every run and a case can assert an age.
const STARTED_AT = 1;
const SETTLED_AT = 2;

/** A task the last boot left behind, settled — the settlement's own builder. */
export const retainedEntry = (overrides = {}) => ({
  ...retainedRecord(
    activeRecord(registration(), STARTED_AT),
    overrides.state ?? "completed",
    overrides.retainedAt ?? SETTLED_AT,
  ),
  ...overrides,
});

/**
 * A task the last boot was still running, with the advisory fields an in-memory
 * record carries and a fresh process cannot verify: a mid-flight notice, a
 * heartbeat, a turn-live mark, a replaced-at mark. None of them may reach disk,
 * which is the claim the cases using this shape exist to make.
 *
 * They are stamped by the functions that stamp them, on a real store, because the
 * alternative is a fixture asserting a field list that only resembles the code
 * writing it. The store is the only thing that can hold a live record, so building
 * one means running the production mutations that produce it.
 */
export const activeEntry = (overrides = {}) => {
  const store = createTaskStore();
  const { childSessionId } = registerActiveTask(
    store,
    registration({ agentName: "general", childSessionId: "ses_2", description: "still running", lineage: ["general"] }),
    undefined,
  );
  annotateNotice(store, childSessionId, "mid-flight", "progress");
  noteActivity(store, childSessionId, false);
  markTurnReplacement(store, childSessionId);
  return { ...store.activeTasks.get(childSessionId), ...overrides };
};

/**
 * The same task as it is FOUND on disk: an active record carrying only what a
 * fresh process can verify, which is `withoutAdvisory` — the one list of those
 * fields, and the same strip the settlement performs.
 */
export const runningEntry = (childSessionId, overrides = {}) => ({
  ...withoutAdvisory(activeEntry({ childSessionId, parentSessionId: "ses_parent" })),
  ...overrides,
});

/**
 * A delivery record from the gate's own builder, so a case names the outcome it is
 * about — delivered how many times, suppressed, held — rather than the fields of a
 * NotificationRecord. `at` and `message` are filled by the code that fills them,
 * because a case asserting a rendering is not asserting on a clock.
 */
export const notifiedAs = (kind, outcome, target = {}) =>
  notifyRecord({ childSessionId: "ses_1", kind, parentSessionId: UNKNOWN_PARENT, ...target }, "delivered", outcome);


/**
 * A delivery the plugin owes and has not landed: the exact write, not a recipe to
 * rebuild one, plus how many attempts the previous boot already spent.
 */
/**
 * An owed notice AS THE HOST HOLDS IT. The clock is part of the record rather than a
 * side table, because the queue is ordered by it and a boot that could not read it
 * would deliver in an order that changes run to run. A fixture without it is a
 * record the production reader drops — which is exactly what it was.
 */
export const owedEntry = (overrides = {}) => ({
  ...owedDelivery(
    { childSessionId: "ses_1", kind: "completed", parentSessionId: "parent_1" },
    "[dynamic-task-notify]\nsession owed",
    1,
  ),
  owedAt: Date.now(),
  ...overrides,
});
