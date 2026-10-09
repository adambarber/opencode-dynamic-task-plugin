// An identity brand: a session id is a string on the wire, and nothing at the type
// level kept a bare string from being passed where a session id was expected. The
// brand is a module-private unique symbol, and the only way to a value of the type
// is a NARROWING predicate below. Minting happens at the boundary where the host's
// string is read; everything inside the plugin carries the brand.

declare const SESSION_ID: unique symbol;

/** A host session id, once it has been read from the host. */
export type SessionId = string & { readonly [SESSION_ID]: true };

/**
 * The predicate that mints the brand.
 *
 * A brand in TypeScript is an intersection the compiler cannot synthesise from a
 * plain string, but it CAN narrow one to it: `raw is SessionId` narrows a `string`
 * to the branded subtype with no assertion anywhere, which is why the shape of a
 * SessionId is a fact this file asserts once and every caller simply relies on.
 * The predicate doubles as the boundary's own validity rule, so "what counts as an
 * id" is answered in the same place the id is given its type.
 */
function isSessionId(raw: string): raw is SessionId {
  return raw.trim().length > 0;
}

/**
 * Mint a SessionId from a host string. Returns undefined for anything that is not a
 * non-empty id, so the boundary decides what a missing id means instead of a cast.
 */
export function sessionIdOf(raw: string | null | undefined): SessionId | undefined {
  if (raw === null || raw === undefined) return undefined;
  return isSessionId(raw) ? raw : undefined;
}

