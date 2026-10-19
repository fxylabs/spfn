// ============================================================================
// Configuration
// ============================================================================

import { NextRequest } from 'next/server.js';
import { InterceptorRule } from '@spfn/core/nextjs/server';

/**
 * Request interceptor result
 */
export interface RequestInterceptorResult
{
    url: string;
    headers?: Record<string, string>;
}

/**
 * Response interceptor result
 */
export interface ResponseInterceptorResult
{
    response: Response;
    body: any;
}

/**
 * Request interceptor function
 */
export type ProxyRequestInterceptor = (
    req: NextRequest,
    url: string,
) => Promise<RequestInterceptorResult> | RequestInterceptorResult;

/**
 * Response interceptor function
 */
export type ProxyResponseInterceptor = (
    response: Response,
    body: any,
) => Promise<ResponseInterceptorResult> | ResponseInterceptorResult;

/**
 * Proxy configuration
 */
export interface TypedProxyConfig
{
    /**
     * SPFN API base URL
     *
     * @default process.env.SPFN_API_URL || 'http://localhost:8790'
     */
    apiUrl?: string;

    /**
     * Enable debug logging
     *
     * @default process.env.NODE_ENV === 'development'
     */
    debug?: boolean;

    /**
     * RPC proxy request timeout in milliseconds
     * AbortController timeout - cancels proxied request if backend doesn't respond in time
     * Should be shorter than FETCH_HEADERS_TIMEOUT to ensure meaningful 504 response
     *
     * @default env.RPC_PROXY_TIMEOUT (120000)
     */
    timeout?: number;

    /**
     * Custom headers to add to all forwarded requests
     */
    headers?: Record<string, string>;

    /**
     * Simple request interceptor - modify request before forwarding
     *
     * For simple use cases. Use `interceptors` for advanced features like:
     * - Path/method matching
     * - Cookie setting
     * - Multiple interceptors with chaining
     */
    onRequest?: ProxyRequestInterceptor;

    /**
     * Simple response interceptor - modify response before returning
     *
     * For simple use cases. Use `interceptors` for advanced features.
     */
    onResponse?: ProxyResponseInterceptor;

    /**
     * Advanced interceptors with path matching, cookie support, and chaining
     *
     * @example
     * ```typescript
     * interceptors: [{
     *   pathPattern: '/_auth/*',
     *   method: 'POST',
     *   request: async (ctx, next) => {
     *     ctx.headers['Authorization'] = 'Bearer token';
     *     await next();
     *   },
     *   response: async (ctx, next) => {
     *     ctx.setCookies.push({
     *       name: 'session',
     *       value: 'xxx',
     *       options: { httpOnly: true, maxAge: 3600 }
     *     });
     *     await next();
     *   }
     * }]
     * ```
     */
    interceptors?: InterceptorRule[];

    /**
     * Enable automatic interceptor discovery from registry
     *
     * When enabled, interceptors registered via registerInterceptors()
     * are automatically applied.
     *
     * @default true
     */
    autoDiscoverInterceptors?: boolean;

    /**
     * Disable interceptors from specific packages
     *
     * @example ['auth', 'storage']
     */
    disableAutoInterceptors?: string[];
}
