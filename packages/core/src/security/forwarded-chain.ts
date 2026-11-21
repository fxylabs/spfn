/**
 * @spfn/core - Reading a client address out of `X-Forwarded-For`
 *
 * Shared by the places that read the header: the Next.js app — its proxy, which
 * forwards the address it resolved to the backend, and a server-side `createApi`
 * call, which asserts the browser's address to that proxy — and the backend's own
 * `getClientIp`, when the operator declared the proxies in front of it.
 */

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
 * caller falls back to the connection peer.
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

    return parts[parts.length - Math.max(1, trustedHops)];
}

/**
 * The browser's address as the Next.js app resolves it from an inbound
 * `X-Forwarded-For`: `TRUSTED_PROXY_HOPS` (default 1) entries from the right.
 *
 * The one rule for both the RPC proxy and a server-side `createApi` call, so the
 * address a call asserts is the one the proxy would have read off the browser's
 * own request.
 */
export function appClientIp(xff: string | null | undefined): string | undefined
{
    const hops = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '', 10);

    return clientIpFromForwardedChain(xff, Number.isFinite(hops) && hops > 0 ? hops : 1);
}
