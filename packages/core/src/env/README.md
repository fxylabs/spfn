# @spfn/core/env — Environment Variable Management

Type-safe, schema-based environment variable validation, parsing, and security-focused
file separation for Next.js + SPFN server.

## Import paths

There are **two** entry points. Picking the wrong one breaks the build.

```typescript
// Schema, registry, parsers, type guards — isomorphic (no node:fs)
import { defineEnvSchema, createEnvRegistry, envString /* ... */ } from '@spfn/core/env';

// File loader — SERVER ONLY (uses node:fs). Never import in client/edge code.
import { loadEnv, loadEnvOnce } from '@spfn/core/env/loader';
```

`loadEnv` is **not** re-exported from `@spfn/core/env`. Import it from `@spfn/core/env/loader`.

---

## Public API (complete)

From `@spfn/core/env`:

- Schema helpers: `defineEnvSchema`, `envString`, `envNumber`, `envBoolean`, `envUrl`,
  `envEnum`, `envJson`
- Registry: `createEnvRegistry`, `EnvRegistry` (class), `validateAllEnv`
- Type guards: `isClientAccessible`, `isServerOnly`, `isNextjsAccessible`, `isSpfnServerOnly`
- Parsers: `parseString`, `createStringParser`, `parseBoolean`, `parseNumber`,
  `createNumberParser`, `parseInteger`, `parseDecimal`, `parseUrl`, `createUrlParser`,
  `parsePostgresUrl`, `parseRedisUrl`, `parseEnum`, `createEnumParser`, `parseJson`,
  `createJsonParser`, `parseArray`, `createArrayParser`, `createSecureSecretParser`,
  `createPasswordParser`
- Parser composition: `chain`, `withFallback`, `optional`
- Types: `Parser<T>`, `EnvVarSchema`, `EnvSchemaCollection`, `InferEnvType`,
  `EnvValidationResult`, `NodeEnv`, `LogLevel`

From `@spfn/core/env/loader`:

- `loadEnv`, `loadEnvOnce`, `resetEnvLoadState`
- Types: `LoadEnvOptions`, `LoadEnvResult`

> There is **no** `getEnvVar` / `requireEnvVar` / `hasEnvVar` / `getEnvVars` /
> `loadEnvironment` function, and **no** `env.get()` / `env.require()` /
> `getByCategory()` / `generateMarkdownDocs()` etc. Those belong to a removed API — do
> not use them. The current model is: define a schema, build a registry, call
> `.validate()`, read properties off the returned proxy.

---

## Quick Start

```typescript
// src/config/env.ts
import {
    defineEnvSchema,
    envString,
    envNumber,
    envBoolean,
    envEnum,
    createEnvRegistry,
    parsePostgresUrl,
} from '@spfn/core/env';

const schema = defineEnvSchema({
    DATABASE_URL: envString({
        description: 'PostgreSQL connection URL',
        required: true,
        sensitive: true,
        validator: parsePostgresUrl,
    }),
    PORT: envNumber({
        description: 'Server port',
        default: 3000,
    }),
    DEBUG: envBoolean({
        description: 'Enable debug mode',
        default: false,
    }),
    LOG_LEVEL: envEnum(['debug', 'info', 'warn', 'error'] as const, {
        description: 'Logging level',
        default: 'info',
    }),
});

const registry = createEnvRegistry(schema);
export const env = registry.validate();
export type Env = typeof env;

// Full type safety:
env.DATABASE_URL; // string  (required)
env.PORT;         // number  (default: 3000)
env.DEBUG;        // boolean (default: false)
env.LOG_LEVEL;    // 'debug' | 'info' | 'warn' | 'error'
```

`defineEnvSchema` auto-fills the `key` field from each object key. You can write the
schema object inline without it, but then you must set `key` manually on every entry —
prefer `defineEnvSchema`.

---

## Schema Definition

### Type helpers

| Helper | Result type | Default validator |
|--------|-------------|-------------------|
| `envString(options)` | `string` | identity (no-op) |
| `envNumber(options)` | `number` | `parseNumber` |
| `envBoolean(options)` | `boolean` | `parseBoolean` |
| `envUrl(options)` | `string` | none (set `validator` yourself, e.g. `parsePostgresUrl`) |
| `envEnum(allowed, options)` | union of `allowed` | built-in membership check |
| `envJson<T>(options)` | `T` | `parseJson` |

```typescript
API_KEY: envString({
    description: 'API authentication key',
    required: true,
    sensitive: true,
    minLength: 32,
}),

PORT: envNumber({
    description: 'Server port',
    default: 3000,
    validator: createNumberParser({ min: 1, max: 65535, integer: true }),
}),

// envUrl has NO default validator — add one for protocol enforcement:
API_URL: envUrl({
    description: 'API endpoint URL',
    required: true,
    validator: createUrlParser('https'),
}),

LOG_LEVEL: envEnum(['debug', 'info', 'warn', 'error'] as const, {
    description: 'Logging level',
    default: 'info',
}),

CONFIG: envJson<{ host: string; port: number }>({
    description: 'JSON configuration',
    required: true,
}),
```

### `EnvVarSchema` options

| Option | Type | Description |
|--------|------|-------------|
| `description` | `string` | Purpose / usage (used in CLI validate output) |
| `type` | `'string' \| 'number' \| 'boolean' \| 'url' \| 'enum' \| 'json'` | Set by the helper; don't pass manually |
| `required` | `boolean` | Throw at access time if unset and no default |
| `default` | `T` | Value returned when the variable is unset |
| `validator` | `(value: string) => T` | Parse/validate. Throwing fails validation |
| `fallbackKeys` | `string[]` | Legacy keys read (in order) when the primary key is unset |
| `minLength` | `number` | Minimum raw string length (checked before `validator`) |
| `sensitive` | `boolean` | Marks a secret; triggers a warning if `NEXT_PUBLIC_*` |
| `examples` | `T[]` | Example values (metadata only) |
| `nextjs` | `boolean` | File-separation hint (see below). Defaults to `true` for `NEXT_PUBLIC_*`, else `false` |

> There is **no** `category` option. Docs that show `category: '...'` are stale — passing
> it is harmless (excess property) but it does nothing.

### Type inference (`InferEnvType`)

```typescript
import type { InferEnvType } from '@spfn/core/env';

const schema = defineEnvSchema({
    DATABASE_URL: envString({ description: 'DB URL', required: true }),
    PORT: envNumber({ description: 'Port', default: 3000 }),
    DEBUG: envBoolean({ description: 'Debug' }),
});

type Env = InferEnvType<typeof schema>;
// {
//   DATABASE_URL: string;        // required: true  → required
//   PORT: number;                // has default     → required
//   DEBUG?: boolean | undefined; // neither         → optional
// }
```

Rule: `required: true` **or** a `default` present ⇒ required field. Otherwise optional
(`| undefined`). `registry.validate()` returns `InferEnvType<typeof schema>`.

---

## Registry

```typescript
import { createEnvRegistry } from '@spfn/core/env';

const registry = createEnvRegistry(schema); // or: new EnvRegistry(schema)
const env = registry.validate();
```

### Lazy validation (timing matters)

`registry.validate()` performs **only schema-level checks** (e.g. sensitive + client-
accessible warnings) and returns a **Proxy**. Each individual variable is read from
`process.env`, defaulted, and run through its `validator` **at the moment you access the
property** — not when `validate()` is called.

```typescript
const env = registry.validate(); // does NOT read process.env values yet
loadEnv();                        // dotenv files populate process.env
env.DATABASE_URL;                 // value is read + validated HERE
```

Consequences:

- You can call `validate()` before `loadEnv()` — values are picked up lazily. This is the
  intended order for the SPFN server entry point.
- A missing `required` variable does **not** throw at `validate()` time; it throws on
  first access (`Error('Environment validation failed')`, with the offending key logged).
- Accessing an unknown key (not in the schema) returns `undefined`.

### Skipping validation

Set `SKIP_ENV_VALIDATION=true` (or `=1`) to make the proxy skip the `required` check —
missing required vars return their `default` (or `undefined`) instead of throwing. Useful
for build steps that don't have secrets. `validator`/`minLength` checks still apply when a
value is present. **`EnvRegistry.validateAll()` ignores this flag** and always reports
missing requireds.

### `validateAll()` / `validateAllEnv()` (eager, for CLI)

For an explicit up-front check of *all* variables (used by `spfn env validate`):

```typescript
import { validateAllEnv } from '@spfn/core/env';

const result = validateAllEnv([coreRegistry, authRegistry]); // EnvValidationResult
if (!result.valid) {
    for (const e of result.errors) {
        console.error(`${e.key}: ${e.message}`);
    }
    process.exit(1);
}
for (const w of result.warnings) {
    console.warn(`${w.key}: ${w.message}`);
}
```

`EnvValidationResult` is `{ valid: boolean; errors: {key,message}[]; warnings: {key,message}[] }`.
A single registry exposes the same via `registry.validateAll()` returning just
`{ errors, warnings }`.

Messages carry the key and the rule, never the value. For a `sensitive` key the validator's
own message is replaced by `(value hidden — sensitive key)`, because a validator may echo its
input; core's parsers describe the expected shape instead of quoting the input. An app
validator on a non-sensitive key should do the same.

### Boot-time check (the server)

`startServer()` runs `validateAllEnv` right after loading the env files and the app's
`server.config`, before it initializes infrastructure or listens. The list is `@spfn/core`'s
registry plus the registries the app hands over in `server.config`:

```typescript
// src/server/config/env.config.ts
export const envSchema = defineEnvSchema({ /* ... */ });
export const envRegistry = createEnvRegistry(envSchema);
export const env = envRegistry.validate();

// src/server/server.config.ts
import { envRegistry } from '@/server/config/env.config';

export default defineServerConfig()
    .env({ registries: [envRegistry] })
    .build();
```

On failure it logs each key with its reason (never a value) and exits with code 1. A
package's variables are checked only when the app passes a registry for them —
`createEnvRegistry(envSchema)` over the schema the package exports from `./config`.

- `SKIP_ENV_VALIDATION` does not apply: it relaxes the lazy proxy for build steps, and a
  server about to serve is not a build step.
- `createServerlessApp()` runs the same check and rejects its promise instead of exiting.
- `createServer()` (the app factory both of them use) and `provisionInfrastructure()` do not
  run it.
- `@spfn/core` itself requires `SPFN_API_URL`, so the server process needs it set.
  `NEXT_PUBLIC_SPFN_API_URL` is optional there: Next.js inlines it at build time and the
  server falls back to `SPFN_API_URL`.

### The app's schema in the CLI (`spfn.config.js` `env.schemas`)

`spfn env` and `spfn secret` find a package's schema at `<package>/config`; an app's own
schema can live anywhere, so `spfn.config.js` names it:

```js
// spfn.config.js
export default {
    env: {
        schemas: ['src/server/config/env.config.ts'], // modules exporting `envSchema`
    },
};
```

Paths are relative to the project root; TypeScript and tsconfig path aliases are supported.
Without `-p <package>`, the CLI reads these modules plus every installed `@spfn/*` package
whose `./config` exports `envSchema`, and groups its output by source. A key two sources
declare identically is listed once; two declarations that differ in type, `required` or
`sensitive` are an error naming the key and both sources — one variable has one owner, and
other packages read it from the owner's `env` instead of declaring it again.

### Fallback keys

```typescript
DATABASE_URL: envString({
    description: 'Database URL',
    required: true,
    fallbackKeys: ['DB_URL', 'POSTGRES_URL'], // tried in order if DATABASE_URL is unset
}),
```

### Other `EnvRegistry` methods

`register(schema)`, `registerMultiple(schemas)` — add schemas after construction.
`reset()` — clears the internal "already validated" flag (test helper).

---

## Environment File Loading

`loadEnv` is server-only (`@spfn/core/env/loader`). It parses `.env*` files, merges them,
and writes into `process.env`.

```typescript
import { loadEnv } from '@spfn/core/env/loader';
import { createEnvRegistry } from '@spfn/core/env';
import { envSchema } from './env.schema';

loadEnv();                                  // server entry point
const env = createEnvRegistry(envSchema).validate();
```

### Loading priority (5 tiers, low → high; later overrides earlier)

`NODE_ENV` (default `'local'`) selects which files apply:

1. `.env`                   — common defaults (committed)
2. `.env.{NODE_ENV}`        — per-environment override (committed)
3. `.env.local`             — local override (gitignored; **skipped when `NODE_ENV=test`**)
4. `.env.{NODE_ENV}.local`  — per-environment secrets (gitignored)
5. `.env.server`            — SPFN-server-only secrets (gitignored; **never read by Next.js**)

Within `loadEnv`, **keys already present in `process.env` are not overwritten** (so
platform-injected vars win) unless `override: true`.

### `LoadEnvOptions`

```typescript
loadEnv({
    cwd: '/path/to/project', // project root        (default: process.cwd())
    nodeEnv: 'production',   // selects .env.{nodeEnv} (default: process.env.NODE_ENV || 'local')
    server: true,            // include .env.server  (default: true; set false for Next.js client builds)
    debug: true,             // log loaded files     (default: false)
    override: false,         // overwrite existing process.env keys (default: false)
});
```

`loadEnv` returns `LoadEnvResult` = `{ loadedFiles: string[]; loadedKeys: string[] }`.

### `loadEnvOnce()` / `resetEnvLoadState()`

`loadEnvOnce(options?)` runs `loadEnv` once per process; subsequent calls return an empty
result. `resetEnvLoadState()` clears that latch (test helper).

### Next.js does its own loading

Next.js loads `.env` / `.env.local` / `.env.{NODE_ENV}` itself. In Next.js code (server
components, route handlers) **do not call `loadEnv()`** — just build the registry and read
values. `.env.server` is intentionally invisible to Next.js (that is the whole point of
the separation below).

---

## Security Separation (Next.js + SPFN)

SPFN runs as a **separate process** from Next.js. Next.js server components can read every
variable in `.env` / `.env.local`; a server-side data-exfiltration bug (e.g. a
react2shell-style vulnerability) would expose all of them. Keep server-only secrets out of
files Next.js reads.

### File layout

```
project/
├── .env                    # common defaults              (committed)
├── .env.production         # production non-secret overrides (committed)
├── .env.local              # Next.js local overrides      (gitignored)
├── .env.production.local   # production secrets            (gitignored)
└── .env.server             # SPFN-server-only secrets      (gitignored)
```

Commit a `.env.server.example` template (placeholder values only) so teammates know which
keys to fill in.

### Which file for what?

| Variable | File | Why |
|----------|------|-----|
| `NEXT_PUBLIC_*` | `.env.local` | Client-exposed; browser-safe |
| `SPFN_API_URL` (per-env) | `.env` / `.env.production` | Used by Next.js too; non-secret |
| `SPFN_APP_URL` | `.env.local` | Next.js local setting |
| `DB_POOL_MAX` | `.env.server` | Server-only, non-secret |
| `DATABASE_URL` | `.env.server` | Server-only, **secret** |
| `SESSION_SECRET` | `.env.server` | Server-only, **secret** |

Rule of thumb: anything Next.js must read goes in `.env` / `.env.local`; everything
server-only (especially secrets) goes in `.env.server`.

### Schema `nextjs` flag

`nextjs` documents which process a variable belongs to. Defaults: `true` for
`NEXT_PUBLIC_*`, `false` otherwise. The type guards below consume it.

```typescript
DATABASE_URL: envString({
    description: 'PostgreSQL connection URL',
    required: true,
    sensitive: true,
    nextjs: false,   // SPFN-server-only → belongs in .env.server
}),

SPFN_API_URL: envString({
    description: 'Backend API URL',
    required: true,
    nextjs: true,    // Next.js also reads it → .env / .env.local
}),

NEXT_PUBLIC_WS_URL: envString({
    description: 'WebSocket URL',
    // nextjs defaults to true (NEXT_PUBLIC_ prefix)
}),
```

### Type guards

```typescript
import {
    isClientAccessible, isServerOnly,
    isNextjsAccessible, isSpfnServerOnly,
} from '@spfn/core/env';

isClientAccessible('NEXT_PUBLIC_API_URL'); // true  — string key, NEXT_PUBLIC_ prefix
isClientAccessible('DATABASE_URL');        // false
isServerOnly('DATABASE_URL');              // true  — inverse of isClientAccessible

// These take a SCHEMA object (not a string) and honor the `nextjs` flag:
isNextjsAccessible(schema.SPFN_API_URL);   // true
isSpfnServerOnly(schema.DATABASE_URL);     // true  — inverse of isNextjsAccessible
```

> `isClientAccessible` / `isServerOnly` take a **string key**.
> `isNextjsAccessible` / `isSpfnServerOnly` take an **`EnvVarSchema` object** and respect
> its `nextjs` flag. Don't mix them up.

### Sensitive-on-client warning

`registry.validate()` (and `validateAll()`) emit a warning if a `sensitive` variable is
client-accessible — fix it by dropping the `NEXT_PUBLIC_` prefix, not by unmarking it:

```typescript
// Wrong — secret exposed to the browser, triggers a warning:
NEXT_PUBLIC_API_SECRET: envString({ description: 'secret', sensitive: true }),

// Right:
API_SECRET: envString({ description: 'secret', sensitive: true }),
```

---

## Parsers

All parsers are `(value: string) => T` and **throw** on invalid input. Use them as a
schema `validator`, or standalone.

### String

```typescript
import { parseString, createStringParser } from '@spfn/core/env';

parseString('  hello  '); // 'hello' (trims; throws if empty)

createStringParser({ minLength: 32, maxLength: 128, pattern: /^[A-Za-z0-9_-]+$/, trim: true });
```

### Boolean

```typescript
import { parseBoolean } from '@spfn/core/env';

parseBoolean('true' /* | '1' | 'yes' */);  // true   (case-insensitive)
parseBoolean('false' /* | '0' | 'no' */);  // false
// anything else → throws
```

### Number

```typescript
import {
    parseNumber, createNumberParser, parseInteger, parseDecimal,
} from '@spfn/core/env';

parseNumber('42');                                  // 42
parseNumber('42', { min: 1, max: 100, integer: true });
createNumberParser({ min: 1, max: 65535, integer: true });
parseInteger('42', { min: 1, max: 100 });           // integer-constrained
parseDecimal('0.75', { min: 0, max: 1 });           // float-constrained
```

> The float helper is named **`parseDecimal`**. There is no `parseFloat` export.

### URL

```typescript
import {
    parseUrl, createUrlParser, parsePostgresUrl, parseRedisUrl,
} from '@spfn/core/env';

parseUrl('https://api.example.com');             // any protocol
parseUrl('https://x', { protocol: 'https' });    // enforce protocol
createUrlParser('https');                         // reusable
parsePostgresUrl('postgres://u:p@host:5432/db');  // postgres:// or postgresql://
parseRedisUrl('redis://localhost:6379');          // redis:// or rediss://
```

### Enum

```typescript
import { parseEnum, createEnumParser } from '@spfn/core/env';

parseEnum('info', ['debug', 'info', 'warn', 'error']);
createEnumParser(['debug', 'info', 'warn', 'error'], true /* caseInsensitive */);
```

> For schema fields prefer the `envEnum(allowed, options)` helper — it produces a precise
> string-literal union type. `parseEnum`/`createEnumParser` return a plain `string`.

### JSON

```typescript
import { parseJson, createJsonParser } from '@spfn/core/env';

parseJson('{"host":"localhost","port":3000}');
createJsonParser<{ host: string; port: number }>();
```

### Array

```typescript
import { parseArray, createArrayParser, createNumberParser } from '@spfn/core/env';

parseArray('a,b,c');                       // ['a','b','c']
parseArray('a|b|c', { separator: '|' });   // ['a','b','c']  (empty string → [])

createArrayParser(createNumberParser({ min: 1, max: 65535, integer: true }))('3000,4000');
// → [3000, 4000]
```

### Secrets & passwords

```typescript
import { createSecureSecretParser, createPasswordParser } from '@spfn/core/env';

// Entropy-based secret check (Shannon entropy in bits/char)
createSecureSecretParser({ minLength: 32, minUniqueChars: 16, minEntropy: 3.5 });
// reference: random lowercase ~4.7 · alphanumeric ~5.2 · printable ASCII ~6.6 · "aaaa" ~0

createPasswordParser({
    minLength: 12,
    requireUppercase: true,
    requireLowercase: true,
    requireNumber: true,
    requireSpecial: true,
});
```

### Composition

```typescript
import { chain, withFallback, optional, parseString, createStringParser, parseRedisUrl, parseJson } from '@spfn/core/env';

chain(parseString, createStringParser({ minLength: 32 }));  // run sequentially
withFallback(parseJson, { host: 'localhost' });             // return fallback if parser throws
optional(parseRedisUrl);                                    // '' → undefined, else parse
```

---

## Pitfalls & anti-patterns

- **Don't import `loadEnv` from `@spfn/core/env`.** It lives in `@spfn/core/env/loader`
  (server-only, uses `node:fs`). Importing the loader into client/edge code breaks bundling.
- **`.env.server.local` does not exist.** The loader's 5 tiers are `.env`,
  `.env.{NODE_ENV}`, `.env.local`, `.env.{NODE_ENV}.local`, `.env.server`. Do not invent a
  `.env.server.local` file — it is never loaded.
