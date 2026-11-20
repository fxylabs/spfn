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

import { type KeyAlgorithmType } from '../types';

/**
 * What the sealed cookie carries.
 *
 * The first four fields are the session itself. Whether its key is bound, when
 * that key expires and which browser family it started in are facts of the key
 * row, which the backend reads at every request: they are not sealed here. A
 * cookie sealed before that — carrying `binding`, `keyExpiresAt` or `uaFamily` —
 * unseals as before, and nothing reads those fields.
 */
export interface SessionData
{
    userId: string;
    privateKey: string;     // Base64 encoded DER
    keyId: string;
    algorithm: KeyAlgorithmType;

    /**
     * The sign-in asked to be kept signed in (`remember: true`). Sealed so that
     * every later re-seal of this session keeps the lifetime it was given —
     * `SPFN_AUTH_SESSION_TTL_REMEMBER` rather than `SPFN_AUTH_SESSION_TTL`.
     */
    remember?: true;
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
 * Why a sealed session could not be read — as jose tells the cases apart.
 *
 * - `expired`: sealed by this server, past its lifetime
 * - `undecryptable`: not sealed under the current secret — tampered with, or
 *   sealed before `SPFN_AUTH_SESSION_SECRET` was rotated
 * - `claims`: decrypted, but issued for another issuer or audience
 * - `malformed`: not a JWE at all
 *
 * Every kind means the same thing to a browser: the cookie is unusable and goes.
 * They are kept apart for the log and for a test that has to reach each one.
 */
export type SessionUnsealFailure = 'expired' | 'undecryptable' | 'claims' | 'malformed';

/** What reading a sealed session answers: the session, or the kind of failure. */
export type SessionRead = { session: SessionData } | { failure: SessionUnsealFailure };

const UNSEAL_FAILURE_MESSAGES: Record<SessionUnsealFailure, string> = {
    expired: 'Session expired',
    undecryptable: 'Invalid session',
    claims: 'Session validation failed',
    malformed: 'Failed to unseal session',
};

/**
 * The error `unsealSession` throws, carrying the failure kind.
 */
export class SessionUnsealError extends Error
{
    constructor(readonly failure: SessionUnsealFailure)
    {
        super(UNSEAL_FAILURE_MESSAGES[failure]);
        this.name = 'SessionUnsealError';
    }
}

/**
 * Read a sealed session, answering with the session or a typed failure.
 *
 * @param jwt - Encrypted JWT string
 */
export async function readSealedSession(jwt: string): Promise<SessionRead>
{
    const secret = await getSessionSecretKey();

    try
    {
        const { payload } = await jose.jwtDecrypt(jwt, secret, {
            issuer: 'spfn-auth',
            audience: 'spfn-client',
        });

        return { session: payload.data as SessionData };
    }
    catch (err)
    {
        const failure = unsealFailureOf(err);

        if (failure === 'undecryptable')
        {
            await warnUndecryptable(jwt);
        }

        return { failure };
    }
}

function unsealFailureOf(err: unknown): SessionUnsealFailure
{
    if (err instanceof jose.errors.JWTExpired)
    {
        return 'expired';
    }

    if (err instanceof jose.errors.JWEDecryptionFailed)
    {
        return 'undecryptable';
    }

    return err instanceof jose.errors.JWTClaimValidationFailed ? 'claims' : 'malformed';
}

async function warnUndecryptable(jwt: string): Promise<void>
{
    if (coreEnv.NODE_ENV === 'production')
    {
        return;
    }

    authLogger.session.warn(`JWE decryption failed`, {
        secretFingerprint: await getSecretFingerprint(),
        jwtLength: jwt.length,
        jwtPrefix: jwt.slice(0, 20),
        jwtSuffix: jwt.slice(-10),
    });
}

/**
 * Unseal encrypted JWT (JWE) to session data
 *
 * @param jwt - Encrypted JWT string
 * @returns Session data
 * @throws SessionUnsealError, naming the failure kind, if the session cannot be read
 */
export async function unsealSession(jwt: string): Promise<SessionData>
{
    const read = await readSealedSession(jwt);

    if ('failure' in read)
    {
        throw new SessionUnsealError(read.failure);
    }

    return read.session;
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
            authLogger.session.warn('Failed to get session info', { error: err });
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
