---
title: "Authentication"
description: "Complete guide for setting up and using @spfn/auth - environment variables, middleware, RBAC, OAuth, and session management"
order: 9
available: true
---

# Authentication

`@spfn/auth` provides authentication, authorization, and RBAC for SPFN applications. This guide covers the complete setup process and usage patterns.

## Features

- **Asymmetric JWT** - Client-signed tokens using ES256/RS256
- **Session Management** - HttpOnly cookie sessions with configurable TTL
- **Role-Based Access Control** - Roles, permissions, and middleware guards
- **One-Time Tokens** - Direct API access for file uploads, SSE, streaming
- **OAuth** - Google, Kakao, Naver, GitHub built in; extensible via a provider registry
- **Second factor** - Optional TOTP or passkey, with a step-up when a new device signs in
- **Registered devices** - A per-device key list, an event when one is added, and a mailed sign-out-everywhere link
- **Session binding** - Opt-in: a web session runs on a short-lived key only a passkey can renew
- **User Management** - Email/phone identity, profiles, invitations
- **Next.js Integration** - Server components, session guards, OAuth callbacks

---

## Setup

Auth setup consists of 6 steps. Follow them in order.

### 1. Install Package

```bash
pnpm add @spfn/auth
```

### 2. Environment Variables

Auth requires environment variables in **two separate files**. This is the most common source of setup issues.

#### `.env.server` (SPFN Backend)

The SPFN server reads these variables. They are **never exposed to the browser**.

```bash
# ── Required ─────────────────────────────────────────────────────────
DATABASE_URL=postgresql://user:pass@localhost:5432/myapp_dev

# Verification token secret (email verification, password reset)
SPFN_AUTH_VERIFICATION_TOKEN_SECRET="generate-a-random-32-char-string"

# Same value as .env.local — the API server unseals the OAuth state the Next.js
# side sealed with it, and encrypts stored provider tokens with it
SPFN_AUTH_SESSION_SECRET="my-super-secret-session-key-at-least-32-chars-long"

# ── Admin Account (at least one method required) ─────────────────────
# JSON format (recommended for multiple accounts)
SPFN_AUTH_ADMIN_ACCOUNTS='[{"email":"admin@example.com","password":"Admin!@34","role":"superadmin"}]'

# ── Optional ─────────────────────────────────────────────────────────
# JWT_SECRET/JWT_EXPIRES_IN apply to the legacy server-signed JWT mode only
SPFN_AUTH_JWT_SECRET=your-jwt-secret        # Default: dev-secret-key-change-in-production
SPFN_AUTH_JWT_EXPIRES_IN=7d                 # Default: 7d
SPFN_AUTH_BCRYPT_SALT_ROUNDS=12             # Default: 12 (native bcrypt, off the event loop)
SPFN_AUTH_SESSION_TTL=7d                    # Default: 7d

# ── Email Delivery (via @spfn/notification) ──────────────────────────
# @spfn/auth has no mail settings of its own — verification codes and
# invitations go out through @spfn/notification, which owns these names
SPFN_NOTIFICATION_EMAIL_PROVIDER=aws-ses    # Default: aws-ses (also sendgrid, smtp)
SPFN_NOTIFICATION_EMAIL_FROM="noreply@example.com"
AWS_REGION="us-east-1"                      # Default: ap-northeast-2
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...

# ── Google OAuth (optional) ──────────────────────────────────────────
SPFN_AUTH_GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com
SPFN_AUTH_GOOGLE_CLIENT_SECRET=GOCSPX-...

# OAuth token keyring — required once web OAuth is enabled.
# Comma-separated <keyId>:<base64 32-byte key>; the first key encrypts, the rest decrypt.
SPFN_AUTH_TOKEN_ENCRYPTION_KEYS=v1:<base64-encoded-32-byte-key>
```

