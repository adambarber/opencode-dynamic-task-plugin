// The operator's cap overlay, as a plugin RPC.
//
// WHY a method and not a file: the TUI is a plugin and the dispatch path is a
// plugin, so a file is the only thing they cannot share without a writer that is
// neither of them. The host's KV is scoped to the plugin that owns it, so the
// overlay cannot simply move into the store the ledger already uses — the TUI has
// no store of its own. A method on the server plugin's RPC is the host's own route
// between the two halves, and it carries the location with it: a call runs in the
// CALLER's location, so no method can name a project directory and a dialog in one
// project cannot reach another's caps.
//
// Both payloads are declared as bare JSON objects on purpose. The host validates
// them, and then WE validate them: the rules that decide what a cap is live in
// `caps.ts`, and a second copy of them in a schema would be the drift that module
// exists to prevent. So the schema says "an object" and the readers below say what
// an overlay is.

import type { RpcHandlers } from "@opencode/plugin/promise/rpc";
// TYPES from the schema package only; the host's `Rpc.define` is deliberately NOT
// called. The built plugin is loaded from a SYMLINKED directory with no node_modules
// beside it, so a bare runtime specifier resolves against the link path and the host
// reports "Cannot find package" — every other import in `dist/` is a `node:` builtin
// for exactly that reason. What `define` buys is one check (no declared error name may
// start with the reserved `rpc.`), so that check is ours to keep, in a test.
import type { PortableDefinition, PortableValueSchema } from "@opencode/schema/rpc";
import { type AgentOverlay, parseAgentOverlay } from "./caps.js";
import { isPlainRecord } from "./host-shape.js";
import { type OverlayRead, UNREADABLE } from "./overlay-store.js";


/**
 * An object schema, closed. Every payload here is an object and nothing else.
 *
 * Annotated with the host's PORTABLE schema type on purpose: the host converts these
 * with its own validator, so a schema has to be one it can convert — and a bare
 * literal is inferred as `Tool.ValueSchema`, the wider union that also names the
 * effect codecs, which does not register at all. Naming the constraint instead of
 * widening around it costs no runtime dependency, and a JSON Schema payload decodes
 * to `unknown` either way, which is exactly what the readers below are for.
 */
const object = (
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): PortableValueSchema => ({ additionalProperties: false, properties, required, type: "object" });

/** `ctx.rpc.register` is given this type. Not written out: the definition IS the contract. */
export type OverlayHandlers = RpcHandlers<typeof OverlayRpc>;

export const OverlayRpc = {
  // Declared, not published. An event here would have no subscriber: the limits dialog
  // is modal and awaited, so there is no handle to interrupt it with, and the honest
  // cost of the missing event is one stale dialog rather than an unused channel. The
  // field is required by the host's own type, so it is stated and left empty.
  events: {},
  id: "dynamic-task-overlay",
  methods: {
    // An input even though it takes nothing: a method with no input is still called
    // with one argument, so declaring it keeps the call site honest about that.
    read: {
      input: object({}),
      output: object(
        {
          // The stored document, exactly as it was written. It is handed over
          // unvalidated because the caps reader owns that judgement, and a second
          // normalizer on this side would be a second answer to the same question.
          caps: { type: "object" },
          present: { type: "boolean" },
          problem: { type: "string" },
        },
        ["present"],
      ),
    },
    write: {
      errors: {
        not_writable: object({ reason: { type: "string" } }, ["reason"]),
      },
      input: object({ caps: { type: "object" } }, ["caps"]),
      output: object({ confirmed: { type: "boolean" } }, ["confirmed"]),
    },
  },
  // `satisfies`, not an annotation: the host's type is a WIDENING, so annotating here
  // would erase the literal method names the payload readers and the TUI client infer.
  // This checks the same conformance and keeps `typeof OverlayRpc` exact.
} satisfies PortableDefinition;

/**
 * The read payload as the host will ACCEPT it.
 *
 * The store's `OverlayRead` spells "absent" and "unreadable" with explicit nulls, but
 * the declared output schema names `caps` as an object and `problem` as a string — and
 * the host rejects a payload that breaks the schema rather than passing it on. So the
 * wire shape states only what is there: a null field would fail validation and lose
 * the whole answer, including the `present` that says a project has caps at all.
 */
export function readWirePayload(read: OverlayRead): Record<string, unknown> {
  return {
    ...(read.caps === null ? {} : { caps: read.caps }),
    present: read.present,
    ...(read.problem === null ? {} : { problem: read.problem }),
  };
}

/**
 * The read payload, narrowed into the ONE shape "the overlay, as found" has.
 *
 * `unknown` is what the host's JSON Schema gives us, so every caller of `read` gets
 * this or gets nothing: a payload that is not the shape we declared is refused here
 * rather than believed further in, where the wrong answer would be a cap.
 */
export function readOverlayPayload(value: unknown): OverlayRead {
  const body = isPlainRecord(value) ? value : {};
  const present = body.present === true;
  const caps = isPlainRecord(body.caps) ? body.caps : null;
  const problem = typeof body.problem === "string" && body.problem !== "" ? body.problem : null;
  // A payload claiming an overlay while carrying neither caps nor a reason is ITSELF
  // the problem, and naming it beats reporting a silence the operator cannot tell
  // apart from "no caps were ever set".
  if (present && caps === null && problem === null) {
    return { caps: null, present: true, problem: UNREADABLE };
  }
  return { caps, present, problem };
}

/**
 * The write payload, narrowed. Null means the caller sent something that is not an
 * overlay — refused rather than stored, because a document half-understood would be
 * caps the operator never wrote.
 *
 * The rule is `caps.ts`'s and only `caps.ts`'s: every question about what a cap is,
 * and about whether a document is a set of them, is answered by the reader the
 * dispatch path is judged against. This adds the refusal, which the file never needed
 * because the file had exactly one writer.
 */
export function readOverlayWrite(value: unknown): AgentOverlay | null {
  if (!isPlainRecord(value)) return null;
  return parseAgentOverlay(value.caps);
}