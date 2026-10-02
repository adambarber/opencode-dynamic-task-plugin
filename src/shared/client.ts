// src/shared/client.ts
// OpenCode client boundary (Task 08) — the single home for the client type.
//
// The v1 client that PluginInput hands us does not declare the `question`
// namespace (only the v2 generation does), so the plugin has to say something
// about it. It used to say something by HAND, and the hand-written mirror was
// wrong in four places: the path key (`id` where the host routes
// `/question/{requestID}`), the reply body (`{ answer }` where the host wants
// `{ answers: Array<QuestionAnswer> }`), a reject body the host declares
// `never`, and a whole namespace that no test could type-check.
//
// So the namespace is DERIVED from the host's own generated request types
// instead of restated by hand. `Pick` drops only the `url` path template, which
// the runtime client fills in; every field name, every field type, and every
// rejected shape now come from the SDK. A wrong key stopped being a runtime 404
// and became a build error — the class of defect this file exists to make
// unrepresentable. Verified against opencode 1.18.30: it serves
// `/question/{requestID}/reply` and `/question/{requestID}/reject`, and no
// `{id}` route exists.

import type { PluginInput } from "@opencode-ai/plugin";
import type { QuestionReplyData, QuestionRejectData } from "@opencode-ai/sdk/v2/types";
import type { SessionGetErrors, SessionStatus, SessionStatusResponses } from "@opencode-ai/sdk";

/**
 * The question namespace, typed from the host's generated request data. `body`
 * is absent from `reject` because the endpoint declares it `never`: a rejection
 * reason has no channel to the asking session. The reason is therefore a
 * parent-facing artifact — it reaches the operator through the block claim this
 * plugin writes, never through the reject call.
 */
export interface QuestionNamespace {
  reply(args: Pick<QuestionReplyData, "path" | "body">): Promise<unknown>;
  reject(args: Pick<QuestionRejectData, "path">): Promise<unknown>;
}

export type OpenCodeClient = PluginInput["client"] & {
  question: QuestionNamespace;
};

/**
 * The host's status map, as the host's own generated type declares it: session id to
 * that session's turn object.
 *
 * Derived from the ROOT entry, which re-exports the v1 generation wholesale — and v1
 * is the generation this plugin's client actually is, because `PluginInput` hands us
 * a v1 client. (The v1 declarations have no deep import path; `exports` maps
 * `/gen/types` nowhere. Only the root reaches them.)
 *
 * It earns its keep in one specific way. The declared 200 is an INDEX SIGNATURE, so
 * under `noUncheckedIndexedAccess` a session id the host does not list reads as
 * `SessionStatus | undefined` — the absence of a KEY, which is the only honest shape
 * for "no turn is running here". The hand-written `string | null` this replaces had no
 * such distinction: its `null` stood for BOTH "the map lists no entry" and "there is
 * no such session", and that second meaning is what invented failures for children the
 * host was merely not working on. The index signature cannot be coerced into a value,
 * so the coercion has nowhere to go.
 */
export type HostStatusMap = SessionStatusResponses[200];

/**
 * One entry of that map: the host's own turn object, verbatim.
 *
 * The vocabulary is deliberately OPEN at the reading boundary and CLOSED at every
 * decision. The host may add a word this plugin has never heard of, and the reading
 * has to be able to carry it: a type that could only hold known words would force an
 * unrecognised one to be dropped, and dropping it collapses "listed, and I do not
 * understand this" into "not listed" — the exact confusion this type exists to end.
 * What is closed is the decision, because `RUNNING_HOST_WORDS` in `liveness.ts` is a
 * `ReadonlySet<HostTurn["type"]>` seeded from literals: a host that renames or drops
 * `busy` breaks the BUILD there instead of leaving every working child reading as not
 * running, everywhere, silently.
 */
export type HostTurn = SessionStatus;

/**
 * The host's own "no such session", as the SDK DECLARES it.
 *
 * `SessionGetErrors[404]` is `NotFoundError`, so existence is answered by an endpoint
 * whose contract answers it — which is why no plugin-invented existence field appears
 * anywhere in this codebase, and why none is needed here. The name the error carries is
 * typed against this alias wherever it is compared, so a rename upstream becomes a build
 * error rather than a presence read that silently never fires.
 */
export type HostSessionMissing = SessionGetErrors[404];

/**
 * Whether this host's client really carries a question call.
 *
 * The premise behind `OpenCodeClient` is documented above and verified against a
 * real host — but a type is a belief, and a belief that is load-bearing at runtime
 * is a promise somebody has to keep. `index.ts` earns its own cast by probing the
 * four capabilities the tool map needs; this is the fifth, and until now nothing
 * checked it, so a host without the namespace failed by throwing inside a question
 * event handler — the one failure mode this plugin has no way to report.
 *
 * It is a probe of ONE call, not of the namespace, because the two entry points
 * need different ones and a client that gained `reject` without `reply` should
 * still be able to reject. Deliberately NOT part of the boot guard: the question
 * namespace is one feature among the tools, and a host missing it should lose
 * questions, not the whole plugin. The caller turns a `false` into a refusal it can
 * report, which is the outcome a throw could not produce.
 *
 * The cast below is the sanctioned idiom rather than a second untruth: it widens
 * to an untyped map to ASK whether a key exists, which is the question, instead of
 * asserting an answer.
 */
export function hasQuestionCall(client: PluginInput["client"], call: "reply" | "reject"): boolean {
  const question = (client as { question?: Record<string, unknown> }).question;
  return typeof question?.[call] === "function";
}
