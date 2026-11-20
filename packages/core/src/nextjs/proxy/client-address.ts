/**
 * The browser's address across a server-side call, as the Next.js app signs and
 * believes it.
 *
 * Server-only: the isomorphic client reaches `forwardedClientHeaders` through
 * `@spfn/core/nextjs/server-call`, by dynamic import, the way it reaches `next/headers`.
 */
import { env } from '@spfn/core/config';

import { parseProxyKeySet, type ProxyKey } from '../../security/proxy-signature';
import { appClientIp } from '../../security/forwarded-chain';
import { FORWARDED_CLIENT_HEADER, signForwardedClient, verifyForwardedClient } from '../../security/forwarded-client';

/**
 * The key the proxy signs with: the first of the key set `secret` names — the same
 * parser the backend uses, so `v2:new,v1:old` reads alike on both sides — or null.
 */
export function activeProxyKey(secret: string | undefined): ProxyKey | null
{
    return secret ? (parseProxyKeySet([secret])[0] ?? null) : null;
}

/**
 * The header a server-side call to `url` carries to assert the browser's address,
 * read off the inbound request by the proxy's own rule and keyed with
 * `SPFN_PROXY_SECRET`. Empty without a key or without an address to assert.
 *
 * @param inbound - the headers of the browser request the call is made for
 * @param method - the call's method
 * @param url - the URL the call goes to
 */
export function forwardedClientHeaders(inbound: Pick<Headers, 'get'>, method: string, url: string): Record<string, string>
{
    const key = activeProxyKey(env.SPFN_PROXY_SECRET);
    const clientIp = appClientIp(inbound.get('x-forwarded-for'));
    const assertion = key && clientIp
        ? signForwardedClient(key, { method, path: new URL(url, 'http://localhost').pathname }, clientIp)
        : undefined;

    return assertion ? { [FORWARDED_CLIENT_HEADER]: assertion } : {};
}

/**
 * The browser's address for a request the proxy received: the one a server-side
 * call asserted, when the assertion verifies with the proxy's key for this method
 * and path; otherwise the one its `X-Forwarded-For` names.
 */
export function proxiedClientIp(request: Request, proxyKey: ProxyKey | null): string | undefined
{
    const asserted = proxyKey
        ? verifyForwardedClient(
            proxyKey,
            { method: request.method, path: new URL(request.url).pathname },
            request.headers.get(FORWARDED_CLIENT_HEADER),
        )
        : undefined;

    return asserted ?? appClientIp(request.headers.get('x-forwarded-for'));
}
