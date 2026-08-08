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
SPFN_AUTH_GOOGLE_REDIRECT_URI=                       # Default: {NEXT_PUBLIC_SPFN_APP_URL||SPFN_APP_URL}/_auth/oauth/google/callback
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
`https://app.example.com/_auth/oauth/google/callback`). If you use the direct
`POST /_auth/oauth/start` flow (no Next.js interceptor), set `SPFN_AUTH_GOOGLE_REDIRECT_URI`
to the API host callback instead — that flow sets its CSRF cookie on the API host.

### OAuth Flow

```
1. Browser → /_auth/oauth/google?state=…  → Redirect to Google consent screen
2. Google  → /_auth/oauth/google/callback → Server validates, creates/links account
3. Server  → /auth/callback?userId=…&keyId=…&returnUrl=…&isNewUser=…
4. Next.js → OAuthCallback component      → Finalizes session, redirects to returnUrl
```

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
| `/_auth/oauth/finalize` | POST | Finalize OAuth session |
| `/_auth/oauth/:provider/unlink-notify` | GET/POST | Provider발 연동 해제 웹훅 수신 (카카오 연결 해제 웹훅 · 네이버 연결끊기 Callback URL 등록용, 서명 검증 후 소셜 연결·저장 토큰 삭제) |

Hono matches literal segments before `:provider`, so `/google` and `/providers` are taken by
their own routes and every other provider id falls through to the generic handlers.

### Custom Providers (Pluggable)

OAuth provider 분기는 registry 기반이라 내장 provider 외의 provider를 런타임에 끼울 수 있습니다. 내장 `google`·`kakao`·`naver`·`github`·`apple`은 자기 등록되고, 외부 패키지는 `registerOAuthProvider()`로 등록합니다.

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

등록 후 `POST /_auth/oauth/start`, `GET /_auth/oauth/:provider`, `GET /_auth/oauth/:provider/callback`이 해당 provider를 자동 처리합니다 — 콜백 route를 따로 만들 필요는 없습니다 (제네릭 콜백이 이미 `Transactional()`로 감싸여 있어 중간 실패 시 orphan user가 남지 않습니다). provider id는 `SOCIAL_PROVIDERS` enum(`google`·`apple`·`github`·`kakao`·`naver`·`superself`)에 포함되어야 합니다.

> 인터페이스(`OAuthProvider` / `NormalizedIdentity` / `OAuthTokens`) 전체 명세는 [`@spfn/auth` README의 Custom OAuth Providers](../../packages/auth/README.md#custom-oauth-providers-pluggable) 참고.

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
| `/_auth/password` | PUT | Required | Change password |
| `/_auth/session` | GET | Required | Get session info |
| `/_auth/tokens` | POST | Required | Issue one-time token |

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
| `invitationCreatedEvent` | `{ invitationId, email, token, roleId, invitedBy, expiresAt, isResend, metadata? }` |
| `invitationAcceptedEvent` | `{ invitationId, email, userId, roleId, invitedBy, metadata? }` |
| `authDeletionRequestedEvent` | `{ userId, userPublicId, purgeScheduledAt, requestedBy }` |
| `authDeletionCancelledEvent` | `{ userId, userPublicId }` |
| `authDeletionCompletedEvent` | `{ userPublicId, purgeStrategy }` — carries no PII, not even `userId` |
| `oauthUnlinkedEvent` | `{ userId, provider, providerUserId, reason? }` — provider 쪽에서 연동을 끊어 소셜 연결이 삭제된 직후. 계정 탈퇴 연계 등 후속 정책은 이 이벤트를 구독해 처리 |

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
