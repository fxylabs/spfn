# @spfn/pages-next

> **One content repo, deployed your way or hosted for you**

Next.js integration for [`@spfn/pages`](../pages/README.md) — turns a validated
site model into a deployable site. One package, two modes:

- **Single-tenant (self-deploy)** — the content repo carries a ~4-file Next.js
  scaffold and deploys anywhere Next.js or static output runs: Vercel,
  Cloudflare Pages, your own server. Static export (`output: 'export'`) is fully
  supported.
- **Multi-tenant (SPFN hosting)** — the hosted edge reuses the same layouts and
  helpers, resolving the tenant per request. No scaffold needed in the content
  repo; registering the repo link is enough.

## Installation

```bash
pnpm add @spfn/pages @spfn/pages-next
```

Peer deps: `next` (`^16.3.3`), `react` and `react-dom` (`^19.2.1`).

## Self-deploy usage

The whole route surface is an optional catch-all:

```tsx
// app/[[...slug]]/page.tsx
import { createSitePages } from '@spfn/pages-next';
import { FsContentSource } from '@spfn/pages/server';

const site = createSitePages({ source: () => new FsContentSource('.') });

export const generateStaticParams = site.generateStaticParams;
export const generateMetadata = site.generateMetadata;
export default site.Page;
```

`FsContentSource('.')` reads the checked-out repo directly — builds see exactly
the commit they run on, no GitHub API calls, no rate limits.

Build script (`package.json`):

```json
{ "build": "spfn-pages sync && next build" }
```

`spfn-pages sync` materializes the two things Next.js can't render from the
site model into `public/` before the build:

- raw HTML escape-hatch pages (`site/pages/*.html` → `public/<slug>/index.html`)
- `site/public/` assets (copied as-is, binary-safe)

The package ships a stable `bin/spfn-pages.js` launcher so package managers can
link the command during installation, before the compiled `dist/cli.js` exists.
Build `@spfn/pages-next` before invoking the command in a fresh workspace; the
root Turborepo build enforces that dependency order.

When `spfn.site.yaml` sets `url:`, sync also generates the site-wide SEO
surface. `sitemap.xml` enumerates every served route (markdown docs and html
pages alike — sync is the one place that sees them all) and `robots.txt`
allows crawling and points at the sitemap; a file of the same name in
`site/public/` wins and suppresses generation. Each written html page gets a
`<link rel="canonical">` injected before `</head>` unless it already declares
one — the canonical URL is deployment config (`url:` + slug), not design
content, so it lives here rather than in the authored html.

Every output is recorded in `public/.spfn-pages-sync.json`; the next run deletes
recorded outputs it no longer produces (a moved landing, a removed asset), so
stale pages never ghost into the static export. Files sync never wrote — things
you placed in `public/` by hand — are left alone.

For Cloudflare Pages / any static host, set `output: 'export'` in
`next.config.js`. On Vercel the default runtime build works too. Push-to-update
is the host's standard deploy hook wired to the repo.

## Exports

- `createSitePages({ source, revalidate? })` → `{ generateStaticParams, generateMetadata, Page, getSite }`
- Layouts: `SiteShell`, `LandingLayout`, `DocLayout`, `PostLayout`, `PostsIndexLayout`
- `DEFAULT_CSS` — baseline stylesheet, every value overridable via `--sf-*` tokens
- `syncSite({ root, out })` — programmatic form of the CLI

Conventions the layouts assume: `doc`/`post` pages render the frontmatter
`title` as the page `<h1>`, so markdown bodies start at `##`; a virtual
`/posts` index is served when no page claims that slug. The footer
(`.sf-footer`) repeats the site brand (`.sf-footer-brand`) and nav
(`.sf-footer-nav`), then appends social links — skipping any social entry
whose URL already appears in the nav — with brand casing via `socialLabel`
(`github` → `GitHub`). Header/footer nav and social links with an absolute
`http(s)` URL open in a new tab (`target="_blank" rel="noopener"`); internal
paths stay in-tab. A `footerNote` in `spfn.site.yaml` renders after the
footer nav as `.sf-footer-note` (right-aligned by default).

`DocLayout` shows a **section sidebar** from `site.sections` (the navigation
trees `loadSite` derives from doc slugs): the tree for the page's first path
segment, current page marked `aria-current`, label-only group nodes for
segments nobody serves. The section root renders as the first flat item and
its children as the top-level list — the whole tree does not nest under the
index page's title. Labels come from frontmatter `navTitle` (fallback
`title`). Sections with fewer than two docs render no sidebar
(a lone page navigates nowhere). Layout is sticky-aside on wide screens and
stacks above the content below `56rem`; styling rides on `.sf-sidebar` /
`.sf-doc-shell` in `DEFAULT_CSS`, overridable via theme tokens and
`custom.css`.

