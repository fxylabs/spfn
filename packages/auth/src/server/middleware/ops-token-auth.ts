/**
 * Ops Token Authentication Middleware
 *
 * The auth half of the CLI-first ops surface (`@spfn/core/ops`). Pass
 * `opsTokenAuth` to `createOpsRouter({ ... }, { auth: opsTokenAuth })` and
 * every ops route requires `Authorization: Bearer spfn_ops_...`.
 *
 * A verified token is a machine principal, not a user session: it lands in
 * the context as `opsToken` (read with `getOpsToken`), and `AuthContext`
 * stays unset. Per-route authorization is `requireOpsScope('waitlist:read')`,
 * matched against the token's scope list ('*' grants all).
 *
 * Refusals follow the case table fixed at design time:
 *
 *   token \ scope     sufficient   insufficient
 *   valid             200          403
 *   expired           401          401
 *   revoked           401          401
 *   unknown           401          401
 *   missing           401          401
 *
 * Expired, revoked, and unknown share one refusal message — whether a
 * presented secret ever existed is not inferable from the answer.
 *
 * Auto-skips the global 'auth' middleware, like `oneTimeTokenAuth`.
 */

import type { Context, Next } from 'hono';
import { defineMiddleware, defineMiddlewareFactory } from '@spfn/core/route';
import { ForbiddenError, UnauthorizedError } from '@spfn/core/errors';
import { verifyOpsTokenService, type VerifiedOpsToken } from '../services/ops-token.service';

/** Read the verified ops token a handler runs under. */
export function getOpsToken(c: Context): VerifiedOpsToken | null
{
    return (c.get('opsToken') as VerifiedOpsToken | undefined) ?? null;
}

export const opsTokenAuth = defineMiddleware('opsTokenAuth', async (c, next) =>
{
    const token = extractBearer(c.req.header('Authorization'));

    if (!token)
    {
        throw new UnauthorizedError({ message: 'Ops token required: Authorization: Bearer <token>' });
    }

    const verified = await verifyOpsTokenService(token);

    if (!verified)
    {
        throw new UnauthorizedError({ message: 'Invalid ops token' });
    }

    c.set('opsToken', verified);

    await next();
}, { skips: ['auth'] });

/**
 * Require the verified ops token to carry every named scope.
 *
 * Must run after `opsTokenAuth` — on a `createOpsRouter` surface it always
 * does, because the factory injects the auth middleware first.
 *
 * @example
 * ```ts
 * export const listSignups = route.get('/_ops/signups')
 *     .use([requireOpsScope('waitlist:read')])
 *     .handler(async () => { ... });
 * ```
 */
export const requireOpsScope = defineMiddlewareFactory('opsScope',
    (...scopes: string[]) => async (c: Context, next: Next) =>
    {
        const token = getOpsToken(c);

        if (!token)
        {
            throw new UnauthorizedError({ message: 'Ops token required: Authorization: Bearer <token>' });
        }

        const granted = new Set(token.scopes);
        const missing = scopes.filter(scope => !granted.has(scope) && !granted.has('*'));

        if (missing.length > 0)
        {
            throw new ForbiddenError({ message: `Ops token lacks scope: ${missing.join(', ')}` });
        }

        await next();
    });

function extractBearer(header: string | undefined): string | null
{
    if (!header || !header.startsWith('Bearer '))
    {
        return null;
    }

    return header.substring(7);
}
