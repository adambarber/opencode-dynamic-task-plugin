// src/shared/client.ts
// The v2 host boundary — the single home for "what the host is".
//
// v2 is domain-shaped, not client-shaped: there is no `client` object at all. The
// host hands the plugin a `Context` of typed domains (session, agent, event, tool,
// location, permission), so a namespace access is no longer a property walk on one
// client — it is a named field of a domain object we hold wholesale.
//
// Everything else here is unchanged in purpose: production still holds an
// `OpaqueHost` rather than the host, and the only way out is `callHost`, so a
// deadline is an argument at the call rather than a scan finding above it.

//jscpd:ignore-start
import type { Context } from "@opencode/plugin/promise/plugin";
import { type BoundArgs, type Bounded, expired, withBound } from "./execution-bound.js";
import { isEventRecord } from "./host-shape.js";

//jscpd:ignore-end
/** The host, as v2 defines it: a set of typed domains and no client. */
export type OpenCodeClient = Context;

// The brand that keeps a host namespace out of production's reach. Module-private,
// so nothing outside can spell the key; a real `Symbol` because it is read at runtime.
const HOST: unique symbol = Symbol("opaque-host");

// What production is given instead of the host. Boundedness used to rest on a scan
// reading the lines above each call, blind to an indirect receiver.
export interface OpaqueHost<C = OpenCodeClient> { readonly [HOST]: C }

/** Mint the one value production holds — from the plugin entry, nowhere else. */
export function asOpaqueHost<C>(context: C): OpaqueHost<C> {
  return { [HOST]: context };
}

/**
 * The only way out of an `OpaqueHost`: the real host, under a stated deadline.
 *
 * `work` must RETURN a promise, and `timedOut` is a value rather than a thunk. Both
 * shapes are here because this chokepoint shipped two ways to be wrong while it read
 * as bounded: a synchronous probe was bounded instead of the await inside it, and a
 * thunk that THREW ran inside the timer and left this promise pending forever.
 */
export async function callHost<C, T, D = T>(
  host: OpaqueHost<C> | undefined | null,
  ...[ms, work, timedOut]: BoundArgs<C, T, D>
): Promise<Bounded<T, D>> {
  return host == null ? expired(timedOut) : withBound(ms, () => work(host[HOST]), timedOut);
}

/**
 * Look at the host's SHAPE without dialling it: a synchronous read, so there is
 * no request to bound. `callHost` is the other question — it asks the host
 * something and needs a deadline.
 */
export function probeHost<C, T>(host: OpaqueHost<C>, inspect: (client: C) => T): T {
  return inspect(host[HOST]);
}

/** How a fire-and-forget write reports a failure when nobody awaits the promise. */
export type FailureReporter = (error: unknown) => void;

/**
 * The deliberate exception, typed rather than listed in a test file.
 *
 * Three calls are fire-and-forget by contract, so a deadline bounds nothing. The
 * `void` return is what turns the exemption into a decision: a future edit that
 * awaits one fails to compile instead of restoring a wait the gate ignores.
 */
export function fireAndForget(
  host: OpaqueHost,
  work: (client: OpenCodeClient) => unknown,
  onFailure?: FailureReporter,
): void {
  void Promise.resolve(work(host[HOST])).catch((error: unknown) => {
    // Swallowed only when there is nobody to tell. A caller that classifies the
    // failure passes `onFailure`, so the report is not lost to this shape.
    onFailure?.(error);
  });
}

/**
 * Whether this host's context really carries a permission reply.
 *
 * The premise behind every ask settlement is a type, and a load-bearing type is a
 * promise somebody has to keep. The caller turns a `false` into a refusal it can
 * report, which is the outcome a throw could not produce. The cast widens to an
 * untyped map to ASK whether the key exists, which is the question — not an answer.
 */
export function hasPermissionReply(host: OpenCodeClient): boolean {
  const {permission} = (host as { permission?: Record<string, unknown> });
  return typeof permission?.reply === "function";
}

/**
 * The three calls the tool map needs, asked the way a shape is asked.
 *
 * Widened to an untyped map because the runtime truth is a PARTIAL context, and
 * asking whether a key exists is the question — not asserting an answer.
 */
export function hasCoreApis(host: OpenCodeClient): boolean {
  // The runtime truth can be a PARTIAL context, so each level is narrowed
  // before the next is read; a missing level answers false, never throws.
  if (!isEventRecord(host)) return false;
  const {agent} = host;
  const {session} = host;
  if (!isEventRecord(agent) || !isEventRecord(session)) return false;
  return (
    typeof agent.list === "function" &&
    typeof session.create === "function" &&
    typeof session.prompt === "function"
  );
}