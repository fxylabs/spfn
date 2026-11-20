/**
 * @spfn/core - A server-side call asserting the browser's address to its proxy
 *
 * A server component, server action or route handler reaches the backend through
 * the app's own RPC proxy: a new request, made by the Next.js server, whose
 * `X-Forwarded-For` names that server and not the browser. `createApi` asserts the
 * browser's address — resolved from the inbound request by the proxy's own rule —
 * in one header, `<ip>;<timestamp>;<nonce>;<hmac>`, keyed with the proxy key. The
 * proxy believes an assertion it can verify and nothing else; a browser holds no
 * key, so it cannot make one.
 *
 * The HMAC covers a fixed label, the method and path of the call to the proxy, the
 * address, the timestamp and the nonce: an assertion replayed on another route, or
 * after the 30-second window, is not believed.
 *
 * Server-only (`node:crypto`).
 *
 * @module security/forwarded-client
 */
import { createHmac } from 'node:crypto';

import { generateNonce, safeEqualHex, type ProxyKey } from './proxy-signature';

export const FORWARDED_CLIENT_HEADER = 'x-spfn-forwarded-client';

/** Keeps an assertion's HMAC apart from any proxy signature made with the same key. */
const ASSERTION_LABEL = 'spfn-forwarded-client';

/** How long an assertion is believed, either side of its timestamp. */
const ASSERTION_WINDOW_MS = 30_000;

/** The call to the proxy an assertion is made for. */
export interface AssertedCall
{
    method: string;
    /** The path of the URL the call goes to, without its query. */
    path: string;
}

/**
 * The header value asserting `clientIp` on `call`, or `undefined` for an address
 * the format cannot carry.
 */
export function signForwardedClient(
    key: ProxyKey,
    call: AssertedCall,
    clientIp: string,
    stamp: { timestamp: string; nonce: string } = { timestamp: String(Date.now()), nonce: generateNonce() },
): string | undefined
{
    if (clientIp.includes(';'))
    {
        return undefined;
    }

    return [clientIp, stamp.timestamp, stamp.nonce, assertionHmac(key.secret, call, clientIp, stamp)].join(';');
}

/**
 * The address `header` asserts, when it was made with `key` for this very call
 * within the window; `undefined` for anything else, absent included.
 */
export function verifyForwardedClient(
    key: ProxyKey,
    call: AssertedCall,
    header: string | null | undefined,
    now: number = Date.now(),
): string | undefined
{
    const fields = (header ?? '').split(';');
    const [clientIp, timestamp, nonce, hmac] = fields;

    if (fields.length !== 4 || !clientIp || !nonce || !hmac || !(Math.abs(now - Number(timestamp)) <= ASSERTION_WINDOW_MS))
    {
        return undefined;
    }

    return safeEqualHex(hmac, assertionHmac(key.secret, call, clientIp, { timestamp, nonce })) ? clientIp : undefined;
}

function assertionHmac(secret: string, call: AssertedCall, clientIp: string, stamp: { timestamp: string; nonce: string }): string
{
    const canonical = [ASSERTION_LABEL, call.method.toUpperCase(), call.path, clientIp, stamp.timestamp, stamp.nonce].join('\n');

    return createHmac('sha256', secret).update(canonical).digest('hex');
}
