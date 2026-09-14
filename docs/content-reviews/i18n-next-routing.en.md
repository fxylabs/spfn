# `@spfn/i18n` Next.js routing quality review

- Brief: docs/content-plans/i18n-next-routing.md
- Brief revision: v0.1
- Content file: packages/i18n/README.md
- Content SHA-256: 13b619acc1e496bf0db5310cf759a9b66b43a631f5ed8762c74e5170b5f034a8
- Author: Codex package implementation session
- Reviewer: Luna independent reviewer
- Reviewed at: 2026-08-25
- Supported reader and path: A Next.js user integrating locale-prefixed pages with `@spfn/i18n`; Next.js `^16.3.3`, configured locale tuples, and application-declared localized paths
- Verdict: ready

## Review scope

The required outcome is that a reader can place the two package imports, predict `/`, `/en`, and `/ko` behavior with query preservation, and identify the routing decisions that remain in the application. I reviewed only the new Next.js installation note and routing section in `packages/i18n/README.md`. The trust boundary is the documented public-path and NextRequest rewrite/redirect behavior for declared paths. Locale detection, catalogs, layouts, matcher generation, and broader SEO are excluded. Stop when the documented commands, ownership boundary, and tested behavior are unambiguous.

## Claims and evidence

- The installation command `pnpm add next@^16.3.3` matches the package peer dependency and the supported Next.js 16.x line (`packages/i18n/README.md:21-24`, `packages/i18n/package.json:64-67`).
- The routing example imports `defineI18nRouting` from `@spfn/i18n/routing` and `createLocaleProxy` from `@spfn/i18n/next`, matching the package exports and source modules.
- The `as-needed` example correctly describes `/` as an internal `/en` rewrite, direct `/en` as a 308 redirect to `/`, and `/ko` as public. Query preservation is covered by the implementation tests.
- The README explicitly keeps locale detection, validation, catalogs, layouts, static params, and the proxy matcher in the consuming application. It does not claim automatic discovery or localization of every route.
- The metadata example matches `localizedMetadata`: canonical `/ko`, reciprocal `en=/` and `ko=/ko`, and `x-default=/`.

## Sentence and visual jobs

| Location | C/E/A/R/D | Reader value | Finding | Action |
| --- | --- | --- | --- | --- |
| Installation, `:19-24` | A | Installs the optional Next.js peer | Version line and command are precise | Keep |
| Routing policy, `:114-145` | C, A, R | Places both imports and predicts the three public paths | Examples are concrete and query behavior is stated | Keep |
| Metadata, `:147-157` | E, R | Connects public paths to canonical and alternate URLs | Output matches the tested policy | Keep |
| Ownership boundary, `:157` and FAQ | C, D | Prevents assuming the package discovers locales or owns app routes | Boundary is explicit | Keep |

## Supported-path run

Static review of `packages/i18n/src/routing.ts`, `src/next.ts`, tests, and package exports matched the README examples. The package routing and Next.js tests cover public-path normalization, canonical/alternate metadata, query preservation on rewrite and redirect, supported-locale pass-through, and undeclared route pass-through. Coordinator evidence records `pnpm --filter @spfn/i18n test` 19/19, type-check, lint, package build/circular check, and `pnpm check:versions` as passing; root `pnpm build` passed 17/17 tasks and root `pnpm test` passed 18/18 tasks. The external consumer gate is complete: the package tarball `/private/tmp/spfn-i18n-0.2.0-beta.2.tgz` installed in the minimal Next.js 16.3.0 app at `/private/tmp/spfn-i18n-next-consumer-0825`, and `pnpm build` passed TypeScript, static generation, `/en`, `/ko`, and the Proxy manifest.

## Independent reviewer answers

1. The reader is a Next.js user who already has catalogs and needs one shared public URL policy.
2. The section separates URL policy from translations and shows exactly where the two entry points are imported.
3. The examples make `/`, `/en`, `/ko`, query retention, metadata output, and app-owned decisions observable.
4. No material comprehension or claim error was found in the reviewed section.

## Reader evidence

Not required by the brief for this package documentation review. The consuming-app production build is recorded above as completed evidence; no reader evidence was fabricated.

## Remaining hypotheses and next check

No further in-scope content check is required. The consumer build evidence should remain attached to this reviewed revision if the package tarball or README changes.

## Sufficient evidence and stop condition

The reviewed installation/routing claims, examples, ownership boundary, package source/tests, root checks, and minimal consumer build agree, with no material content finding. The content verdict remains `ready`.
