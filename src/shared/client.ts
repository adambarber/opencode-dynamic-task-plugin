// src/shared/client.ts
// OpenCode client boundary (Task 08) — the single home for the client
// type. The SDK client comes from PluginInput; the `question` namespace is
// host-provided beyond the generated SDK surface, so it is declared here
// explicitly (Tenet 9: named, scoped, reasoned) instead of smuggled as any.

import type { PluginInput } from "@opencode-ai/plugin";

export interface QuestionNamespace {
  reply(args: { path: { id: string }; body: { answer: string } }): Promise<unknown>;
  reject(args: { path: { id: string }; body: { reason: string } }): Promise<unknown>;
}

export type OpenCodeClient = PluginInput["client"] & {
  question: QuestionNamespace;
};
