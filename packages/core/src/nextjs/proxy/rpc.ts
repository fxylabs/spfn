/**
 * RPC-Style Proxy for define-route System
 *
 * Next.js API Route handler that resolves routeName to method/path
 * and forwards requests to SPFN backend.
 *
 * @example
 * ```typescript
 * // app/api/rpc/[routeName]/route.ts
 * import { createRpcProxy } from '@spfn/core/nextjs/server';
 * import { eventRouteMap } from '@spfn/core/event';
 * import { routeMap } from '@/generated/route-map';
 *
 * export const { GET, POST } = createRpcProxy({
 *     routeMap: { ...routeMap, ...eventRouteMap },
 * });
 * ```
 *
 * The generated `routeMap` already holds the routes of every package router the
 * app mounts with `.packages()`, so no package map is merged by hand.
 * `eventRouteMap` is the exception: a hand-written constant, not a mounted
 * router.
 */
import { NextRequest, NextResponse } from 'next/server';

import { env } from '@spfn/core/config';
import { logger } from '@spfn/core/logger';
import type { HttpMethod } from '@spfn/core/route';

import { signProxyRequest, parseProxyKeySet } from '../../security/proxy-signature';
import { buildUrlWithParams, buildQueryString } from '../shared';
import { interceptorRegistry } from './interceptors';
import { executeRequestInterceptors, executeResponseInterceptors, filterMatchingInterceptors } from './interceptors';
import {
    buildProxyHeaders,
    parseCookiesFromNextRequest,
    buildSetCookieHeader,
    buildErrorResponse,
    forwardResponseHeaders,
    parseResponseBody,
    collectInterceptors,
    buildRequestContext,
    buildResponseContext,
} from './helpers';
import type { TypedProxyConfig } from './types';

const rpcLogger = logger.child('@spfn/core:rpc-proxy');

// ============================================================================
// Types
// ============================================================================

/**
 * Route info from generated route map
 */
export interface RouteMapEntry
{
    method: HttpMethod;
    path: string;
}

/**
 * Generated route map type
 */
export type RouteMap = Record<string, RouteMapEntry>;

/**
 * RPC proxy configuration
 */
export interface RpcProxyConfig extends Omit<TypedProxyConfig, 'onRequest' | 'onResponse'>
{
    /**
     * Route map containing routeName → {method, path} mappings
     *
     * The generated map carries the app's own routes and those of every package
     * router it mounts with `.packages()`. Merge `eventRouteMap` beside it when
     * the app uses SSE — that one is a constant rather than a mounted router.
     *
     * @example
     * ```typescript
     * import { eventRouteMap } from '@spfn/core/event';
     * import { routeMap } from '@/generated/route-map';
     *
     * export const { GET, POST } = createRpcProxy({
     *     routeMap: { ...routeMap, ...eventRouteMap },
     * });
     * ```
     */
    routeMap: RouteMap;

    /**
     * Shared secret for signing proxy→backend requests (HMAC-SHA256).
     *
     * When set, every forwarded request carries an HMAC signature the backend's
     * proxy-guard middleware verifies, letting it reject direct-to-backend calls
     * that bypass this proxy. Set the SAME value here and on the backend.
     *
     * @default process.env.SPFN_PROXY_SECRET (undefined → signing disabled)
     */
    proxySecret?: string;
}

// ============================================================================
// RPC Proxy Handler
// ============================================================================

/**
 * Create RPC proxy handler for Next.js API Route
 *
 * Handles requests in the format:
 * - GET /api/rpc/{routeName}?input={...}
 * - POST /api/rpc/{routeName} with body
 *
 * Resolves routeName to actual HTTP method and path from routeMap,
 * then forwards to SPFN backend.
 */
