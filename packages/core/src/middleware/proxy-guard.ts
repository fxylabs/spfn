/**
 * Proxy-guard middleware
 *
 * Verifies that an inbound request came through a trusted Next.js RPC proxy
 * (HMAC signature) and/or from an allowed browser origin, then tags the request
 * with a `clientType`. Lets the backend reject direct-to-backend calls that
 * bypass the proxy.
 *
 * This does NOT replace user authentication (JWT) — it answers "what kind of
 * client is this?", not "who is the user?". It also cannot stop a client from
 * calling the proxy itself; that is the web's inherent limit (see
 * PROXY-BACKEND-AUTH-SPEC.md). Mobile clients call the backend directly and are
 * handled by a future attestation path, OR'd into this same check.
 *
 * @module middleware/proxy-guard
 */
import type { Context, MiddlewareHandler, Next } from 'hono';

import { env } from '@spfn/core/config';
import { logger } from '@spfn/core/logger';

import {
    verifyProxyRequest,
    parseProxyKey,
    parseProxyKeySet,
    PROXY_SIGNATURE_HEADER,
    PROXY_TIMESTAMP_HEADER,
    PROXY_NONCE_HEADER,
    PROXY_KEY_ID_HEADER,
    type VerifyFailureReason,
} from '../security/proxy-signature';

const guardLogger = logger.child('@spfn/core:proxy-guard');

// ============================================================================
// Types
// ============================================================================

/**
 * How the request reached the backend.
 * - `web`: verified via a trusted proxy signature
 * - `untrusted`: could not be verified (only reached handlers in `tag` mode)
 * - future: `ios` | `android` once attestation lands
 */
export type ClientType = 'web' | 'untrusted' | (string & {});

/**
 * Enforcement mode.
 * - `off`: middleware is a no-op (default — keeps existing apps working).
 * - `tag`: verify and set `clientType`, but never reject (observe first).
 * - `strict`: reject requests that fail verification.
 */
export type ProxyGuardMode = 'off' | 'tag' | 'strict';

/**
 * Optional replay store. Returns `true` when the nonce is fresh (and records it),
 * `false` when it has been seen before. Backed by Redis in multi-instance setups.
 */
export interface NonceStore
{
    checkAndSet(nonce: string, ttlMs: number): Promise<boolean>;
}

export interface ProxyGuardConfig
{
    /**
     * Active shared HMAC secret, as `<keyId>:<secret>` (or a bare secret).
     * Defaults to `env.SPFN_PROXY_SECRET`. Without it (and no previous keys),
     * signatures cannot be verified and every request is tagged `untrusted`.
     */
    secret?: string;

    /**
     * Previous (grace) keys still accepted for verification during rotation, as a
     * comma-separated list of `<keyId>:<secret>`. The proxy never signs with
     * these — they exist only so in-flight requests signed with the prior key
     * keep verifying until the rollout settles. Defaults to
     * `env.SPFN_PROXY_SECRET_PREVIOUS`. Backend-only, so it can live in
     * `.env.server` (never exposed to the Next.js process).
     */
    previousSecrets?: string;

    /** Enforcement mode. @default 'off' */
    mode?: ProxyGuardMode;

    /** Allowed clock skew / replay window in ms. @default 30000 */
    windowMs?: number;

    /**
     * Browser origin allowlist. When set, a request carrying an `Origin` header
     * not in this list is rejected (strict) / tagged (tag). Requests without an
     * `Origin` (server-to-server, mobile) skip this check and fall back to the
     * signature.
     */
    allowedOrigins?: string[];

    /** Optional nonce store for hard replay rejection. Redis (multi-instance) or in-memory (single). */
    nonceStore?: NonceStore;

    /**
     * When the nonce store throws (e.g. Redis down), reject the request instead of
     * falling back to the timestamp window. Trades availability for strictness.
     * @default false (fall back to the timestamp window)
     */
    nonceFailClosed?: boolean;

    /** Paths to skip entirely (e.g. health checks). */
    skipPaths?: string[];

