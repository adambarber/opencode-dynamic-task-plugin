// Tool map (entry/tools boundary): every registered tool is defined here —
// description, input schema, and a one-line execute that delegates to its executor
// module. Session-scoped tools are built by scopedTool, which resolves the session
// scope once and hands it to the executor. Bodies live beside their hazards; this
// file owns the inventory the Task-00 fidelity gate reads.
//jscpd:ignore-start
import type { Tool } from "@opencode/schema/tool";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { executeDynamicTask } from "./spawn.js";
import { readContinueArgs, readNotifyArgs, readSpawnArgs } from "./args.js";
import { executeTaskContinue } from "./continue.js";
import { executeTaskNotify } from "./notice.js";
import { executeTaskList, executeTaskResult, executeTaskStatus } from "./read.js";
import { executeTaskInterrupt } from "./interrupt.js";
import { type ResolvedSessionScope, type ToolDeps, openSessionScope } from "./context.js";
import { NOTIFY_TOOL } from "../shared/notification-text.js";
import type { Verdict } from "../shared/verdict.js";
import { NOTICE_CLAIMS } from "../shared/notice-claim.js";
import {
  DYNAMIC_TASK_DESCRIPTION,
  MODEL_ARG_DESCRIPTION,
  TASK_CONTINUE_DESCRIPTION,
  TASK_INTERRUPT_DESCRIPTION,
  TASK_LIST_DESCRIPTION,
  TASK_NOTIFY_DESCRIPTION,
  TASK_RESULT_DESCRIPTION,
  TASK_STATUS_DESCRIPTION,
} from "../shared/voice.js";

//jscpd:ignore-end
// One JSON Schema per tool's WHOLE input, not a record of per-argument schemas: v2's
// `Tool.Info` takes a single `input`. JSON Schema is not a fallback — `ValueSchema`
// declares it as one of three accepted forms, so writing it directly drops the zod-ish
// `tool.schema` DSL entirely and leaves the host validating the same shape we publish.
type InputSchema = Tool.ValueSchema;

const string = (description: string) => ({ description, type: "string" }) as const;
const optionalString = (description: string) => ({ description, type: "string" }) as const;
const optionalStringList = (description: string) =>
  ({ description, items: { type: "string" }, type: "array" }) as const;

// The ONLY door into any registered tool, and the ONLY decision about what an
// executor runs against. Bound to its resolver, so a tool declares the input it
// runs against in one place and the executor that goes with it — the session-id
// guard is structurally present for every session tool rather than repeated
// (and driftable) inside four executors.
//
// The four executors that read their raw arguments declare them under their own real
// types (SpawnArgs, ContinueArgs, NotifyArgs); a JSON-Schema input decodes to
// `unknown`, which is the honest type for something the host validated for us and
// which every one of those executors already took.
// Resolvers return the scope AND the narrowed arguments; executors run only
// against those, so host JSON reaches an executor exclusively through a reader.
const registeredTool = <S, A>(resolve: (raw: unknown, ctx: ToolContext) => Verdict<{ scope: S; args: A }>) =>
  (input: InputSchema, description: string, execute: (scope: S, args: A, ctx: ToolContext) => Promise<string>) => ({
    description,
    input,
    // Direct tools, not Code-Mode-catalog tools. Without this the host files
    // every one of the seven under `execute`, and a model that calls one
    // directly hears `No tool named "task_notify" is currently available` —
    // observed live in a child that then stayed silent. The child's voice is
    // the one call this plugin cannot afford to route through an indirection
    // a small model may not take.
    options: { codemode: false },
    async execute(raw: unknown, ctx: ToolContext) {
      // ctx goes to the resolver because the resolved scope is how a
      // session-scoped tool learns who is calling it — a fact the arguments
      // cannot carry, and the fact that lets a stop tell a caller from its
      // own session. Passing it here rather than threading it past the resolver
      // is what keeps that decision at the one door.
      const verdict = resolve(raw, ctx);
      if (!verdict.ok) return { content: verdict.error };
      return { content: await execute(verdict.input.scope, verdict.input.args, ctx) };
    },
  });

