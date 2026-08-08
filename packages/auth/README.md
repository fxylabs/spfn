# @spfn/auth

> **Two applications' worth of auth, in one package**

Nothing ships until people can sign in. `@spfn/auth` clears that gate twice over — once
for the people who use your product, and once for the people who operate it.

- **For your users** — registration, password and OTP login, social sign-in, sessions,
  registered devices, and account deletion with a recovery window.
- **For your operators** — admin accounts seeded from the environment, roles and
  permissions enforced on every route, invitations, and role administration your
  superadmins can change at runtime.

The second half is what usually becomes a second application: an admin dashboard with its
own auth, its own screens, and its own maintenance, growing for as long as the product
does. Attach [`@spfn/mcp`](../mcp/README.md) instead and those operations become tools an
AI agent runs, gated by the same roles — see
[Can I operate the app without building an admin dashboard?](#can-i-operate-the-app-without-building-an-admin-dashboard).

Underneath: asymmetric client-signed JWTs (ES256/RS256), OTP verification, OAuth 2.0
through a pluggable provider registry (Google, GitHub, Kakao and Naver built in), session
cookies for Next.js, and runtime RBAC. Routes mount under `/_auth/*` and are reached
through a typed `authApi` client. Requires `@spfn/core`; Next.js is an optional peer
(`^16.2.11`).

## Install

```bash
pnpm add @spfn/auth drizzle-orm@1.0.0-rc.4
```

## Import paths

Entry points (from `package.json` `exports`). Picking the wrong one breaks the build —
`/server`, `/client-proof` and `/nextjs/*` pull in Node code and must never reach the browser bundle.

```typescript
import { authApi, authRouteMap }      from '@spfn/auth';          // isomorphic: client + route map + types/constants
import { authRouter, authenticate }   from '@spfn/auth/server';   // SERVER ONLY: router, services, repos, middleware, helpers
import { /* hooks/components */ }      from '@spfn/auth/client';   // browser only (currently empty — WIP)
import { env, envSchema }             from '@spfn/auth/config';    // validated env proxy + schema
import { InvalidCredentialsError }    from '@spfn/auth/errors';    // error classes + authErrorRegistry
import '@spfn/auth/nextjs/api';                                    // SERVER: auto-registers RPC interceptors (side-effect)
import { RequireAuth, getSession }    from '@spfn/auth/nextjs/server'; // SERVER: RSC guards, session helpers, OAuth handler
import { OAuthCallback }              from '@spfn/auth/nextjs/client';  // 'use client' OAuth callback component
import { createClientProofDevHandler } from '@spfn/auth/client-proof';  // SERVER: mobile clientProofV1 profile (see below)
```

> Database entities (`users`, `userPublicKeys`, …) and all services/repositories are exported
> from `@spfn/auth/server`, **not** from the root `@spfn/auth`.

## How do I add auth to an SPFN app?

Four edits in the consuming app. All four are required for the flow to work end to end.

### 1. Lifecycle — `server.config.ts`

`createAuthLifecycle()` validates env before DB connect, then seeds admin accounts and
initializes RBAC after the DB is ready. Pass custom roles/permissions here (see RBAC below).

```typescript
import { defineServerConfig } from '@spfn/core/server';
import { createAuthLifecycle } from '@spfn/auth/server';
import { appRouter } from './router';

export default defineServerConfig()
    .port(8790)
    .routes(appRouter)
    .lifecycle(createAuthLifecycle())
    .build();
```

### 2. Router + global middleware — `router.ts`

`authRouter` (the package's `mainAuthRouter`) is merged via `.packages()`; `authenticate` is
applied globally via `.use()`. Public routes opt out per-route with `.skip(['auth'])`.

```typescript
import { defineRouter } from '@spfn/core/route';
import { authRouter, authenticate } from '@spfn/auth/server';
import { getHealth } from './routes/health';

export const appRouter = defineRouter({
    getHealth,
    // ...your routes
})
    .packages([authRouter])   // mounts /_auth/* and exposes routes on authApi
    .use([authenticate]);     // global auth middleware

export type AppRouter = typeof appRouter;
```

### 3. Next.js interceptor — RPC proxy route

The interceptor handles session cookies, JWT signing, and key management automatically.
Import it for its side-effect (it self-registers); it must run before the proxy is created.

```typescript
// app/api/rpc/[routeName]/route.ts
import '@spfn/auth/nextjs/api';        // side-effect: registers auth interceptors
import { createRpcProxy } from '@spfn/core/nextjs/server';
import { authRouteMap } from '@spfn/auth';
import { routeMap } from '@/generated/route-map';

export const { GET, POST } = createRpcProxy({ routeMap: { ...routeMap, ...authRouteMap } });
```

### 4. Run migrations

```bash
pnpm spfn db generate   # only if entities changed
pnpm spfn db migrate
```

The API client needs no auth-specific config. `authApi` is also available standalone:

```typescript
import { authApi } from '@spfn/auth';
const session = await authApi.getAuthSession.call({});   // → GET /_auth/session
```

## Which environment variables do I need?

Set across **two files** by audience. Server-only secrets go in `.env.server`; values the
Next.js runtime needs (session cookie crypto) go in `.env.local`. Names only below — supply
real secret values out of band, never commit them.

| Var | File | Required | Notes |
|-----|------|----------|-------|
| `DATABASE_URL` | both | yes | Postgres connection |
| `SPFN_AUTH_VERIFICATION_TOKEN_SECRET` | `.env.server` | yes | OTP / verification token signing |
| `SPFN_AUTH_SESSION_SECRET` | `.env.local` | yes | ≥32 chars, AES-256 session cookie encryption (validated: entropy/unique-char checks) |
| `SPFN_AUTH_TOKEN_ENCRYPTION_KEYS` | `.env.server` | web OAuth | OAuth token keyring: comma-separated `<keyId>:<base64-32-byte-key>` entries; first key is active |
| `SPFN_API_URL` | `.env.local` | — | default `http://localhost:8790` |
| `SPFN_AUTH_SESSION_TTL` | both | — | default `7d` (e.g. `7d`, `12h`, `45m`) |
| `SPFN_AUTH_JWT_SECRET` / `SPFN_AUTH_JWT_EXPIRES_IN` | `.env.server` | — | legacy server-signed JWT mode only |
| `SPFN_AUTH_BCRYPT_SALT_ROUNDS` | `.env.server` | — | default `12` (native bcrypt, off the event loop) |
| `SPFN_AUTH_COOKIE_SECURE` | both | — | override Secure flag (defaults to `NODE_ENV==='production'`) |
| `SPFN_AUTH_ADMIN_*` | `.env.server` | — | admin seeding (see below) |
| `SPFN_AUTH_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET` | `.env.server` | — | enables Google OAuth when both set |
| `SPFN_AUTH_GOOGLE_SCOPES` | `.env.server` | — | comma-separated; default `email,profile` |
| `SPFN_AUTH_GOOGLE_REDIRECT_URI` | `.env.server` | — | default `{NEXT_PUBLIC_SPFN_APP_URL\|\|SPFN_APP_URL}/_auth/oauth/google/callback` — see [OAuth callback origin](#oauth-callback-origin-web-app-host--rewrite) |
| `SPFN_AUTH_KAKAO_CLIENT_ID` / `_CLIENT_SECRET` | `.env.server` | — | REST API key enables Kakao Login; secret is included when configured |
| `SPFN_AUTH_KAKAO_ADMIN_KEY` | `.env.server` | — | app admin key; required to verify the Kakao User Unlinked webhook |
| `SPFN_AUTH_KAKAO_SCOPES` / `_REDIRECT_URI` | `.env.server` | — | default scope `account_email`; callback `/_auth/oauth/kakao/callback` |
| `SPFN_AUTH_NAVER_CLIENT_ID` / `_CLIENT_SECRET` | `.env.server` | — | both values enable Naver Login |
| `SPFN_AUTH_NAVER_REDIRECT_URI` | `.env.server` | — | default `{NEXT_PUBLIC_SPFN_APP_URL\|\|SPFN_APP_URL}/_auth/oauth/naver/callback` |
| `SPFN_AUTH_GITHUB_CLIENT_ID` / `_CLIENT_SECRET` | `.env.server` | — | both values enable GitHub OAuth |
| `SPFN_AUTH_GITHUB_SCOPES` / `_REDIRECT_URI` | `.env.server` | — | default scopes `read:user,user:email`; callback `/_auth/oauth/github/callback` |
| `SPFN_AUTH_GOOGLE_NATIVE_CLIENT_IDS` | `.env.server` | — | comma-separated client IDs accepted as native id_token audience (iOS/Android/web); enables Google native sign-in |
| `SPFN_AUTH_APPLE_CLIENT_IDS` | `.env.server` | — | comma-separated Apple client IDs (bundle ID / Services ID); enables Apple native sign-in |
| `SPFN_AUTH_KAKAO_NATIVE_CLIENT_IDS` | `.env.server` | — | comma-separated Kakao app keys accepted as native id_token audience (native app key); `SPFN_AUTH_KAKAO_CLIENT_ID` is also accepted, so either one enables Kakao native sign-in |
| `SPFN_AUTH_NAVER_NATIVE_CLIENT_IDS` | `.env.server` | — | comma-separated Naver client IDs accepted as native id_token audience. `SPFN_AUTH_NAVER_CLIENT_ID` is also accepted, so this is only needed for a separate app application |
| `SPFN_AUTH_OAUTH_SUCCESS_URL` | `.env.server` | — | default `/auth/callback` |
| `SPFN_AUTH_OAUTH_ERROR_URL` | `.env.server` | — | default `/auth/error?error={error}` |
| `SPFN_AUTH_RESERVED_USERNAMES` / `_USERNAME_MIN_LENGTH` / `_USERNAME_MAX_LENGTH` | `.env.server` | — | username rules |
| `NEXT_PUBLIC_SPFN_API_URL` / `NEXT_PUBLIC_SPFN_APP_URL` | `.env.local` | — | browser-facing URLs for OAuth redirects |

Read validated values via `import { env } from '@spfn/auth/config'` (a proxy validated at
startup). `envSchema` carries descriptions/defaults.

### Admin seeding

`createAuthLifecycle()` creates admin accounts on startup from env, in priority order. Seeded
accounts are auto email-verified, `status: 'active'`, `passwordChangeRequired: true`.

- **JSON (recommended):** `SPFN_AUTH_ADMIN_ACCOUNTS` — array of `{email, password, role?, phone?, passwordChangeRequired?}`. `role` defaults to `user` (`user` | `admin` | `superadmin`).
- **CSV:** `SPFN_AUTH_ADMIN_EMAILS` + `SPFN_AUTH_ADMIN_PASSWORDS` + `SPFN_AUTH_ADMIN_ROLES`.
- **Single (legacy):** `SPFN_AUTH_ADMIN_EMAIL` + `SPFN_AUTH_ADMIN_PASSWORD` → always `superadmin`.

## Routes

All routes mount at `/_auth/*` and are reached through `authApi.<name>.call({ body })`. Public
routes use `.skip(['auth'])`; the rest require `Authorization: Bearer <client-signed-jwt>`.

| `authApi` method | HTTP | Auth | Purpose |
|------------------|------|------|---------|
| `sendVerificationCode` | POST `/_auth/codes` | public | send 6-digit OTP |
| `verifyCode` | POST `/_auth/codes/verify` | public | verify OTP → verification token |
| `register` | POST `/_auth/register` | public | create user + register public key |
| `login` | POST `/_auth/login` | public | password login + new session key |
| `logout` | POST `/_auth/logout` | yes | revoke current key |
| `rotateKey` | POST `/_auth/keys/rotate` | yes | rotate public key before 90-day expiry |
| `listKeys` | POST `/_auth/keys/list` | yes | the caller's registered devices — see [Registered devices](#registered-devices-key-management) |
| `revokeKey` | POST `/_auth/keys/revoke` | yes | sign one device out |
| `revokeAllKeys` | POST `/_auth/keys/revoke-all` | yes | sign every device out (spares the caller by default) |
| `changePassword` | PUT `/_auth/password` | yes | change password |
| `getAuthSession` | GET `/_auth/session` | yes | current session/user |
| `issueOneTimeToken` | POST | yes | short-lived token (e.g. SSE handshake) |
| `checkUsername` / `updateUsername` / `updateLocale` | — | mixed | username availability/update, locale |
| `getUserProfile` / `updateUserProfile` | — | yes | profile read/update |
| `createInvitation` / `acceptInvitation` / `listInvitations` / `cancelInvitation` / `resendInvitation` / `deleteInvitation` / `getInvitation` | — | mixed | invitation flow |
| `requestAccountDeletion` | POST `/_auth/deletion/request` | yes | request account deletion (re-auth gated) — see [Account Deletion & Recovery](#account-deletion--recovery) |
| `cancelAccountDeletion` | POST `/_auth/deletion/cancel` | public | cancel a pending deletion (credential-based recovery) |
| `listRoles` / `createAdminRole` / `updateAdminRole` / `deleteAdminRole` / `updateUserRole` | — | superadmin | admin RBAC management |
| OAuth routes | — | — | see OAuth section |

There is deliberately **no account-existence endpoint**. `POST /_auth/exists` was removed
because it answered "does this account exist" directly, which is user enumeration; the
login path is timing-equalized for the same reason. Do not reintroduce one without
revisiting that decision.

Auth uses **asymmetric, client-signed JWTs**: the client generates an ES256/RS256 keypair,
sends the public key on register/login, signs request JWTs locally, and the server verifies
with the stored public key (`keyId` carried in the JWT). The server never holds a private key.
Keys expire after 90 days — rotate with `rotateKey`.

### Registered devices (key management)

Keys are per-device, so a login never revokes the previous key and they accumulate on purpose.
`listKeys` / `revokeKey` / `revokeAllKeys` are what let the account owner see what accumulated and
cut off anything they no longer recognise.

```typescript
const { keys } = await authApi.listKeys.call({ body: {} });
// → [{ keyId, deviceName?, platform?, algorithm, fingerprintPrefix, createdAtMillis,
//      lastUsedAtMillis?, expiresAtMillis?, isExpired, isActive, revokedAtMillis? }]

await authApi.listKeys.call({ body: { includeRevoked: true } });   // also what was cut off
```

Every moment is epoch milliseconds, not an ISO string — one representation across the whole
surface, so a generated Swift or Kotlin client reads an integer instead of choosing a date
formatter. This changed in mobile contract 0.5.0; an app still reading `createdAt` moves to
`createdAtMillis`.

`algorithm` is the `KeyAlgorithm` enum from contract 0.6.0 rather than a bare string — the routes
have always constrained it to those values, and the contract had been understating the server. The
declared values are the ones the server accepts and sends **now**: one can be added, and one can be
withdrawn for a weakness found later, so a generated client should be built to meet a value it does
not recognise rather than assume the set is closed.

```typescript
await authApi.revokeKey.call({ body: { keyId } });            // → { keyId, selfRevoked }
await authApi.revokeAllKeys.call({ body: {} });               // other devices only
await authApi.revokeAllKeys.call({ body: { includeCurrent: true } });   // everything
```

> **All three are POST with their arguments in the body, deliberately.** The mobile auth
> profile (clientProofV1) signs the request body, and `canonical-json` fixes exactly how those
> bytes are written. A `GET` has no body to sign, and a value in the path has no such rule —
> client and server could disagree on the signed string over percent-encoding, a trailing
> slash, or a proxy rewrite alone, and the request would be refused with nothing in the logs
> naming the cause. Every operation in the contract is shaped this way.

- **The public key never leaves the server**, and the fingerprint is truncated to 8 characters.
  The list exists to recognise a device and point at it; the full fingerprint is what a native
  sign-in sends as its nonce, not a label.
- **`isExpired` is computed, not stored.** Nothing flips `isActive` when the TTL runs out —
  `authenticate` refuses the key at request time. A list that showed such a key as simply active
  would report something the server does not act on.
- **Revoking your own key is allowed.** It is this device's sign-out, which `logout` already does.
  `selfRevoked` in the response tells the two cases apart.
- **`revokeAllKeys` spares the calling device unless you ask otherwise**, so the common case is
  "sign out my other devices". `includeCurrent: true` is the full sign-out — until now reachable
  only as a side effect of changing a password, which nobody does for that reason.
- **A key id you do not own answers 404** (`KeyNotFoundError`). Every lookup is scoped by user, so
  the answer is only ever "not yours" and reveals nothing about other accounts.
- **Revocation takes effect immediately.** `authenticate` reads the key from the database on every
  request with no cache in front of it.
- **`includeRevoked: true` shows what was already cut off**, with `revokedAt`. The default is only
  keys that can still sign.

Every path that registers a key (`register`, `login`, `rotateKey`, native OAuth) accepts optional
`deviceName` (≤64 chars) and `platform` (`ios` / `android` / `web` / `desktop`). Both are display
only — nothing is authorized by them — and both are absent on keys registered before they existed.
Rotation carries the replaced key's label over unless the client sends a new one.

All three are in the mobile contract (0.4.1) as `auth.keys.list` / `auth.keys.revoke` /
`auth.keys.revokeAll`, so a generated mobile client reaches them the same way it reaches key
rotation.

A `keyId` is **single-use for its lifetime**: it is unique across all users and is never reissued
once revoked. A client that logs out, rotates, or is revoked must generate a **fresh keypair and
`keyId`** for its next sign-in — resending the old one is refused with
`KeyIdAlreadyRegisteredError` (409), on every path that registers a key. Re-registering a key that
is still active is the one
exception: it stays a no-op success, so repeated logins from the same device keep working, and an
expired-but-active key has its expiry extended by the sign-in that proved the identity again.

### Writing protected routes (route DSL)

This is the current SPFN route DSL — `route.<method>().input().use().skip().handler()` registered
via `defineRouter`. Access auth state through the context helpers, not by reading raw context.

```typescript
import { route } from '@spfn/core/route';
import { authenticate, requirePermissions, optionalAuth } from '@spfn/auth/server';
import { getAuth, getOptionalAuth } from '@spfn/auth/server';

// Protected (global `authenticate` already applies; helpers read the context)
export const getMe = route.get('/me')
    .handler(async (c) =>
    {
        const { user, userId, role, locale } = getAuth(c);
        return { id: userId, email: user.email, role };
    });

// Permission-gated (all required); use requireAnyPermission for OR, requireRole for roles
export const deleteUser = route.delete('/users/:id')
    .use([authenticate, requirePermissions('user:delete')])
    .handler(async (c) => { /* ... */ });

// Public + optional user context. optionalAuth auto-skips global 'auth' — no .skip needed
export const getProducts = route.get('/products')
    .use([optionalAuth])
    .handler(async (c) =>
    {
        const auth = getOptionalAuth(c);   // AuthContext | undefined
        return auth ? personalized(auth.userId) : publicList();
    });
```

Context helpers from `@spfn/auth/server`: `getAuth`, `getOptionalAuth`, `getUser`, `getUserId`,
`getRole`, `getLocale`, `getKeyId`. Middleware: `authenticate`, `optionalAuth`,
`requirePermissions`, `requireAnyPermission`, `requireRole`, `roleGuard`, `oneTimeTokenAuth`.

## OAuth

OAuth uses a **pluggable provider registry** — not hardcoded branches. The built-in `google`,
`github`, `kakao`, and `naver` web providers self-register on module load; `apple` provides native
`id_token` sign-in. External packages add providers at runtime with `registerOAuthProvider()`.
Google, GitHub, and Naver each require their client ID and secret; Kakao requires its REST API
key (and sends its optional client secret when configured).

Client flow: call `authApi.getGoogleOAuthUrl.call({ body: { returnUrl } })`, redirect the browser
to the returned `authUrl`, and render `OAuthCallback` on your success page. The Next.js interceptor
manages the keypair → pending-session-cookie → full-session handoff transparently.

```tsx
// app/auth/callback/page.tsx
export { OAuthCallback as default } from '@spfn/auth/nextjs/client';
```

```typescript
import { authApi } from '@spfn/auth';
const { authUrl } = await authApi.getGoogleOAuthUrl.call({
    body: {
        returnUrl: '/dashboard',
        metadata: { birthDate: '2000-01-01', termsAgreed: true },
    },
});
window.location.href = authUrl;
```

GitHub, Kakao, and Naver use the provider-generic URL route:

```typescript
const { authUrl } = await authApi.getProviderOAuthUrl.call({
    params: { provider: 'github' }, // or 'kakao', 'naver'
    body: {
        returnUrl: '/dashboard',
        metadata: { birthDate: '2000-01-01', termsAgreed: true },
    },
});
window.location.href = authUrl;
```

Both convenience URL APIs seal `metadata` into the encrypted OAuth state. On a new social
signup, the callback passes it to `beforeRegister` and `authRegisterEvent`; existing-account
logins do not run the registration hook.

Built-in OAuth routes: `POST /_auth/oauth/google/url`, `GET /_auth/oauth/google` (redirect),
`GET /_auth/oauth/google/callback`, `POST /_auth/oauth/finalize`, `GET /_auth/oauth/providers`,
plus the provider-generic `POST /_auth/oauth/start`. `getGoogleAccessToken(userId)` returns a
valid Google access token (auto-refreshing via stored refresh token when near expiry; throws if
no Google account is linked or no refresh token is available).

Kakao's `is_email_valid` and `is_email_verified` claims are both required before its email can
link an existing SPFN account. GitHub uses the primary email from `/user/emails` (needs the
`user:email` scope) and treats it as verified only when GitHub marks it verified; without that
scope it falls back to the public profile email, unverified. Naver's profile email is either the
Naver account email or a contact email that passed Naver's own verification, so a present email
is treated as verified — it is stored on the user row and may link an existing account by email,
the same trust level as Kakao. Accounts created before this policy (user row with `email` null)
are backfilled on their next login: if the provider reports a verified email and no other account
owns it, `email` and `emailVerifiedAt` are filled in (best-effort; a conflict skips the backfill
and the login continues).

### Provider-initiated unlink notifications (`unlink-notify`)

Kakao and Naver notify the service when a user disconnects the app **from the provider's side**
(account deletion, "연결된 서비스 관리" 해제 등). Without handling this, the service keeps the
OAuth link and stored tokens for a user who already revoked consent — a privacy-compliance gap
(Kakao shows a permanent console warning until the webhook is registered).

`GET|POST /_auth/oauth/:provider/unlink-notify` is a public endpoint that verifies the
provider's signature, deletes the `user_social_accounts` row (destroying the stored
access/refresh tokens with it), and emits `auth.oauth.unlinked`. Requests that fail
verification are rejected by status code and touch nothing.

Register in the provider console:

| Provider | Console setting | URL to register | Verification | Success response |
|----------|-----------------|-----------------|--------------|------------------|
| Kakao | [앱] > [웹훅] > 연결 해제 웹훅 | `https://<host>/_auth/oauth/kakao/unlink-notify` | `Authorization: KakaoAK <admin key>` vs `SPFN_AUTH_KAKAO_ADMIN_KEY` | 200 within 3s |
| Naver | API 설정 > 연결끊기 Callback URL | `https://<host>/_auth/oauth/naver/unlink-notify` | HMAC-SHA256 signature + AES-128-CBC `encryptUniqueId` (key = `md5(client_secret)[0..16]`) | 204 No Content |

The framework only severs the link. What happens next (keep the account, start account
deletion, …) is app policy — subscribe to the event:

```typescript
import { oauthUnlinkedEvent } from '@spfn/auth/server';

oauthUnlinkedEvent.subscribe(async ({ userId, provider, providerUserId, reason }) =>
{
    // e.g. delete the account when the social link was its only credential
});
```

Custom providers opt in by implementing `verifyUnlinkNotification()` (and optionally
`unlinkNotifyAckStatus`) — providers without it answer 404 on this route.

### OAuth callback origin (web app host + rewrite)

The callback's CSRF check is a double-submit: the Next.js interceptor sets an `oauth_csrf`
cookie on the **web app host**, and the callback compares it against the nonce sealed in the
state. Host-only cookies never reach a different host, so **the provider callback must return
to the web app origin** — redirect URIs default to
`{NEXT_PUBLIC_SPFN_APP_URL || SPFN_APP_URL}/_auth/oauth/<provider>/callback`.

The app forwards `/_auth/*` to the API with a standard rewrite (**required** — without it the
callback 404s on the web host, including in local dev):

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

Register each **web app host** callback URL in its provider console, for example
`https://app.example.com/_auth/oauth/kakao/callback` and
`https://app.example.com/_auth/oauth/naver/callback`.

The cookie name also carries a `_${PORT}` suffix from the process that set it (the Next.js
process), which differs from the API process in a split deployment — the callback therefore
matches every `spfn_oauth_csrf*` cookie candidate against the state nonce, so no PORT
coordination is needed.

One caveat: the direct `POST /_auth/oauth/start` flow (no Next.js interceptor) sets its CSRF
cookie on the **API host**. If you use that flow in a split deployment, set
the corresponding provider redirect URI explicitly to the API host callback instead.

### Native social sign-in (mobile / web id_token)

For native apps — and for Apple on Android/web, which has no native SDK — the client obtains an
`id_token` from the platform SDK and posts it to **`POST /_auth/oauth/:provider/native`**. No
authorization code, no client secret: the server verifies the id_token against the provider's
JWKS (signature, issuer, audience, expiry, nonce), links/creates the user, and **registers the
client's public key**. It returns `{ userId, keyId, isNewUser }` — *not* a token. The client mints
its own Bearer client token by signing with the on-device private key (the same client-signs /
server-verifies model as the rest of auth).

Enable per provider by declaring the accepted audiences: `SPFN_AUTH_GOOGLE_NATIVE_CLIENT_IDS` for
Google (the web `SPFN_AUTH_GOOGLE_CLIENT_ID` is also accepted), `SPFN_AUTH_APPLE_CLIENT_IDS` for
Apple, and `SPFN_AUTH_KAKAO_NATIVE_CLIENT_IDS` for Kakao (the REST API key in
`SPFN_AUTH_KAKAO_CLIENT_ID` is also accepted). Apple is native-only here — its web OAuth
(code-exchange) methods throw.

```typescript
await authApi.oauthNative.call({
    params: { provider: 'apple' },                 // or 'google', 'kakao'
    body: { idToken, nonce, publicKey, keyId, fingerprint, algorithm: 'ES256', profile: { name } },
});
// → { userId, keyId, isNewUser }; client then signs its own ES256 Bearer token with keyId
```

Every refusal names itself. The response body carries `error.code` — the server's error class
name — alongside the usual `__type`, so a client that has no TypeScript error registry can still
tell the eleven ways this call fails apart:

| `error.code` | HTTP | What the client does |
| --- | --- | --- |
| `ValidationError` | 400 | fix the request body |
| `NativeSignInUnsupportedError` | 400 | hide that provider's native button — server configuration |
| `NonceKeyBindingError` | 400 | send `nonce === fingerprint` |
| `InvalidKeyFingerprintError` | 400 | send the SHA-256 of the submitted key |
| `UnverifiedEmailLinkError` | 400 | send the user to verify that address |
| `InvalidSocialTokenError` | 401 | obtain a fresh id_token |
| `AccountDisabledError` | 403 | show the account status |
| `AccountPendingDeletionError` | 403 | offer restore |
| `KeyIdAlreadyRegisteredError` | 409 | generate a new keyId and retry |
| `TooManyRequestsError` | 429 | **the only retry-the-same-request code** |
| `Error` | 500 | generic failure |

The `nonce` is the **raw** nonce the client used; Apple hashes it (SHA-256) into the token, so send
the raw value for any provider. `profile.name` captures the name Apple returns only on first
sign-in. Trade-off: skipping code exchange means no Apple refresh token / server-side revoke —
revoke SPFN access by revoking the registered key instead.

> **The nonce must be the `fingerprint` of the key being registered.** Since contract 0.4.0 the
> server refuses the call when `nonce !== fingerprint`, or when that fingerprint is not the
> SHA-256 of the submitted `publicKey`'s DER bytes. So the client does not mint a random nonce —
> it asks the provider for a token bound to the key it is about to enroll:
>
> ```typescript
> const fingerprint = sha256Hex(derBytesOf(publicKey));   // lowercase hex, 64 chars
> const nonce = fingerprint;                              // what the provider echoes back
> // Apple only: put sha256Hex(nonce) in the authorization request — Apple hashes what it receives
> ```
>
> Why: an `id_token` is a bearer credential. It is not bound to the channel it came over, so
> verifying it alone means whoever holds one valid token can enroll **their own** key on **someone
> else's** account — by extracting the app key from a real app binary, from a rooted device, or
> from a leaked log. The web OAuth flow is not exposed this way: there the public key travels
> inside encrypted `state` whose nonce must match the browser's CSRF cookie. Deriving the nonce
> from the key gives the native path the same binding, because a stolen token carries the victim's
> fingerprint and cannot be re-paired with an attacker's key. Re-submitting the victim's own key
> stays possible and is worthless — the attacker has no matching private key.
>
> Naver's trailing-`A` problem (below) is satisfied for free: a SHA-256 hex digest is lowercase.

> **Generate the nonce as lowercase hex, not base64.** Naver drops a trailing `A` from a base64url
> nonce before putting it in the id_token. A 16-byte base64url value ends in one of `A Q g w` —
> its last character carries only 2 bits of data plus 4 bits of padding — so a base64 nonce fails
> verification for roughly one sign-in in four, intermittently and with nothing in the logs
> pointing at the cause.
>
> The trigger is the character `A`, not the encoding as such. **Uppercase hex ends in `A` once in
> sixteen and breaks the same way**; lowercase hex (`0-9a-f`) has no `A` in its alphabet, so it
> cannot hit the case at all. Nonce comparison is exact by design (`jwks-verify.ts`) — accepting a
> truncated value would also accept any other nonce sharing those first characters — so the fix
> belongs on the client. Confirmed on Naver; not yet measured on the other providers, and
> lowercase hex is safe for all of them.

#### The optional `accessToken`

`accessToken` is the provider access token from the same sign-in. It is **optional and
provider-specific** — the server never requires it, and a client that omits it still signs in.

Send it only when a provider's id_token cannot establish the user's **email**, which is identity
data: `createOrLinkUser` matches an existing account by verified email. Display-side profile
(name, avatar) is deliberately *not* a reason to send it — that belongs to the app, not to auth.

| Provider | Send `accessToken`? | Why |
|---|---|---|
| Google | No | id_token carries `email` + `email_verified` |
| Apple | No | same, and Apple relay addresses are already the authoritative value |
| Kakao | **Optional, recommended** | id_token carries `email` but no `email_verified`; without it the address is stored unverified |
| Naver | **Optional, recommended** | id_token carries no profile claim at all; userinfo returns the address, which carries no verification flag (see below) |

Whatever the provider, the server trusts a lookup made with this token only after the identity it
returns matches the id_token's `sub`. A mismatch, or a failed lookup, is treated as if the token
had not been sent.

**Kakao.** Enable OpenID Connect in the Kakao developer console and request the `openid` scope, or
the SDK returns no `idToken`. One Kakao app issues several keys (native app key, REST API key), and
the `aud` claim is whichever key obtained the token — so list the native app key and let the REST
API key be accepted alongside it. The `sub` (회원번호) is per-app, not per-key, so web and app
sign-ins resolve to the same user.

Kakao's id_token carries `email` but no `email_verified`, so the identity comes back **unverified**
and the account is created with a null email. To match the web flow's strength, send the
`accessToken` the SDK returned in the same sign-in as an optional body field: the server then reads
`is_email_valid` / `is_email_verified` from `/v2/user/me`. That token is client-supplied, so the
lookup is trusted only when its 회원번호 equals the id_token's `sub`; a mismatch or a failed lookup
leaves the email unverified and the sign-in still succeeds.

```typescript
await authApi.oauthNative.call({
    params: { provider: 'kakao' },
    body: { idToken, nonce, accessToken, publicKey, keyId, fingerprint, algorithm: 'ES256' },
});
```

**Naver.** Naver runs two login surfaces. The web redirect flow uses `/oauth2.0/*`, which is plain
OAuth2 and issues no id_token; native verification uses the OIDC surface at `/oauth2/*`. The
`SPFN_AUTH_NAVER_CLIENT_ID` you already have is accepted as the audience — one Naver application
has a single client ID covering its web and app environments — so
`SPFN_AUTH_NAVER_NATIVE_CLIENT_IDS` is only needed when the app registers a separate application.

Naver's native SDK cannot produce an id_token: it is pinned to `/oauth2.0/*` and its authorize
request has no `scope` parameter at all. The app therefore obtains the id_token through a browser
flow (`ASWebAuthenticationSession` / Custom Tab) against `/oauth2/authorize?scope=openid` with PKCE
— `token_endpoint_auth_methods_supported` includes `none`, so no client secret is needed. The
server contract is the same whichever way the token was obtained.

The id_token carries `iss`, `aud`, `azp`, `sub`, `nonce`, `jti`, `iat`, `exp` — no email, no name,
no picture, even when the application marks email as required. Send `accessToken` to fill it: the
server reads `/v1/nid/me`, whose `id` is the same pairwise value as the id_token's `sub`, and
treats a returned address as verified (the same rule the web flow uses). `sub` being pairwise helps
here — a token from another application resolves to a different `sub` and is rejected by the match.

That verified verdict rests on one fact and it is worth stating plainly, because `createOrLinkUser`
links a social identity to an existing account on a verified address alone. The `/v1/nid/me`
response carries **no** verification flag — unlike Kakao, which reports `is_email_valid` and
`is_email_verified` and is checked against both. What Naver guarantees instead is at change time:
moving the contact email requires a code sent to the new address, so the returned value is an
address the user has proven they control. It is **not** a stable identifier: the user can change it,
one address can be shared by up to six Naver IDs, and it may be absent entirely. `providerUserId` is
the only key that identifies the account.

```typescript
await authApi.oauthNative.call({
    params: { provider: 'naver' },
    body: { idToken, nonce, accessToken, publicKey, keyId, fingerprint, algorithm: 'ES256' },
});
```

Without `accessToken` a Naver sign-in has no email at all, so every user is created fresh and never
links to an existing account.

### Custom providers

Implement `OAuthProvider` and register it. `SOCIAL_PROVIDERS` is `['google','apple','github','kakao','naver','superself']`. Implement the optional `verifyNativeIdToken(idToken, { nonce })` to support native id_token sign-in.

```typescript
import {
    registerOAuthProvider, getOAuthProvider, getRegisteredProviders,
    oauthCallbackService,
    type OAuthProvider, type NormalizedIdentity, type OAuthTokens,
} from '@spfn/auth/server';

registerOAuthProvider(myProvider);   // same id re-registers (override)
```

### OAuth token encryption and key rotation

Web OAuth access and refresh tokens are encrypted at rest with AES-256-GCM. Token encryption is
separate from session-cookie encryption: `SPFN_AUTH_TOKEN_ENCRYPTION_KEYS` is backend-only and
must never be exposed to the Next.js process. Generate a key with `openssl rand -base64 32` and
assign it a non-secret key ID:

```dotenv
SPFN_AUTH_TOKEN_ENCRYPTION_KEYS=v2:<base64-32-byte-key>
```

For zero-downtime rotation, prepend the new key and retain old keys for decryption:

```dotenv
SPFN_AUTH_TOKEN_ENCRYPTION_KEYS=v3:<new-key>,v2:<old-key>
```

New writes use the first key. Reads using an older key, the legacy session-secret-derived `enc:v1`
format, or historical plaintext are automatically re-encrypted with the active key. Keep every old
key available until all rows have been read or explicitly migrated; removing a referenced key makes
those tokens undecryptable. Ciphertext is bound to `provider`, `providerUserId`, and token type
(`access` or `refresh`) with authenticated data, preventing ciphertext from being moved to another
account or field.

Deployments that need a KMS or per-account envelope encryption can call
`configureOAuthTokenCipher()` from `@spfn/auth/server` before the server starts. The custom cipher
receives the same account/token context and owns its key rotation policy.

**Integration contract for custom providers:**

- The built-in provider-generic callback route handles any registered provider. A custom callback is
  only needed when the provider does not follow the standard `code` / `state` response contract.
- If a custom callback calls `oauthCallbackService()` directly, wrap the route in `Transactional()`
  (`import { Transactional } from '@spfn/core/db'`).
- The provider `id` must be in `SOCIAL_PROVIDERS` (`enumText`, plain text — adding a value needs **no**
  DB migration).
- `auth.login` / `auth.register` events now carry any `SOCIAL_PROVIDERS` value in `provider` —
  update any `switch(provider)` in subscribers.

## How do I read the session in a Next.js page?

Sessions are HttpOnly cookies encrypted with `SPFN_AUTH_SESSION_SECRET` (JWE), holding the
client private key + `keyId` (`SessionData`: `{ userId, privateKey, keyId, algorithm }`). The
interceptor reads them to sign outbound RPC JWTs. From `@spfn/auth/nextjs/server`:

```typescript
import { saveSession, getSession, clearSession } from '@spfn/auth/nextjs/server';

await saveSession({ userId: '123', privateKey: '...', keyId: 'uuid', algorithm: 'ES256' });
const session = await getSession();   // read-only, safe in Server Components
await clearSession();
```

RSC guards (redirect when unmet) — `RequireAuth`, `RequireRole`, `RequirePermission`:

```tsx
import { RequireAuth, RequireRole } from '@spfn/auth/nextjs/server';

export default async function AdminPage()
{
    return (
        <RequireAuth redirectTo="/login">
            <RequireRole roles={['admin', 'superadmin']} redirectTo="/forbidden">
                <Dashboard />
            </RequireRole>
        </RequireAuth>
    );
}
```

Also exported: `getAuthSessionData`, `getUserRole`, `getUserPermissions`, `hasAnyRole`,
`hasAnyPermission`, the OAuth pending-session helpers, and `createOAuthCallbackHandler`.

## How do I define roles and permissions?

Built-in roles: `superadmin` (priority 100), `admin` (80), `user` (10). Built-in permissions:
`auth:self:manage`, `user:read|write|delete|invite`, `rbac:role:manage`, `rbac:permission:manage`.
Custom roles/permissions are declared on the lifecycle (preferred — runs on startup) or via
`initializeAuth(options)`.

```typescript
createAuthLifecycle({
    roles: [{ name: 'editor', displayName: 'Editor', priority: 30 }],
    permissions: [{ name: 'post:publish', displayName: 'Publish Posts', category: 'content' }],
    rolePermissions: { editor: ['post:publish'] },
});
```

Programmatic checks (server): `hasPermission`, `hasAnyPermission`, `hasAllPermissions`, `hasRole`,
`hasAnyRole`, `getUserRole`, `getUserPermissions`. Runtime role admin: `createRole`, `updateRole`,
`deleteRole`, `setRolePermissions`, `addPermissionToRole`, `removePermissionFromRole`,
`getAllRoles`, `getRoleByName`, `getRolePermissions`.

## Can I operate the app without building an admin dashboard?

Yes, and that is the point of the operator half of this package. The day after you deploy,
someone has to refund an order, look up a user, publish a change, retry a failed job. The
usual answer is to build screens for each of those. SPFN's answer is to expose those
operations to an agent instead, and there are two transports for that:

- **CLI-first (the default)**: develop ops as routes with
  [`createOpsRouter`](../core/README.md#how-do-i-operate-the-app-from-the-terminal),
  authenticate them with [ops tokens](#ops-tokens-spfn-ops), and drive them with
  `spfn ops` from the same terminal the app was built in.
- **MCP**: [`@spfn/mcp`](../mcp/README.md) turns operations into tools a chat client's
  agent can run — the fit when operators work outside a terminal.

`@spfn/auth` already knows who your operators are and which of them may do what; the MCP
wiring below shows how those answers reach `@spfn/mcp`.

The connection is app code, deliberately. `@spfn/mcp` does not read this package's RBAC on
its own — it asks you for a `validateToken` and a `listTools`, and those are where auth's
answers go:

```typescript
import { createMcpRoute } from '@spfn/mcp/server';
import { hasPermission, getUserRole } from '@spfn/auth/server';

// one required permission per tool — the same permission names your routes check
const allTools = [
    { name: 'orders.refund',   permission: 'order:refund',   /* … */ },
    { name: 'content.publish', permission: 'post:publish',   /* … */ },
];

export const mcpRouter = createMcpRoute({
    appUrl: 'https://app.example.com',
    serverInfo: { name: 'example-app', version: '1.0.0' },

    validateToken: async (token, resource) => verifyAccessToken(token, resource),

    resolveContext: async (auth) => ({
        userId: auth.userId,
        role: await getUserRole(auth.userId),
    }),

    listTools: async (ctx) =>
    {
        const allowed = await Promise.all(
            allTools.map(t => hasPermission(ctx.userId, t.permission)),
        );

        return allTools.filter((_, i) => allowed[i]);
    },
});
```

Two rules keep this safe. **Expose operations, not tables** — `orders.refund` carries an
authorization rule; a generic `db.query` carries none. And **check the permission inside
the handler too**, not only in `listTools`: hiding a tool from the list is discovery
control, not authorization.

## Events

`@spfn/auth` emits decoupled events (via `@spfn/core/event`). Subscribe for welcome emails,
analytics, onboarding, etc. Client-supplied `metadata` on register/OAuth flows is forwarded verbatim.

```typescript
import { authLoginEvent, authRegisterEvent, invitationCreatedEvent, invitationAcceptedEvent } from '@spfn/auth/server';

authRegisterEvent.subscribe(async ({ userId, email, provider, metadata }) =>
{
    if (email) await sendWelcome(email);
});
```

Payload types: `AuthLoginPayload`, `AuthRegisterPayload`, `InvitationCreatedPayload`,
`InvitationAcceptedPayload`, `AuthDeletionRequestedPayload`, `AuthDeletionCancelledPayload`,
`AuthDeletionCompletedPayload`, `OAuthUnlinkedPayload` (`auth.oauth.unlinked` — provider-side
disconnect, see the OAuth unlink-notify section). These events also bind to `@spfn/core/job`
jobs via `.on(event)`.

## Registration gate (`beforeRegister`)

Events fire *after* the user exists — they cannot reject a registration. For server-enforced
signup policy (age gate, invite-only domains, block lists) inject a validator with
`configureAuth`; it runs **before the user row is created** on every registration channel:
`credentials` (email/phone register), `oauth` (new-user social signup, web + native), and
`invitation` (acceptance). Throwing rejects the registration; `RegistrationRejectedError` (403)
is the recommended error. The hook receives the same `metadata` the app supplied to
`register` / OAuth start / the invitation — never credentials.

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

Notes:
- Runs after built-in checks (verification token, duplicate account) — existing error
  precedence is unchanged, and the hook cannot be probed without a valid verification token.
- Not called when an OAuth login links a social account to an existing user, nor for admin
  seeding in `initializeAuth()`.
- OAuth signups have no client-typed fields unless you pass `metadata` at OAuth start — decide
  per channel (reject, or allow and collect during onboarding).
- On the `oauth` channel `email` is the provider-reported address and may be **unverified**
  (the created account then stores `email` as `null`). The context carries
  `emailVerified` — an email-based allow/block policy must check it before trusting `email`.
- The hook runs **inside the registration DB transaction** on every channel — keep it fast.
  A slow call (e.g. an external policy API) holds a pooled DB connection open per signup.
- On the **web** OAuth flow a rejection surfaces as the standard OAuth error redirect
  (302 to the app's OAuth error URL, message only) — not a 403 JSON response. The native
  OAuth flow, credentials, and invitation channels return the error status (403) directly.

## One-Time Token

For short-lived authenticated handshakes (e.g. SSE) where a `Bearer` header is awkward: issue
with `authApi.issueOneTimeToken`, protect the consuming route with the `oneTimeTokenAuth`
middleware. Call `initOneTimeTokenManager({ ttl, store })` during setup for a custom TTL/store.

## Ops tokens (`spfn ops`)

The machine credential behind the CLI-first ops surface
([`@spfn/core/ops`](../core/README.md#how-do-i-operate-the-app-from-the-terminal)). An ops
token is not a user session: it carries a label and a scope list, only its SHA-256 hash is
stored, and the secret is shown exactly once at issuance.

```typescript
// src/server/ops.ts — the app develops its own ops as routes
import { createOpsRouter, opsRoute } from '@spfn/core/ops';
import { opsTokenAuth, requireOpsScope } from '@spfn/auth/server';

export const opsRouter = createOpsRouter({
    listSignups: opsRoute.get('/signups')
        .use([requireOpsScope('waitlist:read')])
        .handler(async () => signupsRepository.list()),
}, { auth: opsTokenAuth });
```

`opsRoute` comes from `@spfn/core` **0.3.0-beta.2** onwards; before that release an ops
route spelled its own `/_ops/` prefix with `route`.

Issue and manage tokens where database access already exists — a deployed app carries **no
token-creation endpoint**:

```bash
spfn ops token issue --name laptop --scopes 'waitlist:read'   # secret printed once
spfn ops token issue --name laptop --scopes '*' --to-keychain --app https://api.example.com
spfn ops token list
spfn ops token revoke 3
```

Verification refuses uniformly: an expired, revoked, or never-issued token all answer the
same 401, so whether a presented secret ever existed is not inferable. A valid token
missing a route's scope answers 403 naming only the missing scope. `'*'` grants every
scope.

## Mobile clientProofV1 (`@spfn/auth/client-proof`)

Server side of the spfn-mobile native SDK auth profile (issue #46; asymmetric revision in
contract 0.2.0). Implements the pinned mobile contract exactly: SPFN-CANON-JSON-1 canonical
JSON (custom parser/encoder — int64 via BigInt, duplicate-key rejection, UTF-8 byte key
order), SPFN-PROOF-INPUT-1 proof assembly with ECDSA P-256 + SHA-256 signature verification
(wire form: raw `r‖s`, 64 bytes, base16-lower; DER is rejected, low-S is not required — the
nonce + replay window own uniqueness), the contract admission order (revoked → session →
expired → replayed → signature; a nonce is spent only on admission), in-memory session
issuance/expiry, and
the fixed-string contract error envelope (`PROOF_INVALID` · `PROOF_REPLAYED` · `PROOF_EXPIRED` ·
`SESSION_REVOKED` · `PROFILE_REJECTED` · `CONTRACT_UNSUPPORTED` — SDKs classify by code, never
HTTP status).

- Wire headers (D23, ratified): `x-spfn-auth-profile`, `x-spfn-client-id`, `x-spfn-key-id`,
  `x-spfn-nonce`, `x-spfn-issued-at`, `x-spfn-proof`, `x-spfn-session`.
- A request body must be **byte-canonical** — a body that parses but re-encodes differently is
  refused even when its proof verifies (the proof binds the received bytes).
- `createClientProofDevHandler(...)` — framework-free `fetch(Request) → Response` dev surface
  with the three contract operations and the `/control` test hooks the spfn-mobile integration
  suites drive (`examples/04-mobile-contract-dev` is the runnable wiring).
- `createClientProofGuard(state)` — Hono middleware for mounting `requiresSession` operations
  on an SPFN server; tags admitted requests `clientType: 'mobile'` (the attestation slot
  proxy-guard reserved). hono is a type-only import here.
- A refusal is **answered**, never thrown: `authenticate` / `optionalAuth` answer a request that
  named this profile with the canonical envelope (`error.code` is one of the six codes, and the
  body carries nothing else), and the guard and dev handler do the same. Handing the refusal to
  the generic error handler instead would put the carrying error class's name in `error.code`
  (`UnauthorizedError`) — a code no generated SDK can classify (#106). Errors raised **after**
  admission (account status, application errors) are ordinary SPFN errors and keep the REST
  envelope.
- Replay ledger is module-local, NOT core's `NonceStore` — `checkAndSet` records on check,
  which would spend a nonce on a refused request; the contract requires spending only on
  admission.
- Conformance: spfn-mobile fixtures are vendored under
  `src/server/client-proof/__tests__/fixtures/` (digest-pinned to upstream `MANIFEST.json`,
  dev bundle sha256 `07fd8268…a433e45`) and run in the unit suite.
- Dev/test scope: public keys (SPKI DER base64, keyed by `x-spfn-key-id`) are registered at
  construction or through the `/control/register-key` hook; the private half never reaches
  the server. No persistence — a production enrollment/rotation story is phase 2.

### The contract version on the wire (contract 0.6.0)

A client compiled and shipped separately from the server cannot be fixed by redeploying. Until
0.6.0 a mismatch between what that client was generated against and what the server serves
surfaced as an undecodable body: the app looked broken and nothing said why.

Both ends now say what they are.

| Header | Direction | Sent by |
|--------|-----------|---------|
| `x-spfn-client-kind` | request | every client — `web`, `ios` or `android` |
| `x-spfn-client-version` | request | the client's own release: a store version, or a bundle build |
| `x-spfn-client-contract-version` | request | `ios` and `android` only |
| `x-spfn-server-contract-version` | response | the server, on every response including a refusal |
| `x-spfn-supported-contract-range` | response | the server, likewise |

```typescript
import { createClientVersionMiddleware } from '@spfn/auth/client-proof';

// Mount before authentication: enrollment and login carry no proof, and they are
// where a stale client arrives first.
app.use('*', createClientVersionMiddleware());
```

- **`web` states no contract version**, because a browser bundle is deployed with the server that
  serves it and has no second version to reconcile. It is exempt by construction, not by leniency.
- **An `ios` or `android` client that states no contract version, or one outside the range, is
  refused** `CONTRACT_UNSUPPORTED` (409) with the usual envelope.
- **A request naming no kind passes** — a curl, a health probe, a server-to-server call is not a
  deployed client this rule is about.
- **None of it enters the proof input.** These are diagnostic; `PROOF_INPUT_FIELDS` is unchanged.
- **The server states facts and stops there.** Comparing the announced range against its own version
  and deciding a user should see an update prompt is the client's judgment, made in the client. The
  server has no way to make an app update and does not pretend to.

Response header names are deliberately distinct from the request ones: a proxy that echoes a request
header into the response would otherwise make the client's own version look like the server's.

### When each operation became available (contract 0.6.1)

Every operation in the exported bundle carries `since` — the contract version it first appeared in.
`deprecatedIn` and `removedIn` are optional and absent today, because nothing has been deprecated.

| Operation | `since` |
|-----------|---------|
| `auth.clientProof.handshake`, `echo.send`, `items.list` | 0.1.0 |
| `auth.enroll.register`, `auth.enroll.login`, `auth.enroll.oauthNative`, `auth.keys.rotate` | 0.3.0 |
| `auth.keys.list`, `auth.keys.revoke`, `auth.keys.revokeAll` | 0.4.1 |

- **This is history, not policy.** The mobile contract's compatibility policy is `allOrNothing`: one
  contract version passes or refuses the whole surface, so these three fields change no verdict here.
  An app contract generated from SPFN routes decides `perOperation` and reads the same fields as an
  input — the shape is shared so the two never diverge.
- **A removal is mark, then wait, then remove.** `deprecatedIn` in one version with the operation
  still served, `removedIn` in a later one. Nothing is removed in the version that deprecates it.
- **A removed operation leaves the operations list**, so no entry carries `removedIn` today. It is
  where the fact gets recorded when the first removal happens.

### Usage — dev surface (mobile integration target)

The fastest path: run the packaged dev handler, which already serves the three contract
operations and `/control`. `examples/04-mobile-contract-dev` is exactly this, runnable.

```typescript
import { serve } from '@hono/node-server';
import { createClientProofDevHandler } from '@spfn/auth/client-proof';

const handler = createClientProofDevHandler({
    // keyId → registered public key (SPKI DER base64); the private key stays on the client
    publicKeys: { 'key-dev-0001': process.env.SPFN_CLIENT_PROOF_PUBLIC_KEY! },
    sessionTtlMillis: 600_000,
});
serve({ fetch: handler.fetch, port: 8791, hostname: '127.0.0.1' });
// handler.controlToken — pass to the test harness for /control routes
// handler.state       — revokeKey() / expireSessions() / stats() from code
```

### Usage — mounting on your own Hono/SPFN server

Protect `requiresSession` operations with the guard, and assemble the handshake route from
the exported primitives (`admitClientProofRequest` + `state.openSession`):

```typescript
import { Hono } from 'hono';
import {
    ClientProofState, createClientProofGuard, admitClientProofRequest,
    decodeHandshakeRequest, encodeHandshakeResponse, encodeCanonicalJson,
    ClientProofRefusal, newHexId,
} from '@spfn/auth/client-proof';

const state = new ClientProofState({ publicKeys: { 'key-dev-0001': process.env.SPFN_CLIENT_PROOF_PUBLIC_KEY! } });
const app = new Hono();

app.post('/v1/auth/client-proof/handshake', async (c) =>
{
    const body = new Uint8Array(await c.req.arrayBuffer());
    const admission = admitClientProofRequest({
        state, headers: c.req.raw.headers, method: 'POST',
        path: '/v1/auth/client-proof/handshake', requiresSession: false, body,
    });
    if (!admission.admitted)
    {
        return c.newResponse(admission.refusal.envelopeBytes(newHexId()).slice().buffer,
            admission.refusal.httpStatus as 401, { 'content-type': 'application/json' });
    }
    const request = decodeHandshakeRequest(admission.value);
    const opened = state.openSession(request.clientId, request.keyId);
    return c.newResponse(
        encodeCanonicalJson(encodeHandshakeResponse(opened.sessionId, BigInt(opened.expiresAtMillis))).slice().buffer,
        200, { 'content-type': 'application/json' });
});

// Any route behind the guard sees clientType='mobile' and c.get('clientProof')
app.post('/v1/echo', createClientProofGuard(state), (c) => { /* handler */ });
```

Responses and errors MUST be canonical bytes with the contract envelope — build them with
`encodeCanonicalJson`/`ClientProofRefusal`, never `c.json()` (key order and int64 differ).

## Account Deletion & Recovery

Grace-period deletion with in-window recovery, an admin/GDPR-response entry point for immediate
purge, and a pluggable app-data cleanup hook. Not covered by this feature: re-signup email
blind-index/hashing (a purged account's email becomes reusable immediately — see the project's
PII protection track for blind-index re-signup prevention), backup beyond-use handling, DSR
intake/response workflows, and webhook fan-out — those are app/ops concerns.

```
active ──request (re-auth)──> pending_deletion ──grace period elapses (cron)──> deleted (anonymize) | row removed (hard-delete)
  ^                                  │
  └───────────cancel (re-auth)───────┘        immediate = grace period of 0, same pipeline
```

- **Request** — `POST /_auth/deletion/request` (authenticated). Step-up re-auth: password
  holders confirm with `password`; OAuth-only/passwordless accounts confirm with a
  `verificationToken` from `/_auth/codes` + `/_auth/codes/verify` (`purpose: 'account_deletion'`).
  On success: status → `pending_deletion`, every active session key is revoked, a
  `account_deletion_requests` audit row is created, `auth.deletion.requested` fires, and (if
  the user has an email and `sendNotifications` is on) a notice is sent with the scheduled purge
  date.
- **Login is blocked while pending** — password login, OAuth login, and the `authenticate`
  middleware all reject a `pending_deletion` account with `AccountPendingDeletionError` (403,
  `details.purgeScheduledAt`) instead of the generic `AccountDisabledError`, so the client can
  show a recovery prompt.
- **Cancel (recovery)** — `POST /_auth/deletion/cancel` (public — sessions were revoked at
  request time, so there's no Bearer token to authenticate with). Credential-based: email/phone
  plus `password` or a fresh `verificationToken`. On success, status → `active`; the user still
  needs to log in separately afterward.
- **Purge job** — sweeps `account_deletion_requests` for rows past their grace period and
  destroys the account. Register it explicitly (see below); it is **not** wired up by
  `createAuthLifecycle()` automatically.
- **Admin / GDPR-response entry points** — `requestAccountDeletionService(userId, { requestedBy: 'admin', immediate })`
  and `purgeUserService(userId)` are exported for app-side admin routes / DSR handling; the app
  owns the route and its authorization.

```typescript
import { defineServerConfig } from '@spfn/core/server';
import { createAuthLifecycle, authJobRouter } from '@spfn/auth/server';

export default defineServerConfig()
    .lifecycle(createAuthLifecycle({
        deletion: {
            gracePeriodDays: 30,               // default; 0 = immediate
            purgeStrategy: 'anonymize',        // default; or 'hard-delete'
            allowSelfImmediate: false,         // default; self-service immediate: true
            sendNotifications: true,           // default
            onBeforePurge: async (user) =>
            {
                // throw to skip this user for the current sweep (retried next run)
                await appDataCleanup(user.id);
            },
        },
    }))
    .jobs(authJobRouter)   // registers the daily (04:00 UTC) purge sweep
    .routes(appRouter)
    .build();
```

**Purge strategies:**

- `anonymize` (default) — scrubs PII, keeps the row: `email` → `deleted-{publicId}@deleted.invalid`,
  `phone`/`username`/`passwordHash` → `null`, `status` → `'deleted'`, `deletedAt`/`deletedBy` set
  (`softDelete()` on `users`). Social accounts and public keys are deleted (frees the provider
  link and revokes access), the profile's PII columns are cleared, and any leftover verification
  codes for the original email/phone are removed. The freed email/phone can be re-registered
  immediately.
- `hard-delete` — physically removes the `users` row; child rows (`user_profiles`,
  `user_public_keys`, `user_social_accounts`, `user_permissions`) cascade-delete via their FK.
  The `account_deletion_requests` audit row survives either strategy — its `userId` FK is
  `set null` (not cascade), by design, so "who requested/purged what, when" outlives the user row.

The final "your account has been deleted" notice is sent **after** the purge transaction commits
(never before, and never on a purge that aborted or rolled back — see below), using the address
captured before the destructive step ran. This holds for `hard-delete` too: the row is already
gone by send time, but the address was captured beforehand, so the notice still goes out.

**Concurrency.** The purge job re-verifies the user is still `pending_deletion` on the write
primary immediately before any destructive DML, inside the same transaction as the DML itself —
closing the window between a stale read (the sweep's own batch, or replica lag) and a concurrent
`cancel`. The `account_deletion_requests` claim (`markCompleted`) is a conditional `UPDATE ...
WHERE status = 'pending'`; if a concurrent cancel already moved the row off `pending`, the claim
matches zero rows and the purge aborts with no destructive DML and no overwritten audit row.

**Cron schedule caveat.** `deletion.purgeCron` (default `0 4 * * *`) is stored for reference, but
the static `authJobRouter` export above always runs on the *default* cron — `job(...).cron(...)`
is fixed at module-import time, which happens before `createAuthLifecycle()` runs in your
`server.config.ts`. For a non-default schedule, build the router yourself, after the
`createAuthLifecycle()` call, and register that instead:

```typescript
import { createAuthDeletionJobRouter } from '@spfn/auth/server';

// ... after .lifecycle(createAuthLifecycle({ deletion: { purgeCron: '0 3 * * *' } }))
.jobs(createAuthDeletionJobRouter({ purgeCron: '0 3 * * *' }))
```

Register **only one** of `authJobRouter` / `createAuthDeletionJobRouter(...)` — both build a job
named `auth.deletion.purge`, so registering both (e.g. the static export *and* a custom-cron
router) double-registers the same job name against pg-boss instead of overriding it.

## FAQ

**How do I add one social provider?**
Set its two environment variables. Google, GitHub, Kakao and Naver each turn on when their
client ID and secret are both present — there is no separate registration step. Then
register the callback URL in that provider's console, and read the next answer before you
deploy.

**Social login worked locally and broke after deploying. Why?**
Almost always the callback origin. The CSRF check is a double-submit against a host-only
cookie set on your **web app** host, so the provider must return to the web app origin, and
the app must forward `/_auth/*` to the API with a Next.js rewrite. Without that rewrite the
callback 404s — including in local dev. Details in
[OAuth callback origin](#oauth-callback-origin-web-app-host--rewrite).

**Does the server hold my users' private keys?**
No. The client generates an ES256/RS256 keypair, sends only the public key on register or
login, and signs each request itself. The server verifies with the stored public key. Keys
expire after 90 days; `rotateKey` renews one.

**Does signing in on a new device sign the old one out?**
No, and that is on purpose — keys are per-device and accumulate. `listKeys` shows the
account owner what accumulated, `revokeKey` cuts one off, `revokeAllKeys` cuts off
everything but the caller.

**How long does a session last?**
`SPFN_AUTH_SESSION_TTL`, seven days by default. It accepts `7d`, `12h`, `45m`.

**Is account deletion immediate?**
No. A request moves the account to `pending_deletion`, revokes every session key, and
schedules the purge for 30 days later by default. The user can cancel with their
credentials during that window. Two things need your attention: the purge sweep is a job
you register explicitly (`.jobs(authJobRouter)`), and a purged account's email becomes
reusable immediately. See [Account Deletion & Recovery](#account-deletion--recovery).

**Can an admin delete a user's account?**
Yes, through `requestAccountDeletionService(userId, { requestedBy: 'admin', immediate })`
and `purgeUserService(userId)`. The package exports the services; you own the route and its
authorization.

**Where do my admin accounts come from?**
The environment, seeded on startup by `createAuthLifecycle()`. Seeded accounts are email
verified, active, and required to change their password on first login.

## Pitfalls & anti-patterns

- **"relation \"auth.users\" does not exist" — tables come from bundled migrations, not push.**
  Package schemas are excluded from `spfn db push`'s diff; the `auth.*` tables are created by the
  migration files shipped in this package. Run `pnpm spfn db migrate` (state check:
  `pnpm spfn db status`). Installing via plain `pnpm add @spfn/auth` runs no migration — only
  `spfn add @spfn/auth` auto-applies them.
- **Wrong entry point.** `@spfn/auth/server` and `@spfn/auth/nextjs/*` are server-only (Node /
  `server-only`). Importing them in a client component breaks the build. Entities, services, and
  repositories are on `/server`, not on root `@spfn/auth`.
- **No `app.bind(contract, ...)`.** That contract pattern is removed. Use the route DSL
  (`route.get().handler()` + `defineRouter`). Any docs/snippets using `app.bind` are stale.
- **Custom error classes must be registered.** Add them to an `ErrorRegistry` (mirror
  `authErrorRegistry` in `src/errors/index.ts`) and pass it to your `createApi({ errorRegistry })`,
  or the client receives a generic error instead of the typed one.
- **Two env files, by audience.** `SPFN_AUTH_SESSION_SECRET` lives in `.env.local` (Next.js needs
  it for cookie crypto); `SPFN_AUTH_VERIFICATION_TOKEN_SECRET` and
  `SPFN_AUTH_TOKEN_ENCRYPTION_KEYS` live in `.env.server`. Token encryption keys are backend-only;
  putting them in `.env.local` unnecessarily gives the Next.js process token-decryption authority.
- **`SPFN_AUTH_SESSION_SECRET` is validated.** Minimum 32 chars plus entropy/unique-char checks —
  a short or low-entropy value fails startup, not just a warning.
- **Forgetting the interceptor import.** Without `import '@spfn/auth/nextjs/api'` in the RPC proxy
  route, the client sends no `Authorization` header and every protected call 401s. The
  `authenticate` middleware error message points here.
- **Custom OAuth callback without `Transactional()`.** A failure mid-callback leaves an orphan
  user. Always wrap the callback route in `Transactional()` and call `oauthCallbackService`.
- **`sideEffects: false` tree-shakes the google provider.** The built-in provider self-registers
  via a module side-effect; an aggressive bundler config can drop it. Don't mark this package's
  imports side-effect-free.
- **Public routes need an explicit opt-out.** With global `authenticate`, any route without
  `.skip(['auth'])` (or `optionalAuth`, which auto-skips) requires a valid token.
- **`SOCIAL_PROVIDERS` is plain `enumText`.** Adding a provider value needs no DB migration, but
  every `switch(provider)` over login/register events must handle the new value.
- **Email/SMS is not here.** It moved to `@spfn/notification` (`import { sendEmail, sendSMS } from
  '@spfn/notification/server'`). Wire verification-code / invitation emails through its events.
- **`authJobRouter` isn't registered for you.** `createAuthLifecycle()`'s `afterInfrastructure`
  hook runs *before* `@spfn/core` initializes pg-boss and registers jobs, so the lifecycle has no
  opportunity to auto-register the account-deletion purge job. Call `.jobs(authJobRouter)`
  yourself — see [Account Deletion & Recovery](#account-deletion--recovery).
- **`USER_STATUSES` gained `pending_deletion` / `deleted`.** Any code with a `switch(user.status)`
  or an exhaustive status union must handle both — `enumText` is plain `text` with no DB `CHECK`,
  so nothing enforces this at the database layer.

## Complete example

```typescript
// server.config.ts
import { defineServerConfig } from '@spfn/core/server';
import { createAuthLifecycle } from '@spfn/auth/server';
import { appRouter } from './router';

export default defineServerConfig()
    .port(8790)
    .routes(appRouter)
    .lifecycle(createAuthLifecycle({
        roles: [{ name: 'editor', displayName: 'Editor', priority: 30 }],
        permissions: [{ name: 'post:publish', displayName: 'Publish Posts', category: 'content' }],
        rolePermissions: { editor: ['post:publish'] },
    }))
    .build();

// router.ts
import { defineRouter } from '@spfn/core/route';
import { authRouter, authenticate } from '@spfn/auth/server';
import { getMe } from './routes/me';

export const appRouter = defineRouter({ getMe })
    .packages([authRouter])
    .use([authenticate]);
export type AppRouter = typeof appRouter;

// app/api/rpc/[routeName]/route.ts
import '@spfn/auth/nextjs/api';
import { createRpcProxy } from '@spfn/core/nextjs/server';
import { authRouteMap } from '@spfn/auth';
import { routeMap } from '@/generated/route-map';
export const { GET, POST } = createRpcProxy({ routeMap: { ...routeMap, ...authRouteMap } });

// any client component
import { authApi } from '@spfn/auth';
const session = await authApi.getAuthSession.call({});
```

## Related

- [`@spfn/core`](../core/README.md) — route DSL (`route`, `defineRouter`), `createApi`, env
  (`@spfn/core/env`), errors (`ErrorRegistry`), db (`Transactional`), events, jobs.
- [`@spfn/mcp`](../mcp/README.md) — exposes operations as MCP tools, so the operator half of
  this package needs no admin dashboard.
- `@spfn/notification` — email/SMS/push (verification codes, invitation emails).
- Full guide: `docs/guides/authentication.md`.
