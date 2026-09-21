# @spfn/core/codegen — Code generation (route-map & custom generators)

Pluggable code-generation system with a single shared file watcher. The orchestrator
runs a list of generators once (build / manual) or continuously (watch). The one built-in
generator is `@spfn/core:route-map`, which produces the `routeName → {method, path}` map
the RPC proxy needs.

## Import paths

```typescript
// Single entry point — everything is exported from here:
import {
    defineConfig, defineGenerator,
    loadCodegenConfig, createGeneratorsFromConfig,
    CodegenOrchestrator,
} from '@spfn/core/codegen';

import type {
    CodegenConfig, GeneratorConfig,
    Generator, GeneratorOptions, GeneratorTrigger,
    OrchestratorOptions,
    RouteMapGeneratorConfig,
} from '@spfn/core/codegen';
```

There is no `@spfn/core/codegen/loader` or other sub-path — everything ships from
`@spfn/core/codegen`.

---

## Public API (complete)

Functions:

- `defineConfig(config: CodegenConfig): CodegenConfig` — identity helper for `.spfnrc.ts`.
- `defineGenerator<T>(config: T): T` — identity helper that carries a generator config's
  type through to the array (so `name`/options are type-checked).
- `loadCodegenConfig(cwd: string): CodegenConfig` — reads `.spfnrc.ts` → `.spfnrc.json` →
  `package.json` (first hit wins). Returns `{ generators: [] }` if none found.
- `createGeneratorsFromConfig(config, cwd): Promise<Generator[]>` — resolves each config
  entry into a live `Generator` (loads packages / `.ts` files via jiti).

Class:

- `CodegenOrchestrator` — `new CodegenOrchestrator(options)`, then `generateAll(trigger?)`,
  `watch()`, `close()`.

Types:

- `CodegenConfig`, `GeneratorConfig`
- `Generator`, `GeneratorOptions`, `GeneratorTrigger`
- `OrchestratorOptions`
- `RouteMapGeneratorConfig` (config shape for the built-in route-map generator)
- `ContractGeneratorConfig` (config shape for the built-in contract generator)
- `ContractGeneratorError`, `ConditionalRegistrationError`, `assertUnconditionalRegistration`
- `RouteContractMapping`, `ResourceRoutes`, `ClientGenerationOptions`, `GenerationStats`
  (legacy client-generation types — exported but not used by any shipped generator)

> **Renamed: `defineCodegenConfig` → `defineConfig`.** The old name does **not** exist.
> Older docs also show an `api-client` / `createApi`-emitting generator and
> `codegen.config.ts` — those are **removed**. The built-in generators today are
> `@spfn/core:route-map` and `@spfn/core:contract`, configured in `.spfnrc.ts`. Do not
> import `defineCodegenConfig` or configure a `name: 'api-client'` generator.

---

## Quick Start

### 1. Configure `.spfnrc.ts`

```typescript
import { defineConfig, defineGenerator } from '@spfn/core/codegen';

export default defineConfig({
    generators: [
        defineGenerator({
            name: '@spfn/core:route-map',
            routerPath: './src/server/router.ts',
            outputPath: './src/generated/route-map.ts', // optional (this is the default)
        }),
    ],
});
```

### 2. Generate

```bash
spfn codegen run      # run all generators once
spfn dev              # watch mode (regenerates on file change)
```

This writes `src/generated/route-map.ts`, which the RPC proxy imports.

---

## Configuration resolution

`loadCodegenConfig(cwd)` checks these in order and returns the **first** that exists:

1. `.spfnrc.ts` — loaded with jiti (supports `defineConfig`/`defineGenerator` + TS types).
   The default export (or the module itself) is the `CodegenConfig`.
2. `.spfnrc.json` — the config is read from the top-level **`codegen`** key:
   `{ "codegen": { "generators": [...] } }`.
3. `package.json` — read from **`spfn.codegen`**: `{ "spfn": { "codegen": { ... } } }`.

If none exist (or parsing fails), you get `{ generators: [] }` and nothing runs.

