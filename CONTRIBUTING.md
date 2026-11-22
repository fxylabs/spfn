# Contributing to SPFN

Thanks for considering a contribution. SPFN is a TypeScript monorepo (pnpm +
Turborepo), and this page is the entry point for both people and AI coding agents.
Point your agent at this file; everything it needs to follow is here.

By participating you agree to our [Code of Conduct](./CODE_OF_CONDUCT.md).

## What this repo is

SPFN (Superfunction) is a TypeScript framework for building full-stack apps with a
Next.js frontend and a typed SPFN backend, published as a set of `@spfn/*` packages.

```
packages/   published framework packages (@spfn/core, @spfn/auth, … and the `spfn` CLI)
examples/   runnable example apps (also pnpm workspace members)
docs/       prose documentation
apps/        LOCAL-ONLY scratch apps — gitignored, never part of a PR
```

Deep, authoritative documentation for each package lives in its own
`packages/<name>/README.md` — these are maintained as the AI-facing source of truth.
**Read the relevant package README before changing that package.** Nothing here
restates their contents.

## Quick start

Requires Node 22.23.4+ (or 24.22.1+, 26.12.1+) and pnpm (see `packageManager` in `package.json`). From the repo root:

```bash
git clone <your fork>
cd spfn
pnpm install            # install all workspace deps
pnpm setup:examples     # give each example the .env.local its build needs
pnpm build              # build every package (turbo; runs a circular-dep check first)
pnpm test               # run all tests (vitest)
pnpm lint               # eslint — house style (Allman, 4-space, semicolons)
pnpm lint:fix           # auto-fix style violations
pnpm audit              # known vulnerabilities in the production dependency graph
pnpm audit:all          # the same, including build tooling
pnpm check:versions     # docs and peer ranges name the same Next.js floor
```

`pnpm setup:examples` is not optional before your first `pnpm build`. The root build
reaches the examples, an example's `next build` collects page data, and collecting it
validates the environment — where `SPFN_API_URL` is required. That value lives in
`.env.local`, which is gitignored, so a fresh clone has none and the build fails at
`examples/01-minimal-api`. Turbo then cancels the remaining builds, `@spfn/auth` never
produces `dist/`, and 34 of its test files fail on a missing self-import. The script
copies each example's committed `.env.local.example` and leaves an existing `.env.local`
alone.

Per package (run inside `packages/<name>/`):

```bash
pnpm build              # tsup build (+ madge circular check, bundle identity check)
pnpm type-check         # tsc --noEmit
pnpm test               # vitest run
pnpm test:unit          # unit tests only (where present)
pnpm check:circular     # madge --circular
```

Every package's `build` ends with `scripts/check-bundle-identity.mjs`, which fails when one source
module is emitted into two `dist/` files, so that a class or a singleton is one object in every entry
point. It reads the record esbuild writes of each build, so every tsup config passes
`recordMetafile('<label>')` (from `scripts/lib/bundle-identity.mjs`, one label per config) to
`esbuildPlugins`; a `dist/` file no record names fails the check, and so does one that two records
name (two configs writing one path) or a record naming a file that is not there (left from an earlier
build — clean `dist/` and build again). When it reports a module twice,
keep `splitting: true` in the package's tsup config; a separate tsup config, such as auth's
`'use client'` build, must reach the main build's modules by package name (or the package's private
`imports`), never by a relative path. Auth and monitor do the latter: `#nextjs/client-shared` names
a main-build entry, the vitest config aliases it to source, and the package's
`scripts/check-bundle.mjs` calls `checkPrivateImports` (`scripts/lib/private-imports.mjs`) so that
every `#…` import in `dist` resolves.

Codegen and migrations (in packages/apps that use them):

```bash
pnpm codegen            # spfn codegen run — regenerates route maps etc.
pnpm db:generate        # drizzle-kit generate — create a migration from schema changes;
                        # in a function package, then migrations/privileges.json
```

## Version floors are a security surface

