/**
 * The durable record of a create that was ISSUED.
 *
 * A `session.create` bound reports on a deadline and does not cancel: the request was
 * handed to the host, so the session may exist while the plugin has no id for it. That
 * is the one place a dispatch has an outcome it cannot look up, and the idless-answer
 * orphan beside it (`voice.createFailed`) has always had to be found by hand — the
 * parent is told a title and a parent id and asked to grep a session list.
 *
 * So the record is written BEFORE the create goes out, keyed by the two facts that
 * already exist at that moment, and DROPPED the moment the create answers. The id is
 * never stored here: it is the ledger's job, and a record that outlived its window
 * would be a second place the child lives.
 *
 * Which makes the answer a lookup with a binary result. Record present: the create was
 * issued and never answered, so the session may or may not exist. Record gone: it
 * answered, and the child is in the ledger under the same title. There is no third
 * state to distinguish and no way to read one without reading the other.
 *
 * A title repeats — "investigate the flaky test" twice under one parent is ordinary —
 * and two unresolved creates sharing a key would overwrite each other. The window is
 * one create wide, and the alternative is the lookup this record exists to replace.
 * It is named here because it is a limit and not an accident.
 */

import { recordKey } from "./state-facade.js";

/** The durable prefix every issued-but-unanswered create lives under. */
export const CREATE_INTENT_PREFIX = "create-intent";

/** What was asked for, and under what — the whole of what is knowable before the id. */
export interface CreateIntent {
  readonly parentSessionId: string | null;
  readonly title: string;
}

/**
 * One intent's address.
 *
 * `null` is a real parent value — a child dispatched from no parent — so it is
 * spelled rather than dropped, because dropping it would put a root child in the same
 * bucket as a child whose parent id the caller never had.
 */
export function createIntentKey(intent: CreateIntent): string {
  return recordKey(CREATE_INTENT_PREFIX, intent.parentSessionId ?? "", intent.title);
}

/**
 * `create-intent` — the guard a lookup validates against, so a record that fails it is
 * withheld and counted rather than handed to a caller as a live create.
 */
export function isCreateIntent(value: unknown): value is CreateIntent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as { parentSessionId?: unknown; title?: unknown };
  if (typeof record.title !== "string") return false;
  return record.parentSessionId === null || typeof record.parentSessionId === "string";
}

/**
 * Record the intent. Awaiting durability is the caller's business: an intent that
 * never reaches the host is still worth having in memory for the late answer, and a
 * dispatch refused because its own bookkeeping could not be stored would be a worse
 * outcome than a dispatch nobody can look up afterwards.
 */
export function issueCreateIntent(store: IntentStore, intent: CreateIntent): void {
  store.put(createIntentKey(intent), JSON.stringify(intent));
}

/** The create answered, one way or the other: the ledger now holds the child. */
export function resolveCreateIntent(store: IntentStore, intent: CreateIntent): void {
  store.drop(createIntentKey(intent));
}

/** The narrow write surface this needs, so a caller need not offer the whole store. */
export interface IntentStore {
  put: (key: string, value: string) => void;
  drop: (key: string) => void;
}

/**
 * The writer, bound to the one durable chain.
 *
 * A facade, not the store: an intent is written and dropped on the dispatch path, and
 * handing a tool a second `createStore` would give it a second write chain that can
 * reorder against the ledger write the create precedes.
 */
export function createIntentWriter(store: IntentStore): IntentStore {
  return { drop: (key) => store.drop(key), put: (key, value) => store.put(key, value) };
}