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
import {
    ASSERTION_WINDOW_MS,
    FORWARDED_CLIENT_HEADER,
    signForwardedClient,
    type AssertedCall,
    verifyForwardedClient,
} from '../../security/forwarded-client';

/** An assertion made for one inbound request and target, and when it was signed. */
interface Assertion
{
    value: string | undefined;
    signedAt: number;
}

/**
 * The assertions made so far for each inbound request, by target
 *
 * Keyed by the inbound request's own headers object — `next/headers` answers one per
 * request — so an entry is reachable only from that request and is collected with it;
 * nothing is shared between requests. Every call of one request to one target sends
 * the same header bytes, which is what Next's request dedupe compares.
 */
const assertionsByRequest = new WeakMap<object, Map<string, Assertion>>();

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
 * One assertion per inbound request and target (method and path), reused by every
 * call of that request: what it asserts is a fact about the inbound request, not
 * about the call. It is signed again only once half the window has passed, so a
 * long server action's late call is not sent with one about to expire.
 *
 * @param inbound - the headers of the browser request the call is made for
 * @param method - the call's method
 * @param url - the URL the call goes to
 */
export function forwardedClientHeaders(inbound: Pick<Headers, 'get'>, method: string, url: string): Record<string, string>
{
    const call = { method, path: new URL(url, 'http://localhost').pathname };
    const assertions = assertionsByRequest.get(inbound) ?? new Map<string, Assertion>();
    const target = `${call.method} ${call.path}`;
    const now = Date.now();
    let assertion = assertions.get(target);

    if (!assertion || now - assertion.signedAt >= ASSERTION_WINDOW_MS / 2)
    {
        assertion = { value: signForInbound(inbound, call, now), signedAt: now };
        assertions.set(target, assertion);
        assertionsByRequest.set(inbound, assertions);
    }

    return assertion.value ? { [FORWARDED_CLIENT_HEADER]: assertion.value } : {};
}

function signForInbound(inbound: Pick<Headers, 'get'>, call: AssertedCall, now: number): string | undefined
{
    const key = activeProxyKey(env.SPFN_PROXY_SECRET);
    const clientIp = appClientIp(inbound.get('x-forwarded-for'));

    return key && clientIp ? signForwardedClient(key, call, clientIp, now) : undefined;
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
