/**
 * A host that accepts every call and answers none.
 *
 * A hang is the one failure this plugin cannot recover from: nothing that comes
 * back is wrong, so there is nothing to root-cause and nothing to roll back, and
 * the turn that made the call stays open until somebody gives up on the process.
 *
 * TWO claims, and they need two different instruments — conflating them is how
 * this file was wrong twice before.
 *
 * BOUNDEDNESS is now the compiler's job. Production holds an `OpaqueHost` with no
 * `.session`/`.app`/`.question`; the only way to name a host namespace is
 * `callHost(host, bound, work)`, so a call outside the chokepoint is a build error.
 *
 * ANSWERING is a property of a run, and these cases observe it: `bounded` shortens
 * the plugin's real deadlines (the timer still fires, only the patience changes) and
 * each tool races a local deadline, so a regression FAILS rather than wedging the
 * suite (`--test-timeout=0`). The race is a seatbelt; the type is the evidence.
 *
 * Both caught defects were one mistake — a bound around the wrong expression. `safeLog`
 * bounded the synchronous probe for `app.log` and left the hangable await outside it;
 * `readSessionMessages` threw from its timeout arm, which runs inside the timer, so
 * the throw escaped and the bound's promise stayed pending forever.
 */

import assert from "node:assert";

import {
  answerMatches,
  answerOmits,
  bounded,
  describe,
  it,
  setupHarness,
  sleep,
  withChild,
} from "./support/index.js";
import { API_UNAVAILABLE, NO_ASSISTANT_TEXT, SEE_ERROR_ABOVE } from "../../dist/shared/task-formatting.js";

/**
 * The plugin's own deadlines, shortened so a case can outwait them. The bound is
 * real and the timer still fires — only the patience changes — so what a case
 * observes is the bound, not a mocked clock.
 */
const IMPATIENT_MS = 150;

/** How long a tool may take to answer a host that will never speak. */
const PATIENCE_MS = 2_000;

/** The value a hung call loses to — a string no tool answer can be. */
const NEVER_ANSWERED = "THE-HOST-NEVER-ANSWERED";

/**
 * Run `call` and report whether it came back. The deadline is local and longer than
 * every bound the plugin owns, so losing this race means the call is not bounded at all.
 */
const answered = async (what, call) => {
  const outcome = await Promise.race([
    bounded(IMPATIENT_MS, call).then((text) => ({ text })),
    sleep(PATIENCE_MS).then(() => ({ text: NEVER_ANSWERED })),
  ]);
  assert.notStrictEqual(
    outcome.text,
    NEVER_ANSWERED,
    `${what} answered nothing while the host was silent — an unbounded call, and the opaque host did not prevent it`,
  );
  return outcome.text;
};

describe("a host that accepts every call and answers none", () => {
  it("the plugin still loads against a host that has not spoken yet", async () => {
    // A read that hangs BEFORE load leaves a session that looks alive and cannot
    // work — the shape of a session that never dispatches. What "loads" means here
    // is narrow and checkable: the tool map exists. Whether each tool then ANSWERS
    // is the sweep's claim, not this one's, and a case that tried to prove both
    // proved neither.
    const h = await bounded(IMPATIENT_MS, () => setupHarness({ hooks: { silentHost: true } }));

    const tools = Object.keys(h.tool ?? {}).sort();
    assert.ok(
      tools.includes("dynamic_task"),
      `a silent host at boot must not stop the plugin loading; tools seen: ${JSON.stringify(tools)}`,
    );
  });

  /** Boot against a live host, then go silent for the call under test. */
  const silentHost = async () => {
    const hooks = {};
    const live = await withChild({ harness: { hooks } });
    hooks.silentHost = true;
    return live;
  };

  /** One tool call against a host that has gone silent — the whole point of this file. */
  const underSilence = async (name, call) => {
    const { h } = await silentHost();
    return answered(name, () => call(h));
  };

  // ── the sweep: no tool may wait on a host that will not speak ─────────────

  describe("every tool answers anyway", () => {
    const CASES = [
      ["task_list", (h) => h.tool.task_list.execute({})],
      ["task_status", (h) => h.tool.task_status.execute({ session_id: "ses_mock_1" })],
      ["task_result", (h) => h.tool.task_result.execute({ session_id: "ses_mock_1" })],
      [
        "task_spawn",
        (h) => h.tool.dynamic_task.execute({ description: "doomed", subagent_type: "explore", prompt: "hi" }),
      ],
      ["task_interrupt", (h) => h.tool.task_interrupt.execute({ session_id: "ses_mock_1" })],
      ["task_continue", (h) => h.tool.task_continue.execute({ session_id: "ses_mock_1", prompt: "again" })],
      ["task_notify", (h) => h.tool.task_notify.execute({ message: "still here" })],
    ];

    for (const [name, call] of CASES) {
      it(name, async () => {
        const answer = await underSilence(name, call);

        assert.match(answer, /\S/, `${name} answered with nothing at all`);
      });
    }
  });

  it("a spawn that cannot create a session says so, and does not report a dispatch", async () => {
    const answer = await underSilence("task_spawn", (h) =>
      h.tool.dynamic_task.execute({ description: "doomed", subagent_type: "explore", prompt: "hi" }),
    );

    // A refusal, not a timeout reported as success: the parent must be able to
    // tell that nothing was dispatched, or it will wait on a child that never ran.
    assert.match(answer, /ERROR|unanswered|could not|timed out/i, `spawn must own its failure, got: ${answer}`);
    assert.doesNotMatch(
      answer,
      /\bses_[A-Za-z0-9]+\b/,
      "a session id in a failed spawn is a dispatch the parent cannot account for",
    );
  });

  it("a read that never returns must not read as an empty child", async () => {
    const { h, id } = await withChild();
    const silent = h.silence();
    const unreadable = await answered("task_result", () => h.tool.task_result.execute({ session_id: id }));

    // The same child, with a transcript that answers. Two answers, and the question
    // is whether they DIFFER: a reader that prints "(none yet)" for a host that
    // would not answer has told the parent its child did nothing, which is a
    // different and far more expensive claim than "I could not tell".
    silent.release();
    const readable = await h.tool.task_result.execute({ session_id: id });

    // Production's own vocabulary decides this, not wording invented here: the
    // failed read must name a failure, and must NOT claim the child said nothing —
    // that rendering is reserved for a transcript the host actually sent, empty.
    answerMatches(unreadable, new RegExp(`${API_UNAVAILABLE}|${SEE_ERROR_ABOVE}`.replace(/[()]/g, "\\$&")));
    answerOmits(unreadable, NO_ASSISTANT_TEXT);
    assert.notStrictEqual(
      readable,
      unreadable,
      "a transcript the host never sent must not render as the one it sent empty",
    );
  });

  it("the session survives a host that comes back", async () => {
    const hooks = {};
    const { h, id } = await withChild({ harness: { hooks } });
    hooks.silentHost = true;
    await answered("task_status (silent)", () => h.tool.task_status.execute({ session_id: id }));

    hooks.silentHost = false;
    const recovered = await h.tool.task_status.execute({ session_id: id });

    assert.match(recovered, /\S/, "a host that answers again is a working session, not a wedged one");
  });
});
