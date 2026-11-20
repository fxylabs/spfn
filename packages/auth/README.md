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
does. Write those operations as ops routes instead and run them with `spfn ops`, behind the
[ops tokens](#ops-tokens-spfn-ops) this package issues — or attach
[`@spfn/mcp`](../mcp/README.md) and write them as MCP tools an AI agent in a chat client runs,
gated by the same roles. See
[Can I operate the app without building an admin dashboard?](#can-i-operate-the-app-without-building-an-admin-dashboard).

Underneath: asymmetric client-signed JWTs (ES256/RS256), OTP verification, OAuth 2.0
through a pluggable provider registry (Google, Apple, GitHub, Kakao and Naver built in), session
cookies for Next.js, and runtime RBAC. Routes mount under `/_auth/*` and are reached
through a typed `authApi` client. Requires `@spfn/core`; Next.js is an optional peer
(`^16.4.5`).

## Install

```bash
pnpm add @spfn/auth drizzle-orm@1.0.0-rc.4
```

Requires `@spfn/core` **0.3.0-beta.18** or later — the guards bound their session lookup with its
per-call `.timeout()`, and the OAuth callback page uses its CSRF helpers.

`hono` is a peer as well, in the range `@spfn/core` depends on (`^4.13.16`): the
[second-factor policy](#requiring-a-second-factor-secondfactor) reads which route a request matched,
and only the copy of Hono that built the request can say. A process with two copies — the install
resolves a different `hono` for this package than for `@spfn/core`, or one `hono` is loaded in two
module formats (an app run as CommonJS beside an ESM server; `@spfn/core` refuses that boot) — is
refused, not served, where the policy would read a route: with `secondFactor.required: true` —
the only setting that makes an enrolment-only account — `createAuthLifecycle()`'s `afterRoutes`
refuses to boot an app built by another copy. Wherever an enrolment-only session's request reaches
the gate on another copy (a custom `app.ts`, where that hook does not run), it answers **500** with a
logged error naming the two copies. Without a required second factor nothing reads a route, and the
app boots as before. `pnpm why hono` should show one version.

> **BREAKING.** This used to answer an enrolment-only session 403 `SECOND_FACTOR_ENROLMENT_REQUIRED`
> on every route, enrolment routes included — a broken process that read as policy. An app that
> boots today has one copy and sees no change; one that had two and requires a second factor now
> fails at boot (or with a 500) and names the cause.

`@simplewebauthn/server` and `@simplewebauthn/browser` come along as dependencies —
[passkeys](#passkeys-webauthn) need them, and standards conformance is the whole risk there.
The browser half is bundled into the `./client` entry rather than marked external, so nothing
in your app has to know about it.

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
import { getStatus } from './routes/status';

export const appRouter = defineRouter({
    getStatus,
    // ...your routes
})
    .packages([authRouter])   // mounts /_auth/* and exposes routes on authApi
    .use([authenticate]);     // global auth middleware

export type AppRouter = typeof appRouter;
```

A replacement authenticator may sit on a **nested router** instead of on each route. Every
middleware of this package that stands in for `authenticate` declares `skips: ['auth']`
(`optionalAuth`, `machineAuth`, `signedTokenAuth(...)`, `opsTokenAuth`, `opsOrUser(...)`,
`oneTimeTokenAuth`, `oauthFinalizeAuth`, `authenticateForSignOut`, `authenticateForRenewal`), and core honours
that on a router's `.use()` too: the router's routes run it in place of the inherited `auth`.
So `defineRouter({ ... }).use([machineAuth])` nested under the router above is a machine-only
subtree, and **router-level `optionalAuth` makes the whole subtree optional — anonymous callers
reach every route in it.** A route that `.skip(['machineAuth'])`s gets `auth` back. Registration
refuses such a middleware at or above `authRouter` — in `authRouter.use([...])` itself, on the
router that mounts `.packages([authRouter])`, one enclosing it, or one holding `authRouter` as a
plain entry (`authRouter` is defined with `packageName: '@spfn/auth'`): `/_auth/*` routes rely on
the inherited `auth`. Mount it with `.packages()`; as a plain entry it is served at the same paths,
but its routes become the app's own to `AppRouter` and the route map. See core's route README,
"Skipping & auto-skip".

### 3. Next.js interceptor — RPC proxy route

The interceptor handles session cookies, JWT signing, and key management automatically.
Import it for its side-effect (it self-registers); it must run before the proxy is created.

```typescript
// app/api/rpc/[routeName]/route.ts
import '@spfn/auth/nextjs/api';        // side-effect: registers auth interceptors
import { createRpcProxy } from '@spfn/core/nextjs/server';
import { routeMap } from '@/generated/route-map';

export const { GET, POST } = createRpcProxy({ routeMap });
```

No auth route map is merged: the generated `routeMap` carries the routes of every package
router the app router mounts with `.packages()`, `authRouter`'s included. `authRouteMap` is
still exported and `{ ...routeMap, ...authRouteMap }` is still harmless — the two hold the
same entries — but it is a no-op.

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

### How do I give the auth client my own hooks?

Build it with `createAuthApi(config)`. It takes `createApi`'s configuration — `onOutcome`,
`onRequest`, `onResponse`, `timeout`, `fetch`, `errorRegistry`, … — and returns the same typed
client as `authApi`, which is simply `createAuthApi()`.

- **Auth's error registry is always added, last.** The registry keys classes by name and a
  later registration wins, so an auth error body is restored as the auth class even when one
  of your classes carries the same name.
- **`errorRegistry` takes an array.** `createApi` merges its core errors (`NotFoundError`, …)
  into an array, while a bare `ErrorRegistry` would replace them — so a bare one is a type error.
- **Hand the client to the browser helpers as `api`**: `useMfaConfirm({ api })` and the passkey
  helpers (`enrollPasskey(api, …)`, `signInWithPasskey(api, …)`, `renewSession(api)`).
- **Server guards keep using the package's own `authApi`**: `RequireAuth`, `getSession` and the
  other session lookups in `@spfn/auth/nextjs/server` do not see your client.

```typescript
import { createAuthApi } from '@spfn/auth';
import { renewSession } from '@spfn/auth/client';
import { errorRegistry as appErrorRegistry } from '@/server/errors';
import { setServerStatus } from '@/lib/server-status';

export const authApi = createAuthApi({
    onOutcome: (outcome) => setServerStatus(outcome.ok ? 'up' : outcome.errorType),
    timeout: 10_000,
    errorRegistry: [appErrorRegistry],
});

// in a client component: the passkey helpers drive this client
const renewed = await renewSession(authApi);
setServerStatus(renewed.ok ? 'renewed' : renewed.reason);
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
| `SPFN_AUTH_TOKEN_ENCRYPTION_KEYS` | `.env.server` | web OAuth, **MFA** | At-rest keyring: comma-separated `<keyId>:<base64-32-byte-key>` entries; first key is active. Required by any app offering a [second factor](#second-factor-mfa), social login or not |
| `SPFN_API_URL` | `.env.local` | yes | declared by `@spfn/core`, no default; the OAuth 2.1 issuer and invitation links are built on it |
| `SPFN_APP_URL` | `.env.local` | OAuth, links, passkeys | declared by `@spfn/core`, no default; the web app origin, unless `NEXT_PUBLIC_SPFN_APP_URL` is set. With neither set, a flow that builds a URL on the app fails with an error naming both |
| `SPFN_AUTH_SESSION_TTL` | both | — | default `7d` (e.g. `7d`, `12h`, `45m`) |
| `SPFN_AUTH_SESSION_TTL_REMEMBER` | both | — | default `30d`; lifetime of a kept session — a sign-in that posted `remember: true`. Same forms; a malformed value refuses the boot |
| `SPFN_AUTH_JWT_SECRET` / `SPFN_AUTH_JWT_EXPIRES_IN` | `.env.server` | — | legacy server-signed JWT mode only |
| `SPFN_AUTH_BCRYPT_SALT_ROUNDS` | `.env.server` | — | default `12` (native bcrypt, off the event loop) |
| `SPFN_AUTH_COOKIE_SECURE` | both | — | override Secure flag (defaults to `NODE_ENV==='production'`); read on every write, by every cookie this package writes — the proxy, `saveSession`/`clearSession`, `clearSessionCookies`, the OAuth callback handler, and the backend's own API-mode OAuth start (`POST /_auth/oauth/start`'s CSRF cookie and the callback's expiry of it) — from one definition, `server/lib/cookie-attributes.ts` |
| `SPFN_AUTH_CSRF` | `.env.local` | — | `off` \| `warn` \| `enforce`; unset behaves as `warn` — see [CSRF protection](#csrf-protection) |
| `SPFN_AUTH_ADMIN_*` | `.env.server` | — | admin seeding (see below) |
| `SPFN_AUTH_ROLE_EMAIL_DOMAINS` | `.env.server` | — | per-role allow-list of email domains, e.g. `admin=example.com;support=example.com,partner.example`; **checked at boot** — see [Restricting roles to email domains](#restricting-roles-to-email-domains) |
| `SPFN_AUTH_GOOGLE_CLIENT_ID` / `_CLIENT_SECRET` | `.env.server` | — | enables Google OAuth when both set |
| `SPFN_AUTH_GOOGLE_SCOPES` | `.env.server` | — | comma-separated; default `email,profile` |
| `SPFN_AUTH_GOOGLE_REDIRECT_URI` | `.env.server` | — | default `{NEXT_PUBLIC_SPFN_APP_URL\|\|SPFN_APP_URL}/_auth/oauth/google/callback`; an override must stay on the web app origin at that path and is **checked at boot** — see [OAuth callback origin](#oauth-callback-origin-web-app-host--rewrite) |
| `SPFN_AUTH_KAKAO_CLIENT_ID` / `_CLIENT_SECRET` | `.env.server` | — | REST API key enables Kakao Login; secret is included when configured |
| `SPFN_AUTH_KAKAO_ADMIN_KEY` | `.env.server` | — | app admin key; required to verify the Kakao User Unlinked webhook |
| `SPFN_AUTH_KAKAO_SCOPES` / `_REDIRECT_URI` | `.env.server` | — | default scope `account_email`; callback `/_auth/oauth/kakao/callback` on the web app origin, **checked at boot** — see [OAuth callback origin](#oauth-callback-origin-web-app-host--rewrite) |
| `SPFN_AUTH_NAVER_CLIENT_ID` / `_CLIENT_SECRET` | `.env.server` | — | both values enable Naver Login |
| `SPFN_AUTH_NAVER_REDIRECT_URI` | `.env.server` | — | default `{NEXT_PUBLIC_SPFN_APP_URL\|\|SPFN_APP_URL}/_auth/oauth/naver/callback`; an override must stay on the web app origin at that path and is **checked at boot** — see [OAuth callback origin](#oauth-callback-origin-web-app-host--rewrite) |
| `SPFN_AUTH_GITHUB_CLIENT_ID` / `_CLIENT_SECRET` | `.env.server` | — | both values enable GitHub OAuth |
| `SPFN_AUTH_GITHUB_SCOPES` / `_REDIRECT_URI` | `.env.server` | — | default scopes `read:user,user:email`; callback `/_auth/oauth/github/callback` on the web app origin, **checked at boot** — see [OAuth callback origin](#oauth-callback-origin-web-app-host--rewrite) |
| `SPFN_AUTH_BATTLENET_CLIENT_ID` / `_CLIENT_SECRET` | `.env.server` | — | both values enable Battle.net OAuth — see [Battle.net](#battlenet) |
| `SPFN_AUTH_BATTLENET_REGION` / `_SCOPES` / `_REDIRECT_URI` | `.env.server` | `global` / `openid` | `cn` for the China host; callback `/_auth/oauth/battlenet/callback` on the web app origin, **checked at boot** |
| `SPFN_AUTH_APPLE_SERVICES_ID` | `.env.server` | — | the Services ID: web `client_id` of Sign in with Apple and the web id_token audience (also accepted as a native audience). With `_TEAM_ID`, `_KEY_ID` and one key variable it enables the Apple web flow (browser and Android); setting any of the five without the rest is **refused at boot** — see [Sign in with Apple](#sign-in-with-apple-web-and-android) |
| `SPFN_AUTH_APPLE_TEAM_ID` | `.env.server` | — | Apple Developer Team ID; `iss` of the client secret JWT |
| `SPFN_AUTH_APPLE_KEY_ID` | `.env.server` | — | Key ID of the Sign in with Apple key; `kid` of the client secret JWT |
| `SPFN_AUTH_APPLE_PRIVATE_KEY` | `.env.server` | — | the `.p8` PEM (sensitive); literal newlines or `\n` both work; must import as an EC P-256 key (**checked at boot**, never logged) |
| `SPFN_AUTH_APPLE_PRIVATE_KEY_FILE` | `.env.server` | — | absolute path of the `.p8` file instead — set exactly one of the two key variables. A Kubernetes deployment mounts the `.p8` from a Secret volume and names its path here, while `spfn secret` manages the PEM variant. The file is read whenever a client secret is minted (about hourly, when the cached one is within 60 s of expiry), so a replaced key file is picked up without a restart, and a file that becomes unreadable or holds an unusable key after boot fails sign-ins (as `provider_error`), not boot |
| `SPFN_AUTH_APPLE_REDIRECT_URI` | `.env.server` | — | default `{NEXT_PUBLIC_SPFN_APP_URL\|\|SPFN_APP_URL}/_auth/oauth/apple/callback` (https only — Apple refuses `localhost`); an override must stay on the web app origin at that path and is **checked at boot** — see [OAuth callback origin](#oauth-callback-origin-web-app-host--rewrite) |
| `SPFN_AUTH_APPLE_RELAY_URLS` | `.env.server` | — | comma-separated https App Links an Android sign-in's callback relays the id_token to; a start's `relayUrl` must equal one exactly. Unset, the native start is refused. A non-https URL, userinfo, a query or a fragment, or setting it without the Apple web flow is **refused at boot** — see [Android](#android-native-start-and-the-callback-relay) |
| `SPFN_AUTH_ANDROID_PACKAGE_NAME` | `.env.server` | — | the Android app's `applicationId`, served in `/.well-known/assetlinks.json`; set together with `_CERT_SHA256` (**checked at boot**) |
| `SPFN_AUTH_ANDROID_CERT_SHA256` | `.env.server` | — | comma-separated SHA-256 fingerprints (`AA:BB:…`, 32 pairs, any case, served uppercase) of the **Play app-signing key**; set together with `_PACKAGE_NAME` (**checked at boot**) |
| `SPFN_AUTH_OAUTH_CALLBACK_ORIGIN_CHECK` | `.env.server` | — | `off` disables the boot check of the five `_REDIRECT_URI` overrides; any other value (unset included) runs it — see [OAuth callback origin](#oauth-callback-origin-web-app-host--rewrite) |
| `SPFN_AUTH_GOOGLE_NATIVE_CLIENT_IDS` | `.env.server` | — | comma-separated client IDs accepted as native id_token audience (iOS/Android/web); enables Google native sign-in |
| `SPFN_AUTH_APPLE_CLIENT_IDS` | `.env.server` | — | comma-separated Apple client IDs (bundle ID / Services ID); enables Apple native sign-in. `SPFN_AUTH_APPLE_SERVICES_ID` is also accepted |
| `SPFN_AUTH_KAKAO_NATIVE_CLIENT_IDS` | `.env.server` | — | comma-separated Kakao app keys accepted as native id_token audience (native app key); `SPFN_AUTH_KAKAO_CLIENT_ID` is also accepted, so either one enables Kakao native sign-in |
| `SPFN_AUTH_NAVER_NATIVE_CLIENT_IDS` | `.env.server` | — | comma-separated Naver client IDs accepted as native id_token audience. `SPFN_AUTH_NAVER_CLIENT_ID` is also accepted, so this is only needed for a separate app application |
| `SPFN_AUTH_OAUTH_SUCCESS_URL` | `.env.server` | — | default `/auth/callback` |
| `SPFN_AUTH_OAUTH_ERROR_URL` | `.env.server` | — | default `/auth/error?error={error}`; `{reason}` takes the [reason code](#the-error-page-reason-codes), appended as `reason=` when absent |
| `SPFN_AUTH_RESERVED_USERNAMES` / `_USERNAME_MIN_LENGTH` / `_USERNAME_MAX_LENGTH` | `.env.server` | — | username rules |
| `SPFN_AUTH_SIGNUP_LINK_TTL_MINUTES` / `_SETUP_TTL_MINUTES` | `.env.server` | — | defaults `30` / `15` — see [Verified-email signup](#verified-email-signup) |
| `SPFN_AUTH_SIGNUP_CONFIRM_PATH` | `.env.server` | — | default `/signup/confirm`; the page in your app the emailed link opens |
| `SPFN_AUTH_PASSWORD_RESET_LINK_TTL_MINUTES` / `_SETUP_TTL_MINUTES` | `.env.server` | — | defaults `30` / `15` — see [Password reset](#password-reset-verified-email) |
| `SPFN_AUTH_PASSWORD_RESET_CONFIRM_PATH` | `.env.server` | — | default `/password/reset`; the page in your app the emailed link opens |
| `SPFN_AUTH_REVOKE_ALL_LINK_TTL_MINUTES` | `.env.server` | — | default `30` — see [The sign-out-everywhere link](#the-sign-out-everywhere-link) |
| `SPFN_AUTH_REVOKE_ALL_CONFIRM_PATH` | `.env.server` | — | default `/account/revoke-all`; the page in your app the link opens |
| `SPFN_AUTH_LINK_MAIL_DELIVERY` | `.env.server` | — | `auto` (default) \| `inline` \| `queued`; who sends signup-link, reset and account-exists mail and verification codes — see [Link mail delivery](#link-mail-delivery) |
| `SPFN_AUTH_PASSKEY_RP_ID` / `_RP_NAME` / `_ORIGINS` | `.env.server` | — | relying party for passkeys; defaults derive from `{NEXT_PUBLIC_SPFN_APP_URL\|\|SPFN_APP_URL}` and are **checked at boot** — see [Passkeys](#passkeys-webauthn) |
| `SPFN_AUTH_PASSKEY_USER_VERIFICATION` | `.env.server` | — | `preferred` (default) or `required`; `discouraged` refuses boot. Says what the browser is asked for; a second factor is judged by each assertion's own flag |
| `SPFN_AUTH_PASSKEY_CHALLENGE_TTL_SECONDS` / `_RECENT_AUTH_MINUTES` | `.env.server` | — | defaults `300` / `10` — see [Passkeys](#passkeys-webauthn) |
| `SPFN_AUTH_MFA_ISSUER` | `.env.server` | — | name the authenticator app files the account under; defaults to the passkey relying-party name, then the app URL host — see [Second factor](#second-factor-mfa) |
| `SPFN_AUTH_MFA_STEP_UP_MINUTES` | `.env.server` | — | default `10`; how recently an enrolled account's device must have proved its second factor for a sensitive change — see [Second factor](#second-factor-mfa) |
| `SPFN_AUTH_MFA_CHALLENGE_TTL_MINUTES` | `.env.server` | — | default `10`; how long a new-device step-up challenge stays spendable — see [Step-up on a new device](#step-up-on-a-new-device) |
| `SPFN_AUTH_MFA_CONFIRM_PATH` | `.env.server` | — | default `/auth/mfa`; app page both OAuth flows (the callback handler and `OAuthCallback`) send a browser to when a social sign-in needs a second factor |
| `SPFN_AUTH_BOUND_KEY_TTL_HOURS` | `.env.server` | — | default `24`; how long a passkey-bound session key lives — see [Session binding](#session-binding) |
| `SPFN_AUTH_BOUND_KEY_RENEW_GRACE_HOURS` | `.env.server` | — | default `168`; how long past expiry a bound key may still be renewed. Past it, sign in again |
| `SPFN_AUTH_CONCURRENT_USE_WINDOW_MS` | `.env.server` | — | default `300000`; how close two sightings from two addresses must be to raise `concurrentUseAtMillis` |
| `SPFN_AUTH_SESSION_RENEW_PATH` | `.env.local` | — | default `/auth/renew`; the page `RequireAuth` sends a bound session whose key ran out |
| `SPFN_AUTH_GUARD_TIMEOUT` | `.env.local` | — | no default; milliseconds the guards' server-side session lookup may take. Unset, it waits as long as the API client does (`SERVER_TIMEOUT`, 120 s). A lookup that times out reads as no session — see [the guards' timeout](#the-guards-timeout) |
| `NEXT_PUBLIC_SPFN_APP_URL` | `.env.local` | — | browser-facing app URL; read before `SPFN_APP_URL` wherever the app origin is needed |
| `NEXT_PUBLIC_SPFN_API_URL` | `.env.local` | — | declared by `@spfn/core`; the API URL browser code calls |

Read validated values via `import { env } from '@spfn/auth/config'` (a proxy validated at
startup). `envSchema` carries descriptions/defaults. The three URLs `@spfn/core` declares
(`SPFN_API_URL`, `NEXT_PUBLIC_SPFN_API_URL`, `SPFN_APP_URL`) are not in it — read them from
`import { env } from '@spfn/core/config'`.

### Admin seeding

`createAuthLifecycle()` creates admin accounts on startup from env, in priority order. Seeded
accounts are auto email-verified, `status: 'active'`, `passwordChangeRequired: true`. The flag is
returned by sign-in and cleared when the password is changed; the package gates nothing on it, so an
app that wants a seeded admin to change the password first must enforce that itself.

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
| `requestSignupLink` | POST `/_auth/signup/email` | public | email a one-time signup confirmation link — see [Verified-email signup](#verified-email-signup) |
| `confirmSignupLink` | POST `/_auth/signup/email/confirm` | public | exchange the link for a password-setup session |
| `completeSignup` | POST `/_auth/signup/password` | setup session | set the password, which creates the account and signs in |
| `requestPasswordReset` | POST `/_auth/password/reset` | public | email a one-time password reset link — see [Password reset](#password-reset-verified-email) |
| `confirmPasswordReset` | POST `/_auth/password/reset/confirm` | public | exchange the link for a password-setup session |
| `completePasswordReset` | POST `/_auth/password/reset/complete` | setup session | set the new password, sign every other device out, sign this one in |
| `login` | POST `/_auth/login` | public | password login + new session key |
| `startDeviceAuth` | POST `/_auth/device/start` | public | begin a device-code login — see [Device-code login](#device-code-login) |
| `startDeviceAuthWeb` | POST `/_auth/device/start/web` | public | the same from a browser behind the proxy, which supplies the key |
| `pollDeviceAuth` | POST `/_auth/device/poll` | public | ask whether the request was answered; the approved answer *is* the login |
| `getDeviceAuthInfo` | POST `/_auth/device/info` | yes | what device is asking, so the approval screen can show it |
| `approveDeviceAuth` | POST `/_auth/device/approve` | yes | let the waiting device in |
| `denyDeviceAuth` | POST `/_auth/device/deny` | yes | refuse it |
| `issueDeviceLink` | POST `/_auth/device/link/issue` | yes | show a code a new device can come in by — see [Device link](#device-link) |
| `redeemDeviceLink` | POST `/_auth/device/link/redeem` | public | the new device parks its key on that code and gets the match number to show |
| `redeemDeviceLinkWeb` | POST `/_auth/device/link/redeem/web` | public | the same from a browser behind the proxy, which supplies the key |
| `getDeviceLinkStatus` | POST `/_auth/device/link/status` | issuing key | where the link stands; the device and three numbers once redeemed |
| `confirmDeviceLink` | POST `/_auth/device/link/confirm` | issuing key | pick the number the new device shows |
| `denyDeviceLink` | POST `/_auth/device/link/deny` | issuing key | refuse the new device |
| `cancelDeviceLink` | POST `/_auth/device/link/cancel` | issuing key | close the link before anyone is let in |
| `pollDeviceLink` | POST `/_auth/device/link/poll` | public | ask whether the issuer picked; the approved answer *is* the login |
| `passkeyRegisterOptions` | POST `/_auth/passkeys/register/options` | yes | begin enrolling a passkey — see [Passkeys](#passkeys-webauthn) |
| `passkeyRegisterVerify` | POST `/_auth/passkeys/register/verify` | yes | verify the attestation and keep the credential |
| `passkeyLoginOptions` | POST `/_auth/passkeys/login/options` | public | begin a passkey sign-in; takes no identifier |
| `passkeyLoginVerify` | POST `/_auth/passkeys/login/verify` | public | verify the assertion; answers exactly as `login` |
| `listPasskeys` | POST `/_auth/passkeys/list` | yes | the caller's enrolled passkeys |
| `renamePasskey` | POST `/_auth/passkeys/rename` | yes | rename one |
| `revokePasskey` | POST `/_auth/passkeys/revoke` | yes | retire one (refused if it is the last way in) |
| `mfaTotpEnroll` | POST `/_auth/mfa/totp/enroll` | yes | mint a TOTP secret — see [Second factor](#second-factor-mfa) |
| `mfaTotpConfirm` | POST `/_auth/mfa/totp/confirm` | yes | spend the first code; answers the ten recovery codes (none under `recoveryCodes: false`) |
| `mfaDisable` | POST `/_auth/mfa/disable` | yes + step-up | remove the second factor (204 either way) |
| `mfaMarkPasskey` | POST `/_auth/mfa/passkey/mark` | yes + step-up | mark or unmark a passkey as the second factor |
| `mfaRegenerateRecoveryCodes` | POST `/_auth/mfa/recovery/regenerate` | yes + step-up | ten fresh codes; every earlier one stops verifying (404 under `recoveryCodes: false`) |
| `mfaStatus` | GET `/_auth/mfa/status` | yes | `{ enrolled, methods, recoveryCodesRemaining }`; no secret |
| `mfaStepUp` | POST `/_auth/mfa/step-up` | yes | re-prove the second factor on this device |
| `mfaStepUpOptions` | POST `/_auth/mfa/step-up/options` | yes | options for a step-up by passkey |
| `mfaVerify` | POST `/_auth/mfa/verify` | public | finish a sign-in that answered `202 { mfaRequired: true }` — see [Step-up on a new device](#step-up-on-a-new-device) |
| `mfaVerifyOptions` | POST `/_auth/mfa/verify/options` | public | options for finishing that sign-in with a passkey |
| `logout` | POST `/_auth/logout` | yes | revoke current key — also a bound session's key that expired and is still inside its renewal grace |
| `rotateKey` | POST `/_auth/keys/rotate` | yes | rotate public key before 90-day expiry |
| `listKeys` | POST `/_auth/keys/list` | yes | the caller's registered devices — see [Registered devices](#registered-devices-key-management) |
| `revokeKey` | POST `/_auth/keys/revoke` | yes | sign one device out |
| `revokeAllKeys` | POST `/_auth/keys/revoke-all` | yes | sign every device out (spares the caller by default) |
| `setSessionBinding` | POST `/_auth/session/binding` | yes | turn session binding on or off — see [Session binding](#session-binding) |
| `getSessionBinding` | GET `/_auth/session/binding` | yes | whether it is on, and when this session's key expires |
| `sessionBindingDisableOptions` | POST `/_auth/session/binding/disable/options` | yes | the challenge that proves it is you before turning it off |
| `passkeyProofOptions` | POST `/_auth/session/passkey-proof/options` | yes | the challenge a bound account answers to let another credential in — see [Letting another credential in](#letting-another-credential-in) |
| `sessionRenewOptions` | POST `/_auth/session/renew/options` | public | begin renewing a bound session key |
| `sessionRenewVerify` | POST `/_auth/session/renew/verify` | public | verify the assertion; answers exactly as `login` |
| `changePassword` | PUT `/_auth/password` | yes | change password |
| `getAuthSession` | GET `/_auth/session` | yes | current session/user, with the role in force (`null` for none) and the permissions `requirePermissions` enforces |
| `getAuthChannels` | GET `/_auth/channels` | public | which sign-in channels the app offers, one boolean each — see [channels](#which-sign-in-channels-exist-channels) |
| `issueOneTimeToken` | POST | yes | short-lived token (e.g. SSE handshake) |
| `checkUsername` / `updateUsername` / `updateLocale` | — | mixed | username availability/update (answers the profile, as `getUserProfile` does); set or clear (`null`) the language choice |
| `getUserProfile` / `updateUserProfile` | — | yes | profile read/update; `metadata` is checked against `defineProfileFields` when declared |
| `listSettings` | GET `/_auth/users/settings` | yes | every declared setting of the caller, built-ins included — see [per-person settings](#how-do-i-declare-per-person-settings-and-profile-fields) |
| `getSetting` | GET `/_auth/users/settings/:key` | yes | one setting of the caller; the default when never set; 404 for an undeclared key |
| `setSetting` | PUT `/_auth/users/settings/:key` | yes | write one (`{ value }`, checked against the key's schema); the default deletes the row |
| `resetSetting` | DELETE `/_auth/users/settings/:key` | yes | return one to its default (204) |
| `createInvitation` / `acceptInvitation` / `listInvitations` / `cancelInvitation` / `resendInvitation` / `deleteInvitation` / `getInvitation` | — | mixed | invitation flow — see [Invitations](#invitations) |
| `requestAccountDeletion` | POST `/_auth/deletion/request` | yes | request account deletion (step-up and recent authentication) — see [Account Deletion & Recovery](#account-deletion--recovery) |
| `cancelAccountDeletion` | POST `/_auth/deletion/cancel` | public | cancel a pending deletion (password or a one-time code to the account's e-mail or phone) |
| `listRoles` / `createAdminRole` / `updateAdminRole` / `deleteAdminRole` / `updateUserRole` | — | superadmin | admin RBAC management |
| OAuth routes | — | — | see OAuth section |
| `registerOAuth2Client` / `getOAuth2Authorize` / `createOAuth2AuthorizationCode` / `oauth2Token` / `oauth2Revoke` / `listOAuth2Grants` / `revokeOAuth2Grant` | `/_auth/oauth2/*` | mixed | OAuth 2.1 authorization server for MCP clients — see [Authorization server for MCP clients](#authorization-server-for-mcp-clients). 404 unless configured |

There is deliberately **no account-existence endpoint**. `POST /_auth/exists` was removed
because it answered "does this account exist" directly, which is user enumeration; the
login path is timing-equalized for the same reason. Do not reintroduce one without
revisiting that decision.

Auth uses **asymmetric, client-signed JWTs**: the client generates an ES256/RS256 keypair,
sends the public key on register/login, signs request JWTs locally, and the server verifies
with the stored public key (`keyId` carried in the JWT). The server never holds a private key.
Keys expire after 90 days — rotate with `rotateKey`, which starts the ninety days again. A key
bound to a passkey is the one exception: it lives for hours and a rotation carries its expiry over
rather than resetting it, because only `session/renew` may move that window — see
[Session binding](#session-binding). A sign-in **replaces** the device's key only when the old
private key proves it (`replacementProof`); otherwise it is a new device — see
[Registered devices](#registered-devices-key-management).

### Which sign-in channels exist (`channels`)

Every route above is mounted for every app. An app that offers fewer ways in says so once, in
`createAuthLifecycle`; it is resolved when the lifecycle is built and read per request:

```typescript
createAuthLifecycle({
    channels: {
        signup: false,          // accounts are issued by an operator, never taken
        passwordReset: true,
        deviceCode: false,
        deviceLink: false,
        passkeyLogin: true,
    },
})
```

Every key is optional and defaults to `true`, so an app that passes nothing serves exactly what it
served before. A key that is not one of these five, or a value that is not a boolean, is refused at
startup — either would leave open a channel the app believes it closed.

A closed channel stays closed until the app itself says otherwise. A second `createAuthLifecycle()`
that passes no `channels` leaves them as they are. One that states the same channels again is fine;
one that states different channels refuses boot in `afterInfrastructure` with an error naming the
channels that differ — and until then every channel either call closed stays closed. That includes
two partial objects such as `{ signup: false }` and `{ deviceCode: false }`: an omitted key means
`true`, so the first says device-code login is on and the second says sign-up is — a contradiction,
not a merge.

| channel | its routes |
|---|---|
| `signup` | `register`, `requestSignupLink`, `confirmSignupLink`, `completeSignup`; `sendVerificationCode` and `verifyCode` with `purpose: 'registration'` |
| `passwordReset` | `requestPasswordReset`, `confirmPasswordReset`, `completePasswordReset` |
| `deviceCode` | `startDeviceAuth`, `startDeviceAuthWeb`, `pollDeviceAuth`, `getDeviceAuthInfo`, `approveDeviceAuth`, `denyDeviceAuth` |
| `deviceLink` | `issueDeviceLink`, `redeemDeviceLink`, `redeemDeviceLinkWeb`, `getDeviceLinkStatus`, `confirmDeviceLink`, `denyDeviceLink`, `cancelDeviceLink`, `pollDeviceLink` |
| `passkeyLogin` | `passkeyLoginOptions`, `passkeyLoginVerify` |

Every other route is always on. `passkeyLogin: false` closes only signing in with a passkey alone:
registering, listing, renaming and revoking passkeys, proving one at `mfa/verify` and `mfa/step-up`,
marking one as the second factor, session renewal and the passkey proofs of a bound session stay on.
No other route signs a person in by a passkey alone — the device-code approval, the device-link
confirmation and the authorization server's consent ask for a passkey only beside the session that
is already signed in. There is no key for password sign-in, so no setting leaves an app
with no way in; whether a second factor is asked for is the second-factor policy's business, not
this option's.

**A sign-in page reads which channels are on** from `GET /_auth/channels` (`authApi.getAuthChannels`),
so it draws no button that would answer 404:

```tsx
// app/sign-in/page.tsx — a server component
import { authApi } from '@spfn/auth';

export default async function SignInPage()
{
    const channels = await authApi.getAuthChannels.call({});
    // { signup: true, passwordReset: true, deviceCode: false, deviceLink: false, passkeyLogin: false }

    return <SignInForm passkey={channels.passkeyLogin} signup={channels.signup} reset={channels.passwordReset} />;
}
```

One boolean per channel above, and a channel added later appears in it with no change on your side.
It is public, like `GET /_auth/oauth/providers`, which lists the social buttons: the answer is the
app's configuration, the same for every caller, needs no session and says nothing about any
account. Like that route it has no rate limit and sets no cache headers; the answer is fixed while
the server runs and changes only when it restarts with different `channels`. Through the Next.js proxy it gets
no rule of its own — a session cookie the browser holds is read and forwarded as on any request, and
none is needed. Its `ROUTE_CHANNELS` entry is `'always'` and its `ROUTE_ENROLMENT` entry `'none'`.

**A channel turned off answers 404** (`ChannelDisabledError`, code `CHANNEL_DISABLED`,
`details.channel` naming the channel) on each of its routes, before anything the route itself runs:
no rate-limit budget is spent, no long poll is held open, no transaction begins and nothing is read
from the database. The check is the first of the route's own middlewares, so the app's server-level
middlewares run as they do on any route. On a public route that means every caller gets the 404; on
a signed-in route (`getDeviceAuthInfo`, `approveDeviceAuth`, `denyDeviceAuth`, and the device-link
issuer's five) the global `auth` middleware runs first, so an anonymous caller gets its `401` and a
signed-in one the 404 — as the authorization server's signed-in routes answer when it is not
configured. The routes still register (registration happens at import, before `createAuthLifecycle`
runs), so the check is made per request, as the
[authorization server's](#authorization-server-for-mcp-clients) is. A verification code is judged by
its `purpose`: with `signup: false`, `purpose: 'account_deletion'` is still sent.

**`signup: false` also closes the social door.** It means no account exists that an operator did not
issue, so a first sign-in with a provider that would create an account is refused —
`SignupDisabledError`, 403, code `SIGNUP_DISABLED`, on the web callback (the error page gets
`reason=signup_disabled`) and on native sign-in. Nothing is written: no account, no social row, no
key. A sign-in whose provider identity is already linked signs in as before, and so does one that
attaches to an existing account under [`oauthEmailMatch`](#when-a-first-sign-ins-email-matches-an-existing-account).
`oauthEmailMatch: 'separate'` would create an account, so it is refused too.

**Service functions do not read the setting.** `registerService`, `requestSignupLinkService`,
`startDeviceAuthService` and the rest stay callable by the app, so an operator console that creates
accounts with `signup: false` keeps working. Invitations (`acceptInvitation`) and
[admin seeding](#admin-seeding) create accounts whatever `signup` says. The one exception is the
social path above, because an account made by a first social sign-in is sign-up by another door.

| Error | HTTP | `code` | When |
|---|---|---|---|
| `ChannelDisabledError` | 404 | `CHANNEL_DISABLED` | a route of a channel the app turned off; `details.channel` names it |
| `SignupDisabledError` | 403 | `SIGNUP_DISABLED` | `signup: false`, and a first social sign-in would have created an account |

The mobile contract lists `SignupDisabledError` and `ChannelDisabledError` since 0.13.8, and marks
each operation a closed channel answers `ChannelDisabledError` on with `closedChannel`:
`auth.enroll.register` (`signup`), the five `auth.device.*` (`deviceCode`) and
`auth.deviceLink.redeem` / `auth.deviceLink.poll` (`deviceLink`). `passkeyLogin` marks nothing there:
the passkey ceremonies need a browser WebAuthn API and are not contract operations, so the contract
is unchanged. In the browser, `signInWithPasskey` meets the 404 as a rejected call.
`GET /_auth/channels` is not a contract operation either, as `GET /_auth/oauth/providers` is not: a
native client learns that a channel is closed from `closedChannel` and the 404.

### Requiring a second factor (`secondFactor`)

By default a second factor is something an account opts into (see
[Second factor](#second-factor-mfa)). An app that wants every account to have one says so once, in
`createAuthLifecycle`:

```typescript
createAuthLifecycle({
    channels: { deviceCode: false, deviceLink: false },
    secondFactor: {
        required: true,          // default false
        methods: ['passkey'],    // default ['totp', 'passkey']
        recoveryCodes: false,    // default true
    },
})
```

**Without the option nothing changes** — no route's middleware chain, no answer, no event value, no
extra query. A key that is not one of these three, a method that is not `totp` or `passkey`, and a
value of the wrong type are refused when the lifecycle is built. A second `createAuthLifecycle()`
that omits the option leaves it as it is; one that states a different policy refuses boot in
`afterInfrastructure`, naming what differs, and the first statement stays in force until then.

#### The enrolment-only state

"Enrolled" means: the account has a live second factor **of a listed method** — a confirmed TOTP
while `'totp'` is listed, a passkey marked as a second factor while `'passkey'` is. With
`required: true`, an account that is not enrolled in that sense can do nothing but enrol one. It is
a property of the account, read on every request, not of the sign-in: there is no stored flag and
no migration, a session that predates the policy is covered, and the moment the account enrols the
**same session** works everywhere.

- Its sign-in succeeds as usual — `auth.login` is emitted and `lastLoginAt` moves — and the
  `LoginResult` carries **`secondFactorEnrolmentRequired: true`**. So does `getAuthSession`.
- `authenticate` answers every other request **403 `SECOND_FACTOR_ENROLMENT_REQUIRED`**
  (`SecondFactorEnrolmentRequiredError`), on the package's routes and on every route of the app.
  403 rather than 401 for the reason `STEP_UP_REQUIRED` is: the session is not gone, and the
  Next.js proxy keeps it. That holds for the principal of every
  [auth profile](#custom-auth-profiles-registerauthprofile) too — `clientProofV1` and any profile
  the app registers: the policy is about the person, whichever verifier proved them.
- `optionalAuth` reads the caller as anonymous, on its Bearer path and on a profile alike.
- A person reaching the app through an OAuth 2.1 access token is refused the same way:
  `verifyAccessToken` throws `SecondFactorEnrolmentRequiredError` for a valid token whose account
  may only enrol (`@spfn/mcp` turns any throw from its validator into its 401 challenge), and
  the token endpoint refuses its code exchange and refresh with `invalid_grant`. A
  one-time token is refused too. Ops tokens and machine principals are not people and are untouched.

The enrolment routes — the only ones such a session reaches:

| routes | while |
|---|---|
| `passkeyRegisterOptions`, `passkeyRegisterVerify`, `listPasskeys`, `mfaMarkPasskey` | `'passkey'` is listed |
| `mfaTotpEnroll`, `mfaTotpConfirm` | `'totp'` is listed |
| `mfaStatus`, `mfaStepUpOptions`, `mfaStepUp`, `getAuthSession`, `logout` | always |

They still run behind the global `auth` middleware, so every app middleware after it sees the
principal on them. Only routes of `mainAuthRouter` can be enrolment routes; the classification is
`ROUTE_ENROLMENT` beside `ROUTE_CHANNELS`, and a route left out of it fails at import.

An enrolment route is recognised by **the route that matched**, not by the request's path: the
classification puts a marker on each one, and `authenticate` looks for it inside the route chain it
is running in. So mounting the server under a prefix (`root.route('/api', app)`) changes nothing,
and nothing an app declares can be taken for one — not an app route at the same path on another
method, not an app `'*'` middleware, not a path no route matched (404). Only the global
`authenticate` reads the marker — and `logout`'s own `authenticateForSignOut`, which runs it there,
with the marker placed after it; `optionalAuth`, `opsOrUser` and a one-time token exempt nothing.

The session-renewal pair (`sessionRenewOptions`, `sessionRenewVerify`) is classified on its own,
`'unchecked'`: it is authenticated by `authenticateForRenewal`, which never asks the policy, so a
bound enrolment-only session renews — and the renewed key is held to enrolment on its next request.

#### Enrolling when the account already holds a credential

Trust on first use is right for an account that holds nothing, and wrong for one that does: a
stolen password must not be enough to enrol the thief's factor beside a passkey or an authenticator
app the owner already has. So in the enrolment-only state, **an account that holds any live
credential it could prove must prove one on this device before it may enrol**; one that holds none
enrols on first use.

"Holds" is: a live passkey, marked as a second factor or not; a confirmed TOTP, listed or not; and,
only while `recoveryCodes` is on, an unspent recovery code. The proof is an ordinary step-up on
this device key: `mfa/step-up/options` and `mfa/step-up` are enrolment routes, and **only while the
account is in the enrolment-only state** `mfa/step-up` accepts an assertion from any live passkey of
the account, a code from a confirmed TOTP whether `'totp'` is listed or not, and a recovery code
only while `recoveryCodes` is on. It opens the ordinary step-up window. Once the account is
enrolled an unlisted proof is refused again, at `mfa/step-up` as at `mfa/verify`.

`passkeys/register/options`, `passkeys/register/verify`, `mfa/passkey/mark`, `mfa/totp/enroll` and
`mfa/totp/confirm` then require that window when the account holds a credential, and answer
**403 `STEP_UP_REQUIRED`** without it, writing nothing — the code the client already handles. The
decision is the account's state as the request reads it on the primary. The
recent-authentication rule on the passkey routes (`RECENT_AUTH_REQUIRED`) runs as it always has.

While the policy requires a second factor with `'passkey'` listed, `passkeys/register/verify`
**marks the passkey it registered as the second factor in the same transaction** — when the
ceremony carried user verification, which is the proof; a registration without it (a security key
with no PIN) is kept unmarked, and an enrolment-only account stays in that state — and its answer
carries `mfaStatus` (the `mfa/status` shape). In the enrolment-only state that makes the session
ordinary from its next request without a second call; on an enrolled account it marks the spare,
so a second passkey is a second factor as soon as it exists (#399). With no policy, or with
`required: false`, it marks nothing and its answer has no `mfaStatus`, as before: there a second
factor is something the owner chose, and marking stays their act (`mfa/passkey/mark`).

**The marking registration is also a step-up.** In the same transaction it opens
[the step-up window](#the-step-up-window) for the credential that registered — the device key, or
the application profile with its key id — with method `passkey`, exactly as `totp/confirm` does for
a TOTP: the ceremony just proved the factor the account now holds, with user verification. So the
sensitive change that usually follows first set-up, a password change, needs no second ceremony.
Only that registration records one: a registration without user verification records nothing, and
on an account that is already enrolled adding a passkey does not refresh the window — the spare is
marked, but it needed an open window to start, and registering more credentials must not keep it
open.

The client flow, by what the account holds (`secondFactorEnrolmentRequired: true` on the sign-in):

| the account holds | flow |
|---|---|
| nothing | register a passkey (`enrollPasskey`) with user verification — done, it is marked; or `totp/enroll`, `totp/confirm` |
| a passkey it never marked | `mfa/step-up/options` → assert with that passkey → `mfa/step-up`, then `passkey/mark` with `secondFactor: true` (or register another, which is marked) |
| a confirmed TOTP the policy does not list | `mfa/step-up` with `{ code }`, then register a passkey — it is marked |

A 403 `STEP_UP_REQUIRED` on any enrolment call means "step up first", exactly as on an enrolled
account's sensitive change.

##### First set-up: a temporary password and a required passkey

An account an operator created with a temporary password (`passwordChangeRequired: true`), under
`methods: ['passkey']`, holding nothing yet:

1. **Sign in** with the temporary password → a session with `secondFactorEnrolmentRequired: true`.
2. **Register a passkey** with user verification (`enrollPasskey`) → it is marked, the session is
   ordinary, and this device's step-up window is open.
3. **`PUT /_auth/password`** with `currentPassword` and `newPassword` → 204, no step-up ceremony in
   between. `currentPassword` (the temporary one) stays required here: with the window just opened,
   a session taken in those minutes could otherwise set a password it never knew.
4. The change still signs out every session, this one included, so the person **signs in again**
   with the new password and their passkey (the 202 and `mfa/verify`). Keeping the session that made
   the change is the second part of #372, not yet released.

Before this release step 3 answered 403 `STEP_UP_REQUIRED` and needed an `mfa/step-up` ceremony with
the passkey registered seconds earlier — three passkey ceremonies in all; it is two now.

When the owner has lost what the account holds, the operator resets it:
`resetSecondFactorService(userId)` (from `@spfn/auth/server`), in one transaction, revokes every
live passkey of the account — without the owner route's step-up, recent-authentication and
last-credential refusals, each announced by `auth.passkey.revoked` with `reason: 'operator'` — and
removes the TOTP, the recovery codes, the second-factor marks and the step-up verifications. The
account then holds nothing, so its next sign-in enrols on first use. It is a service, not a route:
the app decides who may call it. It leaves the password and the device keys alone; an operator who
suspects the account was taken over also signs it out everywhere with
`revokeAllKeysService({ userId, includeCurrent: true })`. An unknown `userId` is `NotFoundError`.

`disableMfaService(userId)` is the narrower call: it removes the TOTP, the recovery codes, the
step-up verifications and every passkey's second-factor mark, and leaves the passkeys themselves —
each still signs its owner in, and under a required policy still counts as a credential the account
must prove before it enrols again.

#### `methods`

Only a listed method counts as enrolled, is reported by `mfa/status`, and is accepted as a proof.
A proof of an unlisted method — a TOTP code the account enrolled before the policy, say — is a
failed proof: the uniform 401, counted against the account's
[failure budget](#wrong-proofs-one-budget-per-account) exactly as a wrong code is, and it opens no
window. An unlisted method's
enrolment routes answer **404 `SECOND_FACTOR_METHOD_DISABLED`** (`SecondFactorMethodDisabledError`,
`details.method`): `totp/enroll` and `totp/confirm` for `'totp'`, `passkey/mark` for `'passkey'`.
Passkey *sign-in* registration stays, since a passkey is also a way in.

`methods: ['passkey']` makes the passkey the second factor. It no longer touches
`SPFN_AUTH_PASSKEY_USER_VERIFICATION`: an assertion is a second factor only when it carried user
verification itself, whatever that variable says ([what a passkey proves](#what-a-passkey-proves)).
When `'passkey'` is not listed, a passkey sign-in is no longer a second proof: an enrolled account
signing in with one on a new device gets the same 202 challenge a password sign-in gets, and the
proxy handles it the same way. While it is listed, a passkey sign-in with user verification needs no
second factor at all, so an app that wants a password plus a passkey whenever a person signs in on a
device that is not already signed in also closes passkey sign-in with `channels: { passkeyLogin: false }` ([channels](#which-sign-in-channels-exist-channels))
— and three more doors ([the recipe](#what-required-means--and-password-plus-passkey-on-a-device-not-signed-in)).

#### `recoveryCodes: false`

None are issued — `totp/confirm` answers `recoveryCodes: []` and writes no row — and none are
accepted: a recovery code at `mfa/verify` or `mfa/step-up` is a failed proof (a 401, counted, and
the code is **not** spent). `recovery/regenerate` answers 404 `SECOND_FACTOR_METHOD_DISABLED`
with `details.method: 'recoveryCodes'`, and `mfa/status` reports `recoveryCodesRemaining: 0`.
Rows from before are ignored, not deleted.

#### What `required` means — and password plus passkey on a device not signed in

`required: true` means **a factor on a new device**: every account holds a listed second factor,
and a device the account has not seen proves one before its key works
([step-up on a new device](#step-up-on-a-new-device)). It does **not** mean "the password on every
sign-in". The first proof is whatever the way in asks for, and with every option at its default
some ways in ask for no password at all:

| way in | what it takes under `required: true` | closed by |
|---|---|---|
| passkey sign-in (`passkeys/login/*`) | the passkey alone, with user verification, while `'passkey'` is listed | `channels: { passkeyLogin: false }` |
| social sign-in, web and native | the provider's sign-in, then a factor | enabling no provider for sign-in — none configured, or each [link-only](#link-only-providers-and-recent-authentication); there is no channel for it |
| password reset | the mailed link, then a factor | `channels: { passwordReset: false }` |
| recovery code | stands in for the factor on every 202 | `secondFactor: { recoveryCodes: false }` |
| device-code login, device link | — | refused at boot under `required` |

So an app that wants **the password and the passkey whenever a person signs in on a device that is
not already signed in** closes all four:

```typescript
createAuthLifecycle({
    channels: {
        passkeyLogin: false,   // a passkey is never the whole credential
        passwordReset: false,  // or keep it, and accept "email + passkey" as a way in
        deviceCode: false,     // required by `required: true`
        deviceLink: false,
    },
    secondFactor: {
        required: true,
        methods: ['passkey'],
        recoveryCodes: false,  // nothing stands in for the passkey
    },
})
// …and no social provider enabled for sign-in — none configured, or each link-only with
// configureAuth({ oauthProviders: { kakao: { signIn: false } } }) — so that
// GET /_auth/oauth/providers answers `providers: []`.
```

Then, for an account that has enrolled its passkey, every sign-in route asks for the password, and a
sign-in on a device that is not already signed in — a signed-out browser included — answers 202
until the passkey is proven at `mfa/verify`. The recipe does **not** cover:

- **A browser that is still signed in, signing in again.** The proxy sends the live session's key as
  `replacementProof`; that sign-in is the same device, so the password alone answers 200.
- **Session renewal with [binding](#session-binding) on.** An expired bound key inside its grace is
  renewed at `session/renew/verify` with the passkey alone; no password is asked.
- **An account with no listed factor yet** — created before the policy, or holding only a method
  not in `methods`. The password answers 200 with an enrolment-only session
  (`secondFactorEnrolmentRequired: true`), and an account holding no credential it could prove
  itself with enrols its passkey on that session with the password alone. The rule above holds from
  the moment the account has enrolled.
- **Services the app calls itself**, which ignore channels, as they always do.

The cost: with no recovery codes and no reset, a person who loses the passkey or the password is let
back in only by the operator (`resetSecondFactorService(userId)`, and a password set by the app). `GET /_auth/channels`
then answers `passkeyLogin: false` and `passwordReset: false`, so the sign-in page draws neither.

#### Removing the last factor

With `required: true`, a route that would remove the account's last listed second factor answers
**409 `SECOND_FACTOR_REQUIRED`** (`SecondFactorRequiredError`) and changes nothing: `mfa/disable`,
`passkey/mark` with `secondFactor: false` on the last marked passkey, and `passkeys/revoke` of it.
Removing one of several is allowed. The operator's way to re-issue a factor — a lost phone — is
`resetSecondFactorService(userId)`, called by the app: it is not refused, and the account is then in
the enrolment-only state, holding nothing, until its owner enrols again.

#### Boot refusals

In `afterInfrastructure`, beside the channel check:

| configuration | |
|---|---|
| `methods: []` | refused — nothing could ever be enrolled |
| `required: true` with `channels.deviceCode` or `channels.deviceLink` on | refused, naming the channel: an approval signs a device in with no listed factor |
| `required: true`, `methods: ['totp']`, no `SPFN_AUTH_TOKEN_ENCRYPTION_KEYS` | refused — no TOTP secret could be stored |
| two lifecycles stating different policies | refused |

| Error | HTTP | `code` | When |
|---|---|---|---|
| `SecondFactorEnrolmentRequiredError` | 403 | `SECOND_FACTOR_ENROLMENT_REQUIRED` | a request of an enrolment-only session on a route that is not an enrolment route |
| `SecondFactorMethodDisabledError` | 404 | `SECOND_FACTOR_METHOD_DISABLED` | a route of an unlisted method, or `recovery/regenerate` with `recoveryCodes: false`; `details.method` |
| `SecondFactorRequiredError` | 409 | `SECOND_FACTOR_REQUIRED` | removing the last listed factor through a route |

The mobile contract lists the three since 0.14.0 and marks each operation that can answer the
first with `secondFactor.enrolmentRequired` — every signed-in operation except `auth.mfa.status`.

### The sign-in guard (`signIn`)

`createAuthLifecycle({ signIn: { admit, settled } })` gives the application a say over who signs in
and tells it how every attempt ended — a lock after repeated failures, an expiring temporary
password, a sign-in history. Leave it out and nothing changes: no extra query, lock or transaction
runs on any sign-in. Both callbacks are optional.

```typescript
import type { SignInAttempt, SignInOutcome } from '@spfn/auth/server';

createAuthLifecycle({
    signIn: {
        admit: async (attempt: SignInAttempt) =>
            attempt.user && await lockouts.isLocked(attempt.user.id) ? { refuse: { code: 'LOCKED' } } : undefined,
        settled: (outcome: SignInOutcome) => signInHistory.record(outcome),
    },
})
```

```typescript
type SignInChannel = Exclude<DeviceRegistrationChannel, 'renewal'> | 'deletion-cancel';
type SignInStage = 'credential' | 'second-factor';
type SignInFailureReason =
    'credential' | 'secondFactor' | 'refused' | 'accountDisabled' | 'pendingDeletion' | 'secondFactorLocked';

interface SignInAttempt
{
    user: User | null;              // null when the identifier names no account
    channel: SignInChannel;
    stage: SignInStage;
    identifier?: { email?: string; phone?: string };   // password and deletion-cancel
    ip?: string;                    // display material (deviceProvenance), never decide by it
    userAgent?: string;
    webProxy: boolean;              // proxy-guard recognised the Next.js proxy: the one attested fact
}

type SignInOutcome = SignInAttempt & (
    | { result: 'succeeded' | 'challenged'; keyId: string }
    | { result: 'failed'; reason: SignInFailureReason; keyId?: string }
);

type SignInAdmission = void | undefined | { refuse: { code: string } };   // code: /^[A-Za-z0-9_.-]{1,64}$/
```

**`admit(attempt)`** answers nothing to let the attempt go on, or `{ refuse: { code } }`. The client
gets **403 `SignInRefusedError`** with the app's string in `details.code`; the status is always 403.
The code is a constant for the client to branch on — 1 to 64 characters, each a letter, a digit,
`_`, `-` or `.` (`ACCOUNT_LOCKED`, `temporary-password-expired`) — never a message or data
interpolated into one. Any other answer, a code outside that shape included, is refused as `admit`
throwing is: 500, no session.
On the web OAuth flow the refusal is the error redirect with `reason=sign_in_refused`. A refused
registration (`register`, `signup-link`, `invitation`) rolls the new account back.

**`settled(outcome)`** is told `challenged` at a 202 (the key is written inactive), `succeeded`
once, when the session exists — at `mfa/verify` for a 202 — and `failed` with a `reason`.

**Where each call runs.** An app repository extending `BaseRepository` joins whatever transaction is
open through the transaction context — no transaction argument to thread — so where a call runs
decides what becomes of a write it makes:

| Call | Runs | A write of yours there |
|---|---|---|
| `admit`, first call on `password`, `deletion-cancel` and `mfa/verify` (before the credential is compared) | outside any transaction, without the lock | commits at once, statement by statement, whatever the attempt's outcome |
| `admit`, deciding call — where the key is written; at `mfa/verify`, where it is activated | in the session's transaction, under the account lock | commits with the session; rolls back with a refused or failed one |
| `admit`, asked again after a wrong credential | in the transaction that records the failure, under the account lock | commits with that record |
| `settled`, `challenged` or `succeeded` | in the session's transaction, under the account lock | commits with the session; a throw rolls the session back |
| `settled`, `failed` for a wrong credential checked before any transaction | in a transaction of its own, under the account lock, before the answer | commits before the 401 or 403; a throw answers 500 |
| `settled`, `failed` for a refusal decided in the session's transaction | in a transaction of its own, under the account lock, after the session's rolled back | commits before the 403; a throw, or the lock busy past its wait, loses the report and is logged |

- **Under the account's lock** (`usersRepository.lockAccount`; none when `user` is null) every other
  writer of the account waits on you, at most five seconds before it answers `AccountBusyError`:
  database work only, and fast. No network call.
- **Never lock a second account** in them — the transaction refuses it with
  `SecondAccountLockError`.
- **Lock order.** The package locks the account row first, then your rows. Code of yours that locks
  your rows and then calls a package writer that locks the account (`setAccountStatus`,
  `revokeAllKeysService`, …) can deadlock against a sign-in. Call the package writer first, or do
  not hold your row locks across it.
- **Every failure is told, committed** — but for the two cases under the second path below, which
  are logged instead. Whatever said no — a wrong password or proof, your `admit`,
  the package's refusal of an account that is not active — `settled` is told `failed` in a
  transaction of its own, under the account lock, committed before the answer: the 401 or 403 does
  not roll it back. It gets there one of two ways:
  - **A wrong credential checked before any transaction** — the password on `password` and
    `deletion-cancel`, the proof at `mfa/verify`, a spent second-factor budget — is told, and `admit`
    is then asked again in that transaction: a failure that crossed your limit is answered with the
    refusal. An unknown identifier has no account row to lock; count it with one statement (an
    upsert).
  - **A refusal decided inside the session's transaction** — the deciding `admit` (`refused`), an
    account the package refuses (`accountDisabled`, `pendingDeletion`), a passkey assertion that
    fails for a known credential (`credential`), and at `mfa/verify`'s completion a right proof it
    can no longer spend: a budget spent since the proof was judged (`secondFactorLocked`, answered
    429 — `admit` is not asked again), the proof or the challenge spent by another request first,
    the challenge expired or its key generation ended (`secondFactor`) — is told once that
    transaction, and every one around it, has rolled back: nothing of the refused session is in the
    report, and the report is committed before the refusal is answered. `admit` is not asked again. On a channel that creates
    the account (`register`, `signup-link`, `invitation`) the refused account never existed, and
    `user` is null.
  - **When the second path's report cannot be written** — the account lock held by another writer
    past its five-second wait (`AccountBusyError`), or your `settled` throwing — the history row is
    lost, and the answer is unchanged: the refusal, as it would have been. The session is already
    gone; there is nothing left for the answer to undo. The package logs one error line, `A refused
    sign-in was not told to signIn.settled; the refusal was answered`, with the error and `channel`,
    `stage`, `reason`, `userId` (null when the attempt had no account) and `keyId` when it had a
    key — never the identifier typed, never an address. Search for that line to find the attempts
    your history is missing. On the first path the same two failures change the answer instead: a
    busy lock answers 503 (`AccountBusyError`), a throw 500, and nothing is lost unseen.
- **A refusal is not a failure the package counts.** `reason: 'refused'` is your own `admit`'s
  refusal told back to you. The worked example below counts it all the same, with every failure at
  `stage: 'credential'`: the deciding `admit` is reached only by a right password, so a right
  password it refuses is told `refused` where a wrong one is told `credential`, and a counter that
  skipped either would count them apart. A locked account's further attempts add to a count that is
  already past the limit, and the lift starts it again.
- **A throw** from `admit` answers 500, with no session. From `settled` on a failure, 500 — never a
  quiet 401 with nothing recorded. From `settled` on a success, the session rolls back: no key, no
  `auth.login`.
- **The package's own count is not yours to roll back.** A wrong second-factor proof is charged to
  the account's budget in a transaction that commits before `settled` is told, so a `settled` that
  throws still leaves the count, the lock it reaches and the one `auth.mfa.locked` in force: after
  the budget is spent the right code is refused, as without a guard.
- **It may run twice.** On OAuth a sign-in that lost a race is rolled back and run once more
  (`beforeRegister` has the same note): the rolled-back run's writes go with it. Side effects — mail,
  webhooks — belong after commit (`onAfterCommit`, or an event subscriber), not in the callback.
- **Not asked on renewal or key rotation.** Those continue a session; a lock must not sign the owner
  out of every device as keys expire. Status is the tool for ending sessions (`setAccountStatus`).

| Channel | Credential the package checks | `admit` asked | `settled` told |
|---|---|---|---|
| `password` (`POST /_auth/login`) | password for an identifier | before the comparison (no lock), and under the lock in the session's transaction, which decides | `failed` (`credential`, `refused`, `accountDisabled`, `pendingDeletion`); `challenged` or `succeeded` |
| `passkey` | the passkey assertion | under the lock where the key is written | `failed` (`credential` for a known credential, `refused`, `accountDisabled`, `pendingDeletion`); `challenged` or `succeeded` |
| `oauth`, `oauth-native`, `password-reset`, `device-code`, `device-link` | the provider, the reset link, the approving device | under the lock where the key is written | `failed` (`refused`, `accountDisabled`, `pendingDeletion`); `challenged` or `succeeded` |
| `register`, `signup-link`, `invitation` | the code, the link, the invitation | under the lock, after `beforeRegister`; a refusal rolls the account back | `failed` (`refused`, `user: null`); `succeeded` |
| second factor (`POST /_auth/mfa/verify`), the 202's channel | the TOTP code, recovery code or passkey | before the proof is judged, and under the lock where the key is activated | `failed` (`secondFactor`, `secondFactorLocked`, `refused`, `accountDisabled`, `pendingDeletion`), `stage: 'second-factor'`; `succeeded` once |
| `deletion-cancel` (`POST /_auth/deletion/cancel`) | the password for an identifier — no session results | before the comparison; a verification-code cancel is not guarded | `failed` (`credential`, `refused`, `accountDisabled` for an account not active with nothing pending) |
| renewal, `keys/rotate` | — | never | never |

**Count by stage, never by reason.** A counter, a delay or any answer the app derives from
`settled` must treat `accountDisabled` and `pendingDeletion` exactly as `credential`: they exist so
the app can tell the **owner**, out of band. On `password` and `deletion-cancel` they are told only
for the right password, and a wrong one is told `credential`, so a lockout that counts `credential`
alone fires after five wrong guesses and never after the right one — the oracle the package's own
answer no longer is. Count every `failed` outcome with `stage: 'credential'`, whatever its reason,
as the worked example below does; a reason added later is then counted without a change of yours.

A wrong **step-up** or **enrolment** proof is not reported: a signed-in person's typo is not a
sign-in. **Not reported either**: an attempt that never identifies an account or a credential — a
malformed request, an unknown passkey credential id, a challenge, link or code already expired or
spent when it is presented, an
identity the OAuth provider would not vouch for — and the verification-code path of
`deletion/cancel` (no password is checked; no session results). Nor is a password
`deletion/cancel` that lost a race after its password matched: the account, read again under its
lock, is no longer pending and not active, or its password hash changed again after it was checked
a second time — answered 401 `InvalidCredentialsError`, told nothing. The race is the owner's
(a status change or a password change landing within the same request), not a guesser's to arrange,
and a counter misses one right password by it. A reset link refused at its
confirmation, before the sign-in step, is not a sign-in yet; an account refused at the completion is
reported. Do not record from inside `admit`: a write there rolls back with a refused session — the
report of the refusal is `settled`'s.

**Why a refused account still costs a comparison.** On `password` and `deletion-cancel`, `admit` is
asked before the password is compared. An account it refuses is compared against the **dummy hash**,
never its own, and answered the refusal whatever the password was. Skipping the comparison would
make a refused account answer faster than an unknown one; comparing its real hash would make the
refusal answer the password. An unknown identifier reaches `admit` with `user: null` — refuse those
too if your policy counts identifiers.

**An account the package refuses answers as a wrong password.** On `password` and
`deletion-cancel`, an account that is disabled, suspended, pending deletion or purged is answered
exactly what a wrong password is — `InvalidCredentialsError` (401), the same body — whatever the
password. Its own hash is still compared, and the refusal is read from columns already on the row,
so the refused path issues no statement the wrong-password path does not. Otherwise the answer would
tell a caller the password was right on an account that cannot sign in. On `deletion-cancel` a
pending deletion is the door itself, so only an account that is not active and has nothing pending
is refused there; an active account with nothing pending is answered `DeletionNotRequestedError`.
`settled` is the one place the reason reaches: a right password is told `failed` with
`accountDisabled` or `pendingDeletion`, a wrong one `credential`, and `admit` is asked again after
either. The other channels (OAuth, passkey, device code, device link, one-time token) prove
possession of something a guesser does not hold, and still answer `AccountDisabledError` /
`AccountPendingDeletionError`.

#### Recipe — tell the owner of a refused account by e-mail

The person who typed the right password for a disabled or pending-deletion account is shown "wrong
password". Tell the account's owner why, out of band, from `settled`:

```typescript
// server.config.ts
import { onAfterCommit } from '@spfn/core/db';
import { createAuthLifecycle } from '@spfn/auth/server';
import { accountNoticeMailer } from './src/server/mail/account-notice';

export const authLifecycle = createAuthLifecycle({
    signIn: {
        settled: (outcome) =>
        {
            const told = outcome.result === 'failed'
                && (outcome.reason === 'accountDisabled' || outcome.reason === 'pendingDeletion');

            if (told && outcome.user?.email)
            {
                // After the report's own transaction commits: mail is not database work.
                const { user, reason } = outcome;
                onAfterCommit(() => accountNoticeMailer.send(user, reason));
            }
        },
    },
});
```

The mail goes to the account's own address, never to the caller: for `pendingDeletion` it carries
the purge date and the restore path (`POST /_auth/deletion/cancel`), for `accountDisabled` the
status and how to reach support. The reason arrives only with the right password, so the mail is
sent only when the owner's password was used — which is why nothing but this mail may read it
(see "Count by stage, never by reason" above). Rate-limit it (one per account per hour, say) so a
leaked password cannot flood the inbox. Without a guard the package tells nobody.

**Under concurrency** an attempt already past `admit` when your limit is reached is still judged, but
a right password then meets the deciding `admit` under the account lock, after the failure that
crossed the limit has committed — so no session starts past the limit. The guesses themselves stay
bounded by the route's rate limit (10 a minute per account).

`loginService` and `cancelAccountDeletionService` own their transactions: with a guard configured,
calling them inside one of yours throws, as `checkSecondFactorProof` does — a recorded failure would
roll back with the refusal.

#### Worked example — lock after five, lifted by an administrator

```typescript
// src/server/entities/sign-in-history.ts
import { bigint, boolean, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const signInHistory = pgTable('sign_in_history', {
    id: serial('id').primaryKey(),
    userId: bigint('user_id', { mode: 'number' }),
    channel: text('channel').notNull(),
    stage: text('stage').notNull(),
    result: text('result').notNull(),
    reason: text('reason'),
    ip: text('ip'),
    webProxy: boolean('web_proxy').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
});

export const signInLockLifts = pgTable('sign_in_lock_lifts', {
    userId: bigint('user_id', { mode: 'number' }).primaryKey(),
    liftedAt: timestamp('lifted_at', { withTimezone: true }).notNull(),
});
```

```typescript
// src/server/repositories/sign-in-history.repository.ts
import { BaseRepository } from '@spfn/core/db';
import { and, count, eq, gt } from 'drizzle-orm';
import type { SignInOutcome } from '@spfn/auth/server';
import { signInHistory, signInLockLifts } from '../entities/sign-in-history';

export class SignInHistoryRepository extends BaseRepository
{
    async record(outcome: SignInOutcome): Promise<void>
    {
        await this.db.insert(signInHistory).values({
            userId: outcome.user?.id ?? null,
            channel: outcome.channel,
            stage: outcome.stage,
            result: outcome.result,
            reason: outcome.result === 'failed' ? outcome.reason : null,
            ip: outcome.ip ?? null,
            webProxy: outcome.webProxy,
        });
    }

    /**
     * Failures at the credential stage since the last lift, whatever their reason — read in the
     * package's transaction, under the account lock. Never a list of reasons: `accountDisabled` and
     * `pendingDeletion` are told only for the right password.
     */
    async failuresSinceLift(userId: number): Promise<number>
    {
        const [lift] = await this.db.select().from(signInLockLifts).where(eq(signInLockLifts.userId, userId));
        const [row] = await this.db.select({ n: count() }).from(signInHistory).where(and(
            eq(signInHistory.userId, userId),
            eq(signInHistory.result, 'failed'),
            eq(signInHistory.stage, 'credential'),
            gt(signInHistory.at, lift?.liftedAt ?? new Date(0)),
        ));

        return row!.n;
    }

    /** An administrator's lift: one upsert of the app's own row, no account lock taken. */
    async lift(userId: number): Promise<void>
    {
        const liftedAt = new Date();

        await this.db.insert(signInLockLifts).values({ userId, liftedAt })
            .onConflictDoUpdate({ target: signInLockLifts.userId, set: { liftedAt } });
    }
}

export const signInHistoryRepository = new SignInHistoryRepository();
```

```typescript
// server.config.ts
import { createAuthLifecycle } from '@spfn/auth/server';
import { signInHistoryRepository } from './src/server/repositories/sign-in-history.repository';
// The app's own record of the temporary passwords it issued.
import { temporaryPasswordsRepository } from './src/server/repositories/temporary-passwords.repository';

export const authLifecycle = createAuthLifecycle({
    signIn: {
        admit: async ({ user, channel }) =>
        {
            if (!user)
            {
                return undefined;
            }

            if (await signInHistoryRepository.failuresSinceLift(user.id) >= 5)
            {
                return { refuse: { code: 'LOCKED' } };
            }

            // An expiring temporary password: the app recorded its expiry when it issued it
            // (with passwordChangeRequired), in a table of its own.
            if (channel === 'password' && user.passwordChangeRequired
                && await temporaryPasswordsRepository.hasExpired(user.id))
            {
                return { refuse: { code: 'TEMPORARY_PASSWORD_EXPIRED' } };
            }

            return undefined;
        },
        settled: outcome => signInHistoryRepository.record(outcome),
    },
});
```

The lift is an ops or admin route calling `signInHistoryRepository.lift(userId)` behind
`requireOpsScope` (or a role check). Whether a password reset lifts the lock is yours to decide: a
`password-reset` sign-in reaches `admit` like any other, so the policy above refuses it while locked
— lift on `channel === 'password-reset'` in `admit` if a reset should. The history is the sign-in
list a settings page shows; `ip` is what the request said, `webProxy` whether the proxy vouched for
it.

#### Out of scope

- **A built-in lock policy.** The package stores no attempts; the example above is the policy.
- **Enforcing `passwordChangeRequired`.** A person refused at sign-in could never reach the route
  that clears the flag; enforcement is a restricted session, not a refusal (tracked separately).
- **The address of a sign-in made from a Next.js server action**, which today is the Next server's
  own (tracked separately in `@spfn/core`).
- **Moving `beforeRegister`** onto the lifecycle.

A second `createAuthLifecycle()` that omits `signIn` leaves it as it is; one that states other
functions refuses boot in `afterInfrastructure`, the first statement staying in force meanwhile.
`configureAuth` has no `signIn`: a late call there would replace the guard silently.

### Migration — a sign-in replaces a key only with proof of the old key

**BREAKING.** A sign-in used to count as "the same device swapping its key" when its body named
one of the account's key ids in `oldKeyId`. A key id is not a secret — it is in every request token
and in the device notice — so a password and a known key id were enough to skip the new-device
challenge, silence the owner's notice and take over the step-up window. Only the old private key
can prove a replacement now:

- **`oldKeyId` no longer has any effect** on `POST /_auth/login` and
  `POST /_auth/passkeys/login/verify`. It is still accepted, so an old client is not refused, but
  a sign-in carrying it is a **new device**: an enrolled account answers `202` with a challenge,
  the owner gets `auth.device.registered`, no step-up record moves, and the key it named stays
  live. **A native client that relies on it now keeps its old key live after every sign-in, and
  can receive a `202`**, until it sends `replacementProof`.
- **`replacementProof` replaces it** — a JWT the old key signs, see
  [Registered devices](#registered-devices-key-management). The `@spfn/auth/nextjs/api` proxy
  signs it for you from the sealed session cookie and strips any `oldKeyId` or `replacementProof`
  the browser sent; an app on that proxy changes nothing. **A custom proxy or native client that
  sent `oldKeyId` now gets new-device treatment** until it sends a proof instead
  (`signKeyReplacementProof` in `@spfn/auth/server` is the proxy's own helper). Mobile contract
  0.14.1 declares the field; the supported range does not move.
- **`POST /_auth/keys/rotate` whose old key is no longer live answers `401`** and writes nothing.
  Before, a rotation that lost a race with a revocation still wrote a live key.
- **A key id already registered is `409 KeyIdAlreadyRegisteredError` on every path** — rotation and
  invitation acceptance included, which answered `500` — unless it is a *sign-in* by the same
  account presenting the same public key of a key that is not revoked (a repeated login from one
  device). `keys/rotate` onto a key id the caller already holds — pending, active, the same public
  key or not — is always the `409`, and a key of an ended generation is a revoked key here too.
- **"Recently authenticated" reads `authenticatedAt`**, when a person last proved a credential on
  this device, rather than the key's `createdAt`. A rotation inherits it, so rotating no longer
  makes a stale session look fresh to the [recent-authentication gate](#the-recent-authentication-gate).
- **A key belongs to the account's key generation.** `revokeAllKeys`, a password change or reset,
  an account deletion request and the sign-out-everywhere link move the generation, and
  `authenticate`, `optionalAuth` and clientProofV1 admission refuse a key of an older one. A
  rotation racing "sign out everywhere" therefore writes a key that is dead on arrival. Such a key
  is answered exactly as a revoked one: `401 KeyRevokedError` on the Bearer surface,
  `SESSION_REVOKED` on clientProofV1 (before the proof and the nonce ledger, as a revoked key is).
  The device that asked to sign out the *others* moves into the new generation with the account.

The migration adds `user_public_keys.authenticated_at` (backfilled from `created_at`) and
`user_public_keys.key_epoch` (backfilled from the account's `users.key_epoch`), so every existing
key matches its account and nobody is signed out at deploy. Run it with the release.

### Migration — `secondFactorEnrolmentRequired` on a sign-in

**Mobile contract 0.14.0.** `LoginResult` (and `RegisterResponse`, `MfaVerifyResponse`,
`OauthNativeResponse`, the approved poll, `getAuthSession`) gains an optional
`secondFactorEnrolmentRequired`. It is present, and `true`, only when the app set
`secondFactor: { required: true }` and the account has no listed factor; an app without the policy
never sees it. Check it after narrowing on `mfaRequired`, and send the person to enrolment rather
than into the app:

```typescript
const result = await authApi.login.call({ body: { email, password } });

if (result.mfaRequired)
{
    router.push('/auth/mfa');

    return;
}

if (result.secondFactorEnrolmentRequired)
{
    router.push('/settings/security/enrol');   // the session is real; only enrolment routes answer

    return;
}
```

`authLoginEvent` gains `secondFactorEnrolmentRequired: boolean` — `false` without the policy. The
contract's minor moves to 0.14 (fields the server sends), so its supported range is now
`>=0.14.0 <0.15.0`.

### Migration — a spare passkey is marked under a required policy

**BREAKING (behaviour), only with `secondFactor: { required: true }` and `'passkey'` listed.**
`passkeys/register/verify` used to mark the new passkey only while the account was enrolment-only.
A spare an enrolled account added was stored unmarked: it still signed in on its own, but
`mfa/verify` and `mfa/step-up` refused it as the second factor until the owner also called
`mfa/passkey/mark`. Now every registration with user verification marks it and answers
`mfaStatus` ([above](#enrolling-when-the-account-already-holds-a-credential)). The registration
needed a step-up, recent authentication and user verification already — more than the mark asks
for — so marking there grants nothing the owner could not do one request later. Only the
registration that enrols the account records a step-up; a spare does not refresh the window.

There is **no data migration**: the policy is runtime configuration a migration cannot see, and
marking rows the owner never chose would widen what proves a factor. Passkeys registered before are
repaired by their owner with `mfa/passkey/mark`; `listPasskeys` gives each one `secondFactor` and
`userVerified`, so a settings page offers the mark only where it succeeds
([Managing passkeys](#managing-passkeys)). With `required: false` or no policy nothing changes.

### Migration — narrow a sign-in on `mfaRequired` before reading `userId`

**Breaking in `@spfn/auth` 0.3.0-beta.25 / mobile contract 0.13.0.** A sign-in no
longer always answers with a session. An account that enrolled a second factor and
signs in from a device the account has never seen gets `202` and a challenge
instead, and the key it registered stays inactive until that challenge is spent —
see [Second factor](#second-factor-mfa).

So `LoginResult` carries one new required field, `mfaRequired`, and every field it
carried before is now optional. It is still **one** type rather than a union:
`authApi.login` infers its result from that declaration, and a union would make
every `result.userId` in your app a compile error with no way to narrow it that
was available in 0.12.x. Narrow on the discriminant:

```typescript
const result = await authApi.login.call({ body: { email, password } });

if (result.mfaRequired)
{
    // No session yet. result.challenge is { secret, expiresAtMillis }.
    router.push('/auth/mfa');

    return;
}

console.log(result.userId); // string, from here on
```

The same reshape applies to `authApi.oauthNative` (`OauthNativeResult`), to
`completePasswordReset`, and to the approved branch of `pollDeviceAuth` — which
carries `mfaRequired: false` and can never carry anything else, since a
device-code approval is itself a second factor.

Nothing changes for an account with no second factor: every one of those calls
answers `200` with `mfaRequired: false` and exactly the fields it always did.
In the Next.js proxy nothing changes for your code at all — the interceptors
handle the 202 and the pending cookie themselves.

### Migration — build the sign-out-everywhere and consent screens yourself

**Breaking after `@spfn/auth` 0.3.0-beta.29** ([fxylabs/spfn#108](https://github.com/fxylabs/spfn/issues/108)).
The package renders no HTML. `@spfn/auth/nextjs/server` no longer exports
`createRevokeAllPageHandlers`, `RevokeAllPageView`, `RevokeAllPageHandlerOptions`,
`RevokeAllPageHandlers`, `createOAuth2AuthorizeHandlers`, `OAuth2AuthorizeHandlerOptions`,
`OAuth2AuthorizeHandlers`, its `OAuth2ConsentView` and `OAuth2ConsentScope`, or `escapeHtml`.
The JSON routes behind them are unchanged, and so is the `OAuth2ConsentView` that
`@spfn/auth/server` exports as their response type.

Delete `app/account/revoke-all/route.ts` and `app/oauth/authorize/route.ts` and put a page at
each path, calling `authApi` the way your login and reset screens already do:
[The sign-out-everywhere link](#the-sign-out-everywhere-link) and
[The consent screen](#the-consent-screen) each show one. The consent page takes over the rules
the handler enforced — the login redirect, redirecting only to the API's `redirectUri`, and the
`frame-ancestors 'none'` / `no-store` headers. Its CSRF check needs nothing from you: the proxy
checks the consent POST in every mode, reading that from the route map this package ships.

### Migration — tell a chosen locale from none

**Behaviour change in `@spfn/auth` 0.3.0-beta.31** ([fxylabs/spfn#110](https://github.com/fxylabs/spfn/issues/110)).
`user_profiles.locale` no longer defaults to `'en'`: NULL now means the person never picked a
language, so an app can follow the request's language instead (see `negotiateLocale` in
`@spfn/i18n/next`).

| Where | `locale` | `chosenLocale` (new) |
|---|---|---|
| `AuthContext` / `getLocale(c)` | the choice, or `'en'` — unchanged | `getChosenLocale(c)`: the choice, or `null` |
| `ProfileInfo` (`getUserProfile`, `updateUserProfile`) | the choice, or `'en'` — unchanged | the choice, or `null` |
| `PATCH /_auth/users/locale` | answers the resolved value | answers the stored choice; send `null` or `''` to clear it |

Three things read differently:

- `userProfilesRepository.findLocaleByUserId` returns `string | null` — the stored value, no fallback.
- `updateUserProfile` with `locale: ''` clears the choice instead of storing `'en'`.
- A profile row created without a locale stores NULL instead of `'en'`.

The migration only drops the column default. Rows already stored as `'en'` stay `'en'`, because
a stored value cannot say whether a person picked it. If your app never offered a language
picker, every `'en'` came from the old default, and you can reset them once:

```sql
UPDATE spfn_auth.user_profiles SET locale = NULL WHERE locale = 'en';
```

If it did offer one, leave the rows alone.

A profile registered with `registerAuthProfile` may leave `chosenLocale` out of the principal it
returns; `getChosenLocale` then answers `null`.

### Migration — settings own locale and timezone

**Behaviour change in the `@spfn/auth` release after 0.3.0-beta.51** ([fxylabs/spfn#161](https://github.com/fxylabs/spfn/issues/161)).
`locale` and `timezone` move from `user_profiles` columns to the built-in settings of the same names
(see [per-person settings](#how-do-i-declare-per-person-settings-and-profile-fields)).

**1. Run the migration once, before the first boot on this version.** `pnpm spfn db migrate`
creates `spfn_auth.user_settings` and copies every chosen locale that is not blank, and every
timezone other than `UTC` or blank, into it. `initializeAuth` reads `user_settings` at boot (the
reconcile below), so a process started before the migration fails at boot. Nothing else changes in your
code: `getLocale(c)`, `getChosenLocale(c)`, `PATCH /_auth/users/locale` and `updateUserProfile({
locale, timezone })` answer as before, reading and writing settings. Two differences: an invalid
IANA timezone on the profile PATCH is now a 400 instead of being stored, and anonymizing an account
deletes its settings. A legacy timezone string that is not an IANA zone (the old column took any
string) is copied as it was but reads as `'UTC'` after the move, with one `warn` per read.

The `user_profiles.locale` and `timezone` columns stay for one more release but are **neither read
nor written**: SQL of your own that reads them sees values frozen at the migration. Read
`spfn_auth.user_settings` instead (`value` is JSON: `'"ko"'::jsonb`). The one-off `'en'` reset of
the previous section becomes:

```sql
DELETE FROM spfn_auth.user_settings WHERE key = 'locale' AND value = '"en"'::jsonb;
```

**2. If the app kept its own settings table**, declare those keys with `defineUserSettings`, copy
the rows over, and drop the table. Per key (the values must pass the declared schema; ones that do
not read as the default):

```sql
INSERT INTO spfn_auth.user_settings (user_id, key, value, updated_by_id, created_at, updated_at)
SELECT user_id, '<new.key>', to_jsonb(value), user_id, now(), now()
FROM app.user_settings WHERE key = '<old_key>'
ON CONFLICT (user_id, key) DO NOTHING;
```

Boot's "keys no declaration names" warning tells you about a key you copied but did not declare.

**3. If the app also kept a language of its own**, do not declare it — merge it into `locale`, and
pick which side wins where both have one:

```sql
-- The profile choice wins (the migration already copied it): fill only the gaps
INSERT INTO spfn_auth.user_settings (user_id, key, value, updated_by_id, created_at, updated_at)
SELECT user_id, 'locale', to_jsonb(value), user_id, now(), now()
FROM app.user_settings WHERE key = 'language' AND value IS NOT NULL
ON CONFLICT (user_id, key) DO NOTHING;

-- The app's value wins
INSERT INTO spfn_auth.user_settings (user_id, key, value, updated_by_id, created_at, updated_at)
SELECT user_id, 'locale', to_jsonb(value), user_id, now(), now()
FROM app.user_settings WHERE key = 'language' AND value IS NOT NULL
ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
```

**4. If `profile.metadata` held UI preferences**, move each to a declared setting and declare the
identity fields that stay with `defineProfileFields`:

```sql
INSERT INTO spfn_auth.user_settings (user_id, key, value, updated_by_id, created_at, updated_at)
SELECT user_id, 'ui.theme', metadata -> 'theme', user_id, now(), now()
FROM spfn_auth.user_profiles WHERE metadata ? 'theme'
ON CONFLICT (user_id, key) DO NOTHING;

UPDATE spfn_auth.user_profiles SET metadata = metadata - 'theme' WHERE metadata ? 'theme';
```

**5. Deprecated, removed in the next release:** `ProfileInfo.locale`, `chosenLocale` and
`timezone` (still filled, from settings — the response is unchanged), the `locale`/`timezone`
inputs of `updateUserProfile`, `userProfilesRepository.findLocaleByUserId` (delegates to
`userSettingsRepository.findLocaleByUserId`), and the two columns. Move clients to
`authApi.listSettings` / `setSetting` before then.

### Migration — `SPFN_AUTH_SESSION_TTL` takes effect

**Behaviour change in `@spfn/auth` 0.3.0-beta.33** ([fxylabs/spfn#126](https://github.com/fxylabs/spfn/issues/126)).
Before this release the variable was ignored and every session lasted seven days; it now takes
effect, so an app that had it set gets that lifetime after upgrading. A malformed value (such as
`1w`) is now refused when the environment is validated — by `spfn env validate`, by the server's
boot check when the app lists a registry holding `envSchema` from `@spfn/auth/config`, and
otherwise on the first read — instead of being ignored, so check the value before you deploy.

### Migration — invitation links are hashed and shown once

**Breaking** (w-etq2g). The invitation token is a bearer credential — whoever holds it becomes
the invitee — and it was stored in plaintext and answered by `GET /_auth/invitations` to anyone
holding `user:read`, so an `admin` could accept a pending `superadmin` invitation. Now:

- `user_invitations.token` is gone; `token_hash` stores `hashCredential(token)`. The migration
  backfills the hash of every stored token, so **links already mailed keep working**.
- `listInvitations` answers `InvitationSummary` items with no `token`. A screen that copied the
  link from the list must call `resendInvitation` instead: it answers a new `token` and
  `invitationUrl` once, and the previous link stops working.
- `resendInvitation` and `cancelInvitation` require the authority `createInvitation` requires —
  `user:invite` and the right to assign the invitation's role (now `assertCanChangeRole`; see
  [one permission model](#migration--one-permission-model)).
  `deleteInvitation` is unchanged: `superadmin` only.
- Server API: `createInvitation` and `resendInvitation` return `{ invitation, token }`;
  `resendInvitation({ id, resentBy, expiresInDays? })` takes the caller and refuses an
  `expiresInDays` beyond 30. `invitationsRepository.findByToken` / `findByTokenWithDetails` are
  `findByTokenHash` / `findByTokenHashWithDetails`, taking the hash; `resend(id, expected,
  tokenHash, expiresAt)` and `cancel(id, cancelledBy, reason?)` write only while the invitation
  is still in the state the caller read, and answer `null` otherwise.
- Acceptance, resend and cancel are each one conditional statement: an acceptance in flight when
  a resend or cancel commits is refused (404 / 410) and creates no account; the loser of two
  concurrent resends, or of a cancel racing another change, answers `409 InvitationChangedError`.
- `invitationCreatedEvent` (create and resend) is emitted after the commit, so a rolled-back
  create or resend mails no link.
- An unknown token answers `404 InvitationNotFoundError`; an accepted, cancelled or expired one
  `410 InvitationNoLongerValidError` (`GET /_auth/invitations/:token` answered 500 before,
  `accept` 400).
- `expiresAt` at create is refused beyond 30 days, the bound `expiresInDays` already had.
- `metadata` at create must be a JSON object: `POST /_auth/invitations` answers 400 for an array,
  a scalar or `null`, and `createInvitation` throws `BadRequestError`. Cancel merges its reason into
  the metadata, and an array took it as an appended element. A row stored earlier with non-object
  metadata keeps it under `legacyMetadata` when cancelled, so the result is always an object.

### Migration — per-IP limits count the address a caller cannot choose

**BREAKING** (au9-N3, in `@spfn/core`). Every per-IP limit in this package — sign-in, signup,
codes, `mfa/verify`, password change, deletion, device-code and device-link, the signup and
reset links, invitation acceptance, OAuth 2.1 token and revoke, revoke-all — keys on
`getClientIp` from `@spfn/core/middleware`, and on a request that did not come through the
signed Next.js proxy it used to take the left-most `X-Forwarded-For` value: a caller sending a
new one per request was never limited. The same address is what device provenance
(`registeredIp`), `last_seen_ip` and the access log record; they all read the one function.

Now the backend reads `X-Forwarded-For` only as far as the operator declared proxies in front of
it — `SERVER_TRUSTED_PROXY_HOPS=<hops>` or `defineServerConfig().trustedProxyHops(<hops>)`,
taking the entry that many hops from the right — and otherwise counts the TCP peer. **An API
server behind a load balancer must declare it**, or every direct request (a mobile app, a CLI,
an OAuth client) counts as the balancer's address and shares one per-IP budget.

**Browser traffic through the Next.js proxy** keeps its own client address only when the
backend's proxy-guard mode is `'tag'` or `'strict'`: the proxy signs the address it resolved,
and only a verified signature makes the backend read it. The default mode is `'off'`, so in a
default app every browser request reaches the backend from the Next.js server's address and
every per-IP limit above is per Next.js server, shared by all its visitors. For per-client
limits, turn proxy-guard on (`defineServerConfig().proxyGuard({ mode: 'tag' })` or `'strict'`,
with `SPFN_PROXY_SECRET` set on both sides), or — when your Next.js server's request to the
backend carries an `X-Forwarded-For` naming the client, which the spfn proxy does not send —
declare the hops (`SERVER_TRUSTED_PROXY_HOPS`). This release does not change the default. See
*Client address* in the `@spfn/core/middleware` README.

### Migration — a request token lives at most 15 minutes, and an expired one says so

**BREAKING** (au9-N9). A Bearer request token — the JWT a device signs with its key, `iss`
`spfn-client` — was valid for as long as its key when it carried no `exp`: `jwt.verify` checks
`exp` only when it is there. And an expired token was answered as an invalid one, so a client
could not tell "sign a new token" from "sign in again".

- **A request token must carry `exp` and `iat`, `iat` at most 60 seconds ahead of the server's
  clock, and `exp − iat` at most 15 minutes** (`REQUEST_TOKEN_MAX_LIFETIME_SECONDS`, 900). Every
  first-party signer already signs for 15 minutes — the Next.js interceptors and
  `generateClientToken`'s default. A token without `exp` or `iat`, or signed for longer, answers
  **401 `InvalidTokenError`**.
- **The signer's clock may differ from the server's by 60 seconds**
  (`REQUEST_TOKEN_CLOCK_SKEW_SECONDS`, the conventional JWT leeway): the Next.js signer runs on
  another host. The allowance applies to every comparison with the server's clock — `iat`, `exp`
  and `nbf` — and not to `exp − iat`, which compares the token with itself. Because it applies at
  both ends, the server accepts a token from `iat − 60` until (not including) `exp + 60` by its own
  clock: a window of at most 900 + 2 × 60 = 1020 seconds (17 minutes). A signer whose clock runs
  more than 60 seconds ahead is refused.
- **An expired token answers 401 `TokenExpiredError`** (it answered `UnauthorizedError`
  "Authentication failed"): sign a new token with the same key. A forged, malformed or
  wrong-issuer token answers `InvalidTokenError`; a key past its `expiresAt` still answers
  `KeyExpiredError`. `optionalAuth` continues anonymously on any of them, as before.
- **`verifyClientToken` answers a typed outcome instead of throwing**:
  `{ payload } | { refused: 'token-expired' | 'bad-signature' | 'malformed' |
  'wrong-issuer-or-algorithm' | 'bad-lifetime' }` (`ClientTokenOutcome`). Code that called it
  inside a `try` must switch on `refused` instead.
- **Who must change:** a client that signs request tokens itself — `generateClientToken` with an
  `expiresIn` above `'15m'`, or its own JWT library without `exp` — must sign for at most 15
  minutes. Native clients on the mobile contract sign `clientProofV1` proofs, not these tokens,
  and are not affected. The legacy server-signed `generateToken` / `verifyToken` pair is
  unchanged; no route calls it.

### Migration — every character of a password counts

**Behaviour change** (au9-N5). bcrypt reads at most 72 bytes of its input, and the password
schema counted 72 *characters*: a character is up to four UTF-8 bytes, so a 60-character
Korean password was decided by its first 24 characters. New password hashes are
`bcrypt(base64(sha256(password)))` — 44 ASCII bytes for any password — stored with the prefix
`$spfn-sha256$` ahead of the bcrypt string; `isLegacyPasswordHash` (`@spfn/auth/server`
helpers) is the one decision about which format a stored hash is in.

- **Existing users keep signing in.** A hash without the prefix verifies the legacy way, and a
  successful password sign-in rewrites it in the new format in the sign-in's own transaction:
  verified and re-hashed before the account lock, written under the lock the key write takes,
  and only over the hash that was verified — a password changed meanwhile stays changed. A
  password change whose verified hash such a rewrite replaced meanwhile verifies the current
  password once more against the stored hash instead of refusing it.
  A password change, reset, signup or invitation acceptance writes the new format anyway. Nothing
  ever writes the legacy format back. An account that never signs in keeps its legacy hash.
- **A password of 72 bytes (UTF-8) or more keeps its legacy hash.** bcrypt hashes the password
  plus its NUL terminator, cut at 72 bytes: up to 71 bytes the terminator fixes the length, from
  72 it is cut off and the legacy hash proves only the first 72 bytes. Any password sharing them
  signs in — as before this release — and none of them is known to be the owner's. The sign-in does not rewrite such a hash; a password change
  or reset writes the new format, and from then on every character counts.
- **The password bound is 8–256 characters** (`PasswordSchema`, which invitation acceptance now
  uses too), up from 72. The other rules are unchanged.
- MFA recovery codes are hashed by the same helper, so newly issued ones use the new format;
  existing ones still verify. Their ten base32 characters were never near the 72-byte cut.
- Code that compares `users.password_hash` against `/^\$2[aby]\$/` or verifies it with a bcrypt
  library directly must go through `verifyPassword` instead.

### Migration — the code routes answer alike for every address

**Fix** (au4-A4, au4-B2, au4-A7). The "you already have an account" notice was rate limited by
a never-sent `registration` row in `verification_codes`, and `POST /_auth/codes/verify` read that
row like a code: its attempt count survived a resend that, for an address without an account,
started a fresh code. Send, five wrong codes, send, one wrong code answered "Invalid
verification code" for an unknown address and "Too many attempts" for a known one.

- The notice window has its own table, `spfn_auth.account_exists_notices` (one row per address,
  claimed in one statement); nothing that verifies a code reads it. Run the package migration:
  it creates the table, carries windows still open over, and deletes the old marker rows.
- `sendVerificationCode` with `purpose: 'registration'` stores a code row for every address.
  For an address with an account the row is never sent and can never match, so the verify
  route answers and counts attempts exactly as it does for an address without one.
- The window is keyed on the folded address (trimmed, lower-cased), so `Owner@` and `owner@`
  share it — the signup-link route used to send one notice per spelling.
- Purging an account deletes its address's notice window along with its codes.

### Migration — a code send does not wait for its delivery

**BREAKING** (a12f1-F4). `POST /_auth/codes` sent the code before answering when the address
had no account, and inside the notice window answered at once when it had one: how long the
answer took said which. The code now leaves the way the account-exists notice does — through
`auth.link-mail` when pg-boss is up (`kind: 'verification-code'`, a row id only), otherwise in
this process after the request — so neither branch waits for the mail or SMS provider. This
covers SMS too: the job sends by the row's `targetType`. See [Link mail delivery](#link-mail-delivery).

- **A provider failure no longer reaches the HTTP answer.** An app that read a 5xx from
  `POST /_auth/codes` as "the provider is down" gets 200 now. The failure is observable where
  the other link mails' are: the auth log line (`Failed to send verification code`, and `Link
  mail was not sent on the request path` for an inline send), the `@spfn/notification` history
  row's `failed` status when history is on, and the failed `auth.link-mail` job (retried up to
  three times) when queued. Alert on those.
- With pg-boss initialised, register `authJobRouter` (`.jobs(authJobRouter)`): a code reaches
  the user once the worker picks the job up. An app that wants codes sent by the API process
  without a worker sets `SPFN_AUTH_LINK_MAIL_DELIVERY='inline'`.
- The same applies to the signup link, the reset link and the account-exists notice in `inline`
  mode (and `auto` without pg-boss): they used to be sent before the answer, and are now sent
  after the commit — outside any transaction and any account lock, also when an app calls the
  service inside a transaction of its own.
- The enqueue waits for the commit too. A job is sent on pg-boss's own connection, so enqueued
  inside an app's transaction it could run before the row it names was visible and send
  nothing. Called inside a transaction, the job is enqueued after it commits, and the request
  has already answered 200. An enqueue failure then means: no mail, one log line by kind and row
  id (`Link mail was not queued after the commit`), and the person asks again — except the missing
  queue in `auto`, which sends inline. There is no inline resend otherwise: a "failed" enqueue
  may have reached the queue, and a resend would send the mail twice. A rolled-back transaction
  enqueues and sends nothing. Called outside one, the enqueue runs at once and its failure
  surfaces as before.
- `createAuthLifecycle()` now returns a `beforeShutdown` hook: a graceful shutdown waits up to
  ten seconds for inline sends still running after their request answered, then closes the
  database; what is still running at the bound is logged by kind and row id (`Link mail still in
  flight at shutdown was abandoned`). `settleLinkMail` is that hook. Queued delivery is waited
  for by `@spfn/core` itself: the enqueue is the after-commit callback's own work, core's shutdown
  drain waits for after-commit callbacks, and the queue accepts sends until after `beforeShutdown`
  (the stopping instance's workers only stop fetching), so the job reaches the queue and a live
  instance delivers it. Both waits are inside core's shutdown budget — see [Link mail
  delivery](#link-mail-delivery) for what is logged when the budget ends either one.

### Migration — verification codes: two purposes, deliverable targets; phone signups are verified

**BREAKING** (au4-A9, au4-A13, au1-B8).

- `sendVerificationCode` / `verifyCode` accept `purpose: 'registration'` and
  `purpose: 'account_deletion'` only — the two purposes something consumes (`register` and the
  deletion re-authentication). `login`, `password_reset`, `email_change` and `phone_change` now
  answer 400: nothing ever accepted their tokens, so they only mailed or texted codes to whoever
  was named. `VERIFICATION_PURPOSES` and `VerificationPurpose` shrink to match. A password reset
  is the reset link (`requestPasswordReset`); the `passwordReset` channel no longer covers a code.
- `sendVerificationCode` refuses a target its `targetType` cannot be delivered to with 400
  before anything is stored or sent: a phone target must be E.164 (`+821012345678`). Normalise
  numbers to E.164 on the client. A `registration` email target must be what `register` accepts
  (`EmailSchema`). For every other purpose the target is an account's existing address, which
  may have been stored from an OAuth provider or an invitation with no format check — and a code
  to it is how a password-less account deletes itself — so it is held only to this: exactly one
  `@` between a non-empty local part and a non-empty domain, no control characters (CR/LF among
  them), no whitespace, nothing that makes the address display as another or is invisible — no
  bidi control (`Bidi_Control`: marks, overrides, isolates) and no default-ignorable code point
  (`Default_Ignorable_Code_Point`: zero-width space, soft hyphen, variation selectors) — at most
  254 characters after trimming. ZWNJ and ZWJ (U+200C, U+200D) are the exception: IDNA2008
  allows them inside Persian, Arabic and Indic domain labels, an OAuth sign-up can store such an
  address, and an `account_deletion` code is how a password-less one deletes itself.
  Plus-addressing and internationalised domains are sent a code.
- Signing up with a phone through `register` now stamps `phoneVerifiedAt` — the verified-at
  column of the target the code proved — as an email signup stamps `emailVerifiedAt`. Accounts
  created by phone before this release keep a null `phoneVerifiedAt`.
- `AuthInitOptions.defaultRole` is removed from the config type: nothing ever read it, and
  every signup gets the `user` role. A config that set it was being ignored; drop the key (an
  object literal that still carries it no longer type-checks). Assign other roles after signup
  (`updateUserRole`) or through invitations, which carry their role.
- The route modules `routes/auth`, `routes/users`, `routes/invitations` and `routes/deletion`
  no longer have a default export (it was marked temporary, for file-based routing nothing
  uses); import the named routers, or `mainAuthRouter`.

### Migration — social OAuth: refusals write nothing, one identity per provider, PKCE

**Breaking** (au5, superself w-tfhek). Four changes an app can notice:

- **Unknown policy values refuse at configuration.** `configureAuth` throws, naming the option and
  the values it accepts, for any value outside the declared set: `oauthEmailMatch` (`'Reject'` used
  to read as `'attach'`), `csrf.mode`, a name under `oauthProviders` that is not a provider, an
  option under a provider or under `oauthLink` that does not exist (`signin` for `signIn`), and a
  `signIn` / `recentAuth.link` / `recentAuth.unlink` that is not a boolean (the string `'false'`
  used to leave sign-in on; `0` used to turn the recent-authentication rule off).
  `createAuthLifecycle({ deletion })` refuses a `purgeStrategy` other than `'anonymize'` /
  `'hard-delete'` and an `allowSelfImmediate` / `sendNotifications` that is not a boolean. A
  `configureAuth` call in `server.config.ts` that throws makes the server refuse to start
  (`@spfn/core` stops the boot when `server.config` fails to load), so fix the value before you
  deploy.
- **A second identity of a provider is refused.** `user_social_accounts` gets
  `UNIQUE (user_id, provider)`. A first sign-in whose email matches an account that already holds
  another identity of the same provider is refused — the web error page with
  `reason=provider_already_linked`, native `409 OAUTH_PROVIDER_ALREADY_LINKED`
  (`OAuthProviderAlreadyLinkedError`, mobile contract 0.14.2) — and the account keeps its one link.
  The migration first deletes, for an account holding several rows of one provider, every row but
  the one with the greatest `updated_at` — the row most recently linked, or most recently used to
  sign in on the web flow (a web sign-in stores fresh provider tokens on it; a native sign-in
  leaves the row untouched) — and the greatest `id` breaks a tie. To see the accounts it will
  touch, run this before upgrading:

  ```sql
  SELECT user_id, provider, count(*) AS links,
         array_agg(provider_user_id ORDER BY updated_at DESC, id DESC) AS newest_first
  FROM spfn_auth.user_social_accounts
  GROUP BY user_id, provider
  HAVING count(*) > 1;
  ```

  After an unlink the account holds no identity of that provider, so that identity no longer
  signs in to it.
- **A sign-in that acted on a read another transaction made stale runs once more.** A sign-in
  reads — no link for the identity, no account holding its verified address — and writes on that
  premise. When a concurrent sign-in or sign-up commits the same identity or address in between,
  the write breaks a unique constraint (`users_email_unique`, or the social table's two rules,
  which the link insert meets by writing nothing), the transaction rolls back, and the sign-in
  runs once more against what the other one committed: two first sign-ins of one identity (a
  double click) land on one account, the winner's; a linked sign-in whose address backfill
  waited on someone else's sign-up of that address succeeds without the address. The provider
  is asked once; `beforeRegister` runs once per attempt that makes an account; events fire once,
  for the attempt that committed. A refusal is never retried. Stale on that second run as well,
  it is refused with `OAuthSignInContendedError` (web `reason=sign_in_contended`, native
  `409 OAUTH_SIGN_IN_CONTENDED`, mobile contract 0.14.2); it used to answer a 500 / `reason=failed`.
- **Custom providers declare PKCE (BREAKING for provider authors).** Every authorization-code
  flow now carries PKCE (S256): the start seals a verifier into the state and the package adds
  `code_challenge` to the URL `getAuthUrl` returns; `exchangeCodeForTokens` receives
  `options.codeVerifier` and must send it as `code_verifier`. `OAuthProvider.pkce` is required:
  `'S256'`, or `{ unsupported: true, reason }` for a provider that cannot do it (it then receives no
  verifier). `registerOAuthProvider()` throws, naming the provider, for one that declares neither —
  a provider written in plain JavaScript or against the earlier type, where `pkce` was optional,
  is refused at registration rather than run without PKCE. Add `pkce: 'S256'` once its exchange
  sends `code_verifier`. A sign-in state sealed before the upgrade (it carries no verifier) is
  refused as `invalid_state`; it lives ten minutes.
- **Stored provider tokens are decrypted only where they are used.**
  `socialAccountsRepository.findByProviderAndProviderId`, `findByUserIdAndProvider` and
  `findByUserId` answer `SocialAccountLink` — the row without `accessToken` / `refreshToken` —
  and `create` is gone (`createIfAbsent` answers `null` when either uniqueness rule stands in the
  way). Code that read tokens off a lookup calls `socialAccountsRepository.readTokens(id)`, which
  decrypts them and re-encrypts any under a retired key. A token that no longer decrypts blocks
  only that call, never a sign-in, the link list or an unlink.

Also, without a migration step: a refused web sign-in or link writes nothing (the callback routes
run no `Transactional()`; the services open their own transaction after the provider calls and the
error page is built after the rollback), every provider HTTP call times out after 5 seconds, and a
Naver unlink notification more than five minutes from now is refused.

### Migration — the grant decides what an MCP client may do

**BREAKING** (au6, superself w-fww3c). The OAuth 2.1 authorization server keeps what a client may
do on its grant and nowhere else:

- **Narrowing a consent narrows the tokens already out.** A token's effective scope is its own
  scopes intersected with the grant's current ones, everywhere: `verifyAccessToken` answers it,
  a refresh without `scope` issues it, and a refresh's explicit `scope` may only narrow it
  further — a chain narrowed to `mcp:read` cannot ask for the grant's full set again
  (`invalid_scope`; re-authorize to widen). The same holds across a narrowing of the grant: a
  refresh while the grant is narrowed issues tokens capped at the narrowed set, and widening the
  grant afterwards does not lift that cap — only a new authorization does. (A token not
  refreshed in between keeps the ceiling it was issued with and follows the grant back up.) A
  token left with none is refused (`null` / `invalid_grant`), an explicit `scope` included. A tool that read `scopes` saw what the token was issued with; it now sees
  what the user still allows.
- **Disconnecting is final; reconnecting makes a new grant.** `DELETE /_auth/oauth2/grants/:id`
  revokes the grant, and approving the same client again inserts a new row instead of bringing
  the old one back — a code, access token or refresh token minted before the disconnect stays
  refused. The unique index on `(client, user, resource)` becomes partial (`WHERE revoked_at IS
  NULL`); the migration replaces it. A revocation is recorded on the grant only: `oauth2_tokens.
  revoked_at` is no longer written when a grant is revoked (it still is when an access token is
  revoked on its own through `/_auth/oauth2/revoke`), so judge a token by its grant.
- **A grant lasts 180 days, and its end is stored on it.** A new column, `oauth2_grants.
  expires_at`, is written when the grant is created: creation + `authorizationServer.
  grantLifetimeMs` (default `180 * 24 * 60 * 60 * 1000`, a positive whole number of milliseconds
  or the lifecycle refuses to start). From `expires_at` on the grant is not live: code exchange,
  refresh and verification refuse, the connected apps list (`GET /_auth/oauth2/grants`) no longer
  shows it, disconnecting it answers 404, and the user's next consent revokes it and creates a
  new grant. Re-consenting to a live grant changes its scopes, not its `expires_at`. Changing
  `grantLifetimeMs` applies to grants created afterwards: raising it does not bring a lapsed
  grant (or its tokens) back, and lowering it does not shorten grants already out.
  **The migration backfills existing rows with `created_at + interval '180 days'` — the default
  lifetime, whatever your app configures.** Grants created more than 180 days before the upgrade
  end at the upgrade. If you configured a different `grantLifetimeMs`, update the existing rows
  after migrating if you want it applied to them, e.g. for 90 days:
  `UPDATE spfn_auth.oauth2_grants SET expires_at = created_at + interval '90 days' WHERE revoked_at IS NULL;`
- **`verifyAccessToken` with no authorization server configured answers `null`** (401 on `/mcp`)
  instead of throwing: no token can have been issued by a server that is not configured.
- **A code is spent only by a request that passed every check.** A `resource` that does not
  match is refused `invalid_target` with the code unspent, so the client can retry. Two exchanges
  of one code revoke the grant whether they arrive one after the other or together — the loser of
  a race used to be answered `invalid_grant` and leave the winner's tokens live.
- **`verifyAccessToken` throws what is not a refusal.** `null` is an invalid token; a 4xx
  `HttpError` (today `SECOND_FACTOR_ENROLMENT_REQUIRED`, 403) is a valid token whose person may not
  act now; anything else — a database error — is thrown as it is. `@spfn/mcp` now answers the
  last two with their own status (403 / 5xx) instead of 401, so a passing outage no longer sends
  every client to re-authorize. A custom validator that threw to refuse must return `null`.
- **Required app change: your consent page must append `iss` to the redirect (RFC 9207).** The
  metadata document now advertises `authorization_response_iss_parameter_supported: true`, so a
  conforming client rejects any authorization response on its redirect URI that lacks `iss`.
  The approve response and every redirectable refusal (`access_denied` included) carry it as
  `iss` / `details.iss`. A consent page that builds the redirect from `code` and `state` alone —
  every page written before this release — now hands RFC 9207 clients a response they refuse.
  Add the line to both redirects (the [consent screen](#the-consent-screen) snippets have it):

  ```typescript
  // approve: beside code and state
  url.searchParams.set('iss', issued.iss);

  // a redirectable refusal: beside error and state
  const { error, redirectUri, state, iss } = refusal.details ?? {};
  if (typeof iss === 'string')
  {
      url.searchParams.set('iss', iss);
  }
  ```

  The metadata document also adds `revocation_endpoint_auth_methods_supported: ["none"]`.
- **CSRF is declared on the route, and the package's own declarations do not depend on your
  route map.** The consent decision and `DELETE /_auth/oauth2/grants/:id` declare
  `.csrf('required')`, and the proxy checks them in every mode. For a request that reaches one of
  this package's routes the check reads the declaration from the route map `@spfn/auth` ships,
  whatever the app's generated map says — an app that upgrades without regenerating keeps the
  protection, as do spellings of the path the backend routes the same way (`%61uthorize`,
  `x/../`). Your own routes' `.csrf('required')` still travels in your generated map; regenerate
  it (`spfn codegen run`) after declaring one. A route is checked when either map declares it:
  an entry of the package's map matching the same method and path never removes your route's
  own declaration.

### Migration — a two-step procedure is decided when it completes

**BREAKING.** A TOTP enrolment, a passkey registration, a passkey step-up, a session renewal,
turning session binding off and a social link each start on one request and complete on
another. The authority used to be decided at the start and carried, unrecorded, in the pending
row, the WebAuthn challenge or the sealed link state; at completion the record's existence was
enough. A session the owner had signed out could finish a link, and a session that started an
enrolment before the owner enrolled a factor could confirm it without a step-up (audit au7-A1,
au5-A1, au7-A3, au9-N7).

Every such record now carries a **stamp** — the credential that started it and the account's key
generation then — and every completion passes one function, `admitDeferred`. The stamp names the
credential by kind and identity: a device key by its key id, a session of an application's
registered auth profile (`registerAuthProfile`) by the profile's name and the key id its verifier
reported. At completion the request presents its own credential, which must be the starting one —
the same kind and the same identity (for a device key, or its verified replacement, below) — and
is admitted with it, so its liveness is asked the way `admitPrincipal` asks it for that kind: a
device key by its row, an application profile by its verifier having admitted it on the completing
request. The account's key generation must still be the stamp's, and the person is admitted now
(`admitCompletion`, the same decision as `admitPrincipal`, under the completing route's
`ROUTE_ENROLMENT` class). The link callback has no session: it is admitted with the starting device
key, or its verified replacement. The rule the procedure exists for is asked at completion, against
the account as it is then. What changes:

- **`POST /_auth/mfa/totp/confirm`** confirms only the enrolment this session started. Another
  session of the account, or one whose key generation ended since (a password change, a sign-out
  of every other device — including from this session) gets **`400 MfaNotEnrolledError`**: enrol
  again. An account that enrolled a factor since `totp/enroll` now answers **`403
  STEP_UP_REQUIRED`** at `confirm`; step up and confirm again.
- **`POST /_auth/passkeys/register/verify`** asks step-up and recent authentication again, at the
  verify. A challenge another session asked for, or one of an ended key generation, is
  **`401 PasskeyChallengeError`**. Recent authentication at the verify is the session
  credential's (a device key's `authenticatedAt`; never an application profile's), or a
  `currentPassword` sent to **this ceremony's** `register/options`: that
  proof is recorded on the ceremony's challenge (`password_proven_at`) and read back by its verify
  alone. It does not touch the key's `authenticatedAt`, so it satisfies no other route's recent
  authentication (a social link, turning session binding on).
- **`POST /_auth/mfa/step-up`** with a passkey spends only a `stepUp` challenge this session asked
  `step-up/options` for. A new-device sign-in's challenge (`mfa/verify/options`) is a kind of its
  own, which only `mfa/verify` spends, and `mfa/verify` spends no step-up challenge. See the
  [challenge kinds](#webauthn-challenge-kinds).
- **`POST /_auth/session/renew/verify`** renews only the key the challenge was issued for, and
  **`POST /_auth/session/binding`** (`mode: 'none'`) spends only a challenge this session asked
  `binding/disable/options` for. An assertion that does not verify now **spends** its challenge:
  ask for new options. Both routes no longer run in a route-wide transaction — the spend of a
  failed assertion has to survive the refusal — and their services open their own.
- **The link callback** completes only while the session that started the link — or the key a
  verified re-login replaced it with — is live and of the account's key generation. Otherwise it
  answers `oauthLink=failed`; an account that cannot be let in answers `account_unavailable` as
  before. `oauthLinkCallbackService` answers that outcome instead of throwing the account-status
  errors.
- **A link cannot be started from an application profile's session.** The callback has no session
  in front of it, and an application profile's credential is live only while its verifier admits
  it on a request — so the callback could not ask whether that session still stands. `POST
  /_auth/oauth/:provider/link` from such a session answers **`403
  OAUTH_LINK_CREDENTIAL_UNSUPPORTED`** (`OAuthLinkCredentialUnsupportedError`) before anything is
  sealed. Start the link from a session signed in with a device key.
- **Only a device key or an application profile starts a two-step procedure.** A stamp names one
  of the two; an OAuth 2.1 grant is neither, and a start presented with one answers **`403
  DEFERRED_CREDENTIAL_UNSUPPORTED`** (`DeferredCredentialUnsupportedError`). No `/_auth` route
  admits a grant today.
- **A record made before the upgrade carries no stamp and is refused** — the person starts again.
  No signed-in completion accepts an unstamped record. A step-up or new-device challenge issued
  before the upgrade was of the retired `mfa` kind, which no route spends any more. All of them are
  short-lived: a WebAuthn challenge lives `SPFN_AUTH_PASSKEY_CHALLENGE_TTL_SECONDS` (5 minutes), a link state 10 minutes, and a pending TOTP enrolment until it is confirmed or swept
  (24 hours) — an enrolment pending across the deploy answers `MfaNotEnrolledError` at `confirm`,
  and `totp/enroll` again is the remedy.
- **A verified replacement carries the stamps.** The web proxy replaces its key at every sign-in;
  a procedure started on key A and completed on its verified replacement B (`keys/rotate`, a
  renewal, a sign-in whose `replacementProof` A signed) is the same device. The replacement
  re-points the pending enrolment and the live challenges to B in its own transaction, as it
  carries the step-up window. A sealed link state cannot be re-pointed: the replaced key records
  its successor (`user_public_keys.replaced_by_key_id`), and the callback follows that chain to
  the key live now. A key id merely named is a new device and carries nothing. An application
  profile's stamp is never re-pointed: its key id is its verifier's.
- **Signatures.** Every service that starts or completes such a procedure takes the request's
  credential (`getAuth(c).credential`): `startTotpEnrolmentService(userId, credential)`,
  `startStepUpService(userId, credential)`, `startSessionBindingDisableService(userId, credential)`,
  and a `credential` field on the params of `confirmTotpEnrolmentService`,
  `startPasskeyEnrollmentService`, `finishPasskeyEnrollmentService`, `stepUpService`,
  `checkSecondFactorProof` (an app route that verifies a step-up by passkey passes it in the
  purpose, `{ kind: 'stepUp', credential }`), `disableSessionBindingService` and `startOAuthLinkService`.
  `startRenewalCeremonyService(ceremony, stamp)` takes the ceremony (`'renewal' | 'bindingOff'`)
  and the stamp; `verifyRenewalAssertionService` is `checkRenewalAssertionService({ userId,
  ceremony, credential, response })`, which answers a proof to `spend()` under the account lock in
  the caller's transaction (or null, having spent a failed assertion's challenge);
  `assertRecentAuthentication` answers which half satisfied it (`'key' | 'password'`);
  `keysRepository.revokeForReplacement(keyId, userId, reason, replacedByKeyId)`,
  `mfaTotpRepository.startEnrolment(userId, secretEnc, stamp)`, and the new
  `mfaTotpRepository.repointStamp` / `webauthnChallengesRepository.repointStamps` (both under the
  account lock). `OAuthLinkState` carries `startedByKeyId` and `keyEpoch`. `PrincipalCredential`
  is unchanged: a completion is admitted through `admitCompletion`, which the package entry does
  not export, so no application can claim a completing route's enrolment class.
  `WEBAUTHN_CHALLENGE_KINDS` drops `mfa` and gains `stepUp`, `newDevice` and `bindingOff`.

The migration adds `started_by_key_id`, `started_by_profile` and `key_epoch` to `mfa_totp` and
`webauthn_challenges`, `password_proven_at` to `webauthn_challenges`, and `replaced_by_key_id` to
`user_public_keys`, all nullable and without a backfill. Run it with the release. The mobile
contract does not change.

### Migration — one second-factor check, one failure budget, passkeys judged by what they proved

**BREAKING.** Bundle 6 of the audit (au7-A2, au2-A2, au2-A3 = au7-A4, au7-A5, au7-A7, au7-A8,
au4-A8, au7-B5). A wrong second-factor proof was counted per new-device challenge and not at all at
`mfa/step-up`; "used once" was a value compared in code; and a passkey counted as a second factor
by a method list and a user-verification setting that disagreed. Now:

- **One failure budget per account** ([details](#wrong-proofs-one-budget-per-account)): five
  wrong proofs in fifteen minutes on any route lock the second factor for fifteen minutes —
  **429 `SECOND_FACTOR_LOCKED`** with `Retry-After`, and `auth.mfa.locked` fires once. Handle the
  429 on your confirm and step-up screens ("try again at …", not "wrong code"), and subscribe to
  the event to mail the owner. The per-challenge five-strike rule is gone — a challenge's pending
  key is no longer deleted by wrong proofs, it expires — and so is the per-enrolment confirm
  counter: five wrong confirms no longer discard the pending TOTP secret, they lock like any
  other five. Mobile contract **0.14.4** lists `SecondFactorLockedError` for `auth.mfa.verify`
  (a patch: the supported range does not move).
- **A passkey without user verification is not a second factor**
  ([what a passkey proves](#what-a-passkey-proves)). A new device signed in with one is asked for
  the second factor (202) where it used to sign straight in; `mfa/verify` and `mfa/step-up` refuse
  it; `mfa/passkey/mark` refuses a passkey registered without it (409
  `PASSKEY_USER_VERIFICATION_REQUIRED`), and the enrolment-only registration no longer marks it.
  **PIN-less security keys need a PIN (or a biometric) set up to count** — register them again
  once they have one. A passkey sign-in **with** user verification is exempt from the new-device
  check whether or not it is marked. Passkeys already marked keep their mark (their registrations
  recorded nothing, `registered_user_verified = false`): user verification is a property of each
  assertion, so each use is judged — a marked key used with its PIN still proves the factor, the
  same key used without one does not.

  **An account whose only second factor is such a passkey, on a key with no PIN, is stopped at
  the second factor.** A sign-in on a new device gets the 202 and then 401 at `mfa/verify`;
  `mfa/step-up` answers 401; and every change gated by step-up — unmarking
  the passkey, disabling the second factor, registering another passkey — answers 403
  `STEP_UP_REQUIRED`. This follows from the rule above and stays. The two ways out: **a recovery
  code** (accepted at `mfa/verify` and `mfa/step-up`; the owner can then set a PIN on the key and
  register it again, or enrol TOTP), or **the operator's `resetSecondFactorService(userId)`**, which
  takes every second factor off the account.

  **Find these accounts before you upgrade.** Before the migration nothing records whether a
  passkey's registration verified the person, and afterwards every passkey registered before it
  has `registered_user_verified = false` — so the candidates are the accounts with a live passkey
  marked as their second factor (`passkeys.second_factor` and no `revoked_at`) and no confirmed
  TOTP (`mfa_totp.confirmed_at`); among them, those with no unused recovery code
  (`mfa_recovery_codes.used_at IS NULL` in the newest `generation`) have neither exit of their own:

  ```sql
  SELECT DISTINCT p.user_id
  FROM spfn_auth.passkeys p
  WHERE p.second_factor AND p.revoked_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM spfn_auth.mfa_totp t
                    WHERE t.user_id = p.user_id AND t.confirmed_at IS NOT NULL);
  ```

  Whether a candidate's key has a PIN shows only at its next use. Ask those owners to set one, or
  to save their recovery codes, before the upgrade; after it, a passkey registered again records
  `registered_user_verified = true` when the registration verified the person.
- **`methods: ['passkey']` no longer raises `SPFN_AUTH_PASSKEY_USER_VERIFICATION` to `required`,**
  and `preferred` beside it no longer refuses boot: the variable only says what the browser is
  asked for. Set `required` yourself to refuse unverified passkey sign-ins outright.
- **Step-up records belong to the credential that proved them.** `mfa_verifications` gains an `id`
  primary key and `profile` / `profile_key_id` beside a now-nullable `key_id`: a session of an
  [application profile](#custom-auth-profiles-registerauthprofile) records its step-up as the
  profile and its reported key id (it used to answer 500 at `totp/confirm` and at a successful
  step-up when that key id had no device-key row, and to record on the device key whose id it
  reported). Existing rows are device keys' and keep working.
- **Recent authentication belongs to the credential too** ([the gate](#the-recent-authentication-gate)).
  A profile session whose verifier reported a device key's id was answered as if it had just
  authenticated whenever that device key had: it started passkey registrations, revoked passkeys,
  linked and unlinked social accounts, turned session binding on and requested the account's
  deletion on that key's sign-in. **An application-profile session is now never recently
  authenticated by itself** — `@spfn/auth` has no record of when it authenticated — so those
  routes answer it **403 `RECENT_AUTH_REQUIRED`** unless the body carries the account password
  (`currentPassword`, `password` at `deletion/request`). Turning session binding on reads no
  password, so a profile session cannot turn it on. An app whose profile reported real device
  key ids and relied on the borrowed freshness sends the password, or makes those requests from a
  device-key session.
- **Signatures.** `assertStepUp({ userId, credential })` takes the request's credential
  (`getAuth(c).credential`) instead of `keyId`, and so do `changePasswordService` (`credential`
  replaces `keyId`), `revokeAllKeysService` (a new optional `credential`; the step-up is asked
  only when it is given), `unlinkOAuthService` and `revokePasskeyService` (a new `credential`).
  Recent authentication is asked of the credential as well:
  `assertRecentAuthentication`, `proveRecentAuthentication` and `recentAuthenticationHolds` take
  `{ userId, credential, currentPassword? }` instead of `keyId`; `startPasskeyEnrollmentService`,
  `finishPasskeyEnrollmentService`, `revokePasskeyService`, `startOAuthLinkService` and
  `unlinkOAuthService` no longer take `keyId`, and `enableSessionBindingService` takes the
  `credential` beside it.
  `confirmTotpEnrolmentService` and `stepUpService` no longer take `keyId`.
  `attemptSecondFactor` and `verifySecondFactor` are removed: call
  `checkSecondFactorProof(userId, proof, purpose)` outside any transaction and `spend()` its answer
  under the account lock. `mfaVerificationsRepository.findByKeyId(keyId)` is
  `findFor(userId, credential)`, and `record(keyId, userId, method)` is
  `record(userId, credential, method)`. `verifyTotp` no longer takes `lastUsedStep` — the spend is
  conditional. `mfaTotpRepository.confirm` answers whether it confirmed; `countFailedConfirm`,
  `mfaChallengesRepository.countFailure` / `dropPendingKey`, `MFA_CHALLENGE_ATTEMPT_LIMIT` and
  `MFA_CONFIRM_ATTEMPT_LIMIT` are removed, with the columns `mfa_challenges.attempts` and
  `mfa_totp.failed_confirm_attempts`. `verificationCodesRepository.incrementAttempts(id)` is
  `spendAttempt(id, limit)` and `markAsUsed(id, retainedUntil)` is
  `markAsUsed(id, limit, retainedUntil)`, answering whether it used the code — both conditional,
  so concurrent requests with one e-mail or phone code produce one verification token.
- **`mfa/step-up` has no route-wide transaction any more**, for the reason `mfa/verify` and
  `totp/confirm` never had one: a wrong proof's count has to commit before its refusal.

Run the migration (`spfn db migrate`); it creates `mfa_attempt_budgets`, adds
`passkeys.registered_user_verified` and reshapes `mfa_verifications` in place.

### Migration — one permission model

**BREAKING** (au1, superself w-4grpy). What a person may do now has one answer, and who may give
or take a role has one rule.

- **A deactivated role confers nothing.** `updateRole(callerId, id, { isActive: false })` (`PATCH
  /_auth/admin/roles/:id`) now takes the role from everyone holding it on their next request:
  `getAuth(c).role` is `null`, `requireRole` and `requirePermissions` refuse what only the role
  gave, and `GET /_auth/session` reports no role. The accounts still sign in; reactivating the
  role restores it, and nothing is written to them. Deactivating `superadmin` is refused (409):
  nobody could reactivate it.
- **One resolver.** `resolveAuthority(userId)` answers `{ role, priority, permissions }`, read on
  the primary in one statement: the active permissions of the role in force, plus the person's
  own grants that are of an active permission and unexpired, minus their own unexpired
  revocations. `requirePermissions`, `hasPermission` and the rest, `GET /_auth/session` and the
  Next.js guards all read it, and the role half is the one `authenticate` resolves on the read it
  already makes. Changes you may notice: **`GET /_auth/session` answers `role: null` for an account
  with no role in force** (it answered 404 before) and lists per-user grants and revocations (it
  listed the role's permissions only); a per-user grant of an inactive permission no longer
  applies; an account that is not active holds no authority. Code reading `session.role.name`
  must handle `null`. `usersRepository.fetchActiveRolePermissions` is gone.
- **Role changes follow priority.** A caller gives or takes only roles ranked strictly below their
  own — both the role given and the role the target holds now (its stored role, whatever its
  state or the email-domain policy). Equals cannot change each other. `assertCanAssignRole` is
  replaced by `assertCanChangeRole(callerId, { targetUserCurrentRole, newRole })` — 404 for an
  unknown role, 409 for an inactive one, 403 otherwise — and `roleChangeRefusal(callerId, change)`,
  its non-throwing form. Both take the caller's **user id** and resolve the caller's authority
  themselves, on the primary, inside the writing transaction: call them there, after its lock. No
  function that writes authority accepts an authority resolved beforehand, so a caller demoted
  between the request's guard and the write is refused. The `admin:promote` permission and the
  role-name exceptions are gone. Every path passes it: `PATCH /_auth/admin/users/:userId/role` (now
  `changeUserRole(callerId, userId, roleId)`, judged under the target's account lock), invitation
  create, resend (gives the role) and cancel (takes it), each judged in the transaction that writes
  the invitation, and
  invitation **acceptance**, which re-reads the inviter's authority: an inviter demoted,
  suspended or deleted since, or a role deactivated since, and the invitation answers 410
  `InvitationNoLongerValidError` and creates nothing (it stays pending). That includes invitations
  pending at the upgrade that their inviter could not make under this rule — an admin's invitation
  to `admin`, say: have a superadmin resend them. Consequences:
  - an `admin` can no longer demote another `admin`, nor give `admin`; only a `superadmin` creates
    or demotes an admin;
  - **nobody gives `superadmin` or changes a superadmin through the API**, not even a superadmin —
    new superadmins come from [admin seeding](#admin-seeding);
  - app-defined roles are bound by their `priority` like the built-in ones (an admin, 80, cannot
    give a role of priority 90, nor change the person holding it).
- **Changing what a role is, and a person's own grants, follow the same rule** — a caller changes
  only what ranks strictly below them and confers only what they hold
  (`assertCanChangeAuthority(callerId, change)`, 403 otherwise). `createRole`, `updateRole`,
  `deleteRole`, `addPermissionToRole`, `removePermissionFromRole` and `setRolePermissions` take the
  caller's user id as their first argument, and the admin routes pass the signed-in caller:
  - creating a role, or setting a role's priority, at or above the caller's own priority → 403 (a
    superadmin, 100, can no longer create a role of priority 100 or 101);
  - updating, deactivating or deleting a role, or changing its permissions, when the caller does not
    strictly outrank it → 403. **`DELETE /_auth/admin/roles/:id` of `superadmin` answers 403** (it
    answered 500 with a plain `Error`), and so does every change of the `superadmin` role through
    the API;
  - attaching to a role a permission the caller does not hold → 403, `createRole`'s
    `permissionIds` included. An app permission no role holds therefore cannot be attached at
    runtime until the configuration gives it to a role the operator holds (for example
    `rolePermissions: { superadmin: ['post:publish'] }`);
  - the role service's other refusals are typed: 404 for an unknown role, 409 for a taken name, a
    config-declared role's fields or deletion (`ConfigOwnedRoleError`), deleting a system role, or
    a role still in use (`RoleInUseError`) (they were plain `Error`s, 500).
  Per-user grants and revocations have a service now, under the same rule:
  `grantUserPermission(callerId, userId, permissionId, { expiresAt?, reason? })` and
  `revokeUserPermission(…)` — 403 when the caller does not strictly outrank the person's stored
  role, or (for a grant) does not hold the permission; written under the person's account lock.
- **Ops tokens record their issuer and stop with them.** `ops_tokens.issued_by_id` (migration
  adds it) names the administrator who issued a token, and a token is honoured only while that
  account is active and still holds the new built-in permission **`ops:token:issue`** (granted to
  `admin` and `superadmin`); demoting or suspending the issuer stops their tokens, restoring them
  brings the tokens back. `POST /_auth/ops-tokens` requires `ops:token:issue` (it required the
  `admin` / `superadmin` role) and, for an account with a second factor, a recent step-up
  (`assertStepUp`, 403 `STEP_UP_REQUIRED`). `issueOpsTokenService(name, scopes, expiresAt,
  { userId, credential })` takes the issuer and the credential of their request
  (`getAuth(c).credential`, the one `assertStepUp` asks), and issues under the
  issuer's account lock, reading there their status, `ops:token:issue` and step-up: a suspension
  or demotion that lands after the route's guard leaves no token. Summaries carry `issuedBy`. **Tokens issued before this release
  have no issuer and are refused** — tokens may be non-expiring, so honouring them until expiry
  could mean forever. Re-issue each one after upgrading (`spfn ops token issue`) and revoke the old.
- **A mapping has one owner.** `role_permissions.source` records it, and the rule is stated once,
  in [Who owns a mapping](#how-do-i-define-roles-and-permissions): the configuration's mappings
  equal the configuration after every boot, and the role service changes only the operator's
  (409 `ConfigOwnedMappingError` for one the configuration owns; `setRolePermissions` no longer
  deletes and re-inserts everything as the operator's). **The migration marks every existing
  mapping `config`, and the first boot after upgrading removes every mapping the configuration
  does not declare — including one an operator added before the upgrade.** Before upgrading, list
  them:

  ```sql
  SELECT r.name AS role, p.name AS permission
  FROM spfn_auth.role_permissions rp
  JOIN spfn_auth.roles r ON r.id = rp.role_id
  JOIN spfn_auth.permissions p ON p.id = rp.permission_id
  ORDER BY 1, 2;
  ```

  and re-add the ones your configuration does not declare with `addPermissionToRole` afterwards
  (or declare them in `rolePermissions`).
- **A role has one owner too, and what the configuration declares is restored on every boot.**
  `roles.source` (migration adds it) records it, stated in
  [Who owns a role](#how-do-i-define-roles-and-permissions). The configuration hash
  (`auth_metadata.rbac_config_hash`) is no longer read: every boot upserts each declared role and
  permission, skipping rows already equal, so a config-declared role re-ranked or edited in the
  table is put back. Through the API, **changing a config-declared role's display name,
  description or priority, or deleting it, answers 409 `ConfigOwnedRoleError`**
  (`CONFIG_OWNED_ROLE`, `details.fields`); `isActive` stays the operator's. This replaces the 409s
  for re-ranking or deleting a built-in role. A role the configuration stops declaring becomes the
  operator's. A configured role with no `priority` is now ranked 10 on every boot (an existing
  row's priority used to be kept).
- **Deleting a role never deletes an account.** `users.role_id` referenced `roles` `ON DELETE
  cascade`: `DELETE /_auth/admin/roles/:id` deleted every account holding the role, and every
  invitation naming it. The migration makes both `ON DELETE restrict`, and `deleteRole` answers
  **409 `RoleInUseError`** (`ROLE_IN_USE`, `details: { roleId, accounts, pendingInvitations,
  emailDomainPolicy }`) while an account holds the role, a pending invitation promises it, or this
  instance's `SPFN_AUTH_ROLE_EMAIL_DOMAINS` names it (the next boot would refuse the policy).
  Reassign the accounts (`PATCH /_auth/admin/users/:userId/role`), cancel the invitations and edit
  the policy first. The role's settled invitations and its mappings are deleted with it. Settled
  means what acceptance itself would refuse: accepted, cancelled, expired, **and pending past its
  `expires_at`** — such an invitation is not counted in `pendingInvitations`, whether or not the
  expiry sweep (`expireOldInvitations`) has marked it `expired` yet, so it never blocks a deletion.
- **A role's rank is judged as it is when the change commits.** Every judgement that rests on a
  role — the role given, the target's current role, the caller's own role, a role whose
  definition or permissions change — is locked inside the writing transaction, after the
  account lock, so a re-rank racing an admin's role change waits for it instead of being judged
  on the old priority. The judging functions take role ids: `AuthorityChange.role` is now
  `roleId`.
- **Role locks are taken in one call, in id order.** `rolesRepository.lockInIdOrder` is the one
  way role rows are locked: an operation takes every role it needs there, at once and in
  ascending id — the role it changes `FOR UPDATE`, the roles a judgement reads (the caller's role
  in force included) `FOR SHARE` — and none afterwards. Two role edits whose callers each hold the
  other's role used to be able to deadlock, one answering 500; they now queue. A judgement whose
  premise went stale — the caller's role (at acceptance, the inviter's) changed between the read
  that names it and the lock — is made again by the operation, once, in a new transaction on fresh
  reads (`runJudgedTransaction`): a demoted inviter is the 410 acceptance promises, a caller whose
  role was deactivated a 403. Only a premise stale on that second judgement too answers **409
  `AuthorityContendedError`** (`AUTHORITY_CONTENDED`); asking again resolves it. An app that calls
  `assertCanChangeRole`, `roleChangeRefusal` or `assertCanChangeAuthority` itself opens its
  transaction with `runJudgedTransaction(work, { context })` to get the same retry; inside a
  transaction it opened otherwise, the stale premise is that 409 at once. `POST
  /_auth/invitations/accept` no longer runs under a route-wide `Transactional()`: the acceptance
  service opens its one transaction itself. `assertCanChangeAuthority` now returns the role it
  changed, as locked.
- **What is conferred cannot outlast what the caller holds.** A permission the caller holds only
  through a per-user grant that expires can be granted per user only to expire no later than the
  caller's own grant, and cannot be attached to a role — 403 otherwise
  (`AuthorityChange.conferredUntil`; `Authority.expiringPermissions` lists such permissions).
- **The boot's mapping sync is two statements that say their result**:
  `INSERT … ON CONFLICT (role_id, permission_id) DO UPDATE SET source = 'config'`, then
  `DELETE … WHERE source = 'config'` of what the configuration no longer declares, in one
  transaction holding the mapped roles `FOR SHARE`. Two instances booting together, or an
  operator adding the same mapping, no longer fail a boot on the unique constraint; the role
  service's deletes carry `source = 'admin'`, so a mapping a boot took over meanwhile answers 409
  rather than being deleted. `rolePermissionsRepository.findAllOnPrimary`, `markConfigOwned` and
  `deleteByIds` are gone.
- **One configuration sync at a time, in one transaction.** The role sync, the permission sync,
  the release of roles no longer declared and the mapping sync run in one transaction, which
  first takes a PostgreSQL advisory lock (`rolesRepository.lockConfigSync`): a second instance's
  sync starts only once the first one's has committed. The lock and the sync share that
  transaction's one connection, so a write pool of one connection (`DB_POOL_MAX=1`) boots; it
  used to hang there, the lock's own transaction holding the only connection the sync waited for. **A rolling deploy that boots two configurations side by side ends
  in exactly the configuration of the instance whose sync ran last** — the later boot — and never
  in a mix (an operator-owned role carrying config-owned mappings, for one). A boot waits at most
  30 s for the lock and is then refused with `RbacSyncBusyError`, naming the holder's backend pid,
  application name, client address and since when; restart it once that instance is up. The
  sync locks every existing role it writes or maps in one call, in id order — `FOR NO KEY UPDATE`
  for a role it declares or owns, `FOR SHARE` for one it only maps — the rule operators' role
  changes follow, so an operator's change of such a role queues behind a boot's sync (bounded by
  its own transaction's `statement_timeout`) and never deadlocks with it; a signup naming the
  role does not wait. An operator change that waits behind a boot's sync longer than its own
  `statement_timeout` is cancelled and answered **503** (core maps the cancellation, `57014`, to
  a `ConnectionError`); send it again. Every lock wait of the sync is bounded by the same 30 s
  (`lock_timeout`): a boot that waits that long for a role an operator's change holds is refused
  with `RbacSyncBusyError` too — `details.lock` is `'role'` (`'configSync'` for the sync lock),
  and the message names the backends holding role rows, or says they released them since; start
  the instance again once that change is done. A role the configuration declares that an
  operator creates after the sync read the roles makes the sync start again once, on a fresh
  read. A role the configuration only maps (does not declare) that an operator creates after the
  sync read the roles gets its configured mappings at the next boot. `rolesRepository.findUndeclared`
  is gone; `insertDeclared`, `findRoleLockHolders` and the `noKeyUpdate` strength of
  `lockInIdOrder` are new.

### Migration — the Next.js proxy decides the session once per response

**BREAKING.** Bundle 11 of the audit (au8-A2, A3, A4, A5, A6, A7, A8, A9, au8-B3, au8-dead).
Every proxy rule used to write the session cookies itself, the last write won, and collisions were
patched with a list of paths `generalAuthInterceptor` skipped; the proxy read *why* the backend
refused from the status and the message text. So a fresh sign-in was wiped by a clear of the old,
unreadable cookie that followed it; a wrong current password (any 401) signed the person out; a
seal that failed answered the backend's 200 with no session and an ownerless key; and
`getSession().userId` on a social sign-in was whatever the page posted. Now:

- **One decision per response.** Rules propose — `establish(session)`, `clear(reason)`,
  `refresh(session)` — and `sessionDecisionInterceptor`, first in `authInterceptors`, decides once
  after every other rule: a new session wins over a clear, a clear over a refresh. It writes the
  whole set (session, key id, CSRF, and the pending cookies flows ask for) through one cookie
  writer, which alone decides the attributes. An app that registers its own interceptor and pushes
  this package's cookie names onto `setCookies` is now competing with that decision — propose
  instead.
- **A proxy without the decision fails loudly.** `@spfn/auth/nextjs/api` registers
  `authInterceptors` whole, decision first. A proxy that assembles its own list
  (`createRpcProxy({ disableAutoInterceptors: ['auth'], interceptors: [...] })`) must put
  `sessionDecisionInterceptor` first in it; a rule that proposes on a request the decision is not
  registered for answers **500 `SessionDecisionMissingError`** (code `SESSION_DECISION_MISSING`)
  in place of the response — and a sign-in's new key is revoked as for a failed seal — rather than
  a 200 with no cookie. The individual rules are not exported from any entry of this package, so
  there is no documented way to build such a list; the check covers a bundler that reaches them
  anyway.
- **Only the key-refused family clears the session.** The codes are those the server answers an
  admission refusal with that end a key — `KeyRevokedError` (401: revoked or unknown key, or one
  of an ended key generation), `AccountNotFoundError` (401: the account is gone),
  `AccountDisabledError`, `AccountPendingDeletionError` and `KeyExpiredError` on an unbound
  session — read off the response envelope's `error.code` from the same table the server builds
  its answers from (`server/lib/admission-refusal.ts`). Every other refusal leaves the session:
  invalid credentials, step-up and recent-authentication, second-factor enrolment, CSRF, rate
  limits, `InvalidTokenError`, permissions, every 5xx and a backend that cannot be reached — and
  **core's `UnauthorizedError` itself**, which is what a stale one-time token, an ops-token route,
  a missing `Authorization` header and an app's own `throw new UnauthorizedError(...)` answer. A 401
  `TokenExpiredError` is retried once with a freshly signed request token; a second refusal is
  passed through.
- **A revoked key answers `KeyRevokedError`, a vanished account `AccountNotFoundError`.** Both
  used to answer core's `UnauthorizedError` (messages unchanged: `Invalid or revoked key`,
  `User not found`) and both extend it. A 401 status check still holds everywhere. `instanceof
  UnauthorizedError` holds on the server, and on a client only when that client was given
  `authErrorRegistry`: `authApi` and `createAuthApi` register it themselves, but a client from
  core's `createApi` without it rebuilds these bodies as a generic `ApiError` (status 401), where
  before this release core's own registry restored `UnauthorizedError`. Register it with
  `createApi<AppRouter>({ errorRegistry: [authErrorRegistry] })` (`authErrorRegistry` from
  `@spfn/auth/errors`; core's registry is merged in for an array). Clients that matched the code `UnauthorizedError` to sign the user out must match the
  new codes (the full family is above); `admissionRefusalError` is their only producer. Mobile
  contract 0.14.5 lists both.
- **Every unreadable session cookie is cleared** — expired, sealed under a rotated secret, issued
  for another audience, or malformed (`readSealedSession` answers which). One that was worded
  otherwise used to ride along for its lifetime.
- **A session that could not be written is a failure.** If the seal or the cookie set fails after
  the backend accepted a sign-in, the answer is **500 `SessionSealFailedError`** in place of the
  200, and the proxy revokes the key that sign-in registered through `POST /_auth/logout` signed
  by that key; a revocation that fails too is logged with the key id.
- **`remember` is a boolean.** `true` gives the session `SPFN_AUTH_SESSION_TTL_REMEMBER` (new,
  `30d` by default), absent or `false` the usual `SPFN_AUTH_SESSION_TTL`. The kept lifetime is
  sealed into the session (`SessionData.remember`), so a renewal, rotation or re-seal keeps it.
  **A string (`'30d'`) is refused with 400 `ValidationError`** before any key is made: the client
  no longer sets its own lifetime. `getSessionTtl(override)` is `getSessionTtl({ remember })`.
  It is taken on the request that **starts** a sign-in — `login`, `register`,
  `invitations/accept`, `signup/password`, `password/reset/complete`, `passkeys/login/verify`,
  `oauth/:provider/url`, `device/start/web` and `device/link/redeem/web` — and a sign-in that
  completes later carries it in its own sealed pending cookie: a 202 into `mfa/verify`, a social
  start into `oauth/finalize`, a device start or redeem into its poll. The completing request
  cannot add or change it.
- **`getSession().userId` is the backend's, and only the key's holder learns it.**
  `POST /_auth/oauth/finalize` is authenticated by the key it finalizes: the proxy signs the call
  with the private half the start's pending cookie holds, the route admits it through
  `authenticate` (its door, `oauthFinalizeAuth`, is a registered enrolment gate, so an
  enrolment-only account still completes) and answers **that principal** — a posted `userId` or
  `keyId` is not read for the answer (`keyId` only picks the pending cookie in the proxy). An
  unsigned finalize, or one signed by another key under the key's id, is a 401 that says nothing
  about the key's owner; a pending cookie that is missing, unreadable or holds another key is
  refused by the proxy before the backend is asked. The second-factor 202 (`{ mfaChallenge }`)
  is the one branch with no principal: it only echoes what the page sent.
  `createOAuthCallbackHandler` no longer seals:
  it completes the sign-in through the RPC proxy (`oauthFinalize`, as the browser) and redirects
  carrying the cookies the proxy decided, so a `userId` or binding on the callback query is not
  read. The proxy runs **in-process** — its handler is called with the callback request's own
  cookies, user agent and client address, never over HTTP — so a host behind basic auth or an
  edge the server cannot call back through still completes, and every user keeps their own rate-limit
  bucket. Pass the app's own proxy — `createOAuthCallbackHandler({ rpcProxy: { POST } })`, the
  `POST` your `/api/rpc/[routeName]` route exports — as the normal form: nothing records the proxy
  an app builds, so without it the handler builds one as `createRpcProxy` does with no options
  (`SPFN_API_URL`, `SPFN_PROXY_SECRET`, the registered interceptors, `authInterceptors`), and an
  app proxy with its own `interceptors`, `apiUrl` or proxy secret would finalize through a
  different chain without saying so.
- **Sign-out expires every cookie of this package** — the session three and the pending ones
  (`spfn_mfa_pending`, `spfn_device_pending` with its private key, the sign-up and password-reset
  setup cookies, every OAuth start's) — from one list, `packageCookieNames(jar)`. So do
  `clearSession()` and `clearSessionCookies()`.
- **The guards treat an outage as an error, not a sign-out.** `getAuthSessionData()` answers
  `null` only for the key-refused family (a bound session presented from another browser family
  among them);
  a 5xx, a network failure or `SPFN_AUTH_GUARD_TIMEOUT` running out is thrown, so the app's error
  boundary renders, the cookies stay, and nobody is sent to sign in by an outage. Wrap a guard in
  your error boundary if you rendered a sign-in page for these before.
- **`saveSession` writes the key-id cookie too**, and every cookie this package writes takes
  `Secure` from `SPFN_AUTH_COOKIE_SECURE` — the callback handler, `saveSession` and the
  backend's API-mode OAuth start used `NODE_ENV` directly, so a sign-in on an HTTP staging host
  set cookies the browser dropped. The attributes have one definition
  (`server/lib/cookie-attributes.ts`, free of Next.js), read by the proxy's writer and the
  backend's alike.
- **Removed:** `interceptors/authentication.ts` (registered nowhere), the
  `nextjs/interceptors/cookie-options` module, `pushCsrfCookie`, `pushCsrfCookieIfStale` and
  `pushCsrfCookieRemoval` (internal), and the `proxyWroteError` metadata flag. The paths
  `generalAuthInterceptor` skips are now only the routes that authenticate nobody (sign-in, codes,
  `exists`, second-factor verify, the browser device-login routes); none is on the list to protect
  a fresh session any more.

**Every sign-in retires the browser's previous key of the same account.** The session decision
does it, not each sign-in path: whenever it writes a new session it reads the request's session
cookie itself (the same unseal that decides a clear) and, when that cookie unseals, is the same
account's by the backend's answer and holds another key, revokes that key once the new session is
written — the same `POST /_auth/logout` sign-out makes, signed by the previous session. A social
sign-in (`oauth/finalize`, and `mfa/verify` after its 202), a device-link or device-code sign-in
(the approving poll), a password reset and every other establishing path are covered alike,
including any added later. Another account's session is left alone, as are the sessions invitation
acceptance and sign-up completion replace (they create a new account). A password or passkey
sign-in with the replacement proof ([above](#migration--a-sign-in-replaces-a-key-only-with-proof-of-the-old-key)),
`keys/rotate` and a renewal have the backend revoke the previous key itself, and their answers do
not say so; the proxy's sign-out then answers `KeyRevokedError`, which is read as "already gone"
and not logged. Any other failure is logged with the key id and the sign-in stands.

**What a failed seal leaves.** When the session cannot be written after the backend accepted a
sign-in, the proxy revokes the new key (500 `SessionSealFailedError`). If that sign-in had already
replaced the previous key on the backend — a password or passkey sign-in with the replacement
proof, `keys/rotate`, a renewal — the previous key is gone too: the browser holds neither, and the
person signs in again.

**What is unchanged.** The key-id cookie (`spfn_session_key_id`) is still the plain key
id: nothing reads it for a decision — the replacement proof is signed from the sealed session.
The proxy-guard default stays `'off'`.

### Migration — an expired bound key is a dead key

**BREAKING.** Session binding stated "this key is dead" two ways — revocation as `is_active = false`,
expiry as a comparison — so a statement that rewrote `expires_at` revived an expired key, and the
account setting's effect was patched onto key rows one at a time (audit au3-A1, au3-A4, au3-A5,
au3-B8). What changes:

- **Turning binding off** (`POST /_auth/session/binding { mode: 'none' }`) no longer gives every
  bound key ninety days. Only a bound key not yet expired becomes an ordinary 90-day key; one
  already expired — inside its renewal grace or past it — is revoked (`revokedReason`
  `Bound key expired when session binding was turned off`). The owner's other browsers whose bound
  session had already expired sign in again after binding is turned off.
- **Turning binding on** binds every live web key of the account, not only the caller's: the
  account's other browser sessions get a bound key's short life at once and must renew with the
  passkey at their expiry. Native and device-code keys are untouched.
- **`POST /_auth/logout`** answers 204 and revokes the key for a bound session whose key has
  expired but is inside its grace (it answered 401 `KeyExpiredError` and left the key renewable).
  The Next.js proxy clears the session cookies on a sign-out the backend answered 401 too; on a
  5xx or a network failure it keeps them and the user retries.
- **`auth.mfa.sweep`** also revokes bound keys past their grace.
- **`registerPublicKeyService`** takes `webProxy?: boolean` (from `deviceProvenance(c).webProxy`)
  instead of `binding`: whether a key is bound is decided inside it, under the account lock. An app
  that called it directly with `binding` passes `webProxy` instead.
- **`keysRepository.updateLastUsedById`** takes an optional fourth argument, `webProxy`; binding is
  decided apart from it.
- **Schema.** `spfn_auth.user_public_keys.via_web_proxy` (boolean, default false). The migration
  sets it on every key already bound and on every key whose `last_seen_ip` is set — that column is
  written only from a request `proxy-guard` attested as the proxy's, so a stored address means the
  key's last recorded use came through it. `client_kind` is not used: the proxy never forwards
  `x-spfn-client-kind`, so `ios` / `android` marks a key a native SDK used directly, and it stays
  false. A key neither signal classifies (not used since `last_seen_ip` existed, or last used
  without an attested address) stays false until its first request through the proxy, which sets
  the flag. On a bound account, every use of an unbound web key binds it (`bindWebKeyService`,
  under the account lock, tried again at the next use if it fails): the request is served and the
  key is asked for a passkey at its next expiry. A copied cookie only works through the proxy that can
  unseal it, so a legacy web session cannot be used without being bound.
- **`KeyExpiredError` says whether the key can be renewed** (`details.renewable: true` for a bound
  key inside its grace; absent otherwise), and the Next.js proxy decides on that rather than on the
  cookie's `binding`: a session whose key was bound after its cookie was sealed gets the renewal
  prompt at its expiry instead of being signed out. (Since bundle 8 part 2 the cookie carries no
  copy of the binding at all — see below.)
- **`keys/rotate` through the proxy** registers the new key as a web key, as a sign-in through the
  proxy does (`rotateKeyService` takes `webProxy`).
- **A bound account shows a passkey to let another credential in.** `device/approve`,
  `device/link/issue`, `passkeys/register/verify`, `PUT /_auth/password` setting a first
  password, `oauth/:provider/link` and `POST /_auth/oauth2/authorize` (approve) answer 403
  `PASSKEY_PROOF_REQUIRED` on an account with session binding on unless the body carries
  `passkeyResponse` — an assertion over `POST /_auth/session/passkey-proof/options { procedure }`
  (`provePasskey(api, procedure)`). A second factor or the password does not satisfy it. Accounts
  without binding are unchanged. A native approver of a bound account cannot approve a
  device-code sign-in (the passkey ceremony is not on the mobile surface; contract 0.14.6 lists
  the code): approve from a browser.
- **A passkey proves the person or it proves nothing here.** Every renewal-grade assertion —
  `session/renew/verify`, `POST /_auth/session/binding { mode: 'none' }` with a passkey, and the
  passkey proof of the procedures above and of turning binding on — needs `userVerified` in the assertion, whatever
  `SPFN_AUTH_PASSKEY_USER_VERIFICATION` says (bundle 6's rule for a second factor), and their options
  ask the browser for it (`userVerification: 'required'`); sign-in keeps the configured value. **A security
  key with no PIN cannot renew a bound session**: set a PIN or a biometric on it, or turn binding
  off with the password. Without user verification renewal answers `SessionRenewalRefusedError`,
  binding-off `RecentAuthenticationRequiredError`, a proof `PASSKEY_PROOF_REQUIRED`.
- **Turning binding on asks the passkey proof** (`bindingEnable`), of every account: `POST
  /_auth/session/binding { mode: 'passkey' }` answers 403 `PASSKEY_PROOF_REQUIRED` unless the body
  carries `passkeyResponse` — `provePasskey(api, 'bindingEnable')` — with user verification, which
  is what every renewal of the bound session will ask. An account with no passkey that can give it
  (none at all, or only one without a PIN) is refused rather than bound and locked out by its own
  setting; the former 400 for an account with no live passkey is this 403.
- **`POST /_auth/ops-tokens` asks the passkey proof too** (`opsTokenIssue`) on an account with
  session binding on: an ops token outlives every key. `spfn ops token issue`, which signs in with
  the password, is refused 403 for such an account; issue from a browser holding the passkey.
- **`device/link/issue` takes a JSON body** (`{}`, or `{ passkeyResponse }`); a request with no
  body is refused 400.
- **`device/approve`, `device/link/issue` and `passkeys/register/verify` run no route-wide
  transaction**; the services open their own, so a failed assertion's spent challenge commits.
  `issueDeviceLinkService` takes a second argument (`{ credential, passkeyResponse }`), and
  `approveDeviceAuthService` takes `credential`.

### Migration — a bound session's browser family is checked by the backend, against the key row

**BREAKING.** Bundle 8 part 2 of the audit (au8-A1, au8-B2). The Next.js proxy compared the
request's `user-agent` family with a `uaFamily` sealed in the session cookie and let a request
without the header through, on the premise that a server component's call sends none. Node's
`fetch` sends `user-agent: node`, so every server-rendered page of a bound account was refused and
sent to sign-in; and a session bound on the server (at its first use through the proxy, or by the
owner turning binding on elsewhere) had a cookie saying unbound, so the check never ran for it.
Now:

- **The backend compares, at admission, against the key row.** When a bound key
  (`binding = 'passkey'`) is admitted, the family of the request's `user-agent` must equal the
  row's `registered_ua_family`; otherwise **401 `SessionContextChangedError`** — the same code
  (`SESSION_CONTEXT_CHANGED`), status and class as before, now answered by the backend. It is in
  the key-refused family (`server/lib/admission-refusal.ts`), so the proxy's session decision
  clears the three session cookies on it and `getAuthSessionData()` answers `null`, as for a
  revoked key. An absent `user-agent` is the family `other`, compared like any other value — there
  is no "no signal" exception and no exception for Node's string. Every door that admits a bound
  key for its own request compares: `authenticate` (and `oauthFinalizeAuth`, which runs it),
  `optionalAuth` (a refusal is the anonymous caller there), the clientProofV1 profile, and
  renewal (`session/renew/*` answer their one `SessionRenewalRefusedError`). A one-time token is
  compared where it is minted (`POST /_auth/tokens`, behind `authenticate`), not where it is
  redeemed. **Sign-out is not compared**: a thief ending the owner's session does no harm, and the
  owner ending it from a changed browser must work.
- **`@spfn/core`'s server-side client forwards the browser's `User-Agent`** with its cookies, from
  the inbound request (`next/headers`), unless the caller set the header; outside a request scope
  (build, a job) nothing is added and a bound session is refused there — there is no browser.
  **This needs the matching `@spfn/core` release.** A custom server-side caller that reaches the
  RPC proxy or the backend without the SPFN client must forward the browser's `User-Agent` itself,
  or a bound session is refused. `createOAuthCallbackHandler`'s in-process finalize already
  forwards the callback request's headers, and `ctx.callBackend` re-sends the proxied request's.
- **`registered_ua_family` is the value the check reads.** It is written at registration, copied
  by rotation and by renewal, and never overwritten. A passkey renewal fills it from the renewing
  request **only where the row has none** — a key that predates the column, or was registered
  without a `user-agent`; **such a bound key is admitted unchecked until that renewal**.
  `startSessionRenewService` / `finishSessionRenewService` take `userAgent` (the renewing
  request's); a renewal no longer re-derives the family from the old row's `user-agent` string.
- **Keys registered through a server-side hop recorded Node's family.** Before this release a
  sign-in completed through the SPFN client on the server (a server action or route handler
  calling `login`, `register`, `signup/password`, `password/reset/complete`, `invitations/accept`,
  `passkeys/login/verify` or a device poll) sent `user-agent: node`, so its key recorded `other`
  and would now refuse the real browser; renewal and rotation carried the value on. **The migration
  `20261116140755_clear_server_hop_ua_family` sets `registered_ua_family` to `NULL` wherever it is
  `other`, on every key, bound or not**, and those rows then follow the rule above: unchecked until
  the next passkey renewal records the renewing request's family. No list of server-client
  user-agents can tell such a row from a real one; what is certain is that a browser of the
  five-badge table never reads as `other`. A browser that genuinely reads as `other` gets it
  recorded again at that renewal. Rows of any other family are untouched.
- **The session cookie carries no binding copy.** `SessionData.binding`, `keyExpiresAt` and
  `uaFamily` are gone: nothing read them once the decisions moved to the key row (`KeyExpiredError`'s
  `renewable` for renewal, admission for the family). A cookie sealed earlier still unseals and the
  fields are ignored. With them go `bindingSessionFields`, `sessionBindingInterceptor` (the re-seal
  after a binding change, which had nothing left to write) and its 500 `SessionResealFailedError`
  (the class stays exported, and nothing answers it), and the proxy's `contextChanged` /
  `refuseAsContextChanged`. `ClearReason` loses `context-changed` and `reseal-failed`; `refresh()`
  loses its `changed` argument.
- **Admission takes `presentedOn`.** `AdmitPrincipalParams` gains `presentedOn: { userAgent } | null`
  (`presentingRequest(c)` builds it), and `AdmissionRefusal` gains `{ reason: 'contextChanged' }`.
  `admitBearerPrincipal(c, key, presentedOn)` takes the third argument; `authenticateBearer(c, next,
  presentedOn)` is `authenticate`'s Bearer path, exported for sign-out.
- **An expired key is answered by admission, after the signature and after the family.** The
  Bearer step (`admitBearerKey(c)`, which loses its `admitsExpired` argument; `BearerOutcome` and
  `BearerRefusal` lose `expired`) no longer answers expiry: it verifies the signature and hands a
  live or expired key to `admitPrincipal`, whose order is account → revoked → **family** → expired
  → second factor. So an expired bound key presented from another browser family answers **401
  `SessionContextChangedError`** (cookies cleared), not the renewal prompt; from its own family it
  is the renewal prompt as before. A request for an expired key whose signature does not verify
  (none, or a wrong key's) now answers **401 `InvalidTokenError`**, as for a live key, instead of
  `KeyExpiredError` — the expired answer told anyone holding a key id that the key was expired and
  renewable. An expired key whose account is refused answers the account's refusal. Per door, for
  an expired bound key from another family: `authenticate` → `SessionContextChangedError`;
  `optionalAuth` → the anonymous caller, as for any key that is not live (unchanged); renewal →
  `SessionRenewalRefusedError` (unchanged); sign-out → admitted and revoked (unchanged, not
  compared); the clientProofV1 profile → `SESSION_REVOKED` at its first step, before the proof, by
  the contract's order (unchanged — it never had a renewal answer).

### Invitations

An invitation lets an account with `user:invite` bring someone in with a role ranked below its
own (`assertCanChangeRole`); acceptance checks again that the inviter still could. The token in the link is a bearer credential, so it is treated like every other link
credential (`mintCredential` / `hashCredential`): 32 random bytes, stored only as a hash.

| Route | Who | Answers |
|---|---|---|
| `POST /_auth/invitations` | `user:invite` + outranks `roleId` | `{ id, email, token, roleId, expiresAt, invitationUrl }` — the only answer that carries the token |
| `GET /_auth/invitations` | `user:read` | `{ invitations: InvitationSummary[], total, page, limit, totalPages }` — no token, no hash |
| `POST /_auth/invitations/resend` | `user:invite` + outranks the invitation's role | `{ expiresAt, token, invitationUrl }` — a new token; the old link stops working |
| `POST /_auth/invitations/cancel` | `user:invite` + outranks the invitation's role | `{ cancelledAt }` |
| `POST /_auth/invitations/delete` | `superadmin` | 204 |
| `GET /_auth/invitations/:token` | public | what the acceptance page shows; 404 / 410 as below |
| `POST /_auth/invitations/accept` | public | the new account; 404 / 410 as below |

- **Mail the link from `invitationCreatedEvent`.** Its `token` (with `isResend` on a resend) is
  the secret; no route returns it again.
- **Resend reissues.** It mints a new token for a pending or expired invitation and replaces the
  stored hash, with a fresh expiry (`expiresInDays`, at most 30). It never extends an old link.
- **`expiresAt` and `expiresInDays` share one bound**, 30 days.
- Refused with 403 and nothing changed: a caller whose role does not outrank the invitation's
  role, for resend and cancel as for create (404 for an unknown role, 409 for an inactive one on
  create and resend).
- **Acceptance re-checks the inviter.** An invitation whose inviter has since been demoted,
  suspended or deleted, or whose role was deactivated, answers 410 and creates no account; it
  stays pending, for another manager to resend. So does one demoted while the acceptance is being
  judged: the acceptance is judged again on fresh reads, never answered with a retry message about
  the inviter's role.

| Error | HTTP | When |
|---|---|---|
| `InvitationNotFoundError` | 404 | the token names no invitation — never issued, replaced by a resend, or deleted |
| `InvitationNoLongerValidError` | 410 | already accepted, cancelled, or expired, or its inviter can no longer give its role (the message says which) |
| `InvitationChangedError` | 409 | a resend or cancel found the invitation changed by another request since it read it; nothing was written |
| `AuthorityContendedError` | 409 | create, resend, cancel or **accept**: the role of the person judged (the caller; the inviter at acceptance) changed under the judgement, and again when it was judged once more — a single change is judged again on fresh reads and answers what it finds (410 for a demoted inviter); `code: 'AUTHORITY_CONTENDED'`, nothing was written, ask again |

### Verified-email signup

A second way in, alongside the six-digit code. The address is proven before a password
exists, so nothing is stored for someone who never confirms.

```
request  → a one-time link is emailed
confirm  → the link becomes a short-lived, HttpOnly password-setup session
password → the account is created, the device registered, the user signed in
```

The six-digit-code path (`sendVerificationCode` → `verifyCode` → `register`) is unchanged.
Offer whichever suits your product, or both.

**1 — request the link.** The response is identical whether or not the address already has
an account, so it cannot be used to probe for accounts. When one exists, the owner gets a
"you already have an account" notice instead of a usable link — at most once an hour per
address, a window this route shares with `sendVerificationCode` and keys on the address
trimmed and lower-cased, so writing it in another case does not send another notice.

```typescript
await authApi.requestSignupLink.call({
    body: { email: 'user@example.com', returnPath: '/welcome' },   // returnPath optional
});
// → { success: true, expiresAt }
```

Calling it again is how a resend works: it invalidates the previous link and any setup
session opened from it. `returnPath` must be a path inside your app — absolute URLs,
`//host`, and `..` are refused, so the link cannot become an open redirect.

The mail leaves through the `auth.link-mail` job when pg-boss is initialised — register
`authJobRouter` — so neither branch of this endpoint waits on a mail provider; see
[Link mail delivery](#link-mail-delivery).

**2 — the page the link opens.** The email points at a page in *your* app
(`SPFN_AUTH_SIGNUP_CONFIRM_PATH`, default `/signup/confirm`), not at an API route. That page
reads the token from the query string and posts it:

```typescript
'use client';

const token = useSearchParams().get('token');

const { email, returnPath } = await authApi.confirmSignupLink.call({ body: { token } });

// Drop the token from the URL so it does not linger in history or a Referer header.
window.history.replaceState({}, '', window.location.pathname);
```

The setup session comes back as an HttpOnly cookie — the proxy interceptor moves it there
and strips it from the response body, so page script never holds it. Serve this page with
`Referrer-Policy: no-referrer`.

**3 — set the password.** This is the step that creates the account. The setup cookie
authorizes it; the device keypair is injected by the interceptor exactly as it is for
`register`.

```typescript
await authApi.completeSignup.call({ body: { password } });
// → { userId, publicId, email }  + session cookie, same as register
```

Creating the user, registering the device key, and marking the setup session used all commit
together. A password that fails the strength policy leaves the session usable, so the user
retypes rather than requesting a fresh email.

**Settings.**

| Variable | Default | Meaning |
|----------|---------|---------|
| `SPFN_AUTH_SIGNUP_LINK_TTL_MINUTES` | `30` | how long the emailed link works |
| `SPFN_AUTH_SIGNUP_SETUP_TTL_MINUTES` | `15` | how long the password-setup session works |
| `SPFN_AUTH_SIGNUP_CONFIRM_PATH` | `/signup/confirm` | the page in your app the link opens |

The link URL is built on `NEXT_PUBLIC_SPFN_APP_URL || SPFN_APP_URL`, the same resolution the
OAuth callbacks use. Delivery uses the `signup-link` template in `@spfn/notification` —
override it there to change the copy.

**What is stored.** Only SHA-256 hashes of the link token and the setup secret, in
`spfn_auth.signup_link_tokens`. Neither credential is recoverable from the database, and
both are one-time: a link opens one setup session, and a setup session sets one password.

### Password reset (verified email)

The way back into an account whose password is gone, using the address the account already
proved. Same three steps as the signup above, and the same posture on the two credentials.

```
request  → a one-time link is emailed
confirm  → the link becomes a short-lived, HttpOnly password-setup session
complete → the new password is written, every other device is signed out, this one is signed in
```

**Who can reset.** An `active` account with no deletion pending whose `emailVerifiedAt` is set
**or** that already has a password. The second half is what makes the rule work on accounts
created before the column was stamped: both register paths proved the address at signup. An
OAuth-only account whose provider reported the address unverified has neither and is excluded —
for it, a reset would be a way in built on an address nobody proved.

**An account pending deletion is not reset.** It is recovered first, through
`/_auth/deletion/cancel` with a one-time code sent to its own e-mail or phone — no password
needed — and reset once it is back. The reset request answers it as it answers every input (no
mail, the same body), because a different answer would tell a stranger the address has an
account; the pointer to the code path is in the deletion notice the account was sent instead.

**1 — request the link.** The response is identical for every input — same status, same two
fields, same `expiresAt` arithmetic — and mail goes only to an account that can be reset, so
neither the answer nor the mailbox reveals whether an address has an account here.

```typescript
await authApi.requestPasswordReset.call({
    body: { email: 'user@example.com', returnPath: '/account' },   // returnPath optional
});
// → { success: true, expiresAt }
```

Calling it again is how a resend works: it invalidates the previous link and any setup
session opened from it. `returnPath` must be a path inside your app — absolute URLs,
`//host`, and `..` are refused, so the link cannot become an open redirect.

The mail leaves through the `auth.link-mail` job when pg-boss is initialised — register
`authJobRouter` — so an address with an account and one without cost the same; see
[Link mail delivery](#link-mail-delivery).

**2 — the page the link opens.** The email points at a page in *your* app
(`SPFN_AUTH_PASSWORD_RESET_CONFIRM_PATH`, default `/password/reset`), not at an API route.
That page reads the token from the query string and posts it:

```typescript
'use client';

const token = useSearchParams().get('token');

const { email, returnPath } = await authApi.confirmPasswordReset.call({ body: { token } });

// Drop the token from the URL so it does not linger in history or a Referer header.
window.history.replaceState({}, '', window.location.pathname);
```

The setup session comes back as an HttpOnly cookie — the proxy interceptor moves it there
and strips it from the response body, so page script never holds it. It is a cookie of its
own, not the signup one, so neither secret is ever accepted by the other flow. Serve this
page with `Referrer-Policy: no-referrer`.

**3 — set the new password.** The setup cookie authorizes it; the device keypair is injected
by the interceptor exactly as it is for `login`.

```typescript
await authApi.completePasswordReset.call({ body: { password } });
// → { userId, publicId, email }  + session cookie, same as login
```

**Every other device is signed out.** Completing a reset denies every pending device
authorization and revokes every active key, exactly as `changePassword` does — whoever was
signed in on the old password, including the person the reset was needed for, has to sign in
again. The browser that performed the reset is signed in on a fresh key registered after the
revocation, so it does not have to retype the new password. `emailVerifiedAt` is stamped if
it was not already, `passwordChangeRequired` is cleared, and `auth.password.reset` is emitted
after commit.

The new hash, the revocations, the new device key and the completion mark commit together. A
password that fails the strength policy leaves the session usable, so the user retypes rather
than requesting a fresh email.

**Settings.**

| Variable | Default | Meaning |
|----------|---------|---------|
| `SPFN_AUTH_PASSWORD_RESET_LINK_TTL_MINUTES` | `30` | how long the emailed link works |
| `SPFN_AUTH_PASSWORD_RESET_SETUP_TTL_MINUTES` | `15` | how long the password-setup session works |
| `SPFN_AUTH_PASSWORD_RESET_CONFIRM_PATH` | `/password/reset` | the page in your app the link opens |

The link URL is built on `NEXT_PUBLIC_SPFN_APP_URL || SPFN_APP_URL`, the same resolution the
signup link uses. Delivery uses the `password-reset` template in `@spfn/notification` —
override it there to change the copy.

**What is stored.** Only SHA-256 hashes of the link token and the setup secret, in
`spfn_auth.password_reset_tokens`. Neither credential is recoverable from the database, and
both are one-time: a link opens one setup session, and a setup session sets one password.
A separate table from `signup_link_tokens`, so a signup secret can never address a reset row.

### Device-code login

A way in for a device that has a screen but no comfortable keyboard — a TV, a console, a CLI
on a headless box. The new device shows a short code; the account owner types that code on a
device that is already signed in.

```typescript
// On the new device — it has no key on file, so this call is public.
const { deviceCode, userCode, expiresAtMillis, intervalMillis } =
    await authApi.startDeviceAuth.call({ body: {
        publicKey, keyId, fingerprint, algorithm: 'ES256',
        deviceName: 'Living room TV', platform: 'desktop',
    } });

// Show `userCode` (XXXX-XXXX) on this device's screen, then poll every intervalMillis.
const answer = await authApi.pollDeviceAuth.call({ body: { deviceCode } });
// → { status: 'pending', intervalMillis }
// → { status: 'approved', userId, publicId, email?, phone?, passwordChangeRequired }
```

Behind the Next.js proxy a browser can be the waiting device. It starts on its own route,
`device/start/web`, which takes no key material — the proxy makes the key there and seals the
session on the approved `device/poll`, exactly as it does for [device link](#device-link):

```typescript
const started = await authApi.startDeviceAuthWeb.call({ body: {} });
// show started.userCode, then poll until the owner answers
let answer;
do answer = await authApi.pollDeviceAuth.call({ body: { deviceCode: started.deviceCode, waitMillis: 20_000 } });
while (answer.status === 'pending');
// approved: the proxy has sealed the session cookie
```

`device/start` itself is unchanged for a CLI or a TV that sends its own key, and the two routes
share one rate limit.

Or long-poll: send `waitMillis` and the server holds a pending request until the owner
answers or the wait runs out, so the device learns of an approval the moment it is made
instead of at its next tick.

```typescript
let answer;

do
{
    // Held up to 20s (the server's maxWaitMs caps it). A pending answer takes the time
    // already waited off intervalMillis — 0 after a full wait, so ask again at once.
    // An error ends the loop, as before.
    answer = await authApi.pollDeviceAuth.call({ body: { deviceCode, waitMillis: 20_000 } });

    if (answer.status === 'pending' && answer.intervalMillis > 0)
    {
        await new Promise(resolve => setTimeout(resolve, answer.intervalMillis));
    }
}
while (answer.status === 'pending');
```

Keep the loop's sleep on `intervalMillis > 0`. It covers a server that answered without
waiting — an older one that ignores the field — so the loop never spins.

```typescript
// On the signed-in device — the user typed the code they read off the other screen.
const asking = await authApi.getDeviceAuthInfo.call({ body: { userCode } });
// → { deviceName?, platform?, fingerprintPrefix, requestedAtMillis, expiresAtMillis }

await authApi.approveDeviceAuth.call({ body: { userCode } });   // or denyDeviceAuth
```

**There is no token handed over, because there is no token.** Every request in this system is
signed by the calling device's own key, so "logging a device in" means getting its public key
into `user_public_keys` under the right account — which is exactly what the winning poll does.
That is why the approved answer is the same shape `login` returns: from the client's side the
two ways in are indistinguishable.

- **Only ever show the code on the new device's screen.** The whole attack on this flow is
  someone sending a victim a code and asking them to approve it — a support call, a chat
  message, a "verify your account" email. A code that arrived any way other than off the
  device in front of you is an attack. This is why `info` and `approve` answer with the
  requesting device's name, platform and fingerprint prefix, and why an approval screen that
  shows only the code is doing it wrong: it is asking the user to confirm a number they were
  just told.
- **The device code is stored only as a SHA-256 hash**, like the ops-token and signup-link
  secrets. It is returned once. A dump of `spfn_auth.device_authorizations` does not let its
  reader finish anyone's login.
- **The user code is stored in the clear, and that is fine** — it authorizes nothing without
  an approver who is already signed in. It is drawn from an alphabet with no `0`/`O` or
  `1`/`I`/`L`, since it is read off one screen and typed on another.
- **A decision is made once.** Approve and deny move the record from `pending` and nowhere
  else, so a second approval, a deny after an approve, or two approvals racing each other all
  get `DeviceAuthAlreadyHandledError` (409) — a refusal is never undone.
- **The approval is one-shot.** The poll that registers the key spends the record in the same
  statement that reads it, so of two polls arriving together exactly one registers the key and
  the other is answered as if the code were unknown.
- **A spent code and a code that never existed answer identically** (`DeviceAuthNotFoundError`,
  404). Saying "that one was real, but it is used up" is the difference between guessing at
  random and knowing a guess landed. Every route that accepts a code is rate limited for the
  same reason: `start` and `poll` per IP, `info` / `approve` / `deny` per IP *and* per calling
  account.
- **Expiry outranks state.** A code that sat past its TTL is expired whatever it says, so an
  approval nobody collected in time registers nothing. The TTL travels in the statement that
  moves the record, not only in the read before it, so a code cannot be spent by a poll that
  read it a moment before it died.
- **A global revocation reaches the codes too.** `revoke-all`, a password change and a
  deletion request each refuse the account's live device authorizations, so an approval nobody
  collected cannot register a fresh key seconds after the user signed everything out — which
  would hand one back to exactly the device they were cutting off.
- **An approval holds only while the approving key does.** The approval records the key the
  approver signed it with, and the poll that collects it is spent only while that key is still
  live — the rule a device link's issuing key is held to, in the same statement. Revoking that
  key, logging that device out or rotating its key withdraws what it approved: the poll answers
  `DeviceAuthExpiredError` and registers nothing. An approval the approving device can no
  longer stand behind is not one the waiting device may collect.
- **The poll re-checks the account.** It is a login, so it admits the account through
  `admitPrincipal` (on the approving key) and refuses a suspended or pending-deletion account
  with `AccountDisabledError` / `AccountPendingDeletionError`, as passkey and OAuth sign-in do
  (password sign-in answers a refused account as a wrong password; a device code is not a guess). Approval and collection are separate moments, and
  what the account is when the key is registered is what counts.
- **`start` bounds what it stores.** It is the one route that takes key material from a caller
  who cannot authenticate, so `publicKey`, `keyId` and `fingerprint` carry length limits —
  generous next to a real key (an RSA-2048 SPKI is 392 base64 characters against a 2048 limit)
  and small next to the megabyte that would otherwise sit in a table no job clears.
- **A long poll holds no transaction.** The wait is route middleware in front of the poll's
  `Transactional()`, so a waiting device does not pin a pooled connection, and the answer is
  judged inside the transaction exactly as a poll without `waitMillis` is — same atomicity,
  same database-error answers. Approve, deny and a global revocation wake a poll parked in the
  same process after they commit. A poll parked on another instance re-reads its record every
  second, so an approval committed elsewhere reaches it within about a second. A device that
  hangs up mid-wait is not judged, so an approval it can no longer hear waits for its next poll;
  at most three polls wait on one code at a time — a fourth is answered at once; and a server
  that starts shutting down ends every wait with a pending answer rather than a cut connection.
- **Clock skew cannot affect this.** Every timestamp in the decision is the server's. The
  `expiresAtMillis` in the start response is for the waiting device's countdown display, and
  nothing the client believes about the time reaches the server's judgement.

Three knobs, resolved at lifecycle time rather than read per call — the first two are
announced to the waiting device in the start response:

```typescript
createAuthLifecycle({
    deviceAuth: {
        ttlMs: 10 * 60 * 1000,   // how long a code lives. default 10 minutes
        intervalMs: 5000,        // poll interval the server asks for. default 5s
        maxWaitMs: 20_000,       // longest a long poll is held. default 20s
    },
})
```

Keep `maxWaitMs` under the idle timeout of every proxy and load balancer in front of the
server. A long poll cut off by one reaches the device as a network error, not as a pending
answer — Google Cloud's load balancer closes a backend request at 30 seconds by default.

No job sweeps the table. Rows are judged by `expiresAt` whenever they are read or moved, so a
stale row authorizes nothing; it only keeps its user code out of circulation, and 31⁸ codes do
not run out.

### Device link

Device-code login the other way round: the device that is already signed in shows the code,
and the new one reads it. This is the natural way onto a phone — the signed-in device is a
laptop with a screen, and the phone has a camera. The signed-in device (the *issuer*) asks for a
code and shows it, as text and as a QR its own client draws. The new device reads it, sends it
with its fresh public key, and shows a two-digit number. The issuer is shown the new device and
three numbers, and taps the one on the new device's screen. The new device's next poll is its
login.

```typescript
// On the signed-in device — the issuer. Every call below is signed with its key.
const { linkId, userCode, expiresAtMillis } = await authApi.issueDeviceLink.call({});

// Show `userCode` (XXXX-XXXX) as text and in a QR code, then wait for a device to use it.
let link;

do
{
    // Held up to 20s while nobody has redeemed the code (deviceAuth.maxWaitMs caps it).
    link = await authApi.getDeviceLinkStatus.call({ body: { linkId, waitMillis: 20_000 } });
}
while (link.status === 'issued');
// → { status: 'redeemed', deviceName?, platform?, fingerprintPrefix, redeemedAtMillis,
//     choices: [37, 82, 15], expiresAtMillis }

// Show the device and the three numbers; the person taps the one on the new device.
await authApi.confirmDeviceLink.call({ body: { linkId, choice: tapped } });
// or authApi.denyDeviceLink.call({ body: { linkId } }); closing the screen:
// authApi.cancelDeviceLink.call({ body: { linkId } })
```

```typescript
// On the new device — it has no key on file, so both calls are public.
const { deviceCode, matchNumber, expiresAtMillis, intervalMillis } =
    await authApi.redeemDeviceLink.call({ body: {
        userCode,                          // read from the QR, or typed
        publicKey, keyId, fingerprint, algorithm: 'ES256',
        deviceName: 'Pocket phone', platform: 'ios',
    } });

// Show `matchNumber` large ("tap 37 on your computer"), then long-poll as device-code does.
let answer;

do
{
    answer = await authApi.pollDeviceLink.call({ body: { deviceCode, waitMillis: 20_000 } });

    if (answer.status === 'pending' && answer.intervalMillis > 0)
    {
        await new Promise(resolve => setTimeout(resolve, answer.intervalMillis));
    }
}
while (answer.status === 'pending');
// → { status: 'approved', userId, publicId, email?, phone?, passwordChangeRequired }
```

**A web browser can be the new device too.** Behind the Next.js proxy the page holds no key, so
it redeems on its own route, `device/link/redeem/web`, whose body is the user code alone:

```typescript
const redeemed = await authApi.redeemDeviceLinkWeb.call({ body: { userCode } });
// show redeemed.matchNumber, then poll until the issuer picks
let answer;
do answer = await authApi.pollDeviceLink.call({ body: { deviceCode: redeemed.deviceCode, waitMillis: 20_000 } });
while (answer.status === 'pending');
// approved: the proxy has sealed the session cookie
```

The proxy makes the key pair on that call, sends its public half with `platform: 'web'`
(overwriting any key material the page sent), and keeps the private half in an HttpOnly pending
cookie that lives as long as the device code. On the approved poll it seals the session from that
cookie and expires it, so the browser is signed in as the issuer. The mobile `device/link/redeem`
is unchanged — a mobile app or a CLI still sends its own key there, and the proxy passes it
through — and the two routes share one rate limit, so a second route does not double the budget
for guessing codes. The pending
cookie names the device code it was made for: a poll from a browser that did not redeem that code
— no pending cookie, or one for another code — is refused 401 (`SessionPendingExpiredError` or
`SessionPendingMismatchError`) and seals nothing, and the device it parked has still been
registered, so it appears on the account's key list until it is revoked.

The approved answer is the one `pollDeviceAuth` and `login` return, produced by the same
completion — account status checks, key registration, the login event — so a client cannot tell
which way in it took. Its key is registered under the issuer's account with channel
`device-link` on `auth.device.registered`.

| state ↓ call → | redeem | status | confirm | deny | cancel | poll |
| --- | --- | --- | --- | --- | --- | --- |
| issued | → redeemed | `issued` | 409 NotRedeemed | 409 NotRedeemed | → expired | — |
| redeemed | 404 | device + `choices` | right number → approved; wrong → denied (`wrong_match`) + 400 WrongMatch | → denied (`refused`) | → expired | `pending` |
| approved | 404 | `approved` | 409 AlreadyHandled | 409 AlreadyHandled | 409 AlreadyHandled | login, → consumed |
| denied (`wrong_match`) | 404 | `denied` | 409 AlreadyHandled | 409 AlreadyHandled | 409 AlreadyHandled | 400 WrongMatch |
| denied (`refused`) | 404 | `denied` | 409 AlreadyHandled | 409 AlreadyHandled | 409 AlreadyHandled | 403 Denied |
| consumed | 404 | `consumed` | 409 AlreadyHandled | 409 AlreadyHandled | 409 AlreadyHandled | 404 |
| dead (TTL, cancelled, replaced, issuer signed out) | 400 Expired | 400 Expired | 400 Expired | 400 Expired | 400 Expired | 400 Expired |
| unknown, or another key's link | 404 | 404 | 404 | 404 | 404 | 404 |

Error names are `DeviceLink` + the cell: `DeviceLinkNotFoundError` (404),
`DeviceLinkExpiredError` (400), `DeviceLinkWrongMatchError` (400), `DeviceLinkDeniedError` (403),
`DeviceLinkNotRedeemedError` (409), `DeviceLinkAlreadyHandledError` (409). A consumed link stays
404 to the new device after its TTL, for device-code login's reason.

A denied link records why in `denied_reason`, and only the new device's poll reads it: a wrong pick
answers `DeviceLinkWrongMatchError`, with a message written for the new device, so its screen can say
the numbers did not match; a refusal answers `DeviceLinkDeniedError`. The issuer's `status` answers
`denied` for both — it already heard `DeviceLinkWrongMatchError` from its own confirm. A link denied
before `@spfn/auth` 0.3.0-beta.39 has no reason recorded and answers as a refusal.

- **Single use.** A code is redeemed once, by one device: redeem moves the link from `issued` and
  nowhere else, so of two devices sending the same code exactly one parks its key, and the other
  is told the code does not exist. The approval is collected once, the same way: of two polls
  arriving together, one registers the key and the other gets 404.
- **Five-minute TTL.** A link code lives 5 minutes (`deviceLink.ttlMs`). Every decision uses the
  server's clock, carried into the statement that moves the link; `expiresAtMillis` is for the
  countdown on screen and nothing else. Issuing again from the same device expires the previous
  link, so there is one live link per issuing key.
- **Only the issuing key can confirm.** Status, confirm, deny and cancel are bound to the key that
  signed `issue` — not merely the account. Another device of the same account, or another account,
  is answered 404, exactly as for a link that never existed. The link also dies with that key: once
  it is revoked, signed out or past its own expiry, every call on the link answers expired — and
  confirm and the poll that registers the key re-check the issuing key inside the statement that
  moves the link, under a lock on the key row, so a sign-out landing at the same moment is never
  read around. A global revocation (`revoke-all`, even the kind that spares the calling device, a
  password change, a deletion request) expires the account's links as well.
- **The match number, and its limit, stated plainly.** Redeem answers the new device with a number
  from 10 to 99; the issuer is shown it among two other distinct numbers, in an order fixed when the
  code was redeemed. The number is what ties the device the issuer is looking at to the device that
  redeemed the code: someone who read the code off the issuer's screen redeems it on a phone the
  issuer cannot see, so the issuer has no number to match. **A person who taps without looking at
  the new device picks the right number one time in three.** That is the whole of the odds, because
  one wrong pick denies the link — there is no second try, and the new device is told the numbers did
  not match. Typing the number would be stronger; three to tap is the trade taken for a flow people
  finish.
- **The new device's key is registered only after a confirm.** It is parked in
  `spfn_auth.device_links`, not in `user_public_keys`, until the poll after the right pick moves it
  over. A key parked on a link that was denied, cancelled, or expired can never sign anything and
  can never be collected.
- **A redeemed, spent or never-issued code answer alike** (`DeviceLinkNotFoundError`, 404), so a
  guesser cannot learn a code was real. A code that died of age answers 400.
- **Rate limits.** `issue` per account (10/min, and 50/min per IP); `redeem` and `poll` per IP
  (10/min and 30/min); `status` per account (30/min, 150/min per IP) and `confirm` / `deny` /
  `cancel` per account (10/min, 50/min per IP) — the device-code policies' sizes.
- **The device code is stored only as a SHA-256 hash**, returned once, as in device-code login.
  Nothing in the flow logs a user code, device code, match number or key.
- **Long polls hold no transaction.** Both `status` (the issuer, while the link waits on the other
  device) and `poll` (the new device, while it waits on the pick) take `waitMillis` and wait exactly
  as the device-code poll does: ahead of the transaction, capped at `deviceAuth.maxWaitMs`, at most
  three requests waiting on one link, a re-read every second for a change committed on another
  instance, every transition waking both after commit, and a shutdown ending every wait with the
  current answer.
- **`redeem` bounds what it stores** exactly as `device/start` does — it is the other route that
  takes key material from a caller who cannot authenticate.

One knob of its own; the poll interval and long-poll cap are `deviceAuth`'s:

```typescript
createAuthLifecycle({
    deviceLink: {
        ttlMs: 5 * 60 * 1000,   // how long a link code lives. default 5 minutes
    },
})
```

The mobile contract carries the new device's half — `auth.deviceLink.redeem` and
`auth.deviceLink.poll`, since contract 0.13.2; since 0.13.3 the poll answers a wrong pick with
`DeviceLinkWrongMatchError` rather than `DeviceLinkDeniedError`. The issuer's five routes run on the
signed-in device and are not on that surface.

### Registered devices (key management)

A [passkey](#passkeys-webauthn) is **not** one of these keys: it is a credential that proves
identity at sign-in, after which an ordinary device key is registered exactly as a password
login registers one.

Keys are per-device, so a login never revokes another device's key and they accumulate on purpose.
`listKeys` / `revokeKey` / `revokeAllKeys` are what let the account owner see what accumulated and
cut off anything they no longer recognise.

A key still waiting on a [second factor](#step-up-on-a-new-device) is in neither list. It
cannot sign for anything, so it is not a device; and nobody signed it out, so it is not a
revoked one either. A global revocation deletes it outright rather than revoking it.

```typescript
const { keys } = await authApi.listKeys.call({ body: {} });
// → [{ keyId, deviceName?, platform?, algorithm, fingerprintPrefix, createdAtMillis,
//      lastUsedAtMillis?, expiresAtMillis?, isExpired, isActive, revokedAtMillis?,
//      registeredIp?, registeredUserAgent?, binding?, concurrentUseAtMillis? }]

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

> **All three key-management operations are POST with their arguments in the body, deliberately.** The mobile auth
> profile (clientProofV1) signs the request body, and `canonical-json` fixes exactly how those
> bytes are written. A `GET` has no body to sign, and a value in the path has no such rule —
> client and server could disagree on the signed string over percent-encoding, a trailing
> slash, or a proxy rewrite alone, and the request would be refused with nothing in the logs
> naming the cause. Proof-bearing auth operations are shaped this way; the unproven,
> bodyless `core.time` synchronization prerequisite is the explicit exception.

- **A key must be the type its algorithm names.** A P-256 SPKI declared `RS256`, an RSA key
  declared `ES256`, and a curve other than P-256 declared `ES256` are each refused 400 with
  `KeyAlgorithmMismatchError` on register, login, rotate and device start — the algorithm is
  stored beside the key and read back at proof verification, so a mismatch accepted at
  enrollment would surface only once the device already believed it was enrolled.
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
- **It also refuses device-code approvals still in flight**, in both modes, because an approved
  code is a key that has not been handed out yet: the next poll would register a fresh active one
  and undo the sign-out. `revokedCount` still counts keys only — a code nobody collected was
  never a session. See [Device-code login](#device-code-login).
- **A key id you do not own answers 404** (`KeyNotFoundError`). Every lookup is scoped by user, so
  the answer is only ever "not yours" and reveals nothing about other accounts.
- **Revocation takes effect immediately.** `authenticate`, `optionalAuth` and clientProofV1
  admission read the key and the account status from the database on every request with no cache
  in front of it, and they read the write primary: a read replica (`DATABASE_READ_URL`) does not
  delay a revocation or a suspension, nor refuse a key registered a moment ago.
- **Revocation closes the key's live streams, after commit.** Every path that revokes a key —
  `revokeKey`, `revokeAllKeys`, `logout`, a password change or reset, an account deletion request,
  the sign-out-everywhere link, and the replacements (rotation, session renewal, a re-login whose
  `replacementProof` the old key signed) — ends in the keys repository, which calls `closeConnectionsByKey` from
  `@spfn/core/event` for each revoked key once the transaction commits (at once outside one;
  never after a rollback). The SSE streams and WebSockets that key opened close on every pod (a
  socket with code `1008`, reason `Key revoked`), and a token it
  minted before the revocation is refused at open: every one-time token is issued tagged with
  the key that asked for it (`/_auth/tokens`, and the core SSE and WS token endpoints), and the
  token manager admits its subject on that key (`admitPrincipal` — key live, account active,
  read on the primary) when the token is consumed. A device whose key was
  replaced reconnects with the new one; a signed-out device's token mint answers 401 and its
  client stops. An app that shares the manager with `.events()` or `.websockets()`
  (`tokenManager: () => getOneTimeTokenManager()`) gets this with no change. A failed close is
  logged by count and never fails the revocation.
- **`includeRevoked: true` shows what was already cut off**, with `revokedAt`. The default is only
  keys that can still sign.

Every path that registers a key (`register`, `login`, `rotateKey`, native OAuth) accepts optional
`deviceName` (≤64 chars) and `platform` (`ios` / `android` / `web` / `desktop`). Both are display
only — nothing is authorized by them — and both are absent on keys registered before they existed.
Rotation carries the replaced key's label over unless the client sends a new one.

- **`registeredIp` and `registeredUserAgent` are where the device came from**, captured once from
  the request that registered the key and never updated — a device that later signs requests from
  another network still shows the address it appeared from, which is what makes an entry the owner
  does not recognise recognisable. Both are absent when the request resolved neither and on keys
  registered before the columns existed; the literal string `unknown` is never stored. They are
  unauthenticated display material, spoofable on any request that does not come through a verified
  proxy, so render them and decide nothing by them. Mobile contract 0.11.0.
- **`binding` says the key is tied to a passkey**, and is absent on every key that is not — which
  is every key on an account that did not turn [session binding](#session-binding) on. A bound key
  expires in hours and only a passkey assertion renews it.
- **`concurrentUseAtMillis` is when this key was last seen from two addresses at once**, inside
  `SPFN_AUTH_CONCURRENT_USE_WINDOW_MS`. Absent when that has never been observed, which is the
  ordinary state. A signal to show, never a refusal — addresses change legitimately — and the
  addresses themselves are never returned. Meaningful only where proxy-guard is configured. Mobile
  contract 0.12.0.

All three are in the mobile contract (0.4.1) as `auth.keys.list` / `auth.keys.revoke` /
`auth.keys.revokeAll`, so a generated mobile client reaches them the same way it reaches key
rotation.

A `keyId` is **single-use for its lifetime**: it is unique across all users and is never reissued
once revoked. A client that logs out, rotates, or is revoked must generate a **fresh keypair and
`keyId`** for its next sign-in — resending the old one is refused with
`KeyIdAlreadyRegisteredError` (409), on every path that registers a key — sign-ins, `rotateKey` and
invitation acceptance alike. Re-registering a key that is still active, by the same account and with
the **same public key**, is the one exception: it stays a no-op success, so repeated logins from the
same device keep working, and an expired-but-active key has its expiry extended by the sign-in that
proved the identity again. The same id with any other public key is the 409.

#### Replacing a device's key

A sign-in that arrives at a device already holding a session key **replaces** that key — the old
one is revoked, the step-up window carries across, no device notice is sent and no new-device
challenge is asked — only when the **old private key** proves it. Naming the old key is not enough:
a key id is in every request token and in the device notice. The proof is `replacementProof` in
the sign-in body (`login`, `passkeys/login/verify`), a JWT:

| part | value |
|------|-------|
| `alg` | the old key's algorithm (`ES256` or `RS256`), signed with its private key |
| `iss` | `spfn-key-replacement` — never `spfn-client`, so a request token is not a proof and a proof is not a request token |
| `purpose` | `key-replacement` |
| `oldKeyId` | the key being replaced — it must be this account's and still live |
| `newKeyId` | the `keyId` this same request registers |
| `iat` | within the last 60 seconds **by the server's clock**, and at most 10 seconds ahead of it — whatever `exp` says |

The Next.js proxy signs it from the private key in the **sealed** session cookie and deletes any
`oldKeyId` or `replacementProof` the browser sent; a native client signs it with the key it holds
(`signKeyReplacementProof` from `@spfn/auth/server` does it for a custom proxy). A proof that is
absent, malformed, expired, made by another account's key or a revoked one, or for another new key
is **not an error**: the password (or passkey) was proved, so the sign-in goes ahead as a **new
device**, and the answer does not say whether the named key exists. So is a proof signed by a key
that is no longer live — revoked, expired, or of an ended key generation: a key `authenticate`
refuses vouches for nothing. `oldKeyId` is still accepted and has no effect.

The old key is revoked by the same statement that checks it is still live, so a replacement never
outlives a revocation that committed first. `rotateKey` is signed by the old key already — the
request is the proof — and is **refused with 401** when that key is no longer live, writing no key.

Each key records when a person last proved a credential on it (`authenticatedAt`): a sign-in sets it
to now, a `rotateKey` inherits it. Each key also belongs to the account's **key generation**:
every global revocation moves the account's, `authenticate` refuses a key of an older one, and a
replacement inherits the old key's — so a rotation racing "sign out everywhere" writes a key that is
dead on arrival.

### The sign-out-everywhere link

The key operations above all need a session, which is exactly what an owner who no longer trusts
the device in front of them does not want to use. `createRevokeAllLink` mints a one-time link your
app mails to the address the account has already proved; opening it signs every device out with no
session at all.

```typescript
import { createRevokeAllLink } from '@spfn/auth/server';

const { url, expiresAt } = await createRevokeAllLink(userId);          // default TTL 30 minutes
const short = await createRevokeAllLink(userId, { ttlMinutes: 10 });
```

**The link opens a page in your app** (`SPFN_AUTH_REVOKE_ALL_CONFIRM_PATH`, default
`/account/revoke-all`), not an API route — the same shape the signup and reset links use. The
package ships no HTML: you build that page with your own components, the way you build the login
and reset screens. It calls two public endpoints, `confirmRevokeAllLink` to describe the link and
`consumeRevokeAllLink` to press the button, both with the token from the query string in the body.

```tsx
// app/account/revoke-all/page.tsx — a server component
import { authApi } from '@spfn/auth';
import { RevokeAllButton } from './revoke-all-button';

export default async function RevokeAllLinkPage({ searchParams }: { searchParams: Promise<{ token?: string }> })
{
    const { token } = await searchParams;

    // Describing the link changes nothing, so a mail scanner that prefetches the
    // page has signed nobody out.
    const described = token
        ? await authApi.confirmRevokeAllLink.call({ body: { token } }).catch(() => null)
        : null;

    if (!token || !described)
    {
        return <p>This link cannot be used. Request a new one from the mail you received.</p>;
    }

    return <RevokeAllButton token={token} {...described} />;
}
```

```tsx
// app/account/revoke-all/revoke-all-button.tsx
'use client';
import { useState } from 'react';
import { authApi } from '@spfn/auth';

interface RevokeAllButtonProps
{
    token: string;
    expiresAt: string;
    activeKeyCount: number;
}

export function RevokeAllButton({ token, expiresAt, activeKeyCount }: RevokeAllButtonProps)
{
    const [revokedCount, setRevokedCount] = useState<number | null>(null);
    const [failed, setFailed] = useState(false);

    async function signOutEverywhere()
    {
        await authApi.consumeRevokeAllLink.call({ body: { token } })
            .then(answer => setRevokedCount(answer.revokedCount), () => setFailed(true));
    }

    if (revokedCount !== null)
    {
        return <p>Signed out of {revokedCount} device(s).</p>;
    }

    return (
        <main>
            <p>
                {activeKeyCount} device(s) are signed in to your account. This link stops working at{' '}
                <time dateTime={expiresAt}>{expiresAt}</time>.
            </p>
            {failed && <p>This link cannot be used any more. Nothing was changed.</p>}
            <button onClick={signOutEverywhere}>Sign out everywhere</button>
        </main>
    );
}
```

- **Opening the page signs nobody out.** The page only calls `confirmRevokeAllLink`, which
  changes nothing; `consumeRevokeAllLink` is reached from the button and nowhere else, because a
  mail scanner that prefetches the link must not end anyone's sessions.
- **No CSRF token and no frame guard are needed.** There is no session on this page: the token in
  the link is the whole credential and both endpoints are public, so a cross-site request or a
  framed page could do nothing a holder of the link cannot already do directly.
- **Say the same thing for every refusal.** Do not tell an expired link from an unknown one on the
  page, for the reason the API does not (below). Keep the token out of your own logs and
  analytics — it is in the page URL, so an analytics script that records full URLs records it.

- **Every refusal is the same 404** (`RevokeAllLinkError`), with the same body: unknown, expired,
  already spent, superseded by a newer link, issued against a key generation that has since moved,
  or belonging to an account that is not active. Telling those apart would tell whoever holds a
  random value that it named something real. 404 rather than the 401 the [password reset
  link](#password-reset-verified-email) answers with, because there is no credential here to have
  been wrong: the mailbox is the proof, and what arrives either names an outstanding link or names
  nothing.
- **The token travels in the request body, never in a path segment.** The request logger records
  the path of every request, and so does whatever proxy sits in front of it.
- **Your obligation, which this package cannot enforce:** the returned `url` carries the plaintext
  token, because this flow sends no mail of its own. Do not log it, do not persist it, do not put
  it in a job payload — hand it to the mail template and let it go. The package's other two links
  are minted inside the worker that sends them precisely so no caller ever holds one; this one
  cannot be.
- **It is one-time and generation-bound.** Consuming it is a single statement, so two clicks
  produce one sign-out and one 404. It also dies the moment anything else ends the account's key
  generation — a completed password reset, a password change, a deletion request, or the
  `revokeAllKeys` route in either mode.
- **It does not change the password.** Send it alongside a password reset link: this one ends the
  sessions, that one ends the credential that started them.
- **Issuing again supersedes.** A second link retires the first, so asking twice does not leave a
  spare capability in the mailbox.
- **`ttlMinutes` must be a positive whole number.** Zero or negative is a `ValidationError` and
  writes no row; an unknown `userId` is refused explicitly rather than surfacing as a foreign-key
  500.
- **Rate limited 10/minute per address** across both endpoints, on one counter — valid and invalid
  tokens are not counted separately, which would be a way to tell them apart.
- **Expired and spent rows are swept** by `auth.revoke-all-token-purge` (daily 06:00), part of
  `authJobRouter`: a week after expiry, a day after being spent or superseded.

**Settings.**

| Variable | Default | Meaning |
|----------|---------|---------|
| `SPFN_AUTH_REVOKE_ALL_LINK_TTL_MINUTES` | `30` | how long the link works |
| `SPFN_AUTH_REVOKE_ALL_CONFIRM_PATH` | `/account/revoke-all` | the page in your app the link opens |

The link URL is built on `NEXT_PUBLIC_SPFN_APP_URL || SPFN_APP_URL`, the same resolution the other
two links use. Only the SHA-256 of the token is stored, in `spfn_auth.key_revoke_all_tokens`.

Neither route is in the mobile contract: both are answered for a browser on a page in your app,
with no session and no client proof, and a generated mobile client has a session by definition.

### Passkeys (WebAuthn)

A passkey is an **optional additional credential** on an account, alongside a password and a
linked social account rather than in place of either. Enroll one from a session that already
exists; sign in with it afterwards without typing an identifier at all.

```
enroll   → register/options (session)  → the browser mints a credential → register/verify
sign in  → login/options    (public)   → the browser picks a credential → login/verify
manage   → list / rename / revoke
```

**A passkey is not a device key.** The assertion proves *who* is asking; the device key the
Next.js proxy registers right after it is what every later request is signed with, exactly as
after a password login. Nothing in clientProofV1, in the JWT path, or in
[Registered devices](#registered-devices-key-management) changes because a session started
this way — a passkey sign-in produces the same `LoginResult` and the same key row as `login`.

#### Setup

```bash
# .env.server — nothing is required; these are the overrides
SPFN_AUTH_PASSKEY_RP_ID=example.com
SPFN_AUTH_PASSKEY_ORIGINS=https://app.example.com,https://admin.example.com
```

With neither set, the relying party is derived from `{NEXT_PUBLIC_SPFN_APP_URL || SPFN_APP_URL}`:
its host becomes the rpId and its origin becomes the single allowed origin. That is the whole
configuration for a one-origin app.

| Var | File | Notes |
|-----|------|-------|
| `SPFN_AUTH_PASSKEY_RP_ID` | `.env.server` | domain credentials are bound to — no protocol, no port. Default: the app URL's host. **Changing it orphans every passkey already enrolled** |
| `SPFN_AUTH_PASSKEY_RP_NAME` | `.env.server` | name the authenticator's own prompt shows. Default: the rpId |
| `SPFN_AUTH_PASSKEY_ORIGINS` | `.env.server` | comma-separated full origins allowed to run a ceremony. Default: the app URL's origin |
| `SPFN_AUTH_PASSKEY_USER_VERIFICATION` | `.env.server` | `preferred` (default) or `required`. `discouraged` refuses boot. What the browser is asked for, and whether a sign-in without user verification is refused outright — not whether an assertion is a second factor: [that is each assertion's own flag](#what-a-passkey-proves) |
| `SPFN_AUTH_PASSKEY_CHALLENGE_TTL_SECONDS` | `.env.server` | default `300` — one ceremony at the authenticator, not an abandoned tab |
| `SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES` | `.env.server` | default `10` — see [the recent-authentication gate](#the-recent-authentication-gate). Also the provider link window when `oauthLink.recentAuthMinutes` is unset |

Two rules on those origins, **checked at boot** and refused with `PasskeyConfigError`:

- each origin must be `https`, and `localhost` is the one host a browser treats as a secure
  context over plain `http` — so `http://localhost:3000` is legal and `http://app.example.com`
  is not;
- each origin's host must be the rpId or a subdomain of it, because the browser will refuse
  the ceremony otherwise.

The check runs at `initializeAuth`, deliberately: every one of these values makes *every*
passkey operation fail, the drift is between environments, and the deploy that introduces it
is where it has to surface — not the first sign-in after it.

**Boot is only refused for a configuration you wrote.** If no `SPFN_AUTH_PASSKEY_*` variable
is set, the derived relying party can still be unusable — `SPFN_APP_URL=http://192.168.1.5:3000`
so a phone on the same network can reach your laptop, say, which is neither https nor
localhost. Refusing to start over a feature nobody asked for would take that app down to fix
something it does not use, so it is logged once instead and only a ceremony fails. Set any
passkey variable and the same configuration refuses to start. This is the posture
[the OAuth callback origin check](#oauth-callback-origin-web-app-host--rewrite) already takes.

#### Enrolling, from a Next.js client component

```tsx
'use client';
import { authApi } from '@spfn/auth';
import { enrollPasskey, isPasskeySupported } from '@spfn/auth/client';

async function addPasskey()
{
    const result = await enrollPasskey(authApi, { label: 'MacBook Touch ID' });

    if (!result.ok)
    {
        // 'unsupported' | 'cancelled' | 'error' — 'cancelled' is not an error to show
        return result.reason === 'cancelled' ? undefined : showError(result.reason);
    }

    showAdded(result.passkeyId, result.label);
}
```

`isPasskeySupported()` is what decides whether to render the button at all.

The passkey helpers take a client and call through it, so they wait as long as that client
does — `SPFN_AUTH_GUARD_TIMEOUT` bounds only the guards. To bound them, pass a client created
with a timeout, `createApi<AuthRouter>({ timeout: 5000 })` (`createApi` from
`@spfn/core/nextjs`, `AuthRouter` from `@spfn/auth`), or call `.timeout()` on your own calls:
`authApi.login.timeout(5000).call(...)`.

#### Signing in, with conditional UI

The passkey appears in the browser's ordinary autofill dropdown. That needs an input whose
`autocomplete` ends in `webauthn`, and a `signInWithPasskey` call started **when the form
renders**, not on a click:

```tsx
'use client';
import { useEffect } from 'react';
import { authApi } from '@spfn/auth';
import { isConditionalMediationAvailable, signInWithPasskey } from '@spfn/auth/client';

export function SignInForm()
{
    useEffect(() =>
    {
        void (async () =>
        {
            if (!await isConditionalMediationAvailable()) return;

            const result = await signInWithPasskey(authApi, { conditional: true });
            if (result.ok) router.replace('/');
        })();
    }, []);

    return (
        <form>
            <input name="email" autoComplete="username webauthn" />
            <input name="password" type="password" autoComplete="current-password" />
        </form>
    );
}
```

Where conditional mediation is missing, render a visible "Sign in with a passkey" button that
calls `signInWithPasskey(authApi)` instead.

Both helpers answer with a discriminated union and **never throw a cancellation**: a person
who dismisses the system sheet raises `NotAllowedError`, and so does a person whose
authenticator had nothing to offer — neither is an application error, and code that has to
tell them apart by re-reading `error.name` gets it wrong once and shows a red banner to
someone who simply changed their mind.

| result | meaning |
|--------|---------|
| `{ ok: true, ... }` | signed in / enrolled; the rest of the object is the server's answer |
| `{ ok: false, reason: 'unsupported' }` | this browser has no WebAuthn; nothing was sent to the server |
| `{ ok: false, reason: 'cancelled' }` | the person dismissed the enrollment prompt |
| `{ ok: false, reason: 'no-credential' }` | sign-in: the authenticator offered nothing, or the person dismissed it |
| `{ ok: false, reason: 'error', error }` | anything else, with the original error attached |

#### The recent-authentication gate

Adding a credential is adding a way in, and removing one can lock an account. Both are refused
unless the caller has recently proved themselves, in one of two ways:

- **this session's credential authenticated within `SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES`**; or
- **the body carries `currentPassword`** and it verifies.

"When did this session last authenticate" is asked of the credential the request presented
(`getAuth(c).credential`), never of a key id it reports:

| Credential | Recently authenticated when |
|---|---|
| a device key | its own key row's `authenticatedAt` is inside the window — a sign-in sets it and a `rotateKey` only inherits it, so rotating does not make a stale session fresh |
| a one-time token | the device key that issued it is: the token is that session's hand-off and nobody proves anything to obtain it, so it is exactly as fresh as its issuer |
| an [application profile](#custom-auth-profiles-registerauthprofile) | **never by itself** — it has no key row, and `@spfn/auth` has no record of when it authenticated. The key id its verifier reports is the profile's own, even when it equals a device key's id, so it borrows nothing from that key's sign-in. It presents the password instead |
| an OAuth 2.1 grant | never — a grant is no session, and these routes do not admit it |

A profile session's password proof is not stored anywhere a later request reads, except at
passkey registration, where `register/options` records it on that ceremony's challenge (below).

A password in the body is the proof offered, and it is judged: a wrong one answers
`RECENT_AUTH_REQUIRED` even on a device that signed in a moment ago. A presented password is always
judged, on every route that takes one — passkey register options, passkey revoke, OAuth link and
unlink, session-binding disable, and the deletion request.

Otherwise: **403 with `code: 'RECENT_AUTH_REQUIRED'`**. Branch on that code to prompt for the
password and retry — it is a stable field, not a message to match on.

Registration asks the gate twice. `register/options` is the early refusal, and a
`currentPassword` that satisfies it there is recorded on that ceremony's challenge — not on the
device key: the proof was given for this registration, and no other route's gate learns of it.
`register/verify` is the decision: it asks the key's `authenticatedAt`, or that ceremony's recorded
password proof, within the window, with step-up, against the account as it is then — so the verify
carries no password and runs no hash under the account lock.

An account with no password stored **cannot** satisfy the gate with a password, however
plausible the value; it has to sign in again. The comparison still runs, against a dummy hash,
so "no password on file" costs exactly what "wrong password" costs — otherwise response time
becomes an oracle for which accounts are OAuth-only.

#### Managing passkeys

```typescript
const { passkeys } = await authApi.listPasskeys.call({ body: {} });
// → [{ passkeyId, label, deviceType, backedUp, transports, createdAt, lastUsedAt, secondFactor, userVerified }]

await authApi.renamePasskey.call({ body: { passkeyId, label: 'Old iPhone' } });
await authApi.revokePasskey.call({ body: { passkeyId } });
```

- **Neither `credentialId` nor the public key is ever returned.** They are what an
  authenticator is addressed by; the list exists to let someone recognise a credential and
  point at it, which the label, the device type and the last-used moment do.
- **`deviceType` is `singleDevice` or `multiDevice`**, and `backedUp` says whether a
  multi-device credential actually has been. "This one only exists on that phone" is what the
  owner needs before revoking the other entry.
- **Revocation is soft, and the credential id stays reserved for good.** A credential someone
  cut off can never be enrolled again — not on another account, and not on the same one
  (`PasskeyAlreadyRegisteredError`, 409). Re-enrolling means a fresh credential.
- **A passkey id you do not own answers 404.** Every lookup is owner-scoped, so the answer is
  only ever "not yours".
- **Renaming has no recent-authentication gate**: a label is display only and nothing is
  authorized by it.
- **`secondFactor` says the passkey is marked as the account's second factor**, and
  **`userVerified` that its registration verified the person** — what marking requires. Offer
  "use as second factor" (`mfa/passkey/mark` with `secondFactor: true`) only where `secondFactor`
  is false and `userVerified` true; elsewhere the mark answers 409
  `PASSKEY_USER_VERIFICATION_REQUIRED`. A mark proves a factor only while the policy lists
  `'passkey'`.

#### Recovery — read this before shipping a passkey-only sign-up

The ways back into an account are: a live passkey, a password, a linked social account, or a
verified email address — the last one because [Password reset](#password-reset-verified-email)
can always give such an account a password back. Nothing else; support cannot restore an
account that has none of the four.

That is why **revoking the last live passkey is refused (409, `code:
'LAST_RECOVERY_CREDENTIAL'`) when the account has no password, no linked social account and no
verified email.** A phone-only account is the case that reaches it. The refusal is not
paternalism; it is the absence of an undo. Branch on that code to offer "set a password
first", "link an account first", or "confirm your email address first".

The same fact should shape your sign-up: an account created without a password, without an
email and given one passkey has exactly one way in, and losing the device loses the account.
Ask for a password, an address, or a social link before, or shortly after, the passkey.

#### How the ceremonies are kept honest

- **Discoverable credentials only** (`residentKey: 'required'`). `login/options` takes an empty
  body — `additionalProperties: false`, so an `email` field is a 400 rather than something
  quietly ignored — and always answers with an empty `allowCredentials`. There is no input
  that could make its answer differ by whether an account exists.
- **A revoked credential and one that was never here answer identically** on `login/verify`.
  Anything else would say whether this account once had it.
- **Challenges are one-time database rows**, spent by a single conditional `UPDATE`. Two
  verifies arriving with the same challenge produce one winner and one refusal, across
  instances. A challenge is bound to its ceremony (`registration` / `authentication`) and, for
  enrollment, to the account that minted it.
- **A refusal leaves the challenge live** — except a renewal-grade assertion (`session/renew`,
  turning binding off) that does not verify, which spends it in a transaction of its own so it
  cannot be tried again. Otherwise spending happens inside the transaction that writes what it
  authorizes, so a failure rolls it back and the ceremony is retryable; only a success is
  unrepeatable.
- **A challenge a signed-in person asked for is theirs alone.** Registration, step-up, renewal and
  binding-off challenges are stamped with the credential that asked for them and the account's
  key generation; only that credential — or, for a device key, its verified replacement — of that
  generation spends one, and only after the account is asked again (`admitDeferred`). A
  discoverable sign-in's challenge names nobody, as before.
- **One challenge kind per procedure, spent by one route.** Two procedures that shared a kind
  would each accept the other's challenge under its own rule:

  <a id="webauthn-challenge-kinds"></a>

  | Kind | Minted by | Accepted only by | Stamped |
  |---|---|---|---|
  | `authentication` | `passkeys/login/options` | `passkeys/login/verify` | no — names nobody |
  | `registration` | `passkeys/register/options` | `passkeys/register/verify` | yes |
  | `stepUp` | `mfa/step-up/options` | `mfa/step-up` (and `checkSecondFactorProof` with `{ kind: 'stepUp' }`) | yes |
  | `newDevice` | `mfa/verify/options` | `mfa/verify` | no — the 202 handle names its pending key |
  | `renewal` | `session/renew/options` | `session/renew/verify` | yes, with the key it renews |
  | `bindingOff` | `session/binding/disable/options` | `session/binding` with `mode: 'none'` | yes |
  | `deviceApprove` | `session/passkey-proof/options` | `device/approve` | yes |
  | `linkIssue` | `session/passkey-proof/options` | `device/link/issue` | yes |
  | `passkeyAdd` | `session/passkey-proof/options` | `passkeys/register/verify` | yes |
  | `passwordSet` | `session/passkey-proof/options` | `PUT /_auth/password` setting a first password | yes |
  | `socialLink` | `session/passkey-proof/options` | `oauth/:provider/link` | yes |
  | `oauth2Consent` | `session/passkey-proof/options` | `POST /_auth/oauth2/authorize` with `approve: true` | yes |
  | `bindingEnable` | `session/passkey-proof/options` | `session/binding` with `mode: 'passkey'` | yes |

  The retired `mfa` kind, which a step-up and a new-device sign-in once shared, is accepted by
  nothing.
- **A signature counter that goes backwards refuses the sign-in and leaves the row alone.** It
  is the signal a cloned authenticator would produce — but a synced passkey reports 0 forever
  and a restored device can hit it, so auto-revoking would lock people out on a false
  positive. The refusal is logged at `warn` with the passkey id; a human decides what it meant.
  The regression is recognised by comparing the signed counter with the stored one, not by the
  wording of the WebAuthn library's error, so a reworded message cannot silence the warning.
- **Attestation is `none`.** Verifying an attestation statement would tell us which
  authenticator model was used and nothing about who is holding it.

#### Errors

| error | status | `code` | when |
|-------|--------|--------|------|
| `PasskeyChallengeError` | 401 | — | the challenge is unknown, expired, already spent, of the other ceremony, or of another account |
| `PasskeyVerificationError` | 401 | — | origin, rpId, signature or counter — and, on sign-in, an unknown or revoked credential |
| `PasskeyNotFoundError` | 404 | — | a passkey the caller does not own, or one already revoked |
| `PasskeyAlreadyRegisteredError` | 409 | — | that credential is on file for some account, revoked ones included |
| `RecentAuthenticationRequiredError` | 403 | `RECENT_AUTH_REQUIRED` | the session proved itself too long ago and carried no password |
| `PasskeyProofRequiredError` | 403 | `PASSKEY_PROOF_REQUIRED` | session binding is on and `register/verify` carried no `passkeyResponse` for `passkeyAdd` — see [Letting another credential in](#letting-another-credential-in) |
| `LastRecoveryCredentialError` | 409 | `LAST_RECOVERY_CREDENTIAL` | revoking it would leave no way back in |
| `PasskeyUserVerificationRequiredError` | 409 | `PASSKEY_USER_VERIFICATION_REQUIRED` | `mfa/passkey/mark` on a passkey registered without user verification |
| `PasskeyConfigError` | boot | — | an origin off the rpId or not https, or an unsupported user-verification value |

#### Events

`passkeyEnrolledEvent` (`auth.passkey.enrolled`: `userId`, `passkeyId`, `label?`) and
`passkeyRevokedEvent` (`auth.passkey.revoked`: `userId`, `passkeyId`, `reason` — `'user'` from
`passkeys/revoke`, `'operator'` from `resetSecondFactorService`) fire after
commit. `authLoginEvent.provider` gains `'passkey'`. Subscribe to the first to tell the owner
a new way into their account appeared — which is what it is.

#### The case table

The behaviour above is asserted row by row in
`src/__tests__/integration/passkeys.test.ts`; each `it` is named for its row.

| row | situation | outcome |
|-----|-----------|---------|
| E1 | fresh session, no passkeys | 200, empty `excludeCredentials` |
| E2 | session key 11 min old, no password | 403 `RECENT_AUTH_REQUIRED` |
| E3 / E4 | 11 min old, correct / wrong password | 200 / 403 — byte-identical to E2 |
| E5 | no password on the account, 11 min old | 403; a password can never speak for it |
| E6 | valid attestation | 200; row written, challenge spent, event emitted |
| E7 / E8 | challenge replayed / expired | 401; one row, no row |
| E9 / E10 | another account's / the other ceremony's challenge | 401 |
| E11 | credential already on some account | 409 |
| E12 / E13 | wrong origin / wrong rpId | 401 |
| E14 | two live passkeys | both listed in `excludeCredentials` |
| E15 | label empty or over 64 chars | 400; challenge stays live |
| E16 | two concurrent verifies, one challenge | one 200, one 401, one row |
| L1 / L2 | empty options body / an `email` in it | 200 with empty `allowCredentials` / 400 |
| L3 | valid assertion | 200, same answer as `login`; counter and device key move |
| L4 / L5 | revoked / unknown credential | 401, byte-identical |
| L6 / L7 / L8 | challenge spent / expired / wrong kind | 401; no device key |
| L9 / L17 | bad signature / wrong origin | 401; counter unmoved |
| L10 | counter went backwards | 401; row untouched, warn logged, not revoked |
| L11 | synced passkey reporting 0 both times | 200 |
| L12 / L13 | disabled / pending deletion | 403, the same errors password login gives |
| L14 | device-key fields missing (proxy bypassed) | 400; challenge stays live |
| L15 | an old session key named in the body | it is revoked as the new one is registered |
| L16 | two concurrent verifies, one assertion | one 200, one 401, one device key |
| M1 | 2 live + 1 revoked | 2 entries, no credential id, no public key |
| M2 / M9 | someone else's / an already revoked passkey | 404 |
| M3 / M4 | rename / revoke on a recent session | 200; revoke emits its event |
| M5 | revoke on an 11-minute-old session | 403 `RECENT_AUTH_REQUIRED` |
| M6 / M7 / M8 | last passkey, no password: alone / with a social account / with a second passkey | 409 / 200 / 200 |
| M10 | re-enrolling a revoked credential | 409 |
| K1 / K4 | two concurrent revokes: 2 passkeys and nothing else / 1 passkey and a password | 200 + 409 / 200 + 404 |
| K2 / K3 | last passkey, no password: with a verified email / phone-only | 200 / 409 |

Configuration rows C1–C6 are in `src/__tests__/unit/passkey-config.test.ts`.

### Second factor (MFA)

Optional by default, and optional in the strong sense: an account that never enrols sees
exactly the behaviour it saw before this existed, on every route, and the package asks for a
second factor only from people who asked it to — unless the app requires one with
[`secondFactor: { required: true }`](#requiring-a-second-factor-secondfactor), which also
chooses the methods and whether recovery codes exist.

Two forms. A **TOTP** authenticator app (RFC 6238, SHA-1, 30-second steps, six digits, one
step of drift), or a **passkey** the owner already enrolled through `/_auth/passkeys/*` and
has marked as a second factor, used with user verification
([what a passkey proves](#what-a-passkey-proves)). Either one comes with ten single-use recovery
codes.

```
enrol   → POST /_auth/mfa/totp/enroll      → { secret, otpauthUri }, shown once
confirm → POST /_auth/mfa/totp/confirm     → { recoveryCodes }, ten of them, shown once
        → or POST /_auth/mfa/passkey/mark  → an existing passkey becomes the second factor
inspect → GET  /_auth/mfa/status           → { enrolled, methods, recoveryCodesRemaining }
step up → POST /_auth/mfa/step-up          → 204, this device's window reopens
remove  → POST /_auth/mfa/disable          → 204
```

#### Prerequisite: the encryption keyring

A TOTP secret is encrypted at rest with **`SPFN_AUTH_TOKEN_ENCRYPTION_KEYS`** — the same
keyring the OAuth tokens use, in the same `enc:v2:<keyId>:` frame, under its own additional
authenticated data so a row cannot be moved between accounts. That variable is listed above
as "web OAuth", and it is now also required by any app offering a second factor, **including
an app with no social login at all**. `totp/enroll` answers a 500 configuration error while
it is unset, and a key id dropped from the keyring answers the same way rather than the 401 a
wrong code gets — an operator has to be able to tell a broken deploy from a person misreading
their phone. A row written under a key that has since been retired is re-encrypted in place
the next time its owner verifies, so a retired key drains as people use their second factor.

#### Enrolling

`totp/enroll` mints a 20-byte secret and returns it as RFC 4648 base32 (upper case, no
padding) plus the `otpauth://` URI an authenticator app scans. Nothing is enrolled yet:
calling it again replaces the pending secret, and a secret nobody confirms is swept away a day
later by `auth.mfa.sweep`. `totp/confirm` spends the first code, which is what turns the
enrolment into a second factor and issues the recovery codes.

The enrolment is the session's that started it. `confirm` is where it is decided, under the
account lock: only that session (or its verified replacement), in the same key generation, confirms
it — any other gets `MfaNotEnrolledError` — and the rule for adding a factor is asked again of the
account as it is then: an account that enrolled a factor since `enroll` answers `403
STEP_UP_REQUIRED`. The checks at `enroll` are an early refusal only.

A submitted code has its spaces and dashes stripped, so `123 456` and `123-456` are the same
code; anything else that is not six ASCII digits — full-width digits, letters, the wrong length —
is a wrong code, answered and counted as one. A wrong code spends the account's
[failure budget](#wrong-proofs-one-budget-per-account) like any other wrong proof, and the pending
secret stays. `totp/enroll` on a **confirmed** enrolment is a 409, because replacing a working
second factor is `disable` followed by a fresh enrolment, both step-up gated. The confirmation is
conditional on the enrolment still being unconfirmed, so two confirms with one code issue one set
of recovery codes.

The **same code cannot be spent twice**, which is what makes it single-use: the newest step
the account has spent is remembered, the statement that spends a step is conditional on it being
newer, and a code presented again inside its own thirty seconds — or by several requests at once —
is refused. That includes the legitimate case of a second device signing in during the same
step — it gets a 401 with the same body as a wrong code, and the client should **retry on the
next step** rather than treat it as a bad credential.

#### Recovery codes

Ten codes, format `xxxxx-xxxxx`, shown once at confirmation and once at each regeneration.
They are stored as **password hashes** rather than as the unsalted SHA-256 the link flows use:
a code a human transcribes is short enough that a leaked dump of unsalted hashes would fall to
an offline sweep. `recovery/regenerate` raises the generation, so every code from before it
stops verifying with the same body as one that never existed. `status` reports how many of the
current generation are unspent, which is what an app warns on at two remaining.

#### The step-up window

For an **enrolled** account, four kinds of change ask for the second factor again:

| route | what it changes |
|-------|-----------------|
| `PUT /_auth/password` | the password, and every other session with it |
| `POST /_auth/keys/revoke-all` | every device |
| `POST /_auth/mfa/disable`, `recovery/regenerate`, `passkey/mark`, `totp/enroll` | the second factor itself |
| `POST /_auth/passkeys/register/options`, `passkeys/revoke` | the account's credentials |

The rule is per **credential** — a device key, or an [application profile](#custom-auth-profiles-registerauthprofile)
with the key id its verifier reports, which is the profile's own and never the device key that
happens to have the same id: this device must have proved the second factor within
`SPFN_AUTH_MFA_STEP_UP_MINUTES` (default 10). Otherwise the answer is **403
`STEP_UP_REQUIRED`**, and the client sends the user to `POST /_auth/mfa/step-up` — a TOTP
code, a recovery code, or an assertion with user verification from a marked passkey (options from
`POST /_auth/mfa/step-up/options`) — and retries. 403 rather than 401 on purpose, and for the
reason `RECENT_AUTH_REQUIRED` is: a 401 on an authenticated route is what a web client reads
as "the session is gone", so it would sign the user out instead of asking for a code.

From a browser, `stepUpWithPasskey(api)` from `@spfn/auth/client` runs the passkey step-up —
options, the ceremony, `mfa/step-up` — and answers the discriminated union the other passkey helpers
do: a ceremony that did not happen is `{ ok: false, reason }` (`unsupported`; `no-credential` when
the person dismissed the sheet or had nothing to offer; `error`), and the server declining rejects
the promise, as `completeMfaWithPasskey` does — 401 `MfaVerificationFailedError` for an unmarked
passkey or one used without user verification, 429 `SECOND_FACTOR_LOCKED`. A 503 is neither: the
account was busy with another change and the assertion's challenge was not spent, so it answers
`{ ok: false, reason: 'busy' }`, as `renewSession` does — call it again. An app route that takes
the proof itself gets the assertion from `stepUpAssertion(api)`
([below](#wrong-proofs-one-budget-per-account)).

```typescript
import { stepUpWithPasskey } from '@spfn/auth/client';

const stepUp = await stepUpWithPasskey(authApi);

if (stepUp.ok)
{
    await authApi.revokeAllKeys.call({ body: {} });   // the change that answered STEP_UP_REQUIRED
}
```

Besides `mfa/verify`, `mfa/step-up` and `totp/confirm`, one more proof opens the window: a passkey
registration that marks the account's first passkey factor in the policy's enrolment-only state
([above](#enrolling-when-the-account-already-holds-a-credential)). No other registration does.

A key **replacement carries the window across** — `rotateKey`, a renewal, or a sign-in whose
`replacementProof` the old key signed — because each is proof of the same device; otherwise the web
proxy, which replaces the key at every login, would expire it constantly. A sign-in that only
*names* the old key carries nothing.

The two passkey routes keep their own `RECENT_AUTH_REQUIRED` rule unchanged and run it after
the step-up: the two guards are independent, and an unenrolled account meets exactly the rule
it met before. Unmarking the last second-factor passkey is likewise independent of
`LAST_RECOVERY_CREDENTIAL` — removing a mark is not removing a way into the account, so
`passkey/mark false` succeeds where `passkeys/revoke` on the same credential is still refused.

Two sign-ins deliberately produce a session with no verification of its own: a
[device-code login](#device-code-login) and a passkey sign-in with user verification. Both are exempt at
*registration* and both still step up for a sensitive change, which is what
`POST /_auth/mfa/step-up` is for. Marking a passkey as a second factor is likewise not proving
it, so the device that marks one steps up before it may change the second factor again.

#### Step-up on a new device

The moment the feature exists for. An **enrolled** account signing in from a device it has
never seen does not get a session — it gets a challenge, and the device key it registered
stays inactive until that challenge is spent. A password phished from somebody is no longer
enough to hold their account.

```
POST /_auth/login            → 202 { mfaRequired: true, challenge: { secret, expiresAtMillis } }
                               the key is registered, is_active = false, and nothing else moved
POST /_auth/mfa/verify       → 200 the LoginResult the sign-in would have given
  { challenge, code }          plus keyId and challengeHash, for the proxy
  { challenge, recoveryCode }
  { challenge, response }      options from POST /_auth/mfa/verify/options
```

Four channels stop: **password**, **oauth** (web), **oauth-native** and **password-reset** —
the four where one stolen credential would otherwise be enough. A device-code approval does not,
because it already carried a second proof, and neither does a passkey sign-in whose assertion
carried user verification, marked or not — possession and verification were both shown — while the
[policy](#requiring-a-second-factor-secondfactor) lists passkeys. A passkey sign-in without user
verification (a security key with no PIN), or any passkey sign-in when the policy does not list
passkeys, is the fifth channel that stops, and `passkeys/login/verify` answers the same 202. The
exemption is read from what the assertion proved, not from the route it came by. Nor does a key rotation,
a renewal, or any path that is creating the account. A sign-in that **replaces** the device's key is
not stopped either — but only when the old private key proves it with `replacementProof`; a sign-in
that merely names an `oldKeyId` is a new device and is challenged
([Replacing a device's key](#replacing-a-devices-key)). A brand-new social account is not stepped
up either, and needs no exemption to say so: an account that was written a moment ago has
nothing enrolled.

**A 202 moves nothing.** No login event, no new-device event, no `lastLoginAt`. All three are
held on the challenge row and fire together at `verify`, with the original channel — so the
owner's record of their own sign-ins stays a record of sign-ins that happened.

**Until it is verified, the key does not exist** to anything the owner can see: `authenticate`
refuses it, `optionalAuth` reads the caller as anonymous, and `listKeys` omits it in both
modes. Every global revocation — `revoke-all`, a password change, the sign-out-everywhere
link, a password reset — **deletes** it and kills its challenge in the same statement, so the
owner who reacts to an unexpected prompt by signing out everywhere really has.

The challenge is 32 random bytes. Only its hash is stored, so a guess reaches no row and
spends nothing; it is single use, it lives `SPFN_AUTH_MFA_CHALLENGE_TTL_MINUTES` (default 10),
and it dies with the account's key generation. A wrong proof at it spends the account's
[failure budget](#wrong-proofs-one-budget-per-account), not the challenge's — a fresh sign-in mints
a fresh challenge and no fresh tries. Retrying the same registration while a challenge is live
resumes it — same row, same expiry — rather than answering 409.

**Recovery codes work here**, which is the point of having them: somebody whose authenticator
is on the phone they just lost signs in on the replacement with a written-down code.

##### Migration

`LoginResult` gained a required `mfaRequired` and every other field became optional. Narrow on
it before reading `userId` — see [the migration note](#migration--narrow-a-sign-in-on-mfarequired-before-reading-userid).

##### The web OAuth path

The backend callback redirects with **`?mfaChallenge=`** (and the start's `keyId`) instead of
`userId`. The value is not a bearer credential for anything but this one `verify`, it is single use, and
`requestLogger` records pathnames only — so unlike the sign-out-everywhere link it is not a
capability riding a URL.

Both consumers of that redirect are served:

- `createOAuthCallbackHandler()` redirects the browser to **`SPFN_AUTH_MFA_CONFIRM_PATH`**
  (default `/auth/mfa`, or the `mfaPath` option) with `?challenge=`, the start's `?keyId=` and
  `?returnUrl=`. A confirm page that posts to `POST /_auth/oauth/finalize` passes that `keyId` on
  as `{ mfaChallenge, keyId }`.
- An app on the callback-page flow posts `{ mfaChallenge, keyId }` to `POST /_auth/oauth/finalize`,
  which answers **202** with the challenge (and the `keyId`, which names the start whose pending
  cookie holds the private key) echoed back instead of finalizing a session.
  `OAuthCallback` does this for you and then navigates to the confirm page with the same
  `?challenge=` and `?returnUrl=` — so both flows are supported end to end: callback → 202 and
  pending cookie → confirm page → proof → session → return path. The component does not need
  to be told where the confirm page is: `mfaVerifyInterceptor` adds `mfaPath` to that 202 from
  `SPFN_AUTH_MFA_CONFIRM_PATH`, through the same resolver the handler redirects with, so
  setting the variable once moves both flows. `<OAuthCallback mfaPath="…" />` is an override
  for one screen, not part of the normal setup.
- A custom callback or confirm page that posts `{ mfaChallenge }` only, as this README told it to
  before per-start cookies, keeps working: the 202 then carries no `keyId`, and the proxy takes the
  private key from the most recent start's pending cookie (else the legacy one) — the start
  `getPendingSession()` without an argument reads. Pass the `keyId` when you have it: with two
  sign-ins in flight, only it names the right one.

##### In the Next.js proxy

Nothing to write. `mfaVerifyInterceptor` — registered for you in `authInterceptors` — seals a
`spfn_mfa_pending` cookie on any 202 (the browser's private key, the key id, and the hash of
the challenge, for ten minutes) and turns it into the session on a verified `verify`. Its own
name and audience, so a social login started in another tab does not overwrite it.

A session is sealed **only** when the verified response names the same challenge and the same
key the cookie holds. Otherwise the proxy answers **401 `SESSION_PENDING_MISMATCH`** without
sealing anything, and **401 `SESSION_PENDING_EXPIRED`** when the cookie is gone. The key is
active at the backend in both cases — what failed is this browser's claim to be the one that
asked — so the remedy is to sign in again.

##### From a browser, with the client helpers

```typescript
import { completeMfaWithCode, completeMfaWithPasskey } from '@spfn/auth/client';

const result = await authApi.login.call({ body: { email, password } });

if (result.mfaRequired)
{
    // Keep result.challenge.secret and send the person to your confirm screen.
    await completeMfaWithCode(authApi, result.challenge.secret, code);
    // The session cookie is sealed by the time this resolves.
}
```

`completeMfaWithRecoveryCode` takes a written-down code, and `completeMfaWithPasskey` runs the
ceremony and answers the same discriminated union the other passkey helpers do.

##### The confirm page, with `useMfaConfirm`

Both OAuth flows land on `SPFN_AUTH_MFA_CONFIRM_PATH`: put the page at `/auth/mfa` and there
is nothing to set; put it anywhere else and set the variable, on the server, once — neither
`OAuthCallback` nor the handler needs the path passed to it. A full URL in the variable is
reduced to its path, so the challenge never leaves the app's origin. `useMfaConfirm()`, from
`@spfn/auth/nextjs/client`, is that page's flow without its look: it reads `?challenge=` and
`?returnUrl=` (the return path through `isSafeReturnPath`, `/` when refused), sends a page
without a challenge to `signInPath` (default `/auth/login`), and on success does a full
`window.location.assign` to the return path so the server reads the session cookie the proxy
just sealed.

```tsx
// app/auth/mfa/page.tsx — a server component
import { redirect } from 'next/navigation';
import { getSession, isSafeReturnPath } from '@spfn/auth/nextjs/server';
import { MfaForm } from './mfa-form';

export default async function MfaPage({ searchParams }: { searchParams: Promise<{ returnUrl?: string }> })
{
    const { returnUrl } = await searchParams;

    // Already signed in: nothing to confirm.
    if (await getSession())
    {
        redirect(returnUrl && isSafeReturnPath(returnUrl) ? returnUrl : '/');
    }

    return <MfaForm />;
}
```

```tsx
// app/auth/mfa/mfa-form.tsx
'use client';
import { useState } from 'react';
import { useMfaConfirm } from '@spfn/auth/nextjs/client';

export function MfaForm()
{
    const mfa = useMfaConfirm();
    const [code, setCode] = useState('');

    return (
        <form onSubmit={(event) => { event.preventDefault(); mfa.submitCode(code); }}>
            <input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" />
            {mfa.state === 'wrong' && <p>That code did not verify. Check your authenticator.</p>}
            {mfa.state === 'expired' && <p>That sign-in expired. <a href="/auth/login">Sign in again</a>.</p>}
            {mfa.state === 'failed' && <p>Something went wrong. Try again.</p>}
            <button disabled={mfa.state === 'submitting'}>Continue</button>
            {mfa.isPasskeySupported && <button type="button" onClick={mfa.tryPasskey}>Use a passkey</button>}
        </form>
    );
}
```

| `state` | means | what the page offers |
|---------|-------|----------------------|
| `idle` | nothing submitted, or a passkey sheet closed (`cancelled`, `no-credential`, `unsupported`) | the inputs |
| `submitting` | a proof is in flight; another submit is ignored; stays so while navigating away | a disabled button |
| `wrong` | `MfaVerificationFailedError` (401) — a wrong code | try again |
| `expired` | `SESSION_PENDING_EXPIRED` or `SESSION_PENDING_MISMATCH` from the proxy | sign in again |
| `failed` | anything else — network, rate limit, a passkey ceremony `error` | try again; the page's inputs are untouched |

`error` carries the error behind the last `wrong` / `expired` / `failed`. The challenge itself
is never logged or handed to a callback. A challenge that outlives its ten minutes **at the
backend** is refused like a wrong code, so it reads as `wrong` rather than `expired`; the
backend answers both with one body on purpose.

#### Wrong proofs: one budget per account

Every second-factor proof — a TOTP code, a recovery code, a passkey assertion — is judged in one
place, `checkSecondFactorProof`, whichever route it arrived on: `mfa/verify`, `mfa/step-up`,
`mfa/totp/confirm`. A wrong one spends the **account's** budget:

- **Five failures within any fifteen minutes**: each failure counts those of the fifteen minutes
  before it, so no burst on either side of a window's edge gets more than five. The fifth locks the
  second factor: for fifteen minutes from that failure no proof is accepted, right or wrong —
  **429 `SECOND_FACTOR_LOCKED`** (`SecondFactorLockedError`) with a `Retry-After` header — and no
  further failure is counted. The lock ends by itself. Signing in with the first factor is not blocked; the 202 it answers waits.
- **One budget, not one per attempt.** A fresh sign-in mints a fresh new-device challenge and no
  fresh tries; `mfa/step-up` and `mfa/verify` spend the same budget.
- **A success resets nothing.** Failures leave the count only when their window passes, so a
  correct code from the owner does not hand a guesser five more.
- **Malformed is wrong.** A code that is not six ASCII digits, a `response` that is not a passkey
  assertion at all (`null`, `{}`, a number), a passkey assertion without user verification, a proof
  of a method the policy does not list: each is a 401, counted. A replayed
  code that verified but whose step was already spent is a 401 and is not counted — it is not a guess.
- **The owner is told.** The failure that locks emits `auth.mfa.locked` after commit, exactly once.

The count is the data's, not a comparison in code: one conditional upsert on
`mfa_attempt_budgets` that writes nothing while the account is locked, so of any number of
concurrent failures exactly one reaches the limit. It runs under the account lock in a transaction
of its own that commits before the refusal — which is why the routes that take a proof have no
route-wide transaction, and why `checkSecondFactorProof` refuses to run inside one. A proof that
checked out is spent under the account lock by a statement conditional on what it was checked
against: the TOTP step newer than the last spent, the recovery code unused, the enrolment
unconfirmed, the WebAuthn challenge unspent; and the budget is asked again there.

An app route that takes a second-factor proof calls it the same way, outside a transaction, then
spends what it answers under the account lock in its own:

```typescript
import { runInTransaction } from '@spfn/core/db';
import { MfaVerificationFailedError } from '@spfn/auth/errors';
import { checkSecondFactorProof, usersRepository } from '@spfn/auth/server';

const proof = await checkSecondFactorProof(userId, { code }, { kind: 'stepUp', credential });

await runInTransaction(async () =>
{
    await usersRepository.lockAccount(userId);

    if (!await proof.spend())
    {
        throw new MfaVerificationFailedError();
    }
    // ...what the proof authorizes
});
```

From a browser, `stepUpAssertion(api)` from `@spfn/auth/client` gets that `response`: it asks
`mfa/step-up/options` and runs the ceremony, posts nothing, and answers
`{ ok: true, response }` or the failures `stepUpWithPasskey` has (`unsupported`, `no-credential`
for a dismissed sheet, `error`). The assertion is spent once, by whichever of `mfa/step-up` or
the app's `checkSecondFactorProof(userId, { response }, { kind: 'stepUp', credential })` and
`spend()` runs first; only the session that asked for it can spend it — `credential` is that
session's, from `getAuth(c)`. It is **not tied to an action**: what it authorizes is the app
route's to decide, and nothing stops the same session spending it on another route of the app's
that takes one. It proves the second factor as at `mfa/step-up`: with user verification, from a
passkey marked as a second factor while the policy lists `'passkey'`; anything else is a wrong
proof. In the [enrolment-only state](#the-enrolment-only-state) any live passkey of the account
proves it, marked or not, whatever is listed — but an app route never meets that state: `authenticate`
refuses such a session 403 `SECOND_FACTOR_ENROLMENT_REQUIRED` before app code runs, and
`optionalAuth` reads it as anonymous.

```typescript
import { stepUpAssertion } from '@spfn/auth/client';

const proof = await stepUpAssertion(authApi);

if (proof.ok)
{
    await appApi.exportData.call({ body: { response: proof.response } });   // the route above
}
```

#### What a passkey proves

A passkey assertion says what it showed: the credential, whether the authenticator **verified the
person** (a PIN, a biometric) rather than only their presence, and whether the owner marked the
credential as their second factor. Every rule reads that, on every use:

- **Without user verification it is never a second factor** — possession alone. It still signs its
  owner in. A new device signed in with it is asked for the second factor (202); it is refused at
  `mfa/verify` and `mfa/step-up`; and it cannot be marked.
- **With user verification, a passkey sign-in is exempt** from the new-device check, marked or not:
  possession and verification were both shown. At `mfa/verify` and `mfa/step-up` a passkey must also
  be marked (or, in the enrolment-only state, any live one).
- **Marking needs a registration that verified the person.** Registration records it
  (`passkeys.registered_user_verified`, `userVerified` in `listPasskeys`); `mfa/passkey/mark` on one
  that did not answers **409 `PASSKEY_USER_VERIFICATION_REQUIRED`**, and a registration under a
  required policy does not mark it.
- `SPFN_AUTH_PASSKEY_USER_VERIFICATION` is what the browser is asked for, and with `required`, a
  sign-in without verification is refused outright. It no longer decides what a second factor is.

#### Telling people it exists

`authLoginEvent` and `authDeviceRegisteredEvent` carry **`mfaEnrolled: boolean`**, computed as
the event is emitted — whether the account has a factor of a listed method. Without a required
policy that is the whole of the package's opinion: subscribe and offer enrolment at a first login
or when a new device appears, and nothing is blocked on it. With
[`secondFactor: { required: true }`](#requiring-a-second-factor-secondfactor) the package blocks
the session itself, and `authLoginEvent` says so in `secondFactorEnrolmentRequired`.

#### Errors

| error | status | `code` | when |
|-------|--------|--------|------|
| `MfaVerificationFailedError` | 401 | — | a wrong or stale code, a spent step, a code that is not six ASCII digits, a used / old-generation / foreign recovery code, or an assertion from an unmarked passkey or without user verification |
| `SecondFactorLockedError` | 429 | `SECOND_FACTOR_LOCKED` | five wrong proofs in fifteen minutes on this account: none is accepted, right or wrong, until `Retry-After` |
| `MfaNotEnrolledError` | 400 | — | `confirm` with no pending secret, or `regenerate` on an account with no second factor |
| `PasskeyUserVerificationRequiredError` | 409 | `PASSKEY_USER_VERIFICATION_REQUIRED` | `passkey/mark` on a passkey registered without user verification |
| `StepUpRequiredError` | 403 | `STEP_UP_REQUIRED` | an enrolled account's device is outside the window |
| `PasskeyProofRequiredError` | 403 | `PASSKEY_PROOF_REQUIRED` | session binding is on and a procedure that lets another credential in carried no passkey proof for it — a step-up does not satisfy it; see [Letting another credential in](#letting-another-credential-in) |
| `SecondFactorEnrolmentRequiredError` | 403 | `SECOND_FACTOR_ENROLMENT_REQUIRED` | the app requires a factor and this account has no listed one; every route but the enrolment routes — see [Requiring a second factor](#requiring-a-second-factor-secondfactor) |
| `SecondFactorMethodDisabledError` | 404 | `SECOND_FACTOR_METHOD_DISABLED` | a route of a method the policy does not list, or `recovery/regenerate` with `recoveryCodes: false` |
| `SecondFactorRequiredError` | 409 | `SECOND_FACTOR_REQUIRED` | removing the last listed factor through a route while one is required |
| `MfaAlreadyEnrolledError` | 409 | — | `totp/enroll` on a confirmed enrolment |
| `MfaConfigError` | 500 | — | `SPFN_AUTH_TOKEN_ENCRYPTION_KEYS` unset, or a stored secret naming a key id no longer in it |
| `SessionPendingMismatchError` | 401 | `SESSION_PENDING_MISMATCH` | minted by the proxy: a verified step-up whose challenge or key is not the one this browser's pending cookie holds |
| `SessionPendingExpiredError` | 401 | `SESSION_PENDING_EXPIRED` | minted by the proxy: a verified step-up with no pending cookie left to seal a session from |

`MfaVerificationFailedError` is the one contract error here, as the `auth.mfa.*` family of the
mobile contract (0.13.0). The enrolment routes are not contract operations, so the rest are
not on that surface.

#### The case table

Asserted row by row in `src/__tests__/integration/mfa-enrolment.test.ts` (enrolment),
`mfa-step-up.test.ts` (the window), `mfa-step-up-registration.test.ts` (which channels stop a
new device), `mfa-verify.test.ts` (verify × input), `second-factor-hardening.test.ts` (the
failure budget, single use under concurrency, what a passkey proves, the profile's step-up record)
and `src/__tests__/unit/mfa-proxy.test.ts` (the Next.js proxy); each `it` is named for its row.
`mfa-unenrolled-regression.test.ts` pins the status and the body shape an **unenrolled**
account gets from `login`, `changePassword`, `keys/revoke-all` and `passkeys/revoke`.

#### The sweep

`auth.mfa.sweep` runs daily at 07:00 and deletes enrolments still unconfirmed after 24 hours,
plus step-up challenges that have expired or been spent and the inactive keys they were
holding, and step-up records older than the step-up window — which grant nothing — of every
credential, an application profile's included. It also revokes session-bound keys past their
renewal grace (see [Session binding](#session-binding)), one account at a time under its lock. It
is carried by `authJobRouter` beside the other sweeps; pass `mfaSweepCron` to
`createAuthJobRouter()` to move it. A confirmed enrolment is never touched.

### Session binding

A web session's signing key is sealed **inside** the session cookie. That is what makes the
cookie a credential rather than a pointer to one — and it means a copy of the cookie *is* that
device. A browser profile copied off a laptop, a value pasted out of DevTools, a jar read by
malware: the copy signs exactly as the original does, registers no new key, raises no new-device
notice, and keeps working until the key is revoked or the session runs out. HttpOnly and
`SameSite=Lax` stop page script and cross-site posts; they do nothing about a copy made on the
machine.

Session binding is the opt-in that closes that window. An account that has a platform passkey may
turn it on; from then on a web session runs on a key that expires in **hours** instead of ninety
days, and only a fresh WebAuthn assertion can put a new one in the cookie. The copy cannot produce
the assertion, so it stops working at the first renewal.

```typescript
// Turn it on. Needs a recently-proved session and a passkey assertion that verified the person —
// what every renewal will ask.
import { provePasskey } from '@spfn/auth/client';
const proof = await provePasskey(api, 'bindingEnable');
if (proof.ok)
{
    await authApi.setSessionBinding.call({ body: { mode: 'passkey', passkeyResponse: proof.passkeyResponse } });
    // → { mode: 'passkey', keyExpiresAtMillis }
}

await authApi.getSessionBinding.call();          // → { mode, keyExpiresAtMillis? }

// Turn it off. A fresh credential is required — see below.
import { disableSessionBinding } from '@spfn/auth/client';
await disableSessionBinding(api);                             // runs the passkey ceremony
await disableSessionBinding(api, { currentPassword: '…' });   // or the account password
```

> **It needs a deployment where the backend can recognise the Next.js proxy.** A key is bound only
> on a request `proxy-guard` tagged `clientType: 'web'`, because that is the only signal the
> backend has that a request came through the proxy that holds the session cookie — and nothing
> else can run the renewal. Without proxy-guard configured, `setSessionBinding` answers 400
> `SessionBindingUnavailableError` rather than turning on a switch that would protect nothing.

**What a copied cookie can and cannot do.** Before the bound key expires, a copy is
indistinguishable from the original by anything the server sees — that is the honest statement, and
the browser-family check below is the only thing standing in front of it. After the key
expires, the copy has nothing: renewal needs the passkey, and the account's own browser is the one
holding it. Turning binding *off* is the privileged direction here, the reverse of the usual
posture: `assertRecentAuthentication` is satisfied by the age of the device key a request is signed
with, and a cookie copied in the ten minutes after a sign-in carries exactly that — so leaving
`'passkey'` mode asks for a passkey assertion or the account password, never key age alone.

**Every web session of the account is bound, and a bound key past its grace is dead.**

- *A web key* is one registered or used on a request `proxy-guard` tagged `clientType: 'web'`, or
  one that replaced such a key by rotation or renewal — recorded on the key row (`via_web_proxy`)
  when it is written and, by the throttled last-use statement, at its first use through the proxy;
  never read from the request body or the declared
  `platform`, and never cleared. A native client's key, a
  device-code device's and a session of an application's own auth profile are not web keys, and
  binding never touches them: they hold no cookie to copy and no browser to renew in.
- *Turning it on* binds, in the same transaction and under the account lock, every web key of the
  account that is live or still waiting on a second factor — not just the one that asked. Each gets
  a bound key's short life from that moment and is asked for a passkey renewal at its expiry, so a
  copied session the owner is reacting to ends there. Expired and revoked keys are not given a new
  life by being bound.
- *A web key that is unbound on a bound account* — a key registered before `via_web_proxy`
  existed, recognised at its first use through the proxy — is bound whenever it is used, from that
  state rather than from the moment the flag was set: the request is served, and the bind, under
  the account lock, re-reads the state. A bind that fails (a lock timeout, a busy account, the
  process exiting) is tried again at the key's next use.
- *Keys written afterwards* are bound where every key is written (`registerPublicKeyService`),
  under the account lock, from the account's setting and whether the key is a web key: a web
  sign-in, a re-registration of an unbound web key, and a rotation of one all come out bound.
- *Turning it off* returns to ordinary 90-day keys only the bound keys not yet expired — live, or
  still waiting on a second factor — and **revokes** the others in the same transaction (their
  streams close): an expired bound key, inside its renewal grace or past it, parked behind a second
  factor or not, could only have been renewed with the passkey, and turning binding off never
  hands it a new life. A parked one loses its pending mark, so its challenge activates nothing.
- *The sweep* (`auth.mfa.sweep`) revokes bound keys past their grace daily, so an expired bound key
  does not linger as an "active" row.
- *Signing out* accepts a bound key that has expired but is still inside its grace, admitted as
  renewal admits it, and revokes it — from any browser family (the family check below does not
  apply to sign-out); the proxy clears the cookies whenever sign-out revoked the key
  or the backend answers 401 to the session the request presented. A key past its grace gets the
  answer any dead key gets, and the cookies are cleared all the same. A 401 to a sign-out that
  presented no session — a cross-site form POST arrives without the `SameSite=Lax` cookie — clears
  nothing. On a 5xx, or when the backend cannot be reached,
  the cookies are kept — the key may still be live, and clearing them would leave it signing in a
  copy the browser no longer shows — and the user signs out again.

**An owner who lost every passkey.** A bound session cannot be renewed without one, and adding a
passkey asks the passkey proof — so the way back goes through turning binding off:

- *With a password*: sign in with it (the new session is bound, live for its short life), turn
  binding off with the password (`disableSessionBinding(api, { currentPassword })`), then add a
  passkey and turn binding on again.
- *With a verified e-mail and no password*: reset the password by e-mail
  ([Password reset](#password-reset-verified-email)), then the same.
- *With neither*: only the operator. `resetSessionBindingService(userId)` turns binding off with
  no proof and releases the keys as turning it off does; it is a service, not a route — the
  application decides who may call it. `resetSecondFactorService(userId)` does not touch binding.

<a id="letting-another-credential-in"></a>
**Letting another credential in.** A copy of a bound cookie works until its key expires. A
session that could, in those hours, hand out a credential that outlives its key would make the
copy permanent — so on an account with binding on, every procedure by which a session lets
another credential in asks a **passkey assertion made for that procedure**. A second factor or
the password does not satisfy it; binding's premise is the passkey. Accounts without binding are
not asked. The assertion must have **verified the person** (a PIN, a biometric —
`userVerified`), whatever `SPFN_AUTH_PASSKEY_USER_VERIFICATION` says; one that shows only
presence is refused 403 like no proof at all. The same holds for renewing a bound session and for
turning binding off with a passkey: each rests on the passkey as proof of the person, and a key
with no PIN proves only that someone holds it.

| Procedure | Route | Credential it would let in |
|---|---|---|
| `deviceApprove` | `POST /_auth/device/approve` | the waiting device's key — an ordinary 90-day key |
| `linkIssue` | `POST /_auth/device/link/issue` (`confirm` is bound to the issuing key) | the redeeming device's key — an ordinary 90-day key |
| `passkeyAdd` | `POST /_auth/passkeys/register/verify` | a passkey: renews bound sessions, signs in natively, turns binding off |
| `passwordSet` | `PUT /_auth/password` on an account with no password | a first factor; changing an existing password proves that password and is not asked |
| `socialLink` | `POST /_auth/oauth/:provider/link` | an identity that signs in natively; the callback refuses a bound account's link started without the proof |
| `oauth2Consent` | `POST /_auth/oauth2/authorize` with `approve: true` | a grant (180 days) and refresh token tied to no key |
| `opsTokenIssue` | `POST /_auth/ops-tokens` | an operator token that outlives every key, revoked only by `DELETE /_auth/ops-tokens/:id` |

Turning binding on asks the same proof (`bindingEnable`) of every account, bound or not: binding
then depends on exactly that assertion, so an account whose passkeys cannot make it is refused
rather than bound into sessions it could never renew.

The client asks `POST /_auth/session/passkey-proof/options { procedure }`, runs
`navigator.credentials.get()`, and sends the assertion as the route's `passkeyResponse` —
`provePasskey(api, procedure)` from `@spfn/auth/client` does the first two. Without it the
route answers **403 `PASSKEY_PROOF_REQUIRED`** and writes nothing. Each procedure is its own
challenge kind, stamped with the session that asked: an assertion made to approve a device
does not issue a link, and only that session can spend it. It is checked before the write and
spent under the account lock with it; an assertion that does not verify spends its challenge.
The device a device-code or device-link sign-in lets in still gets an ordinary key: a TV or a
CLI cannot renew with a passkey.

What else a live session can do, and why it is not asked: `keys/rotate` and `session/renew`
replace the session's own key under binding's rules; `POST /_auth/tokens` mints a 30-second
one-time token tied to its key; `mfa/totp/enroll` and `mfa/recovery/regenerate` add a second
factor, which signs nobody in. Promoting another account (`PATCH /_auth/admin/users/:userId/role`)
and admin invitations are not asked either: they give authority to **another** account, not a
credential of this one. Binding protects this account's sessions, not what an admin session may
administer while it lives. An admin with binding on issues ops tokens from a browser that holds
the passkey: the `spfn` CLI, which signs in with the password, is refused 403
`PASSKEY_PROOF_REQUIRED` for such an account.

**The renewal page.** Once the key has run out, the backend refuses with `KeyExpiredError`, and
for a key renewal still admits — bound, not revoked, inside its grace — the refusal says so
(`details.renewable: true`, defined once in `server/lib/admission-refusal.ts`). The proxy turns
that refusal into 401 `SessionRenewalRequiredError` and keeps the cookies: the session is waiting
on one prompt, not finished. Any other `KeyExpiredError` — an unbound key, a bound one past its
grace — clears the session. The decision is the key row's, read off the refusal, never the
cookie: the cookie holds no copy of the binding, so a key bound after its cookie was sealed (at its
first use through the proxy, or when the owner turned binding on from another browser) is asked to
renew like any other. The renewed session is sealed around the new key `renew/verify` registered. A client component calls `renewSession(api)`, which runs the
ceremony and gets a new bound key sealed into the cookie.

The proxy decides nothing from the cookie about binding: the key row is the fact, and only a
request that reached the backend can read it. That matters on the second device: turning binding
**off** rewrites every live bound key to an ordinary 90-day one, and another device's next request
is forwarded, the backend sees an ordinary key and answers 200 — no renewal prompt for a session that
does not need one, and no browser-family check for a key that is no longer bound.

> **Renewal is bound to the expiring key's own signature.** `session/renew/options` and
> `session/renew/verify` are not public: they take the ordinary bearer JWT the proxy signs with the
> private key in the session cookie, and the key being renewed is that JWT's `keyId` rather than
> anything the body says. The one thing they do differently from every other route is admit a key
> whose `expiresAt` has passed, while it is bound and inside its grace. So a caller who does not
> hold the private half of a key gets the same `SessionRenewalRefusedError` whatever key id they
> name — no credential, a wrong signature, an unbound key, a revoked key, one past its grace and an
> inactive account are one answer with one body, and whether a key id is live never leaks.
> The challenge `renew/options` issues is the key's own: another session's renewal cannot spend
> it, and an assertion that does not verify spends it, so a renewal is retried with new options.

```tsx
'use client';
import { renewSession } from '@spfn/auth/client';
import { authApi } from '@spfn/auth';

export function RenewSession({ returnTo }: { returnTo: string })
{
    return <button onClick={async () =>
    {
        const result = await renewSession(authApi);

        if (result.ok)
        {
            location.href = returnTo;
        }
    }}>Confirm it's you</button>;
}
```

A server-rendered page cannot run a WebAuthn ceremony, so `RequireAuth` sends it there instead of
to the sign-in page:

```tsx
<RequireAuth renewalPath="/auth/renew">
  <DashboardContent />
</RequireAuth>
```

`renewalPath` defaults to `SPFN_AUTH_SESSION_RENEW_PATH`, and that to `/auth/renew`.
`getAuthSessionData()` answers a third state, `'renewal-required'`, for apps writing their own
guard.

**The browser-family check.** Independently of expiry, a bound key presented from a different
browser family than the one its row recorded (`registered_ua_family`) is refused 401
`SessionContextChangedError` **by the backend**, at admission, and the proxy's session decision
clears the three cookies on it (it is in the key-refused family). Browsers do not share cookie
jars, so that move cannot happen without a copy. The comparison is coarse on purpose — five
families, `edge` / `chrome` / `firefox` / `safari` / `other`, and **no desktop/mobile axis** — so a
version bump, a user-agent reduction and Android's "Request desktop site" are all the same browser.

- **The key row decides, not the cookie.** A session bound after its cookie was sealed — at its
  first use through the proxy, or when the owner turned binding on in another browser — is checked
  from its next request. The family is the one recorded when the key was registered, copied by
  rotation and renewal and never overwritten; a bound key with **no recorded family** (one that
  predates the column, or was registered without a `user-agent`) is admitted unchecked until a
  passkey renewal records the renewing browser's.
- **A server-rendered page carries the browser's `user-agent`.** `@spfn/core`'s server-side client
  forwards the inbound request's `User-Agent` with its cookies, and the proxy forwards it to the
  backend. A request without one is the family `other`, compared like any other: a custom
  server-side caller that does not use the SPFN client must forward the browser's `User-Agent`
  itself, or a bound session is refused.
- **Chrome on iOS and Safari on iOS are different families.** They are different cookie jars, so a
  session moving between them moved by being copied. An in-app `SFSafariViewController` shares
  Safari's jar and carries no badge of its own, so it reads as `safari` and passes.
- **Sign-out is not checked**, and neither are unbound keys: the check exists for sessions that
  asked for it.

**The concurrent-use signal.** `listKeys` rows carry `concurrentUseAtMillis` — the last time one
key was seen from two client addresses inside `SPFN_AUTH_CONCURRENT_USE_WINDOW_MS`. It is a signal
for a device list to show and notify on, never a refusal: addresses change legitimately, several
times an hour for a phone. The addresses behind it are not exposed.

Only an address `proxy-guard` attested is recorded or compared. Without that attestation
`x-forwarded-for` is whatever the caller typed, and a caller who could alternate it on their own key
could raise "used from two places at once" whenever they liked; a request with no attested address
counts as no observation, which is also why one of them never makes the *next* request look like a
move. Where proxy-guard is not configured the signal simply never fires. One key writes at most one
address change per window, so a phone flipping between cellular and wifi costs one row update rather
than one per request.

**Unbound accounts are unchanged.** Every response and every query count is what it was: nothing
above applies to an account that did not opt in. No session cookie, bound or not, carries a copy
of the binding — the same four fields an app calling `saveSession()` by hand seals.

Contract 0.12.0. `KeySummary.binding`, `KeySummary.concurrentUseAtMillis`,
`LoginResponse.sessionBinding` and `LoginResponse.keyExpiresAtMillis` are all optional and absent
for an account that did not opt in.

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
`getRole`, `getLocale`, `getChosenLocale` (`null` when the person never picked a language), `getKeyId`. Middleware: `authenticate`, `optionalAuth`,
`requirePermissions`, `requireAnyPermission`, `requireRole`, `roleGuard`, `oneTimeTokenAuth`.

## OAuth

OAuth uses a **pluggable provider registry** — not hardcoded branches. The built-in `google`,
`apple`, `github`, `kakao`, `naver`, and `battlenet` web providers self-register on module load; `apple` also
provides native `id_token` sign-in. External packages add providers at runtime with
`registerOAuthProvider()`. Google, GitHub, Naver, and [Battle.net](#battlenet) each require their client ID and secret;
Kakao requires its REST API key (and sends its optional client secret when configured); Apple
requires its Services ID, Team ID, Key ID and private key — see
[Sign in with Apple](#sign-in-with-apple-web-and-android).

Client flow: call `authApi.getGoogleOAuthUrl.call({ body: { returnUrl } })`, redirect the browser
to the returned `authUrl`, and render `OAuthCallback` on your success page. The Next.js interceptor
manages the keypair → pending-session-cookie → full-session handoff transparently.

A repeated `POST /_auth/oauth/finalize` — a reload of the callback page after the sign-in
finished — is answered with success and never ends a session: when the pending cookie is gone
and the browser's session already belongs to the key being finalized, the call is signed by that
session, and the proxy passes the 200 through and the finalize rule writes no cookie — the ordinary renewal still applies, so a session
within a day of expiry is re-sealed on that 200 for the same key. A finalize the proxy refuses
(no pending cookie and a different key, or a key mismatch) answers 401 and leaves the session the
browser holds in place; only a backend refusal of the key-refused family signs the browser out.

On an account with a [second factor](#second-factor-mfa) and a device it has not seen, the
callback carries `?mfaChallenge=` instead of `userId` and no session is created until
that challenge is spent — see [the web OAuth path](#the-web-oauth-path). Both the
`createOAuthCallbackHandler` route and the `OAuthCallback` page flow are handled.

The name a provider reports becomes the account's display name once. When a social account is
first attached — to a new account, or to an existing one matched by verified email
([`oauthEmailMatch`](#when-a-first-sign-ins-email-matches-an-existing-account)) — and that
account has no `user_profiles` row yet, the name is stored as `displayName`, trimmed; a blank name
is skipped. An existing profile is never overwritten and a later sign-in writes nothing, so a name
the person changed stays changed. An app that creates the profile row itself on `auth.register`
should upsert it rather than insert, because the row may already be there.

```tsx
// app/auth/callback/page.tsx
export { OAuthCallback as default } from '@spfn/auth/nextjs/client';
```

An app that completes the sign-in on a route handler instead of the page passes it its own RPC
proxy, so the callback finalizes through the same interceptors, backend URL and proxy secret as
every other call. Nothing records the proxy `createRpcProxy` builds, so the handler cannot find it
on its own; without `rpcProxy` it builds a default one, which differs silently from an app proxy
configured beyond the defaults.

```typescript
// app/api/auth/callback/route.ts
import { createOAuthCallbackHandler } from '@spfn/auth/nextjs/server';
import { POST } from '@/app/api/rpc/[routeName]/route';

export const GET = createOAuthCallbackHandler({ rpcProxy: { POST } });
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

Apple, GitHub, Kakao, Naver, and Battle.net use the provider-generic URL route:

```typescript
const { authUrl } = await authApi.getProviderOAuthUrl.call({
    params: { provider: 'github' }, // or 'apple', 'kakao', 'naver', 'battlenet'
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

`returnUrl` must be a path inside your app — absolute URLs, `//host`, `..`, a backslash, and a
tab/CR/LF (which a URL parser strips, turning `/<tab>/host` into `//host`) are refused, so a
real login cannot become an open redirect. The start seams answer an unsafe value with a 400
`ValidationError`; the seams that already hold a logged-in user replace the destination instead
of failing the login — `OAuthCallback` navigates to `/` and `createOAuthCallbackHandler`
redirects to its `defaultRedirectUrl` (`/` unless you pass one). The rule is exported as
`isSafeReturnPath` from `@spfn/auth/server`, `@spfn/auth/nextjs/server`, and
`@spfn/auth/nextjs/client` for apps that validate a destination before calling
`getGoogleOAuthUrl`.

Built-in OAuth routes: `POST /_auth/oauth/google/url`, `GET /_auth/oauth/google` (redirect),
`GET /_auth/oauth/google/callback`, `POST /_auth/oauth/finalize`, `GET /_auth/oauth/providers`,
plus the provider-generic `POST /_auth/oauth/start`, `GET /_auth/oauth/:provider/callback`, and
`POST /_auth/oauth/:provider/callback` for a `form_post` provider (Apple), Android's
`POST /_auth/oauth/apple/native/start` with `GET /.well-known/assetlinks.json`
([Android](#android-native-start-and-the-callback-relay)), and the signed-in
`POST /_auth/oauth/:provider/link` and `POST /_auth/oauth/:provider/unlink`
([linking](#linking-a-provider-to-a-signed-in-account)). `getGoogleAccessToken(userId)` returns a
valid Google access token (auto-refreshing via stored refresh token when near expiry; throws if
no Google account is linked or no refresh token is available).

Every authorization-code start carries PKCE (Google, GitHub, Kakao, Battle.net) or, for Apple, an
id_token nonce bound to the state, so an authorization code issued to one sign-in cannot be
finished in another; see [custom providers](#custom-providers). Every provider HTTP call gives up
after 5 seconds, and none runs inside a database transaction.

Kakao's `is_email_valid` and `is_email_verified` claims are both required before its email can
link an existing SPFN account. GitHub uses the primary email from `/user/emails` (needs the
`user:email` scope) and treats it as verified only when GitHub marks it verified; without that
scope it falls back to the public profile email, unverified. Naver's profile email is either the
Naver account email or a contact email that passed Naver's own verification, so a present email
is treated as verified — it is stored on the user row and may link an existing account by email,
the same trust level as Kakao. Whether a verified email links at all is the app's choice:
see [`oauthEmailMatch`](#when-a-first-sign-ins-email-matches-an-existing-account). Accounts created before this policy (user row with `email` null)
are backfilled on their next login: if the provider reports a verified email and no other account
owns it, `email` and `emailVerifiedAt` are filled in (best-effort; a conflict skips the backfill
and the login continues).

### When a first sign-in's email matches an existing account

The first sign-in with a provider identity — one no social row holds yet — may report an email an
existing account already has. `configureAuth({ oauthEmailMatch })` decides what happens, for every
provider and on both the web callback and `POST /_auth/oauth/:provider/native` (#156). Unset, it is
`'attach'`, the behavior of 0.3.0-beta.50:

| `oauthEmailMatch` | Result |
| --- | --- |
| unset or `'attach'` | a verified email links the identity to the existing account and signs in to it; an unverified one is refused with `UnverifiedEmailLinkError` (`reason=failed`) |
| `'reject'` | refused whether verified or not: the web error page with `reason=email_in_use`, native `409 OAUTH_EMAIL_IN_USE`. Neither account changes — no account, no social row, no key |
| `'separate'` | a new account, with no email because the other account holds it. `beforeRegister` runs with the provider's email and `emailVerified` as for any sign-up, `auth.register` fires, and the social row keeps the provider's email as `providerEmail` |

```typescript
configureAuth({
    oauthEmailMatch: 'reject',   // 'attach' (default) | 'reject' | 'separate'
});
```

Any other value — `'Reject'`, `'merge'` — makes `configureAuth` throw, naming the option and the
three values; it is never read as `'attach'`. The same holds for every policy value
`configureAuth` takes ([migration](#migration--social-oauth-refusals-write-nothing-one-identity-per-provider-pkce)).

Someone who signed up with Google later signs in with Kakao, and Kakao reports the same email:

| Setting | What they see |
| --- | --- |
| `'attach'` | the Google account, with no notice (the default) |
| `'reject'` | the error page; on `reason=email_in_use` the app can say "sign in with Google, then connect Kakao in settings" |
| `'separate'` | a new account of its own, signed in with Kakao |

An identity that is already linked signs in to its account in every mode — `'reject'` never stops
it — and a sign-in whose email no account holds makes a new account as before. A `'separate'`
account stays without an email: the re-login backfill skips an email another account owns.

The refusal says nothing about the existing account: its details name the provider only, and it
comes before the account-status check, so a suspended or deleting account is answered
`email_in_use` too, never `account_unavailable`.

The match finds the address whatever case it is stored in. The startup backfill folds stored emails
to lower case, but leaves alone rows that differ only by case and logs their user ids as
capitalization conflicts (see [the FAQ](#faq)); a row an older instance wrote after the backfill
can also remain. A row stored in lower case wins over its case variants, as before. Without one, a
single variant such as `Owner@Example.com` is that account in every mode: `'attach'` links to it,
`'reject'` refuses, `'separate'` makes a new account without the email. Two or more variants with no
lower-case row (`Owner@Example.com` and `OWNER@Example.com`) cannot be told apart, so `'attach'`
refuses them with the same `409 OAUTH_EMAIL_IN_USE` (`reason=email_in_use`) as `'reject'`, rather
than link the identity to the wrong one; `'separate'` still makes a new account. The operator settles
those accounts; sign-up, the registration code, the signup link and invitations treat any variant as
an existing account the same way. Password login and reset still look up the exact lower-case address.

| Error | HTTP | `code` | When |
| --- | --- | --- | --- |
| `OAuthEmailInUseError` | 409 | `OAUTH_EMAIL_IN_USE` | `oauthEmailMatch: 'reject'` and the first sign-in's email belongs to an existing account, or `'attach'` and it belongs to several accounts stored in different cases |

The mobile contract lists `OAuthEmailInUseError` since 0.13.7.

### Battle.net

`battlenet` is a web provider for Blizzard's Battle.net OAuth. Create an API client at
develop.battle.net and register the callback `{app origin}/_auth/oauth/battlenet/callback` as its
redirect URL.

| Variable | Required | Meaning |
| --- | --- | --- |
| `SPFN_AUTH_BATTLENET_CLIENT_ID` | yes | API client ID. With the secret, the provider is enabled |
| `SPFN_AUTH_BATTLENET_CLIENT_SECRET` | yes | API client secret, sent to the token endpoint as HTTP Basic |
| `SPFN_AUTH_BATTLENET_REGION` | no | `global` (default, `https://oauth.battle.net`) or `cn` (`https://oauth.battlenet.com.cn`) |
| `SPFN_AUTH_BATTLENET_SCOPES` | no | Comma-separated; defaults to `openid`. Add game scopes such as `sc2.profile` here |
| `SPFN_AUTH_BATTLENET_REDIRECT_URI` | no | Override of the callback URL, held to the web app origin like the other providers |

With `openid` alone Battle.net releases the account id and the BattleTag — no email and no name.
That decides how a Battle.net sign-in behaves:

- The provider user id is the Battle.net **account id**, never the BattleTag. A BattleTag can be
  changed (a paid name change); the id cannot.
- A Battle.net sign-in never reaches an existing account by email, because there is none. Each
  Battle.net identity signs in to the account it is attached to, or makes a new one with no email.
  To attach it to an account that already exists, the person signs in that account first and
  [links Battle.net from the session](#linking-a-provider-to-a-signed-in-account).
- The BattleTag is the account's display name once, at sign-up, like any provider-reported name.
- The **current** BattleTag is kept on the social account as `providerHandle` and replaced on
  every sign-in and link, and `auth.login` / `auth.register` carry it as `providerHandle` beside
  `providerUserId`. Read it there, not from the display name.

An app that wants Battle.net only as a linked identity — the person signs in another way and
connects Battle.net from their settings — makes it [link-only](#link-only-providers-and-recent-authentication):

```typescript
configureAuth({
    oauthProviders: {
        battlenet: { signIn: false },
    },
});
```

Every Battle.net sign-in is then refused with `reason=link_only`, including one by an identity
already linked to an account, and `GET /_auth/oauth/providers` lists Battle.net under `linkOnly`
rather than `providers`. Refusing Battle.net in [`beforeRegister`](#registration-gate-beforeregister)
is not the same: the hook runs only for a new account, so an identity already linked still signs in.

### Linking a provider to a signed-in account

A signed-in person can attach a provider identity to their own account and detach it again. This is
how an identity with no email — Battle.net — reaches an account that already exists, and it works
for every web provider.

```typescript
import { authApi } from '@spfn/auth';
import { isOAuthLinkOutcome } from '@spfn/auth/nextjs/client';

// on the settings page
const { authUrl } = await authApi.oauthLinkStart.call({
    params: { provider: 'battlenet' },
    body: { returnUrl: '/settings/connections' },
});
window.location.href = authUrl;

// back on /settings/connections?oauthLink=linked&provider=battlenet
const outcome = new URLSearchParams(location.search).get('oauthLink');
if (isOAuthLinkOutcome(outcome)) showLinkResult(outcome);

// detaching it
await authApi.oauthUnlink.call({ params: { provider: 'battlenet' }, body: {} });
```

The provider returns to the same `GET /_auth/oauth/:provider/callback` a sign-in uses, so the
provider needs no second redirect URL. The state a link start seals opens only as a link, and a
sign-in state only as a sign-in. A link registers no device key and emits no `auth.login`: the
session it started from stays the session.

Both routes are authenticated and gated like a [passkey](#passkeys-webauthn) change, because a
linked identity is one more way into the account:

- an account with a [second factor](#second-factor-mfa) must have stepped up on this device within
  its window (`403 STEP_UP_REQUIRED`);
- the session's device key must be younger than the link window, or the body carries
  `currentPassword` (`403 RECENT_AUTH_REQUIRED`). The window is `oauthLink.recentAuthMinutes`,
  else `SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES`, else 10 minutes. The app can turn this rule off
  per provider; [see below](#link-only-providers-and-recent-authentication).

An account holds at most one identity per provider — a `UNIQUE (user_id, provider)` constraint
every write meets: a start for a provider the account already holds is
`409 OAUTH_PROVIDER_ALREADY_LINKED`, a link that meets the constraint at the callback ends
`provider_already_linked`, and a first sign-in that would attach a second identity by email is
refused with `reason=provider_already_linked`. The Next.js interceptor `oauthLinkInterceptor`
checks `returnUrl`, injects the CSRF nonce, and sets the CSRF cookie the callback checks, exactly
as a sign-in start does — a link finished in a browser that did not start it is refused.

The callback sends the browser back to `returnUrl` with `oauthLink=<outcome>&provider=<id>`:

| `oauthLink` | Meaning |
| --- | --- |
| `linked` | The identity is on this account (also when it already was; its tokens and handle are refreshed) |
| `cancelled` | The person declined at the provider |
| `linked_elsewhere` | The identity belongs to another account. Neither account changed — nothing is merged |
| `provider_already_linked` | The account gained another identity of this provider meanwhile |
| `account_unavailable` | The account is disabled, pending deletion, or gone |
| `provider_error` | The provider reported an error or could not be reached |
| `failed` | Anything else — among them, the session that started the link was signed out, or the account's key generation moved (a password change, a sign-out everywhere) since the start |

The checks at the link start — step-up, recent authentication — are an early refusal. The state
carries the starting device key and the account's key generation, and the callback admits them
against the account when it lands: the starting key — or the key a verified re-login replaced it
with — still live, of the same generation, and the person admitted now. A session signed out
meanwhile cannot finish a link it started. Because the callback has no session to present, only a session signed in
with a device key can start a link: one signed in through an application's auth profile is
refused at the start with `403 OAUTH_LINK_CREDENTIAL_UNSUPPORTED`.

A link that cannot be confirmed as this browser's — expired after ten minutes, a missing or
mismatched CSRF cookie, a state brought to another provider's callback — goes to the
[OAuth error page](#the-error-page-reason-codes) with its `reason` instead. The codes are
exported as `OAUTH_LINK_OUTCOMES` / `isOAuthLinkOutcome` from `@spfn/auth`, `@spfn/auth/server`
and `@spfn/auth/nextjs/client`.

`POST /_auth/oauth/:provider/unlink` deletes the social account and its stored tokens. It is a
POST because the body may carry `currentPassword`. It is refused with
`409 LAST_RECOVERY_CREDENTIAL` when the identity is the account's last way in — no password, no
verified email, no passkey and no other social account — and with `404` when the account holds
no identity of that provider. It does not need the provider to be configured. A
[link-only](#link-only-providers-and-recent-authentication) provider's identity is never a way in,
so its unlink is never refused as the last one, and it does not count as the other way in when a
password-less account removes a passkey or unlinks another provider.

Two events, both after commit: `oauthLinkedEvent` (`auth.oauth.linked`: `userId`, `provider`,
`providerUserId`, `providerHandle?`) when an identity is newly attached, and
`oauthLinkRemovedEvent` (`auth.oauth.link_removed`: `userId`, `provider`, `providerUserId`) when
one is detached. A detach never emits `auth.oauth.unlinked` — that event means the provider
withdrew the connection, and its documented subscriber starts an account deletion.

#### Link-only providers and recent authentication

Two settings in `configureAuth`, both off by default — with neither set, sign-in and linking
behave as in 0.3.0-beta.49:

```typescript
configureAuth({
    oauthProviders: {
        battlenet: {
            signIn: false,                              // link-only (#157)
            recentAuth: { link: false, unlink: true },  // this provider's rule (#155)
        },
    },
    oauthLink: {
        recentAuth: { link: true, unlink: true },       // the rule for every other provider
        recentAuthMinutes: 10,                           // the link window, apart from the passkey one
    },
});
```

A **link-only** provider (`signIn: false`) can be linked to and unlinked from a signed-in account
and is never a way in:

| Where | A link-only provider |
| --- | --- |
| `getProviderOAuthUrl`, `POST /_auth/oauth/start`, Google's `POST /_auth/oauth/google/url`, `POST /_auth/oauth/:provider/native`, `POST /_auth/oauth/apple/native/start` | `403 OAUTH_PROVIDER_LINK_ONLY` (`OAuthProviderLinkOnlyError`) |
| `GET /_auth/oauth/:provider`, `GET /_auth/oauth/google` | redirect to the error page with `reason=link_only` |
| the callback, for a sign-in | error page with `reason=link_only` before the code is exchanged: no account, no key. A sign-in started before the setting is refused too |
| link and unlink | unchanged |
| `GET /_auth/oauth/providers` | listed in `linkOnly`, not in `providers` — draw sign-in buttons from `providers`, connect buttons from both |
| the last-way-in check | not counted |

**Recent authentication on link and unlink** is decided per provider and action:
`oauthProviders[p].recentAuth.link`, else `oauthLink.recentAuth.link`, else `true` — and the same
for `unlink`. Turned off, a link or unlink goes through from any valid session; an account with a
second factor still steps up. The window it uses when on is `oauthLink.recentAuthMinutes`, else
`SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES` (the window 0.3.0-beta.49 used), else 10 minutes. The link
path reads that variable as a number and never resolves the passkey configuration, so linking
works in an app with no `SPFN_AUTH_PASSKEY_*` set.

> **Turn `recentAuth` off only for a link-only provider.** On a provider people sign in with, a
> stolen session could attach the thief's own identity, and that identity keeps signing in after
> the session is revoked. A link-only identity signs in to nothing, so the rule has nothing left
> to protect.

The mobile contract lists `OAuthProviderLinkOnlyError` since 0.13.6.

### Sign in with Apple (web and Android)

One Apple sign-in serves all three clients: iOS uses [native sign-in](#native-social-sign-in-mobile--web-id_token),
and the browser and Android use the web flow — Apple ships no native SDK for Android, so an
Android app opens this same web flow in a Custom Tab, started by its own
[native start](#android-native-start-and-the-callback-relay). Start the browser's like any other
provider, with `getProviderOAuthUrl` and `params: { provider: 'apple' }`.

In the Apple Developer console you need:

- an **App ID** with the *Sign in with Apple* capability;
- a **Services ID** (its identifier is `SPFN_AUTH_APPLE_SERVICES_ID`) with Sign in with Apple
  enabled, the web app's domain, and `https://<app>/_auth/oauth/apple/callback` as its Return URL;
- a **Key** with Sign in with Apple enabled — download the `.p8` once
  (`SPFN_AUTH_APPLE_PRIVATE_KEY`, or its path in `SPFN_AUTH_APPLE_PRIVATE_KEY_FILE`) and note its
  **Key ID** (`SPFN_AUTH_APPLE_KEY_ID`);
- your **Team ID** (`SPFN_AUTH_APPLE_TEAM_ID`).

Apple accepts **https Return URLs only, never `localhost`**: local development needs an https
tunnel domain registered on the Services ID, with the app reached through it.

Apple returns with a `form_post` — a cross-site `POST` to the callback. The OAuth cookies are
`SameSite=Lax` and a browser does not send them on a cross-site POST, so
`POST /_auth/oauth/apple/callback` completes nothing: it answers `303 See Other` to
`GET /_auth/oauth/apple/callback` with the form fields (`code`, `state`, `user`, `error`,
`error_description`) in the query, and the browser's top-level GET carries the cookies into the
ordinary callback. The package signs the client secret JWT itself (ES256, one hour, cached) and
takes the identity from the id_token of the token response — Apple has no userinfo endpoint.

The person's **name arrives only on the first authorization** (Apple's `user` form field); later
sign-ins carry none. It is kept as the display name on that first sign-in — see
[OAuth](#oauth). The email is always the id_token's and may be a **private relay address**
(`…@privaterelay.appleid.com`) when the person chose *Hide My Email*.

#### Android: native start and the callback relay

The web flow ends in browser cookies an Android app cannot read, and its start mints a key of its
own. An Android app uses the same Services ID and Return URL through a native start instead:

1. The app posts `{ requestNonce, state, relayUrl }` to `/_auth/oauth/apple/native/start` and opens `authUrl` in a Custom Tab.
2. Apple's `form_post` to `/_auth/oauth/apple/callback` is answered `303` to `relayUrl` with `id_token`, `user`, `error`, `state`.
3. The app drops a link whose `state` it did not mint, and maps a missing `id_token` to a failure.
4. It posts the id_token to `POST /_auth/oauth/apple/native` with `nonce` = its key fingerprint, as on iOS.

`requestNonce` is the SHA-256 hex (64 lowercase) of the fingerprint of the key the app will enroll —
Apple puts it in the id_token as its nonce claim, so the relayed token enrolls that key and no
other. `state` is 16–128 characters of `[A-Za-z0-9_-]`. The start and the relay set no cookie and
touch no database; the start is rate limited like the web start, and it is the mobile contract's
`auth.enroll.oauthAppleRelayStart` (unproven, since contract 0.13.4).

| variable | value |
|---|---|
| `SPFN_AUTH_APPLE_RELAY_URLS` | the App Link(s) the callback may relay to, comma-separated |
| `SPFN_AUTH_ANDROID_PACKAGE_NAME` | the app's package name — its `applicationId` |
| `SPFN_AUTH_ANDROID_CERT_SHA256` | the SHA-256 fingerprint(s) of the key that signs the installed app |

The relay URL must be an **https App Link, listed exactly**: the start compares `relayUrl` with each
entry as a string, without normalising it, and a non-https URL is refused at boot — any app on the
device could claim it and receive the token of a flow an attacker started. Boot also refuses an
entry with userinfo, a query or a fragment, and relay URLs without the Apple web flow configured.

Write each entry in canonical form — lower case, an international host in punycode, and the
default port dropped — since the callback redirects to the URL's normalised form while the start's
comparison is an exact string match; a non-canonical entry here would never equal what the app
actually receives. Use the same host the app's manifest declares in `android:host`.

Android trusts the link only when the domain's `/.well-known/assetlinks.json` names the app. With
both `SPFN_AUTH_ANDROID_*` variables set, the API serves it (`404` when unset):

- the package name is the app's `applicationId`;
- the fingerprint is the **Play app-signing key**'s, from Play Console → App integrity → App
  signing — Play re-signs what you upload, so the upload key's fingerprint does not verify an app
  installed from Play. Never list a debug key on a production domain: the debug keystore is
  unencrypted, with the fixed password `android`, so anyone can sign an app with it.

`spfn init` writes a `/.well-known/assetlinks.json` → API rewrite beside `/_auth/:path*`. An app
created before this change adds it to `next.config` by hand:

```ts
{
    source: '/.well-known/assetlinks.json',
    destination: `${process.env.SPFN_API_URL || 'http://localhost:8790'}/.well-known/assetlinks.json`,
},
```

Android's verifier accepts a `200` with no redirect only, so a Next.js middleware that redirects
`/.well-known/*` (to add a locale or a trailing slash, say) breaks verification.

The `user` field — the person's name — arrives only on the **first authorization**, as on the web;
send it as `/native`'s `profile.name` then, because later sign-ins carry none. The mobile contract
declares it as `OauthNativeRequest.profile` since 0.13.5.

### Several sign-ins at once

Every start — the proxy's `oauth/*/url` interceptor and the API-mode `POST /_auth/oauth/start` —
writes its **own** pair of cookies, so a person who opens the sign-in in two tabs can finish both,
in either order:

| cookie | name | value |
|---|---|---|
| pending session | `<base>.<issuedAt>.<id>` on `spfn_oauth_pending[_PORT]` | the sealed private key, key id and algorithm |
| CSRF nonce | `<base>.<issuedAt>.<id>` on `spfn_oauth_csrf[_PORT]` | the raw nonce sealed into that start's state |

`<base>` is the fixed name the cookie had before, `SPFN_PORT` suffix included; `<issuedAt>` is the
start time in seconds, base-36; `<id>` is the first 16 hex characters of SHA-256 over the start's
key id. Neither the key id nor the nonce appears in a name. Both cookies stay `HttpOnly`,
`SameSite=Lax`, `Path=/`, `Secure` in production, ten minutes.

- **Cap of five.** At most five starts live in one browser. A sixth expires the oldest start's two
  cookies in the same response; that start's callback then finds none of its cookies and is
  refused with `reason=no_cookie`.
  Worst case the five pairs add about 3.4 KB to the `Cookie` header (one ES256 pair is ~670 bytes).
  A name dated more than a minute ahead of the server's clock counts as the oldest, so it is
  evicted first and is never "the most recent start".
- **Callback.** The state is decrypted first; its key id names the CSRF cookies to compare, under
  any port suffix (the API process may run under another `SPFN_PORT` than the Next.js process that
  set it) — more than one when an API-mode client started twice with one key. Every value is
  compared with the state's nonce in constant time and only the matching cookie is expired. A
  refused callback expires nothing, so a login-CSRF attempt cannot break a sign-in in flight in
  another tab.
- **Finalize.** The proxy, `createOAuthCallbackHandler` and the second-factor 202 pick the pending
  cookie by the key id the callback named, and expire that cookie only. The 202 body of
  `POST /_auth/oauth/finalize` carries that `keyId` (additive).
- **Sign-out** expires every start's cookies.

In a server component or route handler, `getPendingSession(keyId?)` from
`@spfn/auth/nextjs/server` returns that start's pending session, or — called without an argument
— the most recent start's. `clearPendingSession()` clears all of them. `sessionCookieNames()`
returns `oauthPendingPrefix` (`spfn_oauth_pending[_PORT].`): every in-flight start's pending
cookie begins with it. `oauthPending` still names the fixed legacy cookie.

**Upgrading.** A sign-in started before the upgrade holds the fixed-name cookies; the callback and
the finalize fall back to them, so it still finishes, and both are expired after use. An app that
read the pending cookie by its exact name (`sessionCookieNames().oauthPending`) reads a cookie new
starts never write — match on `oauthPendingPrefix`, or call `getPendingSession(keyId)`.

In a split deployment, **upgrade the backend first.** A proxy on this version writes only per-start
names, and a backend on an older one looks for the fixed name at the callback — so every OAuth
sign-in fails until the backend catches up. A backend on this version reads both. After a rollback,
a sign-in that was in flight across it shows a state validation error; trying again works.

### The error page: `reason` codes

Every redirect to `SPFN_AUTH_OAUTH_ERROR_URL` (and to `createOAuthCallbackHandler`'s
`errorRedirectUrl`) carries `reason=<code>` beside the `error` text, classified by the error's
type. Branch on `reason`; show `error` if you like. The codes are the closed union
`OAuthErrorReason` (with `OAUTH_ERROR_REASONS` and `isOAuthErrorReason`) from `@spfn/auth`,
`@spfn/auth/server` and `@spfn/auth/nextjs/client`.

| `reason` | cause | `error` text |
|---|---|---|
| `cancelled` | the person declined at the provider (`error=access_denied`, or Apple's `error=user_cancelled_authorize`) | the provider's `error_description` or `error` |
| `expired` | the sign-in took longer than ten minutes | a fixed sentence |
| `invalid_state` | the state does not decrypt, it names another provider, the CSRF cookie holds a different nonce, or the pending cookie does not unseal or holds another key | a fixed sentence |
| `no_cookie` | the callback or the finalize found none of the cookies the start set: the browser keeps no cookies for the site, or the sign-in began in another browser (added in 0.3.0-beta.38, #129) | a fixed sentence |
| `provider_error` | any other provider `error=…`, or the token exchange / user-info call failed | the provider's text; a fixed sentence for a library failure |
| `account_unavailable` | the account is disabled, pending deletion, or gone | unchanged |
| `link_only` | the app made this provider [link-only](#link-only-providers-and-recent-authentication): it can be connected from a signed-in account, never used to sign in (added in 0.3.0-beta.50, #157) | a fixed sentence |
| `email_in_use` | a first sign-in with this provider reported the email of an existing account and the app set [`oauthEmailMatch: 'reject'`](#when-a-first-sign-ins-email-matches-an-existing-account), or `'attach'` found that email on several accounts stored in different cases (added in 0.3.0-beta.51, #156) | a fixed sentence |
| `signup_disabled` | a first sign-in with this provider would have created an account, and the app turned sign-up off with [`channels: { signup: false }`](#which-sign-in-channels-exist-channels) (#308) | a fixed sentence |
| `provider_already_linked` | a first sign-in with this provider matched an account by email, and that account already holds another identity of the same provider — one per provider per account (au5) | a fixed sentence |
| `sign_in_contended` | a concurrent sign-in or sign-up committed the same identity or address first, and running this one again did not settle it — signing in again does; nothing was written | a fixed sentence |
| `sign_in_refused` | the app refused the sign-in in its [`signIn.admit`](#the-sign-in-guard-signin) (#361); nothing was written | unchanged |
| `failed` | anything else — missing `code`/`state`, an unverified email that would link an account (`oauthEmailMatch` unset or `'attach'`), a missing role | unchanged |

A refused sign-in writes nothing: no account, no social row, no key, no stored token, no event.
The callback asks the provider first, then does every write in one transaction, and builds the
error page only after that transaction rolled back.

`SPFN_AUTH_OAUTH_ERROR_URL` takes `{reason}` beside `{error}`
(`/auth/error?error={error}&code={reason}`); a template without `{reason}` gets `reason` as a query
parameter, placed before any `#fragment`. `OAuthCallback` passes the code too —
`onError(message, reason)` and `errorComponent(message, reason)`: the backend's code when the
callback query carried one, `expired`, `invalid_state` or `no_cookie` for a finalize the proxy
refused, and
`failed` otherwise.

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
| Naver | API 설정 > 연결끊기 Callback URL | `https://<host>/_auth/oauth/naver/unlink-notify` | HMAC-SHA256 signature + AES-128-CBC `encryptUniqueId` (key = `md5(client_secret)[0..16]`), and a signed `timestamp` within five minutes of now | 204 No Content |

The signature proves Naver sent a notification, not when. A notification whose `timestamp` is
more than five minutes from the server's clock is refused with 400 and changes nothing, so a
captured one cannot be replayed to remove a link made later or to announce `auth.oauth.unlinked`
again. Naver does not retry a failed notification. Keep the server's clock synchronized.

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
finds the start's CSRF cookie by the id in its name under any port suffix and compares its
value with the state nonce, so no PORT coordination is needed (see
[Several sign-ins at once](#several-sign-ins-at-once)).

An explicit `SPFN_AUTH_<PROVIDER>_REDIRECT_URI` is checked when the server boots, because the
value used to be read lazily on the first OAuth request and a wrong one surfaced much later as
a CSRF refusal nobody traced back to it. A value that does not parse, or whose origin is not the
web app origin, or whose path is not `/_auth/oauth/<provider>/callback`, refuses to start — one
error naming every offending variable:

```
SPFN_AUTH_GOOGLE_REDIRECT_URI must be on the web app origin (http://localhost:3790) at
/_auth/oauth/google/callback: the callback's CSRF cookie is host-only and /_auth/* is forwarded
to the API by the app's rewrite. Unset it to use the default, fix the origin, or set
SPFN_AUTH_OAUTH_CALLBACK_ORIGIN_CHECK=off for a deployment that deliberately terminates the
callback elsewhere.
```

One caveat: the direct `POST /_auth/oauth/start` flow (no Next.js interceptor) sets its CSRF
cookie on the **API host**. If you use that flow in a split deployment, set the corresponding
provider redirect URI explicitly to the API host callback **and**
`SPFN_AUTH_OAUTH_CALLBACK_ORIGIN_CHECK=off` — that is the one deployment the check is wrong
about, and `off` is the only value that disables it.

### Native social sign-in (mobile / web id_token)

For native apps the client obtains an `id_token` from the platform SDK and posts it to **`POST /_auth/oauth/:provider/native`**. No
authorization code, no client secret: the server verifies the id_token against the provider's
JWKS (signature, issuer, audience, expiry, nonce), links/creates the user, and **registers the
client's public key**. It returns `{ userId, keyId, isNewUser }` — *not* a token. The client mints
its own Bearer client token by signing with the on-device private key (the same client-signs /
server-verifies model as the rest of auth).

Enable per provider by declaring the accepted audiences: `SPFN_AUTH_GOOGLE_NATIVE_CLIENT_IDS` for
Google (the web `SPFN_AUTH_GOOGLE_CLIENT_ID` is also accepted), `SPFN_AUTH_APPLE_CLIENT_IDS` for
Apple, and `SPFN_AUTH_KAKAO_NATIVE_CLIENT_IDS` for Kakao (the REST API key in
`SPFN_AUTH_KAKAO_CLIENT_ID` is also accepted). `SPFN_AUTH_APPLE_SERVICES_ID` is also accepted as
an Apple native audience. Apple's web flow — the browser, and Android, which has no Apple SDK —
completes the code flow instead; see [Sign in with Apple](#sign-in-with-apple-web-and-android).

```typescript
await authApi.oauthNative.call({
    params: { provider: 'apple' },                 // or 'google', 'kakao'
    body: { idToken, nonce, publicKey, keyId, fingerprint, algorithm: 'ES256', profile: { name } },
});
// → { userId, keyId, isNewUser }; client then signs its own ES256 Bearer token with keyId
```

Every refusal names itself. The response body carries `error.code` — the server's error class
name — alongside the usual `__type`, so a client that has no TypeScript error registry can still
tell the fourteen ways this call fails apart:

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
| `OAuthProviderLinkOnlyError` | 403 | hide that provider's sign-in button — the app made it [link-only](#link-only-providers-and-recent-authentication) |
| `KeyIdAlreadyRegisteredError` | 409 | generate a new keyId and retry |
| `OAuthEmailInUseError` | 409 | tell the user an account with this email exists: sign in to it and link this provider — the app set [`oauthEmailMatch: 'reject'`](#when-a-first-sign-ins-email-matches-an-existing-account) |
| `SignupDisabledError` | 403 | `code: 'SIGNUP_DISABLED'` — tell the user this app does not create accounts by sign-in; the app set [`channels: { signup: false }`](#which-sign-in-channels-exist-channels) |
| `OAuthProviderAlreadyLinkedError` | 409 | `code: 'OAUTH_PROVIDER_ALREADY_LINKED'` — the account this email matched already holds another identity of this provider; sign in to it and unlink that one first |
| `OAuthSignInContendedError` | 409 | `code: 'OAUTH_SIGN_IN_CONTENDED'` — a concurrent sign-in or sign-up committed this identity or email address first; start a new sign-in (a fresh id_token) |
| `TooManyRequestsError` | 429 | **the only retry-the-same-request code** |
| `Error` | 500 | generic failure |

The `nonce` is the **raw** nonce the client used; Apple hashes it (SHA-256) into the token, so send
the raw value for any provider. `profile.name` carries the name Apple returns only on first
sign-in; it is used when the id_token has no name of its own, and kept as the display name as
described under [OAuth](#oauth). Trade-off: skipping code exchange means no Apple refresh token / server-side revoke —
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

Implement `OAuthProvider` and register it. `SOCIAL_PROVIDERS` is `['google','apple','github','kakao','naver','superself','battlenet']`. Implement the optional `verifyNativeIdToken(idToken, { nonce })` to support native id_token sign-in.
`NormalizedIdentity.handle` is the name the provider shows for the account (a BattleTag); it is
stored as the social account's `providerHandle`, replaced on every sign-in and link, and carried on
the sign-in events.
A provider without a userinfo endpoint returns the identity its token response established as
`OAuthTokens.identity`, and the callback skips `getUserInfo()`. `exchangeCodeForTokens()` receives
`OAuthCodeExchangeOptions.user` — Apple's raw `user` form field (at most 2048 bytes) — beside `state`.
`callbackResponseMode: 'form_post'` declares a provider that returns with a cross-site POST, which
`POST /_auth/oauth/:provider/callback` accepts and 303-redirects to the GET callback.

**PKCE is part of the contract.** The start seals a fresh verifier into the state and the package
adds `code_challenge` (S256) and `code_challenge_method` to the URL `getAuthUrl()` returns;
`exchangeCodeForTokens()` receives the verifier as `options.codeVerifier` and must send it as
`code_verifier`. Every provider declares it — `registerOAuthProvider()` throws, naming the
provider, when `pkce` is missing or is neither of the two forms. One that cannot do PKCE says so,
and only then is the challenge left out:

```typescript
pkce: 'S256',
// or
pkce: { unsupported: true, reason: 'what binds the code instead, if anything' },
```

Built in: Google, GitHub, Kakao and Battle.net do PKCE. Apple and Naver declare it unsupported —
Apple binds the code with the id_token nonce (the SHA-256 of the state), and Naver's OAuth 2.0
surface takes no `code_challenge`. A provider whose token response carries an OpenID id_token binds
`oauthFlowNonce(state)` as its `nonce` and checks it at the exchange, as Apple, Google and Kakao do.
Give every HTTP call `providerRequestSignal()` (5 seconds).

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

Tokens are decrypted only where they are used: `getGoogleAccessToken()` and
`socialAccountsRepository.readTokens(id)`, which is also where a token under an older key is
re-encrypted. A sign-in, the link list and an unlink read the social row without its tokens, so a
key removed by mistake makes those tokens unusable without locking anyone out.

Deployments that need a KMS or per-account envelope encryption can call
`configureOAuthTokenCipher()` from `@spfn/auth/server` before the server starts. The custom cipher
receives the same account/token context and owns its key rotation policy.

**Integration contract for custom providers:**

- The built-in provider-generic callback route handles any registered provider. A custom callback is
  only needed when the provider does not follow the standard `code` / `state` response contract.
- If a custom callback calls `oauthCallbackService()` directly, do **not** wrap the route in
  `Transactional()`: the service asks the provider first and then opens its own transaction, and a
  refusal it throws has already been rolled back when your route turns it into a redirect.
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
await clearSession();                 // expires every cookie of this package
```

**What `getSession()` proves, and what it does not.** It proves that this server sealed the cookie
for that user id and that it has not expired. The user id is the account the backend
authenticated at sign-in — the owner of the key the cookie holds, never a value a page posted. It
is **not a live check**: a key revoked, an account suspended or deleted since the cookie was sealed
still reads as signed in here until the next request through the proxy clears it. Use it to
render; for anything that must hold now — authorization, or reading data that belongs to the user
— call the backend (`authApi.getAuthSession`, a guard, or your own authenticated route), which
re-derives the user from the key on every request.

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
`hasAnyPermission`, the OAuth pending-session helpers, and `createOAuthCallbackHandler`. The
guards read `GET /_auth/session`, whose role and permissions are `resolveAuthority`'s — the ones
`requireRole` and `requirePermissions` enforce on the API.

#### Loading the entry outside Next (tests)

The guards import the bare `next/navigation`: in a route handler, Next swaps only that
spelling for its server build, and `next/navigation.js` breaks `next build` (#151). Node's own
loader cannot resolve a bare `next/*` subpath, so a vitest suite that reaches this entry
inlines it and lets vite resolve the import. Its `server-only` import still needs the suite's
own stub, as any server-only module does.

```typescript
// vitest.config.ts
test: { server: { deps: { inline: [/\/@spfn\/auth\/dist\/nextjs\//] } } },
```

#### The guards' timeout

Every guard and helper above asks the backend for the session through one call,
`getAuthSessionData()`. Unset, that call waits as long as the API client does —
`SERVER_TIMEOUT`, 120 s by default, the same variable the backend uses for its own requests —
so a slow backend holds every protected render for up to two minutes. Bound it for the guards
alone:

```bash
# .env.local — read by the guards, in the Next.js process
SPFN_AUTH_GUARD_TIMEOUT=3000
```

Milliseconds, greater than 0 and at most 2147483647; a few seconds (`3000`–`10000`) suits most
apps. **A lookup that times out is an error, not a sign-out** (BREAKING — it used to read as no
session): the guard throws it, so the app's error boundary renders, the cookies stay and nobody
is redirected to sign in. So does a backend that answers 5xx or cannot be reached. Only a refusal
of the key-refused family — the codes on which the proxy clears the cookies — reads as signed out.
It is logged at error level as `Auth session lookup failed — not a sign-out`. A malformed value is
refused by the env validation, and at runtime throws the env registry's error naming
`SPFN_AUTH_GUARD_TIMEOUT`.

#### What a guard throws, and how to catch it

`getAuthSessionData`, `getUserRole`, `getUserPermissions`, `hasAnyRole`, `hasAnyPermission` and
`RequireAuth` / `RequireRole` / `RequirePermission` answer "signed out" (`null`, `false`, `[]`, a
redirect) only for the key-refused family. Everything else is thrown, as the error the API client
restores — match on `name` (and `status` / `errorType` for `ApiError`):

| failure | thrown | how to tell |
|---------|--------|-------------|
| the backend answered 5xx | its registered class — `InternalServerError` (500), `ServiceUnavailableError` (503), `AccountBusyError` (503), `DatabaseError`, … | `error.name`, `error.statusCode` |
| the backend cannot be reached (the proxy answers 502) or the proxy's own timeout ran out (504) | `ApiError` | `error.name === 'ApiError'`, `error.status` 502 / 504, `error.errorType === 'http'` |
| the Next.js server cannot reach its own proxy | `ApiError` | `error.errorType === 'network'`, `error.status === 0` |
| `SPFN_AUTH_GUARD_TIMEOUT` ran out | `ApiError` | `error.errorType === 'timeout'`, `error.status === 408` |
| a rate limit | `TooManyRequestsError` | `error.name`, `error.statusCode === 429` |
| a bound session presented from another browser | — (`null`: signed out, cookies cleared) | |
| an account held to enrolment (`secondFactor.required`) | — not thrown: the session route is an enrolment route, so the session comes back with `secondFactorEnrolmentRequired: true` | `session.secondFactorEnrolmentRequired` |

`SecondFactorEnrolmentRequiredError` (403, code `SECOND_FACTOR_ENROLMENT_REQUIRED`) is what an
enrolment-only session meets on every *other* route — your own data reads included — and it is
thrown there like any refusal that is not a sign-out.

A **public** layout that only wants to know whether to show the admin link decides for display,
and must not turn an outage into a page that fails to render. Catch, and render as signed out —
for display only; anything that must hold stays behind a guard that throws:

```tsx
import { hasAnyRole } from '@spfn/auth/nextjs/server';

export default async function PublicLayout({ children }: { children: React.ReactNode })
{
    // An outage hides the link; it does not sign anyone out or break the page.
    const showAdmin = await hasAnyRole(['admin']).catch(() => false);

    return <Shell adminLink={showAdmin}>{children}</Shell>;
}
```

Route an account the policy holds to enrolment to the enrolment page before anything else:

```tsx
import { redirect } from 'next/navigation';
import { getAuthSessionData, RequireAuth } from '@spfn/auth/nextjs/server';

export default async function AppLayout({ children }: { children: React.ReactNode })
{
    const session = await getAuthSessionData();

    if (session && session !== 'renewal-required' && session.secondFactorEnrolmentRequired)
    {
        redirect('/settings/security/enrol');
    }

    return <RequireAuth redirectTo="/login">{children}</RequireAuth>;
}
```

### Emptying the cookie jar from a route handler or middleware

`clearSession()` works where `next/headers` is writable. The page that answers *the API
refused your session* is usually a route handler or middleware holding a `NextResponse`
instead — `clearSessionCookies(response, request)` expires every cookie of this package on it —
the session, key-id and CSRF cookies, the pending second-factor, device-login, sign-up and
password-reset cookies, and every in-flight OAuth start's pending and CSRF cookie the request's
jar names (only the legacy fixed names when no request is passed) — and returns the same
response, so the call chains:

```typescript
import { clearSessionCookies } from '@spfn/auth/nextjs/server';

export function GET(request: NextRequest)
{
    return clearSessionCookies(NextResponse.redirect(new URL('/login', request.url)), request);
}
```

Never spell the names in your app. They carry an `SPFN_PORT` suffix (`spfn_session_4001`),
so two dev instances do not overwrite each other's cookies, and a hand-written copy of that
rule clears the wrong cookie without failing. Read them from `sessionCookieNames()`, which
returns `{ session, keyId, oauthPending, oauthPendingPrefix, csrf }` at call time —
`oauthPendingPrefix` is a prefix, not a name: every in-flight OAuth start's pending cookie
begins with it.

## CSRF protection

Cookie-authenticated mutations carry a CSRF token by default. Nothing to write: the
Next.js proxy issues the token with the session and the api client sends it back.

**What it protects.** The session cookie is `SameSite=Lax`, which already blocks the
classic cross-site form POST. What remains is what Lax does not cover: a sibling
subdomain that can write cookies on your parent domain (an XSS on `blog.example.com`
against `app.example.com`), browsers that predate or mis-implement Lax, and a domain
layout that drifts into `SameSite=None` later. This closes those.

**What it does not protect.** Nothing here helps against XSS on your own origin.
Script running on your origin can read the token cookie and call your API as the
user — that is true of every CSRF scheme, and no token design changes it. Same-origin
XSS is out of scope; Content-Security-Policy and output escaping are the answer to it.

### How it works

- On login, OAuth finalize, key rotation and every session renewal, the proxy sets
  `spfn_csrf` — a readable (non-HttpOnly) cookie holding only an HMAC of the session's
  key id, keyed by a subkey derived from `SPFN_AUTH_SESSION_SECRET`. No new variable,
  and the raw session secret is never used as the token key. Sessions that predate
  the feature get one on their first authenticated response, so upgrading does not
  require anyone to sign in again.
- The api client mirrors the cookie into the `x-spfn-csrf` header on **every** RPC call,
  GET-shaped ones included — see "Which requests are checked" for why it cannot narrow
  that itself. Where the header is *checked* is the proxy's decision, not the client's.
- The proxy **recomputes** the expected value from the session it just unsealed and
  compares it to the header, in constant time. It never compares the cookie to the
  header — that is the classic double-submit weakness, and it is exactly what a
  sibling subdomain defeats by tossing a cookie it chose. A tossed cookie fails here.
- The token derives from the session key id, so rotating the key invalidates it. The
  proxy reissues the cookie in the same response that rotates or renews the session.

The check runs in the proxy, not the backend, because only the proxy knows the
request's credential was ambient: it turns the session cookie into a short-lived
bearer JWT, so the backend sees `scheme:'bearer'` for cookie callers and for genuine
bearer clients alike.

### Which requests are checked

Only requests the proxy authenticates from the session cookie, and only when the
resolved **route** method is not GET/HEAD/OPTIONS.

Route method, not the method the browser used to reach the proxy. The api client picks
its wire method from whether the input has a body, and holds no route map — that is the
point of "no metadata codegen required" — so a mutation with nothing to send travels as
GET. `logout` is `POST /_auth/logout`; `revokeOpsToken` is
`DELETE /_auth/ops-tokens/:id`, called with only a path param. Both are `GET` on the
wire and both are forwarded as the route's real method. A client that withheld the
header on GET-shaped calls would therefore 403 them under `enforce`, which is why the
contract is "every call carries it" and the proxy alone decides where it is checked.
Gating in the proxy on the wire method would be worse still: a cross-site top-level GET
navigation *does* carry a `SameSite=Lax` cookie, so every mutation would stay reachable
that way.

Untouched, by construction: requests with no session, direct-to-backend bearer
clients, `clientProofV1` mobile callers, machine and ops tokens. None of them pass
through this code. A request without a session is answered exactly as before (the
backend returns 401) — a CSRF refusal only ever answers an authenticated request, so
the refusal itself cannot tell an anonymous caller whether anyone is signed in.

### Modes

| Mode | Behaviour |
|---|---|
| `off` | No check — except the OAuth2 consent POST, below. |
| `warn` | **Default.** Allows the request, logs one line per request that would be refused — except the OAuth2 consent POST, below. |
| `enforce` | Refuses with `403 {"error":"Forbidden","message":"CSRF token missing or invalid"}`. |

Existing apps get signal before breakage: unset means `warn`. Watch for
`@spfn/auth:interceptor:csrf` lines, then switch on. Apps scaffolded by `spfn init`
start at `enforce`.

```bash
# .env.local — read by the Next.js process, where the proxy runs
SPFN_AUTH_CSRF=enforce
```

```typescript
import { configureAuth } from '@spfn/auth/server';

configureAuth({
    csrf: {
        mode: 'enforce',
        // Exact backend route paths, params already substituted — not /api/rpc/… URLs.
        // For endpoints a browser session never calls, e.g. webhook receivers that
        // authenticate themselves by signature. An exempt path is unprotected for
        // cookie callers too, so list only endpoints that carry their own auth.
        exemptPaths: ['/webhooks/stripe'],
    },
});
```

`configureAuth` wins over the environment variable. `enforce` and `warn` both need
`SPFN_AUTH_SESSION_SECRET` — sessions need it anyway — and refuse rather than quietly
passing everything if it is missing.

**Routes that declare it are checked in every mode.** A route built with
`.csrf('required')` is refused without a matching header under `off` and `warn` too, and an
`exemptPaths` entry naming its path is ignored (with one warning line). The package declares
it on `POST /_auth/oauth2/authorize` — the consent decision, which issues an authorization
code for a third-party client on the strength of the session alone — and on
`DELETE /_auth/oauth2/grants/:id`, the button that disconnects a client. The declaration
travels in the generated route map (`createOAuth2AuthorizationCode: { …, csrf: 'required' }`).
For this package's routes the check reads it from the map `@spfn/auth` ships (`authRouteMap`),
looked up by method and the path the backend will route (`findRouteEntry` from
`@spfn/core/nextjs/server`), so it holds whether or not the app regenerated its own map. It
also reads the entry the RPC proxy resolved, `ctx.route` — never a path list — and checks the
request when either declares `required`.
Your own route can declare it the same way:

```typescript
export const removeMember = route.delete('/teams/:id/members/:userId')
    .use([authenticate])
    .csrf('required')
    .handler(async (c) => { /* … */ });
```

Regenerate the route map after adding one (`spfn codegen run`); for your own routes a map
without the entry leaves the route to the configured mode. Nothing else on your side changes: the cookie is
issued in every mode, the api client mirrors it, and a refusal repairs a missing one as
described below.

### If a request is refused

A refusal in a running app almost always means the token cookie is gone or stale while
the session is not — cleared by hand or by an extension, or a session that predates this
feature. Rotation is not a cause: the response that rotates the key reissues the cookie
in the same breath, and one browser has one jar, so other tabs pick the new value up
with it.

Two things repair it, and both are mechanical:

- **The 403 carries the fix.** The proxy is the one emitting the refusal, so it sets a
  fresh `spfn_csrf` on that very response. A browser that repeats the mutation succeeds.
  The refusal is otherwise unchanged — same status, same body.
- **Any authenticated response reissues a wrong one.** A response whose request arrived
  with no CSRF cookie, or with one that no longer matches the session, queues the
  correct value. A cookie that is merely *present* is not taken as proof it is right.

**The client does not retry a refused call**, so a user sees one failure before the
repaired state takes effect — the framework fixes the browser, not the click.

**Limitation — calls made from the server.** A Server Component cannot set cookies at
all, and Next.js does not forward `Set-Cookie` from a fetch the api client made on the
server to the browser. So neither repair reaches the jar when the refused call came from
a Server Component, a Server Action or a Route Handler; the next browser-originated
request through the proxy is what heals it. Server-side callers otherwise need no
change: the api client reads the whole jar through `next/headers`, and an explicit
`cookies` option merges over that rather than replacing it. Only a caller that
hand-builds a jar somewhere `cookies()` cannot be reached — build time, static
generation — has to include the CSRF cookie itself.

## How do I define roles and permissions?

Built-in roles: `superadmin` (priority 100), `admin` (80), `user` (10). Built-in permissions:
`auth:self:manage`, `user:read|write|delete|invite`, `rbac:role:manage`, `rbac:permission:manage`,
`ops:token:issue`. Custom roles/permissions are declared on the lifecycle (preferred — runs on
startup) or via `initializeAuth(options)`.

```typescript
createAuthLifecycle({
    roles: [{ name: 'editor', displayName: 'Editor', priority: 30 }],
    permissions: [{ name: 'post:publish', displayName: 'Publish Posts', category: 'content' }],
    rolePermissions: { editor: ['post:publish'] },
});
```

Programmatic checks (server): `resolveAuthority(userId)` — `{ role, priority, permissions, expiringPermissions }`, the
one answer every check below and `GET /_auth/session` read — and `hasPermission`,
`hasAnyPermission`, `hasAllPermissions`, `hasRole`, `hasAnyRole`, `getUserRole`,
`getUserPermissions` over it; `getStoredUserRole`. Runtime authority admin — each takes the
caller's user id first and holds them to the rule below: `createRole`, `updateRole`,
`deleteRole`, `setRolePermissions`, `addPermissionToRole`, `removePermissionFromRole`,
`changeUserRole`, `grantUserPermission`, `revokeUserPermission`; and `getAllRoles`,
`getRoleByName`, `getRolePermissions`.

- **Authority now.** The role in force is the stored role, unless it is deactivated (then none:
  no name, no priority, no permissions — reactivating restores it) or the
  [email-domain policy](#restricting-roles-to-email-domains) refuses it (then `user`).
  Permissions = the active permissions of that role + the person's own grants of active
  permissions that have not expired − their own revocations that have not expired. An account
  that is not active holds nothing. Read on the primary.
- **Who may change authority.** One rule: a caller changes only what ranks strictly below them,
  by `priority`, and confers only what they hold. Judged inside the transaction that writes the
  change, on the caller's authority as it is then.
  - *Giving or taking a role* (`assertCanChangeRole`): the caller outranks both the role given
    and the role the target holds now — 404 unknown role, 409 inactive role, 403 otherwise.
    Equals cannot change each other, so only a superadmin creates or demotes an admin, and nobody
    changes a superadmin or gives that role through the API (seed superadmins with
    [admin seeding](#admin-seeding)). The admin role change, invitation create, resend, cancel and
    acceptance all pass it.
  - *Changing what a role is, or a person's own grants* (`assertCanChangeAuthority`, 403): a role
    is created or re-ranked only below the caller's priority; a role is updated, deactivated,
    deleted or given or relieved of permissions only if the caller outranks it; a permission is
    attached to a role or granted to a person only if the caller holds it — and for as long: one
    the caller holds only through an expiring per-user grant is granted per user only to expire
    no later than theirs, and never attached to a role; a person's grants and revocations are
    changed only if the caller outranks the person's stored role.
  - Every role these judgements rest on is locked in the writing transaction, after the account
    lock where there is one, so a re-rank or deactivation of it waits for the change to commit:
    all of them in one call, in id order (`rolesRepository.lockInIdOrder`) — the role changed `FOR
    UPDATE`, the others `FOR SHARE` — so concurrent role edits queue and never deadlock. A caller
    whose role changes between the read naming it and the lock is judged again by the operation,
    once, on fresh reads (`runJudgedTransaction`); only a premise stale twice is a 409
    `AuthorityContendedError`, and asking again works. `updateRole` and `deleteRole` take no
    account lock.
- **Who owns a role.** Each role has exactly one owner (`roles.source`), by the same rule as a
  mapping:
  - `config` — declared by your configuration (`roles`, with the built-ins). **After every boot
    the fields the configuration declares equal it**: `name`, `displayName`, `description`,
    `priority` (10 when omitted), `isSystem`, `isBuiltin` (`RoleConfig`). Whatever changed them at
    runtime, by any means, is put back. Through the API those fields cannot be changed and the
    role cannot be deleted: 409 `ConfigOwnedRoleError`. `isActive` is the operator's —
    deactivating works, `superadmin` excepted.
  - `admin` — created by an operator (`createRole`). Entirely the operator's: boot leaves it alone
    unless the configuration comes to declare it, which makes it the configuration's. A role the
    configuration stops declaring becomes the operator's.
  - Permissions are declared only by the configuration (there is no runtime API that creates
    one), and every boot makes their `displayName`, `description`, `category`, `isSystem` and
    `isBuiltin` equal to it; `isActive` is the app's.
  - **Deleting a role never deletes an account**: while an account holds it, a pending invitation
    promises it or the email-domain policy names it, `deleteRole` answers 409 `RoleInUseError`
    with the counts. Its mappings and settled invitations go with it — a pending invitation past
    its `expires_at` is settled, since acceptance would refuse it, so it blocks nothing even before
    the expiry sweep marks it.
- **Who owns a mapping.** Each role→permission mapping has exactly one owner (`source`):
  - `config` — declared by your configuration (`rolePermissions`, with the built-ins). **After
    every boot these equal the configuration**: a mapping you remove from `rolePermissions` leaves
    the role, and one removed from the database by any other means is back. The boot sync is an
    upsert (`ON CONFLICT … SET source = 'config'`) and a delete of the configuration's mappings it
    no longer declares, so concurrent boots and operator adds meet in the conflict clause.
    The role service never removes one: `removePermissionFromRole` or a `setRolePermissions` that
    leaves it out answers 409 `ConfigOwnedMappingError` and changes nothing — remove it from the
    configuration instead. Adding one that already exists changes nothing: it stays the
    configuration's and disappears when the configuration drops it.
  - `admin` — added by an operator at runtime (`createRole`'s `permissionIds`,
    `addPermissionToRole`, `setRolePermissions`). Boot leaves these alone; the role service adds,
    replaces and removes only these (`setRolePermissions` keeps every existing mapping with its
    owner, deletes only the operator's that were dropped, and inserts new ones as the operator's).
    If the configuration comes to declare one, it becomes the configuration's.
- `superadmin` cannot be deactivated (409 for a role ranked above it; 403 for everyone else, who
  does not outrank it).
- **One configuration sync at a time.** Every boot's sync of roles, permissions, their release
  and mappings runs in one transaction under one advisory lock across instances, on one
  connection (a one-connection write pool boots), so a rolling deploy with two configurations
  ends in the configuration of the boot that synced last, never a mix. While it runs, an
  operator's change of a role the configuration declares or maps waits for it — answered 503 if
  that wait outlasts its own `statement_timeout`. A boot that waits 30 s for another instance's
  sync, or for a role an operator's change holds, is refused (`RbacSyncBusyError`, naming which
  lock and the backends holding it).

The typed refusals of the authority routes (each body carries `code`):

| Error | HTTP | Routes | When |
|---|---|---|---|
| `ConfigOwnedRoleError` (`CONFIG_OWNED_ROLE`) | 409 | `PATCH`, `DELETE /_auth/admin/roles/:id` | a field the configuration declares, or the deletion, of a role it owns (`details.fields`) |
| `RoleInUseError` (`ROLE_IN_USE`) | 409 | `DELETE /_auth/admin/roles/:id` | an account holds the role, an invitation that can still be accepted promises it, or the email-domain policy names it (`details` counts each) |
| `ConfigOwnedMappingError` (`CONFIG_OWNED_MAPPING`) | 409 | `removePermissionFromRole`, `setRolePermissions` (no route) | a mapping the configuration owns |
| `AuthorityContendedError` (`AUTHORITY_CONTENDED`) | 409 | `POST /_auth/admin/roles`, `PATCH` and `DELETE /_auth/admin/roles/:id`, `PATCH /_auth/admin/users/:userId/role`, `POST /_auth/invitations`, `/resend`, `/cancel`, `/accept`; the role-permission and per-user grant services | the role in force of the person the change is judged on — the caller, or the inviter at acceptance — changed between the read naming it and its lock, and again when the change was judged once more; nothing was written, ask again |

### Restricting roles to email domains

`SPFN_AUTH_ROLE_EMAIL_DOMAINS` keeps staff roles on staff accounts: each listed role may be
held only by an account whose email is **verified** and whose domain is listed for it.

```bash
SPFN_AUTH_ROLE_EMAIL_DOMAINS="admin=example.com;support=example.com,partner.example"
```

- **Format.** `role=domain[,domain]` entries separated by `;`. Whitespace is trimmed; domains
  are lowercased and IDNA-normalised (`bücher.example` and `xn--bcher-kva.example` are one
  domain). The domain of an address is the part after its last `@`. Matching is exact:
  `example.com` does not admit `sub.example.com` — list the subdomain if you mean it.
- **Opt-in.** Unset or empty means no policy, and a role absent from the map is unrestricted:
  both behave exactly as before, including granting a role to an unverified account.
- **At grant — refused.** `PATCH /_auth/admin/users/:userId/role`, `updateUserService` with a
  `roleId`, invitation create (the domain only: the invitee has not verified yet) and
  invitation accept (the full rule, against the configuration in force at acceptance —
  accepting verifies the address) answer `403 RoleEmailDomainNotAllowedError` with
  `details: { roleName, reason }`, `reason` one of `domain`, `unverified`, `no_email`. The
  address is never in the error.
- **At check — downgraded, never written.** Everything that resolves a principal's role —
  `authenticate` and the other authenticating middlewares, `requireRole`, `requirePermissions`,
  `getUserRole`, `hasRole`, `getUserPermissions` and the rest, `GET /_auth/session` — applies
  the rule to the current row and the current configuration. An account outside it resolves as
  the built-in `user` role (`getAuth(c).role === 'user'`, the `user` role's permissions; direct
  user permission grants still apply), so it keeps signing in. One `warn` is logged per
  resolution with `reason: 'role_email_domain_policy'`, the user id and the stored role — never
  the email. `users.roleId` is not touched: reverting the configuration restores the role on
  the next request. The check reads the row the request already loads; only a downgrade reads
  the `user` role.
- **Authority.** A caller is judged by the role in force; a **target** by the stored one, so
  an out-of-policy superadmin's row still only yields to someone who outranks superadmin — nobody.
- **At boot — refused.** After RBAC initialization and admin seeding, startup throws, naming the
  variable and the entry, when the value is malformed, when it restricts `user` (the fallback
  must always be satisfiable), when it names a role that does not exist, and when `superadmin`
  is restricted, at least one account stores it, and none of those accounts satisfies the rule
  (zero superadmins passes, so a fresh install boots). A seeded `SPFN_AUTH_ADMIN_*` account whose
  email the policy refuses for its role also refuses boot, before any account is created.
- **Per instance.** Nothing is stored in the database; each instance applies its own env.

Two server functions (`@spfn/auth/server`) for the app to call deliberately:

```typescript
import { listRoleEmailDomainViolations, demoteRoleEmailDomainViolations } from '@spfn/auth/server';

// Accounts whose stored role is restricted and who fail the rule — for a periodic check.
const violations = await listRoleEmailDomainViolations();
// [{ userId: 42, roleName: 'admin', reason: 'domain' | 'unverified' | 'no_email' }]

// Store `user` on exactly those accounts, through updateUserService; returns what it changed.
// Only violators are touched, so a compliant superadmin is never demoted.
const demoted = await demoteRoleEmailDomainViolations();
```

Ops tokens minted by an account that later falls outside the policy are **not** revoked: a token
records no owner. Revoke them with `spfn ops` if that matters to you.

## How do I declare per-person settings and profile fields?

A person's **profile** says who they are (name, avatar, bio, company — plus the fields you declare
below); their **settings** say how they use the app (language, timezone, a notification digest, the
template they used last). Both are declared in code, on the lifecycle beside roles, and the
library owns the tables and the migrations
([fxylabs/spfn#161](https://github.com/fxylabs/spfn/issues/161)).

```typescript
// src/server/auth-declarations.ts
import { defineUserSettings, defineProfileFields } from '@spfn/auth/server';
import { Type } from '@sinclair/typebox';

export const USER_SETTINGS = defineUserSettings([
    {
        key: 'notifications.digest',
        schema: Type.Union([Type.Literal('daily'), Type.Literal('weekly'), Type.Literal('off')]),
        default: 'daily',
    },
    { key: 'editor.lastTemplate', schema: Type.Union([Type.String(), Type.Null()]), default: null },
]);

export const PROFILE_FIELDS = defineProfileFields([
    { key: 'department', schema: Type.String({ maxLength: 80 }) },
    { key: 'github', schema: Type.String({ pattern: '^[A-Za-z0-9-]+$' }) },
]);

// server.config.ts
createAuthLifecycle({
    roles: [/* … */],
    userSettings: USER_SETTINGS,
    profileFields: PROFILE_FIELDS,
});
```

Both functions check the list when the module loads and throw on a key that does not match
`^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$` (at most 120 characters), a key declared twice, or a
default that fails its own schema. Each is installed once: a second install, or one after
`initializeAuth` completed, throws — the same rule as `registerAuthProfile`.

**Reading and writing settings** (`@spfn/auth/server`):

| Function | Does |
|---|---|
| `getUserSetting(userId, key)` | the stored value, or the default when there is no row |
| `setUserSetting(userId, key, value, { by })` | checks the value (`ValidationError`, 400, see the limits below) and stores it; a value equal to the default deletes the row instead. Returns the value as stored |
| `listUserSettings(userId)` | every declared key, built-ins included: `{ key, value, isDefault, updatedAt }`, one query |
| `resetUserSetting(userId, key)` | deletes the row, so the key reads as its default |

A key nobody declared is `UserSettingNotDeclaredError` (404) on all four, and nothing is written.
`USER_SETTINGS.get(userId, 'notifications.digest')` is the same read with the value typed
(`'daily' | 'weekly' | 'off'`); `.set` and `.list` likewise. A missing row *is* the default, so
changing a default in code reaches everyone who never chose.

**Built-in keys.** The library declares two, which an app may not redeclare:

| Key | Schema | Default | |
|---|---|---|---|
| `locale` | `string \| null` (at most 35 characters) | `null` | the language choice; `null` means "never chose, follow the request". Blank clears it. This is what `getLocale(c)` / `getChosenLocale(c)` read |
| `timezone` | `string` (at most 64 characters) | `'UTC'` | an IANA zone name (`Mars/Olympus` is a 400) |

**One rule for valid.** A value is valid for its key when it passes the schema, a built-in key's
own check (the IANA zone for `timezone`), and holds no NUL character (`\u0000`, which PostgreSQL
`jsonb` refuses) in any string. A write that is not valid is a 400; a stored value that is not
valid reads as the default. A setting value over **16 KiB** of JSON is a 400 before the schema runs.
A declared default has no size cap of its own and is cloned on every read that falls back to it, so
keep defaults small.

Without `userSettings`, only these two exist.

**Reconcile, not delete.** At boot, a stored key that no declaration names is reported in one
`warn` with its row count, and its rows stay: remove a key from code and declare it again later,
and the rows read again. A stored value that no longer passes its schema (say a deploy narrowed it)
reads as the default with one `warn` that names the key but not the person, and is not rewritten.

**Profile fields.** `user_profiles.metadata` holds the declared fields. Basic column names
(`displayName`, `bio`, `company`, …) and `locale`/`timezone` cannot be fields — a usage preference
belongs in settings.

- **With `profileFields`, `metadata` is strict.** `PATCH /_auth/users/profile` merges `metadata`
  key by key (keys it does not name stay); an undeclared key or a value failing its schema is a
  400 and nothing is written. `ProfileInfo.metadata` carries every declared key with its value or
  default, and no undeclared key; a stored value failing its schema reads as the default with one
  `warn` naming the key. Undeclared keys already stored are reported once at boot and kept. A
  stored `metadata` that is not an object (a legacy scalar or array) is replaced by the first merge.
- **Without it, `metadata` is free-form**, as before: any object, replaced wholesale on PATCH.
  Existing apps keep working; declare fields when you want them checked.
- **Either way**, a `metadata` patch over **64 KiB** of JSON (measured on the patch, before the
  merge) or holding a NUL character is a 400 and nothing is written.

From a client, the routes below are `authApi.listSettings`, `getSetting`, `setSetting` and
`resetSetting`; each acts on the signed-in person only — no route names a user:

```typescript
const { settings } = await authApi.listSettings.call({});
await authApi.setSetting.call({ params: { key: 'notifications.digest' }, body: { value: 'weekly' } });
```

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
import { authLoginEvent, authRegisterEvent, authDeviceRegisteredEvent, invitationCreatedEvent, invitationAcceptedEvent } from '@spfn/auth/server';

authRegisterEvent.subscribe(async ({ userId, email, provider, metadata }) =>
{
    if (email) await sendWelcome(email);
});
```

`authRegisterEvent` (`auth.register`), `authLoginEvent` (`auth.login`) and
`invitationAcceptedEvent` (`auth.invitation.accepted`) fire after the transaction that wrote the
account commits — on the web OAuth callback, email register, password login and invitation
accept alike. A subscriber can therefore read the rows the event announces from any connection,
and nothing fires when the transaction rolls back. A subscriber that throws, or a publish that
fails, is logged and does not fail the request: the sign-in or sign-up has already committed.
Before 0.3.0-beta.51 these three were published inside the transaction.

`authLoginEvent`'s `provider` is `'email'`, `'phone'`, a social provider, `'device'` or
`'passkey'`. `'device'` is a [device-code login](#device-code-login), where the account was
proven on another device that was already signed in and no credential was presented here;
`'passkey'` is a [WebAuthn assertion](#passkeys-webauthn). `authRegisterEvent` accepts
neither: a device-code request can only ever be approved by an account that already exists,
and a passkey has to be enrolled from a session that already exists, so neither is a signup.

`passkeyEnrolledEvent` (`auth.passkey.enrolled`) and `passkeyRevokedEvent`
(`auth.passkey.revoked`) fire after commit when a passkey is added or retired.

`mfaLockedEvent` (`auth.mfa.locked`: `userId`, `lockedUntil`) fires after commit, once, when an
account's fifth wrong second-factor proof in fifteen minutes locks its second factor
([the budget](#wrong-proofs-one-budget-per-account)). Subscribe to tell the owner: somebody is
guessing, or they are reading the wrong entry in their authenticator, and only they can say which.

On an OAuth sign-in, web or native, `authLoginEvent` and `authRegisterEvent` also carry
`providerUserId` and, when the provider reports one, `providerHandle` — the current
[BattleTag](#battlenet). `oauthLinkedEvent` (`auth.oauth.linked`) and `oauthLinkRemovedEvent`
(`auth.oauth.link_removed`) fire after commit when a signed-in person
[links or unlinks](#linking-a-provider-to-a-signed-in-account) a provider identity.

`authPasswordResetEvent` (`auth.password.reset`: `userId`, `email`) fires after commit when a
[password reset](#password-reset-verified-email) completes. Distinct from a password
*change*, which is made from a session that already proved itself: this one is made by
whoever opened a link in a mailbox, so it is the notice to send the owner.

`authDeviceRegisteredEvent` (`auth.device.registered`) fires after commit whenever a device key is
registered on an account, on every channel that registers one — `channel` says which: `register`,
`signup-link`, `invitation`, `password`, `oauth`, `oauth-native`, `device-code`, `device-link`,
`password-reset` or `passkey`. It carries `userId`, `keyId`, `algorithm`, a 12-character `fingerprintPrefix`,
`createdAtMillis`, and whatever the registration knew about the device: `deviceName?`, `platform?`,
`ip?` and `userAgent?` — the web OAuth callback has neither label, because the sealed state does
not carry them. Subscribe to tell the owner a device was added: a login event says a session began
and not what it began on, so a stolen password used on a new machine was silent until this event.
Send it with a [sign-out-everywhere link](#the-sign-out-everywhere-link), which is the action the
notice should offer.

Both `authLoginEvent` and `authDeviceRegisteredEvent` carry `mfaEnrolled: boolean`, computed
as the event is emitted — whether the account has a factor of a method the policy lists. It is
the hook an app uses to offer a [second factor](#second-factor-mfa) at a first login or when a
new device appears. Without
[`secondFactor: { required: true }`](#requiring-a-second-factor-secondfactor) the package never
blocks an account that has none; with it, the sign-in of such an account still emits
`authLoginEvent`, with **`secondFactorEnrolmentRequired: true`** (always present, `false`
otherwise), and its session may only enrol.

A sign-in that answered **202** because the account needs a [step-up on a new
device](#step-up-on-a-new-device) emits neither event, and does not move `lastLoginAt` either.
Both are held until `POST /_auth/mfa/verify` succeeds and then fire together, carrying the
original channel — so an attacker holding only a password produces no login event and no
device notice on an account they never got into, which is exactly the signal the owner needs
these events to mean.

Key **rotation** is deliberately not announced — replacing the key of a device that is already
signed in is not a new device, and a notice for it would teach the owner to ignore the ones that
matter. A sign-in is only a rotation when the old key signed its `replacementProof` and was still
live: a bare `oldKeyId`, or a proof by somebody else's key, a revoked one, an expired proof or one
made for another key, registers a new device and fires the event. `ip` and `userAgent` are unauthenticated and display-only.

`invitationCreatedEvent` (`auth.invitation.created`) carries the invitation `token` — the only
copy, since only its hash is stored. Mail it from the subscriber; do not log or persist it.

Payload types: `AuthLoginPayload`, `AuthRegisterPayload`, `AuthPasswordResetPayload`,
`AuthDeviceRegisteredPayload`, `InvitationCreatedPayload`,
`InvitationAcceptedPayload`, `AuthDeletionRequestedPayload`, `AuthDeletionCancelledPayload`,
`AuthDeletionCompletedPayload`, `OAuthUnlinkedPayload` (`auth.oauth.unlinked` — provider-side
disconnect, see the OAuth unlink-notify section), `OAuthLinkedPayload`, `OAuthLinkRemovedPayload`,
`PasskeyEnrolledPayload`,
`PasskeyRevokedPayload`. `AuthLoginPayload` and `AuthDeviceRegisteredPayload` both gained
`mfaEnrolled` in 0.3.0-beta.23; `AuthLoginPayload` gained `secondFactorEnrolmentRequired` with
the second-factor policy (#309). These events also bind to `@spfn/core/job`
jobs via `.on(event)`.

## Registration gate (`beforeRegister`)

Events fire *after* the user exists — they cannot reject a registration. For server-enforced
signup policy (age gate, invite-only domains, block lists) inject a validator with
`configureAuth`; it runs **before the user row is created** on every registration channel:
`credentials` (email/phone register), `oauth` (new-user social signup, web + native), and
`invitation` (acceptance). Throwing rejects the registration; `RegistrationRejectedError` (403)
is the recommended error. The hook receives the same `metadata` the app supplied to
`register` / OAuth start / the invitation — never credentials.

To turn sign-up off altogether rather than filter it, use
[`channels: { signup: false }`](#which-sign-in-channels-exist-channels): the sign-up routes answer
404 `CHANNEL_DISABLED` and a first social sign-in is refused with `SIGNUP_DISABLED` before this hook would run.

To refuse a **sign-in** — every channel, the account existing or not — and to be told of each
attempt's outcome, use the [sign-in guard](#the-sign-in-guard-signin) instead.

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
- `email` arrives trimmed and lower-cased, the same form the account is stored under, so a
  denylist or domain allowlist keyed on the address is not walked past by capitalizing it.
- On the `oauth` channel `email` is the provider-reported address and may be **unverified**
  (the created account then stores `email` as `null`). The context carries
  `emailVerified` — an email-based allow/block policy must check it before trusting `email`.
- The hook runs **inside the registration DB transaction** on every channel — keep it fast.
  A slow call (e.g. an external policy API) holds a pooled DB connection open per signup.
- On the `oauth` channel it can run **twice for one sign-in**: a sign-in that lost a race with a
  concurrent sign-in or sign-up of the same identity or address is rolled back and run once more,
  hook included. A rejection is not retried. Put side effects in `authRegisterEvent`, which fires
  once, for the attempt that committed.
- On the **web** OAuth flow a rejection surfaces as the standard OAuth error redirect
  (302 to the app's OAuth error URL, message only) — not a 403 JSON response. The native
  OAuth flow, credentials, and invitation channels return the error status (403) directly.

## Admission: one answer to "may this person be let in"

Every door that produces a person principal asks one function, `admitPrincipal`
(`@spfn/auth/server`), and carries no rule of its own: the Bearer and clientProofV1 paths of
`authenticate`, `optionalAuth`, an app's registered auth profiles, `oneTimeTokenAuth` and the
SSE stream or WebSocket a one-time token opens (at the connect), `authenticateForRenewal`,
`verifyAccessToken` (`/mcp`),
the OAuth 2.1 token endpoint (code exchange and refresh), `mfa/verify` completing a 202 sign-in,
device-code / device-link collection, and `admitDeferred`, which every completion of a two-step
procedure asks under the account lock (TOTP confirm, passkey registration, step-up and binding-off
by passkey, renewal, the link callback — see
[the migration](#migration--a-two-step-procedure-is-decided-when-it-completes)). A rule added
there holds at every door.

```typescript
const admission = await admitPrincipal({
    userId,
    credential: { kind: 'deviceKey', keyId },   // | oneTimeToken | oauth2Grant | renewal | appProfile
    route: c,                                   // the request, for the enrolment-route exception; null elsewhere
});
// { admitted: Principal } | { refused: { reason: 'accountDisabled' | 'pendingDeletion' | 'credentialRevoked' | ... } }
```

It decides in this order. Every step runs only after the door verified the credential the
request presented — a device key's request signature (the Bearer step, which hands a live or an
expired key alike to admission; a signature that does not verify is `InvalidTokenError` and never
reaches step 1), a one-time token's redemption, an OAuth 2.1 grant's token, an app profile's
verifier — and only when the step before it admitted. The cookie/Bearer error each step answers
is named after it; the other doors answer in their own vocabulary (below).

1. **The account**, read on the write primary — no such account is `AccountNotFoundError`; a
   deletion asked for is `AccountPendingDeletionError` (a purged account `AccountDisabledError`);
   then a status other than `active` is `AccountDisabledError`. Both are columns of the users
   row, so this is still one read; `admitsAccount(user)` is the yes/no form for a reader that
   needs no reason.
2. **The credential is not revoked** — `KeyRevokedError`. A device key by `keyLiveness` (not
   revoked, of the account's current key generation); a one-time token by the key that issued
   it; a renewal key by the renewal grace rule (bound, inside its grace); an OAuth 2.1 grant by
   not being revoked; an app profile's credential by its verifier having admitted it on this
   request.
3. **A bound key comes from its browser family** — `SessionContextChangedError`. A key bound to
   a passkey must be presented from the browser family its row recorded; an unbound key, a key
   with no recorded family, and sign-out are not compared.
4. **The key has not expired** — `KeyExpiredError`, `renewable` for a bound key inside its
   grace. It comes after the family so that a copy presented from another browser is told it is
   one, never offered the owner's renewal.
5. **The second-factor policy** (#309) — `SecondFactorEnrolmentRequiredError`. Except for
   renewal, deliberately: renewal admits no request, it continues a key the person holds into its
   replacement, which meets the policy on its first request like any key.

The account, its role and the credential's row are one primary read, so `authenticate` makes
no query it did not make before. Each door answers a refusal as it always has: 401/403 with the
error classes on the cookie/Bearer paths, the contract codes on a proven call, `invalid_grant`
on the token endpoint, 401 with `WWW-Authenticate` on `/mcp`, the one `SessionRenewalRefusedError`
on renewal, `MfaVerificationFailedError` on `mfa/verify`.

On the cookie/Bearer paths each refusal is a class of its own, made by `admissionRefusalError`
alone — so a client can tell "this session is over" from any other 401:

| refusal | error | status | ends the browser session |
|---------|-------|--------|--------------------------|
| key revoked, unknown, or of an ended key generation | `KeyRevokedError` | 401 | yes |
| bound key presented from another browser family | `SessionContextChangedError` | 401 | yes |
| key expired (unbound) | `KeyExpiredError` | 401 | yes (a bound one is renewable) |
| account missing | `AccountNotFoundError` | 401 | yes |
| account disabled / deleted | `AccountDisabledError` | 403 | yes |
| deletion requested | `AccountPendingDeletionError` | 403 | yes |
| second factor to enrol | `SecondFactorEnrolmentRequiredError` | 403 | no |

`KeyRevokedError` and `AccountNotFoundError` extend core's `UnauthorizedError`; the plain
`UnauthorizedError` is never one of these and never ends a session. On a client the classes —
and so `instanceof UnauthorizedError` — are restored only by a client given `authErrorRegistry`:
`authApi` and `createAuthApi` do it themselves; a core `createApi` client needs
`createApi<AppRouter>({ errorRegistry: [authErrorRegistry] })`, or it receives a generic
`ApiError` with the status.

Only the admission module can make a principal. `AuthContext`, `Principal` and
`VerifiedOAuth2AccessToken` carry a brand and a sealed constructor. The brand is a compile-time
guarantee — a private member, so an object literal or a spread of another principal does not
compile as one; it is not checked at run time. A `new` from outside throws, and the package's
own source is scanned in its test suite for a cast to a principal type. An app's own door admits with
`admitPrincipal` and hands the result on with `authContextFor(principal, scheme)`.

### Account status (`setAccountStatus`)

```typescript
import { setAccountStatus } from '@spfn/auth/server';

await setAccountStatus(userId, 'suspended', { from: 'any', reason: 'chargeback dispute' });

const lifted = await setAccountStatus(userId, 'active', { from: 'suspended', reason: 'dispute resolved' });
// 'changed' | 'refused' — refused when the account was no longer 'suspended'
```

The one writer of `users.status`. A change names the status it leaves (`from`), and the write
is one conditional statement on the primary: if another writer moved the account first — a
deletion request, another operator — the change matches no row and answers `'refused'`
instead of overwriting it. `from: 'any'` is the explicit "whatever it is now" (an operator
suspending); with it, `NotFoundError` means no such account.

In one transaction it writes the status and, for every status but `active`, ends the account's
key generation: every device key is revoked (the reason is recorded on each), pending
second-factor sign-ins die with it, and once the transaction commits the **SSE streams** those
keys opened close on every instance. **WebSocket connections already open stay open** — core
keeps no per-key WebSocket registry yet — but no new one is let in: a WebSocket token is
admitted at the connect, and a revoked key's token is refused there. Device sessions do **not**
come back when the account is reactivated — the person signs in again. OAuth 2.1 grants are
kept: they are refused while the account is not active and work again after reactivation.
Account deletion does **not** go through it — see the next section.

### Account status and account deletion are two facts

`users.status` says whether an operator lets the account in (`active | inactive | suspended`).
`users.deletion` says where the account is in its deletion (`null | 'pending' | 'deleted'`; the
purge date stays on the `account_deletion_requests` row). Writing one never changes the other:
a deletion request leaves a suspension in place, cancelling it clears only the deletion, and a
suspended account scheduled for deletion by an administrator and then recovered by its owner is
still suspended. `users.deletion` is the one source of truth for the account's deletion state;
the request row records the request (who, when, the purge date, how it ended).

`setAccountDeletion` (package-internal) is the one writer of `users.deletion`, beside
`setAccountStatus` and like it: under the account lock, one conditional statement naming the
deletion it leaves (`null → pending` on a request, `pending → null` on a cancel,
`pending → deleted` on an anonymize purge), and entering a deletion ends the account's key
generation. `usersRepository.updateById` refuses `deletion` as it refuses `status`.

> **BREAKING — `pending_deletion` and `deleted` are no longer statuses.** `USER_STATUSES` is
> `['active', 'inactive', 'suspended']`; `ACCOUNT_DELETION_STATES` (`['pending', 'deleted']`) and
> `AccountDeletionState` are new exports. Code reading `user.status === 'pending_deletion'` reads
> `user.deletion === 'pending'`; `status === 'deleted'` is `deletion === 'deleted'`; "may this
> account be let in" is `admitsAccount(user)` (`status === 'active' && deletion === null`), not
> `status === 'active'` alone. `UserUpdate` omits `deletion`. `usersRepository.findRoleHolders`
> takes `admissibleOnly: boolean` instead of a status. `AccountPendingDeletionError` keeps
> `details.status: 'pending_deletion'` on the wire.
>
> **Upgrade.** The migration adds `users.deletion` and moves existing rows: `pending_deletion` →
> `status = 'active', deletion = 'pending'`; `deleted` → `status = 'inactive', deletion =
> 'deleted'` (a purged account is not let in by either column). Purge dates and request rows are
> untouched, so scheduled purges run as planned and nobody can sign in who could not before.
> What the old column could not hold is lost: an account suspended **and then** scheduled for
> deletion stored only `pending_deletion`, so after the upgrade it reads as active-and-pending,
> and a cancel would let it in. Before migrating, list the accounts in that state and re-apply
> their suspension afterwards with `setAccountStatus(id, 'suspended', { from: 'any', reason })`:
>
> ```sql
> SELECT u.id, u.public_id, u.email, r.requested_by, r.requested_at, r.purge_scheduled_at
> FROM spfn_auth.users u
> LEFT JOIN spfn_auth.account_deletion_requests r ON r.user_id = u.id AND r.status = 'pending'
> WHERE u.status = 'pending_deletion'
> ORDER BY r.requested_at;
> ```
>
> Your own moderation records (or `requested_by = 'admin'` rows) tell which of them were
> suspended.

A sign-in racing a status change cannot leave a key behind: every key write
(`registerPublicKeyService` — all sign-in channels, renewal, rotation, invitation acceptance)
locks the account row, asks the account half of the admission, and takes the key generation
from that same read. A suspension committing meanwhile waits for the key and then revokes it, or
the key is refused with the answer the channel gives a non-active account. The account row is
the one lock every writer of an account's credential state takes first — see
`usersRepository.lockAccount`.

Which writers those are is derived, not listed: every repository over a table that holds an
account's credential state extends `AccountStateRepository`, whose `accountWrites` classifies
each write method by the account it writes (or names why it needs no lock). Under the package's
tests every such write checks the lock, and an unclassified one is refused. A wait for the lock
is bounded (`ACCOUNT_LOCK_TIMEOUT_MS`, 5 s, exported from `@spfn/auth/server`): a request that
runs out answers **`503 AccountBusyError`** with a `Retry-After` header (retryable, mobile
contract 0.14.3; on the wire the envelope's `code` is `AccountBusyError`) with nothing written,
not a connection error. **`usersRepository.lockAccount(id)` can therefore reject with
`AccountBusyError`** — an application calling it in its own transaction lets that error reach
the error handler, or answers it as a retry. A transaction holds one account's lock at most: a
second account's lock throws `SecondAccountLockError` (an internal error, in every run, not only
under test). An OAuth sign-in whose link moved between its read and its lock runs again (a second
time answers `OAuthSignInContendedError`). `renewSession()` answers a 503 as
`{ ok: false, reason: 'busy' }` — retry, the session is not over.

The tables in that set include the OAuth 2.1 grants, codes and tokens and the WebAuthn
challenges. A consent locks the account and admits the approving session again under the lock
before it writes a grant, so a consent racing a password change or revoke-all is refused, with
no grant and no code. A WebAuthn ceremony reads its challenge, verifies outside the lock, and
spends the challenge under the lock with what it writes: a `503` leaves the challenge unspent
for the retry. A passkey's use is recorded only at the counter the assertion was verified
against, and only upward (an authenticator that always reports 0 keeps working); a recovery code
spends only while its generation is the newest.

The sweeps run one account per transaction under its lock, bounded per run: at most 500
accounts (`SWEEP_BATCH`) from `mfaChallengesRepository.findAccountsWithFinished(cutoff, limit)`
and `mfaTotpRepository.findAccountsUnconfirmedBefore(cutoff, limit)`, no new account after 60 s
(`SWEEP_BUDGET_MS`); a busy account is left for the next run, and each run logs one summary
line. The boot email backfill folds in batches of 500 rows (`EMAIL_NORMALIZATION_BATCH`), so a
lock never waits behind a table-wide rewrite.

> **BREAKING — repository signatures.** Writers of credential state now name the account they
> write: `mfaChallengesRepository.countFailure/markKeyPending/resecret/dropPendingKey` take the
> challenge row; `passkeysRepository.recordUse(passkey, counter)` takes the row the assertion was
> verified against and answers whether the passkey was still live at that counter; `deviceLinksRepository.redeem/approve/deny/cancel` take the link,
> `consumeApproved` and `expireLiveByIssuerKey` the issuer's id; `lockIssuerKey` is removed;
> `LinkHandle` (`Pick<DeviceLink, 'id' | 'issuerUserId'>`, from the device-links repository) is
> what they take; `deviceAuthorizationsRepository.consumeApproved(userId, hash)`;
> `mfaRecoveryCodesRepository.consume(userId, id)`; `mfaTotpRepository.recordUsedStep` answers
> whether it spent the step, `updateSecret` takes the ciphertext it replaces, and
> `deleteUnconfirmedBefore` is `deleteUnconfirmedOf(userId, cutoff)`;
> `mfaChallengesRepository.sweepFinished` is `sweepFinishedOf(userId, cutoff)`;
> `socialAccountsRepository.deleteById(link)`;
> `passwordResetTokensRepository.consume/complete(token, ...)`;
> `keyRevokeAllTokensRepository.consume(userId, hash)`; `keysRepository.updateLastUsed` (unused)
> is removed; `webauthnChallengesRepository.consume(accountId, hash, kind)` answers a boolean and
> `findLive(hash, kind, owner)` reads without spending;
> `oauth2AuthorizationCodesRepository.create(approverId, data)`;
> `approveOAuth2AuthorizeService(params, { userId, credential })`;
> `mfaChallengesRepository.findAccountsWithFinished` and
> `mfaTotpRepository.findAccountsUnconfirmedBefore` take a `limit`. Call the writers under
> `usersRepository.lockAccount` in a transaction.

> **BREAKING — `updateUserService` no longer takes `status`.** It is removed from the type
> (`UserUpdate` = `Omit<Partial<NewUser>, 'status'>`), and `usersRepository.updateById` refuses
> a `status` it is handed at run time. Migration: replace
> `updateUserService(id, { status })` with `setAccountStatus(id, status, { from, reason })` — and
> expect the account's sessions to end, which is the point.

> **BREAKING — `resolveAuthenticatedUser` and `bearerAuthContext` are removed.** Admit with
> `admitPrincipal` and build the context with `authContextFor`. `admitsForRenewal` now lives
> in the admission module (still exported from `@spfn/auth/server`).

> **BREAKING — `AuthContext` is a class.** Its fields are unchanged and gain `credential`
> (what the person presented); a literal no longer type-checks as one. A test stub that set a
> literal casts it (`as never`).

> **BREAKING — `VerifiedOAuth2AccessToken` is a class**, made only by `verifyAccessToken`. Its
> fields are unchanged; a literal no longer type-checks as one.

> **BREAKING — `approveDeviceAuthService` requires `keyId`**, the approving device's key
> (`signingKeyOf(getAuth(c).credential)`). Collection admits the person on that key, so a code is
> refused at collection once the approving key is revoked. Device codes approved before the
> upgrade and not yet collected carry no approving key and are refused; the device starts again.

> **BREAKING — OAuth 2.1 refresh and code exchange answer `invalid_grant`** for an account that
> is not active and for a person the second-factor policy holds to enrolment only. A client
> discards its refresh token on `invalid_grant`, so it signs in again after reactivation.

> **BREAKING — WebSocket tokens are key-tagged.** The WS token endpoint tags a token with the
> device key like the SSE one, and the connect admits the person on that key. A principal of an
> app's own auth profile, which holds no device key, is refused at the connect.

> **BREAKING (`@spfn/core`) — `SSEKeyVerifier` is `(keyId, subject, keyHolder)`** and
> `SSETokenManager.issue(subject, { keyId, keyHolder })` records who holds the key beside the
> tag (the SSE/WS token endpoints record `getKeyHolder(c)`, default `c.get('auth')?.userId`).
> `@spfn/auth`'s manager admits the recorded key holder, never a parse of `subject`, so an app's
> `getSubject` may shape the subject freely; a tagged token issued with no `keyHolder` is
> refused.

## One-Time Token

For short-lived authenticated handshakes (e.g. SSE) where a `Bearer` header is awkward: issue
with `authApi.issueOneTimeToken`, protect the consuming route with the `oneTimeTokenAuth`
middleware. Call `initOneTimeTokenManager({ ttl, store })` during setup for a custom TTL/store.

A token is bound to the device key that asked for it, and is good only while the person is
admitted on that key: `oneTimeTokenAuth` and a stream opening with it both ask `admitPrincipal`
with a `oneTimeToken` credential. A token whose key was revoked since — a logout, a
sign-out-everywhere, a password change, a suspension — is refused (401). An SSE stream opened
with it closes when the key is revoked; a WebSocket already open does not (it stays open until
it disconnects), but a new connect with a token of that key is refused. The person admitted is
the user id the issuer recorded beside the key (`keyHolder`), not a parse of the token's subject. The principal it produces carries the issuing key as
`keyId`. A principal that signed with no device key (an app's own auth profile) is refused a
token (403): there would be no key to bind it to.

> **BREAKING — `issueOneTimeTokenService(userId, keyId)`.** The service takes the key the
> token is bound to (`signingKeyOf(getAuth(c).credential)`); `null` is refused. Untagged
> tokens are no longer admitted by `oneTimeTokenAuth`.

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

An application that admits both credentials on one route has to tell an ops token from a
session JWT *before* either is verified. Do not re-type the literal: `isOpsToken(bearer)`
and the `OPS_TOKEN_PREFIX` it tests against are both exported from `@spfn/auth/server`, so
the shape has one definition and a copy in application code cannot drift from it.
`isOpsToken` answers shape only — it takes a raw header value, returns `false` for a
missing or non-string one, and leaves unknown/revoked/expired to verification.

`opsRoute` comes from `@spfn/core` **0.3.0-beta.2** onwards; before that release an ops
route spelled its own `/_ops/` prefix with `route`.

Issue and manage tokens against the running app, signed in as an administrator. The CLI
prompts for the administrator's email and password, so nothing here needs database access:

```bash
spfn ops token issue --name laptop --scopes 'waitlist:read' --app https://api.example.com
spfn ops token issue --name laptop --scopes '*' --to-keychain --app https://api.example.com
spfn ops token list --app https://api.example.com
spfn ops token revoke 3 --app https://api.example.com
```

Behind those commands are three admin-only routes, mounted with the rest of the auth
router:

| Route | What it does |
| --- | --- |
| `POST /_auth/ops-tokens` | Issue. The secret is in this answer and nowhere else. |
| `GET /_auth/ops-tokens` | List. Only hashes were stored, so no secret can be returned. |
| `DELETE /_auth/ops-tokens/:id` | Revoke. Permanent, and effective immediately. |

Issuing requires `authenticate`, the `ops:token:issue` permission (built-in `admin` and
`superadmin` hold it) and, for an account with a second factor, a recent step-up
(`STEP_UP_REQUIRED`, 403, otherwise); listing and revoking require
`requireRole('admin', 'superadmin')`. The administrator seeded from `SPFN_AUTH_ADMIN_*` (see
[Admin seeding](#admin-seeding)) signs in with a password, so this works in an app whose end
users only sign in socially.

**A token borrows its issuer's authority.** The row records who issued it (`issuedBy`), and
every verification reads that account as it is now: a token whose issuer is no longer active
(suspended, inactive, pending deletion, deleted) or no longer holds `ops:token:issue` (demoted,
or their role deactivated) is refused like a revoked one, and works again if that is restored.
A token issued before issuers were recorded has none and is refused — re-issue it
([migration](#migration--one-permission-model)).

Issuance takes `expiresInDays` from 1 to 36500 (about a century), or `null` for a token that
never expires. There is an upper bound because a day count becomes a date by arithmetic, and
a big enough count produces an invalid date rather than a distant one — a refusal the route
should answer with a message, not with whatever the driver says about a value it cannot store.

SPFN authenticates a request with a JWT the client signs itself, so the CLI generates a key
pair, hands the public half over at login, signs the one call it needs, and revokes the key
before the command ends — on the failing path as much as the succeeding one.
`@spfn/auth/crypto` exports the two functions that take part (`generateKeyPair`,
`generateClientToken`) without pulling in the auth server; it exists from **0.3.0-beta.2**,
which is the floor the `spfn` CLI declares for this package.

Verification refuses uniformly: an expired, revoked, or never-issued token all answer the
same 401, so whether a presented secret ever existed is not inferable. A valid token
missing a route's scope answers 403 naming only the missing scope. `'*'` grants every
scope.

### One route, two credentials (`opsOrUser`)

An operator action is scripted today — the CLI, holding an ops token — and driven from an
admin console tomorrow, a browser holding a user session. That is one route with two
admissible credentials, and neither middleware admits both: `authenticate` refuses an
`spfn_ops_` bearer before any scope guard runs (see [Machine principals](#machine-principals-registermachineverifier)),
and `opsTokenAuth` admits nothing else.

```typescript
import { opsOrUser, getAuth, getOpsToken } from '@spfn/auth/server';

export const exportSignups = route.get('/admin/signups/export')
    .use([opsOrUser({ opsScopes: ['waitlist:read'], permissions: ['admin.waitlist'] })])
    // or by role:            opsOrUser({ opsScopes: ['waitlist:read'], roles: ['admin'] })
    // or both (AND):         opsOrUser({ opsScopes: ['waitlist:read'], roles: ['admin'], permissions: ['admin.waitlist'] })
    .handler(async (c) =>
    {
        // exactly one of these is set
        const ops = getOpsToken(c.raw);   // the ops branch
        const user = getAuth(c.raw);      // the session branch
    });
```

**The branch is chosen by credential shape, never by caller choice.** The raw
`Authorization` bearer is tested with [`isOpsToken`](#ops-tokens-spfn-ops); a match runs
`opsTokenAuth` then `requireOpsScope(...opsScopes)`, and everything else — a user JWT,
another machine namespace, a malformed header, no header — runs `authenticate` then the
session guards. Nothing in the request selects a branch except the credential it presents,
so a caller cannot ask for the weaker check.

**`roles` and `permissions` are AND, roles first.** Two lists only ever narrow. An OR would
mean that adding one role voids the whole permission list, which is the opposite of what a
reader of the two lists expects. Roles run first because the role is already on the auth
context while permissions cost a lookup — so a caller with the wrong role is refused for the
wrong role. Giving neither list is a definition-time error, as is an empty `opsScopes`: a
configuration that would admit a credential unchecked fails at boot, not on a request.

**No implicit admin bypass.** Permissions match by name only, and the ops branch has no role
concept, so neither branch has a principal that passes by virtue of being an administrator.
A refusal is the selected branch's own refusal, with that branch's existing status and
message — no error class and no wire message is introduced here.

`opsOrUser` carries `skips: ['auth']`, so a route using it auto-skips the server-level
`auth` middleware exactly as `optionalAuth` and `opsTokenAuth` do. No `.skip(['auth'])` by
hand.

**Cookies.** The backend never reads them. A browser session reaches a route as a Bearer
token because `@spfn/auth/nextjs/api` forwards it as one, so through the app a console
request is the session rows below; a request carrying only a `Cookie` header is an
unauthenticated request here.

| bearer | branch | answer |
|---|---|---|
| `spfn_ops_…` valid, scope present (or `*`) | ops | 200; `getOpsToken` set, `getAuth` null |
| `spfn_ops_…` valid, scope missing | ops | 403 `Ops token lacks scope` |
| `spfn_ops_…` unknown / revoked / expired | ops | 401 `Invalid ops token` (one message for all three) |
| `spfn_ops_` prefix alone | ops | 401 `Invalid ops token` |
| user JWT valid, permission held | user | 200; `getAuth` set, `getOpsToken` null |
| user JWT valid, permission missing | user | 403 `InsufficientPermissionsError` |
| user JWT expired / bad signature | user | 401 (the existing `authenticate` message) |
| token in a *registered* machine namespace, not ops | user | 401 — the user path admits no machine credential |
| malformed bearer / no `Authorization` | user | 401 |
| session cookie only, no bearer | user | 401 — see Cookies above |
| `x-spfn-auth-profile` + user JWT | user | `PROFILE_REJECTED` (existing `authenticate` behaviour) |
| `x-spfn-auth-profile` + ops token | ops | header ignored; `opsTokenAuth` reads `Authorization` only |
| ops token on a plain `authenticate` route | — | 401, unchanged |
| `opsScopes: []`, or neither `roles` nor `permissions` | — | throws at definition |
| server-level `auth` registered | — | auto-skipped on this route |
| `roles: ['admin']` only; role admin | user | 200 |
| `roles: ['admin']` only; role user | user | 403 `InsufficientRoleError` |
| `roles` + `permissions`; role matches, permission missing | user | 403 `InsufficientPermissionsError` |
| `roles` + `permissions`; permission held, role wrong | user | 403 `InsufficientRoleError` (role is checked first) |

`opsOrUser` is available from **0.3.0-beta.11**.

## Signed tokens (`signedTokenAuth`)

The machine credential for a command surface whose caller holds a token some *other*
service signed ([`@spfn/core/surface`](../core/README.md#can-a-second-surface-sit-beside-_ops)).
The issuer publishes its public keys as a JWKS and signs a short-lived JWT with EdDSA; the
caller presents it as `Authorization: Bearer <jwt>`. Nothing is stored on this side — no
table, no migration.

```typescript
import { defineSurface } from '@spfn/core/surface';
import { signedTokenAuth, getSignedToken } from '@spfn/auth/server';

export const app = defineSurface({
    namespace: '/_app',
    auth: signedTokenAuth({
        keysUrl: 'https://issuer.example/.well-known/keys',  // JWKS, looked up by kid
        iss: 'https://issuer.example',
        aud: 'my-app',
        clockSkewSec: 30,                                      // default
    }),
});

export const pageAdd = app.route.post('/pages').handler(async (c) =>
{
    const { kid, claims } = getSignedToken(c.raw)!;           // claims.sub, claims.scope, …
});
```

- **One key set per instance**, created when `signedTokenAuth(...)` is called. An unknown
  `kid` re-reads the key set at most once a minute (jose's `cooldownDuration: 60_000`), so a
  stream of forged `kid`s cannot turn the middleware into a fetch loop against the issuer.
- **EdDSA only, `kid` required, `exp` and `iat` required.** A header without `kid` is
  refused before any key lookup, and an `iat` later than now (beyond the skew) is refused
  too — jose checks `iat` only under `maxTokenAge`.
- **`keysUrl` must be https**; `http:` is accepted only against a loopback host, and
  anything else throws at construction. Keys fetched in the clear can be swapped on the
  wire, and every token signed by the swapped key would then verify.
- **Not a user.** The verified token lands in its own context key, read with
  `getSignedToken(c)`. `AuthContext` stays unset and `getAuth(c)` keeps returning app users
  only — the [machine principal](#machine-principals-registermachineverifier) rule.
- **Auto-skips** the server-level `auth` middleware, like `opsTokenAuth`. It is standalone:
  it is not registered on the `machineAuth` registry.

Every invalid token answers the same 401 message; the reason goes to `authLogger` at warn,
without the token text.

| Token | Answer |
| --- | --- |
| missing `Authorization`, or not `Bearer` | 401 `Signed token required: Authorization: Bearer <token>` |
| valid signature, `iss`, `aud`, `exp`, `iat` within skew | 200, `getSignedToken(c)` carries `{ kid, claims }` |
| wrong `aud` | 401 `Invalid signed token` |
| wrong `iss` | 401 `Invalid signed token` |
| `exp` in the past beyond skew | 401 `Invalid signed token` |
| `exp` in the past within skew | 200 |
| `iat` in the future beyond skew | 401 `Invalid signed token` |
| missing `exp` or `iat` | 401 `Invalid signed token` |
| no `kid` in the header | 401 `Invalid signed token`, no key-set fetch |
| `alg` other than `EdDSA` (RS256, HS256, none) | 401 `Invalid signed token` |
| tampered payload or signature | 401 `Invalid signed token` |
| unknown `kid`, present after one key-set re-read | 200 |
| unknown `kid`, absent after one re-read | 401 `Invalid signed token` |
| another unknown `kid` within 60 s | 401 `Invalid signed token`, no further fetch |
| `keysUrl` unreachable | 401 `Invalid signed token`, reason logged |

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

Before minting the first proof in each client process, the client calls the built-in
`GET /_core/time` operation (`core.time`) and establishes its proof epoch from
`serverTimeMillis`. This prerequisite is unproven and session-free. If the operation is
unavailable or its response cannot be decoded, proof minting fails closed — there is no silent
fallback to the device's unsynchronized wall clock.

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

### Clock synchronization and proof-time boundaries (contract 0.9.0)

`core.time` is imported from `@spfn/core` rather than restated by auth: operation ID, method,
path, auth class, session requirement, and the closed `ServerTimeResponse` schema all come from
the core route contract. The mobile contract records it as a bodyless GET prerequisite and
requires one synchronization before the first proof minted in each process. It does not prescribe
persistent offset storage, retry sleeps, or device-specific margins.

The server admission rule remains strict: `age = serverNow - issuedAtMillis` must satisfy
`0 <= age <= 300000`. Synchronization does not widen the replay window or change nonce retention.
A refused request still leaves its nonce unused; only admission spends it.

| `serverNow - issuedAtMillis` | Result |
|---:|---|
| `0` | accept |
| `-1` (proof is 1 ms in the future) | `PROOF_EXPIRED` |
| `300000` | accept |
| `300001` | `PROOF_EXPIRED` |

When `core.time` cannot be read, the client must surface that synchronization failure and stop
before sending a proof. Using `Date.now()` or a platform wall clock as an implicit fallback would
reintroduce the skew failure this prerequisite closes.

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
| `core.time` | 0.9.0 |
| `auth.device.start`, `auth.device.poll`, `auth.device.info`, `auth.device.approve`, `auth.device.deny` | 0.10.0 |
| `auth.mfa.verify`, `auth.mfa.status` | 0.13.0 |
| `auth.deviceLink.redeem`, `auth.deviceLink.poll` | 0.13.2 |
| `auth.enroll.oauthAppleRelayStart` | 0.13.4 |

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

## Custom auth profiles (`registerAuthProfile`)

`clientProofV1` is not a special case in the middleware — it is one entry in a registry
`authenticate` and `optionalAuth` dispatch on. An app registers its own scheme the same way,
without forking the middleware or wrapping it:

```typescript
import { registerAuthProfile, type AuthProfileIdentity } from '@spfn/auth/server';
import { UnauthorizedError } from '@spfn/core/errors';

// At boot — server.config.ts, before the server starts taking requests.
registerAuthProfile('acmeDeviceV1', {
    verify: async (c): Promise<AuthProfileIdentity> =>
    {
        const device = await verifyAcmeDevice(c.req.header('x-acme-device-proof'));
        if (device === null)
        {
            // A refusal leaves the verifier as a throw. It reaches the app's
            // error handler exactly as the Bearer path's does.
            throw new UnauthorizedError({ message: 'Invalid device proof' });
        }

        return { userId: String(device.userId), keyId: device.id, scheme: 'acmeDeviceV1' };
    },
});
```

A request naming the profile is then answered by that verifier:

```http
POST /v1/reports
x-spfn-auth-profile: acmeDeviceV1
x-acme-device-proof: <the app's own credential>
```

- **The verifier says who; the admission decides.** It answers an `AuthProfileIdentity` — the
  account id, the key id it names for it, the scheme — never a principal. `runAuthProfile`
  admits it with `admitPrincipal` (credential `appProfile`): the account is read on the
  primary with its role and locale, a suspended or deleting account is refused with the errors
  the Bearer path gives, and the second-factor policy applies.

> **BREAKING — a verifier returns `AuthProfileIdentity`, not `AuthContext`.** Migration: return
> `{ userId, keyId, scheme }` and drop `user`, `role` and `locale` — the admission reads them
> from the account. A role a verifier used to state is now the account's stored role.

- **Register at boot, before the first request.** The registry is read on every dispatch, so a
  profile registered later is simply a profile the requests before it did not have. Registration
  is not frozen after startup — it is a contract, not a runtime check.
- **A duplicate name throws**, `clientProofV1` included. Replacing a registered verifier silently
  is how an import order or a copied profile name swaps the code that decides who is admitted, so
  there is no override — and no unregistration API for the same reason.
- **The verifier must expose a callable `verify`**, and what it resolves must carry a `userId` — a
  verifier that cannot admit anyone is refused at boot, and a resolve without a principal (`null`,
  the JS idiom for "no user") is refused as a throw rather than routed as authenticated.
- **An unknown profile is still refused** (`PROFILE_REJECTED`, 400): registering one name does not
  open the header to others.
- **Mixing is still refused.** A request carrying both `x-spfn-auth-profile` and `Authorization` is
  rejected before either path runs; a custom verifier never sees it.
- **A verifier's throw propagates**, and only the internal clientProofV1 contract refusal is
  answered with the canonical envelope. Under `optionalAuth` too: credentials that were presented
  and refused are never downgraded to anonymous passage — only "presented nothing" continues
  without an auth context.
- **`AuthContext.scheme` is an open union** — `'bearer' | 'clientProofV1' | 'oneTimeToken' | (string
  & {})`. The built-in names keep their autocomplete and a registered profile names its own scheme.
  The field stays informational: downstream permission and tenant code takes one principal shape and
  never branches on how it was produced.
- **A profile that names an account is a person**, and a person is held to
  [the second-factor policy](#requiring-a-second-factor-secondfactor) like any other: while
  `secondFactor.required` holds, an account with no listed factor is refused 403
  `SECOND_FACTOR_ENROLMENT_REQUIRED` before the handler runs (anonymous under `optionalAuth`),
  whichever verifier produced it. A credential that is not a person — a service, a job, a runtime —
  belongs in a [machine principal](#machine-principals-registermachineverifier), which the policy
  does not touch.

## Authorization server for MCP clients

Let Claude Code and Codex connect to your app's `/mcp` endpoint as the user, over the flow
they already speak: OAuth 2.1 with dynamic client registration and PKCE.

```console
$ claude mcp add --transport http acme https://api.acme.com/mcp
$ claude
> /mcp
```

Between those two lines the CLI discovers `/.well-known/oauth-authorization-server`, registers
itself, opens a browser at your consent screen, catches the redirect on a loopback port, and
exchanges the code for a token. Nobody pastes anything.

The feature is opt-in and the opt-in is one block:

```typescript
createAuthLifecycle({
    authorizationServer: {
        scopes: {
            'mcp:read': 'Read your projects and tasks',
            'mcp:write': 'Create and edit your tasks',
        },
        defaultScopes: ['mcp:read'],      // what a request with no `scope` asks for. default: all of them
        // issuer: 'https://api.acme.com',           // default: SPFN_API_URL
        // authorizeUrl: 'https://acme.com/oauth/authorize',  // default: {app url}/oauth/authorize
        // allowedRedirectOrigins: [],    // https origins a client may register. loopback needs no entry
        // accessTokenTtlMs: 8 * 60 * 60 * 1000,     // default 8 hours
        // refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,   // default 30 days without a refresh
        // grantLifetimeMs: 180 * 24 * 60 * 60 * 1000,   // default 180 days from consent, however often refreshed
        // codeTtlMs: 60 * 1000,          // default 60 seconds
    },
})
```

Without that block every endpoint below answers 404 and nothing else changes — including the
boot check, which does not run. `scopes` is the one setting with no default: the names are
your application's vocabulary, they are published in the metadata document and read aloud on
the consent screen, and there is nothing to derive them from.

| Endpoint | Host | Auth | What it is |
| --- | --- | --- | --- |
| `GET /.well-known/oauth-authorization-server` | API | public | RFC 8414 discovery — the first request any client makes |
| `POST /_auth/oauth2/register` | API | public, IP rate limited | RFC 7591 dynamic registration. Public clients only |
| `GET /_auth/oauth2/authorize` | API | `authenticate` | What the consent screen should say. Records nothing |
| `POST /_auth/oauth2/authorize` | API | `authenticate` | The decision. Mints the code |
| `POST /_auth/oauth2/token` | API | public, IP rate limited | `authorization_code` and `refresh_token` |
| `POST /_auth/oauth2/revoke` | API | public (RFC 7009) | `client_id` required; 200 for an unknown token as surely as for a real one |
| `GET /_auth/oauth2/grants` · `DELETE /_auth/oauth2/grants/:id` | API | `authenticate` | What the user has connected, and the button that disconnects it |
| `GET /oauth/authorize` · `POST /oauth/authorize` | web | session | The consent screen itself — see the note at the end |

Two lines wire it to `@spfn/mcp`:

```typescript
import { verifyAccessToken } from '@spfn/auth/server';

export const mcp = createMcpRoute({ validateToken: verifyAccessToken, tools: [...] });
```

`verifyAccessToken(token, resource)` answers `{ clientId, scopes, expiresAt, userId }` or
`null`, and `null` is the token being invalid — `@spfn/mcp` answers it 401 `invalid_token`.
`expiresAt` is seconds since the epoch, like every other OAuth field here. `scopes` is what the
token authorizes **now**: the scopes it was issued with that its grant still holds.

| Outcome | Meaning | `@spfn/mcp` answers |
| --- | --- | --- |
| the principal | a live token whose grant still holds at least one of its scopes | the request runs |
| `null` | unknown, revoked, expired, refresh-kind, wrong resource, grant revoked or past its `expires_at`, no scope left | 401 `invalid_token` |
| throws `SecondFactorEnrolmentRequiredError` | a valid token whose person may only enrol a second factor | 403 `SECOND_FACTOR_ENROLMENT_REQUIRED` |
| throws anything else | verification failed — a database error is not a verdict on the token | 5xx |

- **A suspended person's client is refused, and comes back with the account.** Every access
  token, every refresh and every code exchange admits the grant's account through
  `admitPrincipal`: while the account is not `active` the token answers `null` (401 at `/mcp`)
  and the token endpoint `invalid_grant`, and nothing is spent or revoked. The grant itself is
  kept, so once the account is reactivated (`setAccountStatus(id, 'active', …)`) the same
  refresh token works again. The second-factor policy now applies at the token endpoint too:
  an account that may only enrol cannot exchange or refresh (`invalid_grant`).

- **Only loopback and origins you allowed.** A client may register `http://localhost:*`,
  `http://127.0.0.1:*` or `http://[::1]:*` — a CLI cannot know which port the OS will hand it,
  so the **port** is the one thing allowed to vary. Nothing else does: host, path and query
  must match the registration exactly, a fragment is refused at registration and at request,
  and plain `http` anywhere else is refused outright. An `https` redirect URI has to be on an
  origin listed in `allowedRedirectOrigins`.
- **Those three spellings are three registrations.** `localhost`, `127.0.0.1` and `[::1]` do
  not stand in for one another — they resolve differently on a machine with a split-horizon
  resolver, and a client answered on a host it did not register is a client something
  redirected. IPv6 is the one place spelling is folded: `http://[0:0:0:0:0:0:0:1]:5/cb` and
  `http://[::1]:5/cb` are the same registration, because both sides are read through
  `new URL(...).hostname`.
- **An unknown client or a mismatched redirect URI is shown, never redirected.** There is no
  vetted URI to send that error to, and sending it to the one the request supplied is the open
  redirect the whole rule exists to close. Every other authorize-time error —
  `invalid_request`, `invalid_scope`, `invalid_target`, `access_denied` — goes back to the
  client on its registered URI, which is the only form the waiting CLI can read.
- **PKCE S256, and nothing else.** No `plain`, and no request without a challenge. The code
  arrives on a loopback port that any process on the machine could have been listening on.
- **`resource` is required** (RFC 8707) and the token is only good against it. A token your
  user approved for your MCP server cannot be replayed against a neighbouring deployment that
  shares this authorization server.
- **A code is spent last, by one statement.** Client, redirect URI, PKCE verifier and
  `resource` are all checked first; a request refused for any of them leaves the code unspent,
  so a client that sent the wrong `resource` can correct it and retry. The spend is a conditional
  `UPDATE … RETURNING`, so of two exchanges arriving together exactly one gets tokens — and
  **presenting a code twice revokes the grant**, whether the second arrives after the first
  finished or alongside it, because by then somebody else may hold what the first produced.
- **Refresh tokens rotate, and a rotated one is marked rather than deleted.** Presenting it
  again revokes the grant, which kills the replacement as well as the replayed token: both
  hang off the grant and there is no telling which holder is the thief. A refresh may ask for
  a **subset** of the granted scopes and never for more; narrowing applies to that request and
  leaves the user's consent record as they gave it.
- **The grant is the authority.** A token's own scopes are only the ceiling it was issued with:
  verification answers them intersected with the grant's current scopes, and a refresh without
  `scope` issues that intersection. A user who approves a client again with fewer scopes has
  narrowed every token it already holds; a token left with none is refused.
- **Revocation is final; reconnecting is a new grant.** A revoked grant is never live again, so
  every code and token minted under it stays refused. Approving the same client again while it
  is connected amends the live grant's scopes; approving it after a disconnect creates a new one.
- **A grant ends at its `expires_at`**: the consent + `grantLifetimeMs` (180 days by default),
  written when the grant is created and moved by nothing — not by refreshing, not by re-consenting
  while it is live, not by a later change to `grantLifetimeMs` (which applies to grants created
  afterwards). From then on refresh and verification refuse and the user consents again.
  `refreshTokenTtlMs` is how long an *idle* client keeps its connection; this is how long a busy
  one does.
- **Every code and refresh failure is one `invalid_grant`, word for word.** Unknown, expired,
  spent, wrong verifier, another client's. The endpoint is public, and an error that told
  those apart would answer the question somebody holding a stolen value is asking.
- **Token endpoint errors are RFC 6749 §5.2, not the SPFN envelope** —
  `{ "error": "invalid_grant", "error_description": "..." }`, status 400,
  `Cache-Control: no-store`. The client reading it is an OAuth library that knows those two
  field names and nothing about this framework. Registration refusals are RFC 7591 §3.2.2 the
  same way (`invalid_redirect_uri`, `invalid_client_metadata`).
- **Nothing but a hash is stored.** Codes and tokens are `spfn_at_<64 hex>` /
  `spfn_rt_<64 hex>` / 43 url-safe characters, and the value exists in the clear exactly once,
  in the response that issues it. It is never logged and never put in an event.
- **A global revocation reaches the grants.** `revoke-all`, a password change, a completed
  password reset and a deletion request each revoke every grant the account has — so a CLI
  holding a refresh token through "sign me out everywhere" cannot be back within the hour,
  which is exactly the client that call was aimed at. The user's own
  `DELETE /_auth/oauth2/grants/:id` does the same for one client, immediately. It is CSRF-checked
  in every mode, like the consent decision.
- **The issuer is checked at boot.** It must be an absolute URL with no path — the metadata
  document is served at an origin's root and nowhere else — and it must be `https`, or `http`
  on `localhost` / `127.0.0.1` / `[::1]` for development. Anything else refuses to start with
  a message naming `SPFN_API_URL` or `authorizationServer.issuer`, whichever the value came
  from. An application with no `authorizationServer` block never reaches this check. The one
  value that is accepted and rewritten is a bare trailing slash: `https://api.acme.com/` is
  stored as `https://api.acme.com`, the form `@spfn/mcp` derives, so the two documents naming
  this server agree (RFC 8414 §3.3). That reduction happens where the config is resolved, not
  in the boot check, so a document read without the lifecycle hook publishes the same issuer.
- **Unapproved client rows are swept.** Registration is unauthenticated by necessity, so
  `auth.oauth2.client-purge` (in `authJobRouter`, daily at 05:00) deletes clients older than a
  day that no user ever approved. One with a grant against it is never touched. Registration
  is also capped per IP two ways — a burst rate limit, and a cap on how many unapproved
  clients one address may have standing, which a rate limit cannot express.
- **`/mcp` tokens are not sessions.** An access token issued here authorizes the MCP surface
  for the resource it names. It is not a user session and is not accepted by ordinary API
  routes.

### The consent screen

The screen is a page in your app, at the path published as `authorization_endpoint`
(default `/oauth/authorize`). The package ships no HTML: you build it with your own components.
The page asks `authApi.getOAuth2Authorize` what the request is and draws it; the button sends
the decision to `authApi.createOAuth2AuthorizationCode` and sends the browser back to the waiting
CLI. Neither decides anything — the API validates the request from scratch both times, because
the page between the two calls is in the user's browser.

```tsx
// app/oauth/authorize/page.tsx — a server component
import { redirect } from 'next/navigation';
import { authApi, type AuthRouter } from '@spfn/auth';
import type { RouterInput } from '@spfn/core/nextjs';
import { ConsentForm } from './consent-form';
import { refusalDestination } from './consent-refusal';

type SearchParams = Record<string, string | string[] | undefined>;

export type AuthorizeFields = RouterInput<AuthRouter, 'getOAuth2Authorize'>['query'];

const PARAMETERS = ['client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'resource', 'scope', 'state'];

/** The authorize parameters the link carried, and nothing else it carried. */
function authorizeFields(params: SearchParams): AuthorizeFields
{
    return Object.fromEntries(
        PARAMETERS.flatMap(name => typeof params[name] === 'string' ? [[name, params[name]]] : []),
    ) as AuthorizeFields;
}

export default async function ConsentPage({ searchParams }: { searchParams: Promise<SearchParams> })
{
    const fields = authorizeFields(await searchParams);
    const described = await authApi.getOAuth2Authorize.call({ query: fields })
        .then(consent => ({ consent }), (refusal: unknown) => ({ refusal }));

    if ('refusal' in described)
    {
        const destination = refusalDestination(
            described.refusal,
            `/oauth/authorize?${new URLSearchParams(fields as Record<string, string>)}`,
        );

        if (destination)
        {
            redirect(destination);
        }

        return <p>This authorization request cannot be completed. Nothing was shared.</p>;
    }

    return <ConsentForm consent={described.consent} fields={fields} />;
}
```

```tsx
// app/oauth/authorize/consent-form.tsx
'use client';
import { useState } from 'react';
import { authApi } from '@spfn/auth';
import type { AuthorizeFields } from './page';
import { refusalDestination } from './consent-refusal';

type Consent = Awaited<ReturnType<typeof authApi.getOAuth2Authorize.call>>;

export function ConsentForm({ consent, fields }: { consent: Consent; fields: AuthorizeFields })
{
    const [failed, setFailed] = useState(false);

    async function decide(approve: boolean)
    {
        try
        {
            const issued = await authApi.createOAuth2AuthorizationCode.call({ body: { ...fields, approve } });
            const url = new URL(issued.redirectUri);

            url.searchParams.set('code', issued.code);

            if (issued.state !== undefined)
            {
                url.searchParams.set('state', issued.state);
            }

            url.searchParams.set('iss', issued.iss);
            window.location.assign(url);
        }
        catch (refusal)
        {
            const destination = refusalDestination(refusal, `${location.pathname}${location.search}`);

            if (destination)
            {
                window.location.assign(destination);
            }
            else
            {
                setFailed(true);
            }
        }
    }

    return (
        <main>
            <h1>Authorize {consent.clientName}</h1>
            <p>
                <strong>{consent.clientName}</strong> is asking to act on your behalf at{' '}
                <code>{consent.resource}</code>. The authorization would be returned to{' '}
                <code>{consent.redirectHost}</code>.
            </p>
            <ul>
                {consent.scopes.map(scope => <li key={scope.name}><strong>{scope.name}</strong> — {scope.description}</li>)}
            </ul>
            {failed && <p>This request could not be completed. Nothing was shared — try again.</p>}
            <button onClick={() => decide(true)}>Allow</button>
            <button onClick={() => decide(false)}>Deny</button>
        </main>
    );
}
```

```typescript
// app/oauth/authorize/consent-refusal.ts — used by both files above
import { HttpError } from '@spfn/core/errors';

/** Refusals with no vetted URI to carry them: shown on the page, never redirected. */
const SHOWN = new Set(['unknown_client', 'redirect_uri_mismatch']);

/**
 * Where an API refusal sends the browser, or null when the page shows it.
 *
 * `redirectUri` is read from the refusal the API sent, never from the request:
 * it is the value that matched the registration.
 */
export function refusalDestination(refusal: unknown, returnPath: string): string | null
{
    if (!(refusal instanceof HttpError))
    {
        return null;
    }

    if (refusal.statusCode === 401)
    {
        return `/login?returnUrl=${encodeURIComponent(returnPath)}`;
    }

    const { error, redirectUri, state, iss } = refusal.details ?? {};

    if (typeof error !== 'string' || SHOWN.has(error) || typeof redirectUri !== 'string')
    {
        return null;
    }

    const url = new URL(redirectUri);

    url.searchParams.set('error', error);

    if (typeof state === 'string')
    {
        url.searchParams.set('state', state);
    }

    if (typeof iss === 'string')
    {
        url.searchParams.set('iss', iss);
    }

    return url.toString();
}
```

```typescript
// next.config.ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    async headers()
    {
        return [
            {
                source: '/oauth/authorize',
                headers: [
                    { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
                    { key: 'Cache-Control', value: 'no-store' },
                ],
            },
        ];
    },
};

export default nextConfig;
```

These are rules your page owns; each one is an attack that would otherwise work.

- **No session: send the visitor to your login page** with `?returnUrl=` set to the consent
  request's own path and query — a same-app path, never an absolute URL — so signing in lands
  back on the screen with its parameters intact. The API answers `401` to both calls without a
  session.
- **Redirect only to the `redirectUri` the API returned**, with `code`, `state` and `iss`
  appended on success (`iss` is RFC 9207's mix-up defence: the client checks it names the server
  it started with). Never build a destination from the request's `redirect_uri`: the API's value is the
  one that matched a registration, which is the whole difference between a redirect and an open
  redirect.
- **The two unredirectable refusals are shown on the page.** `unknown_client` and
  `redirect_uri_mismatch` have no vetted URI to carry them. Every other refusal —
  `invalid_request`, `invalid_target`, `invalid_scope`, and `access_denied` when the user denies —
  arrives with `details.redirectUri`, and goes to that URI with `error`, `iss` and the `state`
  verbatim.
- **`clientName` is attacker-controlled.** It arrives from unauthenticated dynamic registration.
  Render it as text — React escapes it — and never through `dangerouslySetInnerHTML`.
- **Forbid framing and caching** with `Content-Security-Policy: frame-ancestors 'none'` and
  `Cache-Control: no-store` on the consent path (the `next.config` snippet above). A consent
  screen that can be framed is a consent screen that can be clickjacked.
- **The decision is CSRF-checked in every mode.** `POST /_auth/oauth2/authorize` declares
  `.csrf('required')`, so the proxy checks it whatever `SPFN_AUTH_CSRF` says (see
  [CSRF protection](#csrf-protection)); the page needs nothing beyond the normal `authApi`
  client, which mirrors the CSRF cookie into the header. A browser whose CSRF cookie was missing
  gets one on the refusal, and a second click goes through.

The end-to-end path — lifecycle config, this route, `/mcp`, and connecting from Claude Code
and Codex — is [docs/guides/mcp-clients.md](../../docs/guides/mcp-clients.md).

## Machine principals (`registerMachineVerifier`)

A machine credential is issued by a service to a non-interactive process, and its subject is
an account or a tenant, not a person. `AuthContext` cannot hold one — it requires a `users`
row — and resolving a machine token to its owning user is worse than the type error: it makes
the machine's request indistinguishable from that user's own session.

So a machine principal never enters `AuthContext`. It lives in its own context key, is read by
its own helper, and is admitted by its own middleware:

```typescript
import { machineAuth, requireMachineScope, getMachinePrincipal } from '@spfn/auth/server';

export const ingest = route.post('/v1/ingest')
    .use([machineAuth, requireMachineScope('events:write')])
    .handler(async (c) =>
    {
        const { subjectType, subjectId } = getMachinePrincipal(c.raw)!;
        // subjectType: 'account' | 'service' | whatever the verifier named
    });
```

`getAuth(c)` on that route returns nothing, because nothing put a user there. That is the
whole design: a machine request cannot impersonate a user session, not because a check
forbids it but because no code path leads there.

**Ownership is not authentication.** Who issued a machine token, who owns it, and who may
revoke or audit it are the registrant's data-level concerns — put the token id in `claims` and
answer them from your own tables. What the request *acts as* is the token's own subject and
scopes, and nothing here resolves a machine subject to a user.

### Registering a verifier

A verifier claims one namespace, by a raw `tokenPrefix` (for an opaque secret, the
`spfn_ops_` shape) or by a `kidPrefix` on the unverified JOSE header of a JWS. The built-in
ops token's own shape is exported rather than spelled out — match it with `isOpsToken` or
`OPS_TOKEN_PREFIX` from `@spfn/auth/server`. Register at boot, before the first request:

```typescript
import { registerMachineVerifier } from '@spfn/auth/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const RUNTIME_JWKS = createRemoteJWKSet(new URL('https://issuer.example.com/.well-known/jwks.json'));

registerMachineVerifier({
    id: 'runtimeJwsV1',
    match: { kidPrefix: 'machine:runtime:' },
    verify: async (token) =>
    {
        const { payload } = await jwtVerify(token, RUNTIME_JWKS, { issuer: 'https://issuer.example.com' });

        return {
            subjectType: 'account',
            subjectId: String(payload.sub),
            scopes: String(payload.scope ?? '').split(' ').filter(Boolean),
            claims: { tokenId: payload.jti },
            scheme: 'runtimeJwsV1',
        };
    },
});
```

The request carries it as an ordinary bearer token — no new wire format, and the
profile-header channel is not involved:

```http
POST /v1/ingest
Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6Im1hY2hpbmU6cnVudGltZTo...
```

- **Namespace your kids.** `machine:` is the convention this package documents, and a user
  session JWT never carries that shape. The prefix is what tells the two apart before either
  is verified.
- **Conflicting discriminators are refused at registration** — a duplicate `id`, a duplicate
  prefix, or a prefix that would shadow an already-registered one (`machine:` swallowing
  `machine:runtime:`). Two verifiers one token could match would make admission depend on
  registration order, so that is a boot-time error rather than something the dispatch
  resolves per request.
- **A `tokenPrefix` claims every token that starts with it**, and `authenticate` consults the
  registry before it decodes anything. A prefix a user's JWT could begin with (`ey…`) would
  therefore refuse every user session — pick a prefix no other credential on your surface
  shares, as `spfn_ops_` does.
- **Register at boot, before the first request.** The registry is module state read on every
  dispatch, so a verifier registered later is simply a verifier the requests before it did
  not have. There is no unregistration and no reset — the same contract, and the same reason,
  as [`registerAuthProfile`](#custom-auth-profiles-registerauthprofile).
- **Registering nothing costs nothing.** With no verifier registered, `authenticate` is two
  array-length checks away from what it was. The unverified JOSE header peek happens only
  once a `kidPrefix` verifier exists.
- **`scheme` is the registry's answer**, not the verifier's: whatever a verifier returns
  there, the principal carries the `id` that admitted it, so an audit trail cannot be made to
  name the wrong verifier.

### The case table

| credential ↓ route → | `authenticate` (user) | `machineAuth` | `optionalAuth` |
|---|---|---|---|
| user bearer JWT | ✓ user (unchanged) | 401 | ✓ user (unchanged) |
| machine token, registered namespace, valid | 401 — refused before the token is decoded | ✓ sets `machinePrincipal` | 401 |
| machine token, registered namespace, verifier rejects | 401 | 401 | 401 |
| machine-shaped token, unregistered namespace | 401 (the existing invalid-token path) | 401 | continues, no auth |
| profile header + any Bearer | `PROFILE_REJECTED` (unchanged) | `PROFILE_REJECTED` | `PROFILE_REJECTED` |
| nothing | 401 (unchanged) | 401 | continues, no auth |
| valid principal, missing scope | — | 403 | — |
| valid principal, sufficient scope | — | 200 | — |

Every 401 above is one message. Whether a namespace is registered, whether a presented token
was ever valid, and whether a verifier rejected it are not inferable from the answer — the
same non-disclosure rule the [ops-token](#ops-tokens-spfn-ops) table keeps. 403 is reserved
for scope, where the caller is already authenticated; `requireMachineScope` matches scopes
exactly and has no wildcard, and it fails closed with a 401 if it runs without `machineAuth`
before it.

A verifier that throws something other than a refusal — a bug in registrant code — is the
same generic 401 on the wire, with the real error logged. Never a 500 carrying registrant
internals, and never a silent pass.

The last row of the unregistered-namespace case is the one asymmetry: a token in a namespace
nobody registered is not a machine credential as far as this package can tell, so under
`optionalAuth` it gets what any unusable bearer token has always got. A token in a
*registered* namespace is refused there, because refusing it is the difference between
"presented the wrong credential" and "presented none".

The non-disclosure above is therefore an `authenticate` and `machineAuth` property, not an
`optionalAuth` one: on an `optionalAuth` route a caller can tell a registered namespace from
an unregistered one, because one is refused and the other is served anonymously. Closing that
gap would mean refusing every unusable bearer token on those routes — a change to behaviour
that predates machine principals, and a worse trade than the inference it prevents. Mount
`machineAuth` where the distinction matters.

### Issuance is yours

This package verifies machine tokens; it does not mint them. Issuance, rotation, and
revocation belong to whoever owns the subject — keep the tokens short-lived, and prefer a
signature you can verify offline (`kidPrefix` + JWKS) over a secret you must look up.

`opsTokenAuth` is the built-in instance of exactly this pattern, hand-written for one
credential before the registry existed: its own context key (`opsToken`), its own scope guard,
`AuthContext` never set. It keeps its own implementation and is not registered here.
A route that must admit an ops token *or* a user session uses
[`opsOrUser`](#one-route-two-credentials-opsoruser), which composes the two existing
middleware pairs behind one branch on credential shape rather than widening either path.

## Account Deletion & Recovery

Grace-period deletion with in-window recovery, an admin/GDPR-response entry point for immediate
purge, and a pluggable app-data cleanup hook. Not covered by this feature: re-signup email
blind-index/hashing (a purged account's email becomes reusable immediately — see the project's
PII protection track for blind-index re-signup prevention), backup beyond-use handling, DSR
intake/response workflows, and webhook fan-out — those are app/ops concerns.

```
users.deletion:
none ──request (step-up, recent auth)──> pending ──grace period elapses (cron)──> deleted (anonymize) | row removed (hard-delete)
  ^                                         │
  └──cancel (password or one-time code)─────┘        immediate = grace period of 0, same pipeline

users.status (active | inactive | suspended) is not written by any of them.
```

- **Request** — `POST /_auth/deletion/request` (authenticated). The gates every sensitive
  change passes, with the shared functions: an account with a second factor re-proves it on this
  device (`assertStepUp` — **403 `STEP_UP_REQUIRED`**, as `keys/revoke-all` answers), and the
  session's credential authenticated within the recent-authentication window (never an
  application profile's: [the gate](#the-recent-authentication-gate))
  (`SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES`, default 10) or the body carries the account
  `password` (**403 `RECENT_AUTH_REQUIRED`**; a passwordless account signs in again; a password
  that is presented and wrong is refused even on a recent session). The proofs are checked before
  the account lock (the password hashes) and confirmed under it: the session admitted again by the
  admission for this route — account, credential of whatever kind and second-factor policy, as
  `authenticate` asks them — the step-up still on record, the recent authentication still holding,
  and the password's hash still the one stored — a request that waited for the lock while another
  transaction revoked the key, suspended the account, left it enrolment-only, removed the second
  factor or changed the password is refused with the answer its next request would get and
  schedules nothing (a hash re-encoded meanwhile is verified once more). On success: `deletion` → `pending` (the
  status is left as it is), every active session key is revoked, an `account_deletion_requests`
  audit row is created (with `requestedBy: 'self'`), `auth.deletion.requested` fires, and (when
  `sendNotifications` is on) a notice with the scheduled purge date and how to cancel goes to the
  channel the account has: by e-mail when it has an address, otherwise by SMS (`sendSMS` from
  `@spfn/notification`, the sender verification codes use).
- **Login is blocked while pending** — passkey and OAuth sign-in and every door of the admission
  (`authenticate` and the rest) reject an account whose deletion is pending with
  `AccountPendingDeletionError` (403, `details.purgeScheduledAt`) — before its status, so the
  client can show a recovery prompt even for a suspended account. Password sign-in answers it
  `InvalidCredentialsError`, as a wrong password, whatever the password: the owner learns of it
  from the app (`signIn.settled`, [recipe](#recipe--tell-the-owner-of-a-refused-account-by-e-mail)),
  never from the response.
- **Cancel (recovery)** — `POST /_auth/deletion/cancel` (public — sessions were revoked at
  request time, so there's no Bearer token to authenticate with), the one door that admits an
  account whose deletion is pending. Email or phone, plus **either** the `password` **or** a
  `verificationToken` from `/_auth/codes` + `/_auth/codes/verify` (`purpose: 'account_deletion'`)
  for the account's own e-mail **or** phone — both are accepted whether or not the account has a
  password, so a person who forgot it recovers with a code. The token says which address it
  proves; it is spent by the cancel (single use — a second presentation answers
  `InvalidVerificationTokenError`). A token lives 15 minutes, its code 5: a verified code's row is
  kept until its token expires, so `verificationCodesRepository.deleteExpired()` on a schedule never
  breaks a token still valid. A password is confirmed under the account lock as the request's is. On success `deletion` is cleared and nothing else: a
  suspended account stays suspended, whoever requested the deletion. The user still needs to
  log in separately afterward.
- **Purge job** — sweeps `account_deletion_requests` for rows past their grace period and
  destroys the account. Register it explicitly (see below); it is **not** wired up by
  `createAuthLifecycle()` automatically.
- **Admin / GDPR-response entry points** — `requestAccountDeletionService(userId, { requestedBy: 'admin', immediate })`
  and `purgeUserService(userId)` are exported for app-side admin routes / DSR handling; the app
  owns the route and its authorization. The request row records `requestedBy: 'admin'`; the
  person can still cancel it (an operator who wants the account kept out suspends it — that
  fact survives the cancel). An `immediate` request purges once it commits, outside
  its transaction (`onBeforePurge` is the app's own I/O); a purge that fails there is the sweep's
  to retry.

> **BREAKING — a deletion request passes step-up and recent authentication.** `POST
> /_auth/deletion/request` no longer takes `verificationToken`; a passwordless account whose
> session is older than the recent-authentication window signs in again first, and an account
> with a second factor answers `403 STEP_UP_REQUIRED` until it re-proves it on this device
> (`mfa/step-up`). `requestAccountDeletionService(userId, { requestedBy: 'self', credential, password? })`
> takes the requesting session's credential (`getAuth(c).credential`) in place of `verificationToken`; `{ requestedBy: 'admin' }` is
> unchanged.

> **BREAKING — cancel accepts a code for any account, and spends it.** `POST
> /_auth/deletion/cancel` accepts a `verificationToken` for an account that has a password (it
> answered 400 before), and for the account's phone as well as its e-mail. A token cancels once;
> before, it could be presented again for its 15 minutes.

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
    .jobs(authJobRouter)   // the daily (04:00 UTC) purge sweep, and auth.link-mail
    .routes(appRouter)
    .build();
```

**Purge strategies:**

- `anonymize` (default) — scrubs PII, keeps the row: `email` → `deleted-{publicId}@deleted.invalid`,
  `phone`/`username`/`passwordHash` → `null`, `deletion` → `'deleted'` (the status is kept),
  `deletedAt`/`deletedBy` set
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

**Concurrency.** The purge job re-verifies the account's deletion is still `pending` on the write
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
import { createAuthJobRouter } from '@spfn/auth/server';

// ... after .lifecycle(createAuthLifecycle({ deletion: { purgeCron: '0 3 * * *' } }))
.jobs(createAuthJobRouter({ purgeCron: '0 3 * * *' }))
```

Register **only one** of `authJobRouter` / `createAuthJobRouter(...)` — both build the same job
names, so registering both (e.g. the static export *and* a custom-cron router) double-registers
each name against pg-boss instead of overriding it.

`createAuthDeletionJobRouter` is the former name of `createAuthJobRouter` and still works, with
the same argument and the same result. It is deprecated because the router has carried more than
the deletion purge since `auth.link-mail` joined it.

### Link mail delivery

`auth.link-mail` is the second job on the router, and the reason to register the router even in
an app that never deletes an account.

**What it queues, and why only a row id.** Four messages leave through it: the verified-email
signup link, the password reset link, the "you already have an account" notice the signup
request answers a known address with, and every verification code `POST /_auth/codes` sends —
by email or by SMS (`kind: 'verification-code'`; the worker reads the code from its
`verification_codes` row and sends it by the row's `targetType`, and a code superseded, used or
expired by then is not sent). The payload is `{ kind, rowId }` — or `{ kind, target,
targetType }` for the notice — and never the token, the code, the URL or the rendered mail.
`@spfn/notification` can queue a send of its own, but its payload carries the *rendered* mail,
which for these three templates would leave the link token in plaintext in `pgboss.job` until
archive. So the queue carries a reference and the worker mints the credential moments before
sending it: the plaintext exists in the mail and nowhere else.

**What that buys.** The request writes its row with `token_hash` null and answers. Both branches
of both endpoints now cost the same database work, so how long a request took no longer says
whether the address has an account — the mail was the only asymmetry left. A pending row is not
confirmable: a null hash matches no lookup, and the worker's `issue` refuses a row that was
superseded, consumed, completed or expired in the meantime, in the same statement that would
write the hash. A failed send throws so pg-boss retries, and the retry re-mints, which is why a
token from a failed attempt stops working.

**The three modes** — `SPFN_AUTH_LINK_MAIL_DELIVERY`:

| mode | behaviour |
|------|-----------|
| `auto` (default) | queue when pg-boss is initialised, send inline when it is not — an app with no jobs keeps working |
| `queued` | always queue; an enqueue failure never becomes an inline send — outside a transaction it fails the request, after a commit it is logged (below) |
| `inline` | always send inline |

**Inline** means in this process, once the request's transaction has committed — not before the
answer. A queued job is likewise enqueued only after the caller's transaction commits, so the
worker never runs before the row it reads exists; called outside a transaction, the enqueue runs
at once. After a commit the request has already answered 200, so an enqueue failure (but the
missing queue in `auto`) means no mail and one log line (kind, row id) — no inline resend, since
a "failed" enqueue may have reached the queue — and the person asks again. On a graceful shutdown,
`createAuthLifecycle()`'s `beforeShutdown` waits up to ten seconds for inline sends still in
flight, before the database closes, and logs what it abandons. What holds, exactly:

- **Queued sends after a commit** are waited for by `@spfn/core`'s shutdown drain: the enqueue is
  the after-commit callback's own work, and the drain waits for every after-commit callback until
  it settles (one that starts during the drain included). The queue accepts sends until after
  `beforeShutdown` — the stopping instance only stops *fetching* at the start — so the job is in
  the queue and a live instance sends it. If the drain's budget ends first, core logs
  `Shutdown manager: drain timeout — abandoning operations` (`after-commit` among them); that
  enqueue fails once pg-boss stops and is logged as `Link mail was not queued after the commit`
  — no mail.
- **Inline sends** (`inline`, or `auto` without pg-boss) are detached from the callback — the
  request does not wait for the provider — so core's drain does not see them. `settleLinkMail`
  waits for them, at most ten seconds, and names what is still running at its bound
  (`Link mail still in flight at shutdown was abandoned`, kind and row id).
- **Both are bounded by core's shutdown budget.** `beforeShutdown` runs for what the hooks'
  budget leaves it: at least a fifth of `shutdown.timeout` while the deadline has not passed,
  minus what `onShutdown` hooks used first. When that is under ten seconds and a send is still
  running, core cuts the hook before `settleLinkMail` writes its line: the log reads
  `beforeShutdown lifecycle hook failed or timed out`, the rows are not named, and the database
  closes under the send. Give `shutdown.timeout` at least 50 seconds (the default is 280) for the
  per-row line to be reached.
In no mode does a request wait for the provider: an answer that waited for a send would
take longer for the branch that sends something than for the one that sends nothing, which says
whether the address has an account.

**When the provider refuses an inline send** — `inline`, `auto` with no pg-boss, or the
fallback below — the failure is logged (`Link mail was not sent on the request path`, with the
kind and row id) and the request has already answered as if the mail had gone out, because an
answer that depended on the mail provider would be an account-existence oracle during an outage;
the user asks again, and only the job path retries.

**The fallback warning.** In `auto`, an app that initialised pg-boss but never registered this
router has no `auth.link-mail` queue, so the enqueue fails. Losing the mail there would be silent,
so that request sends inline instead and the log says once per process:

```
Queue auth.link-mail does not exist, so this link mail was sent on the request path.
Register the auth job router — .jobs(authJobRouter) — or set SPFN_AUTH_LINK_MAIL_DELIVERY='inline'.
```

The fix is in the message: register the router, or say `inline` if sending on the request is what
you want. Only a missing queue falls back — every other enqueue failure, a database outage above
all, surfaces (or, for a call inside a transaction, is logged after the commit), because falling
back on those would hide the outage behind mail that still gets through.

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
callback 404s — including in local dev. An explicit `SPFN_AUTH_<PROVIDER>_REDIRECT_URI` on the
wrong origin or path no longer gets that far: it fails at boot with a message naming the
variable. Details in
[OAuth callback origin](#oauth-callback-origin-web-app-host--rewrite).

**I forgot my password.**
Send the address to `requestPasswordReset` and open the link that arrives. Any `active`
account whose email is verified — or that already has a password, which covers every account
created before the column was stamped — can be reset that way. See
[Password reset](#password-reset-verified-email). Completing it signs every other device out,
so it is also the answer to "someone else knows my password". An account with neither a
verified address nor a password (OAuth-only, provider said unverified) cannot be reset by
email; it signs in through its provider.

**Does the server hold my users' private keys?**
No. The client generates an ES256/RS256 keypair, sends only the public key on register or
login, and signs each request itself. The server verifies with the stored public key. Keys
expire after 90 days; `rotateKey` renews one.

**Does signing in again in the same browser retire the browser's previous key?**
Yes, when it is the same account's: whichever way the person signs in again — password, passkey,
social, device link or code, a second factor after a 202 — the proxy revokes the key of the
session it replaces once the new one is written. A sign-in into another account (an invitation,
a sign-up, a social account of someone else) leaves the previous account's key live.

**Does signing in on a new device sign the old one out?**
No, and that is on purpose — keys are per-device and accumulate. `listKeys` shows the
account owner what accumulated, `revokeKey` cuts one off, `revokeAllKeys` cuts off
everything but the caller.

**How long does a session last?**
A kept session — the sign-in posted `remember: true` ("keep me signed in") — lives
`SPFN_AUTH_SESSION_TTL_REMEMBER`, thirty days unless set. Any other session: the first of
`configureAuth({ sessionTtl })`, `SPFN_AUTH_SESSION_TTL`, and otherwise seven days. The client
chooses only whether a session is kept, never how long; `remember` that is not a boolean is
refused with 400. Each setting accepts `7d`, `12h`, `45m` or a number of seconds; a malformed
value at the level that answers throws rather than falling through to the next. A malformed `SPFN_AUTH_SESSION_TTL` is refused
when the environment is validated (`spfn env validate`, or the server's boot check for a registry
the app lists), naming the variable and the accepted forms.

**Is account deletion immediate?**
No. A request moves the account's deletion to `pending`, revokes every session key, and
schedules the purge for 30 days later by default. The user can cancel with their password
or a one-time code during that window. Two things need your attention: the purge sweep is a job
you register explicitly (`.jobs(authJobRouter)`), and a purged account's email becomes
reusable immediately. See [Account Deletion & Recovery](#account-deletion--recovery).

**Can an admin delete a user's account?**
Yes, through `requestAccountDeletionService(userId, { requestedBy: 'admin', immediate })`
and `purgeUserService(userId)`. The package exports the services; you own the route and its
authorization.

**Where do my admin accounts come from?**
The environment, seeded on startup by `createAuthLifecycle()`. Seeded accounts are email
verified, active, and carry `passwordChangeRequired: true`. Sign-in returns the flag and changing
the password clears it, but the package gates nothing on it: a seeded account can use the app with
its seeded password. An app that wants the change enforced must do it itself — read the flag from
the sign-in result and hold the user on a change-password page — until the package has a
restricted session for it.

**Is `Foo@Example.com` the same account as `foo@example.com`?**
Yes. Addresses are trimmed and lower-cased on the way in and on the way out, so one person
who capitalizes differently on different days reaches one account instead of creating a
second. Nothing else is folded — Gmail's dot and `+` rules are that provider's delivery
behaviour, not an internet rule, and applying them would merge addresses other providers
treat as different people.

`createAuthLifecycle()` brings existing rows into the same form on startup. If two accounts
differ only by capitalization, both are left exactly as they are and their user ids are
logged as an error: which one is the real account, and what becomes of the other's data, is
not a question the package can answer for you. Until you resolve it, the mixed-case one
cannot sign in.

Admin seeding is unaffected either way. It recognizes a configured admin in whatever form
the address was stored, so an account the backfill has not reached is skipped rather than
duplicated into a second privileged row holding the configured password.

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
  opportunity to auto-register the jobs. Call `.jobs(authJobRouter)` yourself — see
  [Account Deletion & Recovery](#account-deletion--recovery). An app that initialises pg-boss and
  skips this keeps sending link mail, but on the request path, with a warning naming the router —
  see [Link mail delivery](#link-mail-delivery).
- **A deletion is not a status.** `users.status` holds `active | inactive | suspended` only; where
  the account is in its deletion is `users.deletion`. Checking `status === 'active'` alone lets a
  pending or purged account through — use `admitsAccount(user)`. `enumText` is plain `text` with
  no DB `CHECK`, so nothing enforces either set of values at the database layer.

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
import { routeMap } from '@/generated/route-map';   // already holds authRouter's routes
export const { GET, POST } = createRpcProxy({ routeMap });

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
