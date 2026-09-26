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
