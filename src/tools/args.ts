// The tools' argument contract (entry/tools boundary), stated once. The JSON
// schema the host validates is built from these names in tools/index.ts; this
// module is the TypeScript side of the same three arguments, so a tool cannot
// declare an argument the executor does not read or read one it never declared.

/**
 * What every prompt-bearing tool takes. A session to act on (absent only for the
 * tool that CREATES one), the prompt, and an optional model override — the same
 * three, in the same spelling, with the same optionality for `dynamic_task` and
 * `task_continue`. Two interfaces listing them side by side is how the model
 * argument ends up optional in one tool and required in the other.
 *
 * Every field is optional because the host validates a tool call as a question,
 * not a constructor: an absent field is a refusal the admission gate reports in
 * the tool's own voice, never a schema error the parent has to decode.
 */
export interface PromptToolArgs {
  session_id?: string | undefined;
  prompt?: string | undefined;
  model?: string | undefined;
}

/** What creating a task adds on top: what to call it, which agent, and what it waits for. */
export interface SpawnArgs extends PromptToolArgs {
  description?: string | undefined;
  subagent_type?: string | undefined;
  depends_on?: string[] | undefined;
  depends_on_settled?: string[] | undefined;
}

/** Following up on a task takes the shared three and nothing more. */
export type ContinueArgs = PromptToolArgs;
