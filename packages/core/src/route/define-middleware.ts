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
    skips?: string[];  // Server-level middlewares to auto-skip when this middleware is used
};

/**
 * Named middleware factory with type inference
 *
 * Factory function that creates middleware instances with parameters
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
} & ((...args: TArgs) => MiddlewareHandler);

/**
 * Define a named middleware
 *
 * Creates a middleware with a unique name that can be referenced
 * in route-level skip() calls with full type safety.
 *
 * Supports two patterns:
 * 1. Regular middleware: Direct middleware handler
 * 2. Factory middleware: Function that creates middleware with parameters
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
     * Server-level middleware names to auto-skip when this middleware is used at route level.
     *
     * @example
     * ```ts
     * // optionalAuth auto-skips the global 'auth' middleware
     * export const optionalAuth = defineMiddleware('optionalAuth', handler, {
     *     skips: ['auth']
     * });
     *
     * // Usage: .use([optionalAuth]) — no need for .skip(['auth'])
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
        else
        {
            // Create a new wrapper function to avoid "Cannot assign to read only property 'name'" error
            const factory = handlerOrFactory as (...args: TArgs) => MiddlewareHandler;
            const wrapper = (...args: TArgs) => factory(...args);

            // Use Object.defineProperty to set name property (which is read-only by default)
            Object.defineProperty(wrapper, 'name', {
                value: name,
                writable: false,
                enumerable: false,
                configurable: true,
            });

            Object.defineProperty(wrapper, '_name', {
                value: name as TName,
                writable: false,
                enumerable: false,
                configurable: true,
            });

            if (skips)
            {
                Object.defineProperty(wrapper, 'skips', {
                    value: skips,
                    writable: false,
                    enumerable: false,
                    configurable: true,
                });
            }

            return wrapper as NamedMiddlewareFactory<TName, TArgs>;
        }
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
 * @param name - Unique middleware name
 * @param factory - Factory function that returns a middleware handler
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
 * ```
 */
export function defineMiddlewareFactory<TName extends string, TArgs extends unknown[]>(
    name: TName,
    factory: (...args: TArgs) => MiddlewareHandler,
): NamedMiddlewareFactory<TName, TArgs>
{
    const wrapper = (...args: TArgs) => factory(...args);

    Object.defineProperty(wrapper, 'name', {
        value: name,
        writable: false,
        enumerable: false,
        configurable: true,
    });

    Object.defineProperty(wrapper, '_name', {
        value: name as TName,
        writable: false,
        enumerable: false,
        configurable: true,
    });

    return wrapper as NamedMiddlewareFactory<TName, TArgs>;
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
