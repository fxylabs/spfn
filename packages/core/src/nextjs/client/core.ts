/**
 * Type-Safe RPC-Style Client with Structured Input API
 *
 * Provides full end-to-end type safety from server routes to client calls.
 * No metadata codegen required - method/path resolution happens at the proxy layer.
 *
 * @example
 * ```typescript
 * // Server
 * export const appRouter = defineRouter({
 *   getUser: route.get('/users/:id')
 *     .input({ params: Type.Object({ id: Type.String() }) })
 *     .handler(async (c) => { ... }),
 *   createUser: route.post('/users')
 *     .input({ body: Type.Object({ name: Type.String() }) })
 *     .handler(async (c) => { ... }),
 * });
 *
 * export type AppRouter = typeof appRouter;
 *
 * // Client - no metadata needed!
 * const api = createApi<AppRouter>();
 *
 * // ✅ GET (no body) - becomes GET /api/rpc/getUser?input={...}
 * const user = await api.getUser.call({ params: { id: '1' } });
 *
 * // ✅ POST (has body) - becomes POST /api/rpc/createUser
 * const newUser = await api.createUser.call({ body: { name: 'John' } });
 *
 * // ✅ With options (headers, cookies, interceptors)
 * const user = await api.getUser
 *   .headers({ 'X-Custom': 'value' })
 *   .cookies({ session: 'xxx' })
 *   .fetchOptions({ next: { revalidate: 60 } })
 *   .call({ params: { id: '1' } });
 * ```
 */
import { env } from '@spfn/core/config';
import { ErrorRegistry, errorRegistry as coreErrorRegistry } from '@spfn/core/errors';
import { logger } from '@spfn/core/logger';
import type { Router } from '@spfn/core/route';
import * as debugLogs from './debug-logs';
import { ApiError } from './errors';
import {
    parseResponseBody,
    executeFetchWithTimeout,
    handleErrorResponse,
    buildCookieHeader,
    autoDetectServerCookies,
} from './helpers';
import { CSRF_HEADER, csrfHeaderValue, documentCookieEntries } from './csrf';
import { RouteCallBuilder } from './builder';
import type { ApiConfig, CallOptions } from './types';
import type { Client } from './builder';

const apiLogger = logger.child('@spfn/core:api-client');

// ============================================================================
// Client Implementation
// ============================================================================

/**
 * Create type-safe RPC client
 *
 * No metadata required - the client sends routeName + input to the proxy,
 * and the proxy resolves the actual HTTP method and path from the router.
 *
 * @example
 * ```typescript
 * // Client - no metadata needed!
 * const api = createApi<AppRouter>();
 *
 * // GET request (no body) - browser cacheable
 * const user = await api.getUser.call({ params: { id: '1' } });
 *
 * // POST request (has body)
 * const newUser = await api.createUser.call({ body: { name: 'John' } });
 * ```
 */