    /**
     * Reject (413) once the streamed body exceeds this many bytes. Measured AS IT
     * STREAMS — Content-Length is NOT trusted, so a missing/chunked/under-reported
     * length can't bypass it. Bounds the per-request memory the guard buffers.
     * Undefined = no cap (default). Multipart is exempt (unsigned).
     */
    maxBodyBytes?: number;
}

// ============================================================================
// Hono context augmentation
// ============================================================================

declare module 'hono'
{
    interface ContextVariableMap
    {
        clientType?: ClientType;
    }
}

// ============================================================================
// Helpers
// ============================================================================

/** Sentinel: body exceeded maxBodyBytes while streaming (never fully buffered). */
const BODY_OVERSIZE = Symbol('proxy-guard:body-oversize');

/** Sentinel: the body stream errored mid-read (e.g. client abort). */
const BODY_READ_ERROR = Symbol('proxy-guard:body-read-error');

/**
 * Read the raw request body without consuming it for downstream handlers.
 * Bound for ANY non-multipart content-type (not just application/json) so the
 * backend hashes exactly what the proxy signed — otherwise the body could be
 * tampered by flipping content-type. Multipart uploads are excluded on both
 * sides (their large bodies are never hashed).
 *
 * When maxBytes is set the body is measured AS IT STREAMS and aborted past the
 * limit — so a missing/chunked/under-reported Content-Length can't bypass the cap
 * (the header is never trusted). Returns BODY_OVERSIZE in that case.
 */
