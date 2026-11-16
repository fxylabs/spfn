/**
 * One-Time Token Authentication Middleware
 *
 * Authenticates requests using a one-time token instead of JWT.
 * Extracts token from query parameter `?token=xxx` or `Authorization: OTT xxx` header.
 *
 * The token names the account and the device key that issued it; whether the
 * person may be let in is `admitPrincipal`'s, with a `oneTimeToken`
 * credential — the issuing key still live, the account active on the primary,
 * the second-factor policy. On success it injects the `AuthContext` the
 * `authenticate` middleware does, with the issuing key as `keyId`, so it is
 * transparent to downstream handlers using `getAuth(c)`.
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
import { SecondFactorEnrolmentRequiredError } from '@spfn/auth/errors';

import { redeemOneTimeTokenService } from '../services/one-time-token.service';
import { admitPrincipal, authContextFor, type AdmissionRefusal } from '../services/admission.service';

export const oneTimeTokenAuth = defineMiddleware('oneTimeTokenAuth', async (c, next) =>
{
    // Extract token from query or Authorization header
    const token = c.req.query('token')
        ?? extractOTTHeader(c.req.header('Authorization'));

    if (!token)
    {
        throw new UnauthorizedError({ message: 'One-time token required: ?token=xxx or Authorization: OTT xxx' });
    }

    // Spend the token (one-time use), then admit the person it was issued to.
    // No route this guards is an enrolment route: those are `mainAuthRouter`'s,
    // behind `authenticate`.
    const redeemed = await redeemOneTimeTokenService(token);

    if (!redeemed)
    {
        throw new UnauthorizedError({ message: 'Invalid or expired one-time token' });
    }

    const admission = await admitPrincipal({
        userId: redeemed.userId,
        credential: { kind: 'oneTimeToken', issuedByKeyId: redeemed.issuedByKeyId },
        route: null,
        presentedOn: null,
    });

    if ('refused' in admission)
    {
        throw oneTimeTokenRefusal(admission.refused);
    }

    c.set('auth', authContextFor(admission.admitted, 'oneTimeToken'));

    await next();
}, { skips: ['auth'] });

/**
 * The answers this middleware has always given: a dead token — here, one whose
 * issuing key has since died — is an invalid one; an account that is not
 * active is a 401 of its own; enrolment-only is the policy's 403.
 */
function oneTimeTokenRefusal(refusal: AdmissionRefusal): Error
{
    switch (refusal.reason)
    {
        case 'accountMissing':
            return new UnauthorizedError({ message: 'User not found' });
        case 'accountDisabled':
        case 'pendingDeletion':
            return new UnauthorizedError({ message: 'Account is not active' });
        case 'credentialRevoked':
        case 'credentialExpired':
        case 'contextChanged':
            return new UnauthorizedError({ message: 'Invalid or expired one-time token' });
        case 'enrolmentRequired':
            return new SecondFactorEnrolmentRequiredError();
    }
}

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
