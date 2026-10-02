// Tool map (entry/tools boundary): every registered tool is defined here —
// description, args, and a one-line execute that delegates to its executor
// module. Session-scoped tools are built by scopedTool, which resolves the
// session scope once and hands it to the executor. Bodies live beside their
// hazards; this file owns the inventory the Task-00 fidelity gate reads.
import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin";
import { executeDynamicTask } from "./spawn.js";
import { executeTaskContinue } from "./continue.js";
import { executeTaskNotify } from "./notice.js";
import { executeTaskResult, executeTaskStatus, executeTaskList } from "./read.js";
import { executeTaskInterrupt } from "./interrupt.js";
import { openSessionScope, type ResolvedSessionScope, type ToolDeps } from "./context.js";
import type { Verdict } from "../shared/verdict.js";
import { NOTICE_CLAIMS } from "../shared/task-state.js";
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

// The tool SDK's own arg-map type, so a schema change in the SDK cannot be
// papered over here.
type ToolArgs = Parameters<typeof tool>[0]["args"];

export function buildToolMap(deps: ToolDeps) {
  // The ONLY door into any registered tool, and the ONLY decision about what an
  // executor runs against. Bound to its resolver, so a tool declares the input it
  // runs against in one place and the executor that goes with it — the session-id
  // guard is structurally present for every session tool rather than repeated
  // (and driftable) inside four executors, and an executor's signature has no
  // room for an unresolved id. The refusal is reported by the resolve step,
  // before the executor exists.
  //
  // `args: never` is not a hole, and it should not be "fixed". The four executors
  // that read their raw arguments declare them under their own real types
  // (SpawnArgs, ContinueArgs, NotifyArgs) and TypeScript still accepts them here
  // because `never` is the bottom type — assignable to every type, which is
  // exactly the property that lets one signature admit four different arg types.
  // The alternative is a per-call-site `raw as SpawnArgs`, which is a LARGER claim
  // (each site would assert its own type) and no safer: the resolver above has
  // already established that the value's shape, which is the whole reason the raw
  // arguments can be handed over un-narrowed.
  const registeredTool = <T>(resolve: (raw: unknown, ctx: ToolContext) => Verdict<T>) =>
    (description: string, args: ToolArgs, execute: (input: T, args: never, ctx: ToolContext) => Promise<string>) =>
      tool({
        description,
        args,
        async execute(raw, ctx: ToolContext) {
          // ctx goes to the resolver because the resolved scope is how a
          // session-scoped tool learns who is calling it — a fact the arguments
          // cannot carry, and the fact that lets a stop tell a caller from its
          // own session. Passing it here rather than threading it past the resolver
          // is what keeps that decision at the one door.
          const resolved = resolve(raw, ctx);
          if (!resolved.ok) return resolved.error;
          return execute(resolved.input, raw as never, ctx);
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
  const SESSION_ID = tool.schema.string().describe("Child session ID from dynamic_task (ses_...)");
  // One builder for the two dependency arguments. They are the same schema with
  // the same meaning — a list of child session ids — and differ only in what
  // waiting for them MEANS, which is the sentence, not the type. Spelling the
  // chain twice is how the two arguments stop being the same kind of value.
  const SESSION_ID_LIST = (description: string) =>
    tool.schema.array(tool.schema.string()).optional().describe(description);
  // Likewise the prompt and the model override: the two arguments every
  // prompt-bearing tool takes, each with its own sentence but the same shape. The
  // model's base contract is MODEL_ARG_DESCRIPTION (providerID/modelID as spelled
  // in the host's own config, bare ids refused) — a tool that restates that
  // sentence restates it wrong sooner or later, so a tool adds a clause instead.
  const PROMPT = (description: string) => tool.schema.string().describe(description);
  const MODEL = (clause = "") => tool.schema.string().optional().describe(`${MODEL_ARG_DESCRIPTION}${clause}`);

  return {
      dynamic_task: pluginTool(
        DYNAMIC_TASK_DESCRIPTION,
        {
          description: tool.schema.string().describe("Short human-readable task label"),
          subagent_type: tool.schema.string().describe("Agent to invoke"),
          prompt: PROMPT("Instructions for the child session"),
          model: MODEL(),
          depends_on: SESSION_ID_LIST(
            "Task dependencies — session IDs this task depends on. Each must have completed.",
          ),
          depends_on_settled: SESSION_ID_LIST(
            "Task dependencies that only need to settle (completed, error, or interrupted) before this task runs. Strict ordering still uses depends_on.",
          ),
        },
        executeDynamicTask,
      ),

      task_continue: scopedTool(
        TASK_CONTINUE_DESCRIPTION,
        {
          session_id: SESSION_ID,
          prompt: PROMPT("Follow-up instructions"),
          model: MODEL(" Applies when reviving a settled task; steers keep the task's model."),
        },
        executeTaskContinue,
      ),

      task_notify: pluginTool(
        TASK_NOTIFY_DESCRIPTION,
        {
          message: tool.schema.string().describe("What the parent needs to know"),
          kind: tool.schema
            .enum(NOTICE_CLAIMS)
            .optional()
            .describe("What this notice claims about your own state: 'progress' (default) or 'needs_input' when this turn cannot finish without the parent"),
        },
        executeTaskNotify,
      ),

      task_result: scopedTool(TASK_RESULT_DESCRIPTION, { session_id: SESSION_ID }, executeTaskResult),

      task_interrupt: scopedTool(
        TASK_INTERRUPT_DESCRIPTION,
        {
          session_id: SESSION_ID,
          scope: tool.schema
            .enum(["subtree", "self"])
            .optional()
            .describe("How far the stop reaches: the whole subtree below this task (default), or this session only"),
        },
        executeTaskInterrupt,
      ),

      // Through the same door as the other five. It was the one tool registered
      // by calling `tool(...)` inline, with the resolver it needed written as a
      // closure over `deps` — so the comment on `registeredTool` above ("the ONLY
      // door into any registered tool") was false, and a second registration path
      // was a second place for a session guard to be forgotten. It runs against
      // the PLUGIN, not a session scope, so it is a pluginTool like dynamic_task
      // and task_notify; the difference is that its executor takes no raw args.
      task_list: pluginTool(TASK_LIST_DESCRIPTION, {}, (input) => executeTaskList(input)),

      task_status: scopedTool(TASK_STATUS_DESCRIPTION, { session_id: SESSION_ID }, executeTaskStatus),
  };
}
