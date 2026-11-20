/**
 * Route Registration for define-route style routing
 *
 * Registers routes defined with route.get()...handler() to Hono app
 */

import type { Context, Hono, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode, RedirectStatusCode } from 'hono/utils/http-status';
import { logger } from '@spfn/core/logger';
import type { RouteInput } from './route-input';
import type { RouteBuilderContext } from './context';
import type { RouteDef } from './route-builder';
import type { Router } from './router';
import { resolveRouteMiddlewares, type ResolvedRoute } from './route-chain';
import type { HttpMethod } from './types';
import {
    validateField,
    validateFormData,
    extractQueryParams,
    extractHeaders,
    extractCookies,
    parseJsonBody,
    parseFormData,
} from './validation';

/**
 * Registered route information for logging
 */
export interface RegisteredRoute
{
    method: HttpMethod;
    path: string;
    name: string;
    /** The names of the middleware the route runs, in order; empty for a plain handler. */
    middlewares: string[];
}

/**
 * Register routes from defineRouter() to Hono app
 *
 * Each route is registered with the chain `resolveRouteMiddlewares` resolves
 * for it: the server-level list and every enclosing router's `.use()`, minus
 * what the route skips and what a middleware below declares in `skips`, then
 * the route's own `.use()`.
 *
 * @param app - Hono app instance
 * @param router - Router definition
 * @param namedMiddlewares - Optional server-level named middlewares
 * @param collectedRoutes - An array to append the registered routes to
 *
 * @example
 * ```ts
 * const appRouter = defineRouter({
 *   getUser: route.get('/users/:id')...
 *   createUser: route.post('/users')...
 * });
 *
 * const app = new Hono();
 * const namedMiddlewares = [
 *   { name: 'auth', handler: AuthMiddleware() },
 *   { name: 'rateLimit', handler: RateLimitMiddleware() },
 * ];
 * registerRoutes(app, appRouter, namedMiddlewares);
 * ```
 */
export function registerRoutes<TRoutes extends Record<string, RouteDef<any> | Router<any>>>(
    app: Hono,
    router: Router<TRoutes>,
    namedMiddlewares?: ReadonlyArray<{ name: string; handler: MiddlewareHandler }>,
    collectedRoutes?: RegisteredRoute[],
): RegisteredRoute[]
{
    const routes = collectedRoutes ?? [];

    for (const resolved of resolveRouteMiddlewares(router, namedMiddlewares))
    {
        routes.push(registerRoute(app, resolved));
    }

    return routes;
}

/**
 * Register a single route with its resolved middleware chain
 */
function registerRoute(app: Hono, resolved: ResolvedRoute): RegisteredRoute
{
    const { name, method, path, middlewares, route } = resolved;
    const { input, interceptor, handler } = route;

    // Create wrapped handler with validation
    const wrappedHandler = async (c: Context) =>
    {
        // Create RouteBuilderContext with validation
        const { context, responseMeta } = await createRouteBuilderContext(c, input || {}, interceptor);

        // Call user handler
        const result = await handler(context);

        // If handler returns Response, use it directly (e.g., c.json(), c.redirect())
        if (result instanceof Response)
        {
            return result;
        }

        // Handle empty responses (noContent, notModified, accepted without data)
        if (responseMeta.isEmpty)
        {
            return c.body(null, responseMeta.status);
        }

        // Return data as JSON with status and headers from helper methods
        const hasCustomHeaders = Object.keys(responseMeta.headers).length > 0;

        if (hasCustomHeaders)
        {
            return c.json(result, responseMeta.status, responseMeta.headers);
        }

        return c.json(result, responseMeta.status);
    };

    // Register to Hono with correct HTTP method
    const methodLower = method.toLowerCase() as Lowercase<HttpMethod>;

    // hono 4.12+ overload resolution fails with spread middleware arrays
    const handlers: MiddlewareHandler[] = [...middlewares.map(mw => mw.handler), wrappedHandler as unknown as MiddlewareHandler];
    app.on([methodLower], [path], ...handlers);

    logger.debug(`Registered route: ${method} ${path}`, { name });

    return { method, path, name, middlewares: middlewares.map(mw => mw.name) };
}

/**
 * Response metadata set by helper methods
 */
interface ResponseMeta
{
    status: ContentfulStatusCode;
    headers: Record<string, string>;
    isEmpty: boolean;
}

/**
 * HTTP methods that never carry a request body
 *
 * A `GET`/`HEAD` request has no body to read, so an interceptor declaration on such a
 * route must not make the request fail on a body that was never sent.
 */
function methodCarriesBody(method: string): boolean
{
    return method !== 'GET' && method !== 'HEAD';
}

/**
 * Create RouteBuilderContext from Hono Context
 *
 * Validates params, query, body, headers, cookies and returns structured input.
 * Helper methods (created, accepted, etc.) return data directly for type inference,
 * while storing response metadata internally for later use.
 */
async function createRouteBuilderContext<TInput extends RouteInput>(
    c: Context,
    input: TInput,
    interceptor?: RouteInput,
): Promise<{ context: RouteBuilderContext<TInput>; responseMeta: ResponseMeta }>
{
    // Validate and extract all input fields
    const params = validateField(input.params, c.req.param(), 'path parameters');
    const query = validateField(input.query, extractQueryParams(c), 'query parameters');
    const headers = validateField(input.headers, extractHeaders(c), 'headers');
    const cookies = validateField(input.cookies, extractCookies(c), 'cookies');

    // Body/FormData requires async parsing - determine by Content-Type
    let body: Record<string, unknown> = {};
    let formData: Record<string, unknown> = {};

    // A `.interceptor({ body })` declaration describes a body a middleware injects into the
    // request, so it has to trigger parsing too — a route that declares its whole body there
    // and no `.input` would otherwise hand the handler an empty body. Interceptor fields stay
    // unvalidated (the middleware owns them), exactly as when they ride along an input body.
    const injected = methodCarriesBody(c.req.method) ? interceptor : undefined;
    const expectsBody = input.body ?? injected?.body;
    const expectsFormData = input.formData ?? injected?.formData;

    if (expectsBody || expectsFormData)
    {
        const contentType = c.req.header('content-type') || '';

        if (contentType.includes('multipart/form-data') && expectsFormData)
        {
            const rawFormData = await parseFormData(c);
            formData = input.formData
                ? validateFormData(input.formData, rawFormData, 'form data')
                : rawFormData;
        }
        else if (expectsBody)
        {
            const rawBody = await parseJsonBody(c);
            body = input.body
                ? validateField(input.body, rawBody, 'request body')
                : rawBody;
        }
    }

    // Cache for data() - avoid creating new object on each call
    let cachedData: any = null;

    // Response metadata - set by helper methods, used when building final Response
    const responseMeta: ResponseMeta = {
        status: 200 as ContentfulStatusCode,
        headers: {},
        isEmpty: false,
    };

    // Create context with structured data()
    const context: RouteBuilderContext<TInput> = {
        data: async () =>
        {
            if (!cachedData)
            {
                cachedData = { params, query, body, formData, headers, cookies };
            }

            return cachedData;
        },

        json: (data, status, resHeaders) =>
        {
            return c.json(data, status, resHeaders);
        },

        created: <T>(data: T, location?: string): T =>
        {
            responseMeta.status = 201 as ContentfulStatusCode;
            if (location)
            {
                responseMeta.headers['Location'] = location;
            }

            return data;
        },

        accepted: <T>(data?: T): any =>
        {
            responseMeta.status = 202 as ContentfulStatusCode;
            if (data === undefined)
            {
                responseMeta.isEmpty = true;

                return undefined;
            }

            return data;
        },

        noContent: (): void =>
        {
            responseMeta.status = 204 as ContentfulStatusCode;
            responseMeta.isEmpty = true;
        },

        notModified: (): void =>
        {
            responseMeta.status = 304 as ContentfulStatusCode;
            responseMeta.isEmpty = true;
        },

        paginated: <T>(data: T[], page: number, limit: number, total: number) =>
        {
            return {
                items: data,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                },
            };
        },

        redirect: (url, status) =>
        {
            return c.redirect(url, status as RedirectStatusCode);
        },

        raw: c,
    };

    return { context, responseMeta };
}
