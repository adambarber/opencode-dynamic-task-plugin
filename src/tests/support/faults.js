/**
 * The fault ledger: what can go wrong to a host, how a test asks for it, and the
 * accounting that proves the request was honoured.
 *
 * It lives apart from the host surface it corrupts because it is a different
 * concern with a different reader. The surface answers "what does the host say?";
 * this answers "was the host actually hostile?", and the only way to know is to
 * count. That count is what makes a case trustworthy — a fault that arms and
 * never engages looks exactly like a plugin that never made the call, so
 * armFault() and fault() are the only two doors, and the harness fails any arm
 * that never fired.
 *
 */
/**
 * Every fault this fake can inject, named as a test arms it.
 *
 * A fault that does not engage is indistinguishable from a plugin that never made
 * the call: both look like a clean run. That is not a theoretical gap — this fake
 * had a fault that armed, never fired, and reported nothing, so three cases passed
 * against a host that had never gone silent. So every fault branch records a
 * witness, and a test that claims a fault asserts the witness fired (see
 * harness.witnesses). The list is also the gate's list: a name declared here with
 * no witness recorded for it fails safety-invariants.test.js, so a new fault
 * cannot skip the accounting.
 */
export const FAULTS = Object.freeze([
  "silentHost",
  "presenceHang",
  "presenceThrows",
  "agentsListThrows",
  "createThrowsOnce",
  "createRefusedMissing",
  "createReturnsIdless",
  "abortHang",
  "abortThrows",
  "abortThrowsOnce",
  "abortFail",
  "abortLoseOnce",
  "promptHang",
  "promptFail",
  "promptRefusal",
  "promptSyncThrow",
  "childPromptFailOnce",
  "notifyTransport",
  "abortGate",
  "promptGate",
  "messageReadGate",
  "storageGate",
  "storageThrows",
  "storageWriteThrows",
  "unreadableTranscript",
  "eventStreamThrows",
  "eventStreamEnd",
]);

/**
 * How a test arms each fault, by the helper that arms it. The gate scans test
 * sources for these names, so a new arming helper cannot skip the accounting:
 * an armer with no entry here is a fault a test can inject without ever proving
 * the host went hostile.
 */
export const ARMERS = Object.freeze({
  gateAbort: "abortGate",
  gateChildPrompt: "promptGate",
  gateMessageRead: "messageReadGate",
  gateStorage: "storageGate",
  makeUnreadable: "unreadableTranscript",
  silentHost: "silentHost",
});

/** Record that a fault is ARMED. Not the same as firing — see `armedFaults`. */
export const armFault = (state, name) => state.armed.add(name);

/**
 * Count one fault application. The only way a fault is allowed to fire.
 *
 * Armed-but-never-fired is a failure the harness raises in teardown, because a
 * fault that does not engage is a passing case about nothing.
 */
export const fault = (state, name) =>
  state.faults.set(name, (state.faults.get(name) ?? 0) + 1);

/**
 * Arm every fault named by a hooks object, whatever shape the flag takes: a
 * boolean, a Set of ids, an error to throw. The hook name IS the fault name, so
 * a typo is a flag the pin reports rather than a fault that quietly never
 * engages.
 */
export function armHookFaults(state, hooks) {
  const armed = Object.entries(hooks).filter(([flag, value]) => isAFaultArmed(flag, value));
  for (const [flag] of armed) armFault(state, flag);
}

/**
 * What a hooks object is asking for, as one question. A flag that is off, unnamed,
 * or an empty set is the same answer — do not arm it — so three spellings of "no"
 * cannot drift into three spellings of "yes".
 */
function isAFaultArmed(flag, value) {
  if (!FAULTS.includes(flag)) return false;
  if (value === false || value === undefined || value === null) return false;
  return !(value instanceof Set && value.size === 0);
}

/**
 * Consult a fault hook. Reading it is also arming: a test that sets a flag after
 * boot has armed exactly what one that passed it in has, and the teardown rule
 * has to see both.
 */
export const armedFlag = (state, hooks, flag) => {
  if (hooks[flag] === true) armFault(state, flag);
  return hooks[flag];
};

/**
 * A call that never answers, which is what every `*Hang` fault means.
 *
 * A factory and not a shared promise on purpose: an unresolved promise with handlers
 * attached is collectable only once nothing refers to it, so one module-level instance
 * would hold every handler ever attached to it for the life of the process.
 */
export const neverAnswers = () => new Promise(() => {});

/**
 * One endpoint's hostile answer, if one was armed — a hang, or the error it throws,
 * each RECORDED so a case that armed it has a witness and the teardown can fail one
 * that never fired.
 *
 * Returns a function to CALL when a fault applies, rather than performing it: the caller
 * is inside an async arrow and has to leave through `return`, so a helper that threw on
 * its behalf would be unreachable code at every site that uses it.
 *
 * The two flag names are passed IN, and that is not a convenience: the registry gate
 * checks that every declared fault is spoken in the fake by name, because a fault that
 * lives only in the registry is one no branch can record. Building the names from a
 * prefix would have satisfied that gate's letter while breaking its point — the witness
 * is worth two extra words at a call site.
 */
export const armedHostFault = (state, hooks, hangFlag, throwsFlag) => {
  if (armedFlag(state, hooks, hangFlag)) {
    fault(state, hangFlag);
    return neverAnswers;
  }
  if (armedFlag(state, hooks, throwsFlag)) {
    fault(state, throwsFlag);
    return () => {
      throw hooks[throwsFlag];
    };
  }
  return undefined;
};

/**
 * Apply a fault to ONE id, the way every id-keyed fault in the fake does.
 *
 * The three steps were the same in every branch — is this id armed, count the
 * witness, do the damage — and a branch that forgets the middle one is a branch
 * the teardown cannot see. So the counting lives HERE, once, and a fault arming
 * site has nothing left to forget.
 *
 * Returns the fault's own answer, or `undefined` when this id is not armed, so a
 * caller reads as one line: `return forId(...)`.
 */
export const forId = (state, name, ids, id, apply) =>
  ids?.has(id) ? (fault(state, name), apply()) : undefined;

/** Armed faults that never fired — the shape of a case that proved nothing. */
export const unengagedFaults = (state) => [...state.armed].filter((name) => !state.faults.has(name));

/** What actually fired, as a plain object — a test asserts against this. */
export const witnesses = (state) => Object.fromEntries(state.faults);
