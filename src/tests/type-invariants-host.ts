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
 *   - `OVER_HOST_STATES` was a `Set` of hand-written words, so a word the host had
 *     not added yet read as "not a status" and settled a working child.
 *   - a status channel that never answered read as "no turn running" — silence
 *     resolved as a fact, the same error one layer down.
 *
 * Each of those compiled. So each coercion is written down where the compiler sees
 * it, falsified by breaking production before being trusted: the commit message
 * records the three deliberate breakages and what each pin did about them.
 *
 * `@ts-expect-error` is not a bypass and nothing is silenced here. The directive
 * ASSERTS an error exists on the next line; if the regression it guards returns,
 * `npx tsc --noEmit` — the authoritative gate — fails as an UNUSED directive. That
 * is the opposite of `any`, which fails silently in the same situation.
 */
import type { HostSessionMissing, HostStatusMap, HostTurn } from "../shared/client.js";

// ── the host's status map holds RUNNING turns, so a missing key is not a word ──
declare const statusMap: HostStatusMap;
// @ts-expect-error  An absent key is `undefined`, never a turn. `noUncheckedIndexedAccess`
// is what makes this an error, and it is the flag that did not exist when the null
// was invented — with it off, this line compiles and a reader is handed a missing
// entry with nothing left to tell it apart from a fact.
const assumedTurn: HostTurn = statusMap["ses_x"];

// ── the word union is CLOSED, so `idle` in a map is the host's promise to delete ──
declare const quiesced: { type: "quiesced" };
// @ts-expect-error  `SessionStatus` is a closed union; a word the host has not
// declared cannot be read as one. This is the pin that would have failed when
// `OVER_HOST_STATES` was consulted instead — an invented word matched no member and
// every working child on it read as settled.
const refusedWord: HostTurn = quiesced;

// ── and each declared member is a distinct shape, so the positives pin the rest ──
// Positive pins carry the no-slack half: if the host changed what `retry` carries,
// `fullRetry` below stops compiling, so the word list is verified rather than
// assumed. A pin proved only against a rejection proves less than it looks.
declare const retryPayload: { attempt: number; message: string; next: number };
const fullRetry: HostTurn = { type: "retry", ...retryPayload };
const busyTurn: HostTurn = { type: "busy" };
const idleTurn: HostTurn = { type: "idle" };

// @ts-expect-error  `retry` carries `attempt`, `message` and `next`; a bare word
// must not compile, or a reader could take half a status for the whole of one.
const thinRetry: HostTurn = { type: "retry" };

// ── the host's not-found is NAMED, so a refusal is identified by its own name ──
// The near-miss carries ONLY its name. An earlier version also carried `data`, and
// then the pin was satisfied by the excess property rather than by the name — a pin
// that passes on the wrong error is a comment that costs a compile.
declare const nearMissName: { name: "NotFound" };
// @ts-expect-error  `SessionGetErrors[404]` declares `name: "NotFoundError"`. A
// near-miss must not be assignable, or a reader comparing the name would treat
// some other refusal as "this session is gone" — and that inference ends a child.
const nearMiss: HostSessionMissing = nearMissName;

// ── and the refusal carries no status code, so the code check is a tolerance ──
// `isHostSessionMissing` also matches a bare `status === 404` because the SDK's
// error mode picks which shape arrives and the reader must not depend on a mode it
// does not set. That is deliberate, so it is pinned: the tolerance is visible here
// rather than looking like an accidental second spelling.
declare const bareStatus: { status: 404 };
const toleratedByShape: { status: number } = bareStatus;

export type _HostPins = [
  typeof assumedTurn,
  typeof refusedWord,
  typeof fullRetry,
  typeof busyTurn,
  typeof idleTurn,
  typeof thinRetry,
  typeof nearMiss,
  typeof toleratedByShape,
];
// ── BOUNDEDNESS IS A TYPE: production cannot reach a host namespace ──
// Tenet 2 ("every outbound host call is bounded") was held by a scan reading
// production text, which cannot see a call reached through an indirect receiver —
// the one defect it missed was `hostLogCall(client)`, an unbounded `safeLog` that
// stopped plugin init silently, because the log was what hung.
//
// So boundedness moves into the type: production holds `OpaqueHost`, which has no
// namespaces, so naming one is a BUILD FAILURE. Falsified by inserting an unbounded
// `host.session.status(...)` into prompt.ts: TS2339. The rejected alternative —
// branding each SDK method's return — is in docs/tasks/18-opaque-host-boundedness.md.
import type { OpaqueHost } from "../shared/client.js";

declare const host: OpaqueHost;

// @ts-expect-error  THE PIN. Naming a host namespace through the value production
// was given is the only way an outbound call escapes `client.ts`. An UNUSED
// directive means opacity was weakened and boundedness is a scan finding again.
const escapesTheChokepoint = await host.session.status({ throwOnError: true });

// ── and the mint is the ONLY way to obtain one ──
// The brand is a `unique symbol`, so no literal can carry the key. The fixture is
// the DECISIVE one — a REAL client under the brand's NAME — and it was falsified:
// under a `declare const HOST: "__host"` corruption it compiles clean. An earlier
// fixture ({ session: unknown }) was rejected under BOTH brands, proving nothing.
import type { OpenCodeClient } from "../shared/client.js";

declare const realClient: OpenCodeClient;
declare const spellsTheBrand: { __host: OpenCodeClient };
// @ts-expect-error  A literal cannot carry a `unique symbol` key, so no object can
// stand in for a minted host. This compiles clean if the brand becomes a string.
const forgedHost: OpaqueHost = spellsTheBrand;

export type _OpaqueHostPins = [typeof escapesTheChokepoint, typeof forgedHost];
