// Tool map (entry/tools boundary): every registered tool is defined here —
// description, input schema, and a one-line execute that delegates to its executor
// module. Session-scoped tools are built by scopedTool, which resolves the session
// scope once and hands it to the executor. Bodies live beside their hazards; this
// file owns the inventory the Task-00 fidelity gate reads.
import type { Tool } from "@opencode/schema/tool";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { executeDynamicTask } from "./spawn.js";
import { executeTaskContinue } from "./continue.js";
import { executeTaskNotify } from "./notice.js";
import { executeTaskResult, executeTaskStatus, executeTaskList } from "./read.js";
import { executeTaskInterrupt } from "./interrupt.js";
import { openSessionScope, type ResolvedSessionScope, type ToolDeps } from "./context.js";
import { NOTIFY_TOOL } from "../shared/notification-text.js";
import type { Verdict } from "../shared/verdict.js";
import { NOTICE_CLAIMS } from "../shared/notice-claim.js";
import {
  DYNAMIC_TASK_DESCRIPTION,
  TASK_CONTINUE_DESCRIPTION,
  TASK_NOTIFY_DESCRIPTION,
  TASK_RESULT_DESCRIPTION,
  TASK_INTERRUPT_DESCRIPTION,
  TASK_LIST_DESCRIPTION,
  TASK_STATUS_DESCRIPTION,
  MODEL_ARG_DESCRIPTION,
} from "../shared/voice.js";

// One JSON Schema per tool's WHOLE input, not a record of per-argument schemas: v2's
// `Tool.Info` takes a single `input`. JSON Schema is not a fallback — `ValueSchema`
// declares it as one of three accepted forms, so writing it directly drops the zod-ish
// `tool.schema` DSL entirely and leaves the host validating the same shape we publish.
type InputSchema = Tool.ValueSchema;

const string = (description: string) => ({ type: "string", description }) as const;
const optionalString = (description: string) => ({ type: "string", description }) as const;
const optionalStringList = (description: string) =>
  ({ type: "array", items: { type: "string" }, description }) as const;

export function buildToolMap(deps: ToolDeps) {
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
  const registeredTool = <T>(resolve: (raw: unknown, ctx: ToolContext) => Verdict<T>) =>
    (input: InputSchema, description: string, execute: (resolved: T, args: never, ctx: ToolContext) => Promise<string>) => ({
      input,
      description,
      async execute(raw: unknown, ctx: ToolContext) {
        // ctx goes to the resolver because the resolved scope is how a
        // session-scoped tool learns who is calling it — a fact the arguments
        // cannot carry, and the fact that lets a stop tell a caller from its
        // own session. Passing it here rather than threading it past the resolver
        // is what keeps that decision at the one door.
        const verdict = resolve(raw, ctx);
        if (!verdict.ok) return { content: verdict.error };
        return { content: await execute(verdict.input, raw as never, ctx) };
      },
    });

  // A tool that acts on a named child resolves the session id here, once per
  // call. The two tools that run against the PLUGIN rather than a session scope
  // have no session id to resolve, and the whole dependency set is the input.
  const sessionInput = (raw: unknown, ctx: ToolContext): Verdict<ResolvedSessionScope> => {
    const opened = openSessionScope(deps, raw, ctx);
    return opened.ok ? { ok: true, input: opened.scope } : opened;
  };
  const pluginInput = (): Verdict<ToolDeps> => ({ ok: true, input: deps });
  const scopedTool = registeredTool(sessionInput);
  const pluginTool = registeredTool(pluginInput);
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
    type: "object",
    properties: { session_id: SESSION_ID, ...properties },
    required,
  });
  const MODEL = (clause = "") => optionalString(`${MODEL_ARG_DESCRIPTION}${clause}`);

  return {
    dynamic_task: pluginTool(
      {
        type: "object",
        properties: {
          description: string("Short human-readable task label"),
          subagent_type: string("Agent to invoke"),
          prompt: PROMPT("Instructions for the child session"),
          model: MODEL(),
          depends_on: SESSION_ID_LIST(
            "Task dependencies — session IDs this task depends on. Each must have completed.",
          ),
          depends_on_settled: SESSION_ID_LIST(
            "Task dependencies that only need to settle (completed, error, or interrupted) before this task runs. Strict ordering still uses depends_on.",
          ),
        },
        required: ["description", "subagent_type", "prompt"],
      },
      DYNAMIC_TASK_DESCRIPTION,
      executeDynamicTask,
    ),

    task_continue: scopedTool(
      SESSION_SCHEMA(
        {
          prompt: PROMPT("Follow-up instructions"),
          model: MODEL(" Applies when reviving a settled task; steers keep the task's model."),
        },
        ["session_id", "prompt"],
      ),
      TASK_CONTINUE_DESCRIPTION,
      executeTaskContinue,
    ),

    [NOTIFY_TOOL]: pluginTool(
      {
        type: "object",
        properties: {
          message: string("What the parent needs to know"),
          kind: {
            type: "string",
            enum: [...NOTICE_CLAIMS],
            description:
              "What this notice claims about your own state: 'progress' (default) or 'needs_input' when this turn cannot finish without the parent",
          },
        },
        required: ["message"],
      },
      TASK_NOTIFY_DESCRIPTION,
      executeTaskNotify,
    ),

    task_result: scopedTool(
      { type: "object", properties: { session_id: SESSION_ID }, required: ["session_id"] },
      TASK_RESULT_DESCRIPTION,
      executeTaskResult,
    ),

    task_interrupt: scopedTool(
      SESSION_SCHEMA(
        {
          scope: {
            type: "string",
            enum: ["subtree", "self"],
            description:
              "How far the stop reaches: the whole subtree below this task (default), or this session only",
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
    task_list: pluginTool({ type: "object", properties: {} }, TASK_LIST_DESCRIPTION, (input) =>
      executeTaskList(input),
    ),

    task_status: scopedTool(
      { type: "object", properties: { session_id: SESSION_ID }, required: ["session_id"] },
      TASK_STATUS_DESCRIPTION,
      executeTaskStatus,
    ),
  };
}