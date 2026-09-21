// ============================================================================
// Route Call Builder (Structured Input API)
// ============================================================================

import type { RouteDef, Router } from '@spfn/core/route';
import type {
    CallOptions,
    ExtractRoutes,
    InferRouteInput,
    InferRouteOutput,
    RequestInterceptor,
    ResponseInterceptor,
} from './types';

/**
 * Pick only non-empty fields from StructuredInput
 *
 * This removes fields that are empty objects `{}` from the input type,
 * so users only need to provide fields that are actually defined in the route.
 */
type PickNonEmpty<T> = {
    [K in keyof T as T[K] extends Record<string, never> ? never : K]: T[K];
};

/**
 * Make fields that can be undefined into optional fields
 *
 * When a field is defined as `Type.Optional(Type.Object({...}))`,
 * the resulting type is `T | undefined`. This utility converts such fields
 * into proper optional fields (`field?: T`) so users don't need to pass them.
 */
type MakeOptionalIfUndefinable<T> =
    // Required fields (undefined is not assignable)
    { [K in keyof T as undefined extends T[K] ? never : K]: T[K] }
    // Optional fields (undefined is assignable)
    & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };

/**
 * Clean structured input - only include fields that have actual schema,
 * and make fields optional if they accept undefined
 */
type CleanStructuredInput<TInput> = MakeOptionalIfUndefinable<PickNonEmpty<TInput>>;

/**
 * Check if input has any required fields
 *
 * Returns false if all fields are optional (i.e., {} is assignable to the input type)
 */
type HasAnyRequiredFields<TInput> = {} extends CleanStructuredInput<TInput> ? false : true;

/**
 * Route call builder with structured input API
 *
 * Input is structured with explicit params, query, body fields
 * that match the server-side route definition.
 *
 * @example
 * ```typescript
 * // GET /users/:id - params only
 * const user = await api.getUser.call({ params: { id: '1' } });
 *
 * // GET /users/:id?include=posts - params + query
 * const user = await api.getUser.call({
 *     params: { id: '1' },
 *     query: { include: 'posts' }
 * });
 *
 * // POST /users - body only
 * const user = await api.createUser.call({
 *     body: { name: 'John', email: 'john@example.com' }
 * });
 *
 * // PUT /users/:id - params + body
 * const user = await api.updateUser.call({
 *     params: { id: '1' },
 *     body: { name: 'Jane' }
 * });
 *
 * // With options (headers, cookies, Next.js caching)
 * const user = await api.getUser
 *     .headers({ 'X-Custom': 'value' })
 *     .fetchOptions({ next: { revalidate: 60 } })
 *     .call({ params: { id: '1' } });
 * ```
 */
export class RouteCallBuilder<
    TInput,
    TOutput,
>
{
    private _headers?: Record<string, string>;
    private _cookies?: Record<string, string>;
    private _fetchOptions?: RequestInit;
    private _onRequest?: RequestInterceptor;
    private _onResponse?: ResponseInterceptor;

    constructor(
        private readonly executor: (input: any, options: CallOptions) => Promise<TOutput>,
        private readonly routeName: string,
    ) 
    {}

    /**
     * Clone builder
     */
    private clone(): RouteCallBuilder<TInput, TOutput>
    {
        const builder = new RouteCallBuilder<TInput, TOutput>(
            this.executor,
            this.routeName,
        );
        builder._headers = this._headers;
        builder._cookies = this._cookies;
        builder._fetchOptions = this._fetchOptions;
        builder._onRequest = this._onRequest;
        builder._onResponse = this._onResponse;

        return builder;
    }

    /**
     * Set request headers
     */
    headers(headers: Record<string, string>): RouteCallBuilder<TInput, TOutput>
    {
        const builder = this.clone();
        builder._headers = { ...this._headers, ...headers };

        return builder;
    }

    /**
     * Set cookies
     */
    cookies(cookies: Record<string, string>): RouteCallBuilder<TInput, TOutput>
    {
        const builder = this.clone();
        builder._cookies = { ...this._cookies, ...cookies };

        return builder;
    }

    /**
     * Set Next.js fetch options
     */
    fetchOptions(options: RequestInit & { next?: { revalidate?: number | false; tags?: string[] } }): RouteCallBuilder<TInput, TOutput>
    {
        const builder = this.clone();
        builder._fetchOptions = { ...this._fetchOptions, ...options };

        return builder;
    }

    /**
     * Set request interceptor
     */
    onRequest(interceptor: RequestInterceptor): RouteCallBuilder<TInput, TOutput>
    {
        const builder = this.clone();
        builder._onRequest = interceptor;

        return builder;
    }

    /**
     * Set response interceptor
     */
    onResponse(interceptor: ResponseInterceptor): RouteCallBuilder<TInput, TOutput>
    {
        const builder = this.clone();
        builder._onResponse = interceptor;

        return builder;
    }

    /**
     * Execute the API call with structured input
     *
     * Input structure matches the server-side route definition:
     * - params: Path parameters (e.g., { id: '123' } for /users/:id)
     * - query: Query string parameters
     * - body: Request body (for POST, PUT, PATCH)
     */
    call(input?: CleanStructuredInput<TInput>): Promise<TOutput>
    {
        const options: CallOptions = {};

        if (this._headers)
        {
            options.headers = this._headers;
        }

        if (this._cookies)
        {
            options.cookies = this._cookies;
        }

        if (this._fetchOptions)
        {
            options.fetchOptions = this._fetchOptions;
        }

        if (this._onRequest)
        {
            options.onRequest = this._onRequest;
        }

        if (this._onResponse)
        {
            options.onResponse = this._onResponse;
        }

        return this.executor(input || {}, options);
    }
}

