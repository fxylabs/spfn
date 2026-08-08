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

Requires Node ≥ 20 and pnpm (see `packageManager` in `package.json`). From the repo root:

```bash
git clone <your fork>
cd spfn
pnpm install            # install all workspace deps
pnpm build              # build every package (turbo; runs a circular-dep check first)
pnpm test               # run all tests (vitest)
pnpm lint               # eslint — house style (Allman, 4-space, semicolons)
pnpm lint:fix           # auto-fix style violations
pnpm audit              # known vulnerabilities in the production dependency graph
pnpm audit:all          # the same, including build tooling
pnpm check:versions     # docs and peer ranges name the same Next.js floor
```

Per package (run inside `packages/<name>/`):

```bash
pnpm build              # tsup build (+ madge circular check)
pnpm type-check         # tsc --noEmit
pnpm test               # vitest run
pnpm test:unit          # unit tests only (where present)
pnpm check:circular     # madge --circular
```

Codegen and migrations (in packages/apps that use them):

```bash
pnpm codegen            # spfn codegen run — regenerates route maps etc.
pnpm db:generate        # drizzle-kit generate — create a migration from schema changes
```

## Version floors are a security surface

A published `peerDependencies` range is what an adopter resolves against, so a range
that still admits a vulnerable release ships that vulnerability to every app installing
the package. `@spfn/*` packages that couple to Next.js require `^16.2.11` — the floor
that clears both CVE-2025-66478 (remote code execution through React Server Components)
and the Server Components denial of service. Next.js 15 is not supported: its patches
landed per minor line (15.0.5, 15.1.9, 15.2.6, …), so no single caret range can express
"patched".

Prose says the floor too, and prose drifts. `pnpm check:versions` compares every
`packages/*/package.json` peer range against every README, `docs/` page and the site's
own requirements — the packages must agree with each other, and the documentation must
agree with them. `.github/workflows/check-versions.yml` runs it on every pull request.

PostgreSQL's floor has a different reason. The code runs on 13 and later, because
`gen_random_uuid()` is a column default and moved into the server in 13; the stated
floor is 14 because 13 stopped receiving fixes in November 2025. `@spfn/monitor` also
needs `CREATE EXTENSION pg_trgm`, which some managed providers withhold.

Advisories are usually published long after the affected code is written, which is why
`.github/workflows/security-audit.yml` runs daily rather than only on a pull request. It
fails on a critical finding in the production graph and reports everything else.

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
