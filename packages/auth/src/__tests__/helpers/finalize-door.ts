/**
 * `oauthFinalizeAuth` for a suite with no database.
 *
 * The finalize route answers the principal its door admitted. Admitting one
 * reads the key row, which a unit suite does not have, so this stands in for the
 * door: a request the proxy signed (`Authorization: Bearer …`, `X-Key-Id`) is
 * the signing key of `userId`, anything else is refused as `authenticate`
 * refuses a missing header, and the second-factor 202 passes without a
 * principal, as the real door lets it.
 *
 * @example
 * vi.mock('../../server/middleware/oauth-finalize-auth', async () =>
 *     (await import('../helpers/finalize-door')).finalizeDoorStandIn('7'));
 */

import { defineMiddleware } from '@spfn/core/route';
import { UnauthorizedError } from '@spfn/core/errors';

export function finalizeDoorStandIn(userId: string)
{
    return {
        oauthFinalizeAuth: defineMiddleware('oauthFinalizeAuth', async (c, next) =>
        {
            const body: unknown = await c.req.json().catch(() => null);
            const keyId = c.req.header('x-key-id');

            if (typeof (body as { mfaChallenge?: unknown } | null)?.mfaChallenge !== 'string')
            {
                if (!keyId || !c.req.header('authorization')?.startsWith('Bearer '))
                {
                    throw new UnauthorizedError({ message: 'Authentication header missing or invalid: Bearer {token}' });
                }

                c.set('auth' as never, { userId, keyId, user: { id: Number(userId), passwordChangeRequired: false } } as never);
            }

            await next();

            return undefined;
        }, { skips: ['auth'] }),
    };
}
