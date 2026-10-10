// src/shared/model-choice.ts
// The model choice, whole: what a child runs on, who may say so, and the order they
// are asked.
//
// A cap is a number, so `AGENT_CAP_NAMES` is a list of names and one derived shape
// covers every one of them. A model is a qualified string with a provider half and a
// model half, and the plugin already owns its meaning — the `dynamic_task` argument
// gate parses and routes it (prompt.ts), and the task record holds it (task-records.ts).
// This module is that meaning lifted to the whole ladder: layer 4's argument, layer 3's
// per-agent setting, layer 2's global setting, and layer 1's inheritance of the
// dispatching parent's own model, in that order, asked in ONE place.
//
// It is one module for the reason caps is one module: the shape, the read rule, the
// keying and the ladder have to change together, and while they lived apart the concept
// had no owner. It borrows nothing from caps — the key space moved to agent-key.ts so a
// sibling owner never has to import the other.

import { debugLog } from "../debug-logger.js";
import { agentKey } from "./agent-key.js";
import { callHost, type OpaqueHost } from "./client.js";
import { READ_BOUNDS } from "./execution-bound.js";
import { errorMessage, isPlainRecord } from "./host-shape.js";
import { type ModelOverride, parseModelOverride } from "./prompt.js";


/**
 * A model, as the plugin's own vocabulary already spells it: a PAIR, because every
 * consumer of one — routing, the record, the confirmation that renders it — needs the
 * same two halves and not the other's spelling.
 *
 * Declared in prompt.ts beside the parse that produces it and imported here rather
 * than restated, which is the whole reason it is a named import: a second declaration
 * of the pair would be a second place for a field's meaning to drift.
 */
export type { ModelOverride } from "./prompt.js";

/**
 * The settings that may state a model, on the config file or the overlay.
 *
 * A PAIR and not a string: the plugin's routing, the task record and the confirmation
 * all read the model the same way, and a string crossing those boundaries would be a
 * fourth shape for one fact. The qualified TEXT is the document's spelling, and the two
 * functions that cross in and out of it live here rather than at each boundary.
 */
interface ModelSetting {
  readonly model?: ModelOverride | undefined;
}

/**
 * Every scope a stated model can live on, and it is as far as this module reaches into
 * a config.
 *
 * STRUCTURAL, the way `AgentCapSource` is and for the same reason: naming the config
 * here makes `model-choice -> config`, and `config` needs the model's read rule, so the
 * pair would be a cycle. `config` owns precedence between the places a config comes from;
 * this owns what a model choice means.
 */
export interface ModelScope extends ModelSetting {
  readonly agents: Readonly<Record<string, ModelSetting>>;
}

/** An agent's own model, the global one, or nothing — the per-agent setting wins. */
export function resolveAgentModel(scope: ModelScope, agent: string): ModelOverride | undefined {
  return scope.agents[agentKey(agent)]?.model ?? scope.model;
}

/** What the ladder resolves, and nothing about how. */
export interface ChildModelRequest {
  /** Layer 4: the model the dispatching agent asked for, already parsed for it. */
  readonly requested?: ModelOverride | undefined;
  /** Layers 3 and 2: the settings in force, overlay applied. */
  readonly scope: ModelScope;
  /** The agent being dispatched, in the host's own spelling. */
  readonly agent: string;
  /**
   * Layer 1: how to read the dispatching parent's own model.
   *
   * A THUNK, so that a configured model never pays for a host call and an unreadable
   * parent can never refuse a dispatch. A default that can fail is not a default, so
   * the read happens only when the layers above it said nothing — and the host call it
   * wraps is bounded and answers "no model" rather than throwing, so a host that never
   * answers costs the child the inheritance and nothing else.
   *
   * ASYNC because the host is: a session's model is a durable fact the host answers over
   * the wire, and no synchronous read of one exists. That is the only reason the ladder
   * itself is a promise, and it is why the promise is never entered on the layers above.
   */
  readonly inherit: () => Promise<ModelOverride | undefined>;
}

/**
 * The whole ladder, in one call: the argument, the agent's own setting, the global
 * one, then the dispatching parent's own model, then no override at all.
 *
 * One call site for the precedence, because precedence spread over four sites is four
 * chances to answer the same question four different ways — and the one that drifts is
 * always the layer that was added last. The inheritance thunk runs only when the layers
 * above it said nothing, which is what makes a configured setting free of the host and
 * makes an unreadable parent indistinguishable from a parent with no model of its own.
 */
export async function resolveChildModel(request: ChildModelRequest): Promise<ModelOverride | undefined> {
  if (request.requested !== undefined) return request.requested;
  const stated = resolveAgentModel(request.scope, request.agent);
  if (stated !== undefined) return stated;
  return request.inherit();
}

