# `@spfn/i18n` Next.js routing documentation brief

- Status: approved
- Revision: v0.1
- Approved by: operator
- Approved at: 2026-08-25
- Author: Codex package implementation session
- Planned content file: `packages/i18n/README.md`

## Reader state

The reader already uses Next.js and needs locale-prefixed pages, but must decide how public URLs, the internal `[locale]` route tree, proxy behavior and canonical metadata fit together. They may already use `@spfn/i18n` for catalogs and assume that adding translations also solves routing.

## Current attempt and problem

Applications commonly repeat locale lists and default-locale rules in `proxy.ts`, layouts and metadata. The values can drift: the default locale may appear at both `/` and `/en`, an undeclared API route may be rewritten, or canonical and hreflang URLs may disagree with the public route.

## Why it happens

Catalog translation and URL policy are separate concerns, but a small application often encodes the URL policy independently at every Next.js integration point.

## Product answer

`@spfn/i18n/routing` defines the shared URL policy and derives public paths and metadata. `@spfn/i18n/next` applies that policy only to pathnames the application declares localized. The application continues to own locale detection, catalogs, layouts, static params and the proxy matcher.

## Reader outcome

After the section, a reader can place the two imports, predict `/`, `/en` and `/ko` behavior, and identify which decisions remain in the application. They should not conclude that the package discovers locales or localizes every route automatically.

## Review dispatch contract

- Required behavior: explain the two package entry points, the `as-needed` example, query preservation, metadata output and application-owned boundaries.
- Touched production surface: the Next.js routing section and Next.js installation note in `packages/i18n/README.md`.
- Supported inputs: Next.js `^16.3.3`, configured locale tuples, and pathnames explicitly accepted by `isLocalizedPath`.
- Trust boundary: public path construction and NextRequest rewrite/redirect behavior for the declared paths.
- Explicit exclusions: Accept-Language and cookie detection, catalog loading, `[locale]/layout.tsx` implementation, matcher generation, application copy, SEO strategy beyond canonical/hreflang consistency.
- Stop condition: the commands and ownership boundary are unambiguous, match tested behavior, and an independent reviewer finds no material comprehension or claim error.

## Evidence plan

Run package tests, type-check, lint, build, version-policy check, a minimal consuming Next.js production build, and an independent README review. Do not broaden the review to other package documentation or unrelated i18n features.
