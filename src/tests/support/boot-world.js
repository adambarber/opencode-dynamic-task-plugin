/**
 * Boot helpers shared by boot.test.js and boot-delivery.test.js.
 *
 * `anEmptyLedger` is the ledger document shape: `active`, `pending`, `tasks`.
 * `bootWithLedger` builds that document from the case's halves and boots on it
 * through whatever boot function the caller passes (bootOn in boot.test.js,
 * bootedOn in boot-delivery.test.js) — the two callers boot through different
 * doors, so the boot function is a parameter, not a fixed call.
 */

export const anEmptyLedger = () => ({ active: {}, pending: [], tasks: {} });

export const bootWithLedger = (bootFn, halves, hooks) =>
  bootFn(() => ({ ...anEmptyLedger(), ...halves }), hooks);
