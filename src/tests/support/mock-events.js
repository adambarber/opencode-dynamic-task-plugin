/**
 * The host's event vocabulary, and what the fake reads back out of it.
 *
 * These names are PRODUCTION's, not the suite's: every one is `satisfies Event["type"]`
 * in host-events.ts, so this module cannot fire an event the host does not publish —
 * the one thing a fixture must never be able to do, because a fixture that invents an
 * event certifies a gate that listens for it. That is exactly how `question.created`
 * shipped. The names BUILD events through `events` rather than being re-exported as a
 * second list, because a suite naming a raw event type would be naming it from a
 * The names BUILD events through `events` rather than being re-exported as a
 * second list, because a suite naming a raw event type would be naming it from a
 * hand-kept copy of this import — the drift the import exists to prevent. They are
 * also re-exported for the modules that read the same events, so the vocabulary has
 * one owner rather than one import per consumer.
 */
export * from "../../../dist/shared/host-events.js";
//jscpd:ignore-start
import {
  FORM_CANCELLED,
  PERMISSION_ASKED,
  PERMISSION_REPLIED,
  SESSION_DELETED,
  SESSION_ERROR,
  SESSION_EXECUTION_INTERRUPTED,
  SESSION_EXECUTION_STARTED,
  SESSION_EXECUTION_SUCCEEDED,
  SESSION_IDLE,
} from "../../../dist/shared/host-events.js";
import { notificationKindOf } from "../../../dist/shared/notification-text.js";
//jscpd:ignore-end
/**
 * A host event envelope: the type the server names, the session it is about, and
 * whatever else it carries. The server's lifecycle event shapes below are all
 * this, and tests used to spell the literals inline, which is how a test can end
 * up asserting against a shape the host never emits.
 */
const hostEvent = (type, id, properties) => ({ data: { sessionID: id, ...properties }, type });

/**
 * The server's lifecycle event shapes, declared once. `updated` and `error` take
 * the inner status so one declaration covers both the plain and error-valued
 * payloads.
 */
export const events = {
  idle: (id, properties = {}) => hostEvent(SESSION_IDLE, id, properties),
  /**
   * A turn at work: the host saying this session is running. It is the first
   * fact a replacement turn produces, and therefore the life sign that lets that
   * turn's ending be attributed to it rather than to the turn it replaced.
   *
   * v2 replaced the readable status channel with EXECUTION events — started,
   * succeeded, interrupted, failed — and every one of those is declared in
   * `host-events.ts` with `satisfies HostEventType`, so a fixture cannot invent a
   * fifth. A `session.status` here would have been a shape no host emits, which is
   * exactly how `question.created` shipped.
   */
  working: (id) => hostEvent(SESSION_EXECUTION_STARTED, id),
  /** The turn that ended well. Its counterpart to `working`, and named as such. */
  succeeded: (id) => hostEvent(SESSION_EXECUTION_SUCCEEDED, id),
  /** The turn the operator cut short — a third ending, distinct from failure. */
  interrupted: (id) => hostEvent(SESSION_EXECUTION_INTERRUPTED, id),
  deleted: (id, properties = {}) => hostEvent(SESSION_DELETED, id, properties),
  // The failure event carries an error detail, never a status field.
  error: (id, error) => hostEvent(SESSION_ERROR, id, error ? { error } : {}),
  /**
   * The host ASKING a permission, verbatim from the v2 manifest: `permission.asked`
   * carries `{id, sessionID, action, resources}` and no options at all. An absent
   * `sessionID` is the unattributable ask the gate must never touch.
   */
  permissionAsked: (sessionID, properties) => ({
    data: { ...(sessionID ? { sessionID } : {}), ...properties },
    type: PERMISSION_ASKED,
  }),
  /** The ask a live child would raise, spelled the way the manifest spells it. */
  ask: (sessionID, requestId, action = "edit") => events.permissionAsked(sessionID, { action, id: requestId, resources: [] }),
  /** The retirement of an ask — a decision, so it is a settlement the gate does not owe anyone. */
  permissionReplied: (props) => ({ data: props, type: PERMISSION_REPLIED }),
  permissionCancelled: (props) => ({ data: props, type: FORM_CANCELLED }),
};

/**
 * The text one prompt body carries, with the parts envelope stripped. Tolerant of a
 * body carrying no text part, because the two readers that classify a prompt by its
 * marker run before anything knows the body has parts at all — a strict reader there
 * throws inside a mock instead of reporting the prompt as not-a-notification.
 */
export const promptText = (args) => args?.text || "";

/**
 * One funnel for "the parent has now been sent this", and it classifies.
 *
 * Two capture sites typed the same record by hand, so the KIND rode nowhere: every
 * settlement case then told a success from a failure by the REGISTER of the prose,
 * which is how the corpus mis-read an ended turn as a finished job. A record is
 * therefore built here once, carrying the kind the payload declares — and a
 * parent-directed payload that declares none is a PLUGIN bug, so it throws at the
 * capture rather than entering the ledger as an unlabelled notice.
 */
export const noticeRecord = (to, text) => {
  const kind = notificationKindOf(text);
  if (!kind) {
    throw new Error(`parent-directed payload carries no Kind field:\n${text}`);
  }
  return { kind, message: text, to };
};

/**
 * …and the one place a notice joins the ledger, kept separate from classifying it
 * so a REJECTED attempt stays undelivered. Classifying and capturing together
 * counted a failed dial as a delivery and doubled every redelivery case.
 */
export const captureNotice = (state, record) => state.notifications.push(record);

/**
 * The ONE "this session is gone" error the mock transport reports. Three
 * conditions produce it — a session the host never had, a test-declared failure
 * id, and a gate released with `fails` — and they share the message on purpose:
 * a test asserting what the transport said must not be able to tell which
 * scenario it hit, because what the server says is the contract and the
 * condition is only the story that produces it. Spelled three times, the message
 * was three chances to drift away from the server's own wording.
 */
