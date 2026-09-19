/**
 * Session helpers for Next.js
 *
 * Server-side only (uses next/headers)
 */

import * as jose from 'jose';
import { cookies } from 'next/headers.js';
import { sealSession, unsealSession, type SessionData } from '../server/lib/session';
import { deriveCsrfToken } from '../server/lib/csrf';
import { COOKIE_NAMES, getSessionTtl, parseDuration } from '../server/lib/config';
import { type KeyAlgorithmType } from '../server/types';
import { env } from '@spfn/auth/config';
import { logger } from '@spfn/core/logger';

export type { SessionData };

/**
 * Pending OAuth session data (before user ID is known)
 */
export interface PendingSessionData
{
    privateKey: string;
    keyId: string;
    algorithm: KeyAlgorithmType;
}

/**
 * Pending second-factor session, held between a 202 sign-in and its verify (#95).
 *
 * The same three fields plus `challengeHash`, and sealed under its own audience
 * so it can never be unsealed as an OAuth pending cookie or the other way round.
 * The extra field is the binding: the proxy seals a session only when the
 * verified response names this challenge **and** this key, so a cookie minted
 * for one flow cannot seal a session around another flow's key.
 *
 * The hash and not the secret. The proxy has no use for a spendable challenge —
 * it is comparing, not verifying — and a cookie that carried one would be a
 * second copy of a credential for no gain.
 */
export interface PendingMfaSessionData extends PendingSessionData
{
    challengeHash: string;
}

/**
 * Public session information (excludes sensitive data)
 */
export interface PublicSession
{
    /** User ID */
    userId: string;
}

/**
 * Options for saveSession
 */
export interface SaveSessionOptions
{
    /**
     * Session TTL (time to live)
     *
     * Supports:
     * - Number: seconds (e.g., 2592000)
     * - String: duration format ('30d', '12h', '45m', '3600s')
     *
     * If not provided, uses global configuration:
     * 1. Global config (configureAuth)
     * 2. Environment variable (SPFN_AUTH_SESSION_TTL)
     * 3. Default (7d)
     */
    maxAge?: number | string;

    /**
     * Remember me option
     *
     * When true, uses extended session duration (if configured)
     */
    remember?: boolean;
}

/**
 * Save session to HttpOnly cookie
 *
 * @param data - Session data to save
 * @param options - Session options (maxAge, remember)
 *
 * @example
 * ```typescript
 * // Use global configuration
 * await saveSession(sessionData);
 *
 * // Custom TTL with duration string
 * await saveSession(sessionData, { maxAge: '30d' });
 *
 * // Custom TTL in seconds
 * await saveSession(sessionData, { maxAge: 2592000 });
 *
 * // Remember me
 * await saveSession(sessionData, { remember: true });
 * ```
 */
export async function saveSession(
    data: SessionData,
    options?: SaveSessionOptions,
): Promise<void>
{
    // Calculate maxAge
    let maxAge: number;

    if (options?.maxAge !== undefined)
    {
        // Custom maxAge provided
        maxAge = typeof options.maxAge === 'number'
            ? options.maxAge
            : parseDuration(options.maxAge);
    }
    else
    {
        // Use getSessionTtl for consistent configuration
        maxAge = getSessionTtl();
    }

    const token = await sealSession(data, maxAge);
    const cookieStore = await cookies();

    cookieStore.set(COOKIE_NAMES.SESSION, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge,
    });

    // Readable companion: the client mirrors it into x-spfn-csrf, and the proxy
    // refuses cookie-session mutations that arrive without it. A session saved
    // here without one would be a session that cannot mutate anything.
    cookieStore.set(COOKIE_NAMES.CSRF, await deriveCsrfToken(data.keyId), {
        httpOnly: false,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge,
    });
}

/**
 * Get session from HttpOnly cookie
 *
 * Returns public session info only (excludes privateKey, algorithm, keyId)
 */
export async function getSession(): Promise<PublicSession | null>
{
    const cookieStore = await cookies();
    const sessionCookie = cookieStore.get(COOKIE_NAMES.SESSION);

    if (!sessionCookie)
    {
        return null;
    }

    try
    {
        // Never log the cookie value — it's the sealed session token.
        logger.debug('Validating session cookie', { present: true });
        const session = await unsealSession(sessionCookie.value);

        // Return only public information
        return {
            userId: session.userId,
        };
    }
    catch (error)
    {
        // Session expired or invalid
        // Note: Cannot delete cookies in Server Components (read-only)
        // Use validateSessionMiddleware() in Next.js middleware for automatic cleanup
        logger.debug('Session validation failed', {
            error: error instanceof Error ? error.message : String(error),
        });

        return null;
    }
}

