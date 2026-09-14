/**
 * SPFN Next.js Integration (Client-safe exports only)
 *
 * ⚠️  Server-only exports (using next/headers) are in '@spfn/core/nextjs/server'
 *
 * This file ONLY exports code that works in Client Components.
 * DO NOT add any server-only code here.
 */

export {
    createApi,
    ApiError,
    CSRF_HEADER,
    csrfHeaderValue,
    documentCookieEntries,
} from './client';

export type {
    Client,
    RouteClient,
    ApiConfig,
    CallOptions,
    InferRouteInput,
    InferRouteOutput,
    RouterInput,
    RouterOutput,
    RequestInterceptor,
    ResponseInterceptor,
    StructuredInput,
    CookieOptions,
    SetCookie,
} from './client';