A published `peerDependencies` range is what an adopter resolves against, so a range
that still admits a vulnerable release ships that vulnerability to every app installing
the package. `@spfn/*` packages that couple to Next.js require `^16.4.5` — the floor
that clears the seven advisories of the 2026-11-03 release, all fixed in 16.4.5: three
information disclosures through `use cache` functions (GHSA-mfr8-8qww-v76h across root params
called through `unstable_cache()`, GHSA-vc7v-qv4w-wrv8 through nested functions,
GHSA-rhh4-g77r-r9qj through binary arguments), GHSA-vvgp-ww4w-46vf (a poisoned fallback shell
under Cache Components), GHSA-pc58-hwjq-p385 (response desynchronisation when a route returns
a fetched `Response` behind a pipelining proxy), GHSA-f3mh-rxg3-f5g2 (cookies set by an Edge
route handler exposed in a response header) and GHSA-7qx7-33qx-rqx2 (image optimization of
an attacker-supplied SVG); GHSA-2464-fhr4-w9xw and GHSA-673q-mjm6-r5xr (both critical remote code
execution, through image optimization of SVG files and through `use cache` functions returning
typed arrays) and GHSA-p3m5-59mp-jv5r (Server Actions denial of service), all fixed in 16.4.1;
GHSA-vcvr-r3jv-pc5j (critical, fixed in 16.3.6) and GHSA-cjq9-62q9-8jv4 (high,
fixed in 16.3.8), and, further back, GHSA-p293-qw3h-jr36 and GHSA-2xp9-vwfh-vxw4 (remote
code execution through a Windows-hosted server and through image optimization), CVE-2025-66478
(remote code execution through React Server Components) and the Server Components denial
of service. Next.js 15 is not supported: its patches landed per minor line (15.0.5,
15.1.9, 15.2.6, …), so no single caret range can express "patched".

Prose says the floor too, and prose drifts. `pnpm check:versions` compares every
`packages/*/package.json` peer range against every README, `docs/` page and the site's
own requirements — the packages must agree with each other, and the documentation must
agree with them. `.github/workflows/check-versions.yml` runs it on every pull request.

Node has a floor for the same reason. The repository root, every package that declares
`engines.node` and the `package.json` that `spfn init` writes all require
`^22.23.4 || ^24.22.1 || >=26.12.1`. The releases of 2026-10-21 fixed CVE-2026-111497, remote
code execution in the Brotli decoder Node bundles, reachable whenever an app decompresses
Brotli data an attacker supplies — `fetch` does so for any `Content-Encoding: br` response,
including one `safeFetch` receives from an attacker-chosen URL. Node 20 reached end of life
before that release and will not be fixed, so it is not supported, and neither are the
out-of-support odd lines 23 and 25. `pnpm check:versions` compares the Node range the same way:
one range across the manifests, and every sentence stating a Node requirement names one of
its floors.

PostgreSQL's floor has a different reason. The code runs on 13 and later, because
`gen_random_uuid()` is a column default and moved into the server in 13; the stated
floor is 14 because 13 stopped receiving fixes in November 2025. `@spfn/monitor` also
needs `CREATE EXTENSION pg_trgm`, which some managed providers withhold.

Advisories are usually published long after the affected code is written, which is why
`.github/workflows/security-audit.yml` runs daily rather than only on a pull request. It
fails on a high or critical finding in the production graph and reports everything else.
One high advisory is ignored by name in the root `package.json` (`pnpm.auditConfig`):
CVE-2026-93687 (GHSA-vfj7-8cjw-p6xm), a stack-exhaustion denial of service in braces through
deeply nested brace patterns, which has no patched release. `@spfn/core` reaches it only
through micromatch, whose patterns come from the developer's own codegen and db
configuration (including the `DRIZZLE_SCHEMA_PATH` environment value) and from the
`spfn.schemas` field in the `package.json` of installed SPFN packages and direct
dependencies, and never from a request; remove the entry when braces or micromatch
ships a fix.

The root `devDependencies` lists `vite` although nothing imports it. vite reaches the
repository as a peer dependency of vitest, and pnpm keeps an auto-installed peer at the
version it first resolved — a lockfile update, and even an override, left it on a release
whose dev server reads files it should refuse. pnpm resolves peers from the workspace root
first, so the root entry is what moves every package's vitest onto a patched vite. Raise it
when vite publishes a fix, the same way as any other floor.

