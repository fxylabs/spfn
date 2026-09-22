---
title: "Tutorial: Full-Stack Auth"
navTitle: Tutorial
order: 2
description: Clear the first gate between a prototype and a product — build sign-in with @spfn/core and @spfn/auth, from seeded admin to social login and layout guards.
---

## Why start with auth

Nothing ships until people can sign in, and sign-in is the first gate every AI-built
prototype hits. Sessions and their expiry, a callback flow per social provider, roles on
every route — none of it is your product, all of it has a known correct shape, and getting
it subtly wrong is a security incident rather than a bug.

`spfn create --mode full` hands you all of it already wired. This tutorial deliberately
takes the long way instead: it starts in `bare` mode so you see each wiring point once, and
recognize what full mode did for you.

## What you'll build

A Next.js app with a real SPFN backend and working authentication:

- an **admin account seeded from env** at boot,
- a **login page** — email/password for the admin, **Google social login** for everyone else,
- a **signed-in dashboard** guarded by `RequireAuth`,
- an **admin-only area** guarded by `RequireRole`,

with every screen guard living in a Next.js **layout file**, so nested pages inherit
protection automatically. The finished code is
[`examples/03-auth`](https://github.com/fxylabs/spfn/tree/main/examples/03-auth) — every
snippet below is taken from it.

## 1. Create the project

```bash
npx spfn@beta create my-app --mode bare
cd my-app
docker compose up -d       # Postgres + Redis
```

For a product baseline with core, auth, i18n, and MCP already connected, use
`npx spfn@beta create my-app --mode full` instead — everything in sections 2 and 3 below
arrives done.

Bare mode scaffolds a Next.js app with the SPFN backend beside it (`src/server/`),
env files included. Check the app runs before adding auth:

```bash
pnpm spfn:dev              # Next.js + SPFN API
```

## 2. Add @spfn/auth — the four wiring points

```bash
pnpm add @spfn/auth@beta
```

Auth wires into an SPFN app at exactly four places. Miss one and you get 401s or
missing tables — check all four.

**① Server lifecycle** — validates auth env before the DB connects, then seeds
admin accounts and initializes RBAC once it's ready (`src/server/server.config.ts`):

```ts
import { defineServerConfig } from '@spfn/core/server';
import { createAuthLifecycle } from '@spfn/auth/server';
import { appRouter } from '@/server/router';

export default defineServerConfig()
    .port(8890)
    .routes(appRouter)
    .lifecycle(createAuthLifecycle())
    .build();
```

**② Router** — mount the auth routes as a *package* and apply authentication
*globally* (`src/server/router.ts`):

```ts
import { defineRouter } from '@spfn/core/route';
import { authRouter, authenticate } from '@spfn/auth/server';
import { getMe } from './routes/me';
import { listExamples, createExample } from './routes/examples';

export const appRouter = defineRouter({ getMe, listExamples, createExample })
    .packages([authRouter])   // mounts /_auth/* and exposes routes on authApi
    .use([authenticate]);     // global auth; public routes opt out per-route

export type AppRouter = typeof appRouter;
```

Two things people miss here: auth routers register through `.packages([authRouter])`
— not as a plain route entry — and `.use([authenticate])` protects **everything**,
so public routes must opt out explicitly:

```ts
export const listExamples = route.get('/examples')
    .skip(['auth'])           // public read — no session required
    .handler(async (c) => { /* … */ });
```

**③ RPC proxy interceptor** — one side-effect import in the proxy route
(`src/app/api/rpc/[routeName]/route.ts`). Without it every protected call 401s,
because nothing signs the outbound requests:

```ts
import '@spfn/auth/nextjs/api';   // self-registers the auth interceptor — MUST come first
import { createRpcProxy } from '@spfn/core/nextjs/server';
import { routeMap } from '@/generated/route-map';

export const { GET, POST } = createRpcProxy({ routeMap });
```

No auth route map is merged: the generated `routeMap` carries the routes of every package
router the app router mounts with `.packages()`, `authRouter`'s included.

**④ Migrations** — auth ships its tables (users, keys, roles, …) as package
migrations:

```bash
pnpm spfn db migrate
```

## 3. Environment variables — which file gets what

SPFN splits env by *who* may read it. This is the most common setup stumble:

| File | Read by | Holds |
| --- | --- | --- |
| `.env.local` | Next.js **and** SPFN | `DATABASE_URL`, `SPFN_API_URL`, `SPFN_AUTH_SESSION_SECRET` (encrypts the session cookie) |
| `.env.server` | SPFN server **only** | backend secrets: token/encryption keys, **admin seeding**, OAuth credentials |

Minimum for this tutorial (generate real secrets with `openssl rand -base64 32`):

```bash
# .env.local
DATABASE_URL=postgresql://spfn:spfn@localhost:55432/spfn_dev
SPFN_API_URL=http://localhost:8890
SPFN_AUTH_SESSION_SECRET=<32+ char random secret>

# .env.server
DATABASE_URL=postgresql://spfn:spfn@localhost:55432/spfn_dev
SPFN_AUTH_VERIFICATION_TOKEN_SECRET=<32+ char random secret>
SPFN_AUTH_TOKEN_ENCRYPTION_KEYS=v1:<openssl rand -base64 32>
```

### Seed the admin account

Add two more lines to `.env.server`:

```bash
SPFN_AUTH_ADMIN_EMAIL=admin@example.com
SPFN_AUTH_ADMIN_PASSWORD=SecureAdmin123!
```

On boot, `createAuthLifecycle()` creates this account if it doesn't exist — you'll
see `✅ Admin account created: admin@example.com (superadmin)` in the server log.
Rules worth knowing:

- The password must have 8+ chars with upper, lower, number, and special character.
- This simple two-var format seeds the **`superadmin`** role and sets
  `passwordChangeRequired: true`.
- For multiple accounts, explicit roles, or `passwordChangeRequired: false`, use the
  JSON form instead:
  `SPFN_AUTH_ADMIN_ACCOUNTS=[{"email":"…","password":"…","role":"admin","passwordChangeRequired":false}]`

## 4. The login page

Email/password sign-in is one `authApi` call. The RPC interceptor from step ②
does the heavy lifting on success — generates the signing key pair and saves the
encrypted session cookie. Navigate with a full page load (not `router.push`) so
Server Components re-read the fresh session (`src/app/components/login-form.tsx`):

```tsx
'use client';

import { authApi } from '@spfn/auth';
import { useState } from 'react';

export function LoginForm({ redirectTo = '/dashboard' }: { redirectTo?: string })
{
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);

    async function submit(event: React.FormEvent)
    {
        event.preventDefault();
        try
        {
            await authApi.login.call({ body: { email, password } });
            window.location.assign(redirectTo);
        }
        catch
        {
            setError('Sign-in failed. Check the email and password.');
        }
    }

    return (
        <form onSubmit={submit}>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {error && <p>{error}</p>}
            <button type="submit">Sign in</button>
        </form>
    );
}
```

The page itself is a Server Component that bounces already-signed-in users
(`src/app/login/page.tsx`):

```tsx
import { redirect } from 'next/navigation';
import { getSession } from '@spfn/auth/nextjs/server';
import { LoginForm } from '@/app/components/login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage()
{
    if (await getSession())
    {
        redirect('/dashboard');
    }

    return <LoginForm />;
}
```

> Email/password **registration** needs the verification-code flow
> (`/_auth/verify-code`) and a mail/SMS provider, so this tutorial registers normal
> users through social login instead.

## 5. The signed-in screen — RequireAuth in a layout

Guard the *layout*, not each page — everything under `/dashboard` inherits it
(`src/app/dashboard/layout.tsx`):

```tsx
import { RequireAuth } from '@spfn/auth/nextjs/server';
import type { ReactNode } from 'react';

export default function DashboardLayout({ children }: { children: ReactNode })
{
    return <RequireAuth redirectTo="/login">{children}</RequireAuth>;
}
```

Inside, protected API calls are safe without any per-page checks
(`src/app/dashboard/page.tsx`):

```tsx
import { api } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

export default async function DashboardPage()
{
    const me = await api.getMe.call({});   // protected route — session guaranteed by the layout

    return <p>Signed in as {me.email} (role: {me.role})</p>;
}
```

`getMe` on the server side reads the authenticated user with `getAuth(c)`:

```ts
import { route } from '@spfn/core/route';
import { getAuth } from '@spfn/auth/server';

export const getMe = route.get('/me')
    .handler(async (c) =>
    {
        const { user, userId, role } = getAuth(c);

        return { id: userId, email: user.email, role };
    });
```

## 6. The admin area — RequireRole in a layout

Same pattern, role-gated (`src/app/admin/layout.tsx`):

```tsx
import { RequireRole } from '@spfn/auth/nextjs/server';
import type { ReactNode } from 'react';

export default function AdminLayout({ children }: { children: ReactNode })
{
    return <RequireRole roles={['admin', 'superadmin']} redirectTo="/dashboard">{children}</RequireRole>;
}
```

`roles` is an OR match on **exact role names** — `superadmin` does *not* imply
`admin`, so list both when either should pass (the env-seeded admin is
`superadmin`). Signed-out visitors go to `/login`; signed-in users without a
matching role go to `redirectTo`. A `fallback` prop renders in place instead of
redirecting, and `RequirePermission` does the same for fine-grained permissions.

## 7. Social login — Google

Create an OAuth client in the [Google Cloud console](https://console.cloud.google.com/apis/credentials)
(type: *Web application*) and register the redirect URI:

```text
http://localhost:3890/_auth/oauth/google/callback
```

That URI is the default — `{app origin}/_auth/oauth/google/callback` — and it hits
your **Next.js origin**, not the API server: the scaffolded `next.config.ts`
rewrites `/_auth/:path*` to the SPFN API. Then two lines in `.env.server`:

```bash
SPFN_AUTH_GOOGLE_CLIENT_ID=<client id>.apps.googleusercontent.com
SPFN_AUTH_GOOGLE_CLIENT_SECRET=<client secret>
```

(GitHub, Kakao, Naver, and Apple are built in the same way — `SPFN_AUTH_GITHUB_*`,
`SPFN_AUTH_KAKAO_*` etc.; more providers plug in via the OAuth provider registry.)

The login button asks the backend for Google's auth URL and follows it:

```tsx
'use client';

import { authApi } from '@spfn/auth';

async function startLogin()
{
    const { authUrl } = await authApi.getProviderOAuthUrl.call({
        params: { provider: 'google' },
        body: { returnUrl: '/' },
    });
    window.location.assign(authUrl);
}
```

After the provider round-trip, the callback page finalizes the encrypted session
cookie — `@spfn/auth/nextjs/client` ships it ready-made
(`src/app/auth/callback/page.tsx`):

```tsx
export { OAuthCallback as default } from '@spfn/auth/nextjs/client';
```

Social users are registered automatically on first login with the `user` role — so
they reach `/dashboard` but bounce off `/admin`, which is exactly the RBAC split
this tutorial is after. `authApi.oauthProviders.call({})` reports which providers
are configured, letting the UI disable unconfigured buttons (the example's
`OAuthLoginButtons` does exactly this).

## 8. Run the loop

```bash
pnpm spfn:dev        # or spfn:server / spfn:next in two terminals
```

Then walk the same loop this example was verified with:

1. Open `/dashboard` signed out → `RequireAuth` redirects to `/login`.
2. Sign in with `admin@example.com` / the seeded password → back on `/dashboard`,
   showing your email and `superadmin` role via the protected `getMe` call.
3. Open `/admin` → `RequireRole` lets the seeded admin through.
4. Sign out (`authApi.logout`) → `/dashboard` bounces to `/login` again.
5. Sign in with Google → `/dashboard` works, `/admin` redirects back — a
   `user`-role account in an admin-only area.

## Where next

The first gate is cleared. The second one — operating the thing after it ships — is what
[Prototype to Production](./prototype-to-production.md) covers, with MCP tools in place of
an admin dashboard.

- [The SPFN pattern](./pattern.md) — the entity → route → typed client loop this
  app is built on.
- [`@spfn/auth` reference](./packages/auth.md) — sessions, RBAC, invitations,
  OAuth providers, deletion lifecycle.
- [`examples/03-auth`](https://github.com/fxylabs/spfn/tree/main/examples/03-auth) —
  the finished code, runnable as-is.
