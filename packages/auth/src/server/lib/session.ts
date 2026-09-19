/**
 * @spfn/auth - Client Session Management
 *
 * Uses Jose JWE (JSON Web Encryption) to securely store session data in cookies
 * More efficient than Iron Session with better Edge Runtime support
 */

import * as jose from 'jose';
import { env } from '@spfn/auth/config';
import { env as coreEnv } from '@spfn/core/config';
import { authLogger } from '../logger';

import { type KeyAlgorithmType, type SessionBindingType } from '../types';
import type { UaFamily } from './ua-family';

/**
 * What the sealed cookie carries.
 *
 * The first four fields are the session itself and have always been here. The
 * last three are what #97 added, and all three are optional together: a cookie
 * without them is an unbound session, which is every session an account that did
 * not opt in gets and every session an app seals by hand with `saveSession()`.
 * The proxy reads their absence as "behave exactly as before".
 */
export interface SessionData
{
    userId: string;
    privateKey: string;     // Base64 encoded DER
    keyId: string;
    algorithm: KeyAlgorithmType;

    /**
     * `'passkey'` when the key sealed here is bound.
     *
     * The backend is the only party that knows an account opted in — the proxy
     * generated the key but never saw the setting — so this is copied out of the
     * `LoginResult` the sign-in answered with. Absent means unbound.
     */
    binding?: SessionBindingType;

    /** Epoch milliseconds the bound key expires at. Only set alongside `binding`. */
    keyExpiresAt?: number;

    /**
     * Browser family the session was sealed from, per `uaFamily`.
     *
     * Recorded here rather than read off the key row because the comparison
     * happens in the proxy: it is the only hop that sees the browser's own
     * `user-agent`, and a server component's call to the RPC proxy carries none.
     */
    uaFamily?: UaFamily;
}

/**
 * Get session secret key derived from environment
 * Must be at least 32 characters (256-bit)
 *
 * Derives a 32-byte key using SHA-256 to ensure compatibility with Jose A256GCM
 */
async function getSessionSecretKey(): Promise<Uint8Array>
{
    const secret = env.SPFN_AUTH_SESSION_SECRET;

    // Derive a 32-byte key using SHA-256 for A256GCM compatibility
    // Use Web Crypto API for universal compatibility (browser + Node.js)
    const encoder = new TextEncoder();
    const data = encoder.encode(secret);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);

    return new Uint8Array(hashBuffer);
}

/**
 * Get a short fingerprint of the current secret key for debugging
 * Logs only the first 8 hex chars of the SHA-256 hash — safe to expose
 */
async function getSecretFingerprint(): Promise<string>
{
    const key = await getSessionSecretKey();
    const hash = await crypto.subtle.digest('SHA-256', key.buffer as ArrayBuffer);
    const hex = Array.from(new Uint8Array(hash))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    return hex.slice(0, 8);
}

/**
 * Seal session data into encrypted JWT (JWE)
 *
 * @param data - Session data to encrypt
 * @param ttl - Time to live in seconds (default: 7 days)
 * @returns Encrypted JWT string
 */
export async function sealSession(
    data: SessionData,
    ttl: number = 60 * 60 * 24 * 7, // 7 days
): Promise<string>
{
    const secret = await getSessionSecretKey();

    const result = await new jose.EncryptJWT({ data })
        .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
        .setIssuedAt()
        .setExpirationTime(`${ttl}s`)
        .setIssuer('spfn-auth')
        .setAudience('spfn-client')
        .encrypt(secret);

    if (coreEnv.NODE_ENV !== 'production')
    {
        const fingerprint = await getSecretFingerprint();
        authLogger.session.debug(`Sealed session`, {
            secretFingerprint: fingerprint,
            resultLength: result.length,
            resultPrefix: result.slice(0, 20),
        });
    }

    return result;
}

/**
 * Unseal encrypted JWT (JWE) to session data
 *
 * @param jwt - Encrypted JWT string
 * @returns Session data
 * @throws Error if session is invalid or expired
 */
export async function unsealSession(jwt: string): Promise<SessionData>
{
    try
    {
        const secret = await getSessionSecretKey();

        const { payload } = await jose.jwtDecrypt(jwt, secret, {
            issuer: 'spfn-auth',
            audience: 'spfn-client',
        });

        return payload.data as SessionData;
    }
    catch (err)
    {
        if (err instanceof jose.errors.JWTExpired)
        {
            throw new Error('Session expired');
        }

        if (err instanceof jose.errors.JWEDecryptionFailed)
        {
            // Log secret fingerprint for debugging cross-process key mismatch
            if (coreEnv.NODE_ENV !== 'production')
            {
                const fingerprint = await getSecretFingerprint();
                authLogger.session.warn(`JWE decryption failed`, {
                    secretFingerprint: fingerprint,
                    jwtLength: jwt.length,
                    jwtPrefix: jwt.slice(0, 20),
                    jwtSuffix: jwt.slice(-10),
                });
            }

            throw new Error('Invalid session');
        }

        if (err instanceof jose.errors.JWTClaimValidationFailed)
        {
            throw new Error('Session validation failed');
        }

        throw new Error('Failed to unseal session');
    }
}

/**
 * Get session metadata without decrypting
 *
 * @param jwt - Encrypted JWT string
 * @returns Session metadata or null if invalid
 */
export async function getSessionInfo(jwt: string): Promise<{
    issuedAt: Date;
    expiresAt: Date;
    issuer: string;
    audience: string;
} | null>
{
    const secret = await getSessionSecretKey();

    try
    {
        const { payload } = await jose.jwtDecrypt(jwt, secret);

        return {
            issuedAt: new Date(payload.iat! * 1000),
            expiresAt: new Date(payload.exp! * 1000),
            issuer: payload.iss || '',
            audience: Array.isArray(payload.aud) ? payload.aud[0] : payload.aud || '',
        };
    }
    catch (err)
    {
        // Log error for debugging but return null for graceful handling
        if (coreEnv.NODE_ENV !== 'production')
        {
            authLogger.session.warn('Failed to get session info:', err instanceof Error ? err.message : 'Unknown error');
        }

        return null;
    }
}

/**
 * Check if session is about to expire (within threshold)
 *
 * @param jwt - Encrypted JWT string
 * @param thresholdHours - Hours before expiry to trigger refresh (default: 24)
 * @returns True if session should be refreshed
 */
export async function shouldRefreshSession(
    jwt: string,
    thresholdHours: number = 24,
): Promise<boolean>
{
    const info = await getSessionInfo(jwt);

    if (!info)
    {
        return true;
    }

    const hoursRemaining = (info.expiresAt.getTime() - Date.now()) / (1000 * 60 * 60);

    return hoursRemaining < thresholdHours;
}
