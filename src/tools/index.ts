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

export function buildToolMap(deps: ToolDeps) {
  return {
      dynamic_task: tool({
        description:
          "Spawn a subagent task. Returns immediately — the task never blocks this session. Its outcome arrives exactly once as a [dynamic-task-notify] message when it settles; the child can also send mid-flight [dynamic-task-notice] notices with task_notify. Inspect with task_result/task_status/task_list; steer a running child or revive a settled one with task_continue; stop it with task_interrupt.",
        args: {
          description: tool.schema.string().describe("Short human-readable task label"),
          subagent_type: tool.schema.string().describe("Agent to invoke"),
          prompt: tool.schema.string().describe("Instructions for the child session"),
          model: tool.schema
            .string()
            .optional()
            .describe("Optional model override as providerID/modelID exactly as spelled in opencode.jsonc (e.g. \"nvidia/z-ai/glm-5.3\"). Bare ids are rejected at admission."),
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
        description:
          "Send a follow-up prompt to a tracked child session and return immediately. A running child is steered: its current turn is aborted and the message becomes its next turn, staying active. A settled child is revived for a fresh turn. Either way the next outcome arrives as a dynamic-task-notify message. Interrupted tasks are never revived — spawn a fresh dynamic_task instead.",
        args: {
          session_id: tool.schema.string().describe("Child session ID from dynamic_task"),
          prompt: tool.schema.string().describe("Follow-up instructions"),
        },
        async execute(args) {
          return executeTaskContinue(deps, args);
        },
      }),

      task_notify: tool({
        description:
          "Send a message to the parent session while running: progress, findings, or a block needing parent input. This is a mid-flight notice, not a settlement — the task stays active and reports normally when it finishes. If you are blocked, say exactly what would unblock you; the parent can reply via task_continue. Notices arrive as [dynamic-task-notice], distinct from the [dynamic-task-notify] settlement tag. (Children spawned by dynamic_task only.)",
        args: {
          message: tool.schema.string().describe("What the parent needs to know"),
        },
        async execute(args, ctx: ToolContext) {
          return executeTaskNotify(deps, args, ctx);
        },
      }),

      task_result: tool({
        description: "Fetch latest known child session result/status without sending a new prompt.",
        args: {
          session_id: tool.schema.string().describe("Background task session ID (ses_...)"),
        },
        async execute(args) {
          return executeTaskResult(deps, args);
        },
      }),

      task_interrupt: tool({
        description:
          "Terminate a child session by request. The task settles as interrupted synchronously; its history is preserved. An interrupted child is not revived by task_continue — spawn a fresh dynamic_task instead.",
        args: {
          session_id: tool.schema.string(),
        },
        async execute(args) {
          return executeTaskInterrupt(deps, args);
        },
      }),

      task_list: tool({
        description: "List all tracked tasks with their lifecycle states.",
        args: {},
        async execute() {
          return executeTaskList(deps);
        },
      }),

      task_status: tool({
        description: "Detailed tracked state for one task without calling the API.",
        args: {
          session_id: tool.schema.string().describe("Background task session ID (ses_...)"),
        },
        async execute(args) {
          return executeTaskStatus(deps, args);
        },
      }),
  };
}
