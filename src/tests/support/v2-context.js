

import { createRpc } from "./mock-rpc.js";
import { assert } from "./runner.js";
import { sleep } from "./timing.js";

/**
 * The v2 plugin's own context, built over the fake host's namespaces.
 *
 * A v1 harness called the entry function and read the hook object it returned.
 * v2 has no hook object: the plugin registers tools by handing an editor to
 * `tool.transform` and reads events off an async iterable, so the only honest
 * fake is one that serves those two surfaces and lets the plugin take them.
 */
export function v2Context(client, directory, options = {}) {
  const tools = new Map();
  const queue = [];
  const rpc = createRpc();
  // FIFO waiter lists, not single slots: deliveries may overlap (`Promise.all` over
  // a burst of terminal events is the real case), and one slot hands a promise to
  // the wrong delivery — the burst hung forever. `parked` is woken by a delivery,
  // `waiting` is signalled by the generator, both in push order.
  const parked = [];
  const waiting = [];

  const context = {
    ...client,
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length === 0) await new Promise((resolve) => parked.push(resolve));
            while (queue.length > 0) {
              yield queue.shift();
              // the loop body has run for this event; release its own delivery
              waiting.shift()?.();
            }
          }
        },
      }),
    },
    location: { directory },
    options,
    // Registered on the CONTEXT, reached through the client's subclient: the two are
    // the same host route, so a fake that gave the plugin one and not the other would
    // let a channel exist that no caller could ever reach.
    rpc: { register: rpc.register },
    tool: {
      // Async across a MACROTASK like the real registration: the editor writes land
      // after `reload` has already published unless setup awaits `transform` first. A
      // microtask-only fake would let the defect pass — microtasks drain before the
      // awaited reload resumes — the way the data-store double did.
      transform: (fn) =>
        Promise.resolve().then(() => {
          fn({ add: (info) => tools.set(info.name, info) });
          return { dispose: async () => {} };
        }),
      reload: async () => {
        context.toolsAtReload = tools.size;
        return true;
      },
    },
  };

  return {
    context,
    deliverEvent: async (event) => {
      // Two SEPARATE wait lists, because the generator and the deliverer park at
      // different moments. Sharing one slot lost the wake-up: the generator parked
      // first writing its resolver, then this overwrote it, so the promise the
      // generator sat on was never called and delivery hung — it survived only when
      // the two happened to interleave the other way round.
      queue.push(event);
      const consumed = new Promise((resolve) => waiting.push(resolve));
      parked.shift()?.();
      await consumed;
      // the subscriber has the event; give the turn it kicked off a tick to start
      await sleep(0);
    },
    rawTools: tools,
    /** The same registry the context registered into, so a caller can reach it. */
    rpc,
  };
}

/**
 * v2 a tool answers `{ content }`, not a bare string. Every suite here wants the
 * string, so the harness unwraps once, at its own boundary, and keeps the tools
 * exactly as the host received them on `rawTools` — the fidelity pin reads those,
 * so this convenience cannot quietly become a different shape than the contract.
 */
export function textTools(rawTools) {
  return Object.fromEntries(
    [...rawTools].map(([name, info]) => [
      name,
      {
        ...info,
        execute: async (raw, ctx) => {
          const answer = await info.execute(raw, ctx);
          assert.ok(
            answer && typeof answer === "object" && typeof answer.content === "string",
            `tool ${name} answered ${JSON.stringify(answer)} — v2 returns { content }, not a string`,
          );
          return answer.content;
        },
      },
    ]),
  );
}
