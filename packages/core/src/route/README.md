# @spfn/core/route — Type-safe route DSL + router composition

A tRPC-style chainable DSL for defining HTTP routes with TypeBox-validated input,
end-to-end type inference into the handler, and composable routers. This is the core of
SPFN: routes defined here are registered onto Hono and consumed by the typed RPC client.

## Import paths

Everything is exported from a single entry point.

```typescript
import {
    route,            // route builder entry (get/post/put/patch/delete)
    defineRouter,     // compose routes into a router
    registerRoutes,   // mount a router onto a Hono app (usually called by @spfn/core/server)
    defineMiddleware, // named middleware (skippable by name)
    defineMiddlewareFactory,
    Nullable, OptionalNullable, isHttpMethod,
    FileSchema, FileArraySchema, OptionalFileSchema,
} from '@spfn/core/route';

import { Type } from '@sinclair/typebox'; // schemas come from TypeBox, not from this package
```

There is **no** `@spfn/core/route/*` sub-path. Import the schema builder `Type` from
`@sinclair/typebox` directly.

---

## Public API (complete)

Values:

- `route` — builder entry. Methods: `route.get/post/put/patch/delete(path)`. **No `head`/`options`.**
- `defineRouter(routes)` — build a `Router`. Returned router is chainable: `.packages([...])`, `.use([...])`.
- `registerRoutes(app, router, namedMiddlewares?, collectedRoutes?)` — mount onto Hono, returns `RegisteredRoute[]`.
- `defineMiddleware(name, handler | factory, options?)` — named middleware (param-count auto-detects handler vs factory).
- `defineMiddlewareFactory(name, factory)` — explicit factory form (use when the factory itself takes exactly 2 args).
- `Nullable(schema)` → `T | null`; `OptionalNullable(schema)` → `T | null | undefined`.
- `isHttpMethod(value)` — type guard for `'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'`.
- `.contract({ since, response, auth?, requiresSession?, deprecatedIn?, removedIn? })` — builder method; publishes
  the route as a versioned promise. See [`../contract/README.md`](../contract/README.md).
- `defineRouter({...}).contractVersion('1.2.0')` — the version those promises are published under.
  A released snapshot is named from it, and a running server announces it.
- File schemas: `FileSchema(opts?)`, `FileArraySchema(opts?)`, `OptionalFileSchema(opts?)` — **all are functions, call with `()`**.
- File helpers: `isFileSchema`, `isFileArraySchema`, `getFileOptions`, `formatFileSize`.

Types:

- `RouteInput`, `RouteDef`, `RouteHandlerFn`, `Router`, `RegisteredRoute`
- `RouteContract`, `RouteAuthProfile`
- `RouteBuilderContext`, `MergedInput`, `PaginatedResult`
- `HttpMethod`, `NamedMiddleware`, `NamedMiddlewareFactory`, `ExtractMiddlewareNames`
- `FileSchemaOptions`, `FileArraySchemaOptions`, `FileSchemaType`, `FileArraySchemaType`

### Removed API — do not use

The following contract-first / class-based APIs **do not exist** in this package. Older
docs and AI completions invent them — they will not compile:

- **`createApp(...)`, `createContract(...)`, `.bind(handler)`** — there is no contract-first
  layer. A route is `route.<method>(path).input(...).handler(...)`, full stop. The handler
  is attached inline via `.handler()`, never bound separately.
- **`RouteMeta`, `RouteMetadata`, `RouterMetadata`, `InferResponseData`** — not exported
  from `types.ts` (which only exports `HttpMethod`). Do not import them.
- **`.meta(...)`, `.public()`, `.tags(...)`, `.description(...)` builder methods** — the
  builder only has `input`, `interceptor`, `middleware`/`use`, `skip`, `contract`, `handler`.
