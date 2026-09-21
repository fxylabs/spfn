// ============================================================================
// Type Utilities
// ============================================================================

import type { Static, TSchema } from '@sinclair/typebox';
import type { ErrorRegistry, ErrorRegistryInput } from '@spfn/core/errors';
import type { RouteDef, RouteInput } from '@spfn/core/route';

/**
 * Convert File types in schema to actual File for client usage
 *
 * TypeBox File schemas become actual File objects on the client side.
 */
type ConvertFileTypes<T> = T extends File ? File : T extends File[] ? File[] : T;

/**
 * Extract form data input type with File support
 *
 * Maps schema types to runtime types, converting FileSchema to File.
 */
type FormDataInput<T> = {
    [K in keyof T]: ConvertFileTypes<T[K]>;
};

/**
 * Extract structured input from RouteInput
 *
 * Converts TypeBox schemas to their static types for each input field.
 */
export type StructuredInput<TInput extends RouteInput> = {
    params: TInput['params'] extends TSchema ? Static<TInput['params']> : {};
    query: TInput['query'] extends TSchema ? Static<TInput['query']> : {};
    body: TInput['body'] extends TSchema ? Static<TInput['body']> : {};
    formData: TInput['formData'] extends TSchema ? FormDataInput<Static<TInput['formData']>> : {};
    headers: TInput['headers'] extends TSchema ? Static<TInput['headers']> : {};
    cookies: TInput['cookies'] extends TSchema ? Static<TInput['cookies']> : {};
};

/**
 * Infer route input type from RouteDef
 *
 * @example
 * ```typescript
 * // Server route definition
 * const getUser = route.get('/users/:id')
 *   .input({ params: Type.Object({ id: Type.String() }) })
 *   .handler(...);
 *
 * // Client: extract input type
 * type Input = InferRouteInput<typeof getUser>;
 * // { params: { id: string }, query: {}, body: {}, ... }
 * ```
 */
export type InferRouteInput<TRoute> =
    TRoute extends RouteDef<infer TInput, any, any>
        ? StructuredInput<TInput>
        : never;

/**
 * Infer route output type from RouteDef
 *
 * @example
 * ```typescript
 * // Server route definition
 * const getUser = route.get('/users/:id')
 *   .handler(async (c) => {
 *     return { id: '1', name: 'John' };
 *   });
 *
 * // Client: extract output type
 * type Output = InferRouteOutput<typeof getUser>;
 * // { id: string, name: string }
 * ```
 */
export type InferRouteOutput<TRoute> =
    TRoute extends RouteDef<any, any, infer TResponse>
        ? TResponse
        : never;

// ============================================================================
// Router Type Utilities
// ============================================================================

/**
 * True only for `any`.
 *
 * `any` satisfies both branches of a conditional type, so a router whose routes are
 * unresolved (`Router<any>`) would otherwise flatten into "every name exists" and
 * accept a misspelled route name. A route record that is not known contributes no
 * names instead.
 */
type IsAny<T> = 0 extends (1 & T) ? true : false;

/**
 * True when `T` is a union of two or more members.
 */
type IsUnion<T, TCopy = T> = T extends unknown ? ([TCopy] extends [T] ? false : true) : false;

/**
 * One leaf of a router tree: the name a route is registered under, its definition, and
 * the path it was reached by.
 *
 * A route is identified by its own key whatever depth it sits at — `registerRoutes`
 * mounts a nested route under that key, and the contract collector reports a collision
 * on it. Nesting groups the source; it does not qualify the name. The trail is carried
 * so that one name reached through two branches stays two leaves.
 */
interface RouteLeaf<TName extends PropertyKey, TDef, TTrail extends PropertyKey[]>
{
    name: TName;
    def: TDef;
    trail: TTrail;
}

