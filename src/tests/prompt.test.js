/**
 * prompt.ts — the message the plugin writes, and the turn it reads back.
 *
 * The prompt payload and its classification on the way out; the message/part
 * guards and the extraction built on them on the way back. The guards come first
 * because extraction is defined in terms of them — a reader that skipped a guard
 * would be a second, divergent definition of what a message is.
 */

import { describe, it, assert } from "./support/runner.js";
import { settled } from "./support/harness.js";
import { opaqueHost } from "./support/opaque-host.js";
import { ASSISTANT_ROLE, classifyPromptError, describeModelShapeError, extractTextFromParts, getLatestAssistantText, hydrateLatestOutcome, invokePrompt, isMessage, isTextPart, messageErrorDetail, messageRoleOf, parseModelOverride, touchedFiles } from "../../dist/shared/prompt.js";
import { assertAbsent, assertEmpty, assertNothing } from "./support/assertions.js";

// The smallest shapes the reader tests are about, stated once: a text part, and
// a message carrying one. A case should be able to say what it means ("an
// assistant turn that said X") instead of the envelope that carries it — the
// envelope is an implementation detail of the host, and restating it per case
// is how two cases end up asserting different things under the same name.
const textPart = (text) => ({ type: "text", text });
const said = (role, text) => ({ role, parts: [textPart(text)] });

// The host's assistant turn as it actually arrives when the turn was ABORTED:
// an error envelope, and no `parts` key at all. Transcribed from the host's own
// record — every one of the 51 aborted turns in the field corpus (2026-09-08→27)
// carries exactly these keys: agent, cost, error, mode, modelID, parentID, path,
// providerID, role, time, tokens. A fixture that added `parts: []` would satisfy
// the reader's guard for the wrong reason, which is how a fully green suite
// shipped a 12% false-success rate: the one turn that produced no output was the
// one turn the reader could not see.
const abortedTurn = (name = "MessageAbortedError", message = "Aborted") => ({
  role: ASSISTANT_ROLE,
  error: { name, data: { message } },
});

describe("describeModelShapeError", () => {
  it("rejects bare ids with the qualified form", () => {
    assert.match(describeModelShapeError("GLM-5.3-Flash"), /providerID\/modelID/);
    assert.match(describeModelShapeError("GLM-5.3-Flash"), /GLM-5\.3-Flash/);
  });

  it("accepts qualified, absent, and blank inputs", () => {
    assertNothing(describeModelShapeError("nvidia/z-ai/glm-5.3"), "a well-formed override");
    assertNothing(describeModelShapeError(undefined), "no model named");
    assertNothing(describeModelShapeError("   "), "a blank model");
  });
});

describe("extractTextFromParts", () => {
  it("joins text parts", () => {
    assert.strictEqual(extractTextFromParts([textPart("Hello "), textPart("World")]), "Hello \nWorld");
  });

  it("filters non-text parts", () => {
    assert.strictEqual(extractTextFromParts([textPart("Hello"), { type: "file", url: "http://example.com" }]), "Hello");
  });

  it("handles empty array", () => {
    assert.strictEqual(extractTextFromParts([]), "");
  });

  it("handles null/undefined in parts", () => {
    assert.strictEqual(extractTextFromParts([textPart("Hello"), null, undefined, textPart("World")]), "Hello\nWorld");
  });
});

// The real 429 signal lives on the message INFO (AssistantMessage.error ->
// ApiError.data.message), never as a part type or a message role: a failed
// turn still has role "assistant" with empty text. The reader must dig the
// info envelope (dual-era, like messageRoleOf) and surface a human detail.
// The envelope the reader must dig. A failed turn still has role
// "assistant", and the human detail is one level down inside info.error — no
// part carries it. Stated once so two cases cannot pass for different reasons.
// The tools that change a file, in the shape the host's own store carries them:
// `state.input.filePath` under a `state.status`. Every fixture here is transcribed
// from that corpus rather than invented, because a `filePath` at the top level
// would pass a reader built against a shape the host never sends.
const toolCall = (tool, filePath, status = "completed") => ({
  type: "tool",
  tool,
  state: { status, input: filePath === undefined ? {} : { filePath } },
});

