/**
 * @spfn/core - Reading a client address out of `X-Forwarded-For`
 *
 * Shared by the places that read the header: the Next.js app — its proxy, which
 * forwards the address it resolved to the backend, and a server-side `createApi`
 * call, which asserts the browser's address to that proxy — and the backend's own
 * `getClientIp`, when the operator declared the proxies in front of it.
 */
import { env } from '@spfn/core/config';

/**
 * Resolve the real client IP from a forwarded chain.
 *
 * `X-Forwarded-For` is `client, proxy1, proxy2, …` — each trusted hop appends the
 * address it received the connection from, so the rightmost `trustedHops` entries
 * are added by our own infra and can't be spoofed. The client as the outermost
 * trusted hop saw it is `parts[len - trustedHops]`. A client that prepends a fake
 * value just lengthens the chain to the left and is ignored.
 *
 * A chain shorter than the declared hops did not come through the declared
 * proxies — its entries are the caller's own — so it names no client, and the
 * caller falls back to the connection peer. With 0 hops nothing appended to the
 * chain is trusted, so every entry is the caller's own and none is a client.
 *
 * @param xff - raw X-Forwarded-For header value
 * @param trustedHops - number of trusted proxies in front (e.g. LB + nginx = 2)
 */
export function clientIpFromForwardedChain(
    xff: string | null | undefined,
    trustedHops: number,
): string | undefined
{
    const parts = (xff ?? '').split(',').map(s => s.trim()).filter(Boolean);

    return trustedHops > 0 ? parts[parts.length - trustedHops] : undefined;
}

/**
 * The browser's address as the Next.js app resolves it from an inbound
 * `X-Forwarded-For`: `TRUSTED_PROXY_HOPS` (default 1) entries from the right.
 * With 0 — nothing in front of the app — none: Next.js writes the header only
 * when the request carries none, so its entries are the browser's own words.
 *
 * The one rule for both the RPC proxy and a server-side `createApi` call, so the
 * address a call asserts is the one the proxy would have read off the browser's
 * own request. A value that is not a whole number of 0 or more is refused by the
 * env schema's validator, at this read.
 */
export function appClientIp(xff: string | null | undefined): string | undefined
{
    return clientIpFromForwardedChain(xff, env.TRUSTED_PROXY_HOPS);
}
