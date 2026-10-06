/**
 * The host's RPC, as the one route between two plugins.
 *
 * It exists as a fake because the seam it models is the seam the whole feature rests
 * on: two plugins, one process, no shared store, and a call that carries the CALLER's
 * location. A double with one method that returns what it was given would keep that
 * promise while proving nothing, so this registry routes by definition id and refuses
 * a call nothing is listening for — which is the failure a TUI really hits when the
 * server plugin is not loaded, and the one a reader that reaches for a method without
 * asking would never see.
 */

/** The error a call gets when nothing is listening. The host reserves the `rpc.` prefix. */
const NOT_FOUND = "rpc.method_not_found";

export function createRpc() {
  const handlers = new Map();
  const calls = [];
  return {
    calls,
    /** Every call's name and input, so a suite can assert the conversation itself. */
    register: async (definition, given) => {
      handlers.set(definition.id, { definition, handlers: given });
      return {
        dispose: async () => {
          handlers.delete(definition.id);
        },
        events: {
          emit: async () => {},
        },
      };
    },
    /** The subclient either plugin builds: one method per declared method. */
    subclient: (definition) => {
      const client = {};
      for (const name of Object.keys(definition.methods)) {
        client[name] = (input) => dispatch(definition, name, input);
      }
      return client;
    },
  };

  async function dispatch(definition, name, input) {
    calls.push({ id: definition.id, input, method: name });
    const registered = handlers.get(definition.id);
    const method = registered?.handlers[name];
    if (!method) throw clientError(NOT_FOUND, `no ${definition.id}.${name}`);
    // The context the host hands a handler, with the ONE thing it is for: answering with
    // a declared error instead of throwing something the caller has to recognise. A fake
    // that omitted `error` would make every declared error in the plugin untestable.
    const context = {
      error: (type, message, data) => clientError(type, message, data),
      signal: new AbortController().signal,
    };
    const answer = await method(input, context);
    if (answer?.type && answer.message) throw answer;
    return answer;
  }
}

/**
 * What a promise client rejects with.
 *
 * `name` and `data` are the two fields a declared error is read by, so they are set
 * explicitly rather than left to `Error`: the production reader looks for them, and a
 * fake that only carried a message would be testing a reader against a fiction.
 */
function clientError(type, message, data) {
  const error = new Error(message);
  // BOTH spellings, because the host has both: `name` is what a promise client
  // rejection carries and what the production reader looks for, and `type` is the field
  // the definition's own `Failure` uses. Setting only one would let a declared error
  // pass for an ordinary answer.
  error.name = type;
  error.type = type;
  if (data !== undefined) error.data = data;
  return error;
}