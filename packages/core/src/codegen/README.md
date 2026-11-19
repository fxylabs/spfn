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

One sub-path, `@spfn/core/codegen/loader`, carries the module-format rule alone —
`applicationFormat`, `isDependency`, `packageType` and the types `ModuleFormat`, `SyntaxFormat`
— shared with the CLI's `spfn dev` hook and kept to Node built-ins. Everything else ships from
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
  entry into a live `Generator` (imports packages natively and `.ts` files through the
  codegen loader — see [How the router is loaded](#how-the-router-is-loaded)).

Class:

- `CodegenOrchestrator` — `new CodegenOrchestrator(options)`, then `generateAll(trigger?)`,
  `watch()`, `settled()`, `close()`.

Types:

- `CodegenConfig`, `GeneratorConfig`
- `Generator`, `GeneratorOptions`, `GeneratorTrigger`, `ChangedFile`
- `OrchestratorOptions`
- `RouteMapGeneratorConfig` (config shape for the built-in route-map generator)
- `ContractGeneratorConfig` (config shape for the built-in contract generator)
- `StatesGeneratorConfig` (config shape for the built-in states generator)
- `ContractGeneratorError`, `StatesGeneratorError`, `ConditionalRegistrationError`,
  `assertUnconditionalRegistration`
- `RouteContractMapping`, `ResourceRoutes`, `ClientGenerationOptions`, `GenerationStats`
  (legacy client-generation types — exported but not used by any shipped generator)

> **Renamed: `defineCodegenConfig` → `defineConfig`.** The old name does **not** exist.
> Older docs also show an `api-client` / `createApi`-emitting generator and
> `codegen.config.ts` — those are **removed**. The built-in generators today are
> `@spfn/core:route-map`, `@spfn/core:contract` and `@spfn/core:states`, configured in `.spfnrc.ts`. Do not
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

1. `.spfnrc.ts` — `require()`d as an ES module through the codegen loader, synchronously
   (supports `defineConfig`/`defineGenerator` + TS types; the `@spfn/core/codegen` it imports
   is the process's own). `import.meta.url`, `import.meta.filename` and `import.meta.dirname`
   are the file's own (the URL carries a `?spfn-gen=` query). The default export (or the
   module itself) is the `CodegenConfig`.
   A `.spfnrc.ts` whose import graph uses top-level await cannot be required and is reported
   as failing to load.
2. `.spfnrc.json` — the config is read from the top-level **`codegen`** key:
   `{ "codegen": { "generators": [...] } }`.
3. `package.json` — read from **`spfn.codegen`**: `{ "spfn": { "codegen": { ... } } }`.

If none declares a config, you get `{ generators: [] }` and nothing runs. A config file that
exists and fails to load — a `.spfnrc.ts` that throws or does not compile, a `.spfnrc.json` or
`package.json` that is not JSON — throws `Failed to load <file> (at <file>:<line>:<col>):
<message>` instead; `spfn codegen run` and `spfn build` exit non-zero with it. The same holds for
every generator the config names (BREAKING): a custom generator whose file fails to load or
exports no factory, a package generator that is not found (`Cannot load generator
"@spfn/core:route-mapp": …`, naming where it was looked for, or the generators the package does
export), whose `<package>/codegen` throws on import or whose factory throws (its error), and an
entry that names no generator. Only `enabled: false` skips an entry.

`.spfnrc.ts` and custom generators are ES modules: `__dirname`, `__filename`, `require` and
`module.exports` are not defined — write `import.meta.dirname`, `import.meta.filename`, `import`
and `export default`.

> Precedence is "first file found wins", not a deep merge. A `.spfnrc.ts` fully shadows
> `.spfnrc.json` and `package.json`.

### Generator config entries (`GeneratorConfig`)

A `generators[]` entry is one of three shapes:

| Shape | Example | Meaning |
|-------|---------|---------|
| Package generator | `{ name: 'pkg:gen', enabled?: true, ...opts }` | Loaded from `${pkg}/codegen`. `name` **must** contain `:`. `enabled: false` skips it. Extra keys are passed to the factory. |
| File generator | `{ path: './src/generators/x.ts' }` | A `.ts`/`.js` file whose default export is a `() => Generator` factory, imported through the codegen loader (TypeScript and the project's aliases resolve). |
| Pre-built instance | `defineGenerator({...})` result that already has a `generate` fn | Pushed as-is (guards against accidentally calling a factory yourself). |

For package generators, `name` is split on `:` into `package:generatorName`. The loader
imports `${package}/codegen` — resolved from the project root, natively, so for `@spfn/core`
it is the module the process already holds — and looks for `generators[generatorName]`,
falling back to a `create<Name>Generator` export. So `@spfn/core:route-map` → import
`@spfn/core/codegen`, call `generators['route-map'](config)`.

---

## How the router is loaded

`@spfn/core:route-map`, `@spfn/core:contract` and `@spfn/core:states` read the router by
importing it — `await import('<router>?spfn-gen=<n>')` — in the generating process's own
module graph, through a module hook core registers with `module.registerHooks` on the first
load (`src/codegen/loader/`).

- **Packages evaluate once; the project on every load.** The hook hands the generation
  query on to every file of the project the load reaches (under the project root, outside
  `node_modules`), and to nothing else. Node keys an ES module by its URL, so a new
  generation re-runs the project's modules while a package — `@spfn/core`, `@spfn/auth`,
  anything installed — is the one module the process already holds, evaluated once, under
  the pinned `production` environment. A workspace package's own source beside the app — any
  file outside the project root, a sibling package reached through `paths` included — is
  transformed but not re-run either, and not watched: after editing it, restart `spfn dev` (or
  the process that generates) for codegen to see the change.
- **One load per generation.** The orchestrator gives every generator of one run the same
  `generation`; the three built-in generators share one load of each router under it. A
  generator called without one loads on its own.
- **Format.** Project TypeScript is ESM whatever the `"type"` in `package.json` — the rule
  `spfn dev` runs the app by (`@spfn/core/codegen/loader`, shared with the CLI's dev hook),
  and what `spfn build` bundles: `.ts`/`.tsx` are ESM, a type-less `.js` is decided by its
  syntax, a stated extension or `type` is the author's. A `.json` file is served as tsx serves
  it to `spfn dev`: an ES module whose default export is the parsed value (its top-level keys
  are named exports too), so `import data from './data.json'` and the form with
  `with { type: 'json' }` both load; it is re-read on every generation and watched. A leading
  byte-order mark is dropped, as Node, tsx and esbuild drop it. Import attributes are checked
  as Node checks them, with Node's error (`ERR_IMPORT_ATTRIBUTE_UNSUPPORTED`,
  `ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE`): no attribute but `type`, `type` only `'json'`, and
  `'json'` only on a `.json` file. The one departure is the bare JSON import, which Node
  refuses (`ERR_IMPORT_ATTRIBUTE_MISSING`) and codegen accepts, because the dev server (tsx)
  and the build (esbuild) accept it. Any other
  extension is left to Node and whatever else is registered. Project TypeScript is transformed
  file by file with TypeScript's `transpileModule`; a frame inside it is named by its source
  line.
- **Compiler options.** The transform takes, from the tsconfig that governs the file (the
  nearest `tsconfig.json` above it up to the project root, `extends` merged; for a file outside
  the root, the root's), exactly the options that change what runs:
  `experimentalDecorators`, `emitDecoratorMetadata`, `useDefineForClassFields` (unstated: from
  `target` as TypeScript and esbuild decide it — assign below ES2022, define from ES2022 or
  with no `target`; `target` is read for nothing else), `jsx` (`preserve` and `react-native`,
  which leave JSX Node cannot run, become `react-jsx`, as does an unstated `jsx`),
  `jsxFactory`, `jsxFragmentFactory`, `jsxImportSource`, `verbatimModuleSyntax`. It forces
  `module: ESNext`, `target: ES2022`, `sourceMap: true` and `isolatedModules: true`. Nothing
  else is read (`importsNotUsedAsValues`/`preserveValueImports` were removed in TypeScript
  5.5). `spfn build` reads the same file (`src/server/tsconfig.json`); the `spfn dev` server,
  under tsx, reads only the root `tsconfig.json`. A project file outside `src/server/` is
  governed here by its own nearest tsconfig, while `spfn build` bundles every file with
  `src/server/tsconfig.json`: where the two configs differ in one of these options, that file
  runs with different semantics in codegen and in the build.
- **Resolution.** Extensionless and `.js` → `.ts` specifiers and a directory's `index`, as
  TypeScript resolves them; and tsconfig `paths`, as tsc reads them — see the alias gotcha
  below.
- **Errors name the source.** A load that fails — a syntax error, a module-scope throw, a
  missing export, an import that does not resolve — is reported as `Failed to load
  src/server/router.ts (at src/server/routes/admin.ts:3:7): <message>`: the project file and
  source line where it arose (for an unresolved import, the importer), without the
  `?spfn-gen=` query. Where it arose is read from the error's frames, never from its message:
  a route that fails reading `src/server/data/x.txt` is reported at the route's line. The generator's error carries the load's own error as its `cause`, with
  every stack frame in a project file at its source line and frames of code the transform
  added dropped; the CLI prints it. This uses the source maps the loader keeps while the
  load runs — process-wide source maps (`--enable-source-maps`) are not turned on, in the CLI
  or for a programmatic caller.
- **One copy of `@spfn/core`.** After each router load, an `@spfn/core` entry evaluated more
  than once — as CommonJS beside ESM (a `.cts` route requiring `@spfn/*` under tsx), from two
  installs, or natively twice — is refused in a process the spfn CLI started to generate code
  (`markCodegenProcess()`, called in-process by `spfn codegen run`, `spfn build`'s generation
  step, `spfn contract` and the `spfn dev` watcher entry — not an environment variable, so the
  dev server and `next` inherit nothing), with the message `startServer` refuses with. A programmatic caller or a test is warned instead.
- **Retained memory, accepted.** Node never frees an ES module, so every load keeps its
  project modules: measured about 100 KB per reload for a small app, more for a large one,
  once per file change under `spfn dev` (a generation that varies the environment loads up
  to three times). The watcher is not recycled.
- **The watcher regenerates from what each generation read.** See [Watch mode](#watch-mode):
  every project file a load reads is stamped, and a change to any of them regenerates — an
  `@/` import outside `routes/`, and a file a failed import was looked for at, included.

## Watch mode

`spfn dev` runs the generators in watch mode (`orchestrator.watch()`). The model, in order:

- **Every input is stamped.** Each project file a load reads gets a stamp as the loader reads
  it: a hash of the bytes the load used — no stat field, which an in-place write that keeps
  the size and restores the modification time (`rsync --inplace -t`, `touch -r`) would fool. A path an import that resolved nowhere was looked for at (a
  relative path or a `paths` alias, every candidate extension and `index`) is stamped
  *absent*. The stamps are attributed to the generator whose `generate()` made the load, and
  replaced by each run of it: a file a load no longer reaches leaves its inputs.
- **Events are hints.** chokidar watches the base directory of each generator's
  `watchPatterns` (for what no load has reached yet: a new route file, the router), and a
  non-recursive `fs.watch` watches the nearest existing directory of every input. An event
  marks a path dirty or asks for a check; which event arrived, and whether one arrived at
  all, does not decide what is regenerated.
- **One loop, one generation per cycle.** The loop takes the whole dirty set at once and runs
  the union of the generators whose `watchPatterns` match a dirty path or whose inputs hold
  one, in one generation (one load of each router). Changes that arrive while it runs wait in
  the dirty set — in debug mode, as `spfn dev` runs, each is logged as `Queued ~ <path>` — and
  are all taken by the next cycle.
- **Arm, then check.** After every generation the loop watches the directories of the new
  inputs, *then* compares every input with its stamp: existence, then the hash of the file's
  content now (every input is read and hashed on every check). A stale input is
  dirty, logged as `Changed during generation: + src/server/lib/later.ts`, and the loop runs
  again. Because the watch is armed before the comparison, a change lands either before it
  (the comparison finds it) or after the watch exists (an event reports it): a file created
  or edited while a generation ran, or replaced inside one, is not lost.
- **Reported after the check.** A generation's `✓` and `✗` lines are logged once the check has
  run. A generator that read a file the check found changed ran on inputs that changed under
  it, so neither its success nor its failure describes the app as it now is (a save between
  two of the environment probe's loads would read as "depends on the environment"): it gets
  `[<generator>] Read files that changed while it ran; running it again` instead, and the run
  after it reports. A file two loads of one generation read with different contents counts as
  changed even if it is restored before the check.
- **Start.** chokidar's first scan (`ready`), then the initial generation, then arm and
  check. `Watch mode started` is logged once changes are seen from then on.
- **`No generators matched this file`** (debug) is logged only when no generator matched a
  cycle's changes. A cycle in which every matched generator failed ends with their `✗` lines.
- **Loop guard.** After 3 consecutive cycles that the check alone started (no file event in
  between, the loop never idle), the loop warns, naming the files and the generators that
  read them, and starts no further cycle for them until a file event, or until they change
  again. Only a generator that writes a file it reads, differently on every run, does that —
  see [Don't watch your own output](#pitfalls--anti-patterns).
- **`close()`** starts no new generation and resolves once the one running has finished —
  every generator of it, so the outputs of one cycle never disagree. The `spfn dev` watcher
  awaits it on SIGTERM/SIGINT.
- **`settled()`** resolves once the loop is idle: nothing running, nothing dirty, no input
  directory event still settling. A chokidar event not delivered yet (it waits 100 ms for
  writes to settle) is not known to it.
- **State is per orchestrator.** Two orchestrators in one process share no watch state.

**Not watched** — restart `spfn dev` (or save a watched file) after changing:

- Files a route reads with `fs` (or any other way than `import`): they are not inputs.
- `.env` files and the environment: the environment probe reads them, but they are not
  inputs.
- Packages: anything under `node_modules`, and a workspace package's source or rebuilt
  `dist` — packages are evaluated once per process.
- The codegen config (`.spfnrc.ts`, `.spfnrc.json`, `package.json`) and custom generator
  files: read once when `spfn dev` starts.

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

The router module is loaded ([How the router is loaded](#how-the-router-is-loaded);
`appRouter` → `default` → `router`) and walked the
way `registerRoutes` walks it. How the router is *written* does not matter: a one-line
`defineRouter({ createUser })`, an aliased key `create: createUser`, and a second
`defineRouter(` in the same file all produce the same map.

- A **nested router** recurses to any depth and its routes land in the map **flat, under
  their own keys** — the parent's key names the grouping, not the route, exactly as the
  server registers them.
- `method` and `path` come from the `RouteDef`, not from a pattern over the source. A
  route not registered in the router is absent, because there is nothing registering it.
- **`.packages()` routers are carried**, at every depth, provided the router publishes a
  route map (`defineRouter`, not `defineUnmappedRouter`). A package ships a client that
  names its own routes — `authApi.login`, `monitorApi.getStats` — and the app's
  `createRpcProxy` resolves a name in the one map it was constructed with, so the app
  merges nothing by hand: `{ ...routeMap, ...authRouteMap }` is a no-op today. They are
  written after the app's own routes, under a comment line naming where they came from,
  and the header says how many there are and which mount each came through.
- A name that is not a JS identifier (`'get-user'`) is emitted quoted, and `__proto__` is
  emitted as a computed key, so the generated file parses and the map keeps every route as
  an own property.
- Imports are resolved by Node **and by the `compilerOptions.paths` of the nearest
  `tsconfig.json` that declares them**, searched from the router file's own directory up to
  the project root, `extends` chains included — so the `@/*` alias every spfn app has
  resolves while the router loads, whether it lives in the root config (a Next.js app) or in
  `src/server/tsconfig.json` (what `spfn init` scaffolds, and the config `spfn build`
  compiles the server with). The search stops at the project root: a tsconfig above it
  belongs to whatever contains the project. A config that declares no `paths` is passed over
  rather than ending the search. `baseUrl` is honoured, so the scaffold's `"baseUrl": "../.."`
  resolves against the project root as tsc resolves it. The failure names the specifier that
  did not resolve.
- `NODE_ENV` is pinned to `production` **whatever the shell or the parent process set**,
  with one log line when a different value is replaced, naming both. The generated file is
  committed once and shipped, so it describes what ships: `spfn codegen run`, `spfn build`
  and the watcher `spfn dev` starts all load the router under `production` and write the
  same bytes. The pin belongs to the generating process, not to a generator, and is set
  where generation begins, before any project code is evaluated: `spfn dev` starts its
  watcher process with `NODE_ENV=production` in its environment, and `loadCodegenConfig` —
  the first step of `spfn codegen run`, `spfn contract` and `spfn build`'s codegen step —
  pins before it reads `.spfnrc.ts`. So `.spfnrc.ts` and what it imports, a custom generator
  listed before or after the route map, and the built-in generators all see `production`, on
  the first watcher run and every later one. A **programmatic caller** gets the same from
  its first codegen call: `loadCodegenConfig`, `createGeneratorsFromConfig` and
  `new CodegenOrchestrator(...)` each pin, so the process's `NODE_ENV` is `production` from
  then on — for the rest of the process, not only during generation. Modules it loaded
  before that call are its own and keep whatever they read. Calling a generator's
  `generate()` without any of the three does not pin. Only the generating process is pinned
  — `spfn dev` runs its watcher as a process of its own, so the dev server beside it keeps
  `development`. For `spfn build` the generating process is the building one, so the steps
  after codegen (`next build`, the server build) run under `production` too. The file names no
  environment in its header any more: there is one. A route a **package** registers only
  outside production (from its own module scope, which the probe below does not vary) is
  served by `spfn dev` but is not in the map.

### When it refuses

Unlike the old source parser, which dropped what it could not read, the generator throws
— logged always, and fatal on the `build` trigger and on `spfn codegen run`:

- The module will not load. An import that did not resolve names the specifier; anything
  else names the cause and says a route module must be importable without side effects. It
  never falls back to parsing.
- No router is found under `appRouter`, `default` or `router` (the message lists all three).
- The router file registers a route **conditionally** (`...(flag ? { admin } : {})`), which
  would put the flag's value into the map and leave `api.admin.call()` 404ing wherever the
  flag differs. This is the same guard `@spfn/core:contract` uses, and it reads **the router
  the generator was pointed at** — the export the loader found it under, plus the routers
  that export mounts by name from the same file, since a nested router's routes land in the
  same flat map. A second `defineRouter(` the app router never reaches is not scanned: it
  registers nothing in production. The source is read with TypeScript's parser, so a JSDoc
  spelling `defineRouter({ ... })` in prose, a comment holding an old router and a brace
  inside a string are not router source. Only a spread whose expression **reads a
  condition** is refused — a ternary, `&&`, `||`, `??`. A call is allowed
  (`...metadataRoutes(config, resource)`): loading yields exactly the routes it returns.
  Past the scan, by construction: a conditional spread inside an imported module, a router
  built by a factory, a condition hoisted to a variable before the spread, and a
  `.packages()` list assembled conditionally. The environment probe (next bullet) is what
  catches those when the condition reads the environment.
- The generated file **depends on the environment** (#102, #334). While the router loads, the generator
  records every `process.env` key a project file reads — direct access, destructuring and
  `in`, and a read through a library such as the `@spfn/core/env` registry, which is
  attributed to the route module that asked. Reads a package makes while it loads are not
  counted: a package does not run again on a second load — it is evaluated once, under the
  pinned `production` — so varying them could change nothing, and a package's own
  environment-dependent route is not refused: the map has it as production registers it. With no read, nothing more happens. Otherwise the router
  is loaded again with every one of those keys varied — a set key deleted, an unset key set to
  `'true'`, and `NODE_ENV` set to each conventional value it does not hold (`production`,
  `development`, `test`; one load per value), because it is the one key tooling sets on its
  own to a known value — and the whole file the generator would write is compared with the
  one it is about to write. So a route's `csrf`,
  the order of the entries and a `.packages()` mount line in the header count as much as a
  name, a method or a path: a map committed from one environment would otherwise disagree with
  what ships (a `csrf: 'required'` the client never sends a token for). `NODE_ENV` is pinned
  first, so the baseline is `production` and the variations `development` and `test`; the probe
  sets each varied value itself around its own load, which is why the pin does not hide it.
  When the files differ, or a varied load fails, up to four keys are varied one at a time
  (`NODE_ENV` once per value) to say which one changes it. The refusal names each key, the
  `NODE_ENV` value that produced the difference (`production → test`), where it was read
  (`src/server/routes/admin.ts:6`), and what changes: a route added, dropped or moved
  (`+ admin (GET /admin)`, `~ env: GET /production → GET /development`), a field
  (`~ ping: csrf 'required' → none`), an order (`order of the app's routes: a, b → b, a`), a
  mount-line list, or else the first line that differs. When the header's mount lines differ,
  the refusal shows both lists in full, each under the environment that wrote it
  (`mount lines under production:`, `mount lines under development:`): no part of a mount line
  — its `packages[i]` position, its router, its routes — identifies the same mount across two
  loads, so a `+`/`-` per mount would name changes nobody made. It names a key's values only for `NODE_ENV`, since any other key may hold a
  secret. A key the router cannot load without (a module-scope
  `if (!process.env.API_KEY) throw`) is left as it is and logged at info. Cost: one load when
  nothing in the project reads the environment while loading — the examples in this
  repository read nothing — then one more load per `NODE_ENV` value varied (two when
  `NODE_ENV` is read, else one) when the file does not change, at most eight. Not covered: a
  key other than `NODE_ENV` compared against one particular value (`=== 'on'`), a `NODE_ENV`
  value outside the three, a key first read under
  a varied environment, a package's own module scope, and nondeterminism that is not the
  environment. Each varied load runs the project's module scope again, which is one more
  reason a route module must be importable without side effects. There is one environment per
  process, so loads that observe or vary it take turns: two generations run side by side (a
  `Promise.all` over a monorepo's apps) wait for each other load by load. A load that never
  settles — a top-level `await` that hangs — therefore holds the environment and blocks every
  later load in the process, other apps' included; the watcher already ran one generation at a
  time. A key read at module scope
  for use inside a handler is not refused: the written files are compared, not the reads.
- Two routes reach the same name (the message names both places).
- An **app route and a package route** reach the same name, where that package publishes a
  route map. Both register at runtime, and both want the single entry that name has in this
  map — so one of the two paths becomes unreachable while the generated types still
  describe the app's route. **Two package routers** reaching one name is refused too, and
  names both mounts: the generator writes the order now, so the ambiguity is its to refuse.
  The same route reached through two mounts is not two routes — a package exporting one set
  of routes under a router and a sub-router an app mounts beside it hands both mounts the
  same route object, and it is collected once. No first-party package ships that shape today;
  the rule is keyed on object identity so that an app mounting both still builds when one
  does, and the header line of the second mount says which mount got there first.
  A collision with a router that publishes **no** map is not refused — one declared with
  `defineUnmappedRouter`, whose routes are reached by the URL something was handed rather
  than by name: the ops surface (`createOpsRouter`) and the tracking routes of
  `@spfn/notification`. Nothing of theirs is written here, so an app route named after one
  of their routes keeps its own path and must not fail the build.
- A route's `method` is not an `HttpMethod`. `registerRoutes` lowercases the method before
  registering, so `method: 'get'` serves fine and would emit a map that fails `tsc`.

A **missing router file** is still only a warning: the generator returns and writes nothing.

**Warned about and left out, not refused**: a route with no method or path (reachable by
registering a route before `.handler()` was called), and a router entry that is neither a
route nor a router. `registerRoutes` warns and skips both, so a map without them still names
every route the server answers — which is all a refusal would have been protecting.

A package route with no method or path is skipped the same way, and for the same reason.
What is refused is only what would write a file that does not compile or that answers to
the wrong path: a method that is not an `HttpMethod`, and the two collisions above.

### Generated output

```typescript
// src/generated/route-map.ts  — DO NOT EDIT
import type { HttpMethod, RouteCsrf } from '@spfn/core/route';

export interface RouteInfo
{
    method: HttpMethod;
    path: string;
    csrf?: RouteCsrf;
}

export const routeMap: Record<string, RouteInfo> = {
    getUser: { method: 'GET', path: '/users/:id' },
    createUser: { method: 'POST', path: '/users' },
    // From the package routers this app mounts with .packages(), not its own:
    login: { method: 'POST', path: '/_auth/login' },
    revokeOAuth2Grant: { method: 'DELETE', path: '/_auth/oauth2/grants/:id', csrf: 'required' },
};

export type RouteMap = typeof routeMap;
export type RouteName = keyof RouteMap;
```

`csrf` is written only for a route that declares `.csrf('required')`. The RPC proxy hands the
entry it resolved a name to its interceptors as `ctx.route`, which is how `@spfn/auth`'s CSRF
check learns one of the app's own routes must be checked in every mode — so a map generated
before such a route gained the declaration leaves it to the configured mode until the map is
regenerated. A package's own routes need not depend on that: `@spfn/auth` reads its routes'
declarations from the map it ships, with `findRouteEntry`.

`watchPatterns` are `[routerPath, 'src/server/routes/**/*.ts', ...additionalRouteDirs]` and
`runOn` is `['watch', 'manual', 'build']` — every trigger the CLI fires, so it runs in every mode.

---

## Built-in: `@spfn/core:contract`

Writes `contracts/current.json` — every route carrying `.contract()`, and with `eventRouterPath`
every SSE event carrying `.contract()` — and on a **build** compares
it against the newest released snapshot, refusing changes that would break a client already in the
field. Full behaviour lives in [`../contract/README.md`](../contract/README.md); this section is the
generator's own surface.

### `ContractGeneratorConfig`

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `'@spfn/core:contract'` | yes | — | Generator identifier (literal). |
| `routerPath` | `string` | yes | — | Router file, relative to project root. Throws at construction if missing. |
| `routerExport` | `string` | no | `appRouter` → `default` → `router` | Export holding the `defineRouter()` result. |
| `eventRouterPath` | `string` | no | — | Event router file, relative to project root. Loaded like the router (same `NODE_ENV` pin, same tsconfig aliases) and watched; its contracted events become the document's `events` section. Unset → no section. |
| `eventRouterExport` | `string` | no | `eventRouter` → `default` | Export holding the `defineEventRouter()` result. |
| `outputDir` | `string` | no | `'./contracts'` | Holds `current.json`, `released/`, `usage/`. |
| `additionalRouteDirs` | `string[]` | no | `[]` | Extra route dirs to watch. |

### How it differs from route-map

| | `route-map` | `contract` |
|---|---|---|
| Reads the router by | loading the module and walking `RouteDef`s | the same |
| Covers | every registered route | only routes carrying `.contract()` |
| `runOn` | `watch`, `manual`, `build` | `watch`, `build`, `manual` |
| Can fail a build | **yes** — any refusal, on every trigger the CLI fails on | **yes**; a broken contract only on the `build` trigger |

Loading rather than parsing is what makes the contract correct: real routes build schemas from
imported values (`EmailSchema`, `FileSchema()`, constants) that a source parser cannot resolve. It
costs a module import and no infrastructure — `@spfn/auth`'s 43 routes load in ~0.6s with neither
`DATABASE_URL` nor `CACHE_URL` set.

### When it refuses

- The router file is missing, or the module will not load (it names the module and the cause —
  it never skips quietly).
- No router export is found under the configured or default names.
- `eventRouterPath` is set and the file is missing, or holds no event router (an object with
  `events` and `eventNames`) under the configured or default names — the message names the
  candidates it tried.
- The event router contracts events without a router-level `.contract()`, or a contracted event
  has no payload schema, no `since`, or the reserved key `connected` / `ping`.
- Two contracted routes share a name, or a contracted route has no method, path, `since` or
  `response`.
- The router the generator was pointed at contains a conditional spread
  (`...(flag ? { route } : {})`), which would make the contract describe whichever way the
  generator happened to run. Same source scan as `route-map` — see its bullet for exactly what
  is scanned and what is allowed. The environment probe runs in `route-map` only, so a project
  that runs both generators is refused there. The event router file gets the same scan for
  `defineEventRouter({ ...(flag ? { event } : {}) })`.
- On the `build` trigger only: the contract breaks the newest released snapshot.

`spfn dev` generates but never refuses — being unable to hold a half-finished route mid-edit would
make the feature unusable.

---

## Built-in: `@spfn/core:states`

Loads your router and emits the ids and the manifest of every state it mounts —
`src/generated/states.ts`, a file with no import that a browser root and a server component
can both execute. `createStateClient<typeof states>` is a type import, erased at build, and
importing the router itself is not an option (each state's `read()` closes over repositories
and the database), so this file is the only runtime record of which states the app declared.
Compare its `stateManifest` with the `manifest` of `GET /state`: an id the server's manifest
lacks is a deploy skew between the Next.js server and the API, reported at the root instead
of surfacing as `state.<id>` being `undefined` inside a screen. See
[`../state/README.md`](../state/README.md) → "Declared ids at runtime".

### `StatesGeneratorConfig`

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `'@spfn/core:states'` | yes | — | Generator identifier (literal). |
| `routerPath` | `string` | yes | — | Router file, relative to project root — the one `route-map` reads. Throws at construction if missing. |
| `outputPath` | `string` | no | `'./src/generated/states.ts'` | Where the file is written (parent dirs auto-created). |

### What it reads

The router module is loaded exactly as `route-map` loads it (`appRouter` → `default` →
`router`, tsconfig aliases, `NODE_ENV` pinned), then walked:

- **The marker.** `defineStateRouter` sets a non-enumerable `Router._stateManifest` on the
  router it derives — the very object the snapshot route answers as `manifest` — so the ids
  written here and the manifest the server serves come from one value. Each state router
  contributes its entries in declaration order; `key` lists the key fields in schema order.
- **Mounted routers at every depth.** Every nested router under `routes` and every entry of
  `_packageRouters`, recursively — app `routes` first, then `_packageRouters` in mount order.
  A router reached by two trails (`.packages()` copies a mounted router's own package routers
  up) is collected once: the walk is keyed on the router object.
- **Chained routers.** `.use()`, `.packages()` and `.contractVersion()` carry the marker onto
  the router they rebuild, so `states.router.use([audit])` is still found.
- An id that is not a JS identifier is emitted quoted, through the same key rule `route-map`
  uses.

### When it refuses

Throws `StatesGeneratorError` (or the loader's and the guard's errors) — logged on `watch`,
fatal on `build` and on `spfn codegen run`:

- The module will not load, or no router is found under the three export names.
- The router registers **conditionally** — same `ConditionalRegistrationError` source scan as
  `route-map` (the environment probe runs in `route-map` only).
- **Two state routers declare the same id.** The message names both trails.
- **No state router is mounted** anywhere in the walk. The generator is configured but nothing
  it reads mounts a `defineStateRouter(...).router`; the message names the router path. Mount
  the state router or drop the generator.

A mounted state router that declares **no state** — `defineStateRouter({})` — is not refused: it
is an app that has declared none yet. The file is written with `stateIds = [] as const` and an
empty `stateManifest`, which matches the empty manifest the server serves.

A **missing router file** is only a warning: the generator returns and writes nothing.

### Generated output

```typescript
// src/generated/states.ts  — DO NOT EDIT (written under NODE_ENV=production, like every generated file)
export const stateIds = ['consent', 'member', 'workspaces'] as const;

export type StateId = (typeof stateIds)[number];

export const stateManifest: Readonly<Record<StateId, { readonly key: readonly string[]; readonly write: boolean }>> = {
    consent: { key: [], write: true },
    member: { key: ['workspaceId'], write: false },
    workspaces: { key: [], write: false },
};
```

`watchPatterns` are `[routerPath, 'src/server/states.ts', 'src/server/states/**/*.ts',
'src/server/routes/**/*.ts']` and `runOn` is `['watch', 'manual', 'build']`.

---

## CLI

Provided by the `spfn` CLI (`@spfn/cli`), not by `@spfn/core` itself:

```bash
spfn codegen init     # scaffold a .spfnrc.ts
spfn codegen list     # list resolved generators + their watch patterns  (alias: ls)
spfn codegen run      # run all generators once (CodegenOrchestrator.generateAll, trigger 'manual'; a failure exits 1)
spfn dev              # dev server + codegen in watch mode (see "Watch mode")
spfn build            # runs codegen once before building (trigger 'build'; a failure exits 1)

spfn contract check      # regenerate the contract, compare against the newest released snapshot
spfn contract release X  # write contracts/released/X.json
spfn contract list       # released snapshots  (alias: ls)
```

`spfn codegen run` has **no** `--name` flag — it always runs every configured generator.
(The `spfn init` project scaffold writes a `.spfnrc.ts` preconfigured with the route-map
generator and adds a `"codegen": "spfn codegen run"` npm script.)

`spfn codegen run` **exits 1 when a generator refuses**, and stops at the one that refused
— the run that just failed to regenerate a map must not look like the run that did. `spfn
dev` is unaffected: watch mode logs the failure and keeps going, because being unable to
hold a half-finished route mid-edit would make the feature unusable.

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
void orchestrator.watch();
await orchestrator.settled();   // the loop is idle, nothing dirty (see "Watch mode")
// ...later, to shut down: resolves once the running generation has finished.
await orchestrator.close();
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
        changedFile?: ChangedFile;     // watch only: set when exactly one change triggered the run
        changedFiles?: ChangedFile[];  // watch only: every change that triggered the run
    };
    [key: string]: any;
}

interface ChangedFile
{
    path: string;                      // relative to the project root
    event: 'add' | 'change' | 'unlink';
}
```

For incremental rebuilds, check `options.trigger?.changedFile` — or `changedFiles`, when the
watcher took several changes into one run — and fall back to full regeneration when neither is
set (the initial watch pass and build/manual passes set neither). A run's changes are the files
matching the generator's `watchPatterns` and the files its previous run read that changed
since (see [Watch mode](#watch-mode)).

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
  `DO NOT EDIT`). **Upgrading a mounted package goes stale the same way and is quieter about
  it**: the map carries that package's routes, but the upgrade changes no app source, so no
  watcher fires and nothing else says the committed map is a version behind — re-run codegen
  after an upgrade as you would after adding a route.
- **A route must be in `defineRouter({...})` to be emitted.** Defining `export const foo =
  route.get(...)` but not registering `foo` in the router drops it from the map — the
  generator walks the router, so an unregistered route does not exist as far as it is
  concerned. How the registration is *spelled* no longer matters.
- **route-map loads your router, so route modules must import cleanly.** Reading a
  required environment value at module scope now fails `spfn build` and `spfn codegen run`,
  not just `spfn dev`. Move that read inside the handler. Route modules are ES modules here,
  as under `spfn dev` and `spfn build`: a type-only name imported or re-exported without
  `type` (`export { User } from './types'`) fails to link, as it does there.
- **A path alias resolves only if a tsconfig between the importing file and the project root
  maps it.** The loader reads `compilerOptions.paths` from the nearest such `tsconfig.json`
  (following `extends`), so `@/server/routes/users` resolves from the root config or from
  `src/server/tsconfig.json`. It matches as tsc does: a pattern without `*` matches only
  itself and wins, otherwise the matching pattern with the longest prefix, and a `*` may sit
  anywhere in the pattern (`legacy/*/entry`). **Every target of the entry is tried for each
  import, in order**, and the first that names a file is taken — a partial `dist` before
  `./src/*` resolves each import through whichever has it. (Before #335 one target per key
  was chosen for the whole load.) A mapping that lives *above* the project root — a
  monorepo's solution-style config — is not read, and a `baseUrl` with no `paths` resolves
  nothing. An `extends` target TypeScript could not read is warned about instead of silently
  dropping its `paths`; an import that fails to resolve names the specifier and, for an
  alias, every target it tried.
- **Custom generators must default-export a factory.** `createGeneratorsFromConfig` calls
  `module.default()` (a zero-arg function) for `{ path }` entries. Exporting the Generator
  object directly, or a factory that needs args, won't load.
- **Don't watch your own output.** A generator whose `watchPatterns` match its `outputPath`
  re-triggers itself. Write outputs outside the watched globs. A generator that imports a file
  it then writes converges when the content it writes is the same each time (the second check
  finds the same hash); one that writes something different every run (a timestamp) is stopped
  by the loop guard after 3 cycles, with a warning (see [Watch mode](#watch-mode)).
- **`generate()` should not throw to signal "skip".** The orchestrator catches errors per
  generator (one failure doesn't stop the others), but a throw is logged as a failure.
  Return early instead (route-map logs a warning and returns when the router file is
  absent).
- **`watch()` never resolves on its own.** It returns a promise that stays pending to keep
  the process alive; call `close()` to resolve it and tear down the watchers. `close()`
  waits for the generation running, if any.
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

interface StatesGeneratorConfig
{
    name: '@spfn/core:states';
    routerPath: string;
    outputPath?: string;               // default './src/generated/states.ts'
}
```

## Related

- [@spfn/core/route](../route/README.md) — `route.*` / `defineRouter` (the router loaded and walked)
- [@spfn/core/nextjs](../nextjs/README.md) — RPC proxy (`createRpcProxy`) that consumes `routeMap`
- [@spfn/core/state](../state/README.md) — `defineStateRouter`, whose manifest `@spfn/core:states` writes
- [@spfn/core/env](../env/README.md) — environment configuration
