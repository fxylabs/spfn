/**
 * Login/Register Interceptor
 *
 * Automatically handles key generation and session management
 * for login, register, and invitation-accept endpoints.
 * (Invitation acceptance creates the user account + key pair and
 * logs the new user in, so it follows the same key/session flow.)
 */

import type { InterceptorRule } from '@spfn/core/nextjs/server';
import { generateKeyPair } from '../../server/lib/crypto';
import { sealSession } from '../../server/lib/session';
import { getSessionTtl, COOKIE_NAMES } from '../../server/lib/config';
import { authLogger } from '../../server/logger';
import { cookieSecure } from './cookie-options';
import { pushCsrfCookie } from './csrf';

/**
 * The sign-in paths that replace a key the browser already holds.
 *
 * Register, invitation-accept and signup/password create the account, so there
 * is nothing to rotate; the two sign-ins can each arrive at a browser that is
 * already carrying a session key.
 */
const ROTATING_SIGN_IN_PATHS = new Set(['/_auth/login', '/_auth/passkeys/login/verify']);

/**
 * Login, Register, and Invitation-Accept Interceptor
 *
 * Request: Generates key pair and adds publicKey to request body
 * Response: Saves privateKey to HttpOnly cookie
 */
export const loginRegisterInterceptor: InterceptorRule =
    {
        pathPattern: /^\/_auth\/(login|register|invitations\/accept|signup\/password|passkeys\/login\/verify)$/,
        method: 'POST',

        request: async (ctx, next) =>
        {
            // Get old session if exists (for key rotation on login)
            const oldKeyId = ctx.cookies.get(COOKIE_NAMES.SESSION_KEY_ID);

            // Extract remember option from request body (if provided)
            const remember = ctx.body?.remember;

            // Generate new key pair
            const keyPair = generateKeyPair('ES256');

            // Add publicKey data to request body
            if (!ctx.body)
            {
                ctx.body = {};
            }

            ctx.body.publicKey = keyPair.publicKey;
            ctx.body.keyId = keyPair.keyId;
            ctx.body.fingerprint = keyPair.fingerprint;
            ctx.body.algorithm = keyPair.algorithm;
            ctx.body.keySize = Buffer.from(keyPair.publicKey, 'base64').length;

            // Add oldKeyId for a sign-in (key rotation). Both sign-in paths:
            // a passkey assertion starts a session exactly as a password login
            // does, so the key the browser was already carrying has to be
            // retired by the same request that replaces it.
            if (ROTATING_SIGN_IN_PATHS.has(ctx.path) && oldKeyId)
            {
                ctx.body.oldKeyId = oldKeyId;
            }

            // Remove remember from body (not part of contract)
            delete ctx.body.remember;

            // Store privateKey and remember in metadata for response interceptor
            ctx.metadata.privateKey = keyPair.privateKey;
            ctx.metadata.keyId = keyPair.keyId;
            ctx.metadata.algorithm = keyPair.algorithm;
            ctx.metadata.remember = remember;

            await next();
        },

        response: async (ctx, next) =>
        {
            // Only process successful responses
            if (ctx.response.status !== 200)
            {
                await next();

                return;
            }

            // Handle both wrapped ({ data: { userId } }) and direct ({ userId }) responses
            const userData = ctx.response.body?.data || ctx.response.body;
            if (!userData?.userId)
            {
                authLogger.interceptor.login.error('No userId in response');
                await next();

                return;
            }

            try
            {
                // Get session TTL (priority: runtime > global > env > default)
                const ttl = getSessionTtl(ctx.metadata.remember);

                // Encrypt session data
                const sessionData =
                    {
                        userId: userData.userId,
                        privateKey: ctx.metadata.privateKey,
                        keyId: ctx.metadata.keyId,
                        algorithm: ctx.metadata.algorithm,
                    };

                const sealed = await sealSession(sessionData, ttl);

                // Set HttpOnly session cookie
                ctx.setCookies.push({
                    name: COOKIE_NAMES.SESSION,
                    value: sealed,
                    options: {
                        httpOnly: true,
                        secure: cookieSecure,
                        sameSite: 'lax',
                        maxAge: ttl,
                        path: '/',
                    },
                });

                // Set keyId cookie (for oldKeyId lookup)
                ctx.setCookies.push({
                    name: COOKIE_NAMES.SESSION_KEY_ID,
                    value: ctx.metadata.keyId,
                    options: {
                        httpOnly: true,
                        secure: cookieSecure,
                        sameSite: 'lax',
                        maxAge: ttl,
                        path: '/',
                    },
                });

                // Set the readable CSRF cookie the client mirrors into a header
                await pushCsrfCookie(ctx.setCookies, ctx.metadata.keyId, ttl);
            }
            catch (error)
            {
                const err = error as Error;
                authLogger.interceptor.login.error('Failed to save session', err);
            }

            await next();
        },
    };