/** Decrements the nesting budget; `PrevDepth[0]` is `never`, which ends the walk. */
type PrevDepth = [never, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/**
 * How many levels of nesting are followed.
 *
 * A budget rather than open recursion: a router type that refers to itself would
 * otherwise never terminate, and TypeScript would report an instantiation-depth error
 * in whichever component happened to read a route type. A route below the budget is not
 * visible to these types; ten levels is far past any hand-written tree.
 */
type MaxNesting = 10;

/**
 * Collect every route in a route record as a leaf, descending into nested routers
 * exactly as `registerRoutes` does.
 */
type RouteLeaves<TRoutes, TTrail extends PropertyKey[] = [], TDepth extends number = MaxNesting> =
    [TDepth] extends [never]
        ? never
        : IsAny<TRoutes> extends true
            ? never
            : {
                [K in keyof TRoutes]-?: RouteLeafOf<K, Exclude<TRoutes[K], undefined>, [...TTrail, K], TDepth>;
            }[keyof TRoutes];

/**
 * A nested router contributes its own leaves; anything else is a leaf.
 *
 * `{ _routes: ... }` is the runtime's own test for a router (`isRouter`), and a
 * `RouteDef` carries `handler`, `_input` and `_response` but never `_routes`, so a
 * route cannot be mistaken for a router.
 */
type RouteLeafOf<TName extends PropertyKey, TValue, TTrail extends PropertyKey[], TDepth extends number> =
    TValue extends { _routes: infer TNested }
        ? RouteLeaves<TNested, TTrail, PrevDepth[TDepth]>
        : RouteLeaf<TName, TValue, TTrail>;

/** Every name the tree declares. */
type LeafNames<TLeaves> =
    Extract<TLeaves extends RouteLeaf<infer TName, any, any> ? TName : never, PropertyKey>;

/**
 * The leaves declaring exactly this name.
 *
 * Exactly, not assignably: a record typed `Record<string, RouteDef>` contributes the
 * name `string`, which every literal name is assignable to, and a loose sibling must
 * not make each of its siblings look doubly declared.
 */
type LeavesNamed<TLeaves, TName extends PropertyKey> =
    TLeaves extends RouteLeaf<infer TLeafName, any, any>
        ? [TLeafName] extends [TName]
            ? [TName] extends [TLeafName] ? TLeaves : never
            : never
        : never;

/** The definition a leaf carries. */
type LeafDef<TLeaves> = TLeaves extends RouteLeaf<any, infer TDef, any> ? TDef : never;

/** Where a leaf was found — one distinct trail per place the name is declared. */
type LeafTrail<TLeaves> = TLeaves extends RouteLeaf<any, any, infer TTrail> ? TTrail : never;

/**
 * Flatten the leaves into one namespace of name → definition.
 *
 * A name that two branches both declare is left out rather than resolved to one of
 * them: the tree gives it no single meaning, and picking a winner silently would hand
 * a component another route's types. Naming it then fails the `K` constraint on
 * `RouterOutput`/`RouterInput`, on the line that named it. Two places is counted by
 * trail, so one slot holding a union of route definitions stays one route and still
 * infers the union.
 *
 * The result is a fresh mapped type, so no key carries an optional or readonly modifier
 * out of the source record — a route key that turned optional would change what
 * `InferRouteInput` returns for it.
 */
type FlattenLeaves<TLeaves> = {
    [TName in LeafNames<TLeaves> as UnambiguousName<TLeaves, TName>]: LeafDef<LeavesNamed<TLeaves, TName>>;
};

/** The name itself when one place declares it, and nothing when two do. */
type UnambiguousName<TLeaves, TName extends PropertyKey> =
    IsUnion<LeafTrail<LeavesNamed<TLeaves, TName>>> extends true ? never : TName;

/**
 * Extract routes from Router type
 *
 * `Router<TRoutes>` holds its routes in `_routes`, and a value in that record is either
 * a route or another router. Nested routers are flattened away, so every route appears
 * here under its own name at one level — the same set of names the server registers.
 */
type ExtractRoutes<TRouter> =
    TRouter extends { _routes: infer TRoutes }
        ? FlattenLeaves<RouteLeaves<TRoutes>>
        : FlattenLeaves<RouteLeaves<TRouter>>;

/**
 * Extract output type for a specific route from router
 *
 * @example
 * ```typescript
 * import type { RouterOutput } from '@spfn/core/nextjs';
 * import type { AppRouter } from '@/server/router';
 *
 * // Get output type for a specific route
 * type ListData = RouterOutput<AppRouter, 'listExamples'>;
 *
 * // Use in props
 * interface Props {
 *     data: RouterOutput<AppRouter, 'listExamples'>;
 * }
 *
 * // Extract item type from paginated response
 * type Example = RouterOutput<AppRouter, 'listExamples'>['items'][number];
 * ```
 *
 * A route declared inside a nested router is named the same way. The server registers
 * a nested route under its own key, so `K` is the flat set of route names in the tree
 * and the depth the route was declared at never appears here:
 *
 * ```typescript
 * const appRouter = defineRouter({
 *     getRoot,
 *     examples: defineRouter({ listExamples, createExample }),
 * });
 *
 * type ListData = RouterOutput<typeof appRouter, 'listExamples'>;
 * ```
 *
 * Two branches declaring the same name make that name ambiguous, and it is left out of
 * `K` rather than resolved to one of them — naming it is a compile error here instead
 * of the wrong route's types reaching a component.
 */
export type RouterOutput<TRouter, K extends keyof ExtractRoutes<TRouter>> =
    InferRouteOutput<ExtractRoutes<TRouter>[K]>;

/**
 * Extract input type for a specific route from router
 *
 * @example
 * ```typescript
 * import type { RouterInput } from '@spfn/core/nextjs';
 * import type { AppRouter } from '@/server/router';
 *
 * // Get input type for a specific route
 * type CreateInput = RouterInput<AppRouter, 'createExample'>;
 *
 * // Use in function parameter
 * function submitForm(data: RouterInput<AppRouter, 'createExample'>['body']) {
 *     // ...
 * }
 * ```
 *
 * `K` is the flat set of route names, so a route declared inside a nested router is
 * named by its own key here too — see {@link RouterOutput}.
 */
export type RouterInput<TRouter, K extends keyof ExtractRoutes<TRouter>> =
    InferRouteInput<ExtractRoutes<TRouter>[K]>;

/**
 * Cookie options for setCookie
 */
export interface CookieOptions
{
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'strict' | 'lax' | 'none';
    maxAge?: number;
    path?: string;
    domain?: string;
}

/**
 * Cookie to set in response
 */
export interface SetCookie
{
    name: string;
    value: string;
    options?: CookieOptions;
}

// ============================================================================
// Client Configuration
// ============================================================================

/**
 * Request interceptor - called before fetch
 */
export type RequestInterceptor = (
    url: string,
    init: RequestInit,
) => Promise<RequestInit> | RequestInit;

/**
 * Response interceptor - called after fetch
 */
export type ResponseInterceptor = (
    response: Response,
    body: any,
) => Promise<{ response: Response; body: any }> | { response: Response; body: any };

/**
 * Client configuration
 */
export interface ApiConfig {
    /**
     * Base URL for RPC endpoint
     *
     * @default '/api/rpc'
     * @example '/api/rpc', 'http://localhost:3000/api/rpc'
     */
    baseUrl?: string;

    /**
     * Default headers for all requests
     */
    headers?: Record<string, string>;

    /**
     * Request timeout in milliseconds
     *
     * @default env.SERVER_TIMEOUT (120000)
     */
    timeout?: number;

    /**
     * Custom fetch implementation
     */
    fetch?: typeof fetch;

    /**
     * Global request interceptor
     */
    onRequest?: RequestInterceptor;

    /**
     * Global response interceptor
     */
    onResponse?: ResponseInterceptor;

    /**
     * Custom error registry for deserialization
     *
     * Core HTTP errors are automatically registered. Use this to add your custom application errors.
     *
     * @example
     * ```typescript
     * import { errorRegistry } from '@spfn/core/errors';
     * import { authErrorRegistry } from '@myapp/auth/errors';
     * import { PaymentFailedError } from '@/server/errors';
     *
     * const api = createApi<AppRouter>({
     *   errorRegistry: [errorRegistry, authErrorRegistry, PaymentFailedError]
     * });
     * ```
     */
    errorRegistry?: ErrorRegistry | ErrorRegistryInput[];

    /**
     * Enable debug logging
     *
     * @default false
     */
    debug?: boolean;
}

/**
 * Per-call options
 */
export interface CallOptions {
    /**
     * Request timeout in milliseconds
     * Overrides the global timeout set in ApiConfig
     */
    timeout?: number;

    /**
     * Additional headers for this request
     */
    headers?: Record<string, string>;

    /**
     * Override cookies for this request
     *
     * Note: Cookies are automatically forwarded by the proxy.
     * Use this only when you need to override them.
     */
    cookies?: Record<string, string>;

    /**
     * Request-specific interceptor
     */
    onRequest?: RequestInterceptor;

    /**
     * Response-specific interceptor
     */
    onResponse?: ResponseInterceptor;

    /**
     * Next.js-specific fetch options
     *
     * @example
     * // Time-based revalidation
     * { next: { revalidate: 60 } }
     *
     * // Disable cache
     * { cache: 'no-store' }
     *
     * // Tag-based revalidation
     * { next: { tags: ['users'] } }
     */
    fetchOptions?: RequestInit & {
        next?: {
            revalidate?: number | false;
            tags?: string[];
        };
    };
}
