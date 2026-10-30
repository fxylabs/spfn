/**
 * The social account a sign-in came through, as `auth.login` / `auth.register` carry it (#154)
 */

import { type NormalizedIdentity } from './provider';

/**
 * `providerUserId` and `providerHandle` for the sign-in events.
 *
 * The handle is the one this sign-in reported — the current BattleTag — so an app
 * reading the event never sees the stale value the row held before it.
 */
export function providerAccountFields(identity: NormalizedIdentity): { providerUserId: string; providerHandle?: string }
{
    return { providerUserId: identity.providerUserId, providerHandle: identity.handle };
}
