/**
 * Route Builder
 *
 * Provides tRPC-style chainable API for route definition
 */

import type { MiddlewareHandler } from 'hono';
import type { NamedMiddleware } from './define-middleware';
import type { RouteInput } from './route-input';
import type { RouteBuilderContext } from './context';
import type { RouteContract } from './contract';
import type { HttpMethod, RouteEffect } from './types';

/**
 * Route handler function
 */
export type RouteHandlerFn<
    TInput extends RouteInput = RouteInput,
    TInterceptor extends RouteInput = {},
    TResponse = unknown,
> = (c: RouteBuilderContext<TInput, TInterceptor>) => Response | Promise<Response> | TResponse | Promise<TResponse>;

/**
 * Route definition result
 *
 * Contains all information needed for type inference and registration
 */
export type RouteDef<
    TInput extends RouteInput = RouteInput,
    TInterceptor extends RouteInput = {},
    TResponse = unknown,
> = {
    method?: HttpMethod;
    path?: string;
    input?: TInput;
    interceptor?: TInterceptor;
    middlewares?: (MiddlewareHandler | NamedMiddleware<string>)[];
    skipMiddlewares?: string[] | '*';

    /**
     * Public promise this route makes to separately deployed clients.
     *
     * Present as a runtime value, unlike `_response`: the contract generator and
     * the compatibility gate read it.
     */
    contract?: RouteContract;

    /**
     * What invoking this route does. Read by a command surface, which
     * announces it in its manifest; codegen and the contract ignore it.
     */
    effect?: RouteEffect;

    /** One line a command surface announces beside the route; codegen and the contract ignore it. */
    summary?: string;

    handler: RouteHandlerFn<TInput, TInterceptor, TResponse>;

    // Type inference helpers
    _input: TInput;
    _interceptor: TInterceptor;
    _response: TResponse;
};

/**
 * Route builder with chainable API (tRPC-style)
 */
export class RouteBuilder<
    TInput extends RouteInput = {},
    TInterceptor extends RouteInput = {},
    TResponse = never,
