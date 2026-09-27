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
