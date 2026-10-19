import { NextRequest } from 'next/server.js';
import { SetCookie } from '../../client';

/**
 * Interceptor Rule
 *
 * Defines when and how to intercept requests/responses
 */
export interface InterceptorRule
{
    /**
     * Path pattern to match
     *
     * - String with wildcards: '/_auth/*', '/users/:id'
     * - RegExp: /^\/_auth\/.+$/
     * - '*' matches all paths
     *
     * @example
     * ```typescript
     * pathPattern: '/_auth/*'      // matches /_auth/login, /_auth/register
     * pathPattern: '/users/:id'    // matches /users/123, /users/456
     * pathPattern: /^\/_auth\/.+$/ // regex match
     * pathPattern: '*'             // matches all paths
     * ```
     */
    pathPattern: string | RegExp;

    /**
     * HTTP method(s) to match (optional)
     *
     * - Single method: 'POST'
     * - Multiple methods: ['POST', 'PUT']
     * - Omit to match all methods
     *
     * @default undefined (matches all methods)
     */
    method?: string | string[];

    /**
     * Request interceptor
     *
     * Called before SPFN API request
     */
    request?: RequestInterceptor;

    /**
     * Response interceptor
     *
     * Called after SPFN API response
     */
    response?: ResponseInterceptor;
}

/**
 * Response an interceptor refuses a request with
 */
export interface ProxyAbort
{
    /** HTTP status returned to the caller */
    status: number;

    /** JSON body returned to the caller */
    body: unknown;

    /**
     * Cookies to set on the refusal itself
     *
     * A refusal skips the backend and every response interceptor, so this is the
     * only way a refused request can hand the browser anything. The CSRF check in
     * @spfn/auth uses it to reissue the readable token cookie on the 403 it emits,
     * which is what makes "retry and it works" true rather than aspirational: the
     * client that was refused now holds the value the next attempt needs.
     *
     * Set nothing an unauthenticated caller could not already have — a refusal is
     * reachable by whoever sent the request.
     */
    setCookies?: SetCookie[];
}

/**
 * Request Interceptor Context
 *
 * Available before calling SPFN API
 */
export interface RequestInterceptorContext
{
    /**
     * Request path (e.g., '/_auth/login')
     */
    path: string;

    /**
     * HTTP method (e.g., 'POST')
     */
    method: string;

    /**
     * Request headers (mutable)
     */
    headers: Record<string, string>;

    /**
     * Request body (mutable)
     */
    body?: any;

    /**
     * Query parameters from original request
     */
    query: Record<string, string | string[]>;

    /**
     * Cookies from Next.js request
     */
    cookies: Map<string, string>;

    /**
     * Original Next.js request
     */
    request: NextRequest;

    /**
     * Metadata for sharing data between interceptors
     */
    metadata: Record<string, any>;

    /**
     * Refuse the request without calling the backend
     *
     * An interceptor that sets this stops the proxy before the fetch: the status
     * and body are returned to the caller as-is and no response interceptor runs.
     * A refusal therefore sets only the cookies the refusing interceptor put on
     * `abort.setCookies` itself. Used by the CSRF check in @spfn/auth, the only
     * layer that knows a request was authenticated from the session cookie rather
     * than from a caller-supplied bearer token.
     */
    abort?: ProxyAbort;
}

/**
 * Response Interceptor Context
 *
 * Available after SPFN API responds
 */
export interface ResponseInterceptorContext
{
    /**
     * Request path
     */
    path: string;

    /**
     * HTTP method
     */
    method: string;

    /**
     * Original request data (immutable)
     */
    request: {
        headers: Record<string, string>;
        body?: any;
    };

    /**
     * Response data (mutable)
     */
    response: {
        ok: boolean;
        status: number;
        statusText: string;
        headers: Headers;
        body: any;
    };

    /**
     * Cookies from original request (read-only)
     */
    cookies: Map<string, string>;

    /**
     * Cookies to set in response
     *
     * @example
     * ```typescript
     * ctx.setCookies.push({
     *   name: 'session',
     *   value: 'xxx',
     *   options: { httpOnly: true, maxAge: 3600 }
     * });
     * ```
     */
    setCookies: SetCookie[];

    /**
     * Metadata shared from request interceptors
     */
    metadata: Record<string, any>;
}

/**
 * Request Interceptor Function
 *
 * @param context - Request context (mutable)
 * @param next - Call to continue to next interceptor
 *
 * @example
 * ```typescript
 * const interceptor: RequestInterceptor = async (ctx, next) => {
 *   // Modify headers
 *   ctx.headers['Authorization'] = 'Bearer token';
 *
 *   // Store data for response interceptor
 *   ctx.metadata.userId = '123';
 *
 *   // Continue to next interceptor
 *   await next();
 * };
 * ```
 */
export type RequestInterceptor = (
    context: RequestInterceptorContext,
    next: () => Promise<void>,
) => Promise<void>;

/**
 * Response Interceptor Function
 *
 * @param context - Response context (mutable)
 * @param next - Call to continue to next interceptor
 *
 * @example
 * ```typescript
 * const interceptor: ResponseInterceptor = async (ctx, next) => {
 *   // Modify response body
 *   ctx.response.body = { ...ctx.response.body, extra: 'data' };
 *
 *   // Set cookie
 *   ctx.setCookies.push({
 *     name: 'session',
 *     value: 'xxx',
 *     options: { httpOnly: true }
 *   });
 *
 *   // Continue to next interceptor
 *   await next();
 * };
 * ```
 */
export type ResponseInterceptor = (
    context: ResponseInterceptorContext,
    next: () => Promise<void>,
) => Promise<void>;

/**
 * Proxy Configuration
 */
export interface ProxyConfig
{
    /**
     * SPFN API base URL
     *
     * @default process.env.SERVER_API_URL || process.env.SPFN_API_URL || 'http://localhost:8790'
     */
    apiUrl?: string;

    /**
     * Additional custom interceptors
     *
     * These are executed after auto-discovered interceptors
     *
     * Executed in order: first registered -> last registered
     */
    interceptors?: InterceptorRule[];

    /**
     * Enable automatic interceptor discovery from registry
     *
     * When enabled, all interceptors registered via registerInterceptors()
     * are automatically applied to the proxy.
     *
     * @default true
     */
    autoDiscoverInterceptors?: boolean;

    /**
     * Disable interceptors from specific packages
     *
     * Use this to exclude auto-discovered interceptors from certain packages
     * when you want to provide custom implementations.
     *
     * @example ['auth', 'storage']
     */
    disableAutoInterceptors?: string[];

    /**
     * Enable debug logging
     *
     * @default false
     */
    debug?: boolean;
}
