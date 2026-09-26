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
(`^16.3.3`).

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
| `SPFN_AUTH_PASSWORD_RESET_LINK_TTL_MINUTES` / `_SETUP_TTL_MINUTES` | `.env.server` | — | defaults `30` / `15` — see [Password reset](#password-reset-verified-email) |
| `SPFN_AUTH_PASSWORD_RESET_CONFIRM_PATH` | `.env.server` | — | default `/password/reset`; the page in your app the emailed link opens |
| `SPFN_AUTH_REVOKE_ALL_LINK_TTL_MINUTES` | `.env.server` | — | default `30` — see [The sign-out-everywhere link](#the-sign-out-everywhere-link) |
| `SPFN_AUTH_REVOKE_ALL_CONFIRM_PATH` | `.env.server` | — | default `/account/revoke-all`; the page in your app the link opens |
| `SPFN_AUTH_LINK_MAIL_DELIVERY` | `.env.server` | — | `auto` (default) \| `inline` \| `queued`; who sends signup-link, reset and account-exists mail — see [Link mail delivery](#link-mail-delivery) |
| `SPFN_AUTH_PASSKEY_RP_ID` / `_RP_NAME` / `_ORIGINS` | `.env.server` | — | relying party for passkeys; defaults derive from `{NEXT_PUBLIC_SPFN_APP_URL\|\|SPFN_APP_URL}` and are **checked at boot** — see [Passkeys](#passkeys-webauthn) |
| `SPFN_AUTH_PASSKEY_USER_VERIFICATION` | `.env.server` | — | `preferred` (default) or `required`; `discouraged` refuses boot |
| `SPFN_AUTH_PASSKEY_CHALLENGE_TTL_SECONDS` / `_RECENT_AUTH_MINUTES` | `.env.server` | — | defaults `300` / `10` — see [Passkeys](#passkeys-webauthn) |
| `SPFN_AUTH_MFA_ISSUER` | `.env.server` | — | name the authenticator app files the account under; defaults to the passkey relying-party name, then the app URL host — see [Second factor](#second-factor-mfa) |
| `SPFN_AUTH_MFA_STEP_UP_MINUTES` | `.env.server` | — | default `10`; how recently an enrolled account's device must have proved its second factor for a sensitive change — see [Second factor](#second-factor-mfa) |
| `SPFN_AUTH_MFA_CHALLENGE_TTL_MINUTES` | `.env.server` | — | default `10`; how long a new-device step-up challenge stays spendable — see [Step-up on a new device](#step-up-on-a-new-device) |
| `SPFN_AUTH_MFA_CONFIRM_PATH` | `.env.server` | — | default `/auth/mfa`; app page the OAuth callback handler sends a browser to when a social sign-in needs a second factor |
| `SPFN_AUTH_BOUND_KEY_TTL_HOURS` | `.env.server` | — | default `24`; how long a passkey-bound session key lives — see [Session binding](#session-binding) |
| `SPFN_AUTH_BOUND_KEY_RENEW_GRACE_HOURS` | `.env.server` | — | default `168`; how long past expiry a bound key may still be renewed. Past it, sign in again |
| `SPFN_AUTH_CONCURRENT_USE_WINDOW_MS` | `.env.server` | — | default `300000`; how close two sightings from two addresses must be to raise `concurrentUseAtMillis` |
| `SPFN_AUTH_SESSION_RENEW_PATH` | `.env.local` | — | default `/auth/renew`; the page `RequireAuth` sends a bound session whose key ran out |
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
| `requestPasswordReset` | POST `/_auth/password/reset` | public | email a one-time password reset link — see [Password reset](#password-reset-verified-email) |
| `confirmPasswordReset` | POST `/_auth/password/reset/confirm` | public | exchange the link for a password-setup session |
| `completePasswordReset` | POST `/_auth/password/reset/complete` | setup session | set the new password, sign every other device out, sign this one in |
| `login` | POST `/_auth/login` | public | password login + new session key |
| `startDeviceAuth` | POST `/_auth/device/start` | public | begin a device-code login — see [Device-code login](#device-code-login) |
| `pollDeviceAuth` | POST `/_auth/device/poll` | public | ask whether the request was answered; the approved answer *is* the login |
| `getDeviceAuthInfo` | POST `/_auth/device/info` | yes | what device is asking, so the approval screen can show it |
| `approveDeviceAuth` | POST `/_auth/device/approve` | yes | let the waiting device in |
| `denyDeviceAuth` | POST `/_auth/device/deny` | yes | refuse it |
| `issueDeviceLink` | POST `/_auth/device/link/issue` | yes | show a code a new device can come in by — see [Device link](#device-link) |
| `redeemDeviceLink` | POST `/_auth/device/link/redeem` | public | the new device parks its key on that code and gets the match number to show |
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
| `mfaTotpConfirm` | POST `/_auth/mfa/totp/confirm` | yes | spend the first code; answers the ten recovery codes |
| `mfaDisable` | POST `/_auth/mfa/disable` | yes + step-up | remove the second factor (204 either way) |
| `mfaMarkPasskey` | POST `/_auth/mfa/passkey/mark` | yes + step-up | mark or unmark a passkey as the second factor |
| `mfaRegenerateRecoveryCodes` | POST `/_auth/mfa/recovery/regenerate` | yes + step-up | ten fresh codes; every earlier one stops verifying |
| `mfaStatus` | GET `/_auth/mfa/status` | yes | `{ enrolled, methods, recoveryCodesRemaining }`; no secret |
| `mfaStepUp` | POST `/_auth/mfa/step-up` | yes | re-prove the second factor on this device |
| `mfaStepUpOptions` | POST `/_auth/mfa/step-up/options` | yes | options for a step-up by passkey |
| `mfaVerify` | POST `/_auth/mfa/verify` | public | finish a sign-in that answered `202 { mfaRequired: true }` — see [Step-up on a new device](#step-up-on-a-new-device) |
| `mfaVerifyOptions` | POST `/_auth/mfa/verify/options` | public | options for finishing that sign-in with a passkey |
| `logout` | POST `/_auth/logout` | yes | revoke current key |
| `rotateKey` | POST `/_auth/keys/rotate` | yes | rotate public key before 90-day expiry |
| `listKeys` | POST `/_auth/keys/list` | yes | the caller's registered devices — see [Registered devices](#registered-devices-key-management) |
| `revokeKey` | POST `/_auth/keys/revoke` | yes | sign one device out |
| `revokeAllKeys` | POST `/_auth/keys/revoke-all` | yes | sign every device out (spares the caller by default) |
| `setSessionBinding` | POST `/_auth/session/binding` | yes | turn session binding on or off — see [Session binding](#session-binding) |
| `getSessionBinding` | GET `/_auth/session/binding` | yes | whether it is on, and when this session's key expires |
| `sessionBindingDisableOptions` | POST `/_auth/session/binding/disable/options` | yes | the challenge that proves it is you before turning it off |
| `sessionRenewOptions` | POST `/_auth/session/renew/options` | public | begin renewing a bound session key |
| `sessionRenewVerify` | POST `/_auth/session/renew/verify` | public | verify the assertion; answers exactly as `login` |
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
[Session binding](#session-binding).

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

**Who can reset.** An `active` account whose `emailVerifiedAt` is set **or** that already has
a password. The second half is what makes the rule work on accounts created before the
column was stamped: both register paths proved the address at signup. An OAuth-only account
whose provider reported the address unverified has neither and is excluded — for it, a reset
would be a way in built on an address nobody proved.

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
  would hand one back to exactly the device they were cutting off. Revoking a single key,
  logging out and rotating a key do not: those name one device, and the waiting one is not it.
- **The poll re-checks the account.** It is a login, so it refuses a suspended or
  pending-deletion account with the same errors `/_auth/login` does. Approval and collection
  are separate moments, and what the account is when the key is registered is what counts.
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

The approved answer is the one `pollDeviceAuth` and `login` return, produced by the same
completion — account status checks, key registration, the login event — so a client cannot tell
which way in it took. Its key is registered under the issuer's account with channel
`device-link` on `auth.device.registered`.

| state ↓ call → | redeem | status | confirm | deny | cancel | poll |
| --- | --- | --- | --- | --- | --- | --- |
| issued | → redeemed | `issued` | 409 NotRedeemed | 409 NotRedeemed | → expired | — |
| redeemed | 404 | device + `choices` | right number → approved; wrong → denied + 400 WrongMatch | → denied | → expired | `pending` |
| approved | 404 | `approved` | 409 AlreadyHandled | 409 AlreadyHandled | 409 AlreadyHandled | login, → consumed |
| denied | 404 | `denied` | 409 AlreadyHandled | 409 AlreadyHandled | 409 AlreadyHandled | 403 Denied |
| consumed | 404 | `consumed` | 409 AlreadyHandled | 409 AlreadyHandled | 409 AlreadyHandled | 404 |
| dead (TTL, cancelled, replaced, issuer signed out) | 400 Expired | 400 Expired | 400 Expired | 400 Expired | 400 Expired | 400 Expired |
| unknown, or another key's link | 404 | 404 | 404 | 404 | 404 | 404 |

Error names are `DeviceLink` + the cell: `DeviceLinkNotFoundError` (404),
`DeviceLinkExpiredError` (400), `DeviceLinkWrongMatchError` (400), `DeviceLinkDeniedError` (403),
`DeviceLinkNotRedeemedError` (409), `DeviceLinkAlreadyHandledError` (409). A consumed link stays
404 to the new device after its TTL, for device-code login's reason.

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
  one wrong pick denies the link — there is no second try, and the new device is told it was refused.
  Typing the number would be stronger; three to tap is the trade taken for a flow people finish.
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
`auth.deviceLink.poll`, since contract 0.13.2. The issuer's five routes run on the signed-in
device and are not on that surface.

### Registered devices (key management)

A [passkey](#passkeys-webauthn) is **not** one of these keys: it is a credential that proves
identity at sign-in, after which an ordinary device key is registered exactly as a password
login registers one.

Keys are per-device, so a login never revokes the previous key and they accumulate on purpose.
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
- **Revocation takes effect immediately.** `authenticate` reads the key from the database on every
  request with no cache in front of it.
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
`KeyIdAlreadyRegisteredError` (409), on every path that registers a key. Re-registering a key that
is still active is the one
exception: it stays a no-op success, so repeated logins from the same device keep working, and an
expired-but-active key has its expiry extended by the sign-in that proved the identity again.

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
`/account/revoke-all`), not an API route — the same shape the signup and reset links use. That page
ships with the package: mount it in one route file and you are done.

```typescript
// app/account/revoke-all/route.ts
import { createRevokeAllPageHandlers } from '@spfn/auth/nextjs/server';

export const { GET, POST } = createRevokeAllPageHandlers();
```

`GET` reads the token out of the query string, calls `confirmRevokeAllLink` and draws the expiry,
the device count and one button; `POST` calls `consumeRevokeAllLink` and reports the count it
signed out. Every answer carries `Cache-Control: no-store` and
`Content-Security-Policy: frame-ancestors 'none'`, the token appears in a hidden field and the API
body and nowhere else, and every 404 is the same screen with no reason on it. Pass
`render: (view: RevokeAllPageView) => string` to own the body at all three stages
(`confirm` / `done` / `invalid`) while the handler keeps the status, the headers and the fields.

- **There is no session on this page, so the CSRF token is not derived from one.** `GET` mints 32
  random bytes, sets them in a cookie scoped to the page's own path (`HttpOnly`, `Secure` in
  production, `SameSite=Strict`, 15 minutes) and mirrors them into the form; `POST` compares the
  two before calling the API and expires the cookie afterwards. A custom `render` must echo
  `view.fields` and `view.csrfToken` back as hidden inputs, or the form it draws cannot be
  submitted.

**An app that wants its own page** can call the two endpoints directly instead — they are public,
and this is what the handlers above do:

```typescript
'use client';

const token = useSearchParams().get('token');

// Describing the link changes nothing at all, so a mail scanner that prefetches
// the page has not signed anybody out.
const { expiresAt, activeKeyCount } = await authApi.confirmRevokeAllLink.call({ body: { token } });

// The button.
const { revokedCount } = await authApi.consumeRevokeAllLink.call({ body: { token } });
```

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
| K1 / K4 | two concurrent revokes: 2 passkeys and nothing else / 1 passkey and a password | 200 + 409 / 200 + 404 |
| K2 / K3 | last passkey, no password: with a verified email / phone-only | 200 / 409 |

Configuration rows C1–C6 are in `src/__tests__/unit/passkey-config.test.ts`.

### Second factor (MFA)

Optional, and optional in the strong sense: an account that never enrols sees exactly the
behaviour it saw before this existed, on every route. Nothing here blocks anybody — the
package asks for a second factor only from people who asked it to.

Two forms. A **TOTP** authenticator app (RFC 6238, SHA-1, 30-second steps, six digits, one
step of drift), or a **passkey** the owner already enrolled through `/_auth/passkeys/*` and
has marked as a second factor. Either one comes with ten single-use recovery codes.

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

A submitted code has its spaces and dashes stripped, so `123 456` and `123-456` are the same
code. Five wrong codes discard the pending secret — the sixth attempt says there is nothing to
confirm, and a fresh `totp/enroll` is the remedy and what resets the counter. A **confirmed**
enrolment is never discarded that way; `totp/enroll` on one is a 409, because replacing a
working second factor is `disable` followed by a fresh enrolment, both step-up gated.

The **same code cannot be spent twice**, which is what makes it single-use: the newest step
the account has spent is remembered, and a code presented again inside its own thirty seconds
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

The rule is per **device key**: this device must have proved the second factor within
`SPFN_AUTH_MFA_STEP_UP_MINUTES` (default 10). Otherwise the answer is **403
`STEP_UP_REQUIRED`**, and the client sends the user to `POST /_auth/mfa/step-up` — a TOTP
code, a recovery code, or an assertion from a marked passkey (options from
`POST /_auth/mfa/step-up/options`) — and retries. 403 rather than 401 on purpose, and for the
reason `RECENT_AUTH_REQUIRED` is: a 401 on an authenticated route is what a web client reads
as "the session is gone", so it would sign the user out instead of asking for a code.

A key **rotation carries the window across**, because rotating is already proof of the same
device — otherwise the web proxy, which rotates at every login, would expire it constantly.

The two passkey routes keep their own `RECENT_AUTH_REQUIRED` rule unchanged and run it after
the step-up: the two guards are independent, and an unenrolled account meets exactly the rule
it met before. Unmarking the last second-factor passkey is likewise independent of
`LAST_RECOVERY_CREDENTIAL` — removing a mark is not removing a way into the account, so
`passkey/mark false` succeeds where `passkeys/revoke` on the same credential is still refused.

Two sign-ins deliberately produce a session with no verification of its own: a
[device-code login](#device-code-login) and a passkey sign-in. Both are exempt at
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
the four where one stolen credential would otherwise be enough. A device-code approval and a
passkey sign-in do not, because each already carried a second proof; nor does a key rotation,
a renewal, or any path that is creating the account. A brand-new social account is not stepped
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
cannot touch anybody's attempt counter; it is single use, it lives
`SPFN_AUTH_MFA_CHALLENGE_TTL_MINUTES` (default 10), it dies with the account's key generation,
and five wrong proofs end it and delete the pending key. Retrying the same registration while
a challenge is live resumes it — same row, same expiry, same spent attempts — rather than
answering 409.

**Recovery codes work here**, which is the point of having them: somebody whose authenticator
is on the phone they just lost signs in on the replacement with a written-down code.

##### Migration

`LoginResult` gained a required `mfaRequired` and every other field became optional. Narrow on
it before reading `userId` — see [the migration note](#migration--narrow-a-sign-in-on-mfarequired-before-reading-userid).

##### The web OAuth path

The backend callback redirects with **`?mfaChallenge=`** instead of `userId` and `keyId`. The
value is not a bearer credential for anything but this one `verify`, it is single use, and
`requestLogger` records pathnames only — so unlike the sign-out-everywhere link it is not a
capability riding a URL.

Both consumers of that redirect are served:

- `createOAuthCallbackHandler()` redirects the browser to **`SPFN_AUTH_MFA_CONFIRM_PATH`**
  (default `/auth/mfa`, or the `mfaPath` option) with `?challenge=` and `?returnUrl=`.
- An app on the callback-page flow posts `{ mfaChallenge }` to `POST /_auth/oauth/finalize`,
  which answers **202** with the challenge echoed back instead of finalizing a session.
  `OAuthCallback` does this for you and then navigates to the confirm page with the same
  `?challenge=` and `?returnUrl=` — so both flows are supported end to end: callback → 202 and
  pending cookie → confirm page → proof → session → return path. The component runs in the
  browser and cannot read `SPFN_AUTH_MFA_CONFIRM_PATH`; an app that sets it passes the same
  path as `<OAuthCallback mfaPath="…" />`.

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

Both OAuth flows land on `SPFN_AUTH_MFA_CONFIRM_PATH` (`/auth/mfa`). `useMfaConfirm()`, from
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
| `wrong` | `MfaVerificationFailedError` (401) — a wrong code, or a challenge spent by five wrong ones | try again |
| `expired` | `SESSION_PENDING_EXPIRED` or `SESSION_PENDING_MISMATCH` from the proxy | sign in again |
| `failed` | anything else — network, rate limit, a passkey ceremony `error` | try again; the page's inputs are untouched |

`error` carries the error behind the last `wrong` / `expired` / `failed`. The challenge itself
is never logged or handed to a callback. A challenge that outlives its ten minutes **at the
backend** is refused like a wrong code, so it reads as `wrong` rather than `expired`; the
backend answers both with one body on purpose.

#### Telling people it exists

`authLoginEvent` and `authDeviceRegisteredEvent` carry **`mfaEnrolled: boolean`**, computed as
the event is emitted. That is the whole of the package's opinion: subscribe and offer
enrolment at a first login or when a new device appears. Nothing is ever blocked on it.

#### Errors

| error | status | `code` | when |
|-------|--------|--------|------|
| `MfaVerificationFailedError` | 401 | — | a wrong or stale code, a spent step, a used / old-generation / foreign recovery code, or an assertion from an unmarked passkey |
| `MfaNotEnrolledError` | 400 | — | `confirm` with no pending secret (the five-strike deletion included), or `regenerate` on an account with no second factor |
| `StepUpRequiredError` | 403 | `STEP_UP_REQUIRED` | an enrolled account's device is outside the window |
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
new device), `mfa-verify.test.ts` (verify × input) and `src/__tests__/unit/mfa-proxy.test.ts`
(the Next.js proxy); each `it` is named for its row.
`mfa-unenrolled-regression.test.ts` pins the status and the body shape an **unenrolled**
account gets from `login`, `changePassword`, `keys/revoke-all` and `passkeys/revoke`.

#### The sweep

`auth.mfa.sweep` runs daily at 07:00 and deletes enrolments still unconfirmed after 24 hours,
plus step-up challenges that have expired or been spent and the inactive keys they were
holding. It is carried by `authJobRouter` beside the other sweeps; pass `mfaSweepCron` to
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
// Turn it on. Needs a live passkey and a recently-proved session.
await authApi.setSessionBinding.call({ body: { mode: 'passkey' } });
// → { mode: 'passkey', keyExpiresAtMillis }

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
the user-agent family check below is the only thing standing in front of it. After the key
expires, the copy has nothing: renewal needs the passkey, and the account's own browser is the one
holding it. Turning binding *off* is the privileged direction here, the reverse of the usual
posture: `assertRecentAuthentication` is satisfied by the age of the device key a request is signed
with, and a cookie copied in the ten minutes after a sign-in carries exactly that — so leaving
`'passkey'` mode asks for a passkey assertion or the account password, never key age alone.

**The renewal page.** Once the key has run out, the backend refuses with `KeyExpiredError`, the
proxy turns that into 401 `SessionRenewalRequiredError` and keeps the cookies: the session is
waiting on one prompt, not finished. A client component calls `renewSession(api)`, which runs the
ceremony and gets a new bound key sealed into the cookie.

The proxy never refuses on the cookie's own copy of the expiry. `keyExpiresAt` inside the cookie is
a hint written at the last seal; the key row is the fact, and only a request that reached the
backend can read it. That matters on the second device: turning binding **off** rewrites every
active key to an ordinary 90-day one, but only the browser that asked gets a re-sealed cookie, so
another device keeps a cookie that says `passkey` with an expiry that no longer applies. Because
nothing is decided from that hint, its next request is forwarded, the backend sees an ordinary key
and answers 200 — no renewal prompt for a session that does not need one. What that device does
keep until it signs in again is its sealed `uaFamily`, so the user-agent family check below goes on
applying to it.

> **Renewal is bound to the expiring key's own signature.** `session/renew/options` and
> `session/renew/verify` are not public: they take the ordinary bearer JWT the proxy signs with the
> private key in the session cookie, and the key being renewed is that JWT's `keyId` rather than
> anything the body says. The one thing they do differently from every other route is admit a key
> whose `expiresAt` has passed, while it is bound and inside its grace. So a caller who does not
> hold the private half of a key gets the same `SessionRenewalRefusedError` whatever key id they
> name — no credential, a wrong signature, an unbound key, a revoked key, one past its grace and an
> inactive account are one answer with one body, and whether a key id is live never leaks.

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

**The user-agent family check.** Independently of expiry, a bound session presented from a
different browser family is refused 401 `SessionContextChangedError` and its three cookies are
cleared. Browsers do not share cookie jars, so that move cannot happen without a copy. The
comparison is coarse on purpose — five families, `edge` / `chrome` / `firefox` / `safari` /
`other`, and **no desktop/mobile axis** — so a version bump, a user-agent reduction and Android's
"Request desktop site" are all the same browser.

- **Chrome on iOS and Safari on iOS are different families.** They are different cookie jars, so a
  session moving between them moved by being copied. An in-app `SFSafariViewController` shares
  Safari's jar and carries no badge of its own, so it reads as `safari` and passes.
- **A request with no `user-agent` is no signal, not a different family.** A server component's
  `api.` call reaches the proxy as Node `fetch` and carries none; refusing those would refuse every
  server-rendered page view.
- **Unbound accounts are neither checked nor logged.** The check exists for sessions that asked
  for it.

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

**A binding change that cannot re-seal the cookie fails closed.** Turning binding on or off commits
on the backend and then re-seals the session cookie in the proxy's response. If that re-seal cannot
happen, the answer is 500 `SessionResealFailedError` with the three session cookies cleared, never
the route's 200: a cookie that disagrees with the account is the state the feature exists to avoid,
and signing in again is what produces one that agrees.

**Unbound accounts are unchanged.** Every response, every cookie and every query count is what it
was: nothing above applies to an account that did not opt in, and a sign-in that answers without
the two binding fields seals exactly the session it always did — which is also what an app calling
`saveSession()` by hand gets.

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

On an account with a [second factor](#second-factor-mfa) and a device it has not seen, the
callback carries `?mfaChallenge=` instead of `userId`/`keyId` and no session is created until
that challenge is spent — see [the web OAuth path](#the-web-oauth-path). Both the
`createOAuthCallbackHandler` route and the `OAuthCallback` page flow are handled.

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

### Emptying the cookie jar from a route handler or middleware

`clearSession()` works where `next/headers` is writable. The page that answers *the API
refused your session* is usually a route handler or middleware holding a `NextResponse`
instead — `clearSessionCookies(response)` expires the session, key-id, OAuth-pending and
CSRF cookies on it and returns the same response, so the call chains:

```typescript
import { clearSessionCookies } from '@spfn/auth/nextjs/server';

export function GET(request: NextRequest)
{
    return clearSessionCookies(NextResponse.redirect(new URL('/login', request.url)));
}
```

Never spell the names in your app. They carry an `SPFN_PORT` suffix (`spfn_session_4001`),
so two dev instances do not overwrite each other's cookies, and a hand-written copy of that
rule clears the wrong cookie without failing. Read them from `sessionCookieNames()`, which
returns `{ session, keyId, oauthPending, csrf }` at call time.

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
import { authLoginEvent, authRegisterEvent, authDeviceRegisteredEvent, invitationCreatedEvent, invitationAcceptedEvent } from '@spfn/auth/server';

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
as the event is emitted. It is the hook an app uses to offer a [second
factor](#second-factor-mfa) at a first login or when a new device appears; the package itself
never blocks an account that has none.

A sign-in that answered **202** because the account needs a [step-up on a new
device](#step-up-on-a-new-device) emits neither event, and does not move `lastLoginAt` either.
Both are held until `POST /_auth/mfa/verify` succeeds and then fire together, carrying the
original channel — so an attacker holding only a password produces no login event and no
device notice on an account they never got into, which is exactly the signal the owner needs
these events to mean.

Key **rotation** is deliberately not announced — replacing the key of a device that is already
signed in is not a new device, and a notice for it would teach the owner to ignore the ones that
matter. A login that names an `oldKeyId` is only a rotation when that key was actually revoked: an
`oldKeyId` naming somebody else's key, an already-revoked one or nothing at all registers a new
device and fires the event. `ip` and `userAgent` are unauthenticated and display-only.

Payload types: `AuthLoginPayload`, `AuthRegisterPayload`, `AuthPasswordResetPayload`,
`AuthDeviceRegisteredPayload`, `InvitationCreatedPayload`,
`InvitationAcceptedPayload`, `AuthDeletionRequestedPayload`, `AuthDeletionCancelledPayload`,
`AuthDeletionCompletedPayload`, `OAuthUnlinkedPayload` (`auth.oauth.unlinked` — provider-side
disconnect, see the OAuth unlink-notify section), `PasskeyEnrolledPayload`,
`PasskeyRevokedPayload`. `AuthLoginPayload` and `AuthDeviceRegisteredPayload` both gained
`mfaEnrolled` in 0.3.0-beta.23. These events also bind to `@spfn/core/job`
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
| `auth.mfa.verify`, `auth.mfa.status` | 0.13.0 |
| `auth.deviceLink.redeem`, `auth.deviceLink.poll` | 0.13.2 |

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
        // refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,   // default 30 days
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
`null`, and `null` is a refusal — `@spfn/mcp` ≥ 0.3.0-beta.3 accepts it as one rather than
requiring a throw. `expiresAt` is seconds since the epoch, like every other OAuth field here.

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
- **A code is spent by the statement that reads it**, so of two exchanges arriving together
  exactly one gets tokens — and **presenting a code twice revokes the grant**, because by then
  somebody else may hold what the first exchange produced.
- **Refresh tokens rotate, and a rotated one is marked rather than deleted.** Presenting it
  again revokes the grant, which kills the replacement as well as the replayed token: both
  hang off the grant and there is no telling which holder is the thief. A refresh may ask for
  a **subset** of the granted scopes and never for more; narrowing applies to that request and
  leaves the user's consent record as they gave it.
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
  `DELETE /_auth/oauth2/grants/:id` does the same for one client, immediately.
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

The screen itself is one route file on the web app, at the path published as
`authorization_endpoint`:

```typescript
// app/oauth/authorize/route.ts
import { createOAuth2AuthorizeHandlers } from '@spfn/auth/nextjs/server';

export const { GET, POST } = createOAuth2AuthorizeHandlers({ loginPath: '/login' });
```

`GET` asks `GET /_auth/oauth2/authorize` what the request is and draws it; `POST` checks the
form's own CSRF token, sends the decision to `POST /_auth/oauth2/authorize`, and redirects the
browser back to the waiting CLI. Neither decides anything — the API validates the request from
scratch both times, because the form between the two calls is in the user's browser.

| Option | What it is |
| --- | --- |
| `loginPath` | Where a visitor with no session goes. The handler appends `?returnUrl=` pointing at this request's own path and query, so signing in lands back on the screen with its parameters intact. The value is held to `isSafeReturnPath` like every other return destination in this package, and a refusal is a 400 screen rather than a redirect |
| `render?` | `(view: OAuth2ConsentView) => string`, replacing the default body. Status, headers and the field set stay the handler's |

Every answer carries `Cache-Control: no-store`, and every page also carries
`Content-Type: text/html; charset=utf-8` and `Content-Security-Policy: frame-ancestors 'none'`
— a consent screen that can be framed is a consent screen that can be clickjacked.

- **The two refusal kinds become the two answers.** `unknown_client` and
  `redirect_uri_mismatch` are shown on a 400 screen with no `Location` at all. Every other
  refusal — `invalid_request`, `invalid_target`, `invalid_scope`, `access_denied` — is a 302 to
  the redirect URI **the API returned**, carrying `error=` and the `state` verbatim. The
  `redirect_uri` in the request is forwarded to the API and never built into a `Location`: the
  API's value is the one that matched a registration, which is the whole difference between a
  redirect and an open redirect.
- **The POST carries its own CSRF token.** The page puts the readable CSRF cookie in a hidden
  `csrf` field and the POST refuses, before calling the API at all, unless the field matches
  the cookie. The handler's server-side call to the API mints the CSRF header itself and would
  always pass, so the form's token is the only check that means anything here.
- **`render` owns the body and nothing else.** `OAuth2ConsentView` carries `clientName`,
  `redirectHost`, `scopes`, `resource`, the `fields` to echo as hidden inputs, and the
  `csrfToken`, all raw — put every one of them through the exported `escapeHtml`. `clientName`
  arrives from unauthenticated dynamic registration, and a renderer that drops `fields` or
  `csrfToken` produces a form the API refuses.

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
    .jobs(authJobRouter)   // the daily (04:00 UTC) purge sweep, and auth.link-mail
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

**What it queues, and why only a row id.** Three mails leave through it: the verified-email
signup link, the password reset link, and the "you already have an account" notice the signup
request answers a known address with. The payload is `{ kind, rowId }` — or `{ kind, target,
targetType }` for the notice — and never the token, the URL or the rendered mail.
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
| `auto` (default) | queue when pg-boss is initialised, send on the request when it is not — an app with no jobs keeps working exactly as before |
| `queued` | always queue; an enqueue failure surfaces as a failed request rather than becoming an inline send |
| `inline` | always send on the request — today's behaviour, and the timing signal that comes with it |

**When the provider refuses on the request path** — `inline`, `auto` with no pg-boss, or the
fallback below — the failure is logged and the request still answers as if the mail had gone out,
because an answer that depended on the mail provider would be an account-existence oracle during
an outage; the user asks again, and only the job path retries.

**The fallback warning.** In `auto`, an app that initialised pg-boss but never registered this
router has no `auth.link-mail` queue, so the enqueue fails. Losing the mail there would be silent,
so that request sends inline instead and the log says once per process:

```
Queue auth.link-mail does not exist, so this link mail was sent on the request path.
Register the auth job router — .jobs(authJobRouter) — or set SPFN_AUTH_LINK_MAIL_DELIVERY='inline'.
```

The fix is in the message: register the router, or say `inline` if sending on the request is what
you want. Only a missing queue falls back — every other enqueue failure, a database outage above
all, surfaces, because falling back on those would hide the outage behind mail that still gets
through.

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
  opportunity to auto-register the jobs. Call `.jobs(authJobRouter)` yourself — see
  [Account Deletion & Recovery](#account-deletion--recovery). An app that initialises pg-boss and
  skips this keeps sending link mail, but on the request path, with a warning naming the router —
  see [Link mail delivery](#link-mail-delivery).
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
