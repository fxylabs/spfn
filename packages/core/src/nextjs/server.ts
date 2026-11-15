/**
 * SPFN Next.js Server-Only Integration
 *
 * Server-only exports that use next/headers (for API routes and Server Components)
 *
 * ⚠️  DO NOT import this in Client Components - use '@spfn/core/nextjs' instead
 */

// RPC proxy (routeName → method/path resolution)
export { createRpcProxy } from './proxy/rpc';
export type { RpcProxyConfig } from './proxy/rpc';

// Interceptor registry
export {
    registerInterceptors,
    interceptorRegistry,
    matchPath,
    matchMethod,
    filterMatchingInterceptors,
    findRouteEntry,
    executeRequestInterceptors,
    executeResponseInterceptors,
} from './proxy/interceptors';

// Interceptor types
export type {
    RequestInterceptorContext,
    ResponseInterceptorContext,
    RequestInterceptor,
    ResponseInterceptor,
    InterceptorRule,
    ProxyConfig,
    ProxyAbort,
    RouteMapEntry,
} from './proxy/interceptors/types';
