import {
  ASSISTANT_ROLE,
  getLatestAssistantText,
  isMessage,
  messageErrorDetail,
  messageRoleOf,
  toolCallOf,
  touchedFiles,
} from "../../dist/shared/prompt.js";
import { assert, describe, it } from "./support/runner.js";
import { TESTS_DIR } from "./support/corpus.js";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const gold = JSON.parse(readFileSync(join(TESTS_DIR, "support", "v2-transcript.json"), "utf8"));

describe("transcript readers speak the v2 host vocabulary", () => {
  it("recognizes a flat assistant message with content and no parts", () => {
    assert.strictEqual(isMessage(gold.assistantText), true);
  });

  it("reads the role off type, not info.role", () => {
    assert.strictEqual(messageRoleOf(gold.assistantText), ASSISTANT_ROLE);
    assert.strictEqual(messageRoleOf(gold.userText), "user");
  });

  it("reads the newest assistant text out of content", () => {
    const text = getLatestAssistantText([gold.userText, gold.assistantText]);
    assert.ok(text.length > 0, "a real v2 child turn must yield text");
    assert.ok(!text.includes("undefined"), "no hole in the walk");
  });

  it("reads the tool name off name, not tool", () => {
    const entry = gold.assistantTool.content.find((p) => p.type === "tool");
    const call = toolCallOf(entry);
    assert.ok(call !== null, "a real v2 tool entry must project");
    assert.strictEqual(call.tool, "bash");
    assert.strictEqual(call.incomplete, false);
  });

  it("finds a mutating call inside content", () => {
    const entry = gold.assistantTool.content.find((p) => p.type === "tool");
    const edit = { ...entry, name: "edit", state: { ...entry.state, input: { filePath: "/tmp/derived" } } };
    const touched = touchedFiles([{ content: [edit], time: { created: 1 }, type: ASSISTANT_ROLE }]);
    assert.deepStrictEqual(touched, [{ incomplete: false, path: "/tmp/derived", verb: "edit" }]);
  });

  it("reads a flat error off the message", () => {
    assert.strictEqual(messageErrorDetail(gold.assistantError), "getaddrinfo ENOTFOUND opencode.ai");
  });

  it("a reasoning-only turn yields no text, like v1", () => {
    const reasoning = gold.assistantText.content.filter((p) => p.type === "reasoning");
    assert.ok(reasoning.length > 0, "golden holds reasoning");
    assert.strictEqual(
      getLatestAssistantText([{ content: reasoning, time: { created: 1 }, type: ASSISTANT_ROLE }]),
      "",
    );
  });
});