/**
 * Clear session cookie
 */
export async function clearSession(): Promise<void>
{
    const cookieStore = await cookies();
    cookieStore.delete(COOKIE_NAMES.SESSION);
    cookieStore.delete(COOKIE_NAMES.SESSION_KEY_ID);
    cookieStore.delete(COOKIE_NAMES.CSRF);
}

// ============================================================================
// Pending OAuth Session (for OAuth flow)
// ============================================================================

/**
 * Get encryption key for a pending session, derived per purpose.
 *
 * The purpose is in the derivation as well as in the audience, so the OAuth and
 * second-factor cookies cannot be unsealed as each other even if a caller named
 * the wrong audience: two flows may be live in one browser at once, and the
 * whole point of separating them is that neither can seal a session around the
 * other's key.
 */
async function getPendingSessionKey(purpose: 'oauth' | 'mfa'): Promise<Uint8Array>
{
    const secret = env.SPFN_AUTH_SESSION_SECRET;
    const encoder = new TextEncoder();
    const data = encoder.encode(purpose === 'oauth' ? `oauth-pending:${secret}` : `mfa-pending:${secret}`);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);

    return new Uint8Array(hashBuffer);
}

/**
 * Seal pending session data (for OAuth flow)
 *
 * @param data - Pending session data (privateKey, keyId, algorithm)
 * @param ttl - Time to live in seconds (default: 10 minutes)
 */
export async function sealPendingSession(
    data: PendingSessionData,
    ttl: number = 600,
): Promise<string>
{
    return await sealFor('oauth', data, ttl);
}

/**
 * Seal the pending second-factor session (#95)
 *
 * Takes its data explicitly rather than reading a cookie: the only caller is an
 * interceptor rule, which does not run inside `next/headers` and reads the jar
 * through `ctx.cookies` instead.
 *
 * @param data - privateKey, keyId, algorithm and the challenge hash they are for
 * @param ttl - Seconds. Ten minutes, matching the challenge's own life
 */
export async function sealPendingMfaSession(
    data: PendingMfaSessionData,
    ttl: number = 600,
): Promise<string>
{
    return await sealFor('mfa', data, ttl);
}

/** The one sealer both pending cookies use, parameterized by purpose. */
async function sealFor(purpose: 'oauth' | 'mfa', data: PendingSessionData, ttl: number): Promise<string>
{
    return await new jose.EncryptJWT({ data })
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
        .setIssuedAt()
        .setExpirationTime(`${ttl}s`)
        .setIssuer('spfn-auth')
        .setAudience(purpose === 'oauth' ? 'spfn-oauth' : 'spfn-mfa')
        .encrypt(await getPendingSessionKey(purpose));
}

/**
 * Unseal pending session data
 *
 * @param jwt - Encrypted pending session token
 */
export async function unsealPendingSession(jwt: string): Promise<PendingSessionData>
{
    const { payload } = await jose.jwtDecrypt(jwt, await getPendingSessionKey('oauth'), {
        issuer: 'spfn-auth',
        audience: 'spfn-oauth',
    });

    return payload.data as PendingSessionData;
}

/**
 * Unseal the pending second-factor session (#95)
 *
 * Throws on an OAuth pending cookie presented here, and on anything past its ten
 * minutes — both are the separation this cookie exists for.
 *
 * @param jwt - Encrypted pending token from `COOKIE_NAMES.MFA_PENDING`
 */
export async function unsealPendingMfaSession(jwt: string): Promise<PendingMfaSessionData>
{
    const { payload } = await jose.jwtDecrypt(jwt, await getPendingSessionKey('mfa'), {
        issuer: 'spfn-auth',
        audience: 'spfn-mfa',
    });

    return payload.data as PendingMfaSessionData;
}

/**
 * Get pending session from cookie
 */
export async function getPendingSession(): Promise<PendingSessionData | null>
{
    const cookieStore = await cookies();
    const pendingCookie = cookieStore.get(COOKIE_NAMES.OAUTH_PENDING);

    if (!pendingCookie)
    {
        return null;
    }

    try
    {
        return await unsealPendingSession(pendingCookie.value);
    }
    catch (error)
    {
        logger.debug('Pending session validation failed', {
            error: error instanceof Error ? error.message : String(error),
        });

        return null;
    }
}

/**
 * Clear pending session cookie
 */
export async function clearPendingSession(): Promise<void>
{
    const cookieStore = await cookies();
    cookieStore.delete(COOKIE_NAMES.OAUTH_PENDING);
}
