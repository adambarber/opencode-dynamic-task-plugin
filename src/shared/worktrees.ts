// src/shared/worktrees.ts — the one vouching source for the directory argument.
//
// A dispatch may place its child session in another worktree of THIS project's
// repository. What vouches for a worktree is the repository itself: `git worktree
// list --porcelain` enumerates every worktree of the repo, whoever created it —
// the host's own sandbox worktrees, a workspace manager's (hardstand-style
// `.hardstand/<name>/` directories are git worktrees), or an operator's hands.
// The plugin learns git and learns nothing about any workspace manager: tying the
// plugin to one tool's plumbing would refuse the others for no reason git can see.
//
// No cache: a workspace created seconds ago must be dispatchable immediately; a
// TTL would turn a fresh `hardstand up` into a refusal.
//
// Fail-closed: a repository git cannot read answers no worktrees, so a requested
// directory is refused rather than allowed unvouched — the same posture the
// capacity judgment keeps (an admission decision never falls back to "allowed").

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

/** The filesystem's own answer for a path — resolved, no symlink aliasing. */
export function resolvePath(path: string): string {
  return realpathSync(path);
}

/** One worktree of the repository, as `git worktree list --porcelain` spells it. */
export interface WorktreeEntry {
  readonly path: string;
}

/**
 * Every worktree of the repository at `directory`, or null when git cannot
 * answer (not a repository, git missing, or a timeout). Null is "unknown", not
 * "empty" — the caller refuses on unknown and refuses on empty the same way,
 * but the log line differs.
 */
export function listWorktrees(directory: string, timeoutMs: number): WorktreeEntry[] | null {
  const run = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: directory,
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (run.error || run.status !== 0 || typeof run.stdout !== "string") return null;
  const entries: WorktreeEntry[] = [];
  for (const line of run.stdout.split("\n")) {
    // Porcelain: blocks of `worktree <path>` (then branch/HEAD/bare lines).
    if (line.startsWith("worktree ")) entries.push({ path: line.slice("worktree ".length) });
  }
  return entries;
}

/** The refusal's known-entries rendering, in the admission gate's voice. */
export function worktreeListForRefusal(entries: WorktreeEntry[] | null): string {
  if (entries === null) return "(the repository could not be asked — git did not answer)";
  if (entries.length === 0) return "(none — this project is not a git repository git can read)";
  return entries.map((entry) => entry.path).join(", ");
}
