/**
 * `permission.reply` as v2's contract makes it, and the refusal of every shape that
 * is not that.
 *
 * Split out of `mock-host.js` because a permission answer is the one host call whose
 * CONTRACT was written down wrong four times over: flat `{sessionID, requestID,
 * decision}`, with the decision answering the whole request rather than one question
 * of it. A mock that accepts any shape is exactly what let four wrong field names
 * pass as a green suite, so this one refuses them and records the call actually made.
 *
 * Ground truth, not a stand-in for plugin code (Tenet 12): the thing under test is
 * never faked here. Only the host is, because the server is not what these suites are
 * about.
 */
//jscpd:ignore-start
import { assert } from "./runner.js";

//jscpd:ignore-end
/**
 * Refuse a question settlement the host would not accept. Derived from the SDK's
 * QuestionReplyData/QuestionRejectData: the path key is `requestID` (verified
 * against opencode 1.18.30, which serves /question/{requestID}/reply and no
 * {id} route), a reply body is `answers` — one entry per asked question, each a
 * list of chosen labels — and the reject body is `never`. Asserting the contract
 * HERE is what makes the harness a check on the plugin's host calls, not just a
 * record of them.
 */
function assertPermissionReply({ sessionID, requestID, decision }) {
  assert.ok(typeof sessionID === "string", `permission.reply must name the session it answers in (got ${JSON.stringify(sessionID)})`);
  assert.ok(typeof requestID === "string", `permission.reply must address the request by requestID (got ${JSON.stringify(requestID)})`);
  assert.ok(
    PERMISSION_DECISIONS.includes(decision),
    `decision must be one of ${PERMISSION_DECISIONS.join(" | ")} — the host answers a whole request, not one question of it (got ${JSON.stringify(decision)})`,
  );
}

/** v2 answers a permission with one word; literals here mean a typo cannot pass. */
const PERMISSION_DECISIONS = ["once", "always", "reject"];

/** The endpoint the mock client installs for `permission.reply`. */
export const permissionEndpoint = (state, hooks) =>
  async (args) => {
    const { sessionID, requestID, decision } = args;
    if (hooks.permissionReplyThrows) throw new Error("permission.reply failed");
    assertPermissionReply(args);
    state.permissionCalls.push({ decision, requestID, sessionID });
    return { ok: true };
  };
