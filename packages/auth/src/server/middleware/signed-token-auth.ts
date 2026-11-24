/**
 * Signed Token Authentication Middleware
 *
 * The auth half of a command surface (`@spfn/core/surface`) whose caller holds
 * a token some other service signed: an issuer publishes its public keys as a
 * JWKS, signs a short-lived JWT with EdDSA, and the caller presents it as
 * `Authorization: Bearer <jwt>`. Pass `signedTokenAuth({ keysUrl, iss, aud })`
 * as the surface's `auth`; nothing is stored on this side.
 *
 * A verified token is a machine principal, not a user session: it lands in
 * the context as `signedToken` (read with `getSignedToken`), and `AuthContext`
 * stays unset, so `getAuth(c)` keeps returning app users only — the rule
 * `machine-principals.ts` states for every machine credential.
 *
 * Refusals follow the case table fixed at design time:
 *
 *   token                                              answer
 *   missing, or not `Bearer`                           401 required
 *   valid signature, iss, aud, exp, iat within skew    200
 *   wrong aud / wrong iss                              401 invalid
 *   exp past beyond skew                               401 invalid
 *   exp past within skew                               200
 *   iat in the future beyond skew                      401 invalid
 *   exp or iat missing                                 401 invalid
 *   no kid in the header                               401 invalid, no key lookup
 *   alg other than EdDSA (RS256, HS256, none)          401 invalid
 *   tampered payload or signature                      401 invalid
 *   unknown kid, present after one key-set re-read     200
 *   unknown kid, absent after one re-read              401 invalid
 *   another unknown kid within a minute                401 invalid, no re-read
 *   key set unreachable                                401 invalid
 *
 * Every invalid token gets one refusal message — which check failed narrows a
 * forger's search, so the reason goes to `authLogger` at warn instead, without
 * the token text.
 *
 * Why the checks jose would not make on its own: a header without `kid` is
 * refused before any key lookup, because jose would otherwise try every key
 * the set holds for the algorithm; and `iat` later than now is refused here,
 * because jose reads `iat` only under `maxTokenAge`. A token minted in the
 * future is a clock or an issuer gone wrong, and its `exp` would outlive what
 * the issuer meant to grant.
 *
 * The key set is fetched over https only — http is allowed for a loopback
 * host and refused at construction otherwise. Keys fetched in the clear can be
 * swapped on the wire, and every token signed by the swapped key would then
 * verify.
 *
 * Auto-skips the global 'auth' middleware, like `opsTokenAuth`.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { defineMiddlewareFactory } from '@spfn/core/route';
import { UnauthorizedError } from '@spfn/core/errors';
import { authLogger } from '../logger';
import { optionKeys, readOptions } from '@spfn/core/options';

/** How long an unknown `kid` waits before the key set is read again. */
const KEY_SET_COOLDOWN_MS = 60_000;

const DEFAULT_CLOCK_SKEW_SEC = 30;

const REQUIRED_MESSAGE = 'Signed token required: Authorization: Bearer <token>';
const INVALID_MESSAGE = 'Invalid signed token';

export interface SignedTokenAuthOptions
{
    /** The issuer's JWKS URL. https, or http against a loopback host. */
    keysUrl: string;

    /** Expected `iss` claim. */
    iss: string;

    /** Expected `aud` claim. */
    aud: string;

    /** Tolerance for `exp` and `iat`, in seconds. Default 30. */
    clockSkewSec?: number;
}

/** What a verified signed token carries into the handler. */
export interface VerifiedSignedToken
{
    /** The key the token was signed with. */
    kid: string;
    claims: JWTPayload;
}

type KeySet = ReturnType<typeof createRemoteJWKSet>;

interface Verifier
{
    keys: KeySet;
    iss: string;
    aud: string;
    clockSkewSec: number;
}

// Extend Hono context with the signed token — a key of its own, never `auth`.
declare module 'hono'
{
    interface ContextVariableMap
    {
        signedToken: VerifiedSignedToken;
    }
}

/** Read the verified signed token a handler runs under. */
export function getSignedToken(c: Context): VerifiedSignedToken | null
{
    return (c.get('signedToken') as VerifiedSignedToken | undefined) ?? null;
}

/**
 * Authenticate every request with an EdDSA-signed JWT verified against the
 * issuer's published keys. One key set per instance, created here.
 *
 * @example
 * ```ts
 * const app = defineSurface({
 *     namespace: '/_app',
 *     auth: signedTokenAuth({
 *         keysUrl: 'https://issuer.example/.well-known/keys',
 *         iss: 'https://issuer.example',
 *         aud: 'my-app',
 *     }),
 * });
 * ```
 */
