import { describe, it, assert } from "./support/runner.js";
import { readContinueArgs, readNotifyArgs, readSpawnArgs } from "../../dist/tools/args.js";

// The boundary readers: host JSON enters executors only through these, so a
// mistyped field reads as absent (with its own refusal voice) and a non-object
// as the all-absent shape — never a throw on the read.
describe("tool argument readers narrow host JSON without casting", () => {
  it("reads a full spawn shape field for field", () => {
    assert.deepStrictEqual(
      readSpawnArgs({
        session_id: "ses_1",
        prompt: "do it",
        model: "m",
        description: "d",
        subagent_type: "general",
        depends_on: ["ses_2"],
        depends_on_settled: [],
      }),
      {
        session_id: "ses_1",
        prompt: "do it",
        model: "m",
        description: "d",
        subagent_type: "general",
        depends_on: ["ses_2"],
        depends_on_settled: [],
      },
    );
  });

  it("reads a mistyped field as absent, not as its mistype", () => {
    assert.deepStrictEqual(readSpawnArgs({ prompt: 42, depends_on: "ses_2", description: "d" }), {
      session_id: undefined,
      prompt: undefined,
      model: undefined,
      description: "d",
      subagent_type: undefined,
      depends_on: undefined,
      depends_on_settled: undefined,
    });
  });

  it("reads a non-object as the all-absent shape", () => {
    assert.deepStrictEqual(readSpawnArgs(null), {});
    assert.deepStrictEqual(readContinueArgs("ses_1"), {});
    assert.deepStrictEqual(readNotifyArgs(undefined), {});
  });

  it("reads continue and notify shapes through the same contract", () => {
    assert.deepStrictEqual(readContinueArgs({ session_id: "ses_1", prompt: "go", model: 7 }), {
      session_id: "ses_1",
      prompt: "go",
      model: undefined,
    });
    assert.deepStrictEqual(readNotifyArgs({ message: "hi", kind: "progress", extra: 1 }), {
      message: "hi",
      kind: "progress",
    });
  });
});
