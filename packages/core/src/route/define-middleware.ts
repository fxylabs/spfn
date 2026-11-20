/**
 * Middleware Definition Helper
 *
 * Provides type-safe middleware definition with name inference
 */

import type { MiddlewareHandler } from 'hono';

/**
 * Named middleware with type inference
 *
 * @example
 * ```ts
 * export const authMiddleware = defineMiddleware('auth', async (c, next) => {
 *   // auth logic
 *   c.set('user', { id: 1 });
 *   await next();
 * });
 *
 * export const rateLimitMiddleware = defineMiddleware('rateLimit', async (c, next) => {
 *   // rate limit logic
 *   await next();
 * });
 * ```
 */
export type NamedMiddleware<TName extends string = string> = {
    name: TName;
    handler: MiddlewareHandler;
    _name: TName;  // Type inference helper
    skips?: string[];  // Inherited middlewares to auto-skip where this middleware is used (route or router .use)
    instance?: true;  // A factory call's result: never merged with another middleware by name, only by reference
};

/**
 * Named middleware factory with type inference
 *
 * Factory function that creates middleware instances with parameters. Each
 * call returns a named middleware carrying the factory's name and `skips`,
 * marked `instance: true`.
 *
 * @example
 * ```ts
 * export const requirePermissions = defineMiddleware('permission',
 *   (...permissions: string[]) => async (c, next) => {
 *     // permission check logic
 *     await next();
 *   }
 * );
 * ```
 */
export type NamedMiddlewareFactory<TName extends string = string, TArgs extends any[] = any[]> = {
    name: TName;
    _name: TName;  // Type inference helper
    skips?: string[];
} & ((...args: TArgs) => NamedMiddleware<TName> & { instance: true });

/**
 * Define a named middleware
 *
 * Creates a middleware with a unique name that can be referenced
 * in route-level skip() calls with full type safety.
 *
 * Supports two patterns:
 * 1. Regular middleware: Direct middleware handler
 * 2. Factory middleware: Function that creates middleware with parameters;
 *    delegated to `defineMiddlewareFactory`, so each call returns a named
 *    middleware with the factory's name and `skips`
 *
 * @param name - Unique middleware name
 * @param handler - Middleware handler function
 * @returns Named middleware with type inference
 *
 * @example
 * ```ts
 * // Regular middleware
 * export const authMiddleware = defineMiddleware('auth', async (c, next) => {
 *   const token = c.req.header('authorization');
 *   if (!token) {
 *     return c.json({ error: 'Unauthorized' }, 401);
 *   }
 *   c.set('user', await verifyToken(token));
 *   await next();
 * });
 *
 * // Factory middleware
 * export const requirePermissions = defineMiddleware('permission',
 *   (...permissions: string[]) => async (c, next) => {
 *     const user = c.get('user');
 *     if (!hasPermissions(user, permissions)) {
 *       return c.json({ error: 'Forbidden' }, 403);
 *     }
 *     await next();
 *   }
 * );
 *
 * // server.config.ts
 * export default defineServerConfig()
 *   .middlewares([authMiddleware])
 *   .routes(appRouter)
 *   .build();
 *
 * // routes.ts - skip by name
 * export const publicRoute = route.get('/status')
 *   .skip(['auth'])  // ✅ Type-safe! Autocomplete!
 *   .handler(async (c) => c.success({ status: 'ok' }));
 *
 * // Use factory middleware inline
 * export const protectedRoute = route.get('/admin')
 *   .use([requirePermissions('admin:write')])
 *   .handler(async (c) => { ... });
 * ```
 */
/**
 * Options for defineMiddleware
 */
export interface DefineMiddlewareOptions
{
    /**
     * Inherited middleware names to remove wherever this middleware is used.
     *
     * In a route's `.use()`, the names are removed from everything the route
     * inherits: the server-level list and every enclosing router's `.use()`.
     * In a router's `.use()`, they are removed from what that router inherits —
     * the server-level list and every enclosing router — for every route below
     * it; a sibling in the same `.use()` and anything a deeper router or the
     * route adds are untouched. The removal holds only while this middleware
     * itself runs on the route: a route that `.skip()`s it gets the skipped
     * middleware back. On the server-level list `skips` remove nothing.
     *
     * A middleware declaring `skips` stands in for what it skips, so declaring
     * it can widen access: router-level `optionalAuth` admits anonymous callers
     * to the whole subtree. Registration refuses one on a router that mounts
     * `.packages()`, or encloses such a mount.
     *
     * A factory keeps `skips` too: every call of a factory made by
     * `defineMiddleware(name, factory, { skips })` or
     * `defineMiddlewareFactory(name, factory, { skips })` returns a named
     * middleware carrying them.
     *
     * @example
     * ```ts
     * // optionalAuth auto-skips the global 'auth' middleware
     * export const optionalAuth = defineMiddleware('optionalAuth', handler, {
     *     skips: ['auth']
     * });
     *
     * // Usage: .use([optionalAuth]) — no need for .skip(['auth'])
     * // On a router: defineRouter({ ... }).use([machineAuth]) — its routes skip 'auth'
     * ```
     */
    skips?: string[];
}

