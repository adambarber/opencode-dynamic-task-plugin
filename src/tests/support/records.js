/**
 * The record shapes the store writes and the ledger reader reads.
 *
 * Two suites were declaring these between them: a unit suite that needed a record
 * to hand a reader, and an integration suite that needed one to seed a boot. Two
 * spellings of "a task the last boot left behind" is two chances for a field to
 * be added on one side only — and a fixture that omits a field the reader
 * requires does not fail for the reason it was written.
 *
 * Each builder takes its overrides last, so a case states the field its claim is
 * about and inherits the rest. That is the whole discipline: a case may not add a
 * field silently, because the shape here is the reader's input.
 */

/**
 * A task the last boot left behind, settled. `timeoutNotified` is part of the
 * shape because a real retained record carries it — the settlement strips the
 * advisory fields (see activeEntry) but keeps this one.
 */
export const retainedEntry = (overrides = {}) => ({
  childSessionId: "ses_1",
  parentSessionId: "parent_1",
  agentName: "explore",
  description: "t",
  lineage: [],
  state: "completed",
  startedAt: 1,
  retainedAt: 2,
  timeoutNotified: true,
  ...overrides,
});

/**
 * A task the last boot was still running, with the advisory fields an in-memory
 * record carries and a fresh process cannot verify: a mid-flight notice, a
 * heartbeat, a turn-live mark, a replaced-at mark. None of them may reach disk,
 * which is the claim the cases using this shape exist to make — so it is stated
 * here, once, rather than by each case that needs it present.
 */
export const activeEntry = (overrides = {}) => ({
  childSessionId: "ses_2",
  parentSessionId: "parent_1",
  agentName: "general",
  description: "still running",
  lineage: ["general"],
  state: "active",
  startedAt: 1700000000000,
  lastNotice: { message: "mid-flight", at: 1700000000500 },
  lastActivityAt: 1700000000900,
  turnLiveAt: 1700000000900,
  replacedAt: 1700000000100,
  ...overrides,
});

/** The same task as it is FOUND on disk: activeEntry with the advisories stripped. */
export const runningEntry = (childSessionId, overrides = {}) => ({
  childSessionId,
  parentSessionId: "ses_parent",
  agentName: "general",
  description: "running across restart",
  lineage: [],
  state: "active",
  startedAt: 1,
  ...overrides,
});

/**
 * A delivery the plugin owes and has not landed: the exact write, not a recipe to
 * rebuild one, plus how many attempts the previous boot already spent.
 */
export const owedEntry = (overrides = {}) => ({
  parentSessionId: "parent_1",
  childSessionId: "ses_1",
  kind: "completed",
  text: "[dynamic-task-notify]\nsession owed",
  attempts: 1,
  ...overrides,
});