async function readRawBody(
    c: Context,
    maxBytes?: number,
): Promise<Buffer | undefined | typeof BODY_OVERSIZE | typeof BODY_READ_ERROR>
{
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD')
    {
        return undefined;
    }

    const contentType = c.req.header('content-type') || '';
    if (contentType.includes('multipart/form-data'))
    {
        return undefined;
    }

    const stream = c.req.raw.clone().body;
    if (!stream)
    {
        return undefined;
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    try
    {
        for (;;)
        {
            const { done, value } = await reader.read();
            if (done)
            {
                break;
            }

            total += value.byteLength;
            if (maxBytes !== undefined && total > maxBytes)
            {
                // Fire-and-forget: awaiting cancel() can hang under some stream
                // implementations, and this is a clone so the original is untouched.
                void reader.cancel().catch(() => undefined);

                return BODY_OVERSIZE;
            }

            chunks.push(value);
        }
    }
    catch
    {
        // A mid-stream error (client abort, network blip) RETURNS a sentinel — not an
        // empty body (would 403 valid traffic) and not a re-throw (would 500 + page
        // on-call and break tag mode's never-reject contract).
        guardLogger.debug('Request body read failed (client abort?)');

        return BODY_READ_ERROR;
    }

    return Buffer.concat(chunks);
}

function isOriginAllowed(c: Context, allowedOrigins: string[] | undefined): boolean
{
    if (!allowedOrigins || allowedOrigins.length === 0)
    {
        return true;
    }

    const origin = c.req.header('origin');
    if (!origin)
    {
        // No browser Origin (server-to-server / mobile) — defer to signature.
        return true;
    }

    return allowedOrigins.includes(origin);
}

// ============================================================================
// Middleware
// ============================================================================

/**
 * Create the proxy-guard middleware.
 *
 * @example
 * ```typescript
 * export default defineServerConfig()
 *     .proxyGuard({ mode: 'strict', allowedOrigins: ['https://app.example.com'] })
 *     .routes(appRouter)
 *     .build();
 * ```
 */
export function createProxyGuard(config: ProxyGuardConfig = {}): MiddlewareHandler
{
    const mode = config.mode ?? 'off';
    const windowMs = config.windowMs ?? 30_000;
    const allowedOrigins = config.allowedOrigins;
    const nonceStore = config.nonceStore;
    const nonceFailClosed = config.nonceFailClosed ?? false;
    const skipPaths = new Set(config.skipPaths ?? []);
    const maxBodyBytes = config.maxBodyBytes;

    // Accepted key set: active secret first (wins on keyId collision), then grace keys.
    const activeRaw = config.secret ?? env.SPFN_PROXY_SECRET;
    const previousRaw = config.previousSecrets ?? env.SPFN_PROXY_SECRET_PREVIOUS;
    const keys = parseProxyKeySet([activeRaw, previousRaw]);

    // Fail CLOSED on misconfiguration: strict with no key would otherwise let every
    // request (including direct-to-backend) through. Refuse to start instead.
    if (mode === 'strict' && keys.length === 0)
    {
        throw new Error(
            '[proxy-guard] mode "strict" requires a proxy key but none is configured '
            + '(SPFN_PROXY_SECRET is empty/unset). Refusing to start with the guard open — '
            + 'set the secret, or use mode "tag" / "off".',
        );
    }

    // Warn when rotation can't work: bare secrets (no "keyId:" prefix) on both active
    // and previous collapse to the same keyId, so the grace key is silently dropped.
    if (activeRaw && previousRaw)
    {
        const activeId = parseProxyKey(activeRaw).keyId;
        const collides = previousRaw.split(',').some(p => p.trim() && parseProxyKey(p.trim()).keyId === activeId);
        if (collides)
        {
            guardLogger.warn(
                'Previous proxy key shares keyId with the active key (likely bare secrets without a '
                + '"keyId:" prefix) — grace key ignored, rotation will drop in-flight requests. '
                + 'Use "<keyId>:<secret>" on both keys.',
                { keyId: activeId },
            );
        }
    }

    return async (c: Context, next: Next) =>
    {
        if (mode === 'off' || skipPaths.has(c.req.path))
        {
            return next();
        }

        // A genuine CORS preflight (OPTIONS + Access-Control-Request-Method) belongs to
        // the CORS layer, not the signature guard — exempt it FIRST so it isn't 403'd
        // here without CORS headers. A NON-preflight OPTIONS (rare OPTIONS-as-API) falls
        // through to normal verification, so exempting preflight is never an unguarded
        // bypass. Tagged 'untrusted' (unsigned) so downstream never sees it unset.
        if (c.req.method === 'OPTIONS' && c.req.header('access-control-request-method'))
        {
            c.set('clientType', 'untrusted');

            return next();
        }

        // Every gate below is EVALUATED in both modes; only enforcement differs
        // (reject() = 403 in strict, tag clientType='untrusted' + continue in tag).
        // So tag mode observes exactly what strict would reject — no metric skew.

        // 1. Origin allowlist (browser cross-origin guard)
        if (!isOriginAllowed(c, allowedOrigins))
        {
            return reject(c, mode, next, 'origin-not-allowed');
        }

        // 2. No accepted key — only reachable in tag mode (strict throws at construction).
        if (keys.length === 0)
        {
            c.set('clientType', 'untrusted');

            return next();
        }

        // 3. Cheap header-presence check BEFORE buffering the body, so unsigned requests
        //    (direct-to-backend attacks, tag-mode rollout traffic) reject/tag without
        //    paying the body read.
        const signature = c.req.header(PROXY_SIGNATURE_HEADER);
        const timestamp = c.req.header(PROXY_TIMESTAMP_HEADER);
        const nonce = c.req.header(PROXY_NONCE_HEADER);
        const keyId = c.req.header(PROXY_KEY_ID_HEADER);
        if (!signature || !timestamp || !nonce || !keyId)
        {
            return reject(c, mode, next, 'missing-headers');
        }

        // 4. Read body with a streaming size cap (Content-Length is never trusted, so a
        //    missing/chunked/under-reported length can't bypass the bound).
        const body = await readRawBody(c, maxBodyBytes);
        if (body === BODY_OVERSIZE)
        {
            if (mode === 'strict')
            {
                return c.json({ error: 'Payload Too Large' }, 413);
            }

            c.set('clientType', 'untrusted');

            return next();
        }
        if (body === BODY_READ_ERROR)
        {
            // Body stream failed (client abort) — can't verify, so don't hash an empty
            // body. Reject in strict / tag untrusted, never a 500.
            return reject(c, mode, next, 'body-read-error');
        }

        // 5. HMAC over the wire request-target (raw path + query) and body. Use the raw
        //    URL, NOT the decoded c.req.path, so it matches the bytes the proxy signed.
        const url = new URL(c.req.url);
        const result = verifyProxyRequest({
            keys,
            method: c.req.method,
            path: url.pathname,
            query: url.search,
            body,
            signature,
            timestamp,
            nonce,
            keyId,
            windowMs,
        });

        if (!result.valid)
        {
            return reject(c, mode, next, result.reason);
        }

        // 6. Hard replay rejection via nonce store (both modes — tag observes replays).
        //    Degrade to the timestamp window if the store is briefly unavailable rather
        //    than 500-ing valid traffic.
        if (nonceStore && result.nonce)
        {
            try
            {
                const fresh = await nonceStore.checkAndSet(result.nonce, windowMs * 2);
                if (!fresh)
                {
                    return reject(c, mode, next, 'nonce-replay');
                }
            }
            catch (err)
            {
                if (nonceFailClosed)
                {
                    guardLogger.warn('Nonce store unavailable — rejecting (fail-closed)', err);

                    return reject(c, mode, next, 'nonce-store-unavailable');
                }

                guardLogger.warn('Nonce store unavailable — falling back to timestamp window', err);
            }
        }

        c.set('clientType', 'web');

        return next();
    };
}

// ============================================================================
// Redis-backed nonce store (optional)
// ============================================================================

/** Minimal cache client (compatible with ioredis Redis | Cluster). */
type CacheClient = {
    set(key: string, value: string, ...args: any[]): Promise<any>;
};

/**
 * Build a Redis-backed nonce store for hard replay rejection.
 *
 * Uses `SET key 1 PX ttl NX` — an atomic "set if absent". A fresh nonce returns
 * 'OK'; a replayed one returns null. TTL keeps the key set bounded (only nonces
 * within the replay window matter).
 */
export function createCacheNonceStore(cache: CacheClient, prefix = 'spfn:proxy-nonce:'): NonceStore
{
    return {
        async checkAndSet(nonce: string, ttlMs: number): Promise<boolean>
        {
            const res = await cache.set(`${prefix}${nonce}`, '1', 'PX', Math.ceil(ttlMs), 'NX');

            return res === 'OK';
        },
    };
}

/**
 * In-process nonce store for hard replay rejection without Redis.
 *
 * Good enough for a single instance — each process only knows its own nonces, so
 * across multiple instances a replay routed to a different pod isn't caught. Use a
 * cache-backed store (createCacheNonceStore) for multi-instance hard rejection.
 * Entries self-expire after their TTL; the map is swept opportunistically so it
 * stays bounded by the request rate within the replay window.
 */
export function createInMemoryNonceStore(): NonceStore
{
    const seen = new Map<string, number>(); // nonce -> expiry (epoch ms)
    let lastSweep = 0;

    return {
        async checkAndSet(nonce: string, ttlMs: number): Promise<boolean>
        {
            const now = Date.now();

            if (now - lastSweep > 60_000)
            {
                for (const [n, exp] of seen)
                {
                    if (exp <= now) seen.delete(n);
                }
                lastSweep = now;
            }

            const existing = seen.get(nonce);
            if (existing !== undefined && existing > now)
            {
                return false; // replay within window
            }

            seen.set(nonce, now + ttlMs);

            return true;
        },
    };
}

/**
 * Reject (strict) or tag-and-continue (tag). Keeps the rejection response generic
 * so it leaks no detail about why verification failed.
 */
function reject(
    c: Context,
    mode: ProxyGuardMode,
    next: Next,
    reason: VerifyFailureReason | 'origin-not-allowed' | 'nonce-replay' | 'nonce-store-unavailable' | 'body-read-error' | undefined,
)
{
    if (mode === 'strict')
    {
        guardLogger.warn('Rejected unverified request', { reason, path: c.req.path, method: c.req.method });

        return c.json({ error: 'Forbidden', message: 'Request origin could not be verified' }, 403);
    }

    // tag mode — observe only, never block
    guardLogger.debug('Unverified request (would reject in strict mode)', { reason, path: c.req.path });
    c.set('clientType', 'untrusted');

    return next();
}
