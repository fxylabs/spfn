/**
 * A second request to the backend, made from a response interceptor.
 *
 * The proxy's own fetch happens once, between the two interceptor phases. A rule
 * that learns from the answer that it has to talk to the backend again — repeat
 * the call with a freshly signed credential, or undo something the call did —
 * has no URL, no proxy-guard key and no timeout of its own, and must not invent
 * them. This is the proxy's fetch, offered back to it: same base URL, the same
 * forwarded headers, signed for proxy-guard the same way, bounded by the same
 * timeout.
 */

import { signProxyRequest, PROXY_CLIENT_IP_HEADER, type ProxyKey } from '../../security/proxy-signature';
import { parseResponseBody } from '../shared';
import type { BackendAnswer, BackendCall } from './interceptors/types';

/** The request the proxy sent, as a later call starts from it. */
export interface ProxiedRequest
{
    apiUrl: string;
    proxyKey: ProxyKey | null;
    timeout: number;
    method: string;
    /** Wire path, leading slash, no query. */
    path: string;
    /** Raw query string with its leading `?`, or ''. */
    query: string;
    headers: Headers;
    body: RequestInit['body'];
}

/**
 * Send `call` to the backend and answer with what came back.
 *
 * Omitted fields are the original request's: no `path` repeats the very call
 * the response answers (its query and body included); a `path` of its own sends
 * no query, and the body `call` names, if any. `call.headers` override the
 * forwarded ones, and the proxy-guard signature is made over the request as
 * finally sent.
 *
 * @param original - the request the proxy sent
 * @param call - what differs from it
 */
export async function callBackend(original: ProxiedRequest, call: BackendCall): Promise<BackendAnswer>
{
    const repeat = call.path === undefined;
    const method = call.method ?? original.method;
    const path = call.path ?? original.path;
    const query = repeat ? original.query : '';
    const body = repeat ? original.body : jsonBody(call.body);
    const headers = new Headers(original.headers);

    for (const [name, value] of Object.entries(call.headers ?? {}))
    {
        headers.set(name, value);
    }

    signFor(original.proxyKey, headers, { method, path, query, body });

    const response = await fetchWithin(original.timeout, `${original.apiUrl}${path}${query}`, { method, headers, body });

    return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        body: await parseResponseBody(response),
    };
}

function jsonBody(body: unknown): string | undefined
{
    return body === undefined ? undefined : JSON.stringify(body);
}

/** Replace whatever signature the forwarded headers carried with one over this request, its client address included. */
function signFor(
    proxyKey: ProxyKey | null,
    headers: Headers,
    request: { method: string; path: string; query: string; body: RequestInit['body'] },
): void
{
    if (!proxyKey)
    {
        return;
    }

    const signature = signProxyRequest({
        key: proxyKey,
        method: request.method,
        path: request.path,
        query: request.query,
        body: typeof request.body === 'string' ? request.body : undefined,
        clientIp: headers.get(PROXY_CLIENT_IP_HEADER),
    });

    for (const [name, value] of Object.entries(signature))
    {
        headers.set(name, value);
    }
}

async function fetchWithin(timeout: number, url: string, init: RequestInit): Promise<Response>
{
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try
    {
        return await fetch(url, { ...init, signal: controller.signal });
    }
    finally
    {
        clearTimeout(timer);
    }
}
