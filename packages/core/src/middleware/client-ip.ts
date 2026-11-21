/**
 * @spfn/core - The client address
 *
 * One answer to "which address did this request come from", read by everything
 * that keys or records by it: per-IP rate limits, the request log, and
 * @spfn/auth's device provenance, audit fields and access logs.
 *
 * In order:
 *
 * 1. A request proxy-guard verified as the Next.js proxy's: the address the proxy
 *    resolved and signed (`x-spfn-proxy-client-ip` under a version-2 signature).
 * 2. When the operator declared the proxies in front of this server
 *    (`SERVER_TRUSTED_PROXY_HOPS`, or `defineServerConfig().trustedProxyHops(n)`):
 *    the `X-Forwarded-For` entry n hops from the right, the one the outermost
 *    trusted proxy appended. Entries to its left are the caller's own words.
 * 3. The TCP peer address.
 *
 * With no declaration no forwarding header is read at all. On a request nothing
 * verified, `X-Forwarded-For` is whatever the caller typed, and a caller that
 * types a new value each time is a new caller each time to every per-IP limit.
 */

import type { Context } from 'hono';
import { env } from '@spfn/core/config';
// Package specifier, not '../logger': see rate-limit.ts (issue #136).
import { logger } from '@spfn/core/logger';
import { clientIpFromForwardedChain } from '../security/forwarded-chain';

const clientIpLogger = logger.child('@spfn/core:client-ip');

/** Set from server config; when unset, `SERVER_TRUSTED_PROXY_HOPS` decides. */
let declaredHops: number | undefined;

let undeclaredProxyWarned = false;

/**
 * The one rule for a trusted-proxy declaration: a whole number of hops, 0 or
 * more. Throws otherwise, so a server config carrying a bad value fails to load
 * and the server refuses to start.
 */
export function parseTrustedProxyHops(value: unknown): number
{
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    {
        throw new Error(
            `Invalid trustedProxyHops: ${String(value)}. `
            + 'Must be a whole number of 0 or more: the count of proxies directly in front of this server.',
        );
    }

    return value;
}

/**
 * Declare how many proxies in front of this server append to `X-Forwarded-For`.
 * `undefined` hands the decision back to `SERVER_TRUSTED_PROXY_HOPS`.
 */
export function setTrustedProxyHops(hops: number | undefined): void
{
    declaredHops = hops === undefined ? undefined : parseTrustedProxyHops(hops);
    undeclaredProxyWarned = false;
}

/**
 * The client address of this request, or `'unknown'` when nothing names one.
 *
 * Takes the Hono context; a route handler passes `c.raw`.
 */
export function getClientIp(c: Context): string
{
    return c.get('proxyClientIp')
        ?? forwardedClientIp(c)
        ?? socketRemoteAddress(c)
        ?? 'unknown';
}

function forwardedClientIp(c: Context): string | undefined
{
    const hops = declaredHops ?? env.SERVER_TRUSTED_PROXY_HOPS;
    const forwardedFor = c.req.header('x-forwarded-for');

    if (hops > 0)
    {
        return clientIpFromForwardedChain(forwardedFor, hops);
    }

    if (forwardedFor && !undeclaredProxyWarned)
    {
        undeclaredProxyWarned = true;
        clientIpLogger.warn(
            'A request carried X-Forwarded-For, but no trusted proxy is declared: per-IP rate limits and logs '
            + 'count the TCP peer address. Behind a load balancer or reverse proxy, declare it with '
            + 'SERVER_TRUSTED_PROXY_HOPS=<hops> or defineServerConfig().trustedProxyHops(<hops>).',
        );
    }

    return undefined;
}

/**
 * TCP peer address from the @hono/node-server adapter, when present. Mirrors the
 * adapter's own getConnInfo access path and degrades to undefined on other
 * runtimes (Bun/edge) so callers fall through to 'unknown'.
 */
function socketRemoteAddress(c: Context): string | undefined
{
    const adapter = c.env as {
        server?: { incoming?: { socket?: { remoteAddress?: string } } };
        incoming?: { socket?: { remoteAddress?: string } };
    } | undefined;
    const bindings = adapter?.server ?? adapter;

    return bindings?.incoming?.socket?.remoteAddress;
}