A root `pnpm.overrides` entry moves this workspace and nobody who installs a published
package, so it cannot be what makes a published package safe. The check is an adopter's
install, at its worst: each of a package's `dependencies`, `optionalDependencies` and
`peerDependencies` at the lowest version its range admits, and below it every transitive at
the lowest version its parent's range admits — what an adopter keeps whose lockfile already
holds those versions, since upgrading our package re-resolves only what our ranges no longer
admit. `npm install` resolves the newest, so it cannot build that tree; resolve it from the
registry metadata (`npm view <pkg>@<version> dependencies`, a peer satisfied by the version
an ancestor or the package itself provides) and send the name → versions map to the bulk
advisory endpoint, `POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk`. Where
a later release of our direct dependency excludes what that finds, the published range moves
to it. That is why `@spfn/signing` requires `@google-cloud/kms` `^6.0.0` (5 reaches, through
google-gax and gaxios 7, a rimraf on glob 10 and minimatch 9, which have no release fixing
GHSA-3g3m-2fjr-6pw4 or GHSA-g3hv-75wg-m249); `@spfn/auth` `jsonwebtoken` `^9.0.3` (9.0.2
admits `jws` 3.2.2, GHSA-869p-cjfg-cm3x; 9.0.3 requires `jws` `^4.0.1`); `@spfn/storage`
`@google-cloud/storage` `^8.3.0` (every 7.x and 8.0–8.2 reach a `uuid` with
GHSA-w5hq-g745-h8pq); and every AWS client — signing's `@aws-sdk/client-kms`, notification's
`@aws-sdk/client-sns` and `@aws-sdk/client-sesv2`, storage's `@aws-sdk/client-s3` and
`@aws-sdk/s3-request-presigner` — requires `^3.1074.0`. A client before 3.974.0 pins
`@aws-sdk/core` exactly, and later ones admit by caret a core whose XML builder reaches a
vulnerable `fast-xml-parser`; 3.1074.0 is the first release whose lowest graph is clean. The
lowest-graph standard counts every severity, not only critical and high: the last step, 3.1073.0
→ 3.1074.0, is driven by a low advisory (`fast-xml-parser` 5.7.3, GHSA-474x-hrwr-fgx4). An optional
peer is a range like any other. pnpm installs it into this workspace from the peer range
itself, so raising the range is also what moves the version the tests run against;
`@spfn/notification` names its AWS clients as devDependencies as well, and `@spfn/signing`
deliberately does not (its X1 test keeps the KMS SDKs out of every dependency field).

The table lists every key of the root `pnpm.overrides`, what it is for, and where it is
reached. An override moves this workspace and nobody who installs a published package. Where a
row says "no upstream fix", an adopter installing today gets a patched release inside the third
party's own range, but an adopter whose lockfile already holds the vulnerable release keeps it,
and no range of ours can exclude it until that third party publishes one that does.

| Key | Reason | Path |
| --- | --- | --- |
| `react` | One React in the workspace. The packages' peers admit 18 and 19 and the examples pin 19.2.3; two copies side by side broke Next.js's types. | Tooling; an adopter brings its own React. |
| `react-dom` | Same, for react-dom. | Tooling. |
| `@types/react` | One set of React types, for the same reason. | Tooling. |
| `@types/react-dom` | Same, for react-dom's types. | Tooling. |
| `drizzle-kit` | Pins drizzle-kit to the same release candidate as drizzle-orm. | Tooling: spfn, the packages' `db:generate`, examples. |
| `drizzle-orm` | One Drizzle release candidate in the workspace, the one every package and example pins (`1.0.0-rc.4`). A prerelease satisfies no plain range, so a dependency whose peer is a plain `drizzle-orm` range would otherwise pull a separate 0.x drizzle-orm next to the RC. | Workspace; production code reaches it through each package's own `drizzle-orm`. |
| `next` | Every Next.js in the workspace on the floor the packages require (`^16.4.5`), including one pnpm installs to satisfy a peer. | Workspace; an adopter gets the floor from our `next` peer ranges. |
| `picomatch@2` | GHSA-c2c7-rcm5-vvqj, GHSA-3v7f-55p6-f55p. | Production: core → micromatch 4.0.8 → picomatch `^2.3.1`. No upstream fix: 4.0.8 is micromatch's latest release. |
| `shell-quote` | GHSA-w7jw-789q-3m8p, GHSA-395f-4hp3-45gv. | Dev: concurrently, in spfn's devDependencies. |
| `lodash-es` | Added before cms raised its own range; cms now depends on `^4.18.1`, so it changes nothing. | Production: cms, directly. |
| `minimatch@>=7 <11.0.1` | GHSA-g3hv-75wg-m249: eslint and @typescript-eslint reach a minimatch 10 with no fix. | Tooling. |
| `rollup` | GHSA-mw96-cpmx-2vgc. | Dev: vite 7.3.7 → rollup `^4.43.0`. spfn's own path no longer needs it: tsup 9 requires rollup `^4.64.6`. |
| `yaml` | GHSA-48c2-rrv3-qjmp. spfn and pages depend on `^2.8.3` themselves; the override covers vite's and postcss-load-config's. | Tooling. |
| `js-yaml@3` | The js-yaml 3 advisories fixed in 3.15. | Production: pages → gray-matter 4.0.3 → js-yaml `^3.13.1`. No upstream fix: 4.0.3 is gray-matter's latest release. |
| `nanoid@<3.3.18` | GHSA-2v37-7h3g-55p8. | Production: Next.js pins postcss 8.5.23 → nanoid `^3.3.16`. No upstream fix: Next.js 16.4.5 and 16.4.6 both pin that postcss. |
| `@babel/core@<7.29.6` | GHSA-4x5r-pxfx-6jf8. | Dev: styled-jsx's optional peer under the Next.js the packages test against, and the examples' `@svgr/webpack`. An adopter's Next.js install does not install the optional peer. |
| `browserslist@<4.28.7` | GHSA-c83g-rgw3-j3cx, GHSA-73wf-gq98-2v4g. | Dev: the same Babel helpers. |
| `@grpc/grpc-js@<1.14.5` | GHSA-m9gg-hp2v-232j. | Production, optional peer: signing → `@google-cloud/kms` 6 → google-gax 6 → `@grpc/grpc-js` `^1.12.6`. A fresh install at kms 6.0.0 resolves 1.14.7 and audits clean. No upstream fix: no kms or google-gax release excludes grpc-js below 1.14.5. |
| `source-map-js@<1.2.2` | GHSA-68fv-2mgg-jv7q. | Production: Next.js's pinned postcss 8.5.23 → source-map-js `^1.2.1`. No upstream fix, as for nanoid. |
| `sharp@<0.35.5` | Next.js 16.4.5 itself requires sharp `^0.35.5`, so with our `next` floor this changes nothing. | Production: Next.js. |

Scope an override to the major it repairs (`picomatch@2`, not `picomatch`). A blanket one also
drags packages that ask for the next major back onto the old one, and the workspace then tests a
graph no adopter gets.

`patches/tsup@9.0.0.patch` makes tsup build one declaration program per config (#352). A tsup bump
carries it to the new version, or drops it once tsup bundles a fixed rollup-plugin-dts
([upstream issue](https://github.com/Swatinem/rollup-plugin-dts/issues/408)); otherwise `pnpm install`
fails with `ERR_PNPM_PATCH_NOT_APPLIED`.

## Running the tests

Integration tests need PostgreSQL and Redis. They run against the machine's own
installation, not containers: PostgreSQL is shared, one logical database per
package (`spfn_test`, `spfn_auth_test`, `spfn_cms_test`), and Redis runs as four
small instances on dedicated ports because the cache tests need a replication
pair and a password-protected instance. One script sets all of it up:

```bash
./scripts/test-services.sh start    # from the repo root; also `stop` and `status`
pnpm test                           # integration tests are part of the default run
```

Override the database with `TEST_DATABASE_URL` if yours does not live on 5432.

`pnpm test` also needs `age` and `sops` 3.10 or later on `PATH`: the CLI's secret
tests (`packages/cli/src/commands/secret/__tests__/`) generate a key with
`age-keygen` and encrypt with the real `sops`. On macOS, `brew install age sops`. On
Debian or Ubuntu, `apt-get install age` gives you `age`, but sops has no package
there — take a release binary from https://github.com/getsops/sops/releases, as
the `test` step in `.woodpecker/pr.yml` does.

**Tests run one at a time, on purpose.** The root `pnpm test` passes
`--concurrency=1` to turbo and every package's vitest config pins a single worker
running one file at a time. Two reasons: the packages share one PostgreSQL and one
Redis, and a developer machine has fewer cores than turbo and vitest would
otherwise both fan out across — a run that starves itself times out before its
assertions get to run. Do not raise either number to make a run finish sooner.
Per-package CI (`pnpm test` inside `packages/<name>/`) is unaffected.

## The SPFN pattern

A feature is built as a vertical slice, each layer in its own file:

`Entity` (Drizzle table) → `Repository` (extends `BaseRepository`) → `Route`
(`route.get/post/...` with TypeBox validation) → `Router` (`defineRouter`) →
generated route map (`pnpm codegen`) → typed client (`createApi<AppRouter>()`).

`examples/01-minimal-api` is the smallest end-to-end reference for this flow, and
`examples/02-database-crud` adds the entity and repository layers. For the full pattern
(auth, errors, services, DTOs) read `examples/03-auth` plus `packages/auth/README.md`
and `packages/core/README.md`.

## The development loop

1. Branch from `main`: `git checkout -b feat/short-description`.
2. Make a focused change. Follow the SPFN pattern and code style described here.
3. If you changed routes, run `pnpm codegen` and commit the regenerated output.
   If you changed a Drizzle schema, run `pnpm db:generate` for the migration.
4. Make sure `pnpm build`, `pnpm test`, and `pnpm lint` pass.
5. Open a PR against `main` and fill in the template.

## Hard rules

1. **Never hand-edit generated files.** Route maps (`src/generated/route-map.ts`,
   `src/generated/route-map.*`) are produced by `pnpm codegen`. Change the source
   routes/router and re-run codegen; commit the regenerated output.
2. **Migrations come from the schema.** Don't write SQL migrations by hand — edit the
   Drizzle entity and run `pnpm db:generate`.
3. **`apps/` is local-only and gitignored.** Nothing under `apps/` belongs in a PR.
   Runnable examples go in `examples/` (a workspace member).
4. **Secrets never appear in output, code, logs, or commits.** Do not read or print
   values from `.env*` files — confirm a key's presence by name only. `.env.local` is
   gitignored; only `*.example` env files are committed, with placeholder values.
5. **Verify before you open a PR.** `pnpm build` and `pnpm test` must pass. If you
   touched routes, `pnpm codegen` must have been run and its output committed.

## Code style

The source of truth is the linter/formatter config, not prose — run the tooling and
match what it produces. The established house style is:

- **Allman braces** — every block's opening `{` goes on its own line.
- **4-space indentation, semicolons required.**
- Small, single-responsibility functions.

Do **not** run Prettier to "fix" formatting: Prettier cannot express Allman braces and
will rewrite the entire codebase to the wrong style. Style is enforced via ESLint
(`@stylistic`); run `pnpm lint` and match the surrounding code.

## Pull requests

- **One concern per PR.** Small, single-purpose diffs get reviewed and merged faster.
- **CI must be green.** Build, tests, and lint run on every PR regardless of how the
  code was written.
- **Conventional Commits** for titles and commits: `type(scope): subject` — e.g.
  `feat(auth): …`, `fix(core): …`, `docs(examples): …`. A breaking change uses `!`
  (`fix(deps)!: …`).
- **DCO sign-off is required**: commit with `git commit -s` so every commit carries a
  `Signed-off-by:` line. See [DCO](#dco) below.
- Update the relevant package `README.md` when you change public behavior — those
  READMEs are the source of truth, including for AI agents.

## Working with AI agents

Most contributors will use AI assistance, and that's welcome. Two expectations:

- **You own what you submit.** Whether you typed it or an agent generated it, you are
  responsible for the code: you must understand it, and it must pass every check. We
  review the diff, not the process — you don't need to disclose AI use.
- **Let the agent read the rules.** This file is the contract an agent is expected to
  follow. Point your tool at it, and at the `README.md` of whichever package you are
  changing.

## Versioning

Packages are in **beta** (`0.x.y-beta.N`) / alpha. Do not bump a package to a stable
(non-pre-release) version.

## Publishing

Publishing is a maintainer task. [`.github/PUBLISHING.md`](./.github/PUBLISHING.md)
describes it: the two registries, the per-package workflows, the `latest` dist-tag
sync, and the gotchas. `RELEASE.md` describes the retired tag-triggered release and is
kept for history only; nothing publishes off a git tag any more.

## DCO

Contributions are accepted under the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO). It is a lightweight statement that you wrote the contribution or otherwise have
the right to submit it under the project's license. Certify it by signing off each
commit:

```bash
git commit -s -m "feat(core): add ..."
```

This appends a line to the commit message:

```
Signed-off-by: Your Name <you@example.com>
```

The name and email must be real and match your Git identity. PRs whose commits are not
signed off cannot be merged. If you forget, `git commit --amend -s` (or an interactive
rebase for multiple commits) fixes it.

## Security

Do not open public issues for vulnerabilities — see [SECURITY.md](./SECURITY.md) for
private disclosure.

## License

By contributing, you agree your contributions are licensed under the repository's
[MIT License](./LICENSE).