export function createRpcProxy(config: RpcProxyConfig)
{
    const {
        apiUrl = env.SPFN_API_URL || 'http://localhost:8790',
        debug = env.NODE_ENV === 'development',
        timeout = env.RPC_PROXY_TIMEOUT,
        headers: defaultHeaders = {},
        interceptors,
        autoDiscoverInterceptors = true,
        disableAutoInterceptors,
        proxySecret = env.SPFN_PROXY_SECRET,
        routeMap,
    } = config;

    // Parse the active signing key once — it's fixed for the proxy's lifetime.
    // Use the SAME parser the backend uses (comma key set) and take the active key,
    // so a `v2:new,v1:old` secret is interpreted identically on both sides.
    const proxyKey = proxySecret ? (parseProxyKeySet([proxySecret])[0] ?? null) : null;

    // proxy-guard signs route-relative paths; if SPFN_API_URL carries a base path the
    // backend keeps (no ingress strip), the signed path won't match c.req.url and
    // strict mode 403s everything. Warn loudly so it's diagnosable.
    if (proxyKey)
    {
        try
        {
            const basePath = new URL(apiUrl).pathname;
            if (basePath !== '/' && basePath !== '')
            {
                rpcLogger.warn(
                    `SPFN_API_URL has a base path ("${basePath}"). proxy-guard signs route-relative paths, `
                    + 'so the backend must receive paths WITHOUT this prefix (e.g. ingress strip) or strict '
                    + 'mode will reject all signed requests with 403.',
                );
            }
        }
        catch
        {
            // invalid apiUrl is surfaced elsewhere
        }
    }

    /**
     * Resolve route info from routeMap
     */
    function resolveRoute(routeName: string): { method: string; path: string } | null
    {
        const entry = routeMap[routeName];
        if (entry)
        {
            return { method: entry.method, path: entry.path };
        }

        return null;
    }

    /**
     * Handle RPC request
     */
    async function handleRpc(
        request: NextRequest,
        context: { params: Promise<{ routeName?: string }> },
    ): Promise<NextResponse>
    {
        const startTime = Date.now();
        const params = await context.params;

        try
        {
            const routeName = params.routeName;

            if (!routeName)
            {
                return NextResponse.json(
                    buildErrorResponse('Bad Request', 'Missing routeName parameter', debug),
                    { status: 400 },
                );
            }

            // Parse input from query string (GET) or body (POST)
            let input: {
                params?: Record<string, any>;
                query?: Record<string, any>;
                body?: Record<string, any>;
                formData?: Record<string, any>;
                headers?: Record<string, any>;
                cookies?: Record<string, any>;
            } = {};
            let rawFormData: FormData | null = null;

            if (request.method === 'GET')
            {
                const inputParam = request.nextUrl.searchParams.get('input');
                if (inputParam)
                {
                    try
                    {
                        input = JSON.parse(decodeURIComponent(inputParam));
                    }
                    catch
                    {
                        return NextResponse.json(
                            buildErrorResponse('Bad Request', 'Invalid input parameter', debug),
                            { status: 400 },
                        );
                    }
                }
            }
            else
            {
                // POST - check Content-Type for formData vs JSON
                const contentType = request.headers.get('content-type') || '';

                if (contentType.includes('multipart/form-data'))
                {
                    // Parse multipart/form-data
                    try
                    {
                        rawFormData = await request.formData();

                        // Extract __metadata if present (contains params, query, etc.)
                        const metadataStr = rawFormData.get('__metadata');
                        if (metadataStr && typeof metadataStr === 'string')
                        {
                            const metadata = JSON.parse(metadataStr);
                            input.params = metadata.params;
                            input.query = metadata.query;
                            input.headers = metadata.headers;
                            input.cookies = metadata.cookies;
                        }

                        // Collect formData fields (excluding __metadata)
                        input.formData = {};
                        rawFormData.forEach((value, key) =>
                        {
                            if (key === '__metadata') return;

                            const existing = input.formData![key];
                            if (existing !== undefined)
                            {
                                // Multiple values with same key
                                if (Array.isArray(existing))
                                {
                                    existing.push(value);
                                }
                                else
                                {
                                    input.formData![key] = [existing, value];
                                }
                            }
                            else
                            {
                                input.formData![key] = value;
                            }
                        });
                    }
                    catch (error)
                    {
                        return NextResponse.json(
                            buildErrorResponse('Bad Request', 'Invalid form data', debug),
                            { status: 400 },
                        );
                    }
                }
                else
                {
                    // Parse JSON body
                    try
                    {
                        input = await request.json();
                    }
                    catch
                    {
                        return NextResponse.json(
                            buildErrorResponse('Bad Request', 'Invalid JSON body', debug),
                            { status: 400 },
                        );
                    }
                }
            }

            // Resolve route info from routeMap
            const routeInfo = resolveRoute(routeName);

            if (!routeInfo)
            {
                rpcLogger.warn(`Route not found: ${routeName}`);

                return NextResponse.json(
                    buildErrorResponse('Not Found', `Route "${routeName}" not found`, debug),
                    { status: 404 },
                );
            }

            const { method: targetMethod, path: targetPath } = routeInfo;

            // Build target URL with params and query
            const inputParams = input.params || {};
            const inputQuery = input.query || {};
            const inputBody = input.body;
            const inputFormData = input.formData;
            const hasFormData = rawFormData !== null && inputFormData && Object.keys(inputFormData).length > 0;

            const resolvedPath = buildUrlWithParams(targetPath, inputParams);
            const queryString = buildQueryString(inputQuery);
            const targetUrl = `${apiUrl}${resolvedPath}${queryString}`;

            if (debug)
            {
                rpcLogger.debug('→ RPC request', {
                    routeName,
                    targetMethod,
                    targetPath: resolvedPath,
                    targetUrl,
                    hasBody: !!inputBody,
                    hasFormData,
                });
            }

            // Build headers
            const headers = buildProxyHeaders(request.headers, defaultHeaders);

            // Remove Content-Type for formData (let fetch set it with boundary)
            if (hasFormData)
            {
                headers.delete('content-type');
            }

            // Build fetch options
            const fetchOptions: RequestInit = {
                method: targetMethod,
                headers,
            };

            // Add body for POST/PUT/PATCH
            if (['POST', 'PUT', 'PATCH'].includes(targetMethod))
            {
                if (hasFormData && rawFormData)
                {
                    // Forward formData to backend (rebuild without __metadata)
                    const forwardFormData = new FormData();
                    rawFormData.forEach((value, key) =>
                    {
                        if (key !== '__metadata')
                        {
                            forwardFormData.append(key, value);
                        }
                    });
                    fetchOptions.body = forwardFormData;
                }
                else if (inputBody)
                {
                    fetchOptions.body = JSON.stringify(inputBody);
                }
            }

            // ============================================================
            // Advanced Interceptors - BEFORE FETCH
            // ============================================================

            // Collect and filter interceptors
            const allInterceptors = collectInterceptors(autoDiscoverInterceptors, disableAutoInterceptors, interceptors, interceptorRegistry);
            const matchingInterceptors = filterMatchingInterceptors(allInterceptors, resolvedPath, targetMethod);

            if (debug && matchingInterceptors.length > 0)
            {
                rpcLogger.debug(`Found ${matchingInterceptors.length} matching interceptors for ${targetMethod} ${resolvedPath}`);
            }

            // Create RequestInterceptorContext
            const cookiesMap = parseCookiesFromNextRequest(request);
            const requestCtx = buildRequestContext(
                resolvedPath.slice(1), // Remove leading slash
                targetMethod,
                headers,
                inputBody,
                new URLSearchParams(queryString.slice(1)), // Remove leading ?
                cookiesMap,
                request,
            );

            // Execute request interceptors
            const requestInterceptorsToRun = matchingInterceptors.map(r => r.request).filter((i): i is NonNullable<typeof i> => !!i);
            if (requestInterceptorsToRun.length > 0)
            {
                await executeRequestInterceptors(requestCtx, requestInterceptorsToRun);

                // Apply modified headers
                for (const [key, value] of Object.entries(requestCtx.headers))
                {
                    headers.set(key, value);
                }

                // Apply modified body
                if (requestCtx.body)
                {
                    fetchOptions.body = JSON.stringify(requestCtx.body);
                }
            }

            // An interceptor refused the request (e.g. the CSRF check in @spfn/auth).
            // Return its response without touching the backend; no response
            // interceptor runs, so the only cookies a refusal can carry are the
            // ones the refusing interceptor attached to the abort. The CSRF check
            // attaches a fresh token there, so the refusal is what repairs the
            // browser instead of merely reporting the damage.
            if (requestCtx.abort)
            {
                rpcLogger.warn('Request refused by an interceptor', {
                    routeName,
                    status: requestCtx.abort.status,
                });

                const abortResponse = NextResponse.json(
                    requestCtx.abort.body,
                    { status: requestCtx.abort.status },
                );

                for (const cookie of requestCtx.abort.setCookies ?? [])
                {
                    abortResponse.headers.append('Set-Cookie', buildSetCookieHeader(cookie));
                }

                return abortResponse;
            }

            // ============================================================
            // Proxy → Backend signature (proxy-guard)
            // ============================================================
            // Sign the FINAL request (after interceptors settled body/headers) so
            // the backend can prove it came through this trusted proxy. JSON body
            // is hashed into the signature; large multipart uploads are excluded.
            if (proxyKey)
            {
                const signedBody = typeof fetchOptions.body === 'string' ? fetchOptions.body : undefined;
                // Sign the route-relative path (no SPFN_API_URL base prefix) so it
                // matches the backend's `new URL(c.req.url).pathname` whether the
                // prefix is absent or stripped by an ingress. resolvedPath is already
                // the percent-encoded wire form; queryString is the raw search.
                const signatureHeaders = signProxyRequest({
                    key: proxyKey,
                    method: targetMethod,
                    path: resolvedPath,
                    query: queryString,
                    body: signedBody,
                });

                for (const [headerName, value] of Object.entries(signatureHeaders))
                {
                    headers.set(headerName, value);
                }
            }

            // Execute fetch with timeout
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            try
            {
                const response = await fetch(targetUrl, {
                    ...fetchOptions,
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                // Parse response
                let body = await parseResponseBody(response);

                // ============================================================
                // Advanced Interceptors - AFTER FETCH
                // ============================================================

                // Create ResponseInterceptorContext
                const responseCtx = buildResponseContext(
                    resolvedPath.slice(1),
                    targetMethod,
                    headers,
                    inputBody,
                    response,
                    body,
                    requestCtx.metadata,
                    requestCtx.cookies,
                );

                // Execute response interceptors
                const responseInterceptorsToRun = matchingInterceptors.map(r => r.response).filter((i): i is NonNullable<typeof i> => !!i);
                if (responseInterceptorsToRun.length > 0)
                {
                    await executeResponseInterceptors(responseCtx, responseInterceptorsToRun);
                    body = responseCtx.response.body;
                }

                const duration = Date.now() - startTime;

                if (debug)
                {
                    rpcLogger.debug('← RPC response', {
                        routeName,
                        status: responseCtx.response.status,
                        duration: `${duration}ms`,
                    });
                }

                // Build Next.js response
                // 204 No Content should use NextResponse directly, not NextResponse.json()
                const nextResponse = responseCtx.response.status === 204
                    ? new NextResponse(null, {
                        status: 204,
                        statusText: responseCtx.response.statusText,
                    })
                    : NextResponse.json(body, {
                        status: responseCtx.response.status,
                        statusText: responseCtx.response.statusText,
                    });

                // Forward response headers
                forwardResponseHeaders(response.headers, nextResponse.headers);

                // Apply setCookies from interceptors
                for (const cookie of responseCtx.setCookies)
                {
                    const setCookieHeader = buildSetCookieHeader(cookie);
                    nextResponse.headers.append('Set-Cookie', setCookieHeader);

                    if (debug)
                    {
                        rpcLogger.debug('Set-Cookie header added', {
                            name: cookie.name,
                        });
                    }
                }

                return nextResponse;
            }
            catch (error)
            {
                clearTimeout(timeoutId);

                // Handle timeout
                if (error instanceof Error && error.name === 'AbortError')
                {
                    rpcLogger.error('Request timeout', {
                        routeName,
                        targetUrl,
                        timeout,
                    });

                    return NextResponse.json(
                        buildErrorResponse('Gateway Timeout', `Request timed out after ${timeout}ms`, debug, error),
                        { status: 504 },
                    );
                }

                // Handle other fetch errors
                const fetchErr = error as Error;
                rpcLogger.error('Fetch error', {
                    routeName,
                    targetUrl,
                    error: fetchErr.message,
                });

                return NextResponse.json(
                    buildErrorResponse('Bad Gateway', fetchErr.message || 'Failed to connect to backend', debug, fetchErr),
                    { status: 502 },
                );
            }
        }
        catch (error)
        {
            const duration = Date.now() - startTime;
            const err = error as Error;

            rpcLogger.error('RPC proxy error', {
                error: err.message,
                stack: err.stack,
                duration: `${duration}ms`,
            });

            return NextResponse.json(
                buildErrorResponse('Internal Server Error', err.message || 'Unknown error', debug, err),
                { status: 500 },
            );
        }
    }

    // Return route handlers
    return {
        GET: (req: NextRequest, context: { params: Promise<{ routeName?: string }> }) =>
            handleRpc(req, context),
        POST: (req: NextRequest, context: { params: Promise<{ routeName?: string }> }) =>
            handleRpc(req, context),
    };
}
