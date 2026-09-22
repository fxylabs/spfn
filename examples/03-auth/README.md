# 03 · Auth

Adds **authentication, sessions, and RBAC** to the [02 · Database CRUD](../02-database-crud)
slice using [`@spfn/auth`](../../packages/auth/README.md). Diff this against `02` to see
exactly what auth wires in — four small edits and one protected route.

## What it shows

- **Global authentication** with public opt-outs: reads (`listExamples`, `getExample`) are
  public via `.skip(['auth'])`; writes and `getMe` require a signed-in user.
- **A protected route** (`src/server/routes/me.ts`) reading the user via `getAuth(c)`.
- **Session-aware UI** (`src/app/page.tsx`) using `getSession()` in a Server Component.
- **Admin seeding from env** (`SPFN_AUTH_ADMIN_EMAIL`/`_PASSWORD` in `.env.server`) — the
  account is created on boot with the `superadmin` role.
- **A login page** (`src/app/login/page.tsx`): email/password form for seeded accounts
  (`authApi.login` — the interceptor saves the session cookie) plus the OAuth buttons.
- **Layout guards**: `/dashboard` wraps its children in `RequireAuth`
  (`src/app/dashboard/layout.tsx`), `/admin` in `RequireRole roles={['admin','superadmin']}`
  (`src/app/admin/layout.tsx`) — nested pages inherit protection, no per-page checks.
- The full `authApi` surface (register / login / session / logout / …) mounted at `/_auth/*`.
- **Real Google, Kakao, and Naver OAuth buttons**, provider-status detection, callback finalization, and logout.

This example is the finished code for the site tutorial
([superfunction.xyz/docs/tutorial](https://superfunction.xyz/docs/tutorial), source
`site/pages/docs/tutorial.md`).

## The four wiring points

| File | Wiring |
| --- | --- |
| `src/server/server.config.ts` | `.lifecycle(createAuthLifecycle())` — validates env, seeds admins, inits RBAC |
| `src/server/router.ts` | `.packages([authRouter])` + `.use([authenticate])` — mounts auth routes, applies global auth |
| `src/app/api/rpc/[routeName]/route.ts` | `import '@spfn/auth/nextjs/api'` (interceptor); the generated `routeMap` already holds the /_auth/* routes |
| migrations | `pnpm spfn db migrate` — creates the auth tables (users, keys, roles, …) |

Auth uses **asymmetric, client-signed JWTs**: the client holds the private key (in an
encrypted session cookie), signs each request, and the server verifies with the stored
public key. The server never holds a private key.

## Getting started

> Prerequisites: Node ≥ 20, pnpm, Docker (Postgres).
> The example uses `3890` for Next.js and `8890` for the SPFN API. It maps
> Postgres to `55432` and Redis to `56379` to avoid common port conflicts.

From the repo root, `pnpm install`. Then in this directory:

```bash
# 1. Start Postgres
docker compose up -d

# 2. Configure environment — secrets are split across two files by audience
cp .env.local.example .env.local      # SPFN_AUTH_SESSION_SECRET lives here (Next.js)
cp .env.server.example .env.server    # provider/token secrets live here (server only)

# Replace every <...> placeholder. Generate independent random values; do not reuse them.
openssl rand -base64 48               # session or verification secret
openssl rand -base64 32               # OAuth token encryption key material

# 3. Generate the client route map + run migrations
pnpm codegen
pnpm spfn db migrate

# 4. Run these in separate terminals. This example uses 3890 because 3790-3799
#    may be reserved by other SPFN workspaces on a development machine.
pnpm spfn:server
pnpm spfn:next
```

Open `http://localhost:3890`: the examples list (public) renders immediately and the session
banner shows which social providers are configured. Then walk the auth loop:

1. `/dashboard` signed out → `RequireAuth` redirects to `/login`.
2. Sign in with the seeded admin (`SPFN_AUTH_ADMIN_EMAIL` / `_PASSWORD` from `.env.server`)
   → `/dashboard` shows your email and role via the protected `getMe` call.
3. `/admin` → `RequireRole` lets `admin`/`superadmin` through; a social-login `user` is
   sent back to `/dashboard`.
4. Sign out → `/dashboard` bounces to `/login` again.

Programmatic login is one call — the interceptor generates keys and saves the session cookie:

```typescript
import { authApi } from '@spfn/auth';

await authApi.login.call({ body: { email: 'admin@example.com', password: '…' } });
// now api.getMe.call({}) and POST /examples succeed
```

(Email/password *registration* additionally requires the `/_auth/verify-code` flow — a
verification token from a mail/SMS provider — which this example skips; normal users
register via OAuth.)

See [`packages/auth/README.md`](../../packages/auth/README.md) for the full register/login
key-exchange flow, OAuth, and RBAC.

### Environment variables

Auth secrets are split by audience (see `packages/auth/README.md`):

- `.env.local` — `SPFN_AUTH_SESSION_SECRET` (≥32 chars, validated), `DATABASE_URL`,
  `SPFN_API_URL`, `NEXT_PUBLIC_SPFN_APP_URL`, `CACHE_URL`, `NODE_ENV`, `SPFN_LOG_LEVEL`
- `.env.server` — verification/token-encryption secrets, `DATABASE_URL`, admin seed
  account, provider credentials (Google, Kakao, Naver, GitHub)

## End-to-end social login (Google · Kakao · Naver)

The example calls `authApi.oauthProviders` to enable only configured buttons, then starts login
through `authApi.getProviderOAuthUrl`. The Next.js interceptor generates the client key pair and
OAuth state. Provider callbacks return to the web origin and are forwarded to SPFN by the rewrite
in `next.config.ts`; `/auth/callback` then finalizes the encrypted session cookie.

### Google Cloud console

1. Create an OAuth client (type: Web application) under APIs & Services → Credentials.
2. Register `http://localhost:3890/_auth/oauth/google/callback` as an authorized redirect URI
   (this is the default callback — `{app origin}/_auth/oauth/google/callback`).
3. Set `SPFN_AUTH_GOOGLE_CLIENT_ID` and `SPFN_AUTH_GOOGLE_CLIENT_SECRET`.

### Kakao developer console

1. Enable Kakao Login and register the web platform for `http://localhost:3890`.
2. Register `http://localhost:3890/_auth/oauth/kakao/callback` as a redirect URI.
3. Enable the email consent item (`account_email`) used by the example.
4. Put the REST API key in `SPFN_AUTH_KAKAO_CLIENT_ID`. If the client-secret feature is enabled,
   also set `SPFN_AUTH_KAKAO_CLIENT_SECRET`.

### Naver developer console

1. Create a Naver Login application and select the profile fields you want to test.
2. Register `http://localhost:3890/_auth/oauth/naver/callback` as the callback URL.
3. Set `SPFN_AUTH_NAVER_CLIENT_ID` and `SPFN_AUTH_NAVER_CLIENT_SECRET`.

Restart `pnpm spfn:server` after changing `.env.server`; keep `pnpm spfn:next` running in the
other terminal. A configured button becomes enabled on the home page. After provider consent, a
successful test returns to `/auth/callback`, stores the SPFN session, redirects to `/`, and
displays the internal user ID with a sign-out button.

Naver does not provide a verified-email claim. The example therefore creates/links the account by
Naver's provider user ID and does not automatically attach its email to an existing SPFN account.

## Public vs protected

```typescript
// Public read — opt out of the global authenticate middleware
route.get('/examples').input({ ... }).skip(['auth']).handler(...)

// Protected — global authenticate gates it; read the user from context
route.get('/me').handler(async (c) => { const { user } = getAuth(c); /* ... */ });
```

## Next step

This is the top of the current ladder. For OAuth, RBAC roles/permissions, invitations, and
events, read [`packages/auth/README.md`](../../packages/auth/README.md).