>
{
    public _method?: HttpMethod;
    public _path?: string;
    public _input?: TInput;
    public _interceptor?: TInterceptor;
    public _middlewares?: (MiddlewareHandler | NamedMiddleware<string>)[];
    public _skipMiddlewares?: string[] | '*';
    public _contract?: RouteContract;
    public _effect?: RouteEffect;
    public _summary?: string;

    /**
     * Create a new RouteBuilder with copied properties and optional overrides
     */
    private clone<
        TNewInput extends RouteInput = TInput,
        TNewInterceptor extends RouteInput = TInterceptor,
    >(
        overrides?: Partial<{
            input: TNewInput;
            interceptor: TNewInterceptor;
            middlewares: (MiddlewareHandler | NamedMiddleware<string>)[];
            skipMiddlewares: string[] | '*';
            contract: RouteContract;
            effect: RouteEffect;
            summary: string;
        }>,
    ): RouteBuilder<TNewInput, TNewInterceptor, TResponse>
    {
        const builder = new RouteBuilder<TNewInput, TNewInterceptor, TResponse>();
        builder._method = this._method;
        builder._path = this._path;
        builder._input = (overrides?.input ?? this._input) as TNewInput | undefined;
        builder._interceptor = (overrides?.interceptor ?? this._interceptor) as TNewInterceptor | undefined;
        builder._middlewares = overrides?.middlewares ?? this._middlewares;
        builder._skipMiddlewares = overrides?.skipMiddlewares ?? this._skipMiddlewares;
        builder._contract = overrides?.contract ?? this._contract;
        builder._effect = overrides?.effect ?? this._effect;
        builder._summary = overrides?.summary ?? this._summary;

        return builder;
    }

    /**
     * Define input schemas
     *
     * @example
     * ```ts
     * route.get('/users/:id')
     *   .input({
     *     params: Type.Object({ id: Type.String() }),
     *     query: Type.Object({ page: Type.Number() }),
     *     headers: Type.Object({ authorization: Type.String() })
     *   })
     *   .handler(async (c) => {
     *     const { params, query, headers } = await c.data();
     *     // params = { id: string }
     *     // query = { page: number }
     *     // headers = { authorization: string }
     *   })
     * ```
     */
    input<TNewInput extends RouteInput>(input: TNewInput): RouteBuilder<TNewInput, TInterceptor, TResponse>
    {
        return this.clone({ input });
    }

    /**
     * Define fields injected by interceptors
     *
     * These fields are:
     * - Available in the handler (merged with input)
     * - Excluded from client types (codegen uses only input)
     * - Not validated by route input schema (injected by middleware)
     *
     * Use this when middleware/interceptors add fields to the request
     * before it reaches the handler.
     *
     * @example
     * ```ts
     * // Auth interceptor injects crypto key fields
     * route.post('/_auth/login')
     *   .input({
     *     body: Type.Object({
     *       email: Type.String(),
     *       password: Type.String()
     *     })
     *   })
     *   .interceptor({
     *     body: Type.Object({
     *       publicKey: Type.String(),
     *       keyId: Type.String(),
     *       fingerprint: Type.String()
     *     })
     *   })
     *   .handler(async (c) => {
     *     const { body } = await c.data();
     *     // body type: { email, password, publicKey, keyId, fingerprint }
     *     // Client only sees: { email, password }
     *     return loginService(body);
     *   });
     * ```
     */
    interceptor<TNewInterceptor extends RouteInput>(
        interceptor: TNewInterceptor,
    ): RouteBuilder<TInput, TNewInterceptor, TResponse>
    {
        return this.clone({ interceptor });
    }

    /**
     * Add middlewares to the route
     *
     * Accepts both regular middleware handlers and named middlewares (NamedMiddleware).
     * Named middlewares that are already registered globally will be automatically
     * deduplicated to prevent double execution.
     *
     * @example
     * ```ts
     * import { authenticate } from '@spfn/auth/server/middleware';
     *
     * // With NamedMiddleware (auto-deduped if registered globally)
     * route.get('/users')
     *   .use([authenticate, RateLimitMiddleware()])
     *
     * // With regular middleware handlers
     * route.get('/users')
     *   .use([AuthMiddleware(), RateLimitMiddleware()])
     * ```
     */
    middleware(middlewares: (MiddlewareHandler | NamedMiddleware<string>)[]): RouteBuilder<TInput, TInterceptor, TResponse>
    {
        return this.clone({ middlewares });
    }

    /**
     * Add middlewares to the route (alias for `.middleware()`)
     *
     * Accepts both regular middleware handlers and named middlewares (NamedMiddleware).
     * Named middlewares that are already registered globally will be automatically
     * deduplicated to prevent double execution.
     *
     * @example
     * ```ts
     * import { authenticate } from '@spfn/auth/server/middleware';
     *
     * // With NamedMiddleware (auto-deduped if registered globally)
     * route.get('/users')
     *   .use([authenticate, RateLimitMiddleware()])
     *
     * // With regular middleware handlers
     * route.get('/users')
     *   .use([AuthMiddleware(), RateLimitMiddleware()])
     * ```
     */
    use(middlewares: (MiddlewareHandler | NamedMiddleware<string>)[]): RouteBuilder<TInput, TInterceptor, TResponse>
    {
        return this.middleware(middlewares);
    }

    /**
     * Skip server-level named middlewares
     *
     * Useful for public endpoints that should bypass auth or rate limiting
     *
     * @param middlewareNames - Array of middleware names to skip, or '*' to skip all
     *
     * @example
     * ```ts
     * // Skip specific middlewares
     * route.get('/status')
     *   .skip(['auth', 'rateLimit'])
     *   .handler(async (c) => c.json({ status: 'ok' }));
     *
     * // Skip only auth (still apply rate limiting)
     * route.get('/public-data')
     *   .skip(['auth'])
     *   .handler(async (c) => { ... });
     *
     * // Skip all middlewares
     * route.get('/public-health')
     *   .skip('*')
     *   .handler(async (c) => c.json({ status: 'ok' }));
     * ```
     */
    skip(middlewareNames: string[] | '*'): RouteBuilder<TInput, TInterceptor, TResponse>
    {
        return this.clone({ skipMiddlewares: middlewareNames });
    }

    /**
     * Publish this route as a versioned contract operation
     *
     * Marks the route as a promise to clients that are compiled and deployed
     * separately from the server — a mobile app, an external API consumer.
     * The `@spfn/core:contract` generator writes every contracted route into
     * `contracts/current.json`, and the build refuses a change that would break
     * an already-released client.
     *
     * Routes without `.contract()` are unaffected: they simply do not appear in
     * the contract. A web client needs nothing here — it derives its types from
     * the router in the same build.
     *
     * @example
     * ```ts
     * export const getUser = route.get('/users/:id')
     *   .input({ params: Type.Object({ id: Type.String() }) })
     *   .contract({
     *     since: '1.2.0',
     *     auth: 'clientProofV1',
     *     requiresSession: true,
     *     response: Type.Object({
     *       id: Type.String(),
     *       name: Type.String(),
     *       email: Type.Optional(Type.String()),
     *     }),
     *   })
     *   .handler(async (c) => { ... });
     * ```
     */
    contract(contract: RouteContract): RouteBuilder<TInput, TInterceptor, TResponse>
    {
        return this.clone({ contract });
    }

    /**
     * Declare what invoking this route does
     *
     * Read by a command surface (`@spfn/core/surface`, `@spfn/core/ops`),
     * which announces it in its manifest so a machine caller can tell a read
     * from a write before it calls — `spfn ops call` asks for `--yes` before a
     * `destructive` command. A surface built with `defineSurface` refuses an
     * app command that does not declare one; on `/_ops` it is optional.
     *
     * Nothing else reads it: codegen, the route map, and the contract are
     * unaffected, and a route outside any surface simply carries it.
     *
     * @example
     * ```ts
     * export const pageAdd = app.route.post('/pages')
     *   .input({ body: PageAddBody })
     *   .effect('write')
     *   .summary('Add a page to the blueprint')
     *   .handler(async (c) => { ... });
     * ```
     */
    effect(effect: RouteEffect): RouteBuilder<TInput, TInterceptor, TResponse>
    {
        return this.clone({ effect });
    }

    /**
     * Describe this route in one line for a command surface's manifest
     *
     * A surface announces it beside the command in `spfn ops list` and
     * `--describe`, and refuses one that is empty or longer than 500
     * characters. Codegen, the route map, and the contract ignore it. On a
     * module command the module's own summary wins.
     *
     * @example
     * ```ts
     * export const pageAdd = app.route.post('/pages')
     *   .effect('write')
     *   .summary('Add a page to the blueprint')
     *   .handler(async (c) => { ... });
     * ```
     */
    summary(summary: string): RouteBuilder<TInput, TInterceptor, TResponse>
    {
        return this.clone({ summary });
    }

    /**
     * Define handler function
     *
     * Response type is automatically inferred from the return value.
     * Use helper methods like `c.created()`, `c.paginated()` for proper type inference.
     *
     * @example
     * ```ts
     * // Direct return - type inferred from data
     * route.get('/users/:id')
     *   .input({ params: Type.Object({ id: Type.String() }) })
     *   .handler(async (c) => {
     *     const { params } = await c.data();
     *     return await getUser(params.id); // Type: User
     *   })
     *
     * // Using c.created() - returns data with 201 status, type preserved
     * route.post('/users')
     *   .input({ body: Type.Object({ name: Type.String() }) })
     *   .handler(async (c) => {
     *     const { body } = await c.data();
     *     return c.created(await createUser(body)); // Type: User
     *   })
     *
     * // Using c.paginated() - returns PaginatedResult<T>
     * route.get('/users')
     *   .handler(async (c) => {
     *     const users = await getUsers();
     *     return c.paginated(users, 1, 20, 100); // Type: PaginatedResult<User>
     *   })
     *
     * // Using c.noContent() - returns void
     * route.delete('/users/:id')
     *   .handler(async (c) => {
     *     await deleteUser(params.id);
     *     return c.noContent(); // Type: void
     *   })
     *
     * // Using c.json() - returns Response (type inference lost)
     * // Use only when you need custom status codes not covered by helpers
     * route.get('/custom')
     *   .handler(async (c) => {
     *     return c.json({ data }, 418); // Type: Response
     *   })
     * ```
     */
    handler<THandlerResponse>(
        fn: RouteHandlerFn<TInput, TInterceptor, THandlerResponse>,
    ): RouteDef<TInput, TInterceptor, THandlerResponse>
    {
        return {
            method: this._method,
            path: this._path,
            input: this._input,
            interceptor: this._interceptor,
            middlewares: this._middlewares,
            skipMiddlewares: this._skipMiddlewares,
            contract: this._contract,
            ...(this._effect !== undefined ? { effect: this._effect } : {}),
            ...(this._summary !== undefined ? { summary: this._summary } : {}),
            handler: fn,
            _input: {} as TInput,
            _interceptor: {} as TInterceptor,
            _response: {} as THandlerResponse,
        };
    }
}

/**
 * Create a route definition with HTTP method shortcuts
 */
function createMethodRoute(method: HttpMethod): (path: string) => RouteBuilder
{
    return (path: string) =>
    {
        const builder = new RouteBuilder();
        builder._method = method;
        builder._path = path;

        return builder;
    };
}

/**
 * Route builder entry point
 *
 * @example
 * ```ts
 * // GET request
 * export const getUser = route.get('/users/:id')
 *   .input({ params: Type.Object({ id: Type.String() }) })
 *   .handler(async (c) => {
 *     const { params } = await c.data();
 *     return await db.user.findUnique({ where: { id: params.id } });
 *   });
 *
 * // POST request
 * export const createUser = route.post('/users')
 *   .input({ body: Type.Object({ name: Type.String(), email: Type.String() }) })
 *   .handler(async (c) => {
 *     const { body } = await c.data();
 *     return c.created(await db.user.create({ data: body }));
 *   });
 * ```
 */
export const route = {
    get: createMethodRoute('GET'),
    post: createMethodRoute('POST'),
    put: createMethodRoute('PUT'),
    patch: createMethodRoute('PATCH'),
    delete: createMethodRoute('DELETE'),
};
