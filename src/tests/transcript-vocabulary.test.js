import { describe, it, assert } from "./support/runner.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSISTANT_ROLE,
  getLatestAssistantText,
  isMessage,
  messageErrorDetail,
  messageRoleOf,
  toolCallOf,
  touchedFiles,
} from "../../dist/shared/prompt.js";

const gold = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "support", "v2-transcript.json"), "utf8"),
);

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
    const touched = touchedFiles([{ type: ASSISTANT_ROLE, time: { created: 1 }, content: [edit] }]);
    assert.deepStrictEqual(touched, [{ verb: "edit", path: "/tmp/derived", incomplete: false }]);
  });

  it("reads a flat error off the message", () => {
    assert.strictEqual(messageErrorDetail(gold.assistantError), "getaddrinfo ENOTFOUND opencode.ai");
  });

  it("a reasoning-only turn yields no text, like v1", () => {
    const reasoning = gold.assistantText.content.filter((p) => p.type === "reasoning");
    assert.ok(reasoning.length > 0, "golden holds reasoning");
    assert.strictEqual(
      getLatestAssistantText([{ type: ASSISTANT_ROLE, time: { created: 1 }, content: reasoning }]),
      "",
    );
  });
});
