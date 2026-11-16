/**
 * @spfn/auth - JWT Helpers
 *
 * JWT token generation and verification
 * Supports both server-signed (legacy) and client-signed (asymmetric) tokens
 *
 * Architecture:
 * - Legacy: Server signs/verifies with SPFN_AUTH_JWT_SECRET (symmetric HMAC)
 * - New: Client signs with privateKey, server verifies with publicKey (asymmetric)
 */

import jwt, { type SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { env } from '@spfn/auth/config';
import { type KeyAlgorithmType } from '../types';
import { KeyAlgorithmMismatchError } from '@spfn/auth/errors';

/**
 * Parsed public-key cache.
 *
 * `createPublicKey` re-parses the DER (ASN.1/SPKI) on every call, which would run
 * on every authenticated request. The base64 DER fully identifies the key, so we
 * cache the resulting KeyObject by it. Bounded with FIFO eviction — a miss just
 * re-parses, so a small cap is safe.
 */
const PUBLIC_KEY_CACHE_MAX = 1000;
const publicKeyCache = new Map<string, crypto.KeyObject>();

function getPublicKeyObject(publicKeyB64: string): crypto.KeyObject
{
    const cached = publicKeyCache.get(publicKeyB64);
    if (cached)
    {
        return cached;
    }

    const keyObject = crypto.createPublicKey({
        key: Buffer.from(publicKeyB64, 'base64'),
        format: 'der',
        type: 'spki',
    });

    if (publicKeyCache.size >= PUBLIC_KEY_CACHE_MAX)
    {
        const oldest = publicKeyCache.keys().next().value;
        if (oldest !== undefined)
        {
            publicKeyCache.delete(oldest);
        }
    }
    publicKeyCache.set(publicKeyB64, keyObject);

    return keyObject;
}

export interface SessionPayload
{
    userId: string;
    keyId?: string;
}

export interface TokenPayload extends SessionPayload
{
    exp?: number;
    iat?: number;
    iss?: string;
    timestamp?: number;
    [key: string]: any;
}

/**
 * The placeholder default shipped for local DX. It is public knowledge, so it must
 * never sign or verify real tokens — anyone could forge legacy JWTs with it.
 */
const INSECURE_JWT_SECRET = 'dev-secret-key-change-in-production';

/**
 * Resolve the legacy JWT secret, failing closed in production if it was left at
 * the public default (or unset). Dev keeps the default for convenience.
 */
function getJwtSecret(): string
{
    const secret = env.SPFN_AUTH_JWT_SECRET;

    if ((!secret || secret === INSECURE_JWT_SECRET) && process.env.NODE_ENV === 'production')
    {
        throw new Error(
            'SPFN_AUTH_JWT_SECRET must be set to a strong secret in production (the default is public).',
        );
    }

    return secret;
}

/**
 * Generate a JWT token (legacy server-signed)
 *
 * @deprecated Use client-side signing with private keys instead
 * This method uses symmetric HMAC which requires sharing the secret
 *
 * @param payload - Token payload
 * @returns JWT token string
 */
export function generateToken(payload: SessionPayload): string
{
    return jwt.sign(payload, getJwtSecret(), {
        expiresIn: env.SPFN_AUTH_JWT_EXPIRES_IN,
    } as SignOptions);
}

/**
 * Verify and decode a JWT token (legacy server-signed)
 *
 * @deprecated Use verifyClientToken for client-signed tokens
 * This method uses symmetric HMAC verification
 *
 * @param token - JWT token to verify
 * @returns Decoded payload
 * @throws Error if verification fails
 */
export function verifyToken(token: string): TokenPayload
{
    // Pin the algorithm to the symmetric HMAC this secret signs with — without an
    // allow-list, jsonwebtoken accepts whatever alg the token header claims
    // (algorithm-confusion risk).
    return jwt.verify(token, getJwtSecret(), { algorithms: ['HS256'] }) as TokenPayload;
}

/** The issuer every client-signed request token carries. */
const CLIENT_TOKEN_ISSUER = 'spfn-client';

/**
 * The longest a request token may live, `exp − iat`, in seconds: 15 minutes,
 * what every first-party signer signs for (the Next.js interceptors and
 * `generateClientToken`). A token without `exp` and `iat`, or signed for
 * longer, is refused — it would be replayable for as long as its key lives.
 */
export const REQUEST_TOKEN_MAX_LIFETIME_SECONDS = 15 * 60;

/**
 * How far apart, in seconds, the signer's clock and the server's may be: 60,
 * the conventional JWT leeway. A first-party signer runs on another host (the
 * Next.js server), whose clock is never exactly the server's. It applies to
 * every comparison of a token claim with the server's clock — `iat` at most
 * `now + 60`, `exp` and `nbf` through `jwt.verify`'s `clockTolerance` — and
 * not to `exp − iat`, which compares the token with itself. Applied at both
 * ends, it makes the server accept a token from `iat − 60` until (not
 * including) `exp + 60` by its own clock: a window of at most
 * `REQUEST_TOKEN_MAX_LIFETIME_SECONDS + 2 × 60` = 1020 seconds.
 */
export const REQUEST_TOKEN_CLOCK_SKEW_SECONDS = 60;

/**
 * Why a client-signed request token was refused:
 * - `token-expired` — signed by the key, past its `exp`: sign a new token;
 * - `bad-signature` — not signed by this key (or refused by a claim check);
 * - `malformed` — not a JWT with an object payload;
 * - `wrong-issuer-or-algorithm` — `iss` is not `spfn-client`, or `alg` is not the key's;
 * - `bad-lifetime` — `exp` or `iat` missing, `iat` more than
 *   {@link REQUEST_TOKEN_CLOCK_SKEW_SECONDS} ahead of the server's clock, or
 *   `exp − iat` above {@link REQUEST_TOKEN_MAX_LIFETIME_SECONDS}.
 */
export type ClientTokenRefusal =
    | 'token-expired'
    | 'bad-signature'
    | 'malformed'
    | 'wrong-issuer-or-algorithm'
    | 'bad-lifetime';

/** What verifying a client-signed request token answers: its payload, or why not. */
export type ClientTokenOutcome = { payload: TokenPayload } | { refused: ClientTokenRefusal };

/**
 * Verify a client-signed request token with the key's public key (Base64 DER, SPKI)
 *
 * Answers a typed outcome rather than throwing, so every caller switches on
 * why a token was refused. Checked in order: the shape, the issuer and
 * algorithm, the signature and expiry, then the lifetime. Every comparison
 * with the server's clock allows {@link REQUEST_TOKEN_CLOCK_SKEW_SECONDS}.
 *
 * @param token - JWT token signed by client's private key
 * @param publicKeyB64 - Base64 encoded DER public key (SPKI format)
 * @param algorithm - Algorithm used for signing (ES256 or RS256)
 *
 * @example
 * ```typescript
 * const outcome = verifyClientToken(token, 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...', 'ES256');
 * if ('refused' in outcome) { ... }
 * ```
 */
export function verifyClientToken(
    token: string,
    publicKeyB64: string,
    algorithm: KeyAlgorithmType,
): ClientTokenOutcome
{
    const decoded = jwt.decode(token, { complete: true });

    if (!decoded || typeof decoded.payload !== 'object' || decoded.payload === null)
    {
        return { refused: 'malformed' };
    }

    if (decoded.header.alg !== algorithm || decoded.payload.iss !== CLIENT_TOKEN_ISSUER)
    {
        return { refused: 'wrong-issuer-or-algorithm' };
    }

    const refused = signatureRefusal(token, publicKeyB64, algorithm)
        ?? lifetimeRefusal(decoded.payload as TokenPayload);

    return refused ? { refused } : { payload: decoded.payload as TokenPayload };
}

/**
 * The signature and `exp` check, with the algorithm and issuer pinned
 * (algorithm confusion). `null` when both hold.
 */
function signatureRefusal(token: string, publicKeyB64: string, algorithm: KeyAlgorithmType): ClientTokenRefusal | null
{
    try
    {
        jwt.verify(token, getPublicKeyObject(publicKeyB64), {
            algorithms: [algorithm],
            issuer: CLIENT_TOKEN_ISSUER,
            clockTolerance: REQUEST_TOKEN_CLOCK_SKEW_SECONDS,
        });

        return null;
    }
    catch (error)
    {
        return error instanceof jwt.TokenExpiredError ? 'token-expired' : 'bad-signature';
    }
}

/**
 * `exp` and `iat` present, `iat` no further ahead of the server's clock than
 * the skew allowance, and `exp − iat` within the maximum.
 */
function lifetimeRefusal(payload: TokenPayload): ClientTokenRefusal | null
{
    const { exp, iat } = payload;
    const latestIssue = Math.floor(Date.now() / 1000) + REQUEST_TOKEN_CLOCK_SKEW_SECONDS;

    if (typeof exp !== 'number' || typeof iat !== 'number' || iat > latestIssue)
    {
        return 'bad-lifetime';
    }

    return exp - iat > REQUEST_TOKEN_MAX_LIFETIME_SECONDS ? 'bad-lifetime' : null;
}

/**
 * Decode a JWT token without verification (for debugging)
 *
 * WARNING: Does not verify signature! Only use for debugging/logging.
 * Never trust decoded data without verification.
 *
 * @param token - JWT token to decode
 * @returns Decoded payload or null if invalid
 */
export function decodeToken(token: string): TokenPayload | null
{
    try
    {
        return jwt.decode(token) as TokenPayload | null;
    }
    catch
    {
        return null;
    }
}

/**
 * Verify public key fingerprint matches
 *
 * Used during registration/login to ensure the public key wasn't tampered with
 * during transmission.
 *
 * Security:
 * - Client sends: publicKey + fingerprint
 * - Server calculates: SHA-256(publicKey)
 * - Server compares: calculated === received
 *
 * @param publicKeyB64 - Base64 encoded DER public key
 * @param expectedFingerprint - SHA-256 hex fingerprint (64 chars)
 * @returns True if fingerprint matches
 *
 * @example
 * ```typescript
 * const isValid = verifyKeyFingerprint(
 *     publicKey,
 *     'a1b2c3d4e5f6...' // 64-char hex string
 * );
 * if (!isValid) {
 *     throw new Error('Public key fingerprint mismatch');
 * }
 * ```
 */
export function verifyKeyFingerprint(
    publicKeyB64: string,
    expectedFingerprint: string,
): boolean
{
    try
    {
        const publicKeyDER = Buffer.from(publicKeyB64, 'base64');
        const fingerprint = crypto
            .createHash('sha256')
            .update(publicKeyDER)
            .digest('hex');

        return fingerprint === expectedFingerprint;
    }
    catch (error)
    {
        console.error('Failed to verify key fingerprint:', error);

        return false;
    }
}

/** The key, or null when the bytes are not a readable SPKI public key. */
function readPublicKey(publicKeyB64: string): crypto.KeyObject | null
{
    try
    {
        return getPublicKeyObject(publicKeyB64);
    }
    catch
    {
        return null;
    }
}

/** How a key's own SPKI describes it, for the message a refusal carries. */
function describeKeyType(key: crypto.KeyObject | null): string
{
    if (!key)
    {
        return 'not a readable SPKI public key';
    }

    if (key.asymmetricKeyType === 'ec')
    {
        return `a ${key.asymmetricKeyDetails?.namedCurve ?? 'unknown-curve'} EC key`;
    }

    return `a ${key.asymmetricKeyType ?? 'unrecognised'} key`;
}

/** Whether the key is the type `algorithm` needs. A key that did not parse is not. */
function keyMatchesAlgorithm(key: crypto.KeyObject | null, algorithm: KeyAlgorithmType): boolean
{
    if (!key)
    {
        return false;
    }

    if (algorithm === 'ES256')
    {
        return key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
    }

    // 'rsa' only — rsa-pss uses a different padding and is not RS256.
    return key.asymmetricKeyType === 'rsa';
}

/**
 * Refuses a public key whose SPKI type is not the one its declared algorithm
 * needs, before the key is stored.
 *
 * The algorithm column is what proof verification later reads, and nothing
 * re-derives it from the key material — so an EC key parked as RS256 is
 * accepted at enrollment and fails on every request afterwards, with the device
 * already believing it is enrolled. Refusing at registration is what keeps that
 * mismatch from ever being written.
 *
 * Bytes that are no SPKI public key at all are refused the same way: the parser
 * throws on them, and an unreadable key is the same defect as a mismatched one.
 * Neither is a server fault, so both answer 400 rather than falling out as a 500.
 *
 * @throws KeyAlgorithmMismatchError when the key is not the algorithm's type.
 */
export function assertKeyMatchesAlgorithm(
    publicKeyB64: string,
    algorithm: KeyAlgorithmType,
): void
{
    const key = readPublicKey(publicKeyB64);

    if (!keyMatchesAlgorithm(key, algorithm))
    {
        throw new KeyAlgorithmMismatchError({
            message: `Public key is ${describeKeyType(key)} but the declared algorithm is ${algorithm}`,
        });
    }
}