// ─── reading a model out of untrusted JSON ───────────────────────────────────

/**
 * A model as a document spells it, read into the pair every consumer holds.
 *
 * One reader, because the config file and the overlay both carry `model` as qualified
 * text and a second reader of the same untrusted JSON is the disagreement caps.ts exists
 * to prevent. The rule is the argument gate's own — a bare id fails there loudly, so a
 * config that states one produces a pair with an empty provider and routes to nothing —
 * and anything the rule drops is left for the layer below to answer, exactly as a
 * dropped cap is.
 */
export function readModelSetting(raw: unknown): ModelOverride | undefined {
  if (typeof raw === "string") {
    const parsed = parseModelOverride(raw.trim());
    return parsed !== undefined && parsed.providerID !== "" && parsed.modelID !== "" ? parsed : undefined;
  }
  if (!isPlainRecord(raw)) return undefined;
  const { providerID, modelID } = raw;
  return typeof providerID === "string" && providerID !== "" && typeof modelID === "string" && modelID !== ""
    ? { modelID, providerID }
    : undefined;
}

/**
 * The qualified text a pair is spelled as in a document — the ONE serializer.
 *
 * The host's own spelling, `providerID/modelID`, because the argument gate parses exactly
 * that and the model selector the TUI's catalog reads names its rows that way. Two
 * spellings of one override would give the dispatch path a string the argument gate and
 * the catalog both have to be taught to recognise.
 */
export function spellModel(model: ModelOverride): string {
  return `${model.providerID}/${model.modelID}`;
}

/** Whether a pair is a model the plugin can route, as a guard over unknown input. */
export function isModelOverride(value: unknown): value is ModelOverride {
  if (typeof value !== "string") return isPair(value);
  return readModelSetting(value) !== undefined;
}

function isPair(value: unknown): value is ModelOverride {
  if (!isPlainRecord(value)) return false;
  const { providerID, modelID } = value;
  return typeof providerID === "string" && providerID !== "" && typeof modelID === "string" && modelID !== "";
}

/**
 * The top-level model of an untrusted body, read by the one rule.
 *
 * The overlay's document and the config file's top level both carry `model` as qualified
 * text, and a second reader of the same untrusted JSON is the disagreement caps.ts exists
 * to prevent. This is the one place a stated global model is folded in or left out.
 */
export function readOverlayModel(raw: unknown): ModelOverride | undefined {
  if (!isPlainRecord(raw)) return undefined;
  return readModelSetting(raw.model);
}

/**
 * The session's own model, projected to the routing pair — the host's `Model.Ref`.
 *
 * The inheritance layer's value, and the only shape it can be read from: the host
 * stores a session's model as `{id, providerID, variant?}` and the plugin routes a
 * pair, so the projection happens once here rather than at the read site. A session
 * that has no model of its own answers `undefined`, which is inheritance having
 * nothing to hand down — the host's own answer, not a failure.
 */
export function modelOverrideOf(session: unknown): ModelOverride | undefined {
  if (!isPlainRecord(session)) return undefined;
  const {model} = session;
  if (!isPlainRecord(model)) return undefined;
  const { providerID, id } = model;
  if (typeof providerID !== "string" || providerID === "") return undefined;
  if (typeof id !== "string" || id === "") return undefined;
  return { modelID: id, providerID };
}

/**
 * Layer 1, as the host answers it: the dispatching parent's own model, or nothing.
 *
 * A BOUNDED read, the same one the presence check makes — a session's model is a
 * property of a session that is still there, so "is this session here" and "what is it
 * running on" are one call against the same local server and the same deadline. A
 * second bound for the read would be a second opinion about how patient a session read
 * should be, and the two would drift.
 *
 * It NEVER rejects, and that is the whole design of the layer: a host that refuses (a
 * parent that is gone, a 404, an error) or a host that never answers both answer "this
 * parent has no model to hand down", which the ladder already has a meaning for. An
 * inheritance that could fail would make a default that can fail — the thing the thunk
 * shape exists to prevent.
 */
export async function readParentModel(
  host: OpaqueHost | undefined | null,
  sessionId: string | null | undefined,
): Promise<ModelOverride | undefined> {
  if (host == null || sessionId == null || sessionId === "") return undefined;
  try {
    const read = await callHost(host, READ_BOUNDS.presence, (client) => client.session.get({ sessionID: sessionId }), null);
    return read.timedOut ? undefined : modelOverrideOf(read.value);
  } catch (error: unknown) {
    debugLog("parent-model", "", "inherit-unavailable", { error: errorMessage(error) });
    return undefined;
  }
}
