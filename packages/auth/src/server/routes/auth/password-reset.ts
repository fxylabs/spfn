/**
 * @spfn/auth - Password Reset Routes
 *
 * Thin route handlers that delegate to the password reset service.
 *
 * A separate file from the other auth routes, imported directly by
 * `routes/index.ts`: the route-map generator only parses files that file
 * imports, so a route reached through a re-export would be missing from the
 * generated map and from every typed client built on it.
 */

import { Type } from '@sinclair/typebox';
import { Transactional } from '@spfn/core/db';
import { ValidationError } from '@spfn/core/errors';
import { rateLimitPolicy } from '@spfn/core/middleware';
import { route } from '@spfn/core/route';

import { EmailSchema, PasswordSchema, DeviceNameSchema, PlatformSchema } from '../schema';
import { KEY_ALGORITHM } from '../../types';
import { byIpAndAccount } from '../../lib/rate-limit-keys';
import {
    requestPasswordResetService,
    confirmPasswordResetService,
    completePasswordResetService,
    isSafeReturnPath,
} from '../../services';

/**
 * POST /_auth/password/reset - Ask for a password reset link
 *
 * Answers identically for every address, and mails only an account that can be
 * reset, so it cannot be used to probe for accounts. Calling it again is the
 * resend: it supersedes every live link for the account.
 */
export const requestPasswordReset = route.post('/_auth/password/reset')
    .input({
        body: Type.Object({
            email: EmailSchema,
            returnPath: Type.Optional(Type.String({
                maxLength: 512,
                description: 'Relative path within the app to return to after the reset. Absolute URLs are rejected.',
            })),
        }),
    })
    // byIpAndAccount, not byIpAndTarget: the account dimension is read from
    // `body.email`, and byIpAndTarget looks for `body.target` — which this route
    // does not have, so it would silently degrade to an IP-only limit.
    .use([rateLimitPolicy('auth-password-reset', { limit: 5, windowMs: 60_000, by: byIpAndAccount({ ipLimit: 20 }) })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        if (body.returnPath !== undefined && !isSafeReturnPath(body.returnPath))
        {
            throw new ValidationError({ message: 'returnPath must be a relative path within the app' });
        }

        return await requestPasswordResetService(body);
    });

/**
 * POST /_auth/password/reset/confirm - Exchange a reset link for a setup session
 *
 * The emailed link opens an app page; that page posts the token here. The
 * response carries `setupSecret`, which the Next.js proxy interceptor moves into
 * an HttpOnly cookie and strips from the body — so it never reaches page script.
 */
export const confirmPasswordReset = route.post('/_auth/password/reset/confirm')
    .input({
        body: Type.Object({
            token: Type.String({
                minLength: 16,
                maxLength: 256,
                description: 'Token from the reset link',
            }),
        }),
    })
    .use([rateLimitPolicy('auth-password-reset-confirm', { limit: 10, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        return await confirmPasswordResetService(body);
    });

/**
 * POST /_auth/password/reset/complete - Set the new password
 *
 * Authorized by the setup-session cookie, not by a session — the account's old
 * credentials are exactly what the caller does not have. The interceptor reads
 * that cookie into `setupSecret` and injects the device key the same way it does
 * for login — but no `oldKeyId`, because this revokes every key rather than
 * rotating one. The new hash, the revocation of every earlier key, the new
 * device key and the completion mark all commit together.
 */
export const completePasswordReset = route.post('/_auth/password/reset/complete')
    .input({
        body: Type.Object({
            password: PasswordSchema,
        }),
    })
    .interceptor({
        body: Type.Object({
            setupSecret: Type.String({ description: 'Password-setup session secret, from the HttpOnly cookie' }),
            publicKey: Type.String({ description: 'Client public key' }),
            keyId: Type.String({ description: 'Key identifier' }),
            fingerprint: Type.String({ description: 'Key fingerprint' }),
            algorithm: Type.Union(KEY_ALGORITHM.map(algo => Type.Literal(algo)), { description: 'Signature algorithm' }),
            deviceName: Type.Optional(DeviceNameSchema),
            platform: Type.Optional(PlatformSchema),
        }),
    })
    .use([rateLimitPolicy('auth-password-reset-complete', { limit: 10, windowMs: 60_000 }), Transactional()])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        return await completePasswordResetService(body);
    });