export const signedTokenAuth = defineMiddlewareFactory('signedTokenAuth', (options: SignedTokenAuthOptions): MiddlewareHandler =>
{
    const verifier = verifierOf(options);

    return async (c, next) =>
    {
        const token = extractBearer(c.req.header('Authorization'));

        if (!token)
        {
            throw new UnauthorizedError({ message: REQUIRED_MESSAGE });
        }

        const verified = await verifySignedToken(verifier, token);

        if (!verified)
        {
            throw new UnauthorizedError({ message: INVALID_MESSAGE });
        }

        c.set('signedToken', verified);

        await next();
    };
}, { skips: ['auth'] });

const SIGNED_TOKEN_AUTH_OPTIONS = optionKeys<SignedTokenAuthOptions>({ keysUrl: true, iss: true, aud: true, clockSkewSec: true });

/**
 * `options` read once, by `readOptions` (#477): the `iss` and `aud` checked
 * are the ones every token is verified against, and a misspelt `clockSkew`
 * is refused rather than left at the default.
 */
function verifierOf(options: SignedTokenAuthOptions): Verifier
{
    const read = readOptions<SignedTokenAuthOptions>('signedTokenAuth', options, SIGNED_TOKEN_AUTH_OPTIONS);
    const keysUrl = keysUrlOf(read.keysUrl);
    const iss = requiredClaim('iss', read.iss);
    const aud = requiredClaim('aud', read.aud);

    const clockSkewSec = read.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC;
    if (!Number.isFinite(clockSkewSec) || clockSkewSec < 0)
    {
        throw new Error('signedTokenAuth clockSkewSec must be a non-negative number of seconds.');
    }

    return {
        keys: createRemoteJWKSet(keysUrl, { cooldownDuration: KEY_SET_COOLDOWN_MS }),
        iss,
        aud,
        clockSkewSec,
    };
}

function requiredClaim(claim: 'iss' | 'aud', value: unknown): string
{
    if (typeof value !== 'string' || value.length === 0)
    {
        throw new Error(`signedTokenAuth requires a non-empty ${claim}.`);
    }

    return value;
}

function keysUrlOf(value: string | undefined): URL
{
    const url = parseUrl(value);

    if (!url)
    {
        throw new Error('signedTokenAuth requires keysUrl, an absolute URL of the issuer\'s JWKS.');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
    {
        throw new Error(
            `signedTokenAuth keysUrl must be https (http only against a loopback host), got "${url.protocol}//${url.host}". `
            + 'Keys fetched in the clear can be swapped on the wire.',
        );
    }

    return url;
}

function parseUrl(value: string | undefined): URL | null
{
    try
    {
        return new URL(value ?? '');
    }
    catch
    {
        return null;
    }
}

function isLoopback(hostname: string): boolean
{
    return hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '[::1]'
        || hostname.endsWith('.localhost');
}

/** The verified token, or null with the reason logged. */
async function verifySignedToken(verifier: Verifier, token: string): Promise<VerifiedSignedToken | null>
{
    const kid = kidOf(token);

    if (kid === null)
    {
        return refused('the header carries no kid, or is not a JWS header');
    }

    const claims = await verifiedClaims(verifier, token);

    if (claims === null)
    {
        return null;
    }
    if ((claims.iat as number) > Math.floor(Date.now() / 1000) + verifier.clockSkewSec)
    {
        return refused('iat is later than now beyond the allowed clock skew');
    }

    return { kid, claims };
}

function kidOf(token: string): string | null
{
    try
    {
        const { kid } = decodeProtectedHeader(token);

        return typeof kid === 'string' && kid.length > 0 ? kid : null;
    }
    catch
    {
        return null;
    }
}

async function verifiedClaims(verifier: Verifier, token: string): Promise<JWTPayload | null>
{
    try
    {
        const { payload } = await jwtVerify(token, verifier.keys, {
            issuer: verifier.iss,
            audience: verifier.aud,
            algorithms: ['EdDSA'],
            clockTolerance: verifier.clockSkewSec,
            requiredClaims: ['exp', 'iat'],
        });

        return payload;
    }
    catch (err)
    {
        return refused(err instanceof Error ? err.message : 'unknown');
    }
}

function refused(reason: string): null
{
    authLogger.middleware.warn('Signed token refused', { reason });

    return null;
}

function extractBearer(header: string | undefined): string | null
{
    if (!header || !header.startsWith('Bearer '))
    {
        return null;
    }

    return header.substring(7);
}
