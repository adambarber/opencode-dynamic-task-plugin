/**
 * The mock host's own bookkeeping: the state object every endpoint reads and
 * writes, and the boot-time turn seed.
 *
 * Split from `mock-host.js` along the same boundary that file already declares —
 * this module is what the fake server KNOWS, that one is what it ANSWERS. The
 * state object grew until the host file crossed the line cap, and the split is the
 * honest one: a reader looking for an endpoint does not want eighty lines of
 * counters in the way, and a reader asking "what can the fake observe" should not
 * have to scroll past the HTTP surface to find out.
 */

import { closeHostTurn, openHostTurn } from "./mock-transcript.js";

/**
 * The fake's observable world, assembled fresh per client. Every field is a fact
 * a test can ask about; the comments name the ones whose MEANING is not obvious
 * from their name. Fields appear in alphabetical order because the lint asks for
 * it — the order carries no other information.
 */
export function mockState(domain = {}) {
  return {
    // Every abort the plugin ASKED for, refused ones included. `aborted` below
    // records what the host actually did, which is the wrong question for an
    // ownership suite: a plugin that must never stop a session it did not
    // dispatch is caught by the request reaching the server at all, and against a
    // host that would 404 the target the two records diverge exactly where the
    // bug lives.
    abortAttempts: [],
    abortGate: null,
    // Ids whose first abort was lost, so a "loses once" fixture is spent.
    abortThrown: false,
    aborted: [],
    abortsLost: new Set(),
    agentListReads: 0,
    armed: new Set(),
    childPromptFailed: false,
    createThrown: false,
    // Every fault application, counted by name, and every fault a test asked
    // for. See `FAULTS`.
    faults: new Map(),
    // Sessions the host HAS but did not create in this run — a restore. Kept apart
    // from `sessions` so a case can say "this session predates the test" without
    // pretending the plugin's own dispatch created it.
    foreignSessions: new Set(),
    // The host's inbox table, per session: texts parked under delivery
    // "queue", flushed into promptBodies when the turn ends (closeHostTurn).
    // Empty unless the fake presents the inbox surface.
    inboxQueue: new Map(),
    // The host's durable plugin table. A Map here stands in for the host's SQLite
    // `kv`, and it is the ONLY place in the fake that pretends to be a disk.
    kv: domain.kv ?? new Map(),
    logs: [],
    // Faults a case knowingly may not reach — the only way out of the teardown
    // rule, so "the host was hostile" is always a claim somebody made on purpose.
    maybe: new Set(),
    messageReadGate: null,
    notifications: [],
    notifyAttempts: 0,
    // Every notification the plugin DIALS, held or not — the count that proves
    // a held write was never retried behind the parent's back.
    notifyCalls: [],
    permissionCalls: [],
    presenceReads: 0,
    promptBodies: [],
    // Every prompt that carried a delivery verdict, in order — { delivery, to }.
    promptDeliveries: [],
    promptGate: null,
    // Where each session is currently routed, as the two flat v2 calls set it.
    routed: new Map(),
    sessionBodies: new Map(),
    // The model each session is currently running, as the host's projector holds it.
    sessionModels: new Map(),
    sessions: new Set(),
    // How many times the host's status channel was read. Views that already
    // know what they need must not spend a read per row.
    statusReads: 0,
    storageGate: null,
    transcriptReads: 0,
    // Per-session transcript overrides — see `setTranscript` in mock-host. A Map,
    // not a field on the setup hook, because a case needs to change what ONE child
    // says between two settlements of that same child.
    transcripts: new Map(),
    // The host's TURN record per session — the verdict on the last completed
    // execution, absent while a turn is open. Separate from the transcript on
    // purpose: in v2 those are different facts.
    turns: new Map(),
    // Sessions whose transcript refuses to be read.
    unreadable: new Set(),
    unreadableError: new Map(),
  };
}

/**
 * Sessions the host already knows about when the test starts, for boot-time
 * work that must ask the host BEFORE any event has been delivered (reconciling
 * what the last process left running). The seed is the host's TURN RECORD: a
 * verdict means the host has closed that turn, its absence means one is open.
 */
export function seedHostTurns(state, seed = {}) {
  for (const [id, verdict] of Object.entries(seed)) {
    state.sessions.add(id);
    if (verdict === undefined) openHostTurn(state, id);
    else closeHostTurn(state, id, verdict);
  }
}
