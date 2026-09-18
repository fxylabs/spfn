/**
 * The key-lifetime policy — one constant, read by the service that stamps
 * `expiresAt` on registration/rotation and by the mobile contract export
 * that advertises the TTL to clients. Deliberately dependency-free so the
 * contract exporter can import it without pulling repositories or the DB.
 *
 * @module server/lib/key-policy
 */

import type { SessionBindingType } from '../types';

/** A registered public key expires this many days after registration. */
export const KEY_TTL_DAYS = 90;

/**
 * A key bound to a passkey expires this many hours after registration.
 *
 * Hours rather than days is the whole of the protection: a copied session cookie
 * is indistinguishable from the original until the key inside it runs out, and
 * this is how long that window is. Renewal needs a fresh WebAuthn assertion, so
 * the copy cannot follow. One prompt a day is the trade.
 */
export const BOUND_KEY_TTL_HOURS = 24;

/**
 * How long after a bound key expires a renewal is still offered.
 *
 * Past it the account signs in again. The grace exists so a laptop closed over a
 * long weekend does not come back to a sign-in screen; it is not open-ended,
 * because an expired key that could be renewed forever would be a long-lived key
 * with extra steps.
 */
export const BOUND_KEY_RENEW_GRACE_HOURS = 168;

/**
 * How far apart two sightings of one key from two addresses still count as
 * concurrent use.
 *
 * Addresses change legitimately — a phone moving between wifi and cellular does
 * it several times an hour — so this is a signal shown on the device list, never
 * a refusal. The window is what separates "two places at once" from "the same
 * device, later".
 */
export const CONCURRENT_USE_WINDOW_MS = 300_000;

/**
 * Whether a key registered by some path is bound to a passkey.
 *
 * Two facts and no others: the owner asked for it (`users.session_binding`), and
 * the request came through the proxy this package trusts. The second is what
 * `proxy-guard` answers with `clientType: 'web'`, and it is the only signal the
 * backend has that a request is a browser's rather than a direct caller's.
 *
 * `platform` is not consulted and must not be. Its own documentation says it is
 * what the client declares, display-only, and that nothing is authorized by it —
 * the Next.js proxy does not set it at all, so a key it made usually has none,
 * and a native client may declare `'web'` freely. Deciding a key's lifetime by
 * it would make a display field authoritative for the first time.
 *
 * Here rather than in `key.service` so that every registering path can reach the
 * rule without importing the service, and so the rule stays one line nobody has
 * to mock.
 */
export function decideKeyBinding(
    accountBinding: SessionBindingType,
    webProxy: boolean | undefined,
): SessionBindingType
{
    return accountBinding === 'passkey' && webProxy === true ? 'passkey' : 'none';
}
