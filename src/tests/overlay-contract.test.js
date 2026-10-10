/**
 * The overlay RPC against the host's own validation.
 *
 * Every other channel case talks to the store through the mocked client, and the mock
 * does not validate payloads against the declared schema. The REAL host does — with the
 * same JSON Schema → effect codec this file uses — so a handler that returns
 * `{caps: null, problem: null}` compiles fine and still blows up in production with
 * `Expected object at ["caps"]`. These cases decode every payload the handler can
 * produce through that codec, so the contract the dialog depends on is checked against
 * the host's own converter rather than against our memory of it.
 */
// The effect COPY the host validates with. Top-level effect is beta.83, whose
// fromJsonSchemaDocument shape differs — the server runs the nested rc.112, and only it
// reproduces the production error text this gate exists for.

import { overlayHandlers } from "../../dist/entry/state.js";
import { OverlayRpc } from "../../dist/shared/overlay-rpc.js";
import { createOverlayStore, overlayKey } from "../../dist/shared/overlay-store.js";
import { Effect, JsonSchema, Schema, SchemaRepresentation } from "../../node_modules/@opencode/plugin/node_modules/effect/dist/index.js";
import { assert, createMockClient, describe, facadeOver, it, withTempDir } from "./support/index.js";

/** The host's decode for a plain JSON Schema, mirrored from core/rpc.ts. */
async function hostValidates(schema, value) {
  const codec = Schema.make(SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(schema)).ast);
  try {
    await Effect.runPromise(Schema.decodeUnknownEffect(codec)(value));
    return null;
  } catch (error) {
    return error;
  }
}

/** The handlers a real boot would register, over one faked host table. */
async function withHandlers(seed, fn) {
  return withTempDir(async (directory) => {
    const client = createMockClient({});
    const store = createOverlayStore(facadeOver(client), directory);
    if (seed !== undefined) client.testState.kv.set(overlayKey(directory), seed);
    return fn(overlayHandlers(store, { agents: {}, maxConcurrent: 4, maxDepth: 2 }, directory), directory, client);
  });
}

/** Assert the host accepts this payload against its declared schema. */
async function decodes(schema, payload, what) {
  const failure = await hostValidates(schema, payload);
  assert.equal(failure, null, `${what}, got: ${String(failure)}`);
}

describe("the overlay RPC, decoded the way the host decodes it", () => {
  it("accepts the read payload when no overlay is stored", async () => {
    await withHandlers(undefined, async (handlers) => await decodes(OverlayRpc.methods.read.output, await handlers.read(), "absent overlay must still produce a valid payload"));
  });

  it("accepts the read payload when a stored document cannot be read", async () => {
    await withHandlers("not json at all", async (handlers) => await decodes(OverlayRpc.methods.read.output, await handlers.read(), "an unreadable overlay must still produce a valid payload"));
  });

  it("accepts the read payload when an overlay is stored", async () => {
    await withHandlers(JSON.stringify({ maxConcurrent: 3 }), async (handlers) => await decodes(OverlayRpc.methods.read.output, await handlers.read(), "a stored overlay must produce a valid payload"));
  });

  it("accepts the write confirmation", async () => {
    await withHandlers(undefined, async (handlers) => {
      const context = { error: () => { throw new Error("must not refuse"); } };
      await decodes(OverlayRpc.methods.write.output, await handlers.write({ caps: { maxConcurrent: 3 } }, context), "a stored cap must confirm with a valid payload");
    });
  });

  it("accepts the write refusal's error data", async () => {
    await withHandlers(undefined, async (handlers) => {
      let declared = null;
      const context = { error: (name, message, data) => { declared = { data, name }; return declared; } };
      await handlers.write({ caps: "not an overlay" }, context);
      assert.equal(declared.name, "not_writable");
      await decodes(OverlayRpc.methods.write.errors.not_writable, declared.data, "the refusal's data must validate against its declared schema");
    });
  });
});