describe("touchedFiles: the files a child actually changed", () => {
  const touchedIn = (parts) => touchedFiles([{ role: ASSISTANT_ROLE, parts }]);

  it("names what it wrote and edited, with the verb", () => {
    const files = touchedIn([toolCall("edit", "/p/a.ts"), toolCall("write", "/p/b.ts")]);
    assert.deepEqual(files, [
      { verb: "edit", path: "/p/a.ts", incomplete: false },
      { verb: "write", path: "/p/b.ts", incomplete: false },
    ]);
  });

  // The reason the mutators are an allowlist: `read` names its file in exactly
  // the same key, and there are ten times as many of them in the corpus as edits.
  it("does not report a file the child only read", () => {
    assert.deepEqual(touchedIn([toolCall("read", "/p/a.ts")]), []);
  });

  // Two ways a call is not on disk, and they are the same fact to a parent: a
  // write the host rejected, and an edit still running when the child died. Both
  // are work to redo, and reporting the second as finished is the lie.
  it("marks a change that never completed, whether rejected or still running", () => {
    const files = touchedIn([toolCall("write", "/p/b.ts", "error"), toolCall("edit", "/p/c.ts", "running")]);
    assert.deepEqual(files, [
      { verb: "write", path: "/p/b.ts", incomplete: true },
      { verb: "edit", path: "/p/c.ts", incomplete: true },
    ]);
  });

  it("counts a file once, however many times it was edited", () => {
    assert.equal(touchedIn([toolCall("edit", "/p/a.ts"), toolCall("edit", "/p/a.ts")]).length, 1);
  });

  it("reads no messages, or none with parts, as no changes", () => {
    assert.deepEqual(touchedFiles(undefined), []);
    assert.deepEqual(touchedFiles([{ role: ASSISTANT_ROLE }]), []);
  });
});

describe("messageErrorDetail", () => {
  const assistantTurn = (error, parts = []) => ({
    info: error === undefined ? { role: ASSISTANT_ROLE } : { role: ASSISTANT_ROLE, error },
    parts,
  });

  it("extracts ApiError.data.message from the info envelope", () => {
    assert.strictEqual(
      messageErrorDetail(assistantTurn({ name: "APIError", data: { message: "Too Many Requests", statusCode: 429 } })),
      "Too Many Requests",
    );
  });

  it("falls back to the error name when no message", () => {
    assert.strictEqual(
      messageErrorDetail(assistantTurn({ name: "MessageAbortedError" })),
      "MessageAbortedError",
    );
  });

  it("returns empty for a clean assistant message", () => {
    assert.strictEqual(
      messageErrorDetail(assistantTurn(undefined, [textPart("done")])),
      "",
    );
  });

  it("reads the legacy flat error role from its text parts", () => {
    assert.strictEqual(
      messageErrorDetail({ role: "error", parts: [{ type: "text", text: "provider exploded" }] }),
      "provider exploded",
    );
  });

  it("returns empty for non-message values", () => {
    assert.strictEqual(messageErrorDetail(null), "");
    assert.strictEqual(messageErrorDetail("junk"), "");
    assertEmpty(messageErrorDetail({ role: ASSISTANT_ROLE }), "an assistant message carrying no error part");
  });
});

// --- The prompt dance, outbound ----------------------------------------------

describe("prompt dance: invokePrompt", () => {
  /**
   * A client whose only method is the prompt, answering as the case says. The
   * dance is a payload shape and a passthrough of whatever the client answered,
   * so the two cases are the same client with a different response — named once
   * here rather than re-typed per case, which is how one of them grew a second
   * prompt stub nobody was asserting against.
   */
  const clientAnswering = (respond) => opaqueHost({ session: { prompt: async (args) => respond(args) } });

  it("sends the single payload shape and resolves with the client result", async () => {
    let captured;
    const client = clientAnswering((args) => {
      captured = args;
      return { parts: [{ type: "text", text: "hi" }] };
    });
    // `invokePrompt` is fire-and-forget by contract, so the write is observed at
    // the TRANSPORT rather than in a return value the caller never had.
    invokePrompt(client, "ses_1", "hello");
    await settled();
    assert.deepStrictEqual(captured, { sessionID: "ses_1", text: "hello" });
  });

  it("rejects with the raw client error (callers classify)", async () => {
    const failure = new Error("boom");
    const client = clientAnswering(() => { throw failure; });
    // A fire-and-forget write does not reject at the call site; the failure
    // reaches the `onFailure` the caller passed, and is dropped without one.
    const seen = [];
    invokePrompt(client, "ses_1", "hello", {}, (error) => seen.push(error));
    await settled();
    assert.deepStrictEqual(seen, [failure], "the failure reaches onFailure intact");
    invokePrompt(clientAnswering(() => { throw failure; }), "ses_1", "hello");
    await settled();
    assert.deepStrictEqual(seen, [failure], "and is swallowed with no reporter, not thrown at boot");
  });
});

