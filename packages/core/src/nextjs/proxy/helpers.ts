/**
 * Helper functions for proxy handler
 * Separates utility logic from main proxy handler for better maintainability
 */
import { NextRequest } from 'next/server.js';
import type { CookieOptions, SetCookie } from '../client';
import type {
    InterceptorRule,
    RequestInterceptorContext,
    ResponseInterceptorContext,
    RouteMapEntry,
} from './interceptors/types';
import type { InterceptorRegistry } from './interceptors';
import { PROXY_CLIENT_IP_HEADER } from '../../security/proxy-signature';
import { clientIpFromForwardedChain } from '../../security/forwarded-chain';

// Re-export from shared
export { parseResponseBody } from '../shared';
export { clientIpFromForwardedChain };

/**
 * Build request headers for proxying
 * Forwards important headers from source and adds default headers
 *
 * @param sourceHeaders - Source headers (can be Headers object or Record)
 * @param defaultHeaders - Default headers to add
 * @param clientIp - the browser's address, as `proxiedClientIp` resolved it
 */
export function buildProxyHeaders(
    sourceHeaders: Headers | Record<string, string>,
    defaultHeaders: Record<string, string>,
    clientIp: string | undefined,
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
    // proxy signature covers it, so the backend believes it only from the holder
    // of the proxy key.
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
    route: RouteMapEntry,
): RequestInterceptorContext
{
    return {
        path: `/${path}`,
        route,
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