> Precedence is "first file found wins", not a deep merge. A `.spfnrc.ts` fully shadows
> `.spfnrc.json` and `package.json`.

### Generator config entries (`GeneratorConfig`)

A `generators[]` entry is one of three shapes:

| Shape | Example | Meaning |
|-------|---------|---------|
| Package generator | `{ name: 'pkg:gen', enabled?: true, ...opts }` | Loaded from `${pkg}/codegen`. `name` **must** contain `:`. `enabled: false` skips it. Extra keys are passed to the factory. |
| File generator | `{ path: './src/generators/x.ts' }` | A `.ts`/`.js` file whose default export is a `() => Generator` factory. `.ts` loaded via jiti. |
| Pre-built instance | `defineGenerator({...})` result that already has a `generate` fn | Pushed as-is (guards against accidentally calling a factory yourself). |

For package generators, `name` is split on `:` into `package:generatorName`. The loader
imports `${package}/codegen` and looks for `generators[generatorName]`, falling back to a
`create<Name>Generator` export. So `@spfn/core:route-map` → import `@spfn/core/codegen`,
call `generators['route-map'](config)`.

---

## Built-in: `@spfn/core:route-map`

Loads your router and emits a `routeName → {method, path}` map. This map is
what the **RPC proxy** (`createRpcProxy` in `@spfn/core/nextjs/server`) uses to turn
`api.getUser.call(...)` into an HTTP request — it needs `method` and `path` without
importing server code into the client bundle.

### `RouteMapGeneratorConfig`

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `'@spfn/core:route-map'` | yes | — | Generator identifier (literal). |
| `routerPath` | `string` | yes | — | Router file, relative to project root. Throws at construction if missing. |
| `outputPath` | `string` | no | `'./src/generated/route-map.ts'` | Where the map is written (parent dirs auto-created). |
| `additionalRouteDirs` | `string[]` | no | `[]` | **Deprecated and ignored** for collection; still added to `watchPatterns` as `${dir}/**/*.ts`. |

### What it reads

The router module is loaded with jiti (`appRouter` → `default` → `router`) and walked the
way `registerRoutes` walks it. How the router is *written* does not matter: a one-line
`defineRouter({ createUser })`, an aliased key `create: createUser`, and a second
`defineRouter(` in the same file all produce the same map.

- A **nested router** recurses to any depth and its routes land in the map **flat, under
  their own keys** — the parent's key names the grouping, not the route, exactly as the
  server registers them.
- `method` and `path` come from the `RouteDef`, not from a pattern over the source. A
  route not registered in the router is absent, because there is nothing registering it.
- **`.packages()` routers are left out**, at every depth. A package publishes its own
  route map and the app merges them (`{ ...routeMap, ...authRouteMap }`).
- A name that is not a JS identifier (`'get-user'`) is emitted quoted, so the generated
  file still parses.

### When it refuses

Unlike the old source parser, which dropped what it could not read, the generator throws
— logged always, and fatal on the `build` trigger:

- The module will not load (it names the file and the cause, and says a route module must
  be importable without side effects). It never falls back to parsing.
- No router is found under `appRouter`, `default` or `router` (the message lists all three).
- Two routes reach the same name (the message names both places).
- A route has no method or path — reachable by registering a route before `.handler()` was
  called. The server drops such a route too, so naming it in the map would advertise a
  route that 404s.
- A router entry is neither a route nor a router.

A **missing router file** is still only a warning: the generator returns and writes nothing.

### Generated output

```typescript
// src/generated/route-map.ts  — DO NOT EDIT
import type { HttpMethod } from '@spfn/core/route';

export interface RouteInfo
{
    method: HttpMethod;
    path: string;
}

export const routeMap: Record<string, RouteInfo> = {
    getUser: { method: 'GET', path: '/users/:id' },
    createUser: { method: 'POST', path: '/users' },
};

export type RouteMap = typeof routeMap;
export type RouteName = keyof RouteMap;
```

`watchPatterns` are `[routerPath, 'src/server/routes/**/*.ts', ...additionalRouteDirs]` and
`runOn` is `['watch', 'manual', 'build']` — every trigger the CLI fires, so it runs in every mode.

---

## Built-in: `@spfn/core:contract`

Writes `contracts/current.json` — every route carrying `.contract()` — and on a **build** compares
it against the newest released snapshot, refusing changes that would break a client already in the
field. Full behaviour lives in [`../contract/README.md`](../contract/README.md); this section is the
generator's own surface.

### `ContractGeneratorConfig`

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `'@spfn/core:contract'` | yes | — | Generator identifier (literal). |
| `routerPath` | `string` | yes | — | Router file, relative to project root. Throws at construction if missing. |
| `routerExport` | `string` | no | `appRouter` → `default` → `router` | Export holding the `defineRouter()` result. |
| `outputDir` | `string` | no | `'./contracts'` | Holds `current.json`, `released/`, `usage/`. |
| `additionalRouteDirs` | `string[]` | no | `[]` | Extra route dirs to watch. |

### How it differs from route-map

| | `route-map` | `contract` |
|---|---|---|
| Reads the router by | loading the module and walking `RouteDef`s | the same |
| Covers | every registered route | only routes carrying `.contract()` |
| `runOn` | `watch`, `manual`, `build` | `watch`, `build`, `manual` |
| Can fail a build | no | **yes**, on the `build` trigger only |

Loading rather than parsing is what makes the contract correct: real routes build schemas from
imported values (`EmailSchema`, `FileSchema()`, constants) that a source parser cannot resolve. It
costs a module import and no infrastructure — `@spfn/auth`'s 43 routes load in ~0.6s with neither
`DATABASE_URL` nor `CACHE_URL` set.

### When it refuses

- The router file is missing, or the module will not load (it names the module and the cause —
  it never skips quietly).
- No router export is found under the configured or default names.
- Two contracted routes share a name, or a contracted route has no method, path, `since` or
  `response`.
- `defineRouter({...})` contains a computed spread (`...(flag ? { route } : {})`), which would make
  the contract describe whichever way the generator happened to run.
- On the `build` trigger only: the contract breaks the newest released snapshot.

`spfn dev` generates but never refuses — being unable to hold a half-finished route mid-edit would
make the feature unusable.

---

## CLI

Provided by the `spfn` CLI (`@spfn/cli`), not by `@spfn/core` itself:

```bash
spfn codegen init     # scaffold a .spfnrc.ts
spfn codegen list     # list resolved generators + their watch patterns  (alias: ls)
spfn codegen run      # run all generators once (CodegenOrchestrator.generateAll, trigger 'manual')
spfn dev              # dev server + codegen in watch mode
spfn build            # runs codegen once before building (trigger 'build'; a failure exits 1)

spfn contract check      # regenerate the contract, compare against the newest released snapshot
spfn contract release X  # write contracts/released/X.json
spfn contract list       # released snapshots  (alias: ls)
```

`spfn codegen run` has **no** `--name` flag — it always runs every configured generator.
(The `spfn init` project scaffold writes a `.spfnrc.ts` preconfigured with the route-map
generator and adds a `"codegen": "spfn codegen run"` npm script.)

---

## Programmatic usage

```typescript
import {
    CodegenOrchestrator,
    loadCodegenConfig,
    createGeneratorsFromConfig,
} from '@spfn/core/codegen';

const cwd = process.cwd();
const config = loadCodegenConfig(cwd);
const generators = await createGeneratorsFromConfig(config, cwd);

const orchestrator = new CodegenOrchestrator({ generators, cwd, debug: true });

// Run once. Trigger defaults to 'manual'; only generators whose runOn includes it execute.
await orchestrator.generateAll();            // 'manual'
await orchestrator.generateAll('build');     // what `spfn build` dispatches

// Watch mode: runs an initial 'watch' pass, then returns a promise that stays pending
// (keeping the process alive) until close() is called.
await orchestrator.watch();
// ...later, to shut down: await orchestrator.close();
```

### `OrchestratorOptions`

```typescript
interface OrchestratorOptions
{
    generators: Generator[];
    cwd?: string;          // default: process.cwd()
    debug?: boolean;       // default: false
    throwOnError?: boolean; // default: false
}
```

`throwOnError` decides what a generator failure does. Off — the default — it is logged and the
run continues, which is what keeps watch mode alive through a half-edited file. `spfn build`
turns it on: a generator that refuses at build time (a broken route contract, a router that will
not load) has to reach the exit code, or the refusal scrolls past and the build ships anyway.

---

## Custom generators

A generator is a plain object implementing the `Generator` interface. Register it by
`path` (file) or by exporting it from a package's `./codegen` entry.

### File-based

```typescript
// src/generators/admin-nav-generator.ts
import type { Generator, GeneratorOptions } from '@spfn/core/codegen';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// Default export MUST be a zero-arg factory returning a Generator.
export default function createAdminNavGenerator(): Generator
{
    return {
        name: 'admin-nav',
        watchPatterns: ['src/app/admin/**/nav.config.tsx'],
        runOn: ['watch', 'manual', 'build'],

        async generate(options: GeneratorOptions): Promise<void>
        {
            const out = join(options.cwd, 'src/lib/admin/nav-data.generated.tsx');
            mkdirSync(dirname(out), { recursive: true });
            // ...scan source, write `out`
        },
    };
}
```

```typescript
// .spfnrc.ts
import { defineConfig } from '@spfn/core/codegen';

export default defineConfig({
    generators: [
        { path: './src/generators/admin-nav-generator.ts' },
    ],
});
```

### Package-based

```typescript
// my-package/src/codegen/index.ts
import { createMyGenerator } from './my-generator';

// The loader looks up `generators[name]` by the part after the ':'.
export const generators = {
    'my-generator': createMyGenerator,   // factory: (config) => Generator
};
```

```jsonc
// my-package/package.json — must expose ./codegen
{ "exports": { "./codegen": { "import": "./dist/codegen/index.js", "types": "./dist/codegen/index.d.ts" } } }
```

```typescript
// consumer .spfnrc.ts
defineGenerator({ name: 'my-package:my-generator', enabled: true, /* ...opts */ });
```

The factory receives the config object with `name` and `enabled` stripped out (everything
else is passed through as options).

### `Generator` interface

```typescript
type GeneratorTrigger = 'watch' | 'manual' | 'build' | 'start';

interface Generator
{
    name: string;
    watchPatterns: string[];                 // globs; orchestrator watches their base dirs
    runOn?: GeneratorTrigger[];              // default ['watch', 'manual', 'build']
    generate(options: GeneratorOptions): Promise<void>;
}

interface GeneratorOptions
{
    cwd: string;
    debug?: boolean;
    trigger?: {
        type: GeneratorTrigger;
        changedFile?: { path: string; event: 'add' | 'change' | 'unlink' };  // watch only
    };
    [key: string]: any;
}
```

For incremental rebuilds, check `options.trigger?.changedFile` and fall back to full
regeneration when it's absent (build/manual passes don't set it).

---

## Pitfalls & anti-patterns

- **`defineCodegenConfig` does not exist — use `defineConfig`.** Likewise there is no
  `api-client` built-in generator, no `createApi`-emitting codegen, and no
  `codegen.config.ts`. The current model is `.spfnrc.ts` + `@spfn/core:route-map`. Any doc
  showing those is stale.
- **`.spfnrc.json` / `package.json` need the wrapper key.** JSON config lives under
  `"codegen"` (in `.spfnrc.json`) or `"spfn": { "codegen": ... }` (in `package.json`). A
  top-level `{ "generators": [...] }` in `.spfnrc.json` is ignored. (A `.spfnrc.ts` default
  export, by contrast, *is* the config directly.)
- **Config precedence is first-found, not merged.** A `.spfnrc.ts` completely shadows the
  JSON/package configs — they are not combined.
- **Run codegen before the client builds.** `src/generated/route-map.ts` is committed/built
  output the RPC proxy imports. If it's missing or stale, `api.<route>.call()` resolves the
  wrong (or no) `method`/`path`. `spfn build` runs codegen first; if you build by other
  means, run `spfn codegen run` yourself. Treat the file as generated (it's marked
  `DO NOT EDIT`).
- **A route must be in `defineRouter({...})` to be emitted.** Defining `export const foo =
  route.get(...)` but not registering `foo` in the router drops it from the map — the
  generator walks the router, so an unregistered route does not exist as far as it is
  concerned. How the registration is *spelled* no longer matters.
- **route-map loads your router, so route modules must import cleanly.** Reading a
  required environment value at module scope now fails `spfn build` and `spfn codegen run`,
  not just `spfn dev`. Move that read inside the handler. Top-level `await` in a route or
  router module does not load either — jiti transforms to CJS — the same limit
  `@spfn/core:contract` has always had.
- **Custom generators must default-export a factory.** `createGeneratorsFromConfig` calls
  `module.default()` (a zero-arg function) for `{ path }` entries. Exporting the Generator
  object directly, or a factory that needs args, won't load.
- **Don't watch your own output.** A generator whose `watchPatterns` match its `outputPath`
  re-triggers itself. Write outputs outside the watched globs (the orchestrator serializes
  runs and queues one pending re-run, but a self-match still loops).
- **`generate()` should not throw to signal "skip".** The orchestrator catches errors per
  generator (one failure doesn't stop the others), but a throw is logged as a failure.
  Return early instead (route-map logs a warning and returns when the router file is
  absent).
- **`watch()` never resolves on its own.** It returns a promise that stays pending to keep
  the process alive; call `close()` to resolve it and tear down the chokidar watcher.
- **Package generators need a `:` in `name`.** `{ name: 'route-map' }` (no colon) is
  rejected as an invalid name — it must be `'@spfn/core:route-map'`.

---

## Complete example

```typescript
// .spfnrc.ts
import { defineConfig, defineGenerator } from '@spfn/core/codegen';

export default defineConfig({
    generators: [
        // Built-in: route-map for the RPC proxy
        defineGenerator({
            name: '@spfn/core:route-map',
            routerPath: './src/server/router.ts',
            outputPath: './src/generated/route-map.ts',
        }),
        // A project-local custom generator
        { path: './src/generators/admin-nav-generator.ts' },
    ],
});
```

```typescript
// src/server/router.ts
import { defineRouter } from '@spfn/core/route';
import { getUser, createUser } from './routes/users';

export const router = defineRouter({
    getUser,
    createUser,
});
```

```typescript
// src/server/routes/users.ts
import { route } from '@spfn/core/route';

export const getUser    = route.get('/users/:id')/* ...contract/handler */;
export const createUser = route.post('/users')/* ...contract/handler */;
```

```typescript
// app/api/rpc/[routeName]/route.ts — RPC proxy consumes the generated map
import { createRpcProxy } from '@spfn/core/nextjs/server';
import { routeMap } from '@/generated/route-map';

// routeMap (from src/generated/route-map.ts) lets the proxy resolve method + path
export const { GET, POST } = createRpcProxy({ routeMap });
```

```bash
spfn codegen run      # writes src/generated/route-map.ts
```

---

## Types reference

```typescript
interface CodegenConfig { generators?: GeneratorConfig[]; }

type GeneratorConfig =
    | { path: string }                                   // file-based
    | ({ name: string; enabled?: boolean } & Record<string, any>); // package-based

type GeneratorTrigger = 'watch' | 'manual' | 'build' | 'start';

interface Generator
{
    name: string;
    watchPatterns: string[];
    runOn?: GeneratorTrigger[];        // default ['watch', 'manual', 'build']
    generate(options: GeneratorOptions): Promise<void>;
}

interface RouteMapGeneratorConfig
{
    name: '@spfn/core:route-map';
    routerPath: string;
    outputPath?: string;               // default './src/generated/route-map.ts'
    additionalRouteDirs?: string[];   // deprecated: watched, never collected from
}
```

## Related

- [@spfn/core/route](../route/README.md) — `route.*` / `defineRouter` (the router loaded and walked)
- [@spfn/core/nextjs](../nextjs/README.md) — RPC proxy (`createRpcProxy`) that consumes `routeMap`
- [@spfn/core/env](../env/README.md) — environment configuration