describe("prompt dance: parseModelOverride", () => {
  it("splits provider and model on the first slash", () => {
    assert.deepStrictEqual(parseModelOverride("prov/model-x"), { providerID: "prov", modelID: "model-x" });
    assert.deepStrictEqual(parseModelOverride("a/b/c"), { providerID: "a", modelID: "b/c" });
  });

  it("keeps providerless models with an empty provider", () => {
    assert.deepStrictEqual(parseModelOverride("lonely"), { providerID: "", modelID: "lonely" });
  });

  it("rejects empty and non-string overrides", () => {
    assert.strictEqual(parseModelOverride(""), undefined);
    assert.strictEqual(parseModelOverride("   "), undefined);
    assert.strictEqual(parseModelOverride(null), undefined);
    assert.strictEqual(parseModelOverride(undefined), undefined);
    assertAbsent(parseModelOverride(42), "a model that is not a string names no override");
  });
});

/**
 * The classifier is total: whatever it is handed, it reports that value back and
 * calls nothing but a refusal retryable. Two describes were each asserting a
 * couple of these by hand, which is how "handles non-Error values" came to be
 * split from "handles odd shapes".
 */
function assertClassifiedAs(thrown, said) {
  const classified = classifyPromptError(thrown);
  assert.strictEqual(classified.message, said, `reported value. got: ${JSON.stringify(classified)}`);
  assert.strictEqual(classified.retryable, false, "a value that is not a transient host error is not retryable");
}

describe("prompt dance: classifyPromptError", () => {
  it("marks transport failures retryable", () => {
    for (const msg of ["ECONNREFUSED", "request ETIMEDOUT", "fetch failed", "network error"]) {
      const classified = classifyPromptError(new Error(msg));
      assert.strictEqual(classified.retryable, true, msg);
      assert.strictEqual(classified.message, msg);
    }
  });

  it("marks application errors non-retryable", () => {
    assertClassifiedAs(new Error("session not found"), "session not found");
  });

  it("handles non-Error values", () => {
    assertClassifiedAs("plain string", "plain string");
    assertClassifiedAs(null, "null");
  });
});

describe("prompt dance: extractor shape coverage", () => {

  it("classifyPromptError handles odd shapes", () => {
    assertClassifiedAs({ message: 42 }, "42");
    assertClassifiedAs(undefined, "undefined");
  });
});

// --- The message/part guards, and the extraction built on them ---------------

describe("message/part family guards (Task 08)", () => {
  it("isTextPart accepts only parts that declare themselves text with string content", () => {
    assert.ok(isTextPart({ type: "text", text: "hi" }));
    assert.ok(isTextPart({ type: "text", text: "" }));
    assert.ok(!isTextPart({ type: "text" }));
    assert.ok(!isTextPart({ type: "text", text: 42 }));
    assert.ok(!isTextPart({ type: "image", url: "x" }));
    assert.ok(!isTextPart({ text: "legacy, untyped" }));
    assert.ok(!isTextPart("text"));
    assert.ok(!isTextPart(null));
  });

  it("isMessage is a record that declares a role; parts are content, not identity", () => {
    assert.ok(isMessage({ parts: [] }));
    assert.ok(isMessage({ role: ASSISTANT_ROLE, parts: [{ type: "text", text: "x" }] }));
    assert.ok(!isMessage({ parts: "nope" }));
    assert.ok(!isMessage({}));
    assert.ok(!isMessage(null));
    assert.ok(!isMessage([]));
  });

  // A turn that produced nothing has no parts. Requiring them made content
  // presence a precondition for identity, so the empty turn — the only one
  // whose outcome needed reading — was the one record the reader rejected.
  it("isMessage accepts the host's aborted turn, which carries no parts", () => {
    assert.ok(isMessage(abortedTurn()));
    assert.ok(isMessage({ ...said(ASSISTANT_ROLE, "x"), ...abortedTurn("APIError", "429 Too Many Requests") }));
  });

  // Both readers walk newest-first. One of them must be able to see a turn
  // with no parts, or the walk steps over the newest record and reports an
  // older turn's outcome as the child's.
  it("the newest message decides even when it carries no parts", () => {
    const stream = [said(ASSISTANT_ROLE, "the child's real last words"), abortedTurn()];
    assert.strictEqual(messageErrorDetail(stream[1]), "Aborted");
    assert.strictEqual(messageErrorDetail(stream[0]), "");
    assert.strictEqual(getLatestAssistantText(stream), "the child's real last words");
  });

  it("messageRoleOf reads nested info first, falls back to top level, empty when neither", () => {
    assert.strictEqual(messageRoleOf({ info: { role: ASSISTANT_ROLE }, parts: [] }), "assistant");
    assert.strictEqual(messageRoleOf({ role: "user", parts: [] }), "user");
    assert.strictEqual(messageRoleOf({ parts: [] }), "");
    assert.strictEqual(messageRoleOf({ info: "junk", role: "system", parts: [] }), "system");
    assert.strictEqual(messageRoleOf({ info: { role: 42 }, parts: [] }), "");
  });

  it("the extraction group is built on the guards: same answers through either door", () => {
    const parts = [{ type: "text", text: "a" }, { type: "tool", x: 1 }, { type: "text", text: "b" }];
    assert.strictEqual(extractTextFromParts(parts), "a\nb");
    const messages = [{ info: { role: "user" }, parts: [] }, { role: ASSISTANT_ROLE, parts: [{ type: "text", text: "final" }] }];
    assert.strictEqual(getLatestAssistantText(messages), "final");
    // Non-message entries are skipped by the guard, never thrown on.
    assert.strictEqual(getLatestAssistantText([null, "junk", ...messages]), "final");
  });
});

