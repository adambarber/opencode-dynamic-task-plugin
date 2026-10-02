// src/shared/host-events.ts
// The ONE place a host event name is spelled, and the ONE place a host event's
// payload is read. Both are pinned to the host's own declarations.
//
// Why this file exists: the question gate shipped matching an event the host
// never publishes, with a fixture that invented the missing event, so the suite
// was green against a host that does not exist. A name here is `satisfies
// HostEventType`, which makes "the host never publishes this" a build error.

import type { OpenCodeEvent } from "@opencode/client/promise";
import { eventField, isEventRecord } from "./host-shape.js";

/** The host's event union — the source of truth for every name below. */
export type HostEventType = OpenCodeEvent["type"];

/** One host event, narrowed to the shape the host declares for that name. */
export type HostEvent<T extends HostEventType> = Extract<OpenCodeEvent, { type: T }>;

// v2 renamed the ask channel: `question.asked` became `permission.asked`, and the
// payload moved from `properties` to `data`. The RETIRED names have no reader, so
// a vocabulary that lists only what is read is one a reader cannot trust.
export const PERMISSION_ASKED = "permission.asked" satisfies HostEventType;
export const PERMISSION_REPLIED = "permission.replied" satisfies HostEventType;
export const FORM_CREATED = "form.created" satisfies HostEventType;
export const FORM_CANCELLED = "form.cancelled" satisfies HostEventType;

// The turn-ending events, spelled here for the same reason: a lifecycle branch
// that names a session event nobody publishes would be equally invisible.
export const SESSION_IDLE = "session.idle" satisfies HostEventType;
export const SESSION_ERROR = "session.execution.failed" satisfies HostEventType;
export const SESSION_DELETED = "session.deleted" satisfies HostEventType;
export const SESSION_EXECUTION_STARTED = "session.execution.started" satisfies HostEventType;
export const SESSION_EXECUTION_SUCCEEDED = "session.execution.succeeded" satisfies HostEventType;
export const SESSION_EXECUTION_INTERRUPTED = "session.execution.interrupted" satisfies HostEventType;

/** True when the host asked something this plugin settles. */
export function isHostAsked(type: string): boolean {
  return type === PERMISSION_ASKED || type === FORM_CREATED;
}

/** True when the turn ended, one way or the other. */
export function isTurnEnding(type: string): boolean {
  return type === SESSION_IDLE || type === SESSION_ERROR;
}

type AskedData = HostEvent<typeof PERMISSION_ASKED>["data"];

function isAskedData(value: unknown): value is AskedData {
  if (!isEventRecord(value)) return false;
  return typeof value.sessionID === "string" && typeof value.id === "string";
}

/** What the gate learns from an ask. */
export interface HostAsk {
  /** The host's own id for the ask — the `requestID` a reply carries. */
  askId: string;
  sessionId: string;
}

/**
 * Read an ask in the host's shape, or null if it is not one.
 *
 * There is no answer to compute: a v2 permission is allow/deny with no options and
 * no labels, so the gate settles it by DENYING (see `question-handling.ts`) rather
 * than by choosing. Both ids are required, because a reply carries both.
 */
export function readHostAsk(event: unknown): HostAsk | null {
  const data = eventField(event, "data");
  if (!isAskedData(data)) return null;
  return { askId: data.id, sessionId: data.sessionID };
}