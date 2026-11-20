# @spfn/core/logger — Zero-dependency structured logger (singleton + child loggers)

Transport-based logging for Next.js + SPFN server. One process-wide singleton `logger`,
five levels, automatic sensitive-data masking, and per-module child loggers. No external
logging library.

## Import paths

One entry point. Everything public comes from `@spfn/core/logger`.

```typescript
import { logger } from '@spfn/core/logger';
import { describeError } from '@spfn/core/logger';
import type { LogLevel, Transport, ErrorDescription, DatabaseErrorDescription } from '@spfn/core/logger';
```

There is **no** root `.` export for `@spfn/core`, so `import { logger } from '@spfn/core'`
does not resolve. `logger`, `Logger`, `LogLevel` and `Transport` all come from the
`@spfn/core/logger` subpath. (Older snippets showing the root form are stale.)

---

## Public API (complete)

From `@spfn/core/logger` (`src/logger/index.ts` is the only export surface):

- `logger` — the singleton `Logger` instance. This is what you use 99% of the time.
- `Logger` — the class. Exported mainly for typing; you do **not** construct it yourself
  (the singleton is created in `factory.ts`). Use `logger` / `logger.child(...)`.
- `describeError(error)` — the one loggable form of a caught error; see
  [Errors are described, not dumped](#errors-are-described-not-dumped).
- Types: `LogLevel`, `Transport`, `ErrorDescription`, `DatabaseErrorDescription`.

Instance methods on `logger` / any child logger:

- `logger.debug(message, ...)`, `logger.info(...)`, `logger.warn(...)`, `logger.error(...)`,
  `logger.fatal(...)` — the five level methods (overloaded, see Logging below).
- `logger.child(module: string): Logger` — new logger that tags every line with `[module=...]`.
- `logger.close(): Promise<void>` — close/flush all transports (graceful shutdown).
- `logger.level: LogLevel` — getter for the currently active level (read-only).

> **No such API — do not use these (they appear in old docs but are not in the code):**
> - `createLogger(name)` — does **not** exist. Use `logger.child(name)`.
> - `withLogContext(ctx, fn)` / any AsyncLocalStorage context helper — does **not** exist.
>   Pass context explicitly as the last argument on each call.
> - File transport, `LOGGER_FILE_ENABLED`, `LOG_DIR` — there is **no** file transport.
>   The only transport is console (stdout/stderr).
> - `LOG_LEVEL` env var — the level is read from `SPFN_LOG_LEVEL` /
>   `NEXT_PUBLIC_SPFN_LOG_LEVEL`, **not** `LOG_LEVEL`.
> - Slack / Email / CloudWatch / Sentry transports — none exist and none are "already
>   configured". The factory wires exactly one `ConsoleTransport`.
>
> Internal formatter functions (`maskSensitiveData`, `formatConsole`, `formatJSON`,
> `extractQueryInfo`, `formatUnhandledRejection`, etc.) live in `formatters.ts` but are
> **not** part of the public export surface — don't import them from `@spfn/core/logger`.
> In particular `formatJSON` exists but is **not wired into any transport**: production
> output is plain (uncolored) console text, not JSON (see Output format).

---

## Quick Start

```typescript
import { logger } from '@spfn/core/logger';

logger.debug('Cache miss', { key: 'user:123' });
logger.info('Server started', { port: 3000 });
logger.warn('Retry attempt', { attempt: 3 });
logger.error('Operation failed', error, { userId: 123 });   // error as 2nd arg
logger.fatal('Database unreachable', error);
```

No initialization, no `await`, no setup — importing `logger` is enough. The singleton is
constructed on first import in `factory.ts`.

---

## Logging: message + (error | context) + context

Each level method (`debug`/`info`/`warn`/`error`/`fatal`) shares the same overloads.
The second argument is detected at runtime, so argument **order and type matter**:

```typescript
// 1. message only
logger.info('Server started');

// 2. message + context object  → rendered as [key=value] pairs
logger.info('Request received', { method: 'POST', path: '/users' });

// 3. message + Error            → stack trace (and cause chain) printed
logger.error('Query failed', error);

// 4. message + Error + context  → both
logger.error('Query failed', error, { userId: 123, op: 'createUser' });

// 5. printf-style — if message contains a %s/%d/%i/%f/%j/%o/%O/%c token,
//    the second arg is substituted via node:util.format (NOT treated as context)
logger.info('Fetching url: %s', requestUrl);
```

How the second argument is classified (see `logWithLevel` in `logger.ts`):
- If `message` contains a printf token (`%s %d %i %f %j %o %O %c %%`), the 2nd arg is
  formatted into the message string — it will **not** appear as context.
- An `Error` instance → logged as the error: its description, stack frames and `cause`
  chain printed (see [Errors are described, not dumped](#errors-are-described-not-dumped)).
- A non-Error object **with** a string `stack` property → treated as an error and described.
- A plain object **without** a `stack` property → treated as **context**.
- A `string` / `number` / `boolean` → wrapped into an `Error` (so `{ key: value }`
  context must be an object, not a bare primitive).

This `stack`-based heuristic means an object you intend as context will be misread as an
error if it happens to carry a string `stack` field. Prefer the explicit 3-arg form
`logger.error(msg, error, context)` when you have both.

---

## Child loggers (per-module)

`logger.child(name)` returns a new `Logger` that inherits the level/transports and adds a
`[module=name]` tag to every line. Cheap to create; create one per module.

```typescript
const dbLogger = logger.child('database');
const apiLogger = logger.child('api');

dbLogger.info('Connection established');
// [2026-06-10 10:30:00.123] [pid=12345] [module=database] (INFO): Connection established
```

Child loggers do **not** stack — calling `.child('b')` on a child created with `.child('a')`
replaces the module name with `b`, it does not produce `a.b`.

---

## Log levels

Five levels, filtered by priority. A log is emitted only when its priority is `>=` the
configured level (filtering happens *before* metadata is built, so suppressed
`logger.debug(...)` calls are cheap).

| Level   | Priority | Stream | Use case |
|---------|----------|--------|----------|
| `debug` | 0 | stdout | Development diagnostics |
| `info`  | 1 | stdout | Normal operations (server start, etc.) |
| `warn`  | 2 | stderr | Potential issues, retries |
| `error` | 3 | stderr | Failures needing attention |
| `fatal` | 4 | stderr | Critical / shutdown-level errors |

`warn`, `error`, `fatal` go to **stderr**; `debug`, `info` go to **stdout** (via
`console.error` / `console.log`).

`LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'`.

---

## Configuration (environment variables)

The level is resolved once, at module load, in `factory.ts`:

| Variable | Effect | Default |
|----------|--------|---------|
| `SPFN_LOG_LEVEL` | Minimum level. First choice. | `info` |
| `NEXT_PUBLIC_SPFN_LOG_LEVEL` | Fallback level (client-visible in Next.js). Used only if `SPFN_LOG_LEVEL` is unset. | `info` |
| `NODE_ENV` | `production` → colorized output **off**; anything else → colors **on**. | (warns if unset) |

```bash
SPFN_LOG_LEVEL=debug   # show everything
NODE_ENV=production    # disable ANSI colors (plain text for log collectors)
```

- An invalid `SPFN_LOG_LEVEL` value falls back to `info` with a stderr warning.
- Because the level is read **once at import time**, changing `process.env.SPFN_LOG_LEVEL`
  at runtime has **no effect** — set it before the process starts.
- The console transport itself is created with level `debug` and is always enabled; the
  effective floor is the logger-level computed from `SPFN_LOG_LEVEL`.

---

## Sensitive data masking

Context objects are recursively scanned and any key whose lowercased name *contains* a
sensitive token is replaced with the literal string `***MASKED***` before output. The
original value is never written to any transport.

```typescript
logger.info('Login attempt', { username: 'john', password: pw, token: t });
// [username=john] [password=***MASKED***] [token=***MASKED***] (INFO): Login attempt
```

Masking applies to nested objects and arrays, and circular references render as
`[Circular]`. Matching is substring + case-insensitive, so `userPassword`, `X-Api-Key`,
`refresh_token`, etc. all match.

Masked key tokens (a key matches if it contains any of these):
`password`, `passwd`, `pwd`, `secret`, `token`, `apikey`, `api_key`, `accesstoken`,
`access_token`, `refreshtoken`, `refresh_token`, `authorization`, `auth`, `cookie`,
`session`, `sessionid`, `session_id`, `privatekey`, `private_key`, `creditcard`,
`credit_card`, `cardnumber`, `card_number`, `cvv`, `ssn`, `pin`.

An `Error` — or an object with a string `stack` — found anywhere in the context is replaced by
its description, not walked key by key: `logger.error('x', { error })` prints what
`logger.error('x', error)` prints.

> Masking only applies to the **context** object. It does **not** scan the `message`
> string. Never interpolate a secret into the message — `logger.info(\`token: ${t}\`)`
> is logged verbatim, unmasked. Put potentially-sensitive data in the context object so
> the masker can catch it.

---

## Errors are described, not dumped

Every error the logger is handed — as the error argument or inside the context — reaches a
transport only as `describeError(error)`. Pass the error object itself; never pre-stringify
it (`{ error: err.message }`, `String(err)`, `err.stack`), because the logger cannot see where a
string came from.

The reason is the database error. drizzle's `DrizzleQueryError` carries every bound value in
`params`, in its message (`Failed query: … params: …`) and in the stack header that repeats the
message; the driver's `PostgresError` under it adds `detail` (`Key (email)=(…) already exists.`,
`Failing row contains (…)`), `where` and `hint`. A description keeps none of them:

```typescript
interface DatabaseErrorDescription
{
    kind: 'database';
    name: string;               // 'DrizzleQueryError' | 'PostgresError' | …
    code?: string;              // SQLSTATE, or the driver's connection code
    severity?: string;
    constraint?: string; schema?: string; table?: string; column?: string; dataType?: string;
    routine?: string;
    message?: string;           // the driver's message, for SQLSTATE classes 08, 23, 40, 53, 57 only
    sql?: string;               // the SQL text with $n placeholders, truncated to 1000 characters
    paramCount?: number;        // how many values were bound — never the values
    stack?: string;             // frames only: the header lines are dropped
}

interface ErrorDescription
{
    kind: 'error';
    name: string;
    message: string;
    stack?: string;             // frames only
    cause?: ErrorDescription | DatabaseErrorDescription;
}
```

- The cause chain is walked; the first link that is a drizzle query error or a driver error
  becomes a database description, with the driver error under drizzle's folded into it.
- The driver's message is kept only for SQLSTATE classes whose messages name identifiers only:
  08 (connection), 23 (integrity constraint — the values are in `detail`), 40 (transaction
  rollback), 53 (insufficient resources), 57 (operator intervention). Class 22 messages quote the
  rejected input (`invalid input syntax for type integer: "…"`), 42601 quotes a token, P0001 is
  the app's own text: those, and unknown codes, keep no message. Neither does a message raised by
  PL/pgSQL `RAISE` (routine `exec_stmt_raise`), whatever ERRCODE it carries.
- The SQL text is kept: query-builder SQL holds `$n` placeholders only. A literal reaches it only
  through `sql.raw(…)` — an app that `sql.raw`s user input logs it, and has an injection bug.
- There is no option to log parameter values. To see them while debugging locally, use drizzle's
  `logger` or postgres.js `debug` on a client you own.
- Outside core's reach: drizzle's OpenTelemetry tracing sets `drizzle.query.params` on its spans.

The same description is what core stores and answers where an error leaves the process: a
failed job's `output` (see the job README), the non-production response body for a database
error (see the middleware README) and a `RepositoryError`'s `cause`.

---

## Output format

There is exactly one transport (`ConsoleTransport`) and it always renders the
human-readable console format — colorized when `NODE_ENV !== 'production'`, plain text
otherwise. Layout:

```
[timestamp] [pid=N] [module=name] [key=value]... (LEVEL): message
```

```
[2026-06-10 10:30:00.123] [pid=12345] [module=database] (INFO): Connection established
[2026-06-10 10:30:01.456] [pid=12345] [module=api] [userId=123] (ERROR): Request failed
Error: Connection timeout
    at processRequest (/app/src/api.ts:45:11)
```

Errors are printed on their own line after the message, as their description: `Name:
message`, for a database error a `[code=…] [constraint=…] [table=…]` line and the SQL with its
parameter count, the stack frames, and the `Caused by:` cause chain. In containers (Docker/K8s), set `NODE_ENV=production` so output is plain text on
stdout/stderr, which the platform collects automatically.

---

## Pitfalls & anti-patterns

- **`createLogger` / `withLogContext` don't exist.** Use `logger.child(name)` for scoping
  and pass context explicitly per call. There is no ambient/async context.
- **No JSON output.** `formatJSON` exists in the source but is unused; the only transport
  emits console text. "Production = JSON logs" (from old docs) is false — production just
  turns colors off.
- **Wrong env var.** The level comes from `SPFN_LOG_LEVEL` (or
  `NEXT_PUBLIC_SPFN_LOG_LEVEL`), **not** `LOG_LEVEL`.
- **Level is frozen at import.** Mutating `process.env.SPFN_LOG_LEVEL` after startup does
  nothing. Set it in the environment before launching.
- **Masked value is `***MASKED***`, not `***`.** Don't assert on `***` in tests/parsers.
- **Secrets in the message are NOT masked.** Only the context object is scanned. Keep
  sensitive values out of the message string; put them in context.
- **Context vs error ambiguity.** A plain object with a string `stack` property is treated
  as an error, not context. Use the 3-arg form `logger.error(msg, error, context)` when
  you have both, and don't put a `stack` key on a context object.
- **Bare primitives as 2nd arg become errors.** `logger.info('x', 42)` logs `42` as an
  Error (or printf-substitutes it if the message has a `%` token) — it is not context.
  Context must be an object: `logger.info('x', { n: 42 })`.
- **Don't import internals.** `maskSensitiveData`, `formatConsole`, `formatJSON`,
  `extractQueryInfo`, `formatUnhandledRejection`, `Logger` construction, etc. are not the
  public surface. Use the `logger` singleton + `child`.
- **No file transport.** `LOGGER_FILE_ENABLED` / `LOG_DIR` do nothing. Route stdout/stderr
  to your log collector (Loki/CloudWatch/ELK) instead.

---

## Complete example

```typescript
import { logger } from '@spfn/core/logger';

const dbLogger = logger.child('database');

async function createUser(input: { email: string; password: string }): Promise<void>
{
    dbLogger.debug('createUser called', { email: input.email });
    // 'password' in context would be auto-masked if included.

    try
    {
        await db.insert(/* ... */);
        dbLogger.info('User created', { email: input.email });
    }
    catch (error)
    {
        // 3-arg form: message + Error (stack + cause) + extra context
        dbLogger.error('User insert failed', error as Error, { email: input.email });
        throw error;
    }
}

// Graceful shutdown: flush transports
process.on('SIGTERM', async () =>
{
    logger.info('Shutting down');
    await logger.close();
    process.exit(0);
});
```

---

## Types reference

```typescript
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface Transport
{
    name: string;
    level: LogLevel;
    enabled: boolean;
    log(metadata: LogMetadata): Promise<void>;
    close?(): Promise<void>;
}
```

`LogMetadata` (the object passed to a `Transport.log`; not exported, shown for
implementers) carries `timestamp: Date`, `level`, `message`, optional `module`,
optional `error: ErrorDescription | DatabaseErrorDescription` (the description, never the
error object), and optional `context` (already masked).

`logger.level` is a `LogLevel` getter (read-only).

The `Transport` interface is public so you *could* implement a custom transport, but the
factory does not expose a registration hook — there is currently no supported way to add a
transport to the singleton without editing `factory.ts`.

---

## Related

- `@spfn/core` — package root (re-exports `logger`).
- `src/logger/factory.ts` — where the singleton + console transport are wired and the
  level is resolved from env.
