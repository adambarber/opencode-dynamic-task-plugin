//jscpd:ignore-start
import { assert, describe, it } from "./support/runner.js";
import { readContinueArgs, readNotifyArgs, readSpawnArgs } from "../../dist/tools/args.js";

//jscpd:ignore-end
/** A well-formed spawn shape, written once: a field that is dropped or invented shows here. */
const SPAWN_SHAPE = {
  depends_on: ["ses_2"],
  depends_on_settled: [],
  description: "d",
  model: "m",
  prompt: "do it",
  session_id: "ses_1",
  subagent_type: "general",
};

// The boundary readers: host JSON enters executors only through these, so a
// mistyped field reads as absent (with its own refusal voice) and a non-object
// as the all-absent shape — never a throw on the read.
describe("tool argument readers narrow host JSON without casting", () => {
  it("reads a full spawn shape field for field", () => {
    // Pass-through on a valid shape, which is only a real claim because the three
    // cases below each show a shape that does NOT survive intact.
    assert.deepStrictEqual(readSpawnArgs(SPAWN_SHAPE), SPAWN_SHAPE);
  });

  it("reads a mistyped field as absent, not as its mistype", () => {
    assert.deepStrictEqual(readSpawnArgs({ depends_on: "ses_2", description: "d", prompt: 42 }), {
      depends_on: undefined,
      depends_on_settled: undefined,
      description: "d",
      model: undefined,
      prompt: undefined,
      session_id: undefined,
      subagent_type: undefined,
    });
  });

  it("reads a non-object as the all-absent shape", () => {
    assert.deepStrictEqual(readSpawnArgs(null), {});
    assert.deepStrictEqual(readContinueArgs("ses_1"), {});
    assert.deepStrictEqual(readNotifyArgs(undefined), {});
  });

  it("reads continue and notify shapes through the same contract", () => {
    assert.deepStrictEqual(readContinueArgs({ model: 7, prompt: "go", session_id: "ses_1" }), {
      model: undefined,
      prompt: "go",
      session_id: "ses_1",
    });
    assert.deepStrictEqual(readNotifyArgs({ extra: 1, kind: "progress", message: "hi" }), {
      kind: "progress",
      message: "hi",
    });
  });
});