describe("prompt dance: getLatestAssistantText", () => {
  it("returns the newest assistant text", () => {
    assert.strictEqual(
      getLatestAssistantText([said(ASSISTANT_ROLE, "first"), said("user", "q"), said(ASSISTANT_ROLE, "second")]),
      "second"
    );
  });

  it("reads the latest assistant text, skipping empties", () => {
    assert.strictEqual(getLatestAssistantText([said(ASSISTANT_ROLE, "old"), said(ASSISTANT_ROLE, "new")]), "new");
    assert.strictEqual(getLatestAssistantText([said(ASSISTANT_ROLE, ""), said("user", "q")]), "");
    assert.strictEqual(getLatestAssistantText([]), "");
    assertEmpty(getLatestAssistantText(null), "no message at all");
  });
});

// The reader's one dependency is a message list, so that is the only thing
// these clients declare: a reader that grew a second dependency would have to
// be faked differently, and this is where that would show.
describe("prompt dance: hydrateLatestOutcome", () => {
  const clientReading = (read) => opaqueHost({ session: { context: async () => read() } });

  // The outcome is a fixed shape — text, errorDetail, unreadable — and a case
  // states only the part that moved. The full default is written once, so a new
  // field on the outcome is one edit here instead of a three-field literal at
  // every site, any of which could disagree about what "empty" means.
  const assertHydrated = async (read, expected) => assert.deepStrictEqual(
    await hydrateLatestOutcome(clientReading(read), "ses_1"),
    { text: "", errorDetail: "", unreadable: false, ...expected },
  );

  it("reads the latest assistant text from the session", async () => {
    await assertHydrated(() => [said(ASSISTANT_ROLE, "CHILD_SAYS")], { text: "CHILD_SAYS" });
  });

  it("surfaces the message-level error detail from the same read", async () => {
    const failedTurn = [{
      info: { role: ASSISTANT_ROLE, error: { name: "APIError", data: { message: "Too Many Requests" } } },
      parts: [],
    }];
    await assertHydrated(() => failedTurn, { errorDetail: "Too Many Requests" });
  });

  // The field defect, verbatim. A child aborted mid-turn notifies SUCCESS
  // because the newest turn failed the parts guard, the error walk stepped over
  // it, and the verdict kept the host's `idle`. The child's last real words
  // still make good context beside the error — the text is not the bug, the
  // lost error is — so the outcome keeps both and the kind becomes `error`.
  it("reports an aborted turn as the failure it is, not the turn before it", async () => {
    const stream = [said(ASSISTANT_ROLE, "the child's real last words"), abortedTurn()];
    await assertHydrated(() => stream, { text: "the child's real last words", errorDetail: "Aborted" });
  });

  it("an aborted turn with nothing said before it is still a failure, not (completed)", async () => {
    await assertHydrated(() => [abortedTurn()], { text: "", errorDetail: "Aborted" });
  });

  // A read that could not be made is not a read that found nothing, and the
  // notification has to be able to say which one it is quoting.
  it("falls back to empty fields and admits the read failed when messages fail", async () => {
    const gone = () => {
      throw new Error("gone");
    };
    await assertHydrated(gone, { unreadable: true });
  });
});