// One schema for the one argument every child-scoped tool takes. Four tools
// spelled it: two borrowed this, task_continue said "Child session ID from
// dynamic_task", and task_interrupt said nothing at all — so the same argument
// had three descriptions and one absence. The word "background" was also wrong
// for three of the four: a settled FOREGROUND task is continued, read and
// stopped through this argument too.
const SESSION_ID = string("Child session ID from dynamic_task (ses_...)");
// One builder for the two dependency arguments. They are the same schema with the
// same meaning — a list of child session ids — and differ only in what
// waiting for them MEANS, which is the sentence, not the type.
const SESSION_ID_LIST = (description: string) => optionalStringList(description);
// Likewise the prompt and the model override: the two arguments every
// prompt-bearing tool takes, each with its own sentence but the same shape. The
// model's base contract is MODEL_ARG_DESCRIPTION (providerID/modelID as spelled
// in the host's own config, bare ids refused) — a tool that restates that
// sentence restates it wrong sooner or later, so a tool adds a clause instead.
const PROMPT = (description: string) => string(description);
// One wrapper for the object schema every session-scoped tool shares: the same
// session_id plus whatever else that tool takes. Spelled twice it drifts.
const SESSION_SCHEMA = (properties: Record<string, unknown>, required: string[]) => ({
  properties: { session_id: SESSION_ID, ...properties },
  required,
  type: "object",
});
const MODEL = (clause = "") => optionalString(`${MODEL_ARG_DESCRIPTION}${clause}`);
// The identity reader for tools that take no arguments: the resolver contract
// still returns scope AND args, so a no-arg tool reads its input as itself.
const passThrough = (raw: unknown): unknown => raw;

export function buildToolMap(deps: ToolDeps) {
  // A tool that acts on a named child resolves the session id here, once per
  // call. The two tools that run against the PLUGIN rather than a session scope
  // have no session id to resolve, and the whole dependency set is the input.
  const sessionInput = <A>(readArgs: (raw: unknown) => A) =>
    (raw: unknown, ctx: ToolContext): Verdict<{ scope: ResolvedSessionScope; args: A }> => {
      const opened = openSessionScope(deps, raw, ctx);
      if (!opened.ok) return opened;
      return { input: { args: readArgs(raw), scope: opened.scope }, ok: true };
    };
  const pluginInput = <A>(readArgs: (raw: unknown) => A) =>
    (raw: unknown): Verdict<{ scope: ToolDeps; args: A }> => ({ input: { args: readArgs(raw), scope: deps }, ok: true });
  const scopedTool = <A>(readArgs: (raw: unknown) => A) => registeredTool(sessionInput(readArgs));
  const pluginTool = <A>(readArgs: (raw: unknown) => A) => registeredTool(pluginInput(readArgs));

  return {
    dynamic_task: pluginTool(readSpawnArgs)(
      {
        properties: {
          depends_on: SESSION_ID_LIST(
            "Task dependencies — session IDs this task depends on. Each must have completed.",
          ),
          depends_on_settled: SESSION_ID_LIST(
            "Task dependencies that only need to settle (completed, error, or interrupted) before this task runs. Strict ordering still uses depends_on.",
          ),
          description: string("Short human-readable task label"),
          model: MODEL(),
          prompt: PROMPT("Instructions for the child session"),
          subagent_type: string("Agent to invoke"),
        },
        required: ["description", "subagent_type", "prompt"],
        type: "object",
      },
      DYNAMIC_TASK_DESCRIPTION,
      executeDynamicTask,
    ),

    task_continue: scopedTool(readContinueArgs)(
      SESSION_SCHEMA(
        {
          model: MODEL(" Applies when reviving a settled task; steers keep the task's model."),
          prompt: PROMPT("Follow-up instructions"),
        },
        ["session_id", "prompt"],
      ),
      TASK_CONTINUE_DESCRIPTION,
      executeTaskContinue,
    ),

    [NOTIFY_TOOL]: pluginTool(readNotifyArgs)(
      {
        properties: {
          kind: {
            description:
              "What this notice claims about your own state: 'progress' (default) or 'needs_input' when this turn cannot finish without the parent",
            enum: [...NOTICE_CLAIMS],
            type: "string",
          },
          message: string("What the parent needs to know"),
        },
        required: ["message"],
        type: "object",
      },
      TASK_NOTIFY_DESCRIPTION,
      executeTaskNotify,
    ),

    task_interrupt: scopedTool(passThrough)(
      SESSION_SCHEMA(
        {
          scope: {
            description:
              "How far the stop reaches: the whole subtree below this task (default), or this session only",
            enum: ["subtree", "self"],
            type: "string",
          },
        },
        ["session_id"],
      ),
      TASK_INTERRUPT_DESCRIPTION,
      executeTaskInterrupt,
    ),

    // Through the same door as the other six. It was the one tool registered
    // by calling the tool builder inline, with the resolver it needed written as
    // a closure over `deps` — so the comment on `registeredTool` above ("the ONLY
    // door into any registered tool") was false. It runs against the PLUGIN, not a
    // session scope, so it is a pluginTool like dynamic_task and task_notify.
    task_list: pluginTool(passThrough)({ properties: {}, type: "object" }, TASK_LIST_DESCRIPTION, (input) =>
      executeTaskList(input),
    ),

    task_result: scopedTool(passThrough)(
      { properties: { session_id: SESSION_ID }, required: ["session_id"], type: "object" },
      TASK_RESULT_DESCRIPTION,
      executeTaskResult,
    ),

    task_status: scopedTool(passThrough)(
      { properties: { session_id: SESSION_ID }, required: ["session_id"], type: "object" },
      TASK_STATUS_DESCRIPTION,
      executeTaskStatus,
    ),
  };
}