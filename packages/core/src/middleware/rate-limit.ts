/**
 * @spfn/core - Rate limit middleware
 *
 * Fixed-window rate limiter, registered under the named 'rateLimit' middleware
 * so routes can opt out with `.skip(['rateLimit'])`.
 *
 * Counters live in the shared cache (ioredis) when one is configured: a single
 * atomic Lua call does the increment and the window expiry, so concurrent
 * requests cannot race between INCR and PEXPIRE, and every instance counts
 * against the same window.
 *
 * With no cache — or with the cache down — the limiter counts **in this
 * process** instead (`MemoryRateLimitStore`), the same in-memory-default shape
 * the clientProofV1 replay ledger and the SSE token manager use. Per-process
 * counters mean the effective limit multiplies by the instance count, which is
 * worse than Redis and much better than the alternative that used to apply:
 * having nowhere to count, and so either passing everything through or
 * refusing everything. `failClosed` is what asks for the strict reading —
 * refuse rather than count locally — and stays off by default.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { defineMiddleware, defineMiddlewareFactory } from '../route/define-middleware';
import type { NamedMiddleware } from '../route/define-middleware';
import { getCache, isCacheDisabled } from '../cache';
import { TooManyRequestsError } from '../errors';
// Package specifier, not '../logger': tsup marks `@spfn/*` external, so a
// relative import would inline a SECOND logger singleton into this entrypoint's
// bundle (issue #136).
import { logger } from '@spfn/core/logger';
import { CacheRateLimitStore, MemoryRateLimitStore, type RateLimitStore } from './rate-limit-store';
import { getClientIp } from './client-ip';

const rateLimitLogger = logger.child('@spfn/core:rate-limit');

/**
 * The process-local counters, shared by every limiter instance so one scope's
 * keys cannot be counted twice under two middlewares.
 */
const memoryStore = new MemoryRateLimitStore();

/** Test seam: forget every process-local window. */
export function resetMemoryRateLimitStore(): void
{
    memoryStore.clear();
}

/**
 * One identity dimension to limit on. A bare string uses the top-level `limit`;
 * an object can carry its own `limit` so dimensions can differ (e.g. a loose
 * per-IP cap alongside a tight per-account cap).
 */
export type RateLimitDimension = string | { key: string; limit?: number };

export interface RateLimitOptions
{
    /** Max requests allowed per window, applied to each dimension without its own `limit`. */
    limit: number;

    /** Window length in milliseconds. */
    windowMs: number;

    /**
     * Namespace for the counter keys. Defaults to `${method} ${routePath}` so
     * each route is limited independently.
     */
    scope?: string;

    /**
     * Identity dimensions to limit on. Each non-empty value is counted
     * separately and the strictest wins (e.g. by IP and by account). A dimension
     * may override the top-level `limit` via `{ key, limit }`. Defaults to the
     * client address only, as `getClientIp` resolves it.
     */
    by?: (c: Context) => (RateLimitDimension | null | undefined)[] | Promise<(RateLimitDimension | null | undefined)[]>;

    /**
     * Refuse with 429 when the shared cache is unavailable, instead of counting
     * in this process. For a surface where a per-process count is not an
     * acceptable substitute for a shared one.
     */
    failClosed?: boolean;

    /** Message for the 429 response. */
    message?: string;
}

/**
 * Picks where this request's counters live.
 *
 * Resolved per request, not once at boot: the cache can come up after the
 * server did, or go away under it, and a limiter that decided at startup would
 * keep counting in the wrong place either way.
 *
 * `failClosed` is what makes a missing cache fatal — it reads as "a
 * process-local count is not good enough here", which is a deployment's call to
 * make, not a default.
 */
function selectStore(failClosed: boolean, message: string | undefined, path: string): RateLimitStore
{
    const cache = getCache();

    if (cache && !isCacheDisabled())
    {
        return new CacheRateLimitStore(cache);
    }

    if (failClosed)
    {
        throw new TooManyRequestsError({ message: message || 'Rate limiter unavailable' });
    }

    rateLimitLogger.debug('No cache — counting rate limits in this process', { path });

    return memoryStore;
}

/**
 * Counts one hit, falling back to process-local counters when the cache throws.
 *
 * A cache that answers `getCache()` can still fail mid-command — the connection
 * drops, the server is loading its dataset, the Lua call times out. That used
 * to escape as a 500: the request neither counted nor was refused, it just
 * broke. Now it counts locally, which is the same degradation a cacheless boot
 * gets, and `failClosed` still overrides.
 */
async function hitWithFallback(
    store: RateLimitStore,
    key: string,
    windowMs: number,
    failClosed: boolean,
    message: string | undefined,
    path: string,
): Promise<{ count: number; pttl: number }>
{
    try
    {
        return await store.hit(key, windowMs);
    }
    catch (error)
    {
        if (failClosed)
        {
            throw new TooManyRequestsError({ message: message || 'Rate limiter unavailable' });
        }

        rateLimitLogger.warn('Cache failed — counting this rate limit in the process instead', {
            path,
            error,
        });

        return memoryStore.hit(key, windowMs);
    }
}