export function createApi<TRouter extends Router<any>>(
    config: ApiConfig = {},
): Client<TRouter>
{
    const {
        baseUrl = '/api/rpc',
        headers: defaultHeaders = {},
        timeout = env.SERVER_TIMEOUT,
        fetch: customFetch = fetch,
        onRequest: globalOnRequest,
        onResponse: globalOnResponse,
        errorRegistry: errorRegistryConfig,
        debug = false,
    } = config;

    // Normalize errorRegistry: always include coreErrorRegistry
    const errorRegistry = Array.isArray(errorRegistryConfig)
        ? new ErrorRegistry([coreErrorRegistry, ...errorRegistryConfig])
        : errorRegistryConfig ?? coreErrorRegistry;

    if (debug)
    {
        apiLogger.debug('API client initialized', { baseUrl });
    }

    /**
     * Execute API call
     *
     * Determines GET vs POST based on body/formData presence:
     * - No body/formData → GET /api/rpc/{routeName}?input={...}
     * - Has body → POST /api/rpc/{routeName} with JSON body
     * - Has formData → POST /api/rpc/{routeName} with multipart/form-data
     */
    async function executeCall(
        routeName: string,
        input: any = {},
        options: CallOptions = {},
    ): Promise<any>
    {
        const hasBody = input.body !== undefined;
        const hasFormData = input.formData !== undefined && Object.keys(input.formData).length > 0;
        const method = (hasBody || hasFormData) ? 'POST' : 'GET';

        // Build full URL - handle SSR case where SPFN_APP_URL might not be set
        let appUrl = env.SPFN_APP_URL || '';

        // In SSR environment, if SPFN_APP_URL is not set, try to get host from request headers
        if (!appUrl && typeof window === 'undefined')
        {
            try
            {
                const { headers } = await import('next/headers');
                const headersList = await headers();
                const host = headersList.get('host');
                const protocol = headersList.get('x-forwarded-proto') || 'http';
                if (host)
                {
                    appUrl = `${protocol}://${host}`;
                    if (debug)
                    {
                        apiLogger.debug(`Auto-detected app URL from headers: ${appUrl}`);
                    }
                }
            }
            catch
            {
                // Fallback: use relative URL and let fetch handle it
                if (debug)
                {
                    apiLogger.warn('Could not determine app URL in SSR environment, using relative URL');
                }
            }
        }

        // Build URL based on method
        let fullUrl: string;
        if (method === 'GET')
        {
            // GET: encode input in query string
            const inputParam = encodeURIComponent(JSON.stringify(input));
            fullUrl = `${appUrl}${baseUrl}/${routeName}?input=${inputParam}`;
        }
        else
        {
            // POST: input goes in body
            fullUrl = `${appUrl}${baseUrl}/${routeName}`;
        }

        // Prepare headers
        // Note: Don't set Content-Type for formData - browser sets it with boundary
        const headers: Record<string, string> = {
            ...(hasFormData ? {} : { 'Content-Type': 'application/json' }),
            ...defaultHeaders,
            ...options.headers,
        };

        // Auto-detect server cookies and merge with user-provided cookies
        const autoDetectedCookies = await autoDetectServerCookies();
        const cookiesToSend = {
            ...autoDetectedCookies,
            ...(options.cookies || {}),
        };

        // Add Cookie header if we have cookies to send
        if (Object.keys(cookiesToSend).length > 0)
        {
            headers['Cookie'] = buildCookieHeader(cookiesToSend);
        }

        // Mirror the readable CSRF cookie into a header, from the browser jar or
        // — server-side — from the jar being forwarded.
        //
        // Carried on GET calls too, deliberately: the wire method here is chosen
        // by whether the input has a body, not by what the route does. A bodyless
        // mutation (`api.logout.call({})`) travels as GET and the proxy still
        // forwards it as the route's POST, so a GET-shaped call can be exactly
        // the request that needs the header. The proxy decides what to check from
        // the resolved route method, and ignores the header on safe routes.
        const csrfToken = csrfHeaderValue(
            typeof window === 'undefined' ? Object.entries(cookiesToSend) : documentCookieEntries(),
        );

        const csrfSetByCaller = Object.keys(headers).some(name => name.toLowerCase() === CSRF_HEADER);

        if (csrfToken && !csrfSetByCaller)
        {
            headers[CSRF_HEADER] = csrfToken;
        }

        // Log cookie auto-detection if debug enabled
        if (debug && Object.keys(autoDetectedCookies).length > 0)
        {
            const cookieArray = Object.entries(autoDetectedCookies).map(([name, value]) => ({ name, value }));
            debugLogs.logCookieAutoDetection(apiLogger, cookieArray);
        }

        // Build request init
        const requestInit: RequestInit = {
            method,
            headers,
            ...options.fetchOptions,
        };

        // Add body for POST
        if (method === 'POST')
        {
            if (hasFormData)
            {
                // Build FormData for file uploads
                const formData = new FormData();

                // Add non-formData fields (params, query, headers, cookies) as JSON metadata
                const metadata: Record<string, any> = {};
                if (input.params) metadata.params = input.params;
                if (input.query) metadata.query = input.query;
                if (input.headers) metadata.headers = input.headers;
                if (input.cookies) metadata.cookies = input.cookies;

                if (Object.keys(metadata).length > 0)
                {
                    formData.append('__metadata', JSON.stringify(metadata));
                }

                // Add formData fields
                for (const [key, value] of Object.entries(input.formData))
                {
                    if (value instanceof File)
                    {
                        formData.append(key, value);
                    }
                    else if (Array.isArray(value))
                    {
                        // Handle array of files or values
                        for (const item of value)
                        {
                            if (item instanceof File)
                            {
                                formData.append(key, item);
                            }
                            else
                            {
                                formData.append(key, String(item));
                            }
                        }
                    }
                    else if (value !== undefined && value !== null)
                    {
                        formData.append(key, String(value));
                    }
                }

                requestInit.body = formData;
            }
            else
            {
                requestInit.body = JSON.stringify(input);
            }
        }

        // Execute request interceptors
        let init = requestInit;
        if (globalOnRequest)
        {
            init = await globalOnRequest(fullUrl, init);
        }
        if (options.onRequest)
        {
            init = await options.onRequest(fullUrl, init);
        }

        if (debug)
        {
            debugLogs.logRequest(apiLogger, routeName, method, fullUrl, !!init.body);
        }

        // Execute fetch with timeout
        let response: Response;
        let body: any;

        try
        {
            response = await executeFetchWithTimeout(fullUrl, init, timeout, customFetch);

            // Parse response
            body = await parseResponseBody(response);
        }
        catch (error)
        {
            // Handle timeout specifically
            if (error instanceof Error && error.name === 'AbortError')
            {
                apiLogger.error('Request timeout', {
                    route: routeName,
                    method,
                    url: fullUrl,
                    timeout,
                });

                throw new ApiError(
                    `Request timeout after ${timeout}ms`,
                    408,
                    fullUrl,
                    undefined,
                    'timeout',
                );
            }

            // Network error
            const errorMessage = error instanceof Error ? error.message : 'Network error';
            apiLogger.error('Network error', {
                route: routeName,
                method,
                url: fullUrl,
                error: errorMessage,
                errorName: error instanceof Error ? error.name : 'unknown',
            });

            throw new ApiError(
                errorMessage,
                0,
                fullUrl,
                undefined,
                'network',
            );
        }

        // Execute global + local response interceptors
        //
        // These run outside the try/catch on purpose. That catch classifies a transport
        // failure, and an interceptor throwing is not one: Next.js implements `redirect()`
        // and `notFound()` by throwing an error carrying a digest, and an interceptor
        // raising a domain error of its own is not a transport failure either. Run inside
        // the try, every one of those became `ApiError(..., 0, ..., 'network')` — the
        // navigation never happened and the caller was handed a network failure that never
        // occurred, which retry and offline handling keyed on `errorType === 'network'`
        // act on.
        if (globalOnResponse)
        {
            const result = await globalOnResponse(response, body);
            response = result.response;
            body = result.body;
        }
        if (options.onResponse)
        {
            const result = await options.onResponse(response, body);
            response = result.response;
            body = result.body;
        }

        if (debug)
        {
            debugLogs.logResponse(apiLogger, routeName, response.status, !!body);
        }

        // Handle error responses
        if (!response.ok)
        {
            await handleErrorResponse(response, body, fullUrl, errorRegistry, debug, apiLogger);
        }

        return body;
    }

    /**
     * Build client proxy
     *
     * Every property access returns a `RouteCallBuilder` for that one property read as a
     * whole route name, and that name goes on the wire as `/api/rpc/{routeName}`. The
     * proxy route resolves it against the generated route map, whose names are flat.
     *
     * Nesting needs nothing here: `registerRoutes` mounts a route declared inside a
     * nested `defineRouter` under its own key, so `api.getThing` is the call for a nested
     * `getThing` exactly as for a top-level one — which is the namespace `Client` types.
     * There is no dot-notation traversal: a property access never returns another proxy,
     * so `api.group.getThing` reads a property of a builder and is `undefined`.
     *
     * `prefix` is vestigial — nothing passes one, and adding a caller that did would
     * build a dotted name the route map cannot resolve.
     */
    function buildProxy(prefix = ''): any
    {
        return new Proxy(
            {},
            {
                get(_target, prop: string)
                {
                    const currentPath = prefix ? `${prefix}.${prop}` : prop;

                    // Return RouteCallBuilder that can either be called or chained
                    return new RouteCallBuilder(
                        (input: any, options: CallOptions) => executeCall(currentPath, input, options),
                        currentPath,
                    );
                },
            },
        );
    }

    return buildProxy() as Client<TRouter>;
}