Kakao, Naver and GitHub follow the same `SPFN_AUTH_<PROVIDER>_CLIENT_ID` /
`_CLIENT_SECRET` shape; see the [`@spfn/auth` README env table](../../packages/auth/README.md#which-environment-variables-do-i-need)
for the full list including native (mobile `id_token`) sign-in.

#### `.env.local` (Next.js Frontend)

Next.js reads these variables. `SPFN_AUTH_SESSION_SECRET` is **required** for cookie-based session management in Server Components.

```bash
# ── Required ─────────────────────────────────────────────────────────
DATABASE_URL=postgresql://user:pass@localhost:5432/myapp_dev
SPFN_API_URL=http://localhost:8790

# Session secret (minimum 32 characters, AES-256 encryption)
# This MUST be set for Next.js session cookies to work
SPFN_AUTH_SESSION_SECRET="my-super-secret-session-key-at-least-32-chars-long"

# ── Optional ─────────────────────────────────────────────────────────
SPFN_AUTH_SESSION_TTL=7d
SPFN_AUTH_COOKIE_SECURE=false   # Override cookie Secure flag (default: true in production)
SPFN_AUTH_CSRF=enforce          # off | warn | enforce (unset = warn); see CSRF Protection
```

> **Why two files?**
>
> SPFN runs as a separate backend process (`.env.server`), while Next.js is the frontend (`.env.local`). `SPFN_AUTH_SESSION_SECRET` must hold **the same value in both** — Next.js seals and reads the encrypted session cookie with it, and the API server unseals the OAuth `state` that Next.js sealed (and encrypts stored provider tokens) with it. Different values on the two sides break the OAuth callback.

### 3. Run Migrations

```bash
# Generate migration files (if schema changed)
pnpm spfn db generate

# Apply migrations to database
pnpm spfn db migrate
```

This creates the `spfn_auth` schema with tables: `users`, `user_profiles`, `user_public_keys`, `user_social_accounts`, `verification_codes`, `user_invitations`, `roles`, `permissions`, `role_permissions`, `user_permissions`, `account_deletion_requests`, `auth_metadata`.

### 4. Register Lifecycle in `server.config.ts`

```typescript
// src/server/server.config.ts
import { defineServerConfig } from '@spfn/core/server';
import { createAuthLifecycle } from '@spfn/auth/server';
import { appRouter } from './router';

export default defineServerConfig()
    .port(8790)
    .routes(appRouter)
    .lifecycle(createAuthLifecycle())  // Creates admin accounts, initializes RBAC + one-time tokens
    .build();
```

`createAuthLifecycle()` resolves the account-deletion config immediately, then on the
server's `afterInfrastructure` step (once the database is ready):
- Initializes built-in roles and permissions, plus any you passed in
- Creates admin accounts from `SPFN_AUTH_ADMIN_ACCOUNTS` (or the CSV/single-account variants)
- Initializes the one-time token manager

Environment variables are not checked here. Each `SPFN_AUTH_*` value is validated the
first time it is read, against the schema in `@spfn/auth/config`.

### 5. Register Router and Middleware in `router.ts`

This is the **critical step** that most setups miss. You need three things:

1. Register `authRouter` via `.packages()` — exposes auth endpoints (`/_auth/*`)
2. Apply `authenticate` middleware via `.use()` — protects all routes globally
3. Use `.skip(['auth'])` on public routes — exempts specific routes from auth

```typescript
// src/server/router.ts
import { defineRouter } from '@spfn/core/route';
import { authRouter, authenticate } from '@spfn/auth/server';
import { getStatus } from './routes/status';
import { listProducts, getProduct } from './routes/products';
import { createOrder } from './routes/orders';

export const appRouter = defineRouter({
    getStatus,
    listProducts,
    getProduct,
    createOrder,
})
.packages([authRouter])    // ← Auth routes: /_auth/login, /_auth/session, etc.
.use([authenticate]);      // ← Global auth middleware on ALL routes

export type AppRouter = typeof appRouter;
```

> **Common mistake:** Using `auth: authRouter` in defineRouter. Auth routes use a fixed `/_auth` namespace and must be registered via `.packages()`.

#### Skipping Auth for Public Routes

Routes that don't require authentication must explicitly skip the global `authenticate` middleware:

```typescript
// src/server/routes/status.ts
import { route } from '@spfn/core/route';

export const getStatus = route.get('/status')
    .skip(['auth'])  // ← Public route, no auth required
    .handler(async (c) =>
    {
        return { status: 'ok' };
    });
```

```typescript
// src/server/routes/products.ts
import { route } from '@spfn/core/route';

// Public: anyone can browse products
export const listProducts = route.get('/products')
    .skip(['auth'])
    .handler(async (c) =>
    {
        // ...
    });

// Protected: only authenticated users can create orders (no .skip needed)
export const createOrder = route.post('/orders')
    .handler(async (c) =>
    {
        const auth = c.raw.get('auth');  // AuthContext is available
        // ...
    });
```

### 6. Configure Next.js Interceptor

The Next.js interceptor handles session cookies, JWT signing, and public key encryption automatically. Without it, login/register/key-rotation will not work.

```typescript
// app/api/rpc/[routeName]/route.ts
import '@spfn/auth/nextjs/api';  // ← Register auth interceptor (side-effect import)
import { appRouter } from '@/server/router';
import { createRpcProxy } from '@spfn/core/nextjs/server';

export const { GET, POST } = createRpcProxy({ router: appRouter });
```

The `import '@spfn/auth/nextjs/api'` line must come **before** `createRpcProxy`. It automatically:
- Injects `publicKey`, `keyId`, `fingerprint`, `algorithm` on `register`, `login`, `rotateKey` calls
- Manages session cookies (HttpOnly, encrypted)
- Handles key generation and storage

#### API Client

Your API client works as-is — no auth-specific registration needed:

```typescript
// src/lib/api-client.ts
import { createApi } from '@spfn/core/nextjs';
import type { AppRouter } from '@/server/router';

export const api = createApi<AppRouter>();
```

Auth routes (`/_auth/*`) are included in `AppRouter` because `authRouter` is registered via `.packages()`. The built-in `authApi` from `@spfn/auth` is also available if you prefer a dedicated client:

```typescript
import { authApi } from '@spfn/auth';

const session = await authApi.getAuthSession.call({});
```

---

## Middleware

`@spfn/auth` provides middleware for authentication and access control.

### authenticate

Global JWT verification middleware. Extracts the token from the `Authorization` header, verifies the signature against stored public keys, and attaches `AuthContext` to the request context.

Already configured in [Step 5](#5-register-router-and-middleware-in-routerts). Available on all routes that don't `.skip(['auth'])`.

### optionalAuth

For routes that work for both authenticated and unauthenticated users. Automatically skips the global `authenticate` middleware — no `.skip(['auth'])` needed.

```typescript
import { route } from '@spfn/core/route';
import { optionalAuth, getOptionalAuth } from '@spfn/auth/server';

export const getProducts = route.get('/products')
    .use([optionalAuth])  // ← No .skip(['auth']) needed, auto-skips
    .handler(async (c) =>
    {
        const auth = getOptionalAuth(c);  // AuthContext | undefined

        if (auth)
        {
            return getPersonalizedProducts(auth.userId);
        }

        return getPublicProducts();
    });
```

### requireRole

Restrict a route to users with specific roles. OR condition — user must have at least one of the specified roles.

```typescript
import { route } from '@spfn/core/route';
import { authenticate, requireRole } from '@spfn/auth/server';

export const deleteUser = route.delete('/admin/users/:id')
    .use([authenticate, requireRole('admin', 'superadmin')])
    .handler(async (c) =>
    {
        // Only admin or superadmin can reach here
    });
```

### requirePermissions

Restrict a route to users with specific permissions. AND condition — user must have **all** specified permissions.

```typescript
import { route } from '@spfn/core/route';
import { authenticate, requirePermissions } from '@spfn/auth/server';

export const publishPost = route.post('/posts/:id/publish')
    .use([authenticate, requirePermissions('post:publish', 'post:edit')])
    .handler(async (c) =>
    {
        // User must have BOTH post:publish AND post:edit
    });
```

### requireAnyPermission

OR condition — user must have **at least one** of the specified permissions.

```typescript
import { route } from '@spfn/core/route';
import { authenticate, requireAnyPermission } from '@spfn/auth/server';

export const viewContent = route.get('/content/:id')
    .use([authenticate, requireAnyPermission('content:read', 'admin:access')])
    .handler(async (c) =>
    {
        // User needs content:read OR admin:access
    });
```

### roleGuard

Combined allow/deny logic. Deny is evaluated first.

```typescript
import { route } from '@spfn/core/route';
import { authenticate, roleGuard } from '@spfn/auth/server';

export const moderateContent = route.post('/content/:id/moderate')
    .use([authenticate, roleGuard({ allow: ['admin', 'moderator'], deny: ['banned'] })])
    .handler(async (c) =>
    {
        // Allowed for admin/moderator, but never for banned users
    });
```

---

## One-Time Token

For operations that bypass the RPC proxy — streaming, large file uploads, SSE, or any direct backend API call — SPFN provides a one-time token system. Authenticated users request a short-lived token via RPC, then use it to call the backend directly.

### Flow

```
1. Client → RPC → POST /_auth/tokens (authenticated) → { token, expiresAt }
2. Client → Direct → POST /files/upload?token=xxx    (file upload)
   Client → Direct → GET /events/stream?token=xxx     (SSE streaming)
3. Backend → oneTimeTokenAuth middleware → verify & consume → AuthContext
```

### Server Setup

One-time tokens are initialized automatically by `createAuthLifecycle()`. Optionally configure TTL:

```typescript
// server.config.ts
.lifecycle(createAuthLifecycle({
    oneTimeToken: { ttl: 60000 },  // 60 seconds (default: 30s)
}))
```

### oneTimeTokenAuth Middleware

Use `oneTimeTokenAuth` on routes that accept one-time tokens instead of JWT. It automatically skips the global `authenticate` middleware and injects the same `AuthContext`.

Token is extracted from `?token=xxx` query parameter or `Authorization: OTT xxx` header.

```typescript
import { route } from '@spfn/core/route';
import { oneTimeTokenAuth, getAuth } from '@spfn/auth/server';

export const uploadFile = route.post('/files/upload')
    .use([oneTimeTokenAuth])  // Auto-skips 'auth', injects AuthContext
    .handler(async (c) =>
    {
        const { userId } = getAuth(c);
        // handle upload...
    });
```

### Client Usage

```typescript
import { authApi } from '@spfn/auth';

// 1. Issue token (via RPC, requires authentication)
const { token } = await authApi.issueOneTimeToken.call({});

// 2. Direct API call with token
await fetch(`${SPFN_API_URL}/files/upload?token=${token}`, {
    method: 'POST',
    body: formData,
});
```

### SSE Integration

Share the auth package's token manager with the SSE system to use a single token pool:

```typescript
// server.config.ts
import { getOneTimeTokenManager } from '@spfn/auth/server';

export default defineServerConfig()
    .lifecycle(createAuthLifecycle())
    .events(eventRouter, {
        auth: {
            enabled: true,
            tokenManager: () => getOneTimeTokenManager(),  // Lazy — resolved at server start
        },
    })
    .build();
```

> **Why a function?** `getOneTimeTokenManager()` requires `createAuthLifecycle()` to run first (during `afterInfrastructure`). At module load time the manager doesn't exist yet. A lazy resolver `() => getOneTimeTokenManager()` defers the call to server startup, when the manager is ready.

### API Endpoint

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/_auth/tokens` | POST | Required | Issue a one-time token |

Response:
```json
{ "token": "a1b2c3...", "expiresAt": "2026-03-12T12:00:30.000Z" }
```

---

## Auth Context

When a request passes through `authenticate` middleware (or `oneTimeTokenAuth`), an `AuthContext` object is attached to the request context.

### getAuth

Returns the `AuthContext` that `authenticate` (or `oneTimeTokenAuth`) put on the request.
It does not authenticate anything itself — on a route that skipped auth it returns
`undefined`, so only call it where an auth middleware ran.

```typescript
import { getAuth } from '@spfn/auth/server';

export const getProfile = route.get('/me')
    .handler(async (c) =>
    {
        const auth = getAuth(c);

        // auth.userId   - User ID (string)
        // auth.user     - Full User entity
        // auth.keyId    - Current public key ID
        // auth.role     - User's role name (string | null)
        // auth.locale   - User's locale

        return { userId: auth.userId, role: auth.role };
    });
```

### getOptionalAuth

Returns `AuthContext | undefined`. Use with `optionalAuth` middleware.

```typescript
import { getOptionalAuth } from '@spfn/auth/server';

export const getProducts = route.get('/products')
    .use([optionalAuth])
    .handler(async (c) =>
    {
        const auth = getOptionalAuth(c);
        const userId = auth?.userId;
        // ...
    });
```

### getUser

Shortcut for `getAuth(c).user` — the full User entity. Same rule as `getAuth`: only use it
on a route an auth middleware guards.

```typescript
import { getUser } from '@spfn/auth/server';

export const getMyEmail = route.get('/me/email')
    .handler(async (c) =>
    {
        const user = getUser(c);
        return { email: user.email };
    });
```

---

## RBAC

### Built-in Roles

Auth creates three built-in roles on startup:

| Role | Priority | Description |
|------|----------|-------------|
| `superadmin` | 100 | Full system access and RBAC management |
| `admin` | 80 | User management and organization administration |
| `user` | 10 | Default role with basic permissions |

### Custom Roles and Permissions

Pass custom roles and permissions to `createAuthLifecycle()`:

```typescript
// src/server/server.config.ts
import { defineServerConfig } from '@spfn/core/server';
import { createAuthLifecycle } from '@spfn/auth/server';

export default defineServerConfig()
    .port(8790)
    .routes(appRouter)
    .lifecycle(createAuthLifecycle({
        roles: [
            { name: 'moderator', displayName: 'Moderator', priority: 30 },
            { name: 'editor', displayName: 'Editor', priority: 20 },
        ],
        permissions: [
            { name: 'post:publish', displayName: 'Publish Posts', category: 'content' },
            { name: 'post:edit', displayName: 'Edit Posts', category: 'content' },
            { name: 'user:invite', displayName: 'Invite Users', category: 'admin' },
            { name: 'user:delete', displayName: 'Delete Users', category: 'admin' },
        ],
        rolePermissions: {
            moderator: ['post:publish', 'post:edit'],
            editor: ['post:edit'],
            admin: ['post:publish', 'post:edit', 'user:invite', 'user:delete'],
        },
    }))
    .build();
```

### Checking Roles/Permissions in Handlers

For middleware-based checks, use `requireRole` or `requirePermissions` (see [Middleware](#middleware)). For inline checks within handlers:

```typescript
import { getAuth, hasPermission, hasRole } from '@spfn/auth/server';

export const updatePost = route.put('/posts/:id')
    .handler(async (c) =>
    {
        const auth = getAuth(c);

        if (await hasRole(auth.userId, 'superadmin'))
        {
            // Superadmin can edit any post
        }

        if (await hasPermission(auth.userId, 'post:edit'))
        {
            // User has post:edit permission
        }
    });
```

### Admin Routes

Admin endpoints for managing roles are available at `/_auth/admin/*`. Writes to the role
catalogue are `superadmin`-only; reading roles and reassigning a user's role also accept `admin`:

| Route | Method | Role | Purpose |
|-------|--------|------|---------|
| `/_auth/admin/roles` | GET | `admin` or `superadmin` | List all roles |
| `/_auth/admin/roles` | POST | `superadmin` | Create role |
| `/_auth/admin/roles/:id` | PATCH | `superadmin` | Update role |
| `/_auth/admin/roles/:id` | DELETE | `superadmin` | Delete role |
| `/_auth/admin/users/:userId/role` | PATCH | `admin` or `superadmin` | Change user role |

---

## Account Deletion & Recovery

Grace-period deletion with in-window recovery: `active → pending_deletion → deleted` (anonymize)
or row removal (hard-delete), with a `cancel` step back to `active` at any point before the purge
runs. Full config (`gracePeriodDays`, `purgeStrategy`, `allowSelfImmediate`, `onBeforePurge`,
notifications) and the purge job registration caveat live in the package README — see
[`packages/auth/README.md#account-deletion--recovery`](../../packages/auth/README.md#account-deletion--recovery).

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/_auth/deletion/request` | POST | Required | Request deletion (password or verification-code re-auth) |
| `/_auth/deletion/cancel` | POST | Public | Cancel a pending deletion (credential-based — sessions were revoked at request time) |

```typescript
// Request (client already holds a valid session)
await authApi.requestAccountDeletion.call({ body: { password } });
// -> { purgeScheduledAt: '2026-08-08T00:00:00.000Z' }

// A blocked login surfaces the scheduled purge date so you can offer recovery:
try
{
    await authApi.login.call({ body: { email, password, publicKey, keyId, fingerprint, algorithm } });
}
catch (error)
{
    if (error instanceof AuthError.AccountPendingDeletionError)
    {
        // error.details.purgeScheduledAt
    }
}

// Cancel (no Bearer token — the account's sessions were revoked on request)
await authApi.cancelAccountDeletion.call({ body: { email, password } });
```

The purge job (`authJobRouter` from `@spfn/auth/server`) must be registered explicitly with
`.jobs(authJobRouter)` — it is not wired up by `createAuthLifecycle()` automatically.

---

## OAuth

### Configuration

Set Google OAuth environment variables in `.env.server`:

```bash
SPFN_AUTH_GOOGLE_CLIENT_ID=123456789-abc.apps.googleusercontent.com
SPFN_AUTH_GOOGLE_CLIENT_SECRET=GOCSPX-...

# Optional
SPFN_AUTH_GOOGLE_SCOPES=email,profile               # Default: email,profile
SPFN_AUTH_OAUTH_SUCCESS_URL=/auth/callback           # Default: /auth/callback
SPFN_AUTH_OAUTH_ERROR_URL=/auth/error?error={error}  # Default: /auth/error?error={error}
SPFN_AUTH_GOOGLE_REDIRECT_URI=                       # Default: {NEXT_PUBLIC_SPFN_APP_URL||SPFN_APP_URL}/_auth/oauth/google/callback (an override is checked at boot)
```

OAuth routes are **automatically enabled** when `SPFN_AUTH_GOOGLE_CLIENT_ID` is set.

### Callback origin & required rewrite

The OAuth CSRF cookie is set on the **web app host** by the Next.js interceptor, so the
provider callback must return to that same origin — the redirect URI defaults to the app URL,
not the API URL. The app must forward `/_auth/*` to the API with a rewrite (without it the
callback 404s, including in local dev):

```javascript
// next.config.js
const nextConfig = {
    async rewrites()
    {
        return [
            {
                source: '/_auth/:path*',
                destination: `${process.env.SPFN_API_URL}/_auth/:path*`,
            },
        ];
    },
};
```

Register the web app host callback URL in the Google console (e.g.
`https://app.example.com/_auth/oauth/google/callback`). An explicit
`SPFN_AUTH_<PROVIDER>_REDIRECT_URI` is checked when the server boots: a value off the web app
origin, or off `/_auth/oauth/<provider>/callback`, refuses to start rather than failing later
as a CSRF refusal on the callback.

If you use the direct `POST /_auth/oauth/start` flow (no Next.js interceptor), set
`SPFN_AUTH_GOOGLE_REDIRECT_URI` to the API host callback instead — that flow sets its CSRF
cookie on the API host — **and** set `SPFN_AUTH_OAUTH_CALLBACK_ORIGIN_CHECK=off`, which is the
only value that disables the boot check.

### OAuth Flow

```
1. Browser → /_auth/oauth/google?state=…  → Redirect to Google consent screen
2. Google  → /_auth/oauth/google/callback → Server validates, creates/links account
3. Server  → /auth/callback?userId=…&keyId=…&returnUrl=…&isNewUser=…
4. Next.js → OAuthCallback component      → Finalizes session, redirects to returnUrl
```

If the account has a [second factor](#second-factor-mfa) and this browser is a device it has
never seen, step 3 carries `?mfaChallenge=…` instead of `userId` and `keyId`, and no session
exists until that challenge is spent. `OAuthCallback` posts it to `/_auth/oauth/finalize`,
which answers 202 and hands it back for your confirm screen.

The `state` in step 1 is produced by the Next.js interceptor (it generates the key pair and
seals it into the state), so start the flow through `authApi.getGoogleOAuthUrl` rather than
linking to `/_auth/oauth/google` directly.

### Callback Page

Create a callback page using the `OAuthCallback` component. It reads `userId`, `keyId` and
`returnUrl` from the query string the server redirected with — there is no `provider` or
`redirectTo` prop:

```typescript
// app/auth/callback/page.tsx
'use client';

import { OAuthCallback } from '@spfn/auth/nextjs/client';

export default function OAuthCallbackPage()
{
    return <OAuthCallback />;
}
```

`OAuthCallback` accepts `apiBasePath` (default `/api/rpc`), `loadingComponent`,
`errorComponent`, `onSuccess` and `onError`.

### Available Endpoints

| Route | Method | Purpose |
|-------|--------|---------|
| `/_auth/oauth/google` | GET | Start Google OAuth flow |
| `/_auth/oauth/google/callback` | GET | Google OAuth callback |
| `/_auth/oauth/google/url` | POST | Get the Google authorization URL (interceptor path) |
| `/_auth/oauth/:provider` | GET | Start the flow for any registered provider |
| `/_auth/oauth/:provider/callback` | GET | Callback for any registered provider |
| `/_auth/oauth/:provider/url` | POST | Get the authorization URL for any registered provider |
| `/_auth/oauth/:provider/native` | POST | Native sign-in — verify a provider `id_token` from a mobile/web SDK |
| `/_auth/oauth/start` | POST | Get OAuth URL (API mode) |
| `/_auth/oauth/providers` | GET | List enabled providers |
| `/_auth/oauth/finalize` | POST | Finalize OAuth session, or answer 202 with a second-factor challenge |
| `/_auth/oauth/:provider/unlink-notify` | GET/POST | Receives a provider-initiated unlink webhook — register it as Kakao's unlink webhook or Naver's disconnect callback URL. Once the signature verifies, the social link and its stored tokens are deleted |

Hono matches literal segments before `:provider`, so `/google` and `/providers` are taken by
their own routes and every other provider id falls through to the generic handlers.

> These are the routes that sign somebody **in** with a social account. `/_auth/oauth2/*` is a
> different feature — the OAuth 2.1 authorization server that lets an MCP client act as the
> signed-in user — and it is off until you configure it. It has its own guide:
> [MCP Clients](./mcp-clients.md).

### Custom Providers (Pluggable)

Provider dispatch runs off a registry, so a provider outside the built-in set can be plugged in at
runtime. The built-in `google`, `kakao`, `naver`, `github` and `apple` register themselves; an
external package registers with `registerOAuthProvider()`.

```typescript
import { registerOAuthProvider, type OAuthProvider } from '@spfn/auth/server';

const myProvider: OAuthProvider = {
    id: 'superself',
    isEnabled: () => Boolean(process.env.MY_CLIENT_ID),
    getAuthUrl: (state) => `https://issuer.example.com/authorize?state=${state}`,
    exchangeCodeForTokens: async (code) => ({ accessToken, refreshToken, expiresIn }),
    getUserInfo: async (accessToken) => ({ providerUserId, email, emailVerified }),
};

registerOAuthProvider(myProvider);
```

Once it is registered, `POST /_auth/oauth/start`, `GET /_auth/oauth/:provider` and
`GET /_auth/oauth/:provider/callback` handle that provider automatically — you do not write a
callback route of your own. The generic callback is already wrapped in `Transactional()`, so a
failure part-way through leaves no orphan user behind. The provider id has to be a member of the
`SOCIAL_PROVIDERS` enum (`google`, `apple`, `github`, `kakao`, `naver`, `superself`).

> The full interface specification (`OAuthProvider` / `NormalizedIdentity` / `OAuthTokens`) is under
> [Custom providers in the `@spfn/auth` README](../../packages/auth/README.md#custom-providers).

---

## Second factor (MFA)

Optional, and optional in the strong sense: an account that never enrols behaves exactly as it
did before, on every route. You turn it on per account, not per app.

Two forms — a TOTP authenticator app, or a passkey the person already enrolled and has marked
as their second factor — and ten single-use recovery codes come with either. Enrolment is
`POST /_auth/mfa/totp/enroll` then `/_auth/mfa/totp/confirm`, both from a signed-in session,
and `GET /_auth/mfa/status` is what an account screen renders from.

You need `SPFN_AUTH_TOKEN_ENCRYPTION_KEYS` set, even with no social login: it is the keyring
the TOTP secret is encrypted with at rest.

### Step-up on a new device

This is the part that changes how your sign-in screen works.

When somebody with a second factor signs in from a device their account has never seen,
`POST /_auth/login` answers **202** instead of 200. There is no session: the device key was
registered inactive, and the body carries a challenge that activates it.

```typescript
const result = await authApi.login.call({ body: { email, password } });

if (result.mfaRequired)
{
    // No session yet. Keep result.challenge.secret and ask for a code.
    setChallenge(result.challenge.secret);

    return;
}

router.push('/dashboard');
```

Then finish it. The client helpers do the whole second half:

```typescript
import {
    completeMfaWithCode,
    completeMfaWithRecoveryCode,
    completeMfaWithPasskey,
} from '@spfn/auth/client';

await completeMfaWithCode(authApi, challenge, code);
// Session cookie sealed. Navigate.
```

Offer the recovery-code field beside the code field. Somebody whose authenticator was on the
phone they just lost is precisely the person meeting this screen.

The same 202 comes back from `POST /_auth/oauth/:provider/native` and from
`POST /_auth/password/reset/complete`, and the same helpers finish all three. A password reset
that stops here has still reset the password and still signed every device out — that happens
before the step-up is asked for — so tell the person they are signed out everywhere and need
to finish.

### What you do not have to write

The Next.js proxy handles the cookie half by itself. On a 202 it seals a short-lived pending
cookie holding this browser's private key; on a successful verify it turns that into the
session and clears it. You never touch either.

Two refusals can come back from the proxy rather than the backend, and both mean the same
thing to a person: sign in again.

| code | when |
|------|------|
| `SESSION_PENDING_MISMATCH` | the verification succeeded, but this browser is not the one that started that sign-in |
| `SESSION_PENDING_EXPIRED` | more than ten minutes passed, so there is no pending cookie left |

### The web OAuth path

If you mount `createOAuthCallbackHandler()`, a social sign-in that needs a second factor
redirects to `SPFN_AUTH_MFA_CONFIRM_PATH` (default `/auth/mfa`) with `?challenge=` and
`?returnUrl=`. Build that page; it is the same screen as the password one, and
`completeMfaWithCode` finishes it the same way. Pass `mfaPath` to the handler to put it
somewhere else.

If you use the `OAuthCallback` page component instead, it posts the challenge to
`/_auth/oauth/finalize`, gets a 202 back, and hands you the challenge through its `onSuccess`
— send the person to your confirm screen from there.

### What a 202 has not done

No login event, no new-device event, no `lastLoginAt`. All three wait for the verify and then
fire together. This matters if you send "new device signed in" mail: an attacker who has only
the password produces no mail, because they have not signed in.

The pending key is invisible everywhere too — `listKeys` omits it, it cannot authenticate, and
anything that signs the account out deletes it. So "sign out everywhere" really does end an
attempt that is mid-step-up.

### Sensitive actions

Separately from sign-in, an enrolled account has to have proved its second factor on the
calling device within `SPFN_AUTH_MFA_STEP_UP_MINUTES` (default 10) before changing its
password, signing every device out, or changing the second factor itself. Otherwise the answer
is **403 `STEP_UP_REQUIRED`** and the remedy is `POST /_auth/mfa/step-up` followed by a retry.
An account with nothing enrolled never sees it.

---

## Registered devices

Auth keys are per-device, so a login never revokes the previous one and they accumulate on
purpose. `POST /_auth/keys/list` is what an account screen renders: each row carries
`deviceName`, `platform`, a truncated `fingerprintPrefix`, every moment as epoch
milliseconds, and the `registeredIp` / `registeredUserAgent` the key was first seen from —
display material, spoofable on any request that does not come through a verified proxy, so
render them and decide nothing by them. `revokeKey` signs one device out; `revokeAllKeys`
signs the others out, or everything with `includeCurrent: true`.

### Telling the owner a device appeared

A login event says a session began, not what it began on. `authDeviceRegisteredEvent` says
what it began on, and fires after commit on every channel that registers a key:

```typescript
import { authDeviceRegisteredEvent } from '@spfn/auth/server';

authDeviceRegisteredEvent.subscribe(async (payload) =>
{
    // { userId, keyId, algorithm, fingerprintPrefix, createdAtMillis, channel, mfaEnrolled,
    //   deviceName?, platform?, ip?, userAgent? }
    // channel: 'register' | 'signup-link' | 'invitation' | 'password' | 'oauth'
    //        | 'oauth-native' | 'device-code' | 'password-reset' | 'passkey'
    await sendNewDeviceMail(payload);
});
```

Key rotation is deliberately not announced — replacing the key of a device that is already
signed in is not a new device, and mail about it teaches people to ignore the mail that
matters. A sign-in that stopped at a second-factor challenge emits nothing until the
challenge is spent.

### The sign-out-everywhere link

Send that mail with the action it should offer. `createRevokeAllLink(userId)` mints a
one-time link that signs every device out **with no session at all** — which is the position
somebody who no longer trusts the device in front of them is in.

```typescript
import { createRevokeAllLink } from '@spfn/auth/server';

const { url, expiresAt } = await createRevokeAllLink(userId);   // default TTL 30 minutes
```

The `url` carries the plaintext token, because this flow sends no mail of its own: hand it to
the mail template and let it go — never a log line, a row or a job payload.

The link opens a page in your app (`SPFN_AUTH_REVOKE_ALL_CONFIRM_PATH`, default
`/account/revoke-all`), not an API route, and that page ships with the package:

```typescript
// app/account/revoke-all/route.ts
import { createRevokeAllPageHandlers } from '@spfn/auth/nextjs/server';

export const { GET, POST } = createRevokeAllPageHandlers();
```

`GET` describes the link — when it expires, how many devices are active — and draws one
button; `POST` confirms it and reports how many devices it signed out. Describing changes
nothing, so a mail scanner that prefetches the page has signed nobody out. Pass
`render: (view: RevokeAllPageView) => string` to own the body at all three stages while the
handler keeps the status, the headers, the CSRF token and the hidden fields.

The token rules, every refusal, the rate limit and the two settings are in
[Registered devices](../../packages/auth/README.md#registered-devices-key-management) and
[The sign-out-everywhere link](../../packages/auth/README.md#the-sign-out-everywhere-link)
in the `@spfn/auth` README.

---

## Session Management

### How Sessions Work

1. **Login/Register**: Client generates a key pair → sends public key to server → server stores it
2. **Request**: Client signs a JWT with private key → sends in `Authorization` header
3. **Verification**: Server verifies JWT signature with stored public key
4. **Next.js**: Sessions are also stored in encrypted HttpOnly cookies for Server Components

### Session in Server Components

```typescript
// app/page.tsx
import { getSession } from '@spfn/auth/nextjs/server';
import { redirect } from 'next/navigation';

export default async function HomePage()
{
    const session = await getSession();

    if (!session)
    {
        redirect('/auth/login');
    }

    redirect('/dashboard');
}
```

### Server Component Guards

```typescript
// app/admin/layout.tsx
import { RequireAuth, RequireRole } from '@spfn/auth/nextjs/server';

export default function AdminLayout({ children }: { children: React.ReactNode })
{
    return (
        <RequireAuth>
            <RequireRole roles={['superadmin', 'admin']}>
                {children}
            </RequireRole>
        </RequireAuth>
    );
}
```

Available guard components. All three are async Server Components, and all three take an
optional `fallback` — render that instead of redirecting when the check fails.

| Component | Props | Purpose |
|-----------|-------|---------|
| `RequireAuth` | `redirectTo?` (default `/auth/login`), `fallback?` | Redirects to login if not authenticated |
| `RequireRole` | `roles: string \| string[]`, `redirectTo?` (default `/unauthorized`), `fallback?` | Requires **at least one** of the roles |
| `RequirePermission` | `permissions: string \| string[]`, `redirectTo?` (default `/unauthorized`), `fallback?` | Requires **at least one** of the permissions |

> Note the difference from the route middleware: `requirePermissions` on a route is an AND
> check, while the `RequirePermission` component is an OR check.

### Logout

```typescript
import { authApi } from '@spfn/auth';

// Revokes the current key and clears session
await authApi.logout.call({});
```

### Session TTL

Configure via environment variable:

```bash
SPFN_AUTH_SESSION_TTL=7d    # 7 days (default)
SPFN_AUTH_SESSION_TTL=30d   # 30 days
SPFN_AUTH_SESSION_TTL=12h   # 12 hours
```

### Session binding

A web session's signing key is sealed **inside** the session cookie, which is what makes the
cookie a credential rather than a pointer to one — and it means a copy of the cookie *is*
that device. It signs exactly as the original does, registers no key and raises no new-device
notice. Session binding is the opt-in that closes that window, for an account that has a
platform passkey.

```typescript
await authApi.setSessionBinding.call({ body: { mode: 'passkey' } });
// → { mode: 'passkey', keyExpiresAtMillis }
```

What turning it on changes:

- The session runs on a key that lives **24 hours** (`SPFN_AUTH_BOUND_KEY_TTL_HOURS`) instead
  of ninety days, and only a fresh WebAuthn assertion can put a new one in the cookie. The
  copy cannot produce one, so it stops working at the first renewal.
- When the key runs out the proxy answers 401 `SessionRenewalRequiredError` and **keeps the
  cookies**: the session is waiting on one prompt, not finished. A client component calls
  `renewSession(api)`, and `RequireAuth` takes `renewalPath` (default
  `SPFN_AUTH_SESSION_RENEW_PATH`, `/auth/renew`) to send a server-rendered page there, since
  a server component cannot run a ceremony. Renewal stays possible for **seven days** past
  expiry (`SPFN_AUTH_BOUND_KEY_RENEW_GRACE_HOURS`, default `168`); past that, sign in again.
- A bound session presented from a different **browser family** is refused 401
  `SessionContextChangedError` and its cookies are cleared. The comparison is coarse on
  purpose — five families, no desktop/mobile axis — so a version bump or "Request desktop
  site" is the same browser, and a request with no `user-agent` is no signal rather than a
  mismatch.
- `listKeys` rows gain `concurrentUseAtMillis`: the last time one key was seen from two
  attested addresses at once. Show it and notify on it — it is never a refusal, because
  addresses change legitimately several times an hour.

Turning it **off** asks for a fresh passkey assertion or the account password —
`disableSessionBinding(api)` from `@spfn/auth/client` — and never for key age alone, since a
cookie copied minutes after a sign-in carries exactly that.

> It needs a deployment where `proxy-guard` is configured: a key is bound only on a request
> tagged `clientType: 'web'`, the one signal the backend has that a request came through the
> proxy holding the cookie. Without it, `setSessionBinding` answers 400
> `SessionBindingUnavailableError` rather than turning on a switch that would protect
> nothing. An account that did not opt in is unchanged in every response, cookie and query.

The full model — what a copy can still do before the key expires, how the renewal routes are
bound to the expiring key, and the fail-closed re-seal — is in
[Session binding](../../packages/auth/README.md#session-binding) in the `@spfn/auth` README.

### Cookie Secure Flag

Session cookies have the `Secure` flag enabled by default in production (`NODE_ENV=production`). This means cookies are only sent over HTTPS.

For HTTP-only environments (e.g. bastion server accessed via plain HTTP), override with:

```bash
# .env.local
SPFN_AUTH_COOKIE_SECURE=false
```

| Value | Behavior |
|-------|----------|
| unset | `Secure` follows `NODE_ENV === 'production'` |
| `true` | Always set `Secure` flag |
| `false` | Never set `Secure` flag |

> **Warning:** Only set `SPFN_AUTH_COOKIE_SECURE=false` in non-public staging environments. Disabling `Secure` on a public-facing server exposes session cookies to network interception.

### CSRF Protection

Mutations authenticated by the session cookie are CSRF-checked by default, in the
Next.js proxy. There is nothing to write in an app: the proxy issues the token
alongside the session and the api client sends it back.

**Threat model.** The session cookie is `SameSite=Lax`, which already blocks the
classic cross-site form POST. This covers the rest: a sibling subdomain that can write
cookies on the parent domain (an XSS on `blog.example.com` aimed at
`app.example.com`), browsers that predate or mis-implement Lax, and a domain layout
that later drifts to `SameSite=None`.

**Out of scope: same-origin XSS.** Script running on your own origin can read the
token cookie and call the API as the user. That is true of every CSRF token scheme —
CSP and output escaping are the defence, not this.

**How it works.** On login, OAuth finalize, key rotation and every session renewal the
proxy sets `spfn_csrf`, a readable (non-HttpOnly) cookie carrying only an HMAC of the
session's key id under a subkey derived from `SPFN_AUTH_SESSION_SECRET` — no new
variable. The client mirrors it into the `x-spfn-csrf` header. The proxy **recomputes**
the expected value from the session it just unsealed and compares in constant time; it
never compares the cookie against the header, so a cookie a sibling subdomain tossed
in never verifies. The token is bound to the key id, so key rotation invalidates it and
the same response that rotates or renews the session reissues the cookie. A session
that predates the feature gets one on its first authenticated response, so upgrading
never asks anyone to sign in again.

Requests the proxy does not authenticate from the session cookie are untouched: no
session, direct-to-backend bearer clients, `clientProofV1`, machine and ops tokens. A
request with no session is answered exactly as before (backend 401), so a refusal never
reveals whether anyone is signed in.

```bash
# .env.local — the proxy runs in the Next.js process
SPFN_AUTH_CSRF=enforce
```

| Value | Behavior |
|-------|----------|
| unset | `warn` — allow the request, log one line per request that would be refused |
| `warn` | Same as unset |
| `enforce` | Refuse with `403 {"error":"Forbidden","message":"CSRF token missing or invalid"}` |
| `off` | No check |

Existing apps get signal before breakage. Watch the `@spfn/auth:interceptor:csrf` logs
in `warn`, then switch to `enforce`. `spfn init` scaffolds new apps at `enforce`.

Endpoints a browser session never calls — webhook receivers that authenticate
themselves by signature — can be exempted by exact backend route path:

```typescript
import { configureAuth } from '@spfn/auth/server';

configureAuth({
    csrf: { mode: 'enforce', exemptPaths: ['/webhooks/stripe'] },
});
```

The client mirrors the cookie into the header on **every** RPC call, GET-shaped ones
included. It has no route map — the proxy resolves `routeName` to a method — so it
cannot tell a read from a bodyless mutation like `logout` (`POST /_auth/logout`) or
`revokeOpsToken` (`DELETE /_auth/ops-tokens/:id`), both of which travel as GET. The
proxy checks against the resolved **route** method, so reads are never checked wherever
the header turns up.

Server Components and Server Actions are unaffected: reads resolve to GET routes, and a
server-side mutation carries the header on its own — the api client reads the whole
cookie jar through `next/headers`.

A refused call in a live app usually means the token cookie went missing or went stale.
Two mechanisms repair it: the 403 itself carries a fresh `spfn_csrf`, so a browser that
repeats the mutation succeeds; and any authenticated response whose request had a
missing or mismatched cookie reissues the right one. The client does not retry, so the
user sees one failure first. Neither repair reaches the browser when the refused call
was made *from* the server — a Server Component cannot set cookies and Next.js discards
`Set-Cookie` from the api client's own fetch — so there the next browser-originated
request is what heals it.

See the [@spfn/auth README](../../packages/auth/README.md#csrf-protection) for the
full design.

---

## API Endpoints Reference

### Auth

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/_auth/codes` | POST | — | Send verification code |
| `/_auth/codes/verify` | POST | — | Verify code, get temp token |
| `/_auth/register` | POST | — | Register new account |
| `/_auth/login` | POST | — | Login with email/phone |
| `/_auth/logout` | POST | Required | Revoke current key |
| `/_auth/keys/rotate` | POST | Required | Rotate public key |
| `/_auth/keys/list` | POST | Required | List the caller's registered devices |
| `/_auth/keys/revoke` | POST | Required | Sign one device out |
| `/_auth/keys/revoke-all` | POST | Required | Sign every device out |
| `/_auth/keys/revoke-all/confirm` | POST | — | Describe a mailed sign-out-everywhere link; there is no session here |
| `/_auth/keys/revoke-all/consume` | POST | — | Spend that link: sign every device out |
| `/_auth/mfa/totp/enroll` | POST | Required | Mint a TOTP secret and its `otpauth://` URI |
| `/_auth/mfa/totp/confirm` | POST | Required | Spend the first code; answers the ten recovery codes |
| `/_auth/mfa/status` | GET | Required | `{ enrolled, methods, recoveryCodesRemaining }` |
| `/_auth/mfa/step-up` | POST | Required | Re-prove the second factor on this device |
| `/_auth/mfa/step-up/options` | POST | Required | Options for a step-up by passkey |
| `/_auth/mfa/disable` | POST | Required + step-up | Remove the second factor |
| `/_auth/mfa/passkey/mark` | POST | Required + step-up | Mark or unmark a passkey as the second factor |
| `/_auth/mfa/recovery/regenerate` | POST | Required + step-up | Ten fresh codes; every earlier one stops verifying |
| `/_auth/mfa/verify` | POST | — | Finish a sign-in that answered 202 — it runs before a session exists |
| `/_auth/mfa/verify/options` | POST | — | Options for finishing that sign-in with a passkey |
| `/_auth/session/binding` | POST | Required | Turn session binding on or off |
| `/_auth/session/binding` | GET | Required | Whether it is on, and when this session's key expires |
| `/_auth/session/binding/disable/options` | POST | Required | The challenge that proves it is you before turning it off |
| `/_auth/session/renew/options` | POST | Renewing key | Begin renewing a bound key — signed by the key being renewed, which may be past expiry |
| `/_auth/session/renew/verify` | POST | Renewing key | Verify the assertion; answers exactly as `/_auth/login` |
| `/_auth/password` | PUT | Required | Change password |
| `/_auth/session` | GET | Required | Get session info |
| `/_auth/tokens` | POST | Required | Issue one-time token |
| `/_auth/device/start` | POST | — | Begin device-code login: park a key, get the codes |
| `/_auth/device/poll` | POST | — | Ask whether the request was answered; collects the login |
| `/_auth/device/info` | POST | Required | Describe the device asking to be let in |
| `/_auth/device/approve` | POST | Required | Let the waiting device in |
| `/_auth/device/deny` | POST | Required | Refuse the waiting device |

> **Device-code login** signs in a device that has no key on file yet — a TV, a console, a
> headless CLI. It shows a short `XXXX-XXXX` code from `start`; the account owner enters that
> code on a device that is already signed in (`info` shows which device is asking, then
> `approve`); the waiting device's next `poll` registers its key and answers exactly as
> `/_auth/login` does. A global sign-out (`keys/revoke-all`, a password change, a deletion
> request) also cancels approvals not yet collected. TTL and poll interval are configured via
> `createAuthLifecycle({ deviceAuth })`; the full flow and its security model are documented in
> `packages/auth/README.md`.

> There is no account-existence endpoint. `POST /_auth/exists` was removed on purpose — it
> let anyone enumerate registered users — and the login path is timing-equalized so existence
> cannot be inferred from it either.

### User Profile

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `/_auth/users/profile` | GET | Required | Get user profile |
| `/_auth/users/profile` | PATCH | Required | Update user profile |
| `/_auth/users/username/check` | GET | Required | Check username availability |
| `/_auth/users/username` | PATCH | Required | Update username |
| `/_auth/users/locale` | PATCH | Required | Update locale |

### Invitations

| Route | Method | Auth | Permission | Purpose |
|-------|--------|------|-----------|---------|
| `/_auth/invitations/:token` | GET | — | — | Get invitation details |
| `/_auth/invitations/accept` | POST | — | — | Accept invitation |
| `/_auth/invitations` | POST | Required | `user:invite` | Create invitation |
| `/_auth/invitations` | GET | Required | `user:read` | List invitations |
| `/_auth/invitations/cancel` | POST | Required | `user:invite` | Cancel invitation |
| `/_auth/invitations/resend` | POST | Required | `user:invite` | Resend invitation |
| `/_auth/invitations/delete` | POST | Required | `superadmin` | Delete invitation |

---

## Error Handling

Auth provides specific error classes for each failure scenario:

```typescript
import { AuthError } from '@spfn/auth/errors';

try
{
    await authApi.login.call({ body: { email, password } });
}
catch (error)
{
    if (error instanceof AuthError.InvalidCredentialsError)
    {
        // Wrong email or password (401)
    }
    if (error instanceof AuthError.AccountDisabledError)
    {
        // Account suspended (403)
    }
}
```

### Error Classes

| Error | Status | When |
|-------|--------|------|
| `InvalidCredentialsError` | 401 | Wrong email/password |
| `InvalidTokenError` | 401 | Malformed or invalid JWT |
| `TokenExpiredError` | 401 | JWT has expired |
| `KeyExpiredError` | 401 | Public key has expired |
| `AccountDisabledError` | 403 | Account is suspended/inactive |
| `AccountPendingDeletionError` | 403 | Account is within its deletion grace period (`details.purgeScheduledAt`) |
| `DeletionAlreadyRequestedError` | 409 | Deletion already requested (or account already purged) |
| `DeletionNotRequestedError` | 404 | No pending deletion request to cancel/purge |
| `ImmediateDeletionNotAllowedError` | 403 | Self-service `immediate: true` without `deletion.allowSelfImmediate` |
| `AccountAlreadyExistsError` | 409 | Email/phone already registered |
| `InsufficientRoleError` | 403 | Missing required role |
| `InsufficientPermissionsError` | 403 | Missing required permission |
| `InvalidVerificationCodeError` | 400 | Wrong verification code |
| `InvalidVerificationTokenError` | 400 | Invalid verification token |
| `RegistrationRejectedError` | 403 | A `beforeRegister` hook rejected the signup |
| `ReservedUsernameError` | 400 | Username is reserved |
| `UsernameAlreadyTakenError` | 409 | Username already in use |

---

## Events

Subscribe to auth events for side effects like analytics, notifications, or audit logging:

```typescript
import { authLoginEvent, authRegisterEvent } from '@spfn/auth/server';

authLoginEvent.subscribe((payload) =>
{
    // payload: { userId, provider: 'email'|'phone'|'google'|… , email?, phone? }
    console.log(`User ${payload.userId} logged in via ${payload.provider}`);
});

authRegisterEvent.subscribe(async (payload) =>
{
    // payload: { userId, provider, email?, phone?, metadata? }
    if (payload.email) await sendWelcomeEmail(payload.email);
});
```

`subscribe()` returns an unsubscribe function. To handle an event in a background job
instead, bind it with `.on(event)` from `@spfn/core/job`.

### Available Events

| Event | Payload |
|-------|---------|
| `authLoginEvent` | `{ userId, provider, email?, phone? }` |
| `authRegisterEvent` | `{ userId, provider, email?, phone?, metadata? }` |
| `authDeviceRegisteredEvent` | `{ userId, keyId, algorithm, fingerprintPrefix, createdAtMillis, channel, mfaEnrolled, deviceName?, platform?, ip?, userAgent? }` — fires whenever a device key is registered, on every channel that registers one. See [Registered devices](#registered-devices) |
| `invitationCreatedEvent` | `{ invitationId, email, token, roleId, invitedBy, expiresAt, isResend, metadata? }` |
| `invitationAcceptedEvent` | `{ invitationId, email, userId, roleId, invitedBy, metadata? }` |
| `authDeletionRequestedEvent` | `{ userId, userPublicId, purgeScheduledAt, requestedBy }` |
| `authDeletionCancelledEvent` | `{ userId, userPublicId }` |
| `authDeletionCompletedEvent` | `{ userPublicId, purgeStrategy }` — carries no PII, not even `userId` |
| `oauthUnlinkedEvent` | `{ userId, provider, providerUserId, reason? }` — fires just after a social link is deleted because the provider unlinked it. Subscribe to it for follow-up policy, such as cascading into account deletion |

### Rejecting a Registration (`beforeRegister`)

Events fire after the user already exists, so they cannot reject a signup. For
server-enforced signup policy (age gate, invite-only domains, block lists), inject a
validator with `configureAuth` — it runs before the user row is created on every
registration channel (`credentials`, `oauth`, `invitation`) and throwing rejects the
registration:

```typescript
import { configureAuth } from '@spfn/auth/server';
import { RegistrationRejectedError } from '@spfn/auth/errors';

configureAuth({
    beforeRegister: async ({ channel, provider, email, phone, metadata }) =>
    {
        if (!isOldEnough(metadata?.birthDate))
        {
            throw new RegistrationRejectedError({ message: 'Age requirement not met' });
        }
    },
});
```

See the [`@spfn/auth` README](../../packages/auth/README.md#registration-gate-beforeregister)
for ordering guarantees and per-channel notes.

---

## Mobile clientProofV1 (`@spfn/auth/client-proof`)

Auth profile for native mobile SDKs (spfn-mobile Swift/Kotlin). Instead of cookies or JWT,
each request carries an ECDSA P-256 signature (SHA-256, raw `r‖s` 64 bytes as base16-lower —
DER is rejected) over `(profile, method, path, clientId, keyId, nonce, issuedAtMillis,
bodySha256)` in `x-spfn-*` headers; the server verifies against the public key registered
under `x-spfn-key-id`, in the fixed order revoked → session → expired → replayed → signature,
and answers with a 6-code contract error envelope. Request/response bodies must be
byte-canonical JSON (SPFN-CANON-JSON-1).

Two ways to serve it:

- **Dev surface** — `createClientProofDevHandler(...)` serves the three contract operations
  (`/v1/auth/client-proof/handshake`, `/v1/echo`, `/v1/items/list`) plus `/control` test
  hooks. `examples/04-mobile-contract-dev` is the runnable wiring; the spfn-mobile
  integration suites point at its base URL.
- **Your own server** — `createClientProofGuard(state)` protects session-required routes
  (tags `clientType: 'mobile'`), and the handshake route is assembled from
  `admitClientProofRequest` + `state.openSession`.

Usage snippets, the admission-order rationale, and the canonical-bytes rule live in the
[`@spfn/auth` README](../../packages/auth/README.md#mobile-clientproofv1-spfnauthclient-proof).
Public keys (SPKI DER base64) are registered at construction or via the dev
`/control/register-key` hook — the private half stays on the client (hardware-held on
mobile). A production enrollment/rotation flow is tracked separately (phase 2).

---

## Troubleshooting

### "relation \"spfn_auth.users\" does not exist" (missing auth tables)

Auth tables are **not** created by `spfn db push`'s schema diff — package schemas are excluded
from push on purpose. They are created by the migration files bundled inside `@spfn/auth`,
which `spfn db migrate` (and the final step of a recent `spfn db push`) applies:

```bash
pnpm spfn db status    # shows applied/pending migrations per package
pnpm spfn db migrate   # applies @spfn/auth migrations + project migrations
```

If you installed the package with plain `pnpm add @spfn/auth` (instead of `spfn add`), no
migration has run yet — `spfn db migrate` is required once before the auth routes work.

### "Refusing to start: N pending migration(s)"

The server checks migration state before it serves anything, and stops when the database
is behind the code. This is the same failure as above, moved to boot: without the check,
the server starts, passes its health check, and 500s on the first request touching a
column the migration would have added.

Read the list it prints, then run `pnpm spfn db migrate`. It happens most often right
after upgrading `@spfn/auth` — a new version can carry new columns.

To start anyway (a harness that migrates later, a rollout that must proceed), pass
`spfn dev --allow-pending-migrations`, or set `SPFN_ALLOW_PENDING_MIGRATIONS=true` where
no flag can be passed. Both log the pending list as a warning instead.

### "SPFN_AUTH_SESSION_SECRET is required"

`SPFN_AUTH_SESSION_SECRET` must be set in `.env.local` (Next.js side). It must be at least 32 characters.

```bash
# .env.local
SPFN_AUTH_SESSION_SECRET="generate-a-cryptographically-secure-32-char-string"
```

### Login succeeds but session is empty

The auth interceptor is not registered. Make sure `import '@spfn/auth/nextjs/api'` is the **first import** in your RPC proxy route:

```typescript
// app/api/rpc/[routeName]/route.ts
import '@spfn/auth/nextjs/api';  // ← Must be first!
import { appRouter } from '@/server/router';
import { createRpcProxy } from '@spfn/core/nextjs/server';

export const { GET, POST } = createRpcProxy({ router: appRouter });
```

### All routes return 401

You applied `authenticate` globally but forgot to `.skip(['auth'])` on public routes. Add `.skip(['auth'])` to routes that don't require authentication:

```typescript
export const getStatus = route.get('/status')
    .skip(['auth'])
    .handler(async (c) => ({ status: 'ok' }));
```

### Auth routes not found (404 on `/_auth/*`)

`authRouter` is not registered. Make sure you use `.packages()`:

```typescript
// ✅ Correct
export const appRouter = defineRouter({ ... })
    .packages([authRouter]);

// ❌ Wrong — auth routes won't be accessible
export const appRouter = defineRouter({
    auth: authRouter,  // This doesn't work for package routers
});
```

### Admin account not created on startup

Check that `createAuthLifecycle()` is registered in `server.config.ts` and at least one admin env var format is set:

```bash
# .env.server — pick one format
SPFN_AUTH_ADMIN_ACCOUNTS='[{"email":"admin@example.com","password":"Admin!@34","role":"superadmin"}]'
```

### Login works on localhost but not on remote server (HTTP)

Session cookies have the `Secure` flag in production, so they are not sent over plain HTTP. If you access the app via `http://<ip>:<port>`, the browser silently drops the cookie.

```bash
# .env.local (on the remote server)
SPFN_AUTH_COOKIE_SECURE=false
```

See [Cookie Secure Flag](#cookie-secure-flag) for details.

### OAuth redirects to wrong URL

Both the provider callback URL and the post-login redirect are built from the **app** URL:
`NEXT_PUBLIC_SPFN_APP_URL` if set, otherwise `SPFN_APP_URL` (default `http://localhost:3000`).
Set them on the API server:

```bash
# .env.server
SPFN_APP_URL=http://localhost:3000
NEXT_PUBLIC_SPFN_APP_URL=http://localhost:3000
```

The landing path is `SPFN_AUTH_OAUTH_SUCCESS_URL` (default `/auth/callback`); errors go to
`SPFN_AUTH_OAUTH_ERROR_URL` (default `/auth/error?error={error}`).