- **`.env.server` is gitignored and Next.js-invisible by design.** Commit
  `.env.server.example` as the template; never put secrets in `.env`/`.env.local`/committed
  files.
- **Don't call `loadEnv()` inside Next.js.** Next.js already loads `.env*` (minus
  `.env.server`). Calling `loadEnv` there is redundant and, with `server: true`, would pull
  server secrets into the Next.js process — defeating the separation.
- **`validate()` is lazy.** It does not throw for missing required vars; the throw happens
  on first property access. For an eager all-at-once check (CI/startup gate) use
  `validateAllEnv([...])` / `registry.validateAll()`.
- **`envUrl` has no built-in validator.** Without `validator`, it only enforces presence —
  add `parsePostgresUrl` / `createUrlParser('https')` etc. for actual URL validation.
- **`sensitive: true` + `NEXT_PUBLIC_` is wrong.** It only emits a warning, not an error —
  the secret is still exposed. Remove the prefix.
- **`SKIP_ENV_VALIDATION` only skips the `required` check** (and only in the lazy proxy);
  present values are still validated, and `validateAll()` — and with it the server's boot
  check — ignores the flag entirely.
- **A validator message must not contain the value.** Validation errors are logged. Throw
  `'Must be a valid number'`, not `` `got: ${value}` ``.
- **Removed API.** `getEnvVar`, `requireEnvVar`, `hasEnvVar`, `getEnvVars`,
  `loadEnvironment`, `namespace`/`useFolderStructure`/`customPaths`/`useCache` loader
  options, `env.get()`/`env.require()`, `getByCategory()`/`getAllSchemas()`,
  `generateMarkdownDocs`/`generateEnvExample`/`generateJsonDocs`, and the `category` schema
  option **do not exist**. Some validator JSDoc still shows `getEnvVar(...)` in examples —
  that is stale; use the schema-`validator` pattern instead.

---

## Complete example

```typescript
// src/config/env.ts
import {
    defineEnvSchema,
    envString, envNumber, envBoolean, envEnum, envUrl,
    createEnvRegistry,
    parsePostgresUrl, createNumberParser, createSecureSecretParser, createUrlParser,
} from '@spfn/core/env';

const schema = defineEnvSchema({
    DATABASE_URL: envString({
        description: 'PostgreSQL connection URL',
        required: true,
        sensitive: true,
        nextjs: false,
        validator: parsePostgresUrl,
    }),
    PORT: envNumber({
        description: 'Server port',
        default: 3000,
        validator: createNumberParser({ min: 1, max: 65535, integer: true }),
    }),
    HOST: envString({ description: 'Server host', default: '0.0.0.0' }),
    SESSION_SECRET: envString({
        description: 'Session encryption secret',
        required: true,
        sensitive: true,
        nextjs: false,
        validator: createSecureSecretParser({ minLength: 32 }),
    }),
    NODE_ENV: envEnum(['local', 'development', 'staging', 'production', 'test'] as const, {
        description: 'Node environment',
        default: 'local',
    }),
    LOG_LEVEL: envEnum(['debug', 'info', 'warn', 'error', 'fatal'] as const, {
        description: 'Log level',
        default: 'info',
    }),
    REDIS_URL: envUrl({
        description: 'Redis connection URL (optional)',
        required: false,
        validator: createUrlParser('any'),
    }),
    DEBUG: envBoolean({ description: 'Enable debug mode', default: false }),
});

const registry = createEnvRegistry(schema);
export const env = registry.validate();
export type Env = typeof env;
```

```typescript
// SPFN server entry point
import { loadEnv } from '@spfn/core/env/loader';
import { env } from '@/config/env';

loadEnv();              // populate process.env from .env* (server reads .env.server too)
console.log(env.PORT);  // validated lazily on access
```

```typescript
// Next.js — no loadEnv()
import { env } from '@/config/env';
const dbUrl = env.DATABASE_URL; // (only resolves if DATABASE_URL is in the Next.js process)
```

---

## Types reference

```typescript
type NodeEnv  = 'local' | 'development' | 'staging' | 'production' | 'test';
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal'; // re-exported from logger
type Parser<T> = (value: string) => T;
```

## Related

- [@spfn/core/config](../config/README.md) — application configuration
- [@spfn/core/logger](../logger/README.md) — logging infrastructure
- [@spfn/core](../../README.md) — main package documentation
