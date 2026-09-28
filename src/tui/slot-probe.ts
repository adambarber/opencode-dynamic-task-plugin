import { jsx } from "@opentui/solid/jsx-runtime";
import type { JSX } from "solid-js";
import type { TuiHostSlotMap, TuiSlotContext, TuiSlotPlugin } from "@opencode-ai/plugin/tui";
import { screenTokens } from "./theme.js";

/**
 * A probe in EVERY host slot, printing that slot's own name.
 *
 * This exists to settle one question with observation instead of inference: which slots the
 * host actually renders, on which screen, and where. Slot names have been read off a GitHub
 * tag and reasoned about since, and that reasoning produced a wrong answer twice — a host
 * component was blamed for a number the plugin draws, and a mount ordering was blamed for a
 * row the host builds. A probe that prints its own name in every slot replaces all of that
 * with something to read off the screen.
 *
 * It is a DIAGNOSTIC, not a feature. Removing it is deleting one call in `index.ts` and this
 * file.
 */

/**
 * Every slot the host declares, named once and never at a call site.
 *
 * `satisfies` is the whole point: the list is checked against the host's own slot map, so a
 * typo is a build failure rather than a slot that silently never renders. The installed
 * `@opencode-ai/plugin` is the only available source — `api.slots` exposes `register` and
 * nothing else, and `TuiHostSlotMap` is a type, erased at runtime.
 *
 * Order is the host's declaration order, so the probe's own listing reads the way the host
 * declares them.
 */
const HOST_SLOTS = [
  "app",
  "app_bottom",
  "home_logo",
  "home_prompt",
  "home_prompt_right",
  "home_bottom",
  "home_footer",
  "session_prompt",
  "session_prompt_right",
  "sidebar_title",
  "sidebar_content",
  "sidebar_footer",
] as const satisfies readonly (keyof TuiHostSlotMap)[];

type CoveredSlot = (typeof HOST_SLOTS)[number];

/**
 * The pin: "every slot" is an invariant, not a promise.
 *
 * `Exclude<…, never>` is `{}`, which the empty object literal below satisfies. Add one slot
 * to the host and the key appears, `{}` no longer satisfies it, and `npx tsc --noEmit` fails
 * until the probe covers it. Exported because a type nothing references is a type nothing
 * checks, and an unused local would fail the build for the wrong reason.
 */
export const SLOT_PROBE_COVERS_EVERY_HOST_SLOT: Record<Exclude<keyof TuiHostSlotMap, CoveredSlot>, never> = {};

/**
 * What a probe renders: its own name, bracketed so it cannot be mistaken for content.
 *
 * This is the PROPS and not the element, because `jsx` from the opentui runtime needs a
 * live renderer and a `node --test` run has none — the same reason `gaugeProps` is the
 * tested surface for the counter. Keeping the label in a plain function is also what lets a
 * case read back the text and compare it to the key the probe was registered under.
 */
export function slotLabelProps(ctx: TuiSlotContext, name: CoveredSlot): Record<string, unknown> {
  return {
    fg: screenTokens(ctx.theme).value,
    get children() {
      return `[${name}]`;
    },
  };
}

/**
 * One plugin per slot, each rendering only the name it was registered under.
 *
 * The name travels as the KEY's value through the map, so the label and the slot it is
 * registered in cannot drift apart: there is no string at a call site to get wrong.
 */
export function slotProbePlugins(): TuiSlotPlugin[] {
  return HOST_SLOTS.map((name) => ({
    slots: {
      [name]: (ctx: TuiSlotContext) => jsx("text", slotLabelProps(ctx, name) as Record<string, unknown>) as unknown as JSX.Element,
    },
  }));
}