- **`.output(schema)`** — does not exist. The response shape is declared inside `.contract({ response })`;
  see [Contract](#contract).
- **`route.head(...)` / `route.options(...)`** — not defined.
- **`c.success(...)` / `c.error(...)`** — not context helpers (see the helper list below).

---

## Quick Start

```typescript
// routes/users.ts
import { route } from '@spfn/core/route';
import { Type } from '@sinclair/typebox';

export const getUser = route.get('/users/:id')
    .input({
        params: Type.Object({ id: Type.String() }),
    })
    .handler(async (c) =>
    {
        const { params } = await c.data();   // params: { id: string }
        return await userRepo.findById(params.id); // plain return → JSON 200, type inferred
    });

export const createUser = route.post('/users')
    .input({
        body: Type.Object({ name: Type.String(), email: Type.String({ format: 'email' }) }),
    })
    .handler(async (c) =>
    {
        const { body } = await c.data();      // body: { name: string; email: string }
        return c.created(await userRepo.create(body), `/users/123`); // 201 + Location
    });
```

```typescript
// router.ts
import { defineRouter } from '@spfn/core/route';
import { getUser, createUser } from './routes/users';

export const appRouter = defineRouter({ getUser, createUser });
export type AppRouter = typeof appRouter;
```

The router is then handed to `@spfn/core/server` via `defineServerConfig().routes(appRouter)`,
which calls `registerRoutes` internally. You rarely call `registerRoutes` by hand.

---

## Route builder

`route.<method>(path)` returns a chainable, **immutable** `RouteBuilder` (each method
returns a fresh builder). `.handler(fn)` is the only terminal — it produces a `RouteDef`.

```typescript
route.get('/users/:id')          // method + path fixed here
    .input({ ... })              // optional — TypeBox schemas per input source
    .interceptor({ ... })        // optional — middleware-injected fields (see below)
    .use([mwA, mwB])             // optional — route-level middleware (alias: .middleware)
    .skip(['auth'])              // optional — skip named server-level middleware
    .contract({ ... })           // optional — publish as a versioned promise (see below)
    .handler(async (c) => { ... }); // required — terminal
```

| Method | Purpose |
|--------|---------|
| `route.get/post/put/patch/delete(path)` | Start a builder with method + path. |
| `.input(schemas)` | Define validated input (`params`/`query`/`body`/`formData`/`headers`/`cookies`). |
| `.interceptor(schemas)` | Declare fields injected by middleware — typed in handler, excluded from client types. |
| `.use(mws)` / `.middleware(mws)` | Attach route-level middleware (regular `MiddlewareHandler` or `NamedMiddleware`). Identical. |
| `.skip(names \| '*')` | Skip server-level named middleware for this route. |
| `.contract(contract)` | Publish the route as a versioned promise to separately deployed clients. |
| `.handler(fn)` | Terminal. Return value type becomes the response type. |

Chain order between `.input`/`.interceptor`/`.use`/`.skip`/`.contract` is free; only `.handler`
must be last.

---

## Input

`.input(...)` takes a `RouteInput` — an object whose keys are TypeBox schemas, one per
HTTP input source. **All six keys are optional**; only declared sources are validated and typed.

```typescript
export type RouteInput = {
    params?:   TSchema; // path params  (/users/:id)
    query?:    TSchema; // query string (?page=1)
    body?:     TSchema; // JSON request body
    formData?: TSchema; // multipart/form-data (file uploads)
    headers?:  TSchema; // request headers (keys are lowercased)
    cookies?:  TSchema; // cookies
};
```

```typescript
route.patch('/users/:id')
    .input({
        params:  Type.Object({ id: Type.String() }),
        query:   Type.Object({ notify: Type.Optional(Type.Boolean()) }),
        body:    Type.Object({ name: Type.String() }),
        headers: Type.Object({ authorization: Type.String() }),
        cookies: Type.Object({ session: Type.String() }),
    })
    .handler(async (c) =>
    {
        const { params, query, body, headers, cookies } = await c.data();
    });
```

### Type coercion

Input is run through TypeBox `Value.Convert` before validation, so URL/query/param strings
are coerced to their schema type:

```typescript
.input({
    params: Type.Object({ id: Type.Number() }),     // "123"  → 123
    query:  Type.Object({ active: Type.Boolean(),    // "true" → true
                          limit:  Type.Number() }),  // "10"   → 10
})
```

### Validation errors

Validation throws `ValidationError` (from `@spfn/core/errors`), caught by the global error
handler → `400` with `{ error: { name, message, statusCode, fields: [{ path, message, value }] } }`.
Validation runs in this order: **params → query → headers → cookies → body/formData**.

### Built-in string formats

`@spfn/core/route` registers these TypeBox formats at import time: `email`, `uri` (http/https),
`uuid`, `date` (`YYYY-MM-DD`), `date-time`. Use via `Type.String({ format: 'email' })`.
Register your own with `FormatRegistry.Set(...)` from `@sinclair/typebox`.

### Nullable helpers

```typescript
import { Nullable, OptionalNullable } from '@spfn/core/route';

Type.Optional(Type.String())     // string | undefined
Nullable(Type.String())          // string | null
OptionalNullable(Type.String())  // string | null | undefined
```

### File uploads (formData)

`body` and `formData` are **mutually exclusive at runtime** — the request `Content-Type`
decides: `multipart/form-data` → `formData` is parsed/validated; otherwise `body`. Declaring
both is allowed but only one is populated per request.

```typescript
import { route, FileSchema, FileArraySchema, OptionalFileSchema } from '@spfn/core/route';

route.post('/upload')
    .input({
        formData: Type.Object({
            avatar: FileSchema({                              // call it — it is a function
                maxSize: 5 * 1024 * 1024,                     // 5MB
                allowedTypes: ['image/jpeg', 'image/png'],
            }),
            docs: FileArraySchema({ maxFiles: 5 }),
            note: OptionalFileSchema(),                       // optional file
            description: Type.Optional(Type.String()),        // non-file fields validated by TypeBox
        }),
    })
    .handler(async (c) =>
    {
        const { formData } = await c.data();
        const avatar = formData.avatar as File; // file.name, file.size, file.type
    });
```

File constraints (`maxSize`/`minSize`/`allowedTypes`/`maxFiles`/`minFiles`) are enforced
separately from TypeBox and also surface as `ValidationError`.

---

## Contract

`.contract()` marks a route as a versioned promise to clients that are **compiled and deployed
separately from the server** — a mobile app in the store, an external API consumer. The build then
refuses a change that would break one of them.

```typescript
export const getUser = route.get('/users/:id')
    .input({ params: Type.Object({ id: Type.String() }) })
    .contract({
        since: '1.2.0',
        auth: 'clientProofV1',
        requiresSession: true,
        response: Type.Object({
            id: Type.String(),
            name: Type.String(),
            email: Type.Optional(Type.String()),
        }),
    })
    .handler(async (c) => { ... });
```

| Field | Meaning |
|-------|---------|
| `response` | Response shape as a TypeBox schema — **declared, not inferred**. No body → `Type.Null()`. |
| `since` | Contract version this operation first appeared in. |
| `auth` | `'none'` or `'clientProofV1'`. Default `'none'`. |
| `requiresSession` | Whether the call carries a session. Default `false`. |
| `deprecatedIn` | Version the operation was announced for removal in. Optional. |
| `removedIn` | Version the operation was removed in. Optional — kept on a route that stays only to carry the record, so a client generated before the removal learns the operation went and when. |

**A web client needs none of this.** `createApi<AppRouter>()` derives its types from the router in
the same build, so a removed response field breaks the TypeScript compile. `.contract()` exists for
the clients TypeScript cannot reach.

`.contract()` is opt-in per route and changes nothing at runtime — no response validation, no
middleware. It only puts a value on `RouteDef` that the `@spfn/core:contract` generator reads.

**Not on a multipart route.** A route declaring `formData` cannot also carry `.contract()` — the
contract describes JSON values and a file part has no spelling among them, so the generator refuses
it rather than describing the operation incompletely. `formData` without `.contract()` is fine.

Full behaviour — the generator, the released snapshots, the compatibility case table and the
removal rules — is in [`../contract/README.md`](../contract/README.md).

---

## Handler & context

`.handler((c) => ...)` receives a `RouteBuilderContext`. Input is read via the **async**
`c.data()`; the return value of the handler becomes the response.

### `c.data()`

Returns `MergedInput` — the validated input merged with any `interceptor` fields. It is
**async** (body/formData parsing) and **cached** (safe to call once per source destructure):

```typescript
const { params, query, body, formData, headers, cookies } = await c.data();
```

### Response: return value handling

The registration layer inspects what the handler returns:

- **Plain value** (object/array/primitive) → `c.json(value, 200)`. Type is inferred all the
  way to the client. **This is the preferred path.**
- **A `Response`** (e.g. from `c.json(...)` / `c.redirect(...)`) → returned as-is. Note this
  **erases the inferred response type** — only use when you need a status the helpers don't cover.
- Helper return values (`c.created`/`c.accepted`/`c.paginated`/...) carry status/headers via
  internal metadata while still returning the **data** for inference.

### Context helpers (exhaustive)

| Helper | Returns | Effect |
|--------|---------|--------|
| `c.data()` | `Promise<MergedInput>` | Validated, merged, cached input. |
| `c.json(data, status?, headers?)` | `Response` | Raw JSON response — **loses response type inference**. |
| `c.created(data, location?)` | `T` (the data) | 201; sets `Location` header if given. |
| `c.accepted(data?)` | `T` or `void` | 202; empty body when called with no argument. |
| `c.noContent()` | `void` | 204, empty body. |
| `c.notModified()` | `void` | 304, empty body. |
| `c.paginated(items, page, limit, total)` | `PaginatedResult<T>` | `{ items, pagination: { page, limit, total, totalPages } }`. |
| `c.redirect(url, status?)` | `Response` | Redirect (default 302). |
| `c.raw` | Hono `Context` | Escape hatch for headers/streaming/`c.get()` set by middleware. |

> `created`/`accepted`/`paginated` return the **data** (not a `Response`) precisely so the
> response type is preserved — you must `return` them.

```typescript
route.delete('/users/:id')
    .input({ params: Type.Object({ id: Type.String() }) })
    .handler(async (c) =>
    {
        await userRepo.delete((await c.data()).params.id);
        return c.noContent(); // 204, type: void
    });

route.get('/users')
    .input({ query: Type.Object({ page: Type.Number(), limit: Type.Number() }) })
    .handler(async (c) =>
    {
        const { query } = await c.data();
        const { items, total } = await userRepo.findPaginated(query);
        return c.paginated(items, query.page, query.limit, total); // PaginatedResult<User>
    });
```

### Errors

Throw — don't return error objects. `@spfn/core/errors` provides
`BadRequestError`/`UnauthorizedError`/`ForbiddenError`/`NotFoundError`/`ConflictError`/
`TooManyRequestsError`/`ValidationError`/`InternalServerError`, plus the generic
`HttpError(status, message)`. The global handler serializes them.

```typescript
import { NotFoundError } from '@spfn/core/errors';

route.get('/users/:id')
    .input({ params: Type.Object({ id: Type.String() }) })
    .handler(async (c) =>
    {
        const user = await userRepo.findById((await c.data()).params.id);
        if (!user)
        {
            throw new NotFoundError({ resource: 'User' });
        }
        return user;
    });
```

### `.interceptor()` — middleware-injected fields

When a middleware injects fields into the request (e.g. auth crypto keys), declare them with
`.interceptor(...)`. They are merged into `c.data()` and **typed in the handler**, but
**excluded from generated client types** (clients never send them). They are **not** validated
by the route input schema (the middleware is responsible).

```typescript
route.post('/_auth/login')
    .input({ body: Type.Object({ email: Type.String(), password: Type.String() }) })
    .interceptor({ body: Type.Object({ publicKey: Type.String(), keyId: Type.String() }) })
    .handler(async (c) =>
    {
        const { body } = await c.data();
        // handler sees: { email, password, publicKey, keyId }
        // client sends only: { email, password }
        return loginService(body);
    });
```

An `interceptor` `body`/`formData` declaration also makes the request body be **parsed**, so a
route whose entire body comes from a middleware needs no `.input` to see it:

```typescript
route.post('/_auth/keys/rotate')
    .interceptor({ body: Type.Object({ publicKey: Type.String(), keyId: Type.String() }) })
    .handler(async (c) =>
    {
        const { body } = await c.data();
        // body = { publicKey, keyId } — parsed, not validated
    });
```

Parsing only: the values are passed through as they arrived, so a field the middleware failed
to inject reaches the handler as `undefined` rather than as a 400. A `GET`/`HEAD` route never
reads a body, whatever it declares.

---

## defineRouter — composition

`defineRouter(routes)` groups routes into a `Router`. Values may be `RouteDef`s **or** nested
`Router`s. The returned router is chainable.

```typescript
// Flat — keys become RPC method names
export const appRouter = defineRouter({ getUser, createUser, updateUser });

// Nested namespaces
export const appRouter = defineRouter({
    users: defineRouter({ get: getUser, create: createUser }),
    posts: defineRouter({ list: listPosts, get: getPost }),
});

// Spread route modules
import * as userRoutes from './routes/users';
export const appRouter = defineRouter({ ...userRoutes, ...postRoutes });

export type AppRouter = typeof appRouter;
```

### `.packages([...])` — mount package routers

Attach routers from SPFN packages (`@spfn/auth`, `@spfn/cms`, …). Package routes **are**
registered/served, but are **excluded from `AppRouter`'s client types** — call them through
the package's own typed client (`authApi`, `cmsApi`) instead of `api`.

```typescript
import { authRouter } from '@spfn/auth/server';

export const appRouter = defineRouter({ getRoot, getStatus })
    .packages([authRouter]);
// api.getRoot.call({})    — app route
// authApi.login.call({})  — package route
```

`.packages()` also flattens any nested package routers the given routers themselves declared.

### `.use([...])` — router-level global middleware

Named middleware applied to **every** route in the router (and package routers), unless a
route opts out with `.skip(...)`. The router carries them, and route registration merges them
with server-config middleware — each one attaching **once** per route.

```typescript
export const appRouter = defineRouter({ getRoot, getStatus })
    .packages([authRouter])
    .use([loggingMiddleware]);
```

---

## Middleware

### Route-level (`.use` / `.middleware`)

Accepts plain Hono `MiddlewareHandler`s and `NamedMiddleware`s, mixed:

```typescript
route.post('/posts')
    .use([authenticate, rateLimit({ limit: 10 })])
    .handler(async (c) => { ... });
```

### Named middleware (`defineMiddleware`)

A named middleware can be **skipped by name** at the route level and is **deduplicated** if
present both globally and route-level. `defineMiddleware` auto-detects form by parameter count:
a 2-arg function is a `(c, next)` handler; anything else is a factory.

```typescript
import { defineMiddleware } from '@spfn/core/route';

// Regular handler — exactly (c, next)
export const authMiddleware = defineMiddleware('auth', async (c, next) =>
{
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', await verifyToken(c.req.header('authorization')!));
    await next();
});

// Factory — any arg count other than 2
export const requirePermissions = defineMiddleware('permission',
    (...perms: string[]) => async (c, next) =>
    {
        if (!hasPermissions(c.get('user'), perms)) return c.json({ error: 'Forbidden' }, 403);
        await next();
    });

route.get('/admin').use([requirePermissions('admin:write')]).handler(...);
```

### `defineMiddlewareFactory` — for 2-arg factories

A factory whose own signature is exactly two args (e.g. `(limit, window) => handler`) would be
misread as a `(c, next)` handler by `defineMiddleware`. Use `defineMiddlewareFactory` to force
the factory interpretation:

```typescript
import { defineMiddlewareFactory } from '@spfn/core/route';

export const rateLimiter = defineMiddlewareFactory('rateLimit',
    (limit: number, window: number) => async (c, next) => { /* ... */ await next(); });

route.get('/api').use([rateLimiter(100, 60_000)]).handler(...);
```

### Skipping & auto-skip

```typescript
route.get('/status').skip(['auth']).handler(...);   // skip a specific server-level middleware
route.get('/status').skip('*').handler(...);          // skip ALL server-level middleware
```

`.skip(...)` only affects **server-level named middleware** — middleware added via `.use()`
on the same route is never skipped. A named middleware can declare auto-skips so callers don't
need an explicit `.skip`:

```typescript
// optionalAuth auto-skips the global 'auth' whenever it is used
export const optionalAuth = defineMiddleware('optionalAuth', handler, { skips: ['auth'] });
route.get('/feed').use([optionalAuth]).handler(...); // 'auth' auto-skipped, no .skip needed
```

### Effective order at registration

```
server-level named middleware (minus skipped / auto-skipped)
  → route-level middleware (.use, deduped against the above)
    → input validation
      → handler
```

Dedup rules: named middleware by `name`; plain middleware by handler reference. A name is
one middleware however many times it is registered — server-config and router-level `.use()`
naming the same middleware attach it **once**, which is what lets middleware hold one-shot
state (a nonce ledger) without rejecting its own request. An entry with no name is never
collapsed, since unrelated anonymous handlers share the empty name.

---

## Pitfalls & anti-patterns

- **`c.data()` is async — `await` it.** `const { params } = c.data()` (no `await`) yields a
  Promise, not your input.
- **File schemas are functions: `FileSchema()`, not `FileSchema`.** Passing the function
  reference (no `()`) produces an invalid schema. Same for `FileArraySchema`/`OptionalFileSchema`.
  (Some old docs show `file: FileSchema` — wrong.)
- **Returning a `Response` erases response-type inference.** `return c.json(data, 418)` makes
  the client type `unknown`/`Response`. Prefer a plain `return data` or a typed helper
  (`c.created`, `c.paginated`) unless you genuinely need a custom status.
- **You must `return` the response helpers.** `c.created(user)` / `c.noContent()` set metadata
  and return the value/void — calling without `return` does nothing useful.
- **`created`/`accepted`/`paginated` return data, not a `Response`.** Don't `await c.json(...)`
  on their output or wrap them again — just `return` them.
- **`.skip(...)` does not skip `.use(...)` middleware.** It only filters **server-level named**
  middleware. To not run a route-level middleware, don't add it.
- **`skip`/`skips` match by middleware *name*, not import identity.** Only `defineMiddleware`-
  created middleware has a name; a plain `MiddlewareHandler` can't be targeted by `.skip`.
- **`body` vs `formData` is decided by `Content-Type`.** A JSON request won't populate
  `formData` and a multipart request won't populate `body`. Don't expect both.
- **Package routes aren't in `AppRouter` types.** After `.packages([authRouter])`, call those
  endpoints via the package client (`authApi`), not via `api` — `typeof appRouter` deliberately
  hides them.
- **`.handler` is terminal.** No chaining after it (it returns a `RouteDef`, not a builder).
  Put `.input/.interceptor/.use/.skip` before `.handler`.
- **Headers are lowercased.** Declare `headers: Type.Object({ authorization: ... })`, not
  `Authorization`. Cookies are split from the `cookie` header and URL-decoded.
- **No contract-first API.** There is no `createApp`/`createContract`/`.bind()`/`.meta()`/
  `RouteMeta`. A route is fully defined by `route.<m>(path).input(...).handler(...)`.

---

## Complete example

```typescript
// routes/users.ts
import { route, FileSchema } from '@spfn/core/route';
import { Type } from '@sinclair/typebox';
import { NotFoundError } from '@spfn/core/errors';
import { userRepo } from '../repositories/user.repository';

export const listUsers = route.get('/users')
    .input({
        query: Type.Object({
            page:  Type.Number({ default: 1 }),
            limit: Type.Number({ default: 20 }),
            search: Type.Optional(Type.String()),
        }),
    })
    .handler(async (c) =>
    {
        const { query } = await c.data();
        const { items, total } = await userRepo.findPaginated(query);
        return c.paginated(items, query.page, query.limit, total);
    });

export const getUser = route.get('/users/:id')
    .input({ params: Type.Object({ id: Type.String() }) })
    .handler(async (c) =>
    {
        const user = await userRepo.findById((await c.data()).params.id);
        if (!user)
        {
            throw new NotFoundError({ resource: 'User' });
        }
        return user;
    });

export const createUser = route.post('/users')
    .input({
        body: Type.Object({
            name:  Type.String({ minLength: 1, maxLength: 100 }),
            email: Type.String({ format: 'email' }),
        }),
    })
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const user = await userRepo.create(body);
        return c.created(user, `/users/${user.id}`);
    });

export const uploadAvatar = route.post('/users/:id/avatar')
    .input({
        params: Type.Object({ id: Type.String() }),
        formData: Type.Object({
            avatar: FileSchema({ maxSize: 5 * 1024 * 1024, allowedTypes: ['image/jpeg', 'image/png'] }),
        }),
    })
    .handler(async (c) =>
    {
        const { params, formData } = await c.data();
        await userRepo.setAvatar(params.id, formData.avatar as File);
        return c.noContent();
    });

export const deleteUser = route.delete('/users/:id')
    .skip(['rateLimit'])
    .input({ params: Type.Object({ id: Type.String() }) })
    .handler(async (c) =>
    {
        await userRepo.delete((await c.data()).params.id);
        return c.noContent();
    });
```

```typescript
// router.ts
import { defineRouter } from '@spfn/core/route';
import { authRouter } from '@spfn/auth/server';
import { loggingMiddleware } from './middlewares/logging';
import * as userRoutes from './routes/users';

export const appRouter = defineRouter({ ...userRoutes })
    .packages([authRouter])
    .use([loggingMiddleware]);

export type AppRouter = typeof appRouter;
```

```typescript
// server.config.ts — registration is done by @spfn/core/server
import { defineServerConfig } from '@spfn/core/server';
import { authMiddleware } from './middlewares/auth';
import { appRouter } from './router';

export default defineServerConfig()
    .middlewares([authMiddleware]) // server-level named middleware (skippable per-route)
    .routes(appRouter)             // calls registerRoutes(app, appRouter, middlewares) internally
    .build();
```

---

## Types reference

```typescript
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type RouteInput = {
    params?: TSchema; query?: TSchema; body?: TSchema;
    formData?: TSchema; headers?: TSchema; cookies?: TSchema;
};

type RouteDef<TInput, TInterceptor, TResponse> = {
    method?: HttpMethod; path?: string;
    input?: TInput; interceptor?: TInterceptor;
    middlewares?: (MiddlewareHandler | NamedMiddleware<string>)[];
    skipMiddlewares?: string[] | '*';
    handler: RouteHandlerFn<TInput, TInterceptor, TResponse>;
    // _input / _interceptor / _response: compile-time inference helpers (never read at runtime)
};

type Router<TRoutes> = {
    routes: TRoutes;
    packages(routers: Router<any>[]): Router<TRoutes>;
    use(middlewares: NamedMiddleware<string>[]): Router<TRoutes>;
    // _routes / _packageRouters / _globalMiddlewares: internal
};

type PaginatedResult<T> = {
    items: T[];
    pagination: { page: number; limit: number; total: number; totalPages: number };
};

type NamedMiddleware<TName extends string = string> = {
    name: TName; handler: MiddlewareHandler; _name: TName; skips?: string[];
};

type RegisteredRoute = { method: HttpMethod; path: string; name: string };
```

`registerRoutes(app, router, namedMiddlewares?, collectedRoutes?)` returns the flattened
`RegisteredRoute[]` (including nested and package routers) — useful for logging mounted routes.

## Related

- [@spfn/core/server](../server/README.md) — `defineServerConfig().routes(router)`, which mounts the router.
- [@spfn/core/errors](../errors/README.md) — error classes thrown from handlers and validation.
- [@sinclair/typebox](https://github.com/sinclairzx81/typebox) — schema builder (`Type`) used in `.input()`.
- [Hono](https://hono.dev) — underlying framework; `c.raw` is a Hono `Context`.
