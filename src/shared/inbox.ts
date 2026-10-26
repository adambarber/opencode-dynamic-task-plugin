// src/shared/inbox.ts
// The host-native Session Inbox (v2.1.4+): the capability verdict and the one
// widening that reaches it.
//
// Every host prompt goes through a durable Session Inbox and carries a delivery
// verdict (verified against the v2.1.4 source, packages/core/src/session/inbox.ts
// and the installed @opencode/client, promise/client.d.ts:47/61-65 and
// effect/api/api.d.ts:318 — `SessionPromptInput.delivery?`):
//
//   "steer"  — promoted at the next step boundary of a RUNNING turn. No abort;
//              the in-flight model step completes, then the promoted input joins
//              the loop.
//   "queue"  — parks in the host's inbox table until the turn ends, then becomes
//              the next turn on its own. A steer-scoped drain never promotes it.
//
// A host below v2.1.4 has no inbox surface and no delivery verdict, so the plugin
// probes ONCE at boot — the same shape-read the other capability probes are — and
// every inbox feature branches on the stored verdict. There is no host-version pin:
// a below-inbox host boots exactly as it always did, on the legacy paths.

import type { OpenCodeClient } from "./client.js";
import { isEventRecord } from "./host-shape.js";

// The boot's verdict, process-global like the live caps it mirrors. Read by the
// tool paths and the gate; written once per boot by `initPluginState`.
let inboxCapable = false;

/** Store this boot's capability verdict. Called once, from the state boot. */
export function installInboxSupport(supported: boolean): void {
  inboxCapable = supported;
}

/** Did this boot's host present the Session Inbox surface? */
export function inboxSupported(): boolean {
  return inboxCapable;
}

/**
 * Look at the host's SHAPE for the Session Inbox, without dialling it.
 *
 * The surface IS the capability: a host that answers `session.inbox.list` is the
 * host that gave `session.prompt` its delivery verdict — they shipped together in
 * v2.1.4 — and a shape read is synchronous, so the boot pays no request for the
 * question. Widened to untyped maps because the installed plugin types are older
 * than the host: asking whether the namespace exists is the question, not
 * asserting an answer the type layer cannot spell yet.
 */
export function hasInboxSupport(host: OpenCodeClient): boolean {
  // Each level is narrowed before the next is read — a missing level answers
  // false, never throws (the same contract hasCoreApis keeps). The levels are
  // read through untyped aliases because the installed plugin types predate the
  // namespace: the RUNTIME truth is what is being asked about.
  if (!isEventRecord(host)) return false;
  // `session` is not in the installed plugin types' client surface, so the read
  // goes through the index signature the guard proved — property access, not an
  // assertion, and each level narrowed before the next is read.
  const { session } = host as Record<string, unknown>;
  if (!isEventRecord(session)) return false;
  const { inbox } = session as { inbox?: unknown };
  if (!isEventRecord(inbox)) return false;
  return (
    typeof inbox.list === "function" &&
    typeof inbox.cancel === "function" &&
    typeof inbox.update === "function"
  );
}
