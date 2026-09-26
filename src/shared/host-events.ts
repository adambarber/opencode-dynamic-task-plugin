// src/shared/host-events.ts
// The ONE place a host event name is spelled, and the ONE place a host event's
// payload is read. Both are pinned to the SDK's own declarations.
//
// Why this file exists: the question gate shipped matching an event the host
// never publishes. It watched `question.created`; opencode publishes
// `question.asked`, carrying `questions: QuestionInfo[]` rather than the
// `answers` the gate was reading — and a fixture had invented the missing
// event, so the suite was green against a host that does not exist. Nothing
// about that was checkable, because the name was a bare string literal and the
// shape was read field-by-field off an `unknown`.
//
// So a name here is `satisfies HostEventType` — a name the SDK does not declare
// does not compile, which makes "the host never publishes this" a build error
// instead of a branch that silently never runs. And a payload is read through a
// guard that validates exactly the fields the gate consumes, returning the
// SDK's own declared type, so a field the host does not carry cannot be read as
// if it were there. A name is not correct because a test says so; the test
// proves behaviour. The types make the name true.

import type { Event } from "@opencode-ai/sdk/v2/types";
import { eventField, isEventRecord } from "./host-shape.js";

/** The host's event union — the source of truth for every name below. */
export type HostEventType = Event["type"];

/** One host event, narrowed to the shape the host declares for that name. */
export type HostEvent<T extends HostEventType> = Extract<Event, { type: T }>;

// The question events this plugin consumes. opencode 1.18.30 publishes both the
// v1 and v2 spellings; they are structurally identical, so both are handled by
// one reader rather than by two drifting copies.
//
// The RETIRED names have no reader, deliberately: the gate dispatches on asked
// only, so a retired question is a question the gate correctly does not answer,
// and the suite proves that by firing real retired events. The names are here
// because this block is the ONE place a host event name is spelled, and a
// vocabulary that lists only the events something happens to read is a
// vocabulary a reader cannot trust to be complete.
export const QUESTION_ASKED = "question.asked" satisfies HostEventType;
export const QUESTION_V2_ASKED = "question.v2.asked" satisfies HostEventType;
export const QUESTION_REPLIED = "question.replied" satisfies HostEventType;
export const QUESTION_REJECTED = "question.rejected" satisfies HostEventType;
export const QUESTION_V2_REPLIED = "question.v2.replied" satisfies HostEventType;
export const QUESTION_V2_REJECTED = "question.v2.rejected" satisfies HostEventType;

// The turn-ending events, spelled here for the same reason: a lifecycle branch
// that names a session event nobody publishes would be equally invisible.
export const SESSION_IDLE = "session.idle" satisfies HostEventType;
export const SESSION_ERROR = "session.error" satisfies HostEventType;
export const SESSION_DELETED = "session.deleted" satisfies HostEventType;
// The host's status channel — how liveness is read. It is here because the test
// harness had to spell it: a chokepoint with a hole in it is a chokepoint the
// caller routes around, and the caller then owns a name nothing checks.
export const SESSION_STATUS = "session.status" satisfies HostEventType;

/** True when the host published an asked question, under either spelling. */
export function isQuestionAsked(type: string): boolean {
  return type === QUESTION_ASKED || type === QUESTION_V2_ASKED;
}

/** True when the turn ended, one way or the other. */
export function isTurnEnding(type: string): boolean {
  return type === SESSION_IDLE || type === SESSION_ERROR;
}

// The asked payload, as the host declares it under either spelling. Only the
// fields the gate consumes are validated, because only those it may read.
type AskedProperties =
  | HostEvent<typeof QUESTION_ASKED>["properties"]
  | HostEvent<typeof QUESTION_V2_ASKED>["properties"];

function isAskedProperties(value: unknown): value is AskedProperties {
  if (!isEventRecord(value)) return false;
  return typeof value.sessionID === "string" && typeof value.id === "string" && Array.isArray(value.questions);
}

/** What the gate learns from an asked question. */
export interface AskedQuestion {
  questionId: string;
  sessionId: string;
  /**
   * The single answer the gate can give, or null when it cannot give one.
   *
   * The reply endpoint takes `answers: Array<QuestionAnswer>` — one entry per
   * question asked. A multi-part ask therefore CANNOT be answered by the gate
   * with one string: answering the first part and leaving the rest would
   * retire the question with the child never having seen the other answers. So
   * "more than one question" and "no options" both yield null, and null is a
   * rejection rather than a silence.
   */
  answer: string | null;
}

/** Read an asked question in the host's shape, or null if it is not one. */
export function readAskedQuestion(event: unknown): AskedQuestion | null {
  const properties = eventField(event, "properties");
  if (!isAskedProperties(properties)) return null;
  const single = properties.questions.length === 1 ? properties.questions[0] : undefined;
  const label = single?.options[0]?.label;
  return {
    questionId: properties.id,
    sessionId: properties.sessionID,
    answer: label !== undefined && label.length > 0 ? label : null,
  };
}
