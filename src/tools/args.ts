// The tools' argument contract (entry/tools boundary), stated once. The JSON
// schema the host validates is built from these names in tools/index.ts; this
// module is the TypeScript side of the same three arguments, so a tool cannot
// declare an argument the executor does not read or read one it never declared.
//jscpd:ignore-start
import { isEventRecord } from "../shared/host-shape.js";

//jscpd:ignore-end
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
// The boundary readers: host-validated JSON arrives as `unknown`, and each
// tool's executor declares its arguments above. The reader is the one place
// that turns the former into the latter, so no executor casts its input.
// A field the host validated: present means correctly typed. Anything else
// is absent, and absence already has its own refusal voice downstream.
function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function optionalStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry): entry is string => typeof entry === "string") ? value : undefined;
}
// A non-object carries no fields; the all-absent shape lets the executor's
// own voice name the first missing one instead of throwing on the read.
function readPromptFields(raw: Record<string, unknown>): PromptToolArgs {
  return {
    model: optionalString(raw.model),
    prompt: optionalString(raw.prompt),
    session_id: optionalString(raw.session_id),
  };
}
export function readSpawnArgs(raw: unknown): SpawnArgs {
  if (!isEventRecord(raw)) return {};
  return {
    ...readPromptFields(raw),
    depends_on: optionalStringList(raw.depends_on),
    depends_on_settled: optionalStringList(raw.depends_on_settled),
    description: optionalString(raw.description),
    subagent_type: optionalString(raw.subagent_type),
  };
}
export function readContinueArgs(raw: unknown): ContinueArgs {
  if (!isEventRecord(raw)) return {};
  return readPromptFields(raw);
}
// Unknown fields because the executor narrows them itself: the message has
// its own required-voice and the kind its own refusal, both downstream.
export interface NotifyArgs {
  message?: unknown;
  kind?: unknown;
}
export function readNotifyArgs(raw: unknown): NotifyArgs {
  if (!isEventRecord(raw)) return {};
  return { kind: raw.kind, message: raw.message };
}