/**
 * Individual route client with structured input API
 */
export type RouteClient<TRoute extends RouteDef<any, any>> = {
    /**
     * Set request headers
     */
    headers(headers: Record<string, string>): RouteClient<TRoute>;

    /**
     * Set cookies
     */
    cookies(cookies: Record<string, string>): RouteClient<TRoute>;

    /**
     * Set Next.js fetch options
     */
    fetchOptions(options: RequestInit & { next?: { revalidate?: number | false; tags?: string[] } }): RouteClient<TRoute>;

    /**
     * Set request interceptor
     */
    onRequest(interceptor: RequestInterceptor): RouteClient<TRoute>;

    /**
     * Set response interceptor
     */
    onResponse(interceptor: ResponseInterceptor): RouteClient<TRoute>;

    /**
     * Execute the API call with structured input
     *
     * @example
     * ```typescript
     * // GET /users/:id
     * api.getUser.call({ params: { id: '123' } });
     *
     * // PUT /users/:id
     * api.updateUser.call({ params: { id: '123' }, body: { name: 'Jane' } });
     * ```
     */
    call: HasAnyRequiredFields<InferRouteInput<TRoute>> extends true
        ? (input: CleanStructuredInput<InferRouteInput<TRoute>>) => Promise<InferRouteOutput<TRoute>>
        : (input?: CleanStructuredInput<InferRouteInput<TRoute>>) => Promise<InferRouteOutput<TRoute>>;
};

/**
 * One property per route in a flattened route record.
 *
 * A slot the flattening could not resolve to a route definition is `never`, as it was
 * before nesting was flattened — a record whose values are neither routes nor routers
 * names nothing callable.
 */
type RouteClients<TRoutes> = {
    [K in keyof TRoutes]: TRoutes[K] extends RouteDef<any, any, any>
        ? RouteClient<TRoutes[K]>
        : never;
};

/**
 * Typed client for entire router
 *
 * One flat namespace, holding the same route names the server registers. A route
 * declared inside a nested `defineRouter` is reached by its own key — `api.getThing`,
 * never `api.group.getThing` — because that is the name `registerRoutes` mounts it
 * under, the name the RPC proxy resolves, and the name `RouterOutput` takes. The group
 * key is not a route and naming it is a compile error.
 *
 * @example
 * ```typescript
 * const appRouter = defineRouter({
 *     getRoot,
 *     users: defineRouter({ getUser }),
 * });
 *
 * const api = createApi<typeof appRouter>();
 *
 * await api.getUser.call({ params: { id: '1' } });   // not api.users.getUser
 * ```
 *
 * A name two branches both declare is left out of the namespace rather than resolved to
 * one of them — the same collision `RouterOutput` refuses. Routes mounted with
 * `.packages()` are deliberately absent: a package publishes its own route map and its
 * own client (`authApi`, `cmsApi`), and that is what calls them.
 */
export type Client<TRouter extends Router<any>> = RouteClients<ExtractRoutes<TRouter>>;
