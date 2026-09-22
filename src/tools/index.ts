// Tool map (entry/tools boundary): every registered tool is defined here —
// description, args, and a one-line execute that delegates to its executor
// module. Bodies live beside their hazards; this file owns the inventory the
// Task-00 fidelity gate scans.
import { tool } from "@opencode-ai/plugin";
import type { ToolContext } from "@opencode-ai/plugin";
import { executeDynamicTask } from "./spawn.js";
import { executeTaskContinue } from "./continue.js";
import { executeTaskNotify } from "./notice.js";
import { executeTaskResult, executeTaskStatus, executeTaskList } from "./read.js";
import { executeTaskInterrupt } from "./interrupt.js";
import type { ToolDeps } from "./context.js";
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

export function buildToolMap(deps: ToolDeps) {
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

      task_continue: tool({
        description: TASK_CONTINUE_DESCRIPTION,
        args: {
          session_id: tool.schema.string().describe("Child session ID from dynamic_task"),
          prompt: tool.schema.string().describe("Follow-up instructions"),
          model: tool.schema.string().optional().describe(`${MODEL_ARG_DESCRIPTION} Applies when reviving a settled task; steers keep the task's model.`),
        },
        async execute(args) {
          return executeTaskContinue(deps, args);
        },
      }),

      task_notify: tool({
        description: TASK_NOTIFY_DESCRIPTION,
        args: {
          message: tool.schema.string().describe("What the parent needs to know"),
        },
        async execute(args, ctx: ToolContext) {
          return executeTaskNotify(deps, args, ctx);
        },
      }),

      task_result: tool({
        description: TASK_RESULT_DESCRIPTION,
        args: {
          session_id: tool.schema.string().describe("Background task session ID (ses_...)"),
        },
        async execute(args) {
          return executeTaskResult(deps, args);
        },
      }),

      task_interrupt: tool({
        description: TASK_INTERRUPT_DESCRIPTION,
        args: {
          session_id: tool.schema.string(),
        },
        async execute(args) {
          return executeTaskInterrupt(deps, args);
        },
      }),

      task_list: tool({
        description: TASK_LIST_DESCRIPTION,
        args: {},
        async execute() {
          return executeTaskList(deps);
        },
      }),

      task_status: tool({
        description: TASK_STATUS_DESCRIPTION,
        args: {
          session_id: tool.schema.string().describe("Background task session ID (ses_...)"),
        },
        async execute(args) {
          return executeTaskStatus(deps, args);
        },
      }),
  };
}