`generateMetadata` also emits the site's well-known assets: `site.favicon`
becomes the `<link rel="icon">` (svg/png/ico/jpg, typed by extension) and
`site.ogImage` the default `og:image` (frontmatter `og:` wins per page).
`og:site_name` is always the site name. When `spfn.site.yaml` sets `url:`,
it becomes `metadataBase` and every doc page additionally gets a canonical
link and `og:url` (slug resolved against the base); without `url:` those two
are omitted rather than emitted as relative paths.

## Dev serving for html pages (`@spfn/pages-next/dev`)

`next dev` resolves the app catch-all before `public/`, so synced html pages
404 in dev and were previously previewable only through a static build. The
`/dev` subpath (import it — not the package root — in `next.config`, which
cannot load `next/navigation`) fixes that with two pieces:

- `devHtmlRewrites(root)` — dev-only `beforeFiles` rewrites mapping each
  `<root>/pages/**/*.html` route to the dev handler. Scanned once at
  dev-server start: a **new** html file needs a restart, edits do not.
- `createDevHtmlHandler({ root })` — a route handler that reads the source
  html per request (`no-store`), mounted as a **dev-only route file**
  `app/spfn-dev-html/[...slug]/route.dev.ts`:

  ```ts
  export const { GET } = createDevHtmlHandler({ root: '../site' });
  ```

  ```ts
  // next.config.ts
  const isDev = process.env.NODE_ENV === 'development';
  pageExtensions: isDev ? ['ts', 'tsx', 'dev.ts'] : ['ts', 'tsx'],
  ...(isDev ? {} : { output: 'export' as const }),
  ...(isDev ? { rewrites: async () => ({ beforeFiles: await devHtmlRewrites('../site') }) } : {}),
  ```

Why this exact shape: an `_`-prefixed app folder is private (unrouted), route
handlers support only required catch-alls (`/` arrives as the `index` slug),
and `output: 'export'` refuses route handlers whose `generateStaticParams` it
cannot statically see — so both the export mode and the `.dev.ts` route
extension are gated to keep the route out of production builds entirely.

## Hosted edge (`@spfn/pages-next/hosted`)

The multi-tenant serving mode. The edge is a **plain HTTP server, no Next** —
React runs server-side as the template engine over the same layouts, and every
response is a complete document with zero framework JS (the only script a page
can carry is the site's own opt-in `analytics` loader). Raw HTML pages serve
verbatim, `public/` assets stream as bytes.

```ts
import { HostedSiteCache, serveSiteRequest } from '@spfn/pages-next/hosted';

const cache = new HostedSiteCache({ headTtlMs: 30_000, maxSites: 100 });

// per request: Host header → tenant record → repo URL
const { site, source } = await cache.get(tenant.repoUrl);
const response = await serveSiteRequest(site, source, url.pathname);
// response: { status, contentType, body: string | Uint8Array } | null (edge's 404)
```

`HostedSiteCache` re-resolves a repo's HEAD at most once per TTL (an
ETag-revalidated 304 when nothing changed — free against the rate limit) and
caches site models under `repo@sha`. A SHA-keyed model is immutable, so pods
never coordinate invalidation; a push shows up within one TTL. When GitHub is
unreachable the last known commit keeps serving. `serveSiteRequest` resolves,
in order: raw html page → rendered doc (with full head metadata — title,
description, og, favicon) → virtual `/posts` index → `public/` asset →
generated SEO file; `null` means the edge renders its own not-found page.
Path traversal is rejected before any read.

The edge emits the same SEO surface as sync, per request instead of at build
time: when the config sets `url:`, rendered docs carry a canonical link,
`og:url`, and `og:site_name`, html pages get a canonical injected unless they
declare one, and `/sitemap.xml` + `/robots.txt` are generated on demand — a
file of the same name in the site's `public/` wins, since assets resolve
first. Without `url:` none of this appears.

## Status

Beta, stage 3 of the frontend serving primitive. Deploy targets being
verified end-to-end: Cloudflare Pages, Vercel, SPFN hosting. Coming next:
the site template repo (with `site/AGENTS.md`), then the hosted tenant edge
service (registration, `*.spfn.app` subdomains, custom domains).
