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

/** RFC 7636 §4.1: 43 to 128 characters drawn from the unreserved set. */
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

/** RFC 7636 §4.2 under S256: 43 base64url characters, unpadded. */
const PKCE_S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Whether a presented verifier is one RFC 7636 describes.
 *
 * Conformance rather than defence — the S256 comparison is what authorizes, and
 * a verifier of any length still has to hash to the stored challenge. What this
 * catches is a client that built its verifier wrong: 22 characters of entropy
 * carries less than the transform promises, and an oversized one is a client
 * that will be refused by the next server it talks to for a reason this one
 * never told it.
 */
export function isPkceVerifierShaped(codeVerifier: string): boolean
{
    return PKCE_VERIFIER.test(codeVerifier);
}

/**
 * Whether a presented challenge could have come out of the S256 transform.
 *
 * A challenge of any other shape is a client that sent something else in the
 * field — its verifier, most often, which is `plain` PKCE wearing the S256
 * label and is exactly what the method check exists to refuse.
 */
export function isPkceS256ChallengeShaped(codeChallenge: string): boolean
{
    return PKCE_S256_CHALLENGE.test(codeChallenge);
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