export function defineMiddleware<TName extends string>(
    name: TName,
    handler: MiddlewareHandler,
    options?: DefineMiddlewareOptions,
): NamedMiddleware<TName>;

export function defineMiddleware<TName extends string, TArgs extends any[]>(
    name: TName,
    factory: (...args: TArgs) => MiddlewareHandler,
    options?: DefineMiddlewareOptions,
): NamedMiddlewareFactory<TName, TArgs>;

export function defineMiddleware<TName extends string, TArgs extends any[] = []>(
    name: TName,
    handlerOrFactory: MiddlewareHandler | ((...args: TArgs) => MiddlewareHandler),
    options?: DefineMiddlewareOptions,
): NamedMiddleware<TName> | NamedMiddlewareFactory<TName, TArgs>
{
    const skips = options?.skips;

    // Distinguish between regular middleware and factory by parameter count
    // MiddlewareHandler always has exactly 2 parameters: (c, next)
    // Factory has any other number of parameters
    if (typeof handlerOrFactory === 'function')
    {
        const paramCount = handlerOrFactory.length;

        // Regular middleware handler (c, next) => ...
        if (paramCount === 2)
        {
            return {
                name,
                handler: handlerOrFactory as MiddlewareHandler,
                _name: name as TName,
                ...(skips && { skips }),
            };
        }

        // Factory (...args) => (c, next) => ...
        return defineMiddlewareFactory(name, handlerOrFactory as (...args: TArgs) => MiddlewareHandler, options);
    }

    // Fallback: treat as regular middleware
    return {
        name,
        handler: handlerOrFactory as MiddlewareHandler,
        _name: name as TName,
        ...(skips && { skips }),
    };
}

/**
 * Define a middleware factory explicitly
 *
 * Use this when your factory function has exactly 2 parameters,
 * which would be incorrectly detected as a regular middleware handler.
 *
 * A call returns a named middleware, named after the factory. Every call
 * shares that name: `.skip([name])` removes all of them, `skips` declared on
 * the factory apply to each call, and two calls with different arguments both
 * run. A call's result is never merged with another middleware by name; the
 * same result referenced at two levels runs once. It is not a Hono handler:
 * pass `.handler` where one is expected.
 *
 * @param name - Unique middleware name
 * @param factory - Factory function that returns a middleware handler
 * @param options - `skips` applied to every call
 * @returns Named middleware factory with type inference
 *
 * @example
 * ```ts
 * // Factory with 2 params (would be misdetected by defineMiddleware)
 * export const rateLimiter = defineMiddlewareFactory('rateLimit',
 *   (limit: number, window: number) => async (c, next) => {
 *     // rate limit logic using limit and window
 *     await next();
 *   }
 * );
 *
 * // Usage
 * route.get('/api')
 *   .use([rateLimiter(100, 60000)])  // 100 requests per minute
 *   .handler(...)
 *
 * // Outside the route chain, hand Hono the handler
 * app.use('/raw/*', rateLimiter(100, 60000).handler);
 * ```
 */
export function defineMiddlewareFactory<TName extends string, TArgs extends unknown[]>(
    name: TName,
    factory: (...args: TArgs) => MiddlewareHandler,
    options?: DefineMiddlewareOptions,
): NamedMiddlewareFactory<TName, TArgs>
{
    const skips = options?.skips;
    const create = (...args: TArgs) => ({
        name,
        _name: name,
        handler: factory(...args),
        ...(skips && { skips }),
        instance: true as const,
    });

    // `name` is read-only on a function, so it is redefined rather than assigned
    return Object.defineProperties(create, {
        name: { value: name, configurable: true },
        _name: { value: name, configurable: true },
        ...(skips && { skips: { value: skips, configurable: true } }),
    }) as NamedMiddlewareFactory<TName, TArgs>;
}

/**
 * Extract middleware names from an array of named middlewares
 *
 * @example
 * ```ts
 * type Middlewares = [
 *   NamedMiddleware<'auth'>,
 *   NamedMiddleware<'rateLimit'>
 * ];
 * type Names = ExtractMiddlewareNames<Middlewares>;  // 'auth' | 'rateLimit'
 * ```
 */
export type ExtractMiddlewareNames<T extends readonly NamedMiddleware<string>[]> =
    T[number]['_name'];
