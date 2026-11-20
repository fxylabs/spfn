# Upgrading from 0.3 to 0.4

Every `@spfn/*` package and the `spfn` CLI moved to a new minor line on 2026-11-18, together:
`@spfn/core`, `@spfn/auth`, `spfn`, `@spfn/storage`, `@spfn/cms` and `@spfn/mcp` to `0.4.0-beta.1`,
the others to the next minor of their own line. Each package now requires the others' new line,
so upgrade them in one step. The full list of changes is in the
[CHANGELOG](../../../CHANGELOG.md).

## Does this affect me?

| What you have | What to do |
|---|---|
| Any `@spfn/*` package | Upgrade all of them and `spfn` together — 0.3 and 0.4 packages cannot be mixed. [Step 2](#2-every-spfn-package-and-spfn-together) |
| An app run with `spfn dev` that has no `"type": "module"` (every `spfn create` scaffold) | Check `src/server` for CommonJS: `require`, `__dirname`/`__filename`, a named import from a file written with `module.exports`, a CommonJS file that requires `@spfn/*`. Write them as ESM. [CLI README](../../../packages/cli/README.md#your-server-source-runs-as-esm-as-it-does-in-production) |
| Server TypeScript run as CommonJS beside the ESM `@spfn/core` dist — under a `spfn` CLI older than its `@spfn/core`, or another runner that loads server source as CommonJS | Upgrade `spfn` with `@spfn/core` and start the app with `spfn dev` — the new core refuses the second copy of itself that this loads. A built server under `spfn start`, or one run as ESM, is not refused. [Below](#the-server-refuses-a-second-copy-of-spfncore) |
| Two installs of `@spfn/core` (`pnpm why @spfn/core` lists more than one) | Make it resolve to one install. [Core README](../../../packages/core/README.md#why-does-the-server-refuse-a-second-copy-of-spfncore) |
| `tsx` below `4.22.4` in `devDependencies` | Raise it to `^4.22.4`. [Step 3](#3-tsx) |
| Next.js below `16.4.5`, or `hono` / `@hono/node-server` declared by the app itself | Raise them to `^16.4.5`, `^4.13.16`, `^2.1.6`. [Step 1](#1-nextjs) |
| `@google-cloud/kms`, `@aws-sdk/client-kms`, `@aws-sdk/client-sns`, `@aws-sdk/client-sesv2` or `@google-cloud/storage` installed by the app | Raise them to the floors in [step 2](#2-every-spfn-package-and-spfn-together), in the same command as the package that uses them |
| Routes, a `.csrf()` or a `.packages()` mount registered only under some `NODE_ENV` or other environment key | Register them unconditionally and gate behaviour inside the handler — code generation now refuses the router. [Core README](../../../packages/core/README.md#do-i-have-to-run-codegen) |
| A committed `src/generated/route-map.ts` (or `states.ts`) | Regenerate and commit — the `Generated with NODE_ENV=…` header line is gone. [Step 4](#4-regenerate-and-commit) |
| `NODE_ENV=development spfn build` (or `test`) | `next build` and the server build now run under `production` too. A build that needs another value runs those steps itself. [CLI README](../../../packages/cli/README.md#spfn-build) |
| `@spfn/auth` with `secondFactor: { required: true }` | Make `hono` resolve to one install (`pnpm why hono`). A second copy now refuses the boot instead of answering 403. [Below](#auth-refuses-to-start-two-copies-of-hono) |
| A Kit release whose `spfnCli` range ends `<0.4.0` | The 0.4 beta CLI is not refused, but only because the range check orders `0.4.0-beta.1` below `0.4.0` — the release was made for 0.3, not tested against 0.4. Use a Kit release made for 0.4 when one exists. [Below](#a-kit-release-refuses-the-cli) |
| An app that imports `drizzle-typebox` without listing it in its own `package.json` | Add it, or import `drizzle-orm/typebox-legacy` — `@spfn/core` no longer brings it. |
| An npm app whose `package.json` lists `drizzle-typebox` (every npm app `spfn init` 0.4.0-beta.1 or earlier scaffolded) | Remove it, or import `drizzle-orm/typebox-legacy` instead, and drop `--legacy-peer-deps` from your own scripts and Dockerfile. [Below](#npm-refuses-the-app-drizzle-typebox) |
| None of the above, and every `@spfn/*` package upgraded | Nothing |

What is new and needs nothing from you: a `passkeyLogin` sign-in channel in `@spfn/auth`
([auth README](../../../packages/auth/README.md#which-sign-in-channels-exist-channels)), and an
`appUrl` that `@spfn/mcp` reads at first use
([mcp README](../../../packages/mcp/README.md#reading-the-origin-at-request-time)).

## Upgrade, in order

Raise Next.js first, then upgrade the packages and the SDKs they take as peers in one command, so
that each 0.4 package finds its peers in place and pnpm prints no unmet-peer warning.

### 1. Next.js

```bash
pnpm add next@^16.4.5
```

The 0.3 packages accept it: their peer range on Next.js has a lower floor. If your `package.json` declares
`hono` or `@hono/node-server` itself, raise them to `^4.13.16` and `^2.1.6` in the same command;
otherwise you get them through `@spfn/core`.

### 2. Every `@spfn/*` package and `spfn`, together

Add the packages your app already has, by dist-tag. The beta packages:

```bash
pnpm add @spfn/core@beta spfn@beta @spfn/auth@beta @spfn/notification@beta @spfn/i18n@beta
```

Add `@spfn/storage@beta`, `@spfn/cms@beta`, `@spfn/mcp@beta`, `@spfn/monitor@beta`,
`@spfn/migrate@beta`, `@spfn/pages@beta` and `@spfn/pages-next@beta` to the same command where you
use them. The alpha packages:

```bash
pnpm add @spfn/signing@alpha @spfn/workflow@alpha
```

If your own `package.json` installs one of these SDKs, append its floor to the `pnpm add` above
that upgrades the package using it, not to a command of its own before it: `@spfn/signing` 0.1
takes `@google-cloud/kms` `^5` as a peer, and 0.4 `@spfn/notification` the AWS floors.

```text
@google-cloud/kms@^6                     # with @spfn/signing@alpha, on GCP KMS
@aws-sdk/client-kms@^3.1074.0            # with @spfn/signing@alpha, on AWS KMS
@aws-sdk/client-sns@^3.1074.0 @aws-sdk/client-sesv2@^3.1074.0   # with @spfn/notification@beta, on AWS
@google-cloud/storage@^8.3.0             # if the app depends on it directly
```

`@spfn/storage`'s AWS SDK, `@spfn/auth`'s `jsonwebtoken` and `@spfn/pages`' `yaml` are
dependencies of those packages and need nothing.

A scaffold has `spfn` in `dependencies`. If you run it as `npx spfn` or `pnpm dlx spfn` instead,
run `npx spfn@beta` / `pnpm dlx spfn@beta`.

Then check that each package resolves once:

```bash
pnpm why @spfn/core
pnpm why hono
```

### 3. `tsx`

```bash
pnpm add -D tsx@^4.22.4
```

`spfn dev` runs your project's own `tsx`. One before 4.22 prints `DEP0205` at every start on
Node 26.

### 4. Regenerate and commit

```bash
pnpm codegen        # the scaffold's script for `spfn codegen run`
git add src/generated
git commit -m "chore: regenerate for spfn 0.4"
```

The route map (and `src/generated/states.ts`, if the app has a state generator) loses its
`Generated with NODE_ENV=…` header line. `spfn codegen run`, `spfn build` and the watcher
`spfn dev` starts now write the same bytes, so the committed file stays put when you run
`spfn dev`.

Then start the app with `spfn dev` and check that it boots.

## What you will see if you miss a step

### The server refuses a second copy of `@spfn/core`

From a `spfn` CLI older than `@spfn/core` — step 2 done for the packages but not for `spfn`:

```
Refusing a second copy of @spfn/core in this process: @spfn/core/… (`…/node_modules/@spfn/core/dist/…`,
0.4.0-beta.1) was evaluated twice: natively as ESM and as CommonJS, required by
…/src/server/server.config.ts. Each copy keeps its own state — rate-limit policies, trusted proxy
hops, the router — so what the app configures on one is not what the other serves.
…/src/server/server.config.ts is TypeScript run as CommonJS: the spfn CLI is older than this
@spfn/core, or the process was not started through `spfn dev` — upgrade spfn together with
@spfn/core and start it with `spfn dev`.
```

pnpm does not warn about this pairing: the old CLI's peer range `>=0.3.0-beta.38 <0.4.0` admits
`0.4.0-beta.1`. Fix: `pnpm add spfn@beta`.

From two installs of `@spfn/core`. Every `@spfn/*` package takes `@spfn/core` as a peer and links
to the app's, so a 0.3 package does not bring its own; the cause the message names is a peer of
`@spfn/core` — `drizzle-orm`, `next` or `react` — that pnpm resolved differently for two
dependents, which installs `@spfn/core` once for each:

```
Refusing a second copy of @spfn/core in this process: @spfn/core/… was loaded from two installs:
`…` (0.4.0-beta.1) and `…` (0.4.0-beta.1). … Two installs of @spfn/core: dedupe — make
@spfn/core resolve to one install for the app and every @spfn package (`pnpm why @spfn/core`; a
peer such as drizzle-orm, next or react resolved differently for two dependents installs it twice).
```

Fix: `pnpm why @spfn/core` shows the two installs and the peer that sets them apart; give that
peer one version in the app's `package.json`, then reinstall.

From a `.cjs`, `.cts` or CommonJS `.js` server file that requires `@spfn/*`, the message names that
file and ends:

```
… is CommonJS, and under `spfn dev` a CommonJS file that requires @spfn/* gets a copy of its own:
import @spfn/* from an ES module (.ts, .mts, or .js written with import/export).
```

Fix: write the file as ESM.

The [core README](../../../packages/core/README.md#why-does-the-server-refuse-a-second-copy-of-spfncore)
explains each case.

### CommonJS in a `.ts` file under `spfn dev`

A named import from a file written with `module.exports`:

```
SyntaxError: The requested module './config' does not provide an export named 'value'
```

`require` in a `.ts` file:

```
ReferenceError: require is not defined in ES module scope, you can use import instead
```

(Node 22.23.4; the wording differs between Node releases.) A default import of a
`module.exports` file still works. Fix: write the file as ESM — `export const value = …`,
`import`, `import.meta.dirname`. The
[CLI README](../../../packages/cli/README.md#your-server-source-runs-as-esm-as-it-does-in-production)
tables every shape against `spfn build` + `spfn start`.

### Code generation refuses an environment-dependent router

`spfn codegen run`, `spfn build` and the `spfn dev` watcher all log, when the shell set another
value:

```
NODE_ENV was "development"; pinned to "production" for code generation, so the generated files
describe what ships whichever command wrote them
```

That line is information. A router whose generated file differs by environment is refused:

```
The route map depends on the environment. The file generated from this router changes when these
keys change, so a file generated under one environment describes something another one does not
serve — a route the client names that 404s, a CSRF token it never sends:

  NODE_ENV (read at src/server/routes/admin.ts:6), production → development
    + admin (GET /admin)

Register the routes unconditionally and gate their behaviour inside the handler instead.
```

Each varied value that changes the file gets a section of its own (`production → test` too, for a
route registered under every value but `production`). The difference line names what changed: a route (`+ admin (GET /admin)`), a field
(`~ ping: csrf 'required' → none`), an order (`order of the app's routes: a, b → b, a`), or both
lists of mount lines. Fix: register the route, `.csrf()` or mount unconditionally and branch inside
the handler. The [codegen README](../../../packages/core/src/codegen/README.md#when-it-refuses)
lists what is and is not covered.

### Auth refuses to start: two copies of `hono`

With `secondFactor.required: true`:

```
Refusing to start: @spfn/auth cannot read the server's routes — two copies of hono are loaded in
this process — the one the server runs on and the one @spfn/auth imports. Check that `hono`
resolves to one install for the app, @spfn/core and @spfn/auth (`pnpm why hono`), and that the
server runs as one module format: under `spfn dev` from a spfn CLI of the same release as
@spfn/core, or with "type": "module" in the app's package.json.
```

Under a custom `app.ts`, where that check does not run, an enrolment-only session's request is a
500 with `@spfn/auth cannot read which route this request matched — …` in the log. Fix: one
`hono` install, and step 2 for `spfn`. The
[auth README](../../../packages/auth/README.md#install) has the details.

### pnpm reports an unmet peer

A 0.4 package beside a 0.3 one, or beside an old Next.js:

```
 WARN  Issues with peer dependencies found
.
└─┬ @spfn/auth 0.4.0-beta.1
  └── ✕ unmet peer @spfn/core@">=0.4.0-beta.1 <0.5.0-0": found 0.3.0-beta.38
```

```
  └── ✕ unmet peer next@^16.4.5: found 16.4.3
```

Fix: step 2 for every package it names, step 1 for Next.js. pnpm reports only this direction,
because it checks peers with prereleases included. The 0.4 ranges end `-0` (`<0.5.0-0`), so they
refuse the next line's betas as well as 0.3. The published 0.3 ranges end `<0.4.0` and cannot
change, and `0.4.0-beta.1` orders below `0.4.0`, so a 0.3 package left beside a 0.4 `@spfn/core`
installs without a warning. That is why every `@spfn/*` package is upgraded together;
`pnpm list --depth 0` shows what you still have on 0.3.

### npm refuses the app: `drizzle-typebox`

`spfn add` or `spfn init` in an npm app:

```
❌ npm refuses this app (ERESOLVE): package.json lists drizzle-typebox, whose peer range drizzle-orm >=0.36.0 excludes the 1.0.0-rc.4 SPFN pins. Remove drizzle-typebox from package.json, or import drizzle-orm/typebox-legacy instead.
```

`npm install` itself fails with `ERESOLVE` on `drizzle-typebox@0.3.3`. Earlier scaffolds listed
`drizzle-typebox`, which no template imports, and the CLI passed `--legacy-peer-deps` to every
npm run so that npm accepted it; the CLI no longer passes the flag. Fix: `npm uninstall
drizzle-typebox` (if your code imports `createInsertSchema` and the like, import them from
`drizzle-orm/typebox-legacy`). pnpm, yarn and bun install the app as before.

### A Kit release refuses the CLI

`spfn kit` refuses a release whose manifest's `spfnCli` range the running CLI is outside:

```
✗ This spfn CLI is outside the range the release supports.
  KIT_CLI_INCOMPATIBLE
```

(`--json` adds the running version, the required range and the release.) The 0.4 beta CLI does
not get this from a range ending `<0.4.0`, but only because the range check orders `0.4.0-beta.1`
below `0.4.0`; it says nothing about whether the release works with 0.4. If you own the app, use a
Kit release made for 0.4 once one exists. If you author a Kit release, end its range `<0.4.0-0` to
exclude the 0.4 betas. See
[`spfn kit`](../../../packages/cli/README.md#spfn-kit).
