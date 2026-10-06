/**
 * Type-level pins for the host's session vocabulary. Nothing here runs and nothing
 * imports this file: the COMPILER is the assertion.
 *
 * These exist because every defect fixed alongside this file was a defect the
 * compiler COULD have caught and did not, and each one is pinned at the coercion
 * rather than at the symptom:
 *
 *   - `reading.hostState === null` read "no key in the status map" as "no such
 *     session", inventing an error for every child a restart left running.
 *   - v1's `session.status` was a map that DELETED its key on idle, so "no turn
 *     running" and "no such session" looked identical. v2 has no such call on the
 *     plugin surface; liveness now derives the answer from the transcript's own
 *     `time.completed`, which is durable and survives a restart.
 *   - a transcript read that never answered read as "no turn running" — silence
 *     resolved as a fact, the same error one layer down.
 *
 * `@ts-expect-error` is not a bypass and nothing is silenced here. The directive
 * ASSERTS an error exists on the next line; if the regression it guards returns,
 * `npx tsc --noEmit` — the authoritative gate — fails as an UNUSED directive. That
 * is the opposite of `any`, which fails silently in the same situation.
 */
//jscpd:ignore-start
import type { HostTurnWord } from "../shared/liveness.js";

//jscpd:ignore-end
// ── the turn verdict is the host's, so an invented one cannot be read as it ──
declare const quiesced: { type: "quiesced" };
// @ts-expect-error  v2 declares exactly three verdicts for a completed execution
// ("succeeded" | "failed" | "interrupted"). A word the host has not declared cannot
// be read as one — which is the mistake this file was rewritten for: the plugin had
// its OWN "running" word for a MESSAGE field, and a verdict it could not declare.
const refusedWord: HostTurnWord = quiesced.type;

// ── every declared verdict is assignable, so the union cannot silently narrow ──
declare const anyVerdict: HostTurnWord;
const ended: "succeeded" | "failed" | "interrupted" = anyVerdict;

// ── absence is NOT a verdict, so "no execution finished" cannot be spelled as one ──
// @ts-expect-error  `undefined` is the ABSENCE of a verdict — the turn is still open —
// and the type says so by not including it. Reading it as one is how a live child
// reads as settled, which is the defect these pins now exist for.
const invented: HostTurnWord = undefined;

// ── and the union is CLOSED, so a verdict added upstream is a build error ──
// @ts-expect-error  A verdict the host added cannot be passed off as a declared one.
const renamed: HostTurnWord = "completed";

export type _HostPins = [typeof refusedWord, typeof ended, typeof invented, typeof renamed];

// ── BOUNDEDNESS IS A TYPE: production cannot reach a host namespace ──
// Tenet 2 ("every outbound host call is bounded") was held by a scan reading
// production text, which cannot see a call reached through an indirect receiver —
// the one defect it missed was `hostLogCall(client)`, an unbounded `safeLog` that
// stopped plugin init silently, because the log was what hung.
//
// So boundedness moves into the type: production holds `OpaqueHost`, which has no
// namespaces, so naming one is a BUILD FAILURE.
import { asOpaqueHost, type OpaqueHost, type OpenCodeClient } from "../shared/client.js";

declare const host: OpaqueHost;

// @ts-expect-error  THE PIN. Naming a host namespace through the value production
// was given is the only way an outbound call escapes `client.ts`. An UNUSED
// directive means opacity was weakened and boundedness is a scan finding again.
const escapesTheChokepoint = await host.session.interrupt({ sessionID: "ses_x" });

// ── and the mint is the ONLY way to obtain one ──
// The brand is a `unique symbol`, so no literal can carry the key. The fixture is
// the DECISIVE one — a REAL context under the brand's NAME — because a weakened
// brand compiles clean against a fixture that never looked like a host.
declare const realContext: OpenCodeClient;
declare const spellsTheBrand: { __host: OpenCodeClient };
// The mint ACCEPTS a real host — otherwise opacity would be satisfied by refusing
// the host entirely, which compiles as cleanly as a real brand does.
const mintedFromReal: OpaqueHost = asOpaqueHost(realContext);
// @ts-expect-error  A literal cannot carry a `unique symbol` key, so no object can
// stand in for a minted host. This compiles clean if the brand becomes a string.
const forgedHost: OpaqueHost = spellsTheBrand;

// ── and the host is a set of DOMAINS, so a v1-shaped claim cannot pass for one ──
declare const v1Client: { app: { agents: () => Promise<unknown> }; session: { prompt: unknown } };
// @ts-expect-error  The host is now `{id, setup}(Context)` — domain-shaped, with
// `agent.list` and a flat `session.prompt({sessionID, text})`. A v1 client satisfies
// none of it, so the old entry's cast can no longer be smuggled back in.
const v1IsNotAContext: OpenCodeClient = v1Client;

export type _OpaqueHostPins = [
  typeof escapesTheChokepoint,
  typeof mintedFromReal,
  typeof forgedHost,
  typeof v1IsNotAContext,
];