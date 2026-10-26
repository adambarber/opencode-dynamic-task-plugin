// The directory argument: worktree-scoped dispatch at the session layer.
//
// Proven 2026-10-26 (the hardstand incident): a child's directory is hardwired to
// the parent's, so worktree isolation is prose, not structure. These cases pin the
// argument end to end: read from raw input, judged against the repository's own
// worktree list (git is the one vouching source — hardstand-style workspaces are
// git worktrees and vouch the same as the host's own), carried on the create body,
// and taught in the tool description.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { DYNAMIC_TASK_DESCRIPTION } from "../../dist/shared/voice.js";
import { readSpawnArgs } from "../../dist/tools/args.js";
import { answerOmits, answerSays, assert, describe, it, setupHarness } from "./support/index.js";

/** A real git repository on disk, with one named worktree beside the main tree. Returns the worktree's RESOLVED path. */
function withWorktree(directory, name) {
  const git = (args, cwd = directory) => {
    const run = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(run.status, 0, `git ${args.join(" ")} failed: ${run.stderr}`);
  };
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  git(["commit", "--allow-empty", "-q", "-m", "root"]);
  git(["worktree", "add", "-q", `workspaces/${name}`, "-b", `wt/${name}`], directory);
  // macOS tmpdirs are /var/... symlinks to /private/var/... — git answers the
  // resolved path, so the test must ask for the resolved one. The worktree lives
  // INSIDE the harness dir: the parent of a temp dir is shared, and two parallel
  // runs would collide on a sibling name.
  return realpathSync(`${directory}/workspaces/${name}`);
}

describe("the directory argument", () => {
  it("is read from the raw args and absent when not sent", () => {
    assert.equal(readSpawnArgs({ directory: "/somewhere/worktree" }).directory, "/somewhere/worktree");
    assert.equal(readSpawnArgs({}).directory, undefined);
    assert.equal(readSpawnArgs({ directory: 42 }).directory, undefined);
    assert.equal(readSpawnArgs(null).directory, undefined);
  });

  it("travels on the create body the host receives", async () => {
    const h = await setupHarness();
    const worktree = withWorktree(h.directory, "workspace-a");
    const out = await h.trySpawn({
      description: "in the worktree",
      directory: worktree,
      prompt: "work",
      subagent_type: "general",
    });
    assert.ok(!out.includes("ERROR"), out.slice(0, 200));
    const body = h.client.testState.sessionBodies.get(worktree) ??
      [...h.client.testState.sessionBodies.values()].find((b) => b.title === "in the worktree");
    assert.ok(body, "the create body is recorded");
    assert.equal(body.location?.directory, worktree, "placement rides the create contract's location");
  });

  it("an unknown directory is refused by name and no session is created", async () => {
    const h = await setupHarness();
    withWorktree(h.directory, "workspace-a");
    const out = await h.trySpawn({
      description: "elsewhere",
      directory: "/not/a/worktree/of-this-repo",
      prompt: "work",
      subagent_type: "general",
    });
    assert.ok(out.includes("ERROR"), "the refusal names itself an error");
    answerOmits(
      out,
      "the refusal names the directory it refused",
      "/not/a/worktree/of-this-repo",
    );
    assert.equal(h.client.testState.sessionBodies.size, 0);
  });

  it("a repository git cannot read refuses the dispatch — unknown must not fall back to allowed", async () => {
    const h = await setupHarness();
    const out = await h.trySpawn({
      description: "unvouched",
      directory: `${h.directory}/nowhere`,
      prompt: "work",
      subagent_type: "general",
    });
    assert.ok(out.includes("ERROR"), "fail-closed: no readable repository, no dispatch");
    assert.equal(h.client.testState.sessionBodies.size, 0);
  });

  it("an absent directory changes nothing — the plugin's own context", async () => {
    const h = await setupHarness();
    const out = await h.trySpawn({
      description: "plain",
      prompt: "work",
      subagent_type: "general",
    });
    assert.ok(!out.includes("ERROR"), out.slice(0, 200));
    const body = [...h.client.testState.sessionBodies.values()].find((b) => b.title === "plain");
    assert.ok(body, "the create happened");
    assert.equal(body.location, undefined, "no location is sent when none was asked for");
  });

  it("the description teaches the argument, so the capability is visible to every parent", () => {
    assert.ok(
      DYNAMIC_TASK_DESCRIPTION.includes("directory"),
      "the spawn description names the directory argument",
    );
    answerSays(
      DYNAMIC_TASK_DESCRIPTION,
      "worktree",
      "the isolation intent is taught, not just the mechanics",
    );
  });
});
