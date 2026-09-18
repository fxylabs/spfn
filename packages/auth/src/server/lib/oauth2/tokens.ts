/**
 * OAuth 2.1 token, code and clock helpers
 *
 * Every secret this server issues is generated, hashed and compared here, so
 * there is one answer to "how long is it, what does it start with, and how is it
 * checked" rather than one per call site.
 *
 * Lookup is by the hash and the hash column is unique, so the database finds at
 * most one row — but the equality that actually authorizes is done here, in
 * constant time, over the hex digests. It costs a string comparison of 64
 * characters and it means the decision never depends on how an index compared.
 *
 * The clock helpers are the other half. Three places express a moment and they
 * disagree about the unit — the row stores a timestamp, `verifyAccessToken`
 * answers seconds since the epoch, and a token response carries the seconds
 * remaining — so all three go through one function each rather than three
 * divisions by 1000 that can each be wrong on their own.
 */

import { createHash, randomBytes } from 'node:crypto';
import { timingSafeEqualString } from '../csrf';

/** Shape of an access token. Paired with `isAccessTokenShaped` below. */
export const OAUTH2_ACCESS_TOKEN_PREFIX = 'spfn_at_';

/** Shape of a refresh token. */
export const OAUTH2_REFRESH_TOKEN_PREFIX = 'spfn_rt_';

/** 32 bytes of entropy, the same width as every other secret in this package. */
const SECRET_BYTES = 32;

/** SHA-256 hex of a token or code. The only form either is ever stored in. */
export function hashOAuth2Secret(secret: string): string
{
    return createHash('sha256').update(secret).digest('hex');
}

/** Constant-time equality for two hex digests. */
export function sameOAuth2Hash(a: string, b: string): boolean
{
    return timingSafeEqualString(a, b);
}

export function generateAccessToken(): string
{
    return OAUTH2_ACCESS_TOKEN_PREFIX + randomBytes(SECRET_BYTES).toString('hex');
}

export function generateRefreshToken(): string
{
    return OAUTH2_REFRESH_TOKEN_PREFIX + randomBytes(SECRET_BYTES).toString('hex');
}

/** 43 url-safe characters, which is 32 bytes of base64url with no padding. */
export function generateAuthorizationCode(): string
{
    return randomBytes(SECRET_BYTES).toString('base64url');
}

/**
 * Whether a presented bearer credential has the access-token shape.
 *
 * Shape only — the token may still be unknown, revoked or expired, which
 * `verifyAccessToken` decides. Callers read a raw header, so a missing or
 * non-string argument answers false rather than throwing, exactly as
 * `isOpsToken` does.
 */
export function isAccessTokenShaped(bearer: string): boolean
{
    return typeof bearer === 'string' && bearer.startsWith(OAUTH2_ACCESS_TOKEN_PREFIX);
}

/** The PKCE S256 transform: base64url of SHA-256 over the verifier's ASCII. */
export function pkceChallengeFor(codeVerifier: string): string
{
    return createHash('sha256').update(codeVerifier).digest('base64url');
}

/** A moment as seconds since the epoch — what `verifyAccessToken` answers with. */
export function toEpochSeconds(at: Date): number
{
    return Math.floor(at.getTime() / 1000);
}

/**
 * Whole seconds from now until a moment — what `expires_in` carries.
 *
 * Floored at zero: a token that expired while the response was being built is
 * answered as zero rather than as a negative number a client would read as an
 * enormous unsigned one.
 */
export function secondsUntil(at: Date, from: Date = new Date()): number
{
    return Math.max(0, Math.floor((at.getTime() - from.getTime()) / 1000));
}
