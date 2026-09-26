// Tool map (entry/tools boundary): every registered tool is defined here —
// description, args, and a one-line execute that delegates to its executor
// module. Session-scoped tools are built by scopedTool, which resolves the
// session scope once and hands it to the executor. Bodies live beside their
// hazards; this file owns the inventory the Task-00 fidelity gate reads.
import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin";import { executeDynamicTask } from "./spawn.js";
import { executeTaskContinue } from "./continue.js";
import { executeTaskNotify } from "./notice.js";
import { executeTaskResult, executeTaskStatus, executeTaskList } from "./read.js";
import { executeTaskInterrupt } from "./interrupt.js";
import { openSessionScope, type ResolvedSessionScope, type ToolDeps } from "./context.js";
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
  // The ONLY door into a session-scoped executor. The scope is resolved here,
  // once per call, and the executor receives it — so the session-id guard is
  // structurally present for every session tool rather than repeated (and
  // driftable) inside four executors, and an executor's signature has no room
  // for an unresolved id.
  const scopedTool = (
    description: string,
    args: ToolArgs,
    execute: (scope: ResolvedSessionScope, args: never) => Promise<string>,
  ) =>
    tool({
      description,
      args,
      async execute(raw) {
        const opened = openSessionScope(deps, raw);
        if (!opened.ok) return opened.error;
        return execute(opened.scope, raw as never);
      },
    });
  const SESSION_ID = tool.schema.string().describe("Background task session ID (ses_...)");

  return {
      dynamic_task: tool({
        description: DYNAMIC_TASK_DESCRIPTION,
        args: {
          description: tool.schema.string().describe("Short human-readable task label"),
          subagent_type: tool.schema.string().describe("Agent to invoke"),
          prompt: tool.schema.string().describe("Instructions for the child session"),
          model: tool.schema
            .string()
            .optional()
            .describe(MODEL_ARG_DESCRIPTION),
          depends_on: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Task dependencies — session IDs this task depends on. Each must have completed."),
          depends_on_settled: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Task dependencies that only need to settle (completed, error, or interrupted) before this task runs. Strict ordering still uses depends_on."),
        },
        async execute(args, ctx: ToolContext) {
          return executeDynamicTask(deps, args, ctx);
        },
      }),

      task_continue: scopedTool(
        TASK_CONTINUE_DESCRIPTION,
        {
          session_id: tool.schema.string().describe("Child session ID from dynamic_task"),
          prompt: tool.schema.string().describe("Follow-up instructions"),
          model: tool.schema.string().optional().describe(`${MODEL_ARG_DESCRIPTION} Applies when reviving a settled task; steers keep the task's model.`),
        },
        executeTaskContinue,
      ),

      task_notify: tool({
        description: TASK_NOTIFY_DESCRIPTION,
        args: {
          message: tool.schema.string().describe("What the parent needs to know"),
        },
        async execute(args, ctx: ToolContext) {
          return executeTaskNotify(deps, args, ctx);
        },
      }),

      task_result: scopedTool(TASK_RESULT_DESCRIPTION, { session_id: SESSION_ID }, executeTaskResult),

      task_interrupt: scopedTool(
        TASK_INTERRUPT_DESCRIPTION,
        { session_id: tool.schema.string() },
        executeTaskInterrupt,
      ),

      task_list: tool({
        description: TASK_LIST_DESCRIPTION,
        args: {},
        async execute() {
          return executeTaskList(deps);
        },
      }),

      task_status: scopedTool(TASK_STATUS_DESCRIPTION, { session_id: SESSION_ID }, executeTaskStatus),
  };
}
