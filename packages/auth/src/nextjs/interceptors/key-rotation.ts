/**
 * Key Rotation Interceptor
 *
 * Handles key rotation with new key generation and session update
 */

import type { InterceptorRule } from '@spfn/core/nextjs/server';
import { generateKeyPair, generateClientToken } from '../../server/lib/crypto';
import { unsealSession, sealSession } from '../../server/lib/session';
import { getSessionTtl, COOKIE_NAMES } from '../../server/lib/config';
import { authLogger } from '../../server/logger';
import { cookieSecure } from './cookie-options';
import { pushCsrfCookie } from './csrf';

/**
 * Key Rotation Interceptor
 *
 * Request: Generates new key pair and adds to body, authenticates with current key
 * Response: Updates session with new privateKey
 */
export const keyRotationInterceptor: InterceptorRule =
    {
        pathPattern: '/_auth/keys/rotate',
        method: 'POST',

        request: async (ctx, next) =>
        {
            const sessionCookie = ctx.cookies.get(COOKIE_NAMES.SESSION);

            if (!sessionCookie)
            {
                await next();

                return;
            }

            try
            {
            // Get current session
                const currentSession = await unsealSession(sessionCookie);

                // Generate new key pair
                const newKeyPair = generateKeyPair('ES256');

                // Add new publicKey to request body
                if (!ctx.body)
                {
                    ctx.body = {};
                }

                ctx.body.publicKey = newKeyPair.publicKey;
                ctx.body.keyId = newKeyPair.keyId;
                ctx.body.fingerprint = newKeyPair.fingerprint;
                ctx.body.algorithm = newKeyPair.algorithm;
                ctx.body.keySize = Buffer.from(newKeyPair.publicKey, 'base64').length;

                // Identity of the new key only — the pair carries `privateKey`,
                // the credential the session is sealed around.
                authLogger.interceptor.keyRotation.debug('Generated a new key pair', {
                    keyId: newKeyPair.keyId,
                    fingerprint: newKeyPair.fingerprint,
                    algorithm: newKeyPair.algorithm,
                });

                // Authenticate with CURRENT key
                const token = generateClientToken(
                    {
                        userId: currentSession.userId,
                        keyId: currentSession.keyId,
                        action: 'rotate_key',
                        timestamp: Date.now(),
                    },
                    currentSession.privateKey,
                    currentSession.algorithm,
                    {expiresIn: '15m'},
                );

                ctx.headers['Authorization'] = `Bearer ${token}`;
                ctx.headers['X-Key-Id'] = currentSession.keyId;

                // Store new key and userId in metadata
                ctx.metadata.newPrivateKey = newKeyPair.privateKey;
                ctx.metadata.newKeyId = newKeyPair.keyId;
                ctx.metadata.newAlgorithm = newKeyPair.algorithm;
                ctx.metadata.userId = currentSession.userId;
                ctx.metadata.bindingFields = currentSession.binding
                    ? {
                        binding: currentSession.binding,
                        keyExpiresAt: currentSession.keyExpiresAt,
                        ...(currentSession.uaFamily ? { uaFamily: currentSession.uaFamily } : {}),
                    }
                    : {};
            }
            catch (error)
            {
                const err = error as Error;
                authLogger.interceptor.keyRotation.error('Failed to prepare key rotation', err);
            }

            await next();
        },

        response: async (ctx, next) =>
        {
        // Only update session on successful rotation
            if (ctx.response.status !== 200)
            {
                await next();

                return;
            }

            if (!ctx.metadata.newPrivateKey || !ctx.metadata.userId)
            {
                authLogger.interceptor.keyRotation.error('Missing key rotation metadata');
                await next();

                return;
            }

            try
            {
            // Get session TTL
                const ttl = getSessionTtl();

                // Create new session with rotated key.
                //
                // The binding fields come from the session being replaced, not
                // from the response: rotation registers a key that inherits the
                // replaced key's binding and its expiry verbatim, so the cookie
                // must inherit them too. Re-deriving would be wrong twice over —
                // the rotate response says nothing about binding, and a fresh
                // expiry is exactly what rotation must not hand a bound key.
                const newSessionData =
                    {
                        userId: ctx.metadata.userId,
                        privateKey: ctx.metadata.newPrivateKey,
                        keyId: ctx.metadata.newKeyId,
                        algorithm: ctx.metadata.newAlgorithm,
                        ...ctx.metadata.bindingFields,
                    };

                const sealed = await sealSession(newSessionData, ttl);

                // Update session cookie
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

                // Update keyId cookie
                ctx.setCookies.push({
                    name: COOKIE_NAMES.SESSION_KEY_ID,
                    value: ctx.metadata.newKeyId,
                    options: {
                        httpOnly: true,
                        secure: cookieSecure,
                        sameSite: 'lax',
                        maxAge: ttl,
                        path: '/',
                    },
                });

                // Rotation changes the key id the token is derived from, so the
                // old CSRF value stops verifying — reissue it in the same response.
                await pushCsrfCookie(ctx.setCookies, ctx.metadata.newKeyId, ttl);
            }
            catch (error)
            {
                const err = error as Error;
                authLogger.interceptor.keyRotation.error('Failed to update session after rotation', err);
            }

            await next();
        },
    };