/**
 * Fixed-window rate limiter — counters in the shared cache when there is one,
 * in this process otherwise.
 *
 * @example
 * ```typescript
 * route.post('/_auth/login')
 *     .use([rateLimit({ limit: 10, windowMs: 60_000 })])
 *     .handler(...);
 * ```
 */
export const rateLimit = defineMiddlewareFactory(
    'rateLimit',
    (options: RateLimitOptions): MiddlewareHandler =>
    {
        const { limit, windowMs, scope, by, failClosed = false, message } = options;

        return async (c, next) =>
        {
            const store = selectStore(failClosed, message, c.req.path);

            const dimensions = (by ? await by(c) : [getClientIp(c)])
                .filter((d): d is RateLimitDimension => Boolean(d));

            const ns = scope || `${c.req.method} ${c.req.routePath || c.req.path}`;

            for (const dimension of dimensions)
            {
                const key = typeof dimension === 'string' ? dimension : dimension.key;
                if (!key)
                {
                    continue;
                }

                const dimLimit = typeof dimension === 'string' ? limit : (dimension.limit ?? limit);

                const { count, pttl } = await hitWithFallback(
                    store,
                    `ratelimit:${ns}:${key}`,
                    windowMs,
                    failClosed,
                    message,
                    c.req.path,
                );

                if (count > dimLimit)
                {
                    const retryAfter = Math.max(1, Math.ceil((pttl > 0 ? pttl : windowMs) / 1000));
                    c.header('Retry-After', String(retryAfter));

                    throw new TooManyRequestsError({
                        message: message || 'Too many requests, please try again later',
                        retryAfter,
                    });
                }
            }

            return next();
        };
    },
);

/**
 * Named rate-limit policies, populated once at boot from
 * `defineServerConfig().rateLimit({ policies })`. A package tags a route with
 * rateLimitPolicy() and the consuming app supplies the numbers here, so policy
 * tuning lives in one place rather than being hard-coded in each package.
 */
const policyRegistry = new Map<string, RateLimitOptions>();

/**
 * App-wide fail-closed default applied to policy tags that don't set `failClosed`
 * themselves. Set at boot from RATE_LIMIT_FAIL_CLOSED so operators can make ALL
 * limiters (including named policies on auth routes) reject on cache outage — the
 * env flag would otherwise only reach the global default limiter.
 */
let policyFailClosedDefault = false;

/** Set the fail-closed default for named policies. Called by the server at boot. */
export function setRateLimitFailClosedDefault(failClosed: boolean): void
{
    policyFailClosedDefault = failClosed;
}

/**
 * Replace the named-policy registry. Called by the server at boot; passing
 * undefined clears it (so a restart without policies doesn't keep stale ones).
 */
export function setRateLimitPolicies(policies?: Record<string, RateLimitOptions>): void
{
    policyRegistry.clear();

    if (!policies)
    {
        return;
    }

    for (const [name, options] of Object.entries(policies))
    {
        policyRegistry.set(name, options);
    }
}

/** Look up a configured policy by name — undefined when the app didn't set it. */
export function getRateLimitPolicy(name: string): RateLimitOptions | undefined
{
    return policyRegistry.get(name);
}

/**
 * Rate-limit a route under a named policy.
 *
 * A package author tags a sensitive route with a policy name plus a safe
 * fallback; the consuming app tunes the numbers centrally via
 * `defineServerConfig().rateLimit({ policies: { [name]: {...} } })`. When the
 * app configures the policy, its fields override the fallback (shallow merge);
 * otherwise the fallback applies, so the route is protected out of the box.
 *
 * LAYERS on top of the global default limiter rather than replacing it: the tag
 * has a distinct name (`rateLimit:<name>`) and does not skip the global, so a
 * route gets both the global per-IP floor (when enabled) and this policy's own
 * bucket — whichever is stricter trips first. Opt out of the global floor on a
 * route with `.skip(['rateLimit'])`.
 *
 * The counter scope defaults to the policy name, so (a) every route sharing a
 * policy shares one bucket, and (b) the key never collides with the global
 * default's per-route `${method} ${path}` scope.
 *
 * @example
 * ```typescript
 * route.post('/_auth/login')
 *     .use([rateLimitPolicy('auth-login', { limit: 5, windowMs: 60_000 })])
 *     .handler(...);
 * ```
 */
export function rateLimitPolicy(name: string, fallback: RateLimitOptions): NamedMiddleware<string>
{
    // Resolution is deferred to the first request: the registry is populated at
    // server boot, which runs after route modules are imported. Cached after the
    // first hit since the registry is static once the server is up.
    let resolved: MiddlewareHandler | undefined;

    const handler: MiddlewareHandler = (c, next) =>
    {
        if (!resolved)
        {
            const configured = getRateLimitPolicy(name);
            const merged: RateLimitOptions = configured ? { ...fallback, ...configured } : { ...fallback };

            if (merged.scope === undefined)
            {
                merged.scope = name;
            }

            if (merged.failClosed === undefined)
            {
                merged.failClosed = policyFailClosedDefault;
            }

            resolved = rateLimit(merged);
        }

        return resolved(c, next);
    };

    return defineMiddleware(`rateLimit:${name}`, handler);
}
