/**
 * The runner seam — what a test file in this suite is written against.
 *
 * `node:test` and `node:assert`, declared once. This is not indirection for its
 * own sake: splitting the suite by module produced one file per module, and every
 * one of them opened with the same two imports. That is the same defect the
 * harness was built for — a shape restated at every site — except this one cannot
 * drift, so it is pure noise in the reader's way. Naming the seam here collapses
 * the restated pair to a single line and leaves the imports that DO differ (the
 * module under test, its fixtures) as the head of every file.
 *
 * Re-exported, not wrapped: `describe`/`it`/`beforeEach`/`afterEach` and `assert`
 * keep their identity, so nothing about node:test's behaviour changes.
 *
 * `assert` is `node:assert/strict`, not `node:assert`: the loose default coerces
 * `4` and `"4"` to the same pass, and every suite here wants that to be a failure.
 */

export { describe, it, beforeEach, afterEach } from "node:test";
export { default as assert } from "node:assert/strict";
