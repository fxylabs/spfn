/**
 * Helper functions for proxy handler
 * Separates utility logic from main proxy handler for better maintainability
 */
import { NextRequest } from 'next/server.js';
import type { CookieOptions, SetCookie } from '../client';
import type { InterceptorRule, RequestInterceptorContext, ResponseInterceptorContext } from './interceptors/types';
import type { InterceptorRegistry } from './interceptors';
import { PROXY_CLIENT_IP_HEADER } from '../../security/proxy-signature';

// Re-export from shared
export { parseResponseBody } from '../shared';

/**
 * Resolve the real client IP from a forwarded chain.
 *
 * `X-Forwarded-For` is `client, proxy1, proxy2, …` — each trusted hop appends the
 * address it received the connection from, so the rightmost `trustedHops` entries
 * are added by our own infra and can't be spoofed. The client as the outermost
 * trusted hop saw it is `parts[len - trustedHops]`. A client that prepends a fake
 * value just lengthens the chain to the left and is ignored.
 *
 * @param xff - raw X-Forwarded-For header value
 * @param trustedHops - number of trusted proxies in front (e.g. LB + nginx = 2)
 */
export function clientIpFromForwardedChain(
    xff: string | null | undefined,
    trustedHops: number,
): string | undefined
{
    if (!xff) return undefined;

    const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return undefined;

    const idx = parts.length - Math.max(1, trustedHops);

    // Fewer entries than configured hops (misconfig / fewer real hops): best-effort
    // to the leftmost rather than returning nothing.
    return parts[idx] ?? parts[0];
}

function trustedProxyHops(): number
{
    const raw = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? '', 10);

    return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/**
 * Build request headers for proxying
 * Forwards important headers from source and adds default headers
 *
 * @param sourceHeaders - Source headers (can be Headers object or Record)
 * @param defaultHeaders - Default headers to add
 */
export function buildProxyHeaders(
    sourceHeaders: Headers | Record<string, string>,
    defaultHeaders: Record<string, string>,
): Headers
{
    const headers = new Headers();

    // Forward important headers from source
    const headersToForward = [
        'content-type',
        'authorization',
        'cookie',
        'user-agent',
        'accept',
        'accept-language',
        // Forwarded so the backend proxy-guard can enforce its origin allowlist on
        // the real browser Origin; without this allowedOrigins would be a no-op.
        'origin',
    ];

    for (const header of headersToForward)
    {
        const value = sourceHeaders instanceof Headers
            ? sourceHeaders.get(header)
            : sourceHeaders[header];

        if (value)
        {
            headers.set(header, value);
        }
    }

    // Forward the real client IP so the backend can rate-limit per user. The
    // backend trusts this header only on proxy-verified requests, so a direct
    // caller can't spoof it. Resolved hop-aware from the inbound X-Forwarded-For.
    const xff = sourceHeaders instanceof Headers
        ? sourceHeaders.get('x-forwarded-for')
        : sourceHeaders['x-forwarded-for'];
    const clientIp = clientIpFromForwardedChain(xff, trustedProxyHops());
    if (clientIp)
    {
        headers.set(PROXY_CLIENT_IP_HEADER, clientIp);
    }

    // Add default headers
    for (const [key, value] of Object.entries(defaultHeaders))
    {
        headers.set(key, value);
    }

    return headers;
}

/**
 * Parse cookies from Cookie header string
 *
 * @param cookieHeader - Cookie header string (e.g., "session=abc; theme=dark")
 * @returns Map of cookie name-value pairs
 */
export function parseCookies(cookieHeader: string | null | undefined): Map<string, string>
{
    const cookiesMap = new Map<string, string>();

    if (!cookieHeader)
    {
        return cookiesMap;
    }

    const cookiePairs = cookieHeader.split(';').map(c => c.trim());
    for (const pair of cookiePairs)
    {
        const [name, ...valueParts] = pair.split('=');
        if (name && valueParts.length > 0)
        {
            const value = valueParts.join('='); // Handle = in cookie value
            cookiesMap.set(name.trim(), value.trim());
        }
    }

    return cookiesMap;
}

/**
 * Parse cookies from NextRequest (Next.js specific helper)
 * Combines cookies from both NextRequest.cookies and Cookie header
 */
export function parseCookiesFromNextRequest(request: NextRequest): Map<string, string>
{
    const cookiesMap = new Map<string, string>();

    // Add cookies from NextRequest (browser cookies)
    for (const cookie of request.cookies.getAll())
    {
        cookiesMap.set(cookie.name, cookie.value);
    }

    // Add cookies from Cookie header (server-side forwarded cookies)
    const cookieHeader = request.headers.get('cookie');
    if (cookieHeader)
    {
        const parsed = parseCookies(cookieHeader);
        for (const [name, value] of parsed.entries())
        {
            cookiesMap.set(name, value);
        }
    }

    return cookiesMap;
}

// Mapping of option names to Set-Cookie attribute formats
const optionMappings: Array<{
    key: keyof CookieOptions;
    format: (value: any) => string | null;
}> = [
    { key: 'httpOnly', format: (v) => v ? 'HttpOnly' : null },
    { key: 'secure', format: (v) => v ? 'Secure' : null },
    { key: 'sameSite', format: (v) => v ? `SameSite=${v}` : null },
    { key: 'maxAge', format: (v) => v !== undefined ? `Max-Age=${v}` : null },
    { key: 'path', format: (v) => v ? `Path=${v}` : null },
    { key: 'domain', format: (v) => v ? `Domain=${v}` : null },
];

/**
 * Build Set-Cookie header string from cookie options
 */
export function buildSetCookieHeader(cookie: SetCookie): string
{
    const parts = [`${cookie.name}=${cookie.value}`];
    const options = cookie.options || {};

    for (const { key, format } of optionMappings)
    {
        const value = options[key];
        if (value !== undefined && value !== false)
        {
            const formatted = format(value);
            if (formatted)
            {
                parts.push(formatted);
            }
        }
    }

    return parts.join('; ');
}

/**
 * Build error response JSON
 */
export function buildErrorResponse(
    errorType: string,
    message: string,
    debug: boolean,
    error?: Error,
): any
{
    return {
        error: errorType,
        message,
        ...(debug && error?.stack && { stack: error.stack }),
    };
}

const headersToForward = [
    'content-type',
    'cache-control',
    'set-cookie',
    'etag',
    'last-modified',
];

/**
 * Forward response headers back to client
 */
export function forwardResponseHeaders(
    sourceHeaders: Headers,
    targetHeaders: Headers,
): void
{
    for (const header of headersToForward)
    {
        const value = sourceHeaders.get(header);
        if (value)
        {
            targetHeaders.set(header, value);
        }
    }
}

/**
 * Collect all interceptors (auto-discovered + config)
 */
export function collectInterceptors(
    autoDiscoverInterceptors: boolean,
    disableAutoInterceptors: string[] | undefined,
    configInterceptors: InterceptorRule[] | undefined,
    registry: InterceptorRegistry,
): InterceptorRule[]
{
    const allInterceptors: InterceptorRule[] = [];

    // Auto-discover from registry
    if (autoDiscoverInterceptors)
    {
        const registeredInterceptors = registry.getAll(disableAutoInterceptors || []);
        allInterceptors.push(...registeredInterceptors);
    }

    // Add config interceptors
    if (configInterceptors)
    {
        allInterceptors.push(...configInterceptors);
    }

    return allInterceptors;
}

/**
 * Build RequestInterceptorContext
 */
export function buildRequestContext(
    path: string,
    method: string,
    headers: Headers,
    body: any,
    searchParams: URLSearchParams,
    cookiesMap: Map<string, string>,
    request: NextRequest,
): RequestInterceptorContext
{
    return {
        path: `/${path}`,
        method,
        headers: Object.fromEntries(headers.entries()),
        body,
        query: Object.fromEntries(searchParams.entries()),
        cookies: cookiesMap,
        request,
        metadata: {},
    };
}

/**
 * Build ResponseInterceptorContext
 */
export function buildResponseContext(
    path: string,
    method: string,
    requestHeaders: Headers,
    requestBody: any,
    response: Response,
    responseBody: any,
    requestMetadata: Record<string, any>,
    cookies: Map<string, string>,
): ResponseInterceptorContext
{
    return {
        path: `/${path}`,
        method,
        request: {
            headers: Object.fromEntries(requestHeaders.entries()),
            body: requestBody,
        },
        response: {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            body: responseBody,
        },
        cookies,
        setCookies: [],
        metadata: requestMetadata,
    };
}
