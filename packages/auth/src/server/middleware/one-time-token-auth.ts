/**
 * One-Time Token Authentication Middleware
 *
 * Authenticates requests using a one-time token instead of JWT.
 * Extracts token from query parameter `?token=xxx` or `Authorization: OTT xxx` header.
 *
 * On success, injects AuthContext identical to the `authenticate` middleware,
 * making it transparent to downstream handlers using `getAuth(c)`.
 *
 * Auto-skips the global 'auth' middleware.
 *
 * @example
 * ```typescript
 * export const uploadFile = route.post('/files/upload')
 *     .use([oneTimeTokenAuth])
 *     .handler(async (c) => {
 *         const { userId } = getAuth(c);
 *         // handle file upload...
 *     });
 * ```
 */

import { defineMiddleware } from '@spfn/core/route';
import { UnauthorizedError } from '@spfn/core/errors';
import { verifyOneTimeTokenService } from '../services/one-time-token.service';
import { findUserWithEffectiveRole, userProfilesRepository } from '@spfn/auth/server';

export const oneTimeTokenAuth = defineMiddleware('oneTimeTokenAuth', async (c, next) =>
{
    // Extract token from query or Authorization header
    const token = c.req.query('token')
        ?? extractOTTHeader(c.req.header('Authorization'));

    if (!token)
    {
        throw new UnauthorizedError({ message: 'One-time token required: ?token=xxx or Authorization: OTT xxx' });
    }

    // Verify and consume token (one-time use)
    const userId = await verifyOneTimeTokenService(token);

    if (!userId)
    {
        throw new UnauthorizedError({ message: 'Invalid or expired one-time token' });
    }

    // Load user data (same as authenticate middleware)
    const [result, locale] = await Promise.all([
        findUserWithEffectiveRole(Number(userId)),
        userProfilesRepository.findLocaleByUserId(Number(userId)),
    ]);

    if (!result)
    {
        throw new UnauthorizedError({ message: 'User not found' });
    }

    const { user, role } = result;

    if (user.status !== 'active')
    {
        throw new UnauthorizedError({ message: 'Account is not active' });
    }

    // Inject AuthContext (identical shape to authenticate middleware)
    c.set('auth', {
        user,
        userId: String(user.id),
        keyId: '',  // No key involved in OTT auth
        role: role?.name ?? null,
        locale,
        scheme: 'oneTimeToken',
    });

    await next();
}, { skips: ['auth'] });

/**
 * Extract token from `Authorization: OTT xxx` header
 */
function extractOTTHeader(header: string | undefined): string | null
{
    if (!header || !header.startsWith('OTT '))
    {
        return null;
    }

    return header.substring(4);
}
