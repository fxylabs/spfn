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
| `SPFN_AUTH_CSRF` | `.env.local` | — | `off` \| `warn` \| `enforce`; unset behaves as `warn` — see [CSRF protection](#csrf-protection) |
| `SPFN_AUTH_ADMIN_*` | `.env.server` | — | admin seeding (see below) |
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
| `SPFN_AUTH_OAUTH_CALLBACK_ORIGIN_CHECK` | `.env.server` | — | `off` disables the boot check of the four `_REDIRECT_URI` overrides; any other value (unset included) runs it — see [OAuth callback origin](#oauth-callback-origin-web-app-host--rewrite) |
| `SPFN_AUTH_GOOGLE_NATIVE_CLIENT_IDS` | `.env.server` | — | comma-separated client IDs accepted as native id_token audience (iOS/Android/web); enables Google native sign-in |
| `SPFN_AUTH_APPLE_CLIENT_IDS` | `.env.server` | — | comma-separated Apple client IDs (bundle ID / Services ID); enables Apple native sign-in |
| `SPFN_AUTH_KAKAO_NATIVE_CLIENT_IDS` | `.env.server` | — | comma-separated Kakao app keys accepted as native id_token audience (native app key); `SPFN_AUTH_KAKAO_CLIENT_ID` is also accepted, so either one enables Kakao native sign-in |
| `SPFN_AUTH_NAVER_NATIVE_CLIENT_IDS` | `.env.server` | — | comma-separated Naver client IDs accepted as native id_token audience. `SPFN_AUTH_NAVER_CLIENT_ID` is also accepted, so this is only needed for a separate app application |
| `SPFN_AUTH_OAUTH_SUCCESS_URL` | `.env.server` | — | default `/auth/callback` |
| `SPFN_AUTH_OAUTH_ERROR_URL` | `.env.server` | — | default `/auth/error?error={error}` |
| `SPFN_AUTH_RESERVED_USERNAMES` / `_USERNAME_MIN_LENGTH` / `_USERNAME_MAX_LENGTH` | `.env.server` | — | username rules |
| `SPFN_AUTH_SIGNUP_LINK_TTL_MINUTES` / `_SETUP_TTL_MINUTES` | `.env.server` | — | defaults `30` / `15` — see [Verified-email signup](#verified-email-signup) |
| `SPFN_AUTH_SIGNUP_CONFIRM_PATH` | `.env.server` | — | default `/signup/confirm`; the page in your app the emailed link opens |
| `SPFN_AUTH_PASSKEY_RP_ID` / `_RP_NAME` / `_ORIGINS` | `.env.server` | — | relying party for passkeys; defaults derive from `{NEXT_PUBLIC_SPFN_APP_URL\|\|SPFN_APP_URL}` and are **checked at boot** — see [Passkeys](#passkeys-webauthn) |
| `SPFN_AUTH_PASSKEY_USER_VERIFICATION` | `.env.server` | — | `preferred` (default) or `required`; `discouraged` refuses boot |
| `SPFN_AUTH_PASSKEY_CHALLENGE_TTL_SECONDS` / `_RECENT_AUTH_MINUTES` | `.env.server` | — | defaults `300` / `10` — see [Passkeys](#passkeys-webauthn) |
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
| `requestSignupLink` | POST `/_auth/signup/email` | public | email a one-time signup confirmation link — see [Verified-email signup](#verified-email-signup) |
| `confirmSignupLink` | POST `/_auth/signup/email/confirm` | public | exchange the link for a password-setup session |
| `completeSignup` | POST `/_auth/signup/password` | setup session | set the password, which creates the account and signs in |
| `login` | POST `/_auth/login` | public | password login + new session key |
| `startDeviceAuth` | POST `/_auth/device/start` | public | begin a device-code login — see [Device-code login](#device-code-login) |
| `pollDeviceAuth` | POST `/_auth/device/poll` | public | ask whether the request was answered; the approved answer *is* the login |
| `getDeviceAuthInfo` | POST `/_auth/device/info` | yes | what device is asking, so the approval screen can show it |
| `approveDeviceAuth` | POST `/_auth/device/approve` | yes | let the waiting device in |
| `denyDeviceAuth` | POST `/_auth/device/deny` | yes | refuse it |
| `passkeyRegisterOptions` | POST `/_auth/passkeys/register/options` | yes | begin enrolling a passkey — see [Passkeys](#passkeys-webauthn) |
| `passkeyRegisterVerify` | POST `/_auth/passkeys/register/verify` | yes | verify the attestation and keep the credential |
| `passkeyLoginOptions` | POST `/_auth/passkeys/login/options` | public | begin a passkey sign-in; takes no identifier |
| `passkeyLoginVerify` | POST `/_auth/passkeys/login/verify` | public | verify the assertion; answers exactly as `login` |
| `listPasskeys` | POST `/_auth/passkeys/list` | yes | the caller's enrolled passkeys |
| `renamePasskey` | POST `/_auth/passkeys/rename` | yes | rename one |
| `revokePasskey` | POST `/_auth/passkeys/revoke` | yes | retire one (refused if it is the last way in) |
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
"you already have an account" notice instead of a usable link.

```typescript
await authApi.requestSignupLink.call({
    body: { email: 'user@example.com', returnPath: '/welcome' },   // returnPath optional
});
// → { success: true, expiresAt }
```

Calling it again is how a resend works: it invalidates the previous link and any setup
session opened from it. `returnPath` must be a path inside your app — absolute URLs,
`//host`, and `..` are refused, so the link cannot become an open redirect.

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
  would hand one back to exactly the device they were cutting off. Revoking a single key,
  logging out and rotating a key do not: those name one device, and the waiting one is not it.
- **The poll re-checks the account.** It is a login, so it refuses a suspended or
  pending-deletion account with the same errors `/_auth/login` does. Approval and collection
  are separate moments, and what the account is when the key is registered is what counts.
- **`start` bounds what it stores.** It is the one route that takes key material from a caller
  who cannot authenticate, so `publicKey`, `keyId` and `fingerprint` carry length limits —
  generous next to a real key (an RSA-2048 SPKI is 392 base64 characters against a 2048 limit)
  and small next to the megabyte that would otherwise sit in a table no job clears.
- **Clock skew cannot affect this.** Every timestamp in the decision is the server's. The
  `expiresAtMillis` in the start response is for the waiting device's countdown display, and
  nothing the client believes about the time reaches the server's judgement.

Two knobs, both announced to the waiting device in the start response and therefore resolved
at lifecycle time rather than read per call:

```typescript
createAuthLifecycle({
    deviceAuth: {
        ttlMs: 10 * 60 * 1000,   // how long a code lives. default 10 minutes
        intervalMs: 5000,        // poll interval the server asks for. default 5s
    },
})
```

No job sweeps the table. Rows are judged by `expiresAt` whenever they are read or moved, so a
stale row authorizes nothing; it only keeps its user code out of circulation, and 31⁸ codes do
not run out.

### Registered devices (key management)

A [passkey](#passkeys-webauthn) is **not** one of these keys: it is a credential that proves
identity at sign-in, after which an ordinary device key is registered exactly as a password
login registers one.

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
| `SPFN_AUTH_PASSKEY_USER_VERIFICATION` | `.env.server` | `preferred` (default) or `required`. `discouraged` refuses boot |
| `SPFN_AUTH_PASSKEY_CHALLENGE_TTL_SECONDS` | `.env.server` | default `300` — one ceremony at the authenticator, not an abandoned tab |
| `SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES` | `.env.server` | default `10` — see [the recent-authentication gate](#the-recent-authentication-gate) |

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

- **the device key this request is signed with was registered within
  `SPFN_AUTH_PASSKEY_RECENT_AUTH_MINUTES`** — that is when this device last presented a
  credential, and it needs no new state; or
- **the body carries `currentPassword`** and it verifies.

Otherwise: **403 with `code: 'RECENT_AUTH_REQUIRED'`**. Branch on that code to prompt for the
password and retry — it is a stable field, not a message to match on.

An account with no password stored **cannot** satisfy the gate with a password, however
plausible the value; it has to sign in again. The comparison still runs, against a dummy hash,
so "no password on file" costs exactly what "wrong password" costs — otherwise response time
becomes an oracle for which accounts are OAuth-only.

#### Managing passkeys

```typescript
const { passkeys } = await authApi.listPasskeys.call({ body: {} });
// → [{ passkeyId, label, deviceType, backedUp, transports, createdAt, lastUsedAt }]

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

#### Recovery — read this before shipping a passkey-only sign-up

**There is no password reset in `@spfn/auth` today.** The ways back into an account are: a
live passkey, a password, or a linked social account. Nothing else — support cannot restore an
account that has none of the three.

That is why **revoking the last live passkey is refused (409, `code:
'LAST_RECOVERY_CREDENTIAL'`) when the account has no password and no linked social account.**
The refusal is not paternalism; it is the absence of an undo. Branch on that code to offer
"set a password first" or "link an account first".

The same fact should shape your sign-up: an account created without a password and given one
passkey has exactly one way in, and losing the device loses the account. Ask for a password or
a social link before, or shortly after, the passkey.

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
- **A refusal leaves the challenge live.** Spending happens inside the transaction that writes
  what it authorizes, so a failure rolls it back and the ceremony is retryable; only a success
  is unrepeatable.
- **A signature counter that goes backwards refuses the sign-in and leaves the row alone.** It
  is the signal a cloned authenticator would produce — but a synced passkey reports 0 forever
  and a restored device can hit it, so auto-revoking would lock people out on a false
  positive. The refusal is logged at `warn` with the passkey id; a human decides what it meant.
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
| `LastRecoveryCredentialError` | 409 | `LAST_RECOVERY_CREDENTIAL` | revoking it would leave no way back in |
| `PasskeyConfigError` | boot | — | an origin off the rpId or not https, or an unsupported user-verification value |

#### Events

`passkeyEnrolledEvent` (`auth.passkey.enrolled`: `userId`, `passkeyId`, `label?`) and
`passkeyRevokedEvent` (`auth.passkey.revoked`: `userId`, `passkeyId`, `reason`) fire after
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

Configuration rows C1–C6 are in `src/__tests__/unit/passkey-config.test.ts`.

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
| `off` | No check. |
| `warn` | **Default.** Allows the request, logs one line per request that would be refused. |
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

`authLoginEvent`'s `provider` is `'email'`, `'phone'`, a social provider, `'device'` or
`'passkey'`. `'device'` is a [device-code login](#device-code-login), where the account was
proven on another device that was already signed in and no credential was presented here;
`'passkey'` is a [WebAuthn assertion](#passkeys-webauthn). `authRegisterEvent` accepts
neither: a device-code request can only ever be approved by an account that already exists,
and a passkey has to be enrolled from a session that already exists, so neither is a signup.

`passkeyEnrolledEvent` (`auth.passkey.enrolled`) and `passkeyRevokedEvent`
(`auth.passkey.revoked`) fire after commit when a passkey is added or retired.

Payload types: `AuthLoginPayload`, `AuthRegisterPayload`, `InvitationCreatedPayload`,
`InvitationAcceptedPayload`, `AuthDeletionRequestedPayload`, `AuthDeletionCancelledPayload`,
`AuthDeletionCompletedPayload`, `OAuthUnlinkedPayload` (`auth.oauth.unlinked` — provider-side
disconnect, see the OAuth unlink-notify section), `PasskeyEnrolledPayload`,
`PasskeyRevokedPayload`. These events also bind to `@spfn/core/job`
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
- `email` arrives trimmed and lower-cased, the same form the account is stored under, so a
  denylist or domain allowlist keyed on the address is not walked past by capitalizing it.
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

Each requires `authenticate` plus `requireRole('admin', 'superadmin')`. The administrator
seeded from `SPFN_AUTH_ADMIN_*` (see [Admin seeding](#admin-seeding))
signs in with a password, so this works in an app whose end users only sign in socially.

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
import { registerAuthProfile, type AuthContext } from '@spfn/auth/server';
import { UnauthorizedError } from '@spfn/core/errors';

// At boot — server.config.ts, before the server starts taking requests.
registerAuthProfile('serviceTokenV1', {
    verify: async (c): Promise<AuthContext> =>
    {
        const user = await findServiceAccount(c.req.header('x-acme-service-token'));
        if (user === null)
        {
            // A refusal leaves the verifier as a throw. It reaches the app's
            // error handler exactly as the Bearer path's does.
            throw new UnauthorizedError({ message: 'Invalid service token' });
        }

        return {
            user,
            userId: String(user.id),
            keyId: 'service-token',
            role: null,
            locale: 'en',
            scheme: 'serviceTokenV1',
        };
    },
});
```

A request naming the profile is then answered by that verifier:

```http
POST /v1/reports
x-spfn-auth-profile: serviceTokenV1
x-acme-service-token: <the app's own credential>
```

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
callback 404s — including in local dev. An explicit `SPFN_AUTH_<PROVIDER>_REDIRECT_URI` on the
wrong origin or path no longer gets that far: it fails at boot with a message naming the
variable. Details in
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
