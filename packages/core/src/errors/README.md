# @spfn/core/errors — Serializable HTTP/DB error classes with cross-boundary deserialization

Type-safe error classes that carry an HTTP status code, auto-serialize to JSON via
`toJSON()`, and can be reconstructed as real error instances on the client through an
`ErrorRegistry`.

## Import paths

```typescript
// Error classes, base class, registry, type guards
import {
    NotFoundError,
    ValidationError,
    EntityNotFoundError,
    SerializableError,
    ErrorRegistry,
    errorRegistry,
    isHttpError,
} from '@spfn/core/errors';
```

There is **no** root `.` export for `@spfn/core`, so `import { NotFoundError } from
'@spfn/core'` does not resolve. Import from the `@spfn/core/errors` subpath. (Older
snippets showing the root form are stale.)

Related symbols that live in **other** subpaths (a common mistake):

- `ErrorHandler` (the Hono `onError` middleware) → `@spfn/core/middleware`.
- `fromPostgresError` (Postgres error-code → DB error mapping) → `@spfn/core/db`,
  **not** `@spfn/core/errors`.

---

## Public API (complete)

From `@spfn/core/errors`:

- Base: `SerializableError` (abstract class), `ErrorRegistry` (class),
  `errorRegistry` (a pre-populated `ErrorRegistry` instance)
- HTTP errors: `HttpError`, `BadRequestError`, `ValidationError`, `UnauthorizedError`,
  `ForbiddenError`, `NotFoundError`, `ConflictError`, `GoneError`,
  `TooManyRequestsError`, `UnsupportedMediaTypeError`, `UnprocessableEntityError`,
  `InternalServerError`, `ServiceUnavailableError`
- Database errors: `DatabaseError`, `ConnectionError`, `QueryError`,
  `EntityNotFoundError`, `ConstraintViolationError`, `TransactionError`,
  `DeadlockError`, `DuplicateEntryError`
- Namespaced re-exports: `HttpErrors` (`HttpErrors.NotFoundError`, …),
  `DatabaseErrors` (`DatabaseErrors.QueryError`, …)
- Type guards: `isHttpError`, `isDatabaseError`, `hasStatusCode`
- Types: `SerializedError`, `SerializableErrorConstructor`, `ErrorRegistryInput`

> **Every constructor takes a single object argument.** There is **no** positional form.
> `new NotFoundError('User', 123)`, `new EntityNotFoundError('User', 123)`,
> `new DatabaseError('msg', 500, {...})`, `new HttpError(404, 'msg')` do **not** exist —
> these were old signatures and will not compile. Use the object forms below.
>
> There is **no** `name` or `timestamp` field on the serialized output. Serialized JSON is
> `{ __type, message, ...publicFields }` — `statusCode` is intentionally excluded (it is
> inferred from the type on deserialize). Old docs showing `{ "name": ..., "timestamp": ... }`
> responses are wrong. The `code` a response carries lives inside the `error` envelope the
> handler adds (below), never as a top-level field.

---

## Quick Start

```typescript
import { NotFoundError, ValidationError } from '@spfn/core/errors';

// Throw anywhere in a route/service. The ErrorHandler middleware serializes it.
throw new NotFoundError({ message: 'User not found', resource: 'User' });

throw new ValidationError({
    message: 'Invalid input',
    fields: [{ path: '/email', message: 'Email is required' }],
});
```

Wire up the handler once (it is **not** automatic — see Pitfalls):

```typescript
import { Hono } from 'hono';
import { ErrorHandler } from '@spfn/core/middleware';

const app = new Hono();
app.onError(ErrorHandler());
```

Response for the `NotFoundError` above (HTTP 404):

```json
{
    "__type": "NotFoundError",
    "message": "User not found",
    "resource": "User",
    "error": {
        "code": "NotFoundError",
        "message": "User not found",
        "requestId": "9f2c8b1e4d6a70f3c5b2e8a1d4f70c93"
    }
}
```

---

## HTTP error classes

All extend `HttpError → SerializableError`. Each constructor takes an object. Classes
with no required fields accept zero args and fall back to a default message.

| Class | Status | Constructor arg | Extra public fields |
|---|---|---|---|
| `HttpError` | (required) | `{ message, statusCode, details? }` | `details?` |
| `BadRequestError` | 400 | `{ message?, details? }` | — |
| `ValidationError` | 400 | `{ message, fields?, details? }` | `fields?` |
| `UnauthorizedError` | 401 | `{ message?, details? }` | — |
| `ForbiddenError` | 403 | `{ message?, details? }` | — |
| `NotFoundError` | 404 | `{ message?, resource?, details? }` | `resource?` |
| `ConflictError` | 409 | `{ message?, details? }` | — |
| `GoneError` | 410 | `{ message?, resource?, details? }` | `resource?` |
| `UnsupportedMediaTypeError` | 415 | `{ message?, mediaType?, supportedTypes?, details? }` | `mediaType?`, `supportedTypes?` |
| `UnprocessableEntityError` | 422 | `{ message?, details? }` | — |
| `TooManyRequestsError` | 429 | `{ message?, retryAfter?, details? }` | `retryAfter?` |
| `InternalServerError` | 500 | `{ message?, details? }` | — |
| `ServiceUnavailableError` | 503 | `{ message?, retryAfter?, details? }` | `retryAfter?` |

```typescript
import {
    BadRequestError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    ConflictError,
    ValidationError,
    TooManyRequestsError,
} from '@spfn/core/errors';

throw new BadRequestError();                                  // "Bad request"
throw new UnauthorizedError({ message: 'Invalid token' });    // 401
throw new ForbiddenError({ message: 'Insufficient permissions' });
throw new NotFoundError({ resource: 'User' });                // "Resource not found", resource: 'User'
throw new ConflictError({ message: 'Email already in use' });

throw new ValidationError({
    message: 'Validation failed',
    fields: [
        { path: '/email', message: 'Invalid format', value: 'nope' },
        { path: '/age', message: 'Must be >= 18', value: 15 },
    ],
});

throw new TooManyRequestsError({ message: 'Rate limit exceeded', retryAfter: 60 });
```

The optional `details` field accepts any `Record<string, unknown>` and is serialized as-is.

---

## Database error classes

All extend `SerializableError`. `EntityNotFoundError`, `ConstraintViolationError`, and
`DuplicateEntryError` extend `QueryError`; `DeadlockError` extends `TransactionError`.
`EntityNotFoundError` and `DuplicateEntryError` **build their own message** from the
provided fields.

| Class | Status | Constructor arg | Notes |
|---|---|---|---|
| `DatabaseError` | 500 (default) | `{ message, statusCode?, details? }` | base class |
| `ConnectionError` | 503 | `{ message, details? }` | |
| `QueryError` | 500 (default) | `{ message, statusCode?, details? }` | |
| `EntityNotFoundError` | 404 | `{ resource, id }` | message auto-built; `resource`, `id` public; `details = { resource, id }` |
| `ConstraintViolationError` | 400 | `{ message, details? }` | |
| `TransactionError` | 500 (default) | `{ message, statusCode?, details? }` | |
| `DeadlockError` | 409 | `{ message, details? }` | |
| `DuplicateEntryError` | 409 | `{ field, value }` | message auto-built; `field`, `value` public; `details = { field, value }` |

```typescript
import {
    EntityNotFoundError,
    DuplicateEntryError,
    ConnectionError,
    QueryError,
} from '@spfn/core/errors';

throw new EntityNotFoundError({ resource: 'User', id: 123 });
// message: "User with id 123 not found", statusCode 404

throw new DuplicateEntryError({ field: 'email', value: 'john@example.com' });
// message: "email 'john@example.com' already exists", statusCode 409

throw new ConnectionError({ message: 'Failed to connect to database' });
throw new QueryError({ message: 'Syntax error in SQL query' });
```

`EntityNotFoundError` is for missing **database** rows. For the HTTP layer (a missing
route/resource) use `NotFoundError`.

### Mapping raw Postgres errors

`fromPostgresError(error)` (from `@spfn/core/db`) maps a `pg` error code to one of the DB
classes above. SPFN's DB helpers and the `Transactional()` middleware already call it, so
you rarely need it directly.

```typescript
import { fromPostgresError } from '@spfn/core/db';

try { await db.insert(users).values(data); }
catch (error) { throw fromPostgresError(error); }
// 23505 → DuplicateEntryError, 23503 → ConstraintViolationError,
// 40P01 → DeadlockError, 08xxx → ConnectionError, else → QueryError
```

---

## Serialization & the ErrorRegistry

`SerializableError.toJSON()` emits `{ __type: this.constructor.name, message, ...publicFields }`,
skipping `name`, `message`, `stack`, and `statusCode`. The `ErrorHandler` middleware calls
`toJSON()`, adds the `error` envelope, and responds with the matching status code (plus
`stack` when `includeStack` is on).

### Reserved field names

`__type`, `message` and `error` are reserved. They are the slots the response shape itself
occupies: `__type` is the discriminator the client registry looks up, `message` is the text,
and `error` is the `{ code, message, requestId }` envelope a client generated for another
language reads. A public field with one of those names would land in the same slot, and
either outcome is a loss — overwrite the envelope and the generated client cannot classify
the failure, drop the field and the app silently loses data it meant to send.

So the collision is refused rather than arbitrated. An error class declaring one of the three
throws on serialization outside production, which surfaces the first time a test serializes
it. In production the field is dropped and the class name is logged: throwing there would
replace the real failure with a failure about serializing it, and the original would never
reach the log or the client.

```typescript
class OrderFailedError extends SerializableError
{
    readonly statusCode = 400;
    error!: { vendorCode: string };   // ✗ reserved — rename to vendor, detail, …
}
```

Going the other way, `ErrorRegistry.deserialize()` drops `__type` and `error` before calling the
constructor: `__type` routed the lookup and `error` describes the response, so neither is a field
of the error. Without that, the documented `Object.assign(this, data)` constructor would copy both
onto the instance and the error would refuse to serialize the moment a server re-threw it.

On the client, the SPFN API client deserializes a response body that has a `__type` field
back into a real error instance using an `ErrorRegistry`. Built-in HTTP and DB errors are
already in the exported `errorRegistry` and are always merged into the client's registry,
so `error instanceof NotFoundError` works on the client out of the box. **Custom error
classes only deserialize if you register them.**

```typescript
import { ErrorRegistry, errorRegistry, ValidationError } from '@spfn/core/errors';

// Pre-populated registry holds all built-in HTTP + DB errors
errorRegistry.has('ValidationError');        // true
errorRegistry.getRegisteredTypes();          // string[]

// Build a custom registry (merge in the built-ins)
const registry = new ErrorRegistry([errorRegistry, PaymentFailedError]);
registry.append(ValidationError);            // chainable
registry.concat(errorRegistry);              // merge another registry

const err = registry.deserialize({ __type: 'NotFoundError', message: 'x', resource: 'User' });
// err instanceof NotFoundError === true

const maybe = registry.tryDeserialize(body); // null if __type missing/unknown (never throws)
```

`ErrorRegistry` methods: `append(ClassOrArray)`, `concat(registry)`, `has(name)`,
`deserialize(data)` (throws on unknown `__type`), `tryDeserialize(data)` (returns `null`),
`getRegisteredTypes()`. Constructor accepts an array mixing single classes, arrays of
classes, and other `ErrorRegistry` instances (`ErrorRegistryInput[]`).

### Minified browser bundles

A production browser bundle renames classes — `PaymentFailedError` becomes `Q` — but keeps the
string a constructor assigns to `this.name`. The server is not minified, so `__type` still
carries the original class name. `append()` therefore keys each class by its constructor name
and also by the `name` its instances set for themselves, read once by building the class with
`{}`. A lookup tries the constructor name first, so an unminified registry resolves exactly as
it always has.

For a class to be restored in a minified browser:

- **Set `this.name` to the class name in the constructor.** A class that leaves it unset only
  inherits its parent's name, and is not keyed under it — that key belongs to the parent.
- **Let the constructor build with `{}`.** One that throws without its fields is keyed by its
  constructor name only.

---

## Custom errors

Extend `SerializableError` directly (define `statusCode`, set `name`, assign fields), or
extend one of the concrete classes.

```typescript
import { SerializableError } from '@spfn/core/errors';

export class PaymentFailedError extends SerializableError
{
    readonly statusCode = 402;
    transactionId!: string;
    reason!: 'insufficient_funds' | 'card_declined';

    constructor(data: {
        message: string;
        transactionId: string;
        reason: 'insufficient_funds' | 'card_declined';
    })
    {
        super(data.message);
        this.name = 'PaymentFailedError';
        Object.assign(this, data);
    }
}
```

To make the client receive `instanceof PaymentFailedError`, register the class in the
`ErrorRegistry` passed to the API client (otherwise the client gets a plain `Error`).
For a custom subclass to round-trip, **its constructor must accept the serialized object**
(`deserialize` calls `new ErrorClass(data)` with the whole JSON body).

---

## Type guards

```typescript
import { isHttpError, isDatabaseError, hasStatusCode } from '@spfn/core/errors';

if (isDatabaseError(error)) { /* error: DatabaseError — has .statusCode, .details */ }
if (isHttpError(error))     { /* error: HttpError */ }
if (hasStatusCode(error))   { /* error: { statusCode: number } */ }
```

---

## Pitfalls & anti-patterns

- **The `ErrorHandler` middleware is not automatic.** You must register it
  (`app.onError(ErrorHandler())` from `@spfn/core/middleware`). Without it, thrown
  `SerializableError`s are not serialized and you get Hono's default 500.
- **`ErrorHandler` and `fromPostgresError` are not in `@spfn/core/errors`.** They live in
  `@spfn/core/middleware` and `@spfn/core/db` respectively. Importing them from
  `@spfn/core/errors` fails.
- **Use the object constructor form.** `new NotFoundError('User')`,
  `new EntityNotFoundError('User', 123)`, `new HttpError(404, 'x')`,
  `new DatabaseError('x', 500, {...})` are all old/removed signatures and won't compile.
- **A generic `throw new Error('...')` is not type-safe.** `ErrorHandler` returns it as
  `{ __type: 'Error', message, cause?, stack? }` with status **500** (or `error.statusCode`
  if present) — no field-level data, no 4xx mapping. Throw a specific class instead.
- **Custom errors don't deserialize on the client unless registered.** Built-ins are in the
  exported `errorRegistry` and always merged in, but your own classes must be added to the
  registry you pass to the API client, or the client receives a plain `Error`.
- **`statusCode` is not in the serialized JSON.** It's excluded by `toJSON()` and re-derived
  from the class on deserialize. Don't expect it in the response body.
- **No `name` / `timestamp` / `code` fields** in the response — only `__type`, `message`,
  and the error's own public fields (plus `stack` in dev). Don't parse for those.
- **In a transactional route, re-throw caught errors.** Errors propagate to trigger
  rollback; swallowing one commits the transaction. Let errors bubble to the middleware
  rather than returning `c.json({ error }, code)` yourself.
- **Never put secrets in `message` or `details`.** They are serialized verbatim and shipped
  to the client (and logged). Don't include passwords, tokens, raw SQL with credentials, etc.

---

## Complete example

```typescript
// server.ts — register the handler once
import { Hono } from 'hono';
import { ErrorHandler } from '@spfn/core/middleware';

export const app = new Hono();
app.onError(ErrorHandler({ includeStack: process.env.NODE_ENV !== 'production' }));

// routes/users.ts — throw specific errors; the handler serializes them
import { route } from '@spfn/core/route';
import { Type } from '@sinclair/typebox';
import { NotFoundError, DuplicateEntryError } from '@spfn/core/errors';
import { findOne, create } from '@spfn/core/db';
import { users } from '@/server/entities/users';

export const getUser = route.get('/users/:id')
    .input({ params: Type.Object({ id: Type.String() }) })
    .handler(async (c) =>
    {
        const { params } = await c.data();
        const user = await findOne(users, { id: params.id });

        if (!user)
        {
            throw new NotFoundError({ message: 'User not found', resource: 'User' });
        }

        return user;
    });

export const createUser = route.post('/users')
    .input({ body: Type.Object({ email: Type.String(), name: Type.String() }) })
    .handler(async (c) =>
    {
        const { body } = await c.data();

        if (await findOne(users, { email: body.email }))
        {
            throw new DuplicateEntryError({ field: 'email', value: body.email });
        }

        return c.created(await create(users, body));
    });

// client side — instanceof works because NotFoundError is a built-in
try { await api.users.get({ id: '999' }); }
catch (err)
{
    if (err instanceof NotFoundError) { /* err.resource === 'User' */ }
}
```

---

## Types reference

- `SerializedError` — `{ __type: string; message: string; [key: string]: unknown }`
- `SerializableErrorConstructor` — `new (data: any) => SerializableError`
- `ErrorRegistryInput` — `SerializableErrorConstructor | SerializableErrorConstructor[] | ErrorRegistry`
- `SerializableError` (abstract) — `Error` subclass with abstract `readonly statusCode: number`
  and `toJSON(): SerializedError`

---

## Related

- `@spfn/core/middleware` — `ErrorHandler` (the `onError` middleware that serializes these
  errors), `ErrorHandlerOptions` (`includeStack`, `enableLogging`, `onError`).
- `@spfn/core/db` — `fromPostgresError` and the `Transactional()` middleware that converts
  and rolls back on DB errors.
- `@spfn/notification/server` — `createErrorSlackNotifier` (an `onError` callback for Slack
  alerts). `@spfn/monitor/server` — `createMonitorErrorHandler` for DB-backed error tracking.
