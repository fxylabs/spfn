# Changelog

All notable changes to SPFN will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Note**: For changelog history prior to v0.1.0-alpha.60, see [CHANGELOG-v0.0.x-alpha.md](./CHANGELOG-v0.0.x-alpha.md)

## [Unreleased]

### Changed

#### @spfn/auth

- **BREAKING: a sign-in no longer always answers with a session** (#95). An account that has
  enrolled a second factor and signs in from a device the account has never seen gets `202`
  and a challenge instead; the device key that sign-in registered stays inactive until the
  challenge is spent, so a phished password on its own no longer holds an account.
  `LoginResult` therefore gains one **required** field, `mfaRequired`, and every field it
  carried before is now optional. It is still **one** type rather than a union, because
  `authApi.login` infers its result from that declaration and a union would turn every
  `result.userId` in an app into a compile error with no narrowing available.
    - **Migration**: narrow on the discriminant before reading anything else.

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
      `completePasswordReset`, and to the approved branch of `pollDeviceAuth` — which carries
      `mfaRequired: false` and can never carry anything else, a device-code approval being a
      second factor already. An account with no second factor still answers `200` with
      `mfaRequired: false` and exactly the fields it always had, and an app on the Next.js
      proxy changes nothing at all: `mfaVerifyInterceptor`, registered for you in
      `authInterceptors`, handles the 202 and the pending cookie.
    - Mobile contract **0.13.0**. Four channels stop on a new device — password, web OAuth,
      `oauth-native` and password-reset. A device-code approval, a passkey sign-in, a key
      rotation, a session renewal and any path that creates the account do not, because each
      already carried a second proof or has nothing enrolled yet.
- A `202` moves nothing else either: `authLoginEvent`, `authDeviceRegisteredEvent` and
  `lastLoginAt` are held on the challenge row and fire together at `POST /_auth/mfa/verify`
  with the original channel (#95). An app that mails "new device signed in" therefore sends
  nothing for an attempt that never became a sign-in.

#### @spfn/mcp

- `validateToken` may refuse a bearer token by returning `null` or `undefined` as well as by
  throwing; the adapter treats all three identically (#93). That is what lets
  `@spfn/auth`'s `verifyAccessToken` be passed straight in, since it answers `null` for an
  expired, revoked or wrong-resource token. `@spfn/mcp` 0.3.0-beta.3.

#### @spfn/storage

- The local S3-compatible example in the documentation is **SeaweedFS** (`weed server -s3`,
  S3 on `:8333`, bucket versioning supported), not MinIO: open-source MinIO is archived and
  its binaries are no longer served. The `STORAGE_CONTRACT_S3_*` variables and the provider
  contract suite are unchanged — only the server you point them at.

#### @spfn/core

- **BREAKING: a nested `runInTransaction` / `Transactional()` call is now a `SAVEPOINT` on the
  outer transaction's connection, not an independent transaction on a second one** (#82). It
  sees the outer transaction's uncommitted writes, takes no second connection from the pool,
  no longer self-deadlocks on a row the outer transaction locked, and commits or rolls back
  **with the root** — which is what the documentation had always claimed.
    - **Migration**: code that relied on a nested call committing on its own — an audit row or
      a failed-attempt record meant to survive an outer rollback — must pass
      `requiresNew: true`, a new option on `RunInTransactionOptions` and `TransactionalOptions`
      that opens a real `BEGIN` with its own timeouts and its own hook queues. Everything else
      needs no change.
    - **BREAKING, second dimension: nested calls made off one transaction no longer run
      concurrently.** They share one connection, where two open savepoints corrupt each other
      — the first `ROLLBACK TO` discards everything written on the connection since that
      savepoint, including a sibling's rows, while the sibling reports success. The runner now
      queues nested frames per transaction, so `Promise.all([nestedA(), nestedB()])` still
      returns both results but runs them one at a time. A branch that needs real concurrency
      takes `requiresNew: true` and its own connection. A nested call whose callback awaits a
      sibling started after it deadlocks — documented as misuse, with a once-per-process
      `warn` the first time frames contend.
    - A `timeout` passed to a nested call is ignored, as before (the root's `statement_timeout`
      is in force on the shared connection and is now genuinely inherited), but the `warn` for
      it fires only when the caller passed a timeout explicitly — it used to fire on every
      nested call, because the default is 30s.
    - Driver caveats now documented in `src/db/transaction/README.md`: the pinned driver never
      issues `RELEASE SAVEPOINT`, and a write inside a nested frame holds one of the backend's
      64 cached subtransaction ids until the root ends, so per-row nesting in a loop pushes the
      backend into subxid overflow.

#### @spfn/cli

- **Behaviour change: `spfn codegen run` exits 1 when a generator refuses** (#97), and stops at
  the generator that refused. It used to log the failure, print `✓ Code generation completed`
  and exit 0, leaving the stale output on disk — so a developer who added a route, ran
  `spfn codegen run` and saw a green check shipped a map that did not name it, and a script
  that gates on the exit code saw nothing. `spfn build` already failed this way; `spfn dev`
  still logs and keeps watching.


### Added

#### @spfn/auth

- **An OAuth 2.1 authorization server, so Claude Code and Codex can connect to an app's `/mcp`
  endpoint as the signed-in user** (#93). Dynamic client registration, PKCE and a consent
  screen: the CLI discovers, registers itself, opens a browser and catches the redirect on a
  loopback port, and nobody pastes a token. `@spfn/auth` 0.3.0-beta.19 and 0.3.0-beta.20.
    - Opt in by naming the scopes — there is no default, because the names are the
      application's own vocabulary: `createAuthLifecycle({ authorizationServer: { scopes,
      defaultScopes?, issuer?, authorizeUrl?, allowedRedirectOrigins?, accessTokenTtlMs?,
      refreshTokenTtlMs?, codeTtlMs? } })`. Without that block every endpoint below answers
      404 and the boot check does not run, so an app that wants none of this changes nothing.
    - New routes: `GET /.well-known/oauth-authorization-server` (RFC 8414),
      `POST /_auth/oauth2/register` (RFC 7591, public clients only, IP rate limited),
      `GET`/`POST /_auth/oauth2/authorize`, `POST /_auth/oauth2/token`,
      `POST /_auth/oauth2/revoke` (RFC 7009), `GET /_auth/oauth2/grants` and
      `DELETE /_auth/oauth2/grants/:id`.
    - The consent screen is one route file on the web app, at the path published as
      `authorization_endpoint` (default `{app url}/oauth/authorize`):
      `export const { GET, POST } = createOAuth2AuthorizeHandlers({ loginPath: '/login' })`
      from `@spfn/auth/nextjs/server`. `render` replaces the body; the handler keeps the
      status, the headers, the hidden fields and the form's own CSRF token.
    - `verifyAccessToken(token, resource)` — exported from `@spfn/auth/server` — is what you
      hand `@spfn/mcp`'s `validateToken`. It answers `{ clientId, scopes, expiresAt, userId }`
      or `null`, and an access token issued here is **not** a session: ordinary API routes do
      not accept it.
    - PKCE `S256` only, `resource` (RFC 8707) required and the token good against it alone,
      refresh tokens rotate and a replayed one revokes the grant, every code and refresh
      failure is one `invalid_grant`, and token-endpoint errors are RFC 6749 §5.2 rather than
      the SPFN error envelope. `revoke-all`, a password change, a completed password reset
      and a deletion request each revoke every grant the account has.
    - New sweep `auth.oauth2.client-purge` (daily 05:00, in `authJobRouter`) deletes
      unapproved client rows older than a day. The issuer is checked at boot — absolute, no
      path, `https` (or `http` on loopback for development) — naming `SPFN_API_URL` or
      `authorizationServer.issuer`, whichever it came from.
    - End-to-end, including both CLIs: [docs/guides/mcp-clients.md](docs/guides/mcp-clients.md).
- **A device-registered event and a signed sign-out-everywhere link** (#94), so an account
  owner can be told a device was added and act on it without a session.
  `@spfn/auth` 0.3.0-beta.21 and 0.3.0-beta.22.
    - `authDeviceRegisteredEvent` (`auth.device.registered`) fires after commit on every
      channel that registers a device key — `channel` is `register`, `signup-link`,
      `invitation`, `password`, `oauth`, `oauth-native`, `device-code`, `password-reset` or
      `passkey`. It carries `userId`, `keyId`, `algorithm`, a 12-character
      `fingerprintPrefix`, `createdAtMillis`, `mfaEnrolled`, and whatever the registration
      knew about the device (`deviceName?`, `platform?`, `ip?`, `userAgent?`). A login event
      says a session began and not what it began on, so a stolen password used on a new
      machine used to be silent. Key **rotation** is deliberately not announced.
      Payload type `AuthDeviceRegisteredPayload`.
    - `createRevokeAllLink(userId, { ttlMinutes? })` from `@spfn/auth/server` mints a
      one-time link your app mails to the address the account already proved; opening it
      signs every device out with no session at all. The returned `url` carries the plaintext
      token — hand it to the mail template and do not log, persist or queue it.
    - It opens a page in your app, not an API route. Mount the one that ships with the
      package: `export const { GET, POST } = createRevokeAllPageHandlers()` from
      `@spfn/auth/nextjs/server`. `GET` draws the expiry, the device count and one button;
      `POST` reports how many devices it signed out. Both mint and check a path-scoped CSRF
      cookie of their own, because there is no session here to derive one from.
    - New public routes `POST /_auth/keys/revoke-all/confirm` and
      `POST /_auth/keys/revoke-all/consume` — the token travels in the body, never in a path
      segment, every refusal is the same 404, and both share one 10/minute rate-limit counter.
      Neither is a mobile-contract operation.
    - New settings: `SPFN_AUTH_REVOKE_ALL_LINK_TTL_MINUTES` (default `30`) and
      `SPFN_AUTH_REVOKE_ALL_CONFIRM_PATH` (default `/account/revoke-all`). New sweep
      `auth.revoke-all-token-purge` (daily 06:00) in `authJobRouter`.
    - `listKeys` rows gain `registeredIp` and `registeredUserAgent`, captured once from the
      request that registered the key and never updated — unauthenticated display material,
      so render them and decide nothing by them. Mobile contract **0.11.0**.
- **A second factor: TOTP, a passkey marked as the second factor, and ten recovery codes**
  (#95). Optional in the strong sense — an account that never enrols meets exactly the
  behaviour it met before, on every route. `@spfn/auth` 0.3.0-beta.23 and 0.3.0-beta.25.
    - New routes `POST /_auth/mfa/totp/enroll`, `totp/confirm`, `disable`, `passkey/mark`,
      `recovery/regenerate`, `step-up`, `step-up/options`, `GET /_auth/mfa/status`, and the
      two public ones a sign-in finishes on, `POST /_auth/mfa/verify` and `verify/options`.
    - **`SPFN_AUTH_TOKEN_ENCRYPTION_KEYS` is now required by any app offering a second
      factor, including one with no social login at all** — it is the keyring a TOTP secret
      is encrypted with at rest. Unset, `totp/enroll` answers a 500 configuration error
      rather than the 401 a wrong code gets.
    - For an **enrolled** account, four kinds of change ask for the second factor again on
      the calling device within `SPFN_AUTH_MFA_STEP_UP_MINUTES` (default 10): the password,
      `keys/revoke-all`, the second factor itself, and the account's passkeys. Otherwise the
      answer is **403 `STEP_UP_REQUIRED`** — 403 and not 401, so a web client asks for a code
      instead of reading it as a dead session. `assertStepUp({ userId, keyId })` is exported
      from `@spfn/auth/server` for an application's own sensitive routes.
    - Recovery codes are ten, `xxxxx-xxxxx`, shown once at confirmation and once at each
      regeneration, stored as password hashes rather than unsalted digests, and
      `recovery/regenerate` retires every earlier one. `status` reports how many are left.
    - New settings: `SPFN_AUTH_MFA_ISSUER`, `SPFN_AUTH_MFA_STEP_UP_MINUTES` (`10`),
      `SPFN_AUTH_MFA_CHALLENGE_TTL_MINUTES` (`10`) and `SPFN_AUTH_MFA_CONFIRM_PATH`
      (`/auth/mfa`). New sweep `auth.mfa.sweep` (daily 07:00) in `authJobRouter`, which
      deletes unconfirmed enrolments after 24 hours and the inactive keys expired challenges
      were holding.
    - From a browser: `completeMfaWithCode`, `completeMfaWithRecoveryCode` and
      `completeMfaWithPasskey` from `@spfn/auth/client` finish the whole second half.
      `authLoginEvent` and `authDeviceRegisteredEvent` carry `mfaEnrolled`, which is the hook
      for offering enrolment; the package itself never blocks an account that has none.
    - Mobile contract **0.13.0** carries the `auth.mfa.*` family; the enrolment routes are not
      contract operations.
- **Opt-in session binding, so a copied session cookie stops working** (#97). A web session's
  signing key is sealed inside the cookie, which makes a copy of the cookie that device —
  binding puts that session on a key that expires in hours and that only a fresh WebAuthn
  assertion can replace. `@spfn/auth` 0.3.0-beta.24.
    - `authApi.setSessionBinding.call({ body: { mode: 'passkey' } })` turns it on and
      `getSessionBinding` reports `{ mode, keyExpiresAtMillis? }`; turning it **off** needs a
      fresh credential, so `disableSessionBinding(api)` from `@spfn/auth/client` runs the
      passkey ceremony or takes `{ currentPassword }`. New routes
      `POST`/`GET /_auth/session/binding`, `POST /_auth/session/binding/disable/options`,
      `POST /_auth/session/renew/options` and `POST /_auth/session/renew/verify`.
    - **It needs a deployment where `proxy-guard` tags the request `clientType: 'web'`** —
      that is the only signal the backend has that a request came through the proxy holding
      the session cookie. Without it, `setSessionBinding` answers 400
      `SessionBindingUnavailableError` rather than turning on a switch that protects nothing.
    - New settings: `SPFN_AUTH_BOUND_KEY_TTL_HOURS` (default `24`),
      `SPFN_AUTH_BOUND_KEY_RENEW_GRACE_HOURS` (default `168`, i.e. seven days past expiry a
      bound key may still be renewed), `SPFN_AUTH_CONCURRENT_USE_WINDOW_MS` (default
      `300000`) and `SPFN_AUTH_SESSION_RENEW_PATH` in `.env.local` (default `/auth/renew`).
    - Once the key runs out the proxy answers 401 `SessionRenewalRequiredError` and **keeps
      the cookies**: a client component calls `renewSession(api)` and the session continues.
      `RequireAuth` takes `renewalPath` and sends a server-rendered page there instead of to
      sign-in, because a server component cannot run a WebAuthn ceremony, and
      `getAuthSessionData()` answers a third state, `'renewal-required'`, for a hand-written
      guard.
    - A bound session presented from a different browser family is refused 401
      `SessionContextChangedError` and its cookies are cleared. The comparison is five
      families (`edge` / `chrome` / `firefox` / `safari` / `other`) with no desktop/mobile
      axis, so a version bump, a user-agent reduction and "Request desktop site" are all the
      same browser; a request with no `user-agent` is no signal rather than a mismatch.
    - `listKeys` rows gain `binding` and `concurrentUseAtMillis` — the last time one key was
      seen from two attested addresses inside the concurrent-use window. A signal to show and
      notify on, never a refusal, and the addresses themselves are never returned.
      Mobile contract **0.12.0**; every new field is optional and absent for an account that
      did not opt in.

#### @spfn/storage

- **Prefix snapshots over object versions, for a pipeline that overwrites its own outputs**
  (#96). `snapshotPrefix(storage, prefix, { concurrency?, maxKeys? })` records which version
  of every object under a prefix was live at one moment, and
  `restoreManifest(storage, manifest, { onto?, concurrency? })` puts those versions back;
  `serializeManifest` / `parseManifest` are the JSON round trip, and storing the manifest is
  the application's job. `@spfn/storage` 0.3.0-beta.2.
    - `stat(key)` now answers `{ key, size, lastModified?, etag?, contentHash?, versionId? }`
      and `copy(from, to, { sourceVersionId? })` takes the version to copy — without the
      option it is exactly the old behaviour.
    - Restore does not stop at the first failure: every entry lands in `restored`, in
      `skipped` with a reason (`already-current`, `no-version`, `version-missing`) or in
      `failed`. A **missing** target key is not a failure — that is the case restore exists
      for. Everything checkable runs before the first copy: a manifest from another provider,
      an `onto` crossing the `public/` boundary, and every target key through the usual key
      validation.
    - **The bucket decides how far back you can go.** A manifest names versions and cannot
      protect them; S3 lifecycle and GCS Object Versioning retention are what keep them
      alive. Restore writes a **new** version of each object it touches and purges no CDN
      cache. Neither operation is atomic, and a manifest grows with the object count — split
      a very large prefix.
    - **GCS through the S3 interoperability endpoint cannot snapshot versions at all**: the
      AWS SDK reads `x-amz-version-id` and interop returns `x-goog-generation`, so every
      entry restores as `no-version`. Use the native GCS provider where versioned snapshots
      matter.
- `getDownloadUrl(key, options)` signs the response's `Content-Disposition` and
  `Content-Type` into the URL (#211) — the download side of a content-addressed layout,
  where the object has no file name of its own and the name to save it under is known only
  per download. Both values are part of the signature on S3-compatible providers and on GCS,
  so a client cannot edit the query to change them; the local provider appends them as query
  parameters and the app's own file route decides whether to honour them. The positional form
  `getDownloadUrl(key, 900)` still means `expiresIn`. `@spfn/storage` 0.3.0-beta.3.

#### @spfn/mcp

- **The RFC 9728 protected resource metadata document**, served unauthenticated at
  `GET /.well-known/oauth-protected-resource` and at the path-aware form whose suffix is the
  resolved `resource` path (`/.well-known/oauth-protected-resource/mcp`) (#93). It publishes
  `resource`, `authorization_servers`, `scopes_supported` and `bearer_methods_supported`;
  `authorizationServers` defaults to the origin of `appUrl`, `scopesSupported` is the list a
  client picks its `scope` from, and `resourceMetadataUrl` overrides the published URL for a
  deployment served under a base path. `@spfn/mcp` 0.3.0-beta.3.
- A rejected bearer token now gets `WWW-Authenticate: Bearer error="invalid_token",
  resource_metadata="…"` (RFC 6750 §3) where a request with **no** token gets the plain
  challenge (#93). That parameter is what lets a client tell the two apart: refresh the token
  it holds, or go and authorize for one.

#### @spfn/signing

- New package: one `Signer` interface with three key providers behind it — `local` (key
  material from an environment variable, a file or a `KeyObject`), `gcp-kms` and `aws-kms`.
  `sign()` returns a promise on every provider, including `local`, so moving a key into a
  KMS is a configuration change rather than a rewrite.
- EdDSA (Ed25519) is the default and ES256 (ECDSA P-256) is the alternative. Every provider
  signs both: `local` through `node:crypto`, `gcp-kms` through `EC_SIGN_ED25519` and
  `EC_SIGN_P256_SHA256`, `aws-kms` through `ECC_NIST_EDWARDS25519` and `ECC_NIST_P256`. On
  both KMS providers the key's spec decides the algorithm and a passed `alg` that disagrees
  is an error at construction. ES256 signatures are JOSE `r || s` on every provider, never
  DER; an Ed25519 signature is already those 64 bytes.
- AWS KMS is called with `MessageType: RAW` for both algorithms, which caps a signing input
  at 4 KiB. `ED25519_SHA_512` is PureEdDSA and signs the message itself; the pre-hashed
  `ED25519_PH_SHA_512` is a different algorithm and is not used.
- `@spfn/signing/verify` is a verify-only entry point that depends on `node:crypto` and
  nothing else, for token checks that run somewhere the issuer's dependencies cannot. It
  never throws on token input: `verifyJws()` answers `{ ok: false, reason }` with
  `malformed`, `invalid-claims`, `unknown-kid`, `alg-mismatch`, `bad-signature`, `expired`,
  `not-yet-valid`, `too-old` or `no-expiry`. `maxAgeSec` bounds how long a token is
  *accepted*, not only the life it granted itself: it needs both `exp` and `iat` (a token
  that omits either is `no-expiry` rather than exempt), it refuses an `iat` in the future as
  `not-yet-valid`, and it caps `exp - iat`. A time claim that is present but is not a finite
  number, and an `iat` after its own `exp`, are `invalid-claims` rather than `malformed` —
  a signature-valid token with a broken claim is the issuer's bug, and telling that apart
  from three bytes of garbage is the point of the reason code.
- The `kid` in the protected header selects the key, and that key's algorithm is the
  algorithm; the header's `alg` is only ever checked for equality against it. `alg: "none"`
  is an `alg-mismatch`, not a decision.
- `KeyRing` holds up to N keys (default 2) with one current, and `rotate()` walks
  add → switch → wait → remove in that order. It refuses to remove the current key, which
  is the step that would strand tokens still in flight, and both `keys` and `publicKeys()`
  hand out a copy so that no caller can delete its way past that refusal.
- Public keys travel as `kid:base64url(key)`, comma-separated — raw Ed25519, a SEC1
  uncompressed P-256 point, or SPKI DER. base64url is validated strictly *and* canonically:
  every segment is decoded, re-encoded and compared, so the sixteen strings that share one
  signature's bytes are not sixteen tokens.
- `contracts/signing/vectors.json` records six tokens with their expected verdicts, and a
  test regenerates them on every run.

#### spfn (CLI)

- `spfn kit` — the generic installer for licensed Superfunction Kits: `install`, `restore`,
  `status`, `check`, `plan`, `update`, `resume` and `abandon`. It hard-codes no product;
  which Kit, which packages and which files are managed all come from the signed setup
  descriptor and release manifest, and product-specific judgement comes from the tooling the
  CLI discovers among the packages the manifest installs.
- A license key can only arrive through a masked prompt or `--license-key-stdin` — no option
  takes one as an argument. The local credential lives in the OS keychain under its own
  service (`superfunction.spfn.kit`), and the short-lived registry session reaches the
  package manager only through the child process environment.
- Every subcommand supports `--json`, prints newline-delimited events with a stable machine
  code and a safe next command, and never prompts in that mode. Exit codes follow the Kit
  contract: `2` waiting for a person, `3` resumable, `4` refused before any write, `5`
  service unavailable, `10` protocol incompatibility.
- Operations are journalled and resumable. A resume re-reads the project and accepts a
  recorded checkpoint only when its evidence still matches; a lock left behind by a dead
  process is reconciled against the journal rather than deleted.
- The Kit control-plane client is not part of this build yet, so `install`, `restore` and
  `update` report `CLI_CONTROL_PLANE_CLIENT_ABSENT` until it ships.

### Fixed

#### @spfn/auth

- **A passkey-bound session renewal answered 200 and left the browser signed out** (#99).
  `POST /_auth/session/renew/verify` matches two registered proxy rules:
  `loginRegisterInterceptor` mints the replacement key pair, and `generalAuthInterceptor`
  authenticates the request by signing it with the key that is expiring. Both wrote to the
  one `metadata` object the proxy shares between a request and its response, and both called
  their key `keyId` — so the id of the *retired* key was the last one written, and the
  response phase sealed the **new** private key around it. The renewal succeeded, the cookie
  it installed named a key that had just been revoked, and the next authenticated request was
  a `401`. The replacement credentials now travel as `newPrivateKey` / `newKeyId` /
  `newAlgorithm`, the names `keyRotationInterceptor` has always used. `@spfn/auth`
  0.3.0-beta.26.
    - Renewal is where it always bites, because that request is *defined* as one a live
      session makes. But the collision was never renewal's alone: every path on the login
      interceptor's list except `login` and `register` is an authenticated path as far as
      `requiresAuth` is concerned, so `passkeys/login/verify`, `password/reset/complete`,
      `signup/password` and `invitations/accept` sealed the wrong key id too whenever the
      browser still had a session cookie in the jar.
    - And the other half of it: `generalAuthInterceptor`'s near-expiry session refresh no
      longer re-seals the **inbound** session on top of a replacement an earlier rule in the
      same chain just installed. Response phases run in registration order, so that re-seal
      was the last write of the session cookie and undid a renewal, a sign-in or a key
      rotation that happened to land in the last day of the cookie's life.
    - Nothing else changes: the renewal protocol, the backend's proof check and its key
      retirement are untouched, and a refused verify still installs no session and clears no
      cookie.

#### @spfn/core

- **BREAKING: a response interceptor could not redirect, and the caller was handed a network
  failure that never happened** (#104). The client ran `onResponse` inside the `try` that wraps
  `fetch`, whose `catch` tells apart only `AbortError` and calls everything else
  `ApiError(message, 0, url, undefined, 'network')`. Next.js implements `redirect()` and
  `notFound()` by throwing an error carrying a `digest`, so the pattern the scaffold's own
  `api-client.ts` suggests — `if (response.status === 401) redirect('/login')` — never
  navigated: the digest was caught and relabelled, and the caller got a transport error for a
  request that completed. That is worse than the interceptor doing nothing, because retry and
  offline handling keyed on `errorType === 'network'` act on it. The response interceptors now
  run **after** the `try`/`catch` rather than inside it, so an interceptor's throw reaches the
  caller unchanged — `redirect()` and `notFound()` navigate, and an interceptor raising a
  domain error of its own raises that error. The `try` still classifies exactly what it exists
  to classify: an aborted request is still `408` / `'timeout'`, a failed fetch is still `0` /
  `'network'`, and a body that is not the JSON its content-type claims is unchanged too.
  Replacing `response` / `body` from an interceptor still takes effect for everything after it,
  error-status handling included, and the global interceptor still runs before the per-call
  one. `@spfn/core` 0.3.0-beta.13.
    - **Migration**: the inversion is that an `onResponse` which throws now raises **its own**
      error at the call site, where beta.12 handed the caller an `ApiError(message, 0, url,
      undefined, 'network')` instead — so a `catch (e) { if (e instanceof ApiError) … }` around
      a call no longer sees it and the error escapes that catch. An interceptor whose throw was
      being absorbed that way must either catch it inside the interceptor and return a
      response, or the call site must widen its handler to the error the interceptor really
      raises; a `redirect()` or `notFound()` thrown from an interceptor needs no handler and
      must not be caught at all.

- **A `paths` target the generator could not read crashed it with a bare `EACCES`** (#103).
  Alias resolution asks whether a wildcard target names a directory holding anything, and
  `statSync(path, { throwIfNoEntry: false })` suppresses only `ENOENT`: a directory the
  process may not read stats fine and then makes `readdirSync` throw, and an unreadable parent
  makes `statSync` throw too. `projectAliases` runs before the `try`/`catch` that turns a load
  failure into a `RouteMapGeneratorError`, so `spfn codegen run` died with
  `EACCES: permission denied, scandir '<dir>'` and nothing naming alias resolution or the
  `paths` entry involved, where every other load failure names the file and the cause. A
  target that cannot be read now counts as unresolvable and the next target in the entry is
  tried — what already happened for a missing one — so `"@/*": ["./dist/*", "./src/*"]`
  resolves through `./src` when `./dist` is unreadable. The guard names `EACCES` and `EPERM`,
  the latter being what Windows and some container runtimes raise for the same directory, and
  lets every other error through. A narrow regression from the empty-directory change in #216.
  `@spfn/core` 0.3.0-beta.13.

- **A route declared inside a nested `defineRouter` could not be named the way the server
  registers it** (#100). `registerRoutes` has always walked into a nested router and
  registered every route inside it under its own flat name, and the two client-side type
  layers each disagreed with that, in opposite directions. `RouterOutput` / `RouterInput`
  unwrapped exactly one level: the nested router stayed a single key holding a `Router`, so
  none of the routes inside it appeared in the allowed name set, and naming the group key
  instead resolved to `never`. `Client` — what `createApi<AppRouter>()` returns — recursed
  into the nested router as a nested *property*, so it asked for `api.group.getThing`, which
  the runtime proxy never built: a property access there returns a call builder, so
  `api.group` was a builder for a route named `group` and `.getThing` on it was `undefined`.
  Nesting was therefore unusable in any app that referenced a route type or called a nested
  route — which is any app built on the generated client. Both layers now take the same flat
  set of route names across the whole tree, whatever depth a route was declared at:
  `RouterOutput<AppRouter, 'getThing'>` and `api.getThing.call(…)` name the route the way
  `registerRoutes` mounts it and the way the RPC proxy resolves it on the wire. A nested route
  yields exactly the type it yields when the same route is declared flat, and a name no branch
  declares is still a compile error, so a typo is caught rather than resolved to `never`.
  Routes mounted with `.packages()` remain deliberately absent from both — call them through
  the package's own client. `@spfn/core` 0.3.0-beta.11.
    - **Migration**: `api.group.getThing` is now a compile error. This is a compile error
      replacing a runtime failure, not a silent fix: that call could never have worked, since
      the proxy sends the property name as a whole route name and `/api/rpc/group` matches
      nothing in the route map. Call the route by its own name — `api.getThing` — which is
      what the server has always registered. A flat router's client is unchanged, so an app
      with no nesting has nothing to migrate.
    - **Migration**: a name declared in two places in one tree — two branches, or the same
      sub-router mounted twice — is left out of the namespace rather than resolved to one of
      them, the same collision the contract collector refuses. Naming it is a compile error at
      the line that names it; give the routes distinct names, or mount the sub-router once.
      Nothing that compiles today can be relying on the old silent answer, since a nested name
      resolved to nothing at all before this release.
    - A router whose routes are not known — `Router<any>`, or an unresolved type parameter
      constrained to it — now contributes no names rather than accepting every name. A helper
      written generically over `TRouter extends Router<any>` can no longer name a route
      through `RouterOutput`; take the concrete router type instead. The same applies to the
      client: `createApi<any>()` returns a client with no properties rather than one where
      every property exists. Give `createApi` the generated `AppRouter` type.
    - The RPC proxy itself is unchanged — it already sent one flat route name per property
      access. Only its JSDoc claimed dot notation, and that claim is now removed; there is no
      dotted traversal to add, because the route map the proxy resolves against is flat.
    - The generated route map is the layer underneath, and it dropped the same routes for its
      own reason. It is fixed in this release too — see the next entry — so a nested route
      now types, dispatches, and appears in the map under one name.

- **Four ordinary ways of writing a router dropped routes from the generated route map**
  (#97). `@spfn/core:route-map` read the router file as text: it found the **first**
  `defineRouter(` in the file, brace-matched it, and collected a name only when that name
  started its own line. So `defineRouter({ createUser })` written on one line contributed
  nothing, an aliased key `create: createUser` contributed nothing, and a second
  `defineRouter(` in the same file — which is how a nested router is assembled, as
  `const users = defineRouter({…})` and then `defineRouter({ users })` — was not read at
  all, silently costing the outer router its own routes. The RPC client sends
  `/api/rpc/{routeName}` and the server resolves it against this map, so each dropped name
  was a route that typechecked and answered 404.
    - The generator now **loads the router with jiti and walks it**, the way
      `@spfn/core:contract` already did, and takes `method` and `path` from the `RouteDef`.
      The names it writes are exactly the names `registerRoutes` registers for the same
      router: nesting recurses to any depth and every route lands flat under its own key,
      and `.packages()` routers stay out at every depth, because a package publishes its own
      route map and the app merges the two (`{ ...routeMap, ...authRouteMap }`). How the
      router is spelled stopped mattering.
    - **It refuses instead of dropping.** Two routes reaching the same name, a route with no
      method or path, a `method` that is not an `HttpMethod`, an entry that is neither a route
      nor a router, a module that will not load, and a file with no `appRouter` / `default` /
      `router` export are all errors that name the places involved. A failure is logged on
      every trigger and reaches the exit code of `spfn build` and `spfn codegen run`; there is
      no fallback to the old text parser.
    - **A conditionally registered route is refused**, the way the contract generator already
      refused it: `defineRouter({ a, ...(process.env.ENABLE_ADMIN ? { admin } : {}) })` used to
      emit `a` alone and exit 0, so the flag's value at generation time decided which names the
      client could address — with the flag set in production, `api.admin.call()` 404ed. The
      guard reads **the router the generator was pointed at** — the export its loader found,
      plus the routers that export mounts by name from the same file, since a nested router's
      routes land in the same flat map — with TypeScript's parser, so a second router the app
      router never reaches, a JSDoc spelling `defineRouter({ ... })` in prose and a brace
      inside a string are not scanned. Only a spread that **reads a condition** is refused (a
      ternary, `&&`, `||`, `??`); a call is allowed, because loading yields exactly the routes
      it returns — `...metadataRoutes(config, resource)` is how `@spfn/mcp` composes its
      router. A conditional spread inside an imported module, a router built by a factory, a
      condition hoisted to a variable before the spread and a `.packages()` list assembled
      conditionally are past what it can see; `NODE_ENV` pinning is the defence for those.
    - **An app route that collides with a route from a package publishing a route map is
      refused.** Both register at runtime and the app's proxy merges
      `{ ...routeMap, ...authRouteMap }`, so the *package* wins the name: an app defining its
      own `logout` with `@spfn/auth` mounted got a typed client claiming `api.logout` was its
      route while every call went to `POST /_auth/logout`. Package routes are still never
      emitted, and two packages sharing a name is not refused — the app's merge order decides
      that one. **The ops surface is not checked**: `createOpsRouter` publishes no route map
      for anything to merge and `spfn ops` invokes a command over the URL its manifest gave,
      so an app route named after an ops command overwrites nothing. `Router` carries
      `_publishesRouteMap` to say which is which, and a package that does publish a map is
      checked as before.
    - **A route module must now import without side effects** on `spfn build` and
      `spfn codegen run`, not only under the contract generator. A module-scope read of a
      required environment value, or a connection opened at import, turns a working build
      into a failing one — the error says so and names the file. All three examples load
      with an empty environment and regenerate byte-identical maps.
    - **`compilerOptions.paths` is read from the nearest `tsconfig.json` that declares them**
      — searched from the router file's own directory up to the project root, `extends` chains
      included — and handed to jiti, because jiti resolves a path alias only through its own
      `alias` option. Without this, the `@/*` alias `spfn init` writes into every app — and
      which the scaffold documents as the idiom — could not be resolved while the router
      loaded, so an app with one `@/` import anywhere in its route graph could not generate a
      map at all. The scaffold puts that alias in **`src/server/tsconfig.json`** (with
      `baseUrl: "../.."`, which is honoured), the config `spfn build` itself compiles with, so
      reading only the root config left a backend-only app unable to generate anything. The
      search stops at the project root, and a config declaring no `paths` is passed over
      rather than ending it. An import that still does not resolve now names the specifier
      instead of advising about module-scope side effects. The contract generator gets the
      same resolution. Several targets for one pattern resolve through the first that exists,
      as tsc and tsup resolve them; an `extends` target TypeScript cannot read is warned about
      rather than silently dropping every `paths` entry; a pattern whose `*` is not a trailing
      `/*` is skipped with a warning; and a wildcard is keyed with its trailing slash
      (`@x/*` → `@x/`) so an exact mapping of the same prefix survives beside it.
    - **`NODE_ENV` is pinned to `production` when the shell left it unset**, as the contract
      generator already did, and the pin is now shared by both. It is process-wide, so
      whichever generator ran first used to decide what the other one loaded: the same repo and
      the same command produced two different maps depending on the order `.spfnrc.ts` listed
      them.
    - `additionalRouteDirs` is **deprecated and ignored**. The loaded router reaches every
      route through its own imports, so there are no extra directories to scan. It is still
      accepted, and still contributes its `${dir}/**/*.ts` pattern to `watchPatterns`, so an
      existing `.spfnrc.ts` keeps working unchanged.
    - A path carrying a line terminator, a quote or a backslash, and a route named `__proto__`,
      are now emitted so the generated file parses and the map keeps every route as an own
      property. A path outside plain ASCII is emitted double-quoted (`JSON.stringify`); every
      realistic path is written exactly as before, and the repo's committed maps regenerate
      byte-identically apart from the reordering below.
    - `packages/auth`'s committed route map is regenerated on this change: same 89 routes, now
      in the order `defineRouter({…})` declares them, which is the order `registerRoutes`
      registers them in.
    - **TypeScript is loaded when a router is read, not when `@spfn/core/codegen` is
      imported.** The compiler is what reads a tsconfig's `paths` and the router's own source,
      and a top-level import of it cost every consumer of that entry ~0.3s and ~70MB —
      `spfn dev` startup, the watcher child, every `.spfnrc.ts` evaluation and
      `spfn codegen list`, none of which resolve an alias or parse a router.


## [@spfn/core@0.3.0-beta.4, @spfn/auth@0.3.0-beta.4] - 2026-08-10

### Added

#### @spfn/core

- `GET /_core/time` (`core.time`) exposes the server's Unix epoch milliseconds as an
  unauthenticated, session-free, non-cacheable built-in capability. It is registered before
  application middleware and routes, and the strict proxy guard excludes it.

#### @spfn/auth

- Mobile contract 0.9.0 imports `core.time` as the prerequisite for process-first
  `clientProofV1` clock synchronization. A client fails closed when synchronization is
  unavailable; the strict `0..300000ms` proof-age window and nonce-on-admission rule are
  unchanged and exported with their four finite boundary cases.

### Changed

#### @spfn/auth

- The `@spfn/core` peer floor is now `>=0.3.0-beta.4`, the first release containing the
  `CORE_TIME_*` exports loaded by `@spfn/auth/client-proof`. Older core prereleases are no
  longer advertised as compatible.

## [@spfn/core@0.3.0-beta.3, spfn@0.3.0-beta.3, @spfn/auth@0.3.0-beta.3] - 2026-08-09

세 가지 breaking change 가 함께 나간다. 배포 전에 아래 두 문서를 먼저 읽는 것이 좋다:

- health 엔드포인트 이전: [`docs/guides/migration/health-endpoint.md`](docs/guides/migration/health-endpoint.md)
- 포트·호스트 3층 정리와 `PORT`·`HOST` 제거: 아래 항목과 [`ENV_VARIABLES.md`](ENV_VARIABLES.md)

가장 눈에 띄는 것은 `@spfn/auth` 의 쿠키 이름 접미사다. `PORT` 를 설정해 두던 앱은 **기존 세션이 전부 끊긴다.** 다시 로그인하면 복구되지만, 배포 시점을 고를 때 알고 있어야 한다.

`spfn` CLI 는 `@spfn/core/app-config` 를 쓰므로 core 하한이 `>=0.3.0-beta.3` 으로 올랐다. 나머지 `@spfn/*` 패키지는 범위(`>=0.3.0-beta.1 <0.4.0`)가 이미 이 버전을 포함해 손대지 않았다.

### Changed

#### @spfn/core

- **BREAKING: 내장 health 엔드포인트가 `/_core/health` 로 옮겨가고, `/health` 는 더 이상 등록되지 않는다.** `/_core/` 는 `@spfn/core` 소유이고 그 안의 경로는 앱 라우트보다 먼저 등록돼 앱이 가져갈 수 없다. readiness probe·Dockerfile `HEALTHCHECK`·업타임 모니터·로드밸런서는 여기를 가리켜야 한다 — 앱이 무엇을 선언하든 답이 바뀌지 않는 유일한 주소다. `/_auth/`·`/_ops/` 와 같은 규칙이고, 그 두 곳에는 가려짐 결함이 한 번도 없었다.
    - **마이그레이션**: [`docs/guides/migration/health-endpoint.md`](docs/guides/migration/health-endpoint.md). probe 경로를 `/_core/health` 로 옮기는 것이 기본이고, 경로를 바꿀 수 없는 배포는 `.healthCheck({ path: '/health' })` 로 옛 주소를 되살린다.
    - `/health` 로 오는 `GET` 은 **한 릴리스 동안 410** 과 새 주소를 답하고, 첫 요청에 서버가 경고를 한 번 남긴다. readiness probe 실패는 운영자에게 응답 본문도 상태 문구도 보여주지 않아서, 404 하나로는 검색할 단서가 남지 않는다. 다음 릴리스에서 제거된다.
    - 앱이 `GET /health` 를 선언했다면 안내는 나가지 않는다. 그 경로는 이제 앱 것이다.
    - `healthCheck.enabled: false` 인 앱은 안내도 받지 않는다. 그 설정에서는 예전에도 `/health` 가 404 였으니 옮겨간 것이 없다.
  - `CORE_NAMESPACE`·`CORE_HEALTH_PATH`·`LEGACY_HEALTH_PATH` 를 `@spfn/core/server` 에서 내보낸다.
  - **`healthCheck.path` 는 이제 명시적 opt-in 이고 기본값이 없다.** 설정하면 `/_core/health` 와 **함께** 답하는 두번째 주소가 열린다. 옮기는 것이 아니다. 예전에는 이 값이 `/health` 로 기본 설정돼 앱이 그 경로에 선언한 라우트를 통째로 삼켰다.
  - **내장 주소는 전부 `lifecycle.beforeRoutes` 훅보다 먼저 등록된다.** Hono 미들웨어는 자기 뒤에 등록된 핸들러만 감싸므로, 앱이 그 훅에서 추가한 전역 인증 가드가 probe 를 막지 못한다. 훅의 문서화된 용도가 바로 `app.use('/*', globalMiddleware())` 다.
  - 설정한 `path` 에 앱 라우트가 겹치면 그 라우트가 실행되지 않는다고 warn 한다. 앱 라우트가 `/_core/` 안에 있을 때도 같다.
  - **프록시 가드가 health 경로 전부를 자동 예외에 넣는다.** 넣지 않으면 strict 모드에서 probe 가 403 을 받는다 — probe 는 RPC 프록시를 지나지 않아 서명이 없다. 파드가 rotation 에 들어가지 못하면서 이유를 아무도 말해주지 않는 실패다. `/health` 안내도 예외에 들어간다. 막히면 운영자가 410 을 읽지 못한다.
  - `RequestLogger` 기본 `excludePaths` 에 `/_core/health` 를 넣었다. 없으면 probe 주기마다 로그 한 줄이 쌓인다.
  - 부팅 배너가 답하는 경로를 함께 보고한다(`healthCheck.corePath`, 설정 시 `healthCheck.path`).
  - 예제 02·03 과 CLI 스캐폴드의 Dockerfile `HEALTHCHECK`, root 응답 안내가 `/_core/health` 를 가리킨다.
#### @spfn/core · spfn (CLI) · @spfn/auth

- **BREAKING: 포트·호스트 설정이 3층으로 정리됐다** — 환경변수 · `spfn.config.js` · 기본값. 그 이상은 없다.

  ```
  SPFN_PORT > spfn.config.js ports.server > 8790
  NEXT_PORT > spfn.config.js ports.next   > 3790
  SPFN_HOST > spfn.config.js host         > localhost
  ```

  기본값은 `@spfn/core/app-config` 한 곳에만 존재한다. 이게 이 형태의 핵심이다. 입력 층(CLI 옵션·생성된 엔트리·env 스키마)에 둔 기본값은 누가 실제로 준 값과 구분되지 않아 아래 층을 조용히 덮는다. 이 저장소에서 그 원인으로 결함 3개가 나왔다.

  - **`PORT`·`HOST` 를 core env 스키마에서 제거.** 기본값 4000·localhost 때문에 `env.PORT` 가 절대 undefined 가 아니었고, 그래서 해석 순서에서 환경변수를 맨 뒤에 둘 수밖에 없었다. 주입된 포트가 닿지 못한 이유가 이것이다. `PORT` 는 Next.js 자신의 변수이기도 하다.
  - **이름이 2개인 이유**: 프로세스가 2개다. `NEXT_PORT` 는 Next.js, `SPFN_PORT` 는 SPFN API 서버.
  - **`spfn.config.js` 를 실제로 읽는다.** `spfn init` 이 만들어 커밋해 왔지만 지금까지 아무도 읽지 않던 파일이다. 두 포트가 한 곳에 나란히 있으므로, 앱이 포트를 바꿀 때 고칠 곳이 한 군데다. 그 전에는 `examples/03-auth` 가 같은 숫자를 7개 파일에 적어두고 손으로 맞췄다.
  - **`ServerConfig.port()`·`.host()` 폐기.** 한 릴리스 동안 `spfn.config.js` 와 기본값 사이에서 계속 동작하고, 부팅 시 경고한다.
  - **`spfn dev --routes` 제거** — `@spfn/core` 가 읽지 않던 죽은 옵션.
  - **`@spfn/auth` 의 쿠키 이름 접미사가 `PORT` 대신 `SPFN_PORT` 를 쓴다.** `PORT` 를 설정해 두던 앱은 쿠키 이름이 바뀌어 **기존 세션이 끊긴다.** 다시 로그인하면 된다.
  - 스캐폴드 `Dockerfile` 의 HEALTHCHECK 와 compose 의 포트 매핑이 `SPFN_PORT`·`NEXT_PORT` 를 따른다. Docker 는 `spfn.config.js` 를 읽지 못하므로 두 파일만 같은 기본값을 예비로 갖는다.
  - **`examples/03-auth` 의 Next 포트 불일치 수정.** `spfn.config.js` 는 `ports.next: 3890` 인데 Dockerfile 은 3790 을 열고 compose 도 3790 을 매핑하고 있었다. `spfn start` 가 이제 선언된 값을 넘기므로, 컨테이너 안에서는 3890 에 뜨고 밖으로 열린 것은 3790 이라 프로덕션 compose 로 띄우면 프론트엔드에 닿을 수 없었다. Docker 가 읽지 못하는 숫자가 어긋나도 부팅은 성공하는 종류의 결함이라, 파일 간 숫자를 직접 비교하는 검사(`app-config/__tests__/deployment-files-agree.test.ts`)로 고정했다. 스캐폴드가 만드는 `spfn.config.js` 도 같은 검사가 덮는다.
  - **`spfn.config.js` 를 불러오지 못하면 경고한다.** 있는데 import 가 실패하는 것은 오타이지 부재가 아니다. 조용히 기본값으로 떨어지면 앱이 지정한 포트 대신 8790 에 뜨고, 증상은 아무도 고르지 않은 포트 하나뿐이다. 부팅은 여전히 막지 않는다.

#### @spfn/core · spfn (CLI)

- **BREAKING: `.env.server.local` 폐지** — 서버 전용 환경변수를 `.env.server` 단일 파일로 통합. `.env.server`는 이제 gitignored(시크릿 포함)이며, committed 템플릿은 `.env.server.example`을 사용. 서버 시크릿을 `.env.server.local`에 두던 프로젝트는 `.env.server`로 이전해야 함(둘 다 gitignored).
  - `@spfn/core`: env loader가 server 레이어에서 `.env.server`만 로드(`.env.server.local` 제거). loader 로딩 규칙 단위 테스트 추가.
  - `spfn` (CLI): `create`/`init`이 `.env.server.local.example`을 생성하지 않고 `.gitignore`에 `.env.server`를 추가. `env:init` 및 런타임 로딩에서도 `.env.server.local` 제거.

### Added

#### 저장소

- **풀 리퀘스트에 기계 검사가 생겼다** (`.woodpecker/pr.yml`) — 그 전에는 하나도 없었다. GitHub 쪽 두 워크플로가 `pull_request` 트리거를 선언하고 있지만, PR 은 Gitea 에 열리고 GitHub 는 미러라 그 트리거는 발화하지 않는다. 실제로 도는 것은 main push 뿐이라 **병합 뒤** 검사다. 이제 PR 에서 `pnpm build` · `lint` · `type-check` · `check:versions` · `check:exports` 와 예제 부팅 스모크가 돈다.
  - **예제가 처음으로 CI 에 들어왔다.** `examples/01·02·03` 에 `type-check` 스크립트가 없어 turbo 가 닿지 못했다. `next build` 는 프론트엔드만 컴파일하고 SPFN 서버는 건드리지 않는다. 그래서 부팅조차 못 하는 예제가 main 에 남아 있었다(issue #119).
  - `scripts/smoke-example-01.mjs` 가 예제 01 을 실제로 띄워 `GET /greeting`·`GET /health` 응답과 가려짐 경고 부재를 확인한다. DB·캐시·시크릿이 필요 없어 모든 PR 에서 돌릴 수 있다. 이 스크립트는 첫 실행에서 프로덕션 설정 로딩 결함을 잡았다.
  - **`pnpm test` 도 게이트에서 돈다.** PostgreSQL 과 Redis 4대를 test 스텝 컨테이너 안에서 `scripts/test-services.sh` 로 띄운다. Woodpecker `services` 를 쓰지 않는 이유는 테스트 쪽에 있다 — 캐시 통합 스위트가 `redis://localhost:6479`~`:6482` 를 env 오버라이드 없이 하드코딩하고 있어, 자기 호스트명을 받는 service 컨테이너로는 닿지 못한다. 전부 localhost 에 두면 CI 가 로컬 스크립트를 그대로 호출할 수 있어 로컬과 CI 가 어긋나지 않는다.
  - 검사는 두 스텝으로 나뉜다. lint 오류가 전체 스위트를 기다리지 않고 1분 안에 보고되게 하려는 것이다. 스텝은 워크스페이스 볼륨을 공유하므로 `verify` 가 만든 `dist/` 는 `test` 에서도 그대로 있다.
- **`pnpm setup:examples`** (`scripts/seed-example-env.mjs`) — 예제마다 커밋된 `.env.local.example` 을 `.env.local` 로 복사한다. 이미 있는 `.env.local` 은 건드리지 않는다.
  - **새로 클론한 저장소는 `pnpm build` 가 실패했다.** 루트 빌드가 예제까지 닿고, 예제의 `next build` 가 페이지 데이터를 수집하면서 환경변수를 검증하는데 거기서 `SPFN_API_URL` 이 필수다. 그 값은 gitignore 대상인 `.env.local` 에만 있었다. 파일 하나가 없어서 `01-minimal-api` 빌드가 깨지고, turbo 가 남은 빌드를 취소하고, `@spfn/auth` 의 `dist/` 가 생기지 않고, auth 테스트 46개 파일 중 34개가 `Cannot find package '@spfn/auth/config'` 로 실패했다. AGENTS.md 가 안내하는 검증 명령이 새 클론에서 돌지 않았다는 뜻이다.

### Fixed

#### 저장소

- **PR 게이트의 파드가 자원을 아무것도 요청하지 않고 있었다** — Woodpecker 는 Kubernetes 백엔드로 돌고, 에이전트 설정에도 `.woodpecker/pr.yml` 에도 스텝 파드의 요청·한도가 없었다. Kubernetes 에서 그것은 BestEffort 등급이다. 경합하면 CPU 를 최소한만 받고, 노드 메모리가 모자라면 가장 먼저 종료된다. 같은 커밋에서 두 증상이 다 나왔다 — 한 번은 website 정적 생성이 페이지마다 60초 제한을 넘겨 실패했고, 다음 실행은 오류 한 줄 없이 빌드 도중 죽었다. 같은 빌드가 노트북에서는 28초다. 느린 코드가 있었던 게 아니라 파드가 아무것도 요구하지 않았다. 두 스텝에 요청 `cpu 2`·`memory 4Gi`, 한도 `cpu 4`·`memory 7Gi` 를 주고 전용 빌드 노드풀(`role: build`, taint 가 있어 toleration 도 함께)로 보낸다. 통과했던 초기 실행들은 노드가 한가했던 것뿐이라 운에 기대고 있었다.

- **예제 01·02 의 `.env.local.example` 이 커밋되지 않고 있었다** — 각 예제의 `.gitignore` 가 `.env*` 를 걸어두고 예외를 주지 않았다(`examples/01-minimal-api/.gitignore:22`, `examples/02-database-crud/.gitignore:37`). 예제 03 만 `!.env.local.example` 예외가 있었다. 그래서 저장소를 클론한 채택자는 두 예제의 env 템플릿을 받지 못했고, "`*.example` env 파일만 커밋된다" 는 규칙이 두 예제에서 지켜지지 않았다. 두 템플릿에는 localhost 자리표시자만 들어 있다.
- **`pnpm type-check` 가 main 에서 에러로 끝났다** — `turbo.json` 에 `type-check` 태스크 선언이 없어 `Could not find task 'type-check' in project` 로 실패했다. AGENTS.md 가 안내하는 명령이다. 선언을 추가했다.

#### @spfn/core

- **DB 없는 서버의 health가 더 이상 503을 답하지 않음** — `.infrastructure({ database: false })`로 끈 구성 요소를 health 상세 응답이 `disabled`로 보고하고 전체 상태를 낮추지 않는다. 그 전에는 의도적으로 없는 DB가 `not_initialized`로 실패에 세어져, DB를 쓰지 않는 서버의 readiness probe가 영영 통과하지 못했다. `redis`도 같다.
  - 응답 문자열이 바뀐다: 껐을 때 `not_initialized` → `disabled`. health 페이로드를 문자열로 판정하는 곳이 있으면 확인 필요.
- **내장 health 경로와 겹치는 앱 라우트를 부팅 시 경고** — 내장 health 엔드포인트는 앱 라우트보다 먼저 등록되므로 같은 경로의 앱 라우트는 실행되지 않는다. 이제 라우트 이름과 경로를 지목해 경고한다. 조용히 가려지는 탓에 examples 01·02·03이 실행되지 않는 `/health` 라우트를 배포하고 있었다(제거함).
- `ServerConfig.infrastructure`의 `@default true if DATABASE_URL exists` 주석이 실제 동작과 달랐다. 자격증명을 살피지 않고 항상 초기화하므로 DB를 쓰지 않는 서버는 `false`를 선언해야 한다(issue #119).
- **프로덕션 서버가 앱의 `server.config`를 실제로 읽는다** — `spfn build`가 만드는 컴파일 결과의 확장자는 tsup이 앱 `package.json`을 보고 정한다. `"type": "module"`이면 `.js`, 아니면 `.mjs`다. 찾는 목록에 `.mjs`만 있어서, 그 필드를 선언한 앱은 프로덕션에서 **설정 전체를 잃었다** — 미들웨어·라우트·인프라 스위치가 모두 사라지고 기본값으로 떴다. 원본 `src/server/server.config.ts`가 마지막 후보로 남아 있었지만 순수 node는 TypeScript도 `@/` 별칭도 해석하지 못해 대신할 수 없었다. 이제 두 확장자를 모두 찾는다.
- **설정을 못 읽었으면 경고한다** — `src/server/server.config.ts`가 있는데 아무 설정도 로드되지 않았다면 warn으로 알린다. 그 전에는 debug 레벨이라 프로덕션에서 보이지 않았고, 서버는 조용히 뜬 뒤 없는 미들웨어·없는 라우트로 동작했다.

#### spfn (CLI)

- **스캐폴드가 만들던 `/health` 라우트 제거** — 내장 health 엔드포인트가 앱 라우트보다 먼저 등록되므로 이 라우트는 처음부터 실행된 적이 없었다. 새 앱은 이제 부팅 시 가려짐 경고 없이 뜨고, `GET /health`는 DB·Redis·마이그레이션 상태까지 담은 내장 응답이 답한다. Dockerfile의 HEALTHCHECK와 root 응답의 `/health` 안내는 그대로 유효하다.
- **프로덕션 엔트리가 앱이 정한 포트를 따른다** — `.spfn/prod-server.mjs`가 포트를 `env.SPFN_PORT`에서 읽었는데 core의 env 스키마에 그 키가 없어 **항상 undefined**였다. 결과적으로 모든 프로덕션 서버가 하드코딩된 8790에 붙었다. `examples/03-auth`는 자기 설정에 8890을 적어두고도 8890을 받은 적이 없다. 이제 `process.env`에서 읽고, 주입된 값이 없으면 앱의 `server.config`가 결정한다. `SPFN_HOST`도 같다.
  - `spfn start`의 `-p`·`-h`에 있던 commander 기본값(`8790`·`0.0.0.0`)도 걷어냈다. 기본값은 운영자가 입력한 값과 구분되지 않은 채 그대로 `SPFN_PORT`로 전달돼, 플래그를 쓰지 않아도 앱 설정을 덮었다. 이제 플래그를 준 경우에만 전달한다. Dockerfile의 `CMD ["pnpm", "run", "spfn:start"]`가 지나는 경로가 바로 여기다.
  - 주소를 알리던 `spfn start`의 로그 두 줄을 걷어냈다. 플래그가 없으면 이 프로세스는 어느 주소에 붙을지 모른다. 실제 주소는 서버가 자기 배너로 알린다.
  - 동작 변화: `server.config`에 `.port()`를 적지 않은 앱은 이제 8790이 아니라 core 기본값을 쓴다. 스캐폴드 템플릿과 모든 예제는 포트를 명시하므로 영향이 없다.
- **`spfn build`가 확장자를 고정한다** — tsup `outExtension`을 `.mjs`로 지정해 앱 `package.json`의 암묵적 규칙에 기대지 않는다.
- 프로덕션 엔트리가 넘기던 `routesPath` 제거 — `@spfn/core`가 읽지 않는 죽은 옵션이라, 엔트리가 라우트를 연결하는 것처럼 보이게 했다. 라우트는 앱의 `server.config`가 등록한다.
- 스캐폴드 example 템플릿 결함 제거: `getExample`의 테스트용 헤더 강제 validation·디버그 로그, root 응답의 미등록 `/teams` 참조.
- `.gitignore`에 `.env.server`가 누락될 수 있던 분기 수정(독립 체크로 분리).
- type-check 미사용 심볼 정리(에러 0).
- **db 파괴 명령 안전 가드**: `drop`/`restore`가 대상 DB(name@host:port)를 표시하고, 원격/프로덕션 DB면 이름 재입력을 요구. `restore --drop`이 `--clean`에 `--if-exists`를 동반하고, plain SQL 경로에서 `--drop` 무시 시 경고. `db clean`이 `.meta.json` 사이드카도 함께 삭제.
- `init` 멱등성: 기존 RPC 프록시 라우트 발견 시 init 전체를 중단(`process.exit(1)`)하지 않고 skip.
- 스캐폴드 `Dockerfile`이 프로젝트의 패키지 매니저(npm/yarn/bun/pnpm)에 맞게 생성되도록 수정(기존 pnpm 하드코딩). base 이미지 node 20→22.
- `spfn start` both 모드가 `concurrently`를 `shell:true`·수동 따옴표 없이 호출하도록 수정(공백 포함 경로 대응).

### Removed

#### spfn (CLI)

- **BREAKING: `spfn generate` / `spfn g fn` 명령 제거** — 폐기된 contract-first 아키텍처(`createApp`/`createContract`/`createFunctionSchema`, 현행 core에서 제거됨)를 스캐폴드해 산출물이 컴파일 불가였음. 실제 `@spfn` 패키지는 route DSL을 사용하고 generate fn 구조(`lib/contracts`)를 쓰지 않음. 향후 필요 시 현행 패턴으로 신규 작성.
- 죽은 `.guide` 참조 제거: `create` 안내 메시지, `sync:guides` 스크립트, RELEASE 체크리스트 항목, stale 빌드 잔재(`copy-templates`에 `emptyDirSync` 추가로 재발 방지).
- generate 죽은 자산 제거: `generateInitMigration`+`init-migration.template`, `validation.ts`, 고아 `templates/config/`, 참조 없는 `Dockerfile.optimized`.

## [0.1.0-alpha.85] - 2025-11-07

### Added

#### @spfn/core

- **Plugin System**: New plugin discovery system for automatic package initialization
  - Auto-discovers `plugin.ts` files from `@spfn/*` packages in node_modules
  - `ServerPlugin` interface with lifecycle hooks (afterInfrastructure, beforeRoutes, afterRoutes, afterStart, beforeShutdown)
  - Plugins can automatically initialize services, mount routes, and hook into server lifecycle
  - Enables packages like `@spfn/auth` to self-configure without manual setup
  - See [API Reference - Server Plugins](/docs/api-reference/server.md#plugins)

## [@spfn/auth@0.1.0-alpha.1] - 2025-11-07

### Added

#### @spfn/auth

- **Invitation System**: New invitation-based user registration system
  - Create invitations with expiry dates and usage limits
  - Accept invitations to create accounts
  - List and manage invitations
  - Support for role assignment via invitations
  - See [Auth Package Documentation](/packages/auth/README.md#invitation-system)

- **Plugin System Support**: Package now exports plugin configuration
  - Auto-discovery of routes via SPFN plugin system
  - Automatic database schema registration
  - Configurable route prefix and base path

### Changed

#### @spfn/auth

- **Environment Variables**: Updated to use `SPFN_AUTH_*` prefix for better namespacing
  - `SPFN_AUTH_JWT_SECRET` (was `JWT_SECRET`)
  - `SPFN_AUTH_JWT_EXPIRES_IN` (was `JWT_EXPIRES_IN`)
  - `SPFN_AUTH_VERIFICATION_TOKEN_SECRET` (was `VERIFICATION_TOKEN_SECRET`)
  - `SPFN_AUTH_BCRYPT_SALT_ROUNDS` (was `BCRYPT_SALT_ROUNDS`)
  - `SPFN_AUTH_SESSION_SECRET` (was `SESSION_SECRET`)
  - `SPFN_AUTH_ADMIN_ACCOUNTS` (was `ADMIN_ACCOUNTS`)
  - Legacy variable names still supported for backward compatibility
  - See [Environment Variables Documentation](/packages/auth/README.md#which-environment-variables-do-i-need)

- **Routes Structure**: Reorganized routes into modular structure
  - `/auth/*` routes for authentication operations
  - `/invitations/*` routes for invitation management
  - Better separation of concerns and maintainability

## [0.1.0-alpha.84] - 2025-11-06

### Added

#### spfn (CLI)

- **Database Sync Command**: New `spfn db sync` command for environment synchronization
  - Sync databases between local and remote environments (dev, staging, production)
  - Automatic backup of target database before sync (mandatory, cannot be skipped)
  - Production protection requiring explicit `--force` flag for safety
  - Table filtering support with `--tables` and `--exclude-tables` options
  - Bidirectional sync with `--pull` flag (reverse direction)
  - Dry-run mode with `--dry-run` for previewing changes
  - Environment configuration via `SPFN_DB_*` environment variables
  - Full replacement strategy for predictable results
  - See [CLI Reference - Database Sync](/docs/api-reference/cli.md#spfn-db-sync)

#### @spfn/core

- **Event System**: New event-driven architecture with type-safe event emitter
  - Memory adapter for lightweight in-process events
  - Type-safe event definitions with TypeScript generics
  - Support for async event handlers with automatic error handling
  - `waitFor()` method for promise-based event waiting
  - `once()` method for one-time event handlers
  - Automatic cleanup and memory management
  - Foundation for future distributed event adapters (Redis, NATS)
  - See [API Reference - Events](/docs/api-reference/events.md)

## [0.1.0-alpha.83] - 2025-11-06

### Added

#### @spfn/core

- **Server Lifecycle Hooks**: New comprehensive lifecycle hook system for server initialization and shutdown
  - `lifecycle.beforeInfrastructure`: Execute before database and Redis initialization
  - `lifecycle.afterInfrastructure`: Execute after infrastructure is ready
  - `lifecycle.beforeRoutes`: Execute before routes are registered (moved from top-level)
  - `lifecycle.afterRoutes`: Execute after routes are registered (moved from top-level)
  - `lifecycle.afterStart`: Execute after server starts listening
  - `lifecycle.beforeShutdown`: Execute before graceful shutdown
  - All hooks properly integrated with server startup sequence
  - See [API Reference - Server Lifecycle](/docs/api-reference/app.md#lifecycle-hooks)

- **Infrastructure Control**: New configuration options for database and Redis initialization
  - `infrastructure.database`: Control automatic database initialization (default: true)
  - `infrastructure.redis`: Control automatic Redis initialization (default: true)
  - Useful for custom infrastructure setup in lifecycle hooks
  - See [API Reference - Infrastructure Control](/docs/api-reference/app.md#infrastructure-control)

- **Logger API Documentation**: Comprehensive documentation for the logger module
  - Complete API reference with all methods and types
  - Configuration guide for environment variables
  - Transport configuration (Console, File)
  - Sensitive data masking documentation
  - Best practices and troubleshooting guide
  - See [API Reference - Logger](/docs/api-reference/logger.md)

### Changed

#### @spfn/core

- **Logger Architecture Refactored**: Simplified from adapter-based to transport-only architecture
  - Removed adapter layer (`adapter-factory.ts`, `adapters/` directory)
  - Simplified to direct logger → transport flow
  - Removed pino and pino-pretty dependencies (344 dependencies reduced)
  - Created new `factory.ts` for transport-based initialization
  - Bundle size reduced by 17% for logger module, 4% for core package
  - All 153 logger tests passing

- **Lifecycle Hooks Consolidated**: `beforeRoutes` and `afterRoutes` moved into `lifecycle` object
  - **Breaking Change**: Top-level `beforeRoutes` and `afterRoutes` are now deprecated
  - Use `lifecycle.beforeRoutes` and `lifecycle.afterRoutes` instead
  - Updated `create-server.ts` to reference new paths
  - More consistent API design with all lifecycle hooks in one place

### Fixed

#### @spfn/core

- **Memory Leak Warnings**: Resolved MaxListenersExceeded warnings in development
  - Added `process.setMaxListeners(15)` in shutdown handler registration
  - Prevents warnings when using hot reload with tsx --watch
  - Handles multiple process event listeners properly

- **Thread-Stream Module Resolution**: Fixed persistent module resolution errors
  - Removed pino-pretty to eliminate worker thread issues with tsx --watch
  - Custom logger now uses built-in ANSI color codes
  - Cleaner development experience without module resolution errors

## [0.1.0-alpha.82] - 2025-11-05

### Added

#### spfn (CLI)

- **Database Backup System Enhancements**: Major improvements to backup/restore functionality
  - **Backup Metadata Tracking**: Automatically collects and saves metadata for each backup
    - Git information (commit hash, branch, tag, dirty status)
    - Migration version (last applied migration, count, hash)
    - Environment labels and custom tags
    - Metadata saved as `.meta.json` files alongside backups
  - **Selective Backup Options**: New flags for granular backup control
    - `--data-only`: Backup data without schema
    - `--schema-only`: Backup schema without data
    - `--tag <tags>`: Add comma-separated tags to backups
    - `--env <environment>`: Label backup environment (production, staging, etc.)
  - **Version Compatibility Warnings**: Restore command now displays metadata and warnings
    - Shows backup database, creation date, environment, and tags
    - Detects Git commit/branch mismatches between backup and current state
    - Warns about migration version differences before restore
    - Helps prevent accidental data loss from incompatible backups
  - **Auto-Backup on Migrate**: New `--with-backup` flag for `spfn db migrate`
    - Automatically creates pre-migration backup before applying migrations
    - Uses compressed custom format for smaller file size
    - Tagged as "pre-migration" for easy identification
  - **Enhanced Security**: Backup commands now auto-update `.gitignore`
    - Adds `backups/` to project root `.gitignore`
    - Adds `*.meta.json` to `backups/.gitignore`
    - Prevents accidental commits of sensitive backup files

#### @spfn/core

- **Types Package**: New `@spfn/core/types` export for pure type definitions
  - Extracted API response types and schemas to dedicated types package
  - Includes `ErrorResponse`, `ApiSuccessResponse`, `ApiErrorResponse`, `ApiResponse`
  - Includes TypeBox schema helpers: `ApiSuccessSchema`, `ApiErrorSchema`, `ApiResponseSchema`
  - Safe to use in both server and client code
  - Better tree-shaking potential

### Changed

#### @spfn/core

- **API Response Types Refactoring**: Reorganized type definitions for better modularity
  - Moved API response types from `route/api-response.ts` to `types/api-response.ts`
  - Updated error-handler to import `ErrorResponse` from `@spfn/core/types`
  - Deprecated `route/api-response.ts` (re-exports from types for backwards compatibility)
  - Added `pino-pretty` as optional dependency for improved logging

### Fixed

#### spfn (CLI)

- **Backup Options Validation**: Added validation to prevent conflicting options
  - Backup and restore commands now reject `--data-only` and `--schema-only` used together
  - Clear error messages guide users to correct usage

## [0.1.0-alpha.81] - 2025-11-05

### Fixed

#### @spfn/core

- **Code Generation**: Removed `.js` extension from generated TypeScript import paths in contract client
  - Changed type export paths from `./${kebabName}.js` to `./${kebabName}`
  - Changed function import paths from `./${kebabName}.js` to `./${kebabName}`
  - Improves compatibility with TypeScript module resolution

## [0.1.0-alpha.80] - 2025-11-04

### Changed

#### @spfn/cms

- **API Route Parameter Naming**: Standardized route parameters to follow RESTful conventions
  - Changed route parameter from `:labelId` to `:id` in all label detail endpoints
  - Updated paths: `/_cms/labels/:id/publish`, `/_cms/labels/:id/admin`, `/_cms/labels/:id/versions`
  - Updated all contracts to use `id` instead of `labelId` in params
  - Reorganized route files from `labels/[labelId]/` to `labels/[id]/` directory structure

- **Labels List API Simplification**: Removed pagination from labels list endpoint
  - Removed `limit` and `offset` query parameters from `getLabelsContract`
  - Removed `limit` and `offset` fields from response
  - Returns all labels without pagination for simpler client implementation

### Fixed

#### @spfn/cms

- **Test Organization**: Split monolithic test file into separate test files by feature
  - Created `labels-admin.test.ts` for admin endpoint tests
  - Created `labels-publish.test.ts` for publish workflow tests
  - Created `labels-versions.test.ts` for version history tests
  - Improved test maintainability and discoverability

## [0.1.0-alpha.79] - 2025-11-04

### Changed

#### @spfn/cms

- **Locale Naming Improvements**: Clarified naming distinction between project locales and system locales
  - Renamed `CmsConfig.supportedLocales` to `CmsConfig.locales` (kept deprecated `supportedLocales` for backward compatibility)
  - Added `getAllLocales()` function to get system-available locales (50+ supported languages)
  - Deprecated `getSupportedLocales()` in favor of `getAllLocales()`
  - Updated `configureCms()` to accept both `locales` and `supportedLocales` parameters with automatic synchronization
  - Updated all internal usages from `config.supportedLocales` to `config.locales`
  - **New naming convention**: `configureCms({ locales: ['en', 'ko'] })` for project-active locales, `getAllLocales()` for system-available locales

### Fixed

#### @spfn/cms

- **Label Type Sync Bug**: Fixed label type field not being preserved during sync operations
  - Fixed `flattenLabels()` in `helpers.ts` to include `type` field in flattened results
  - Fixed `syncSection()` in `sync.ts` to update `type` field in database
  - Fixed change detection to recognize type changes (e.g., text → image)
  - Label types (text, image, video, file, object) now correctly synced from JSON to database

## [0.1.0-alpha.78] - 2025-11-03

### Fixed

#### @spfn/cms

- **Translation Function Object Support**: Fixed `t()` function to handle object-type label values
  - Added automatic `content` field extraction from object values (e.g., `{ type: "text", content: "..." }`)
  - Applied to both `getSection()` and `getSections()` functions
  - Now correctly renders labels that have structured object values instead of plain strings
  - Enables CMS to support rich label metadata while maintaining simple `t()` API

## [0.1.0-alpha.77] - 2025-11-03

### Fixed

#### @spfn/cms

- **Label Version History API**: Fixed to query from `cms_label_values` table directly
  - Changed from `cms_label_versions` (unused table) to `cms_label_values`
  - Queries published versions where `version IS NOT NULL`
  - Returns version history with values grouped by version number
  - Note: `publishedBy` and `notes` fields are null (not stored in label_values table)

## [0.1.0-alpha.76] - 2025-11-03

### Added

#### @spfn/cms

- **Label Version History API**: Added new API endpoint to fetch complete version history for labels
  - New contract: `getLabelVersionsContract` (GET /_cms/labels/:labelId/versions)
  - New route handler: `/labels/[labelId]/versions/index.ts` with DB query optimization
  - Auto-generated API client function: `getLabelVersions()`
  - Returns all published versions with metadata (publishedAt, publishedBy, notes) and values
  - Optimized single API call replaces multiple sequential calls for better performance
  - Version history sorted by version number (descending - newest first)

## [0.1.0-alpha.75] - 2025-11-03

### Added

#### @spfn/cms

- **Label Description Field**: Added `description` field support throughout CMS system
  - Added `description` column to `cms_labels` entity (nullable text field)
  - Updated all API contracts to include `description` field in responses
  - Updated all route handlers to return `description` field
  - Admin UI now displays label descriptions in label list and editor header
  - Descriptions shown below label keys for better context and usability

### Fixed

#### @spfn/cms

- Fixed TypeScript build errors related to missing `description` field in API responses
- Ensured consistent `description` field presence across all label-related endpoints

## [0.1.0-alpha.74] - 2025-11-03

### Added

#### @spfn/cms

- **Draft & Publish System (Phase 1)**: Implemented complete publish workflow for CMS labels
  - New contracts: `publishLabelContract` (POST /_cms/labels/:labelId/publish), `getAdminLabelContract` (GET /_cms/labels/:labelId/admin)
  - New helper functions: `publishLabel()` - converts Draft (version=null) to Published (version=number), `updatePublishedCache()` - regenerates cache for all locales
  - New API endpoints with full error handling and validation
  - Repository extension: `findDraftsByLabelId()` for querying draft values
  - Auto-generated API client functions: `publishLabel()`, `getAdminLabel()`
  - Status calculation: 'default-only', 'unpublished', 'published', 'modified'
  - Published cache regeneration with defaultValue fallback support

#### @spfn/core

- **Contract Scanner Logging**: Added debug logging to contract scanner for troubleshooting
  - New logger: `scannerLogger` with detailed contract extraction logs
  - Logs: contract file discovery, extraction progress, final mapping count
  - Helps diagnose codegen issues and contract detection problems

## [0.1.0-alpha.73] - 2025-11-03

### Fixed

#### @spfn/cms

- **ESM Import Compatibility**: Fixed missing `.js` extension in `next/headers` import in `locale.actions.ts`
  - Changed `import { cookies, headers } from 'next/headers'` to `import { cookies, headers } from 'next/headers.js'`
  - Ensures proper ESM module resolution in production builds

## [0.1.0-alpha.72] - 2025-11-03

### Added

#### @spfn/auth

- **Custom Error Classes**: Added comprehensive error handling system in `server/errors/auth-errors.ts`
  - New errors: `InvalidCredentials`, `AccountDisabled`, `AccountAlreadyExists`, `InvalidVerificationCode`, `InvalidToken`, `TokenExpired`, `KeyExpired`, etc.
  - Migrated from manual JSON responses to throwing typed errors

- **Email/SMS Verification System**: Implemented complete verification code flow
  - Added `verification_codes` entity and helper functions
  - New endpoints: `POST /_auth/codes` (send code), `POST /_auth/codes/verify` (verify code)
  - Verification tokens with 15-minute validity for registration flow
  - Support for registration, password reset, and email/phone change purposes

- **Auth Context Helpers**: Created type-safe context access system
  - New `AuthContext` interface grouping user, userId, keyId
  - Extended Hono's `ContextVariableMap` for type-safe context
  - Helper functions: `getAuth()`, `getUser()`, `getUserId()`, `getKeyId()`
  - Updated all routes to use type-safe helpers

- **Generated API Client**: Auto-generated type-safe client functions in `lib/api/`
  - Functions: `authExists()`, `authLogin()`, `authRegister()`, `authCodesVerify()`, etc.
  - Automatic contract-to-function conversion with proper naming

- **Integration Tests**: Added comprehensive test coverage
  - New integration tests for authenticate middleware (390 lines)
  - New unit tests for verification system (250 lines)

#### @spfn/cms

- **Draft System**: Implemented draft/published version system
  - `version: null` for drafts (mutable)
  - `version: number` for published versions (immutable)
  - Database migration 0002: Made version column nullable
  - Drafts can be overwritten, published versions are immutable

#### @spfn/core

- **Enhanced Error Handling**: Added new HTTP error classes
  - Better error serialization and HTTP status mapping
  - Integration with auth error system

- **API Response Helpers**: Added `c.success()` and `c.error()` helpers to RouteContext
  - Simplified error handling in route handlers
  - Better integration with error throwing pattern

- **Route Binding**: New `bind.ts` module with route binding utilities

### Changed

#### @spfn/auth

- **Registration Flow**: Now requires verification token from code verification
  - New flow: send code → verify code → register with token
  - Enhanced security with verification step

- **Authentication Middleware**: Refactored to use error throwing instead of response objects
  - Better separation of concerns
  - Improved error messages and types
  - Fire-and-forget `lastUsedAt` updates

- **API Response Format**: Simplified response types (removed wrapper objects)
  - Direct data returns instead of nested `data` wrapper for success responses

#### @spfn/cms

- **Entity Schema**: `cms_label_values.version` is now nullable
- **Contract**: `saveValuesContract` accepts `version: null | number`
- **Repository**: `upsert()` handles null version with draft/publish logic
- **Store**: Fixed API call from `cmsPublishedCache.get()` to `getPublishedCache()`

#### @spfn/core

- **API Response Module**: Simplified `route/api-response.ts` (210 lines removed)
- **Code Generator**: Improved contract-to-client generation in `codegen/built-in/contract/emitter.ts`
  - Better function naming (e.g., POST /api/auth/login → `authLogin()`)
  - Improved type generation for API clients

### Breaking Changes

#### @spfn/auth

- Registration endpoint now requires `verificationToken` parameter
- API response format changed (no more nested `data` wrapper for success)
- Auth context access changed from `c.raw.get('user')` to `getUser(c)`

## [0.1.0-alpha.69] - 2025-11-02

### Added

#### @spfn/cms

- **Labels API - Default Values Support**: Added `includeDefaultValues` query parameter to `GET /_cms/labels`
  - Returns `defaultValue` field from label definition JSON files
  - Enables admin UIs to show default values when no content is saved
  - Automatically loads and merges default values from `src/cms/labels/{section}/*.json`

- **Published Cache Upsert Endpoint**: Added `POST /_cms/published-cache` endpoint
  - Create or update published content cache
  - Request body: `{ section, locale, content, version }`
  - Returns updated cache with `publishedAt` timestamp
  - Enables programmatic cache updates after publishing labels

### Changed

#### @spfn/cms

- **Labels Contract**: Updated `getLabelsContract` response schema to include optional `defaultValue` field

## [0.1.0-alpha.68] - 2025-11-02

### Changed

#### @spfn/core

- **Codegen Folder Structure Refactoring**: Reorganized codegen module for better clarity and extensibility
  - Created `core/` directory for system files (orchestrator, generator interface, config loader, types)
  - Created `built-in/` directory for built-in generators
  - Moved contract generator to `built-in/contract/`
  - Renamed files for clarity:
    - `client-generator.ts` → `emitter.ts` (code generation)
    - `contract-scanner.ts` → `scanner.ts`
    - `route-scanner.ts` → `helpers.ts` (resource grouping utilities)
  - Prepared structure for future built-in generators (e.g., auth, migrations)
  - Updated all import paths to reflect new structure

## [0.1.0-alpha.67] - 2025-11-02

### Changed

#### @spfn/cms

- **Contract Path Prefixing**: All CMS contract paths now explicitly include `/_cms` prefix
  - `GET /labels` → `GET /_cms/labels`
  - `GET /labels/:id` → `GET /_cms/labels/:id`
  - `POST /values/:labelId` → `POST /_cms/values/:labelId`
  - `GET /values/:labelId/:version` → `GET /_cms/values/:labelId/:version`
  - `GET /published-cache` → `GET /_cms/published-cache`
  - Ensures contract paths match the actual route mounting point

#### @spfn/core

- **Prefix Validation for External Routes**: Auto-loader now validates contract paths against package prefix
  - When `loadExternalRoutes()` is called with a prefix parameter, contract paths must start with that prefix
  - Errors with clear hints if prefix is missing (e.g., "Contract paths should start with '/auth'. Example: path: '/auth/login'")
  - Prevents mismatch between backend route mounting and client API calls
  - Existing routes without prefix will fail validation until contracts are updated

### Fixed

#### @spfn/core

- **Auto-loader Tests**: Updated external routes tests to reflect new prefix validation behavior
  - Test contract paths now include required prefix
  - Added test case for prefix validation error scenario

## [0.1.0-alpha.66] - 2025-11-02

### Fixed

#### @spfn/cms

- **Server Actions Bundling**: Fixed "use server" directive bundling issue
  - Removed Server Actions exports from `server.ts` to prevent Turbopack build errors
  - Server Actions (`getLocale`, `setLocale`, etc.) now only exported from `actions.ts`
  - `server.ts` now only exports constants and server components
  - Resolves "Server Actions must be async functions" error in Next.js 15 with Turbopack

## [0.1.0-alpha.65] - 2025-11-02

### Added

#### @spfn/core

- **API Response Helpers**: Optional standardized response utilities
  - `success()`, `error()`, `paginated()` helper functions
  - `ApiSuccessResponse<T>`, `ApiErrorResponse`, `ApiResponse<T>` types
  - TypeBox schema helpers: `ApiSuccessSchema()`, `ApiErrorSchema()`, `ApiResponseSchema()`
  - Completely optional - use when desired for consistency

- **Route Module Enhancements**:
  - Prefix support for external package routes (e.g., `/auth`, `/cms`)
  - `loadExternalRoutes()` accepts prefix parameter for mounting
  - Default ErrorHandler now registered in all SPFN apps
  - Automatic mounting with package.json `spfn.prefix` field

- **Schema Module**: 6 new helper functions for common patterns
  - New utilities for schema composition and validation
  - Enhanced type-safe schema operations

- **Codegen Improvements**:
  - Scope-based API naming to avoid conflicts (e.g., `cmsApi`, `authApi`)
  - Package prefix support from package.json
  - `runOn` option to control when generators execute: 'watch' | 'manual' | 'build' | 'start'
  - Improved module generation with better defaults

- **Build Configuration**:
  - Submodule exports for better tree-shaking
  - Coverage configuration for testing

#### @spfn/cms

- Codegen-based API client generation
  - Auto-generated type-safe API clients via `@spfn/core:contract`
  - Generated API structure: CmsLabels, CmsLabelsByKey, CmsPublishedCache, CmsValues
  - All types auto-generated from contracts using InferContract

#### spfn CLI

- **Module Generation Enhancements**:
  - Scope selection when generating new modules (@spfn, @mycompany, etc.)
  - Comprehensive development guide in generated README
  - Example custom generator in new modules
  - Helper scripts (codegen, test, docker) in generated packages
  - 3-layer architecture templates (lib/, server/, client/)

### Changed

#### @spfn/core

- **Error Handling**:
  - Renamed `ValidationError` to `ConstraintViolationError` for clarity
  - Added HTTP `ValidationError` for request validation errors
  - Updated ErrorResponse to include `success: false` field

- **Cache Module**: Migrated from Redis to Valkey/Cache with graceful degradation
  - Support for Valkey (Redis fork)
  - Graceful fallback when cache is unavailable
  - Improved error handling

- **Codegen Architecture**:
  - Reorganized folder structure:
    - Created `scanners/` directory for contract and route scanners
    - Created `generators/contract/` directory
    - Improved imports (removed `.js` extensions)
  - Improved generator architecture with runOn and trigger pattern
  - Better separation of concerns

- **Middleware Module**: Export ErrorResponse type for better type safety

#### Package Structure

- **3-Layer Architecture**: Restructured cms, auth, and cli packages
  - `lib/`: Shared code (contracts, types, constants)
  - `server/`: Server-only code (entities, routes, repositories)
  - `client/`: Client-only code (hooks, store, components)
  - Updated all import paths and build configurations

### Fixed

#### @spfn/core

- TypeScript build errors across multiple modules
- watch-generate imports after folder restructure
- Logger test failures
- Server TypeScript type errors (MockInstance vs SpyInstance)
- Graceful skip for integration tests without PostgreSQL

### Testing

#### @spfn/core

- **Route Module**:
  - Updated auto-loader tests for contract-based routing
  - Added function-routes discovery tests
  - Enhanced bind and create-app test coverage

- **Middleware Module**:
  - Added 20 new maskSensitiveData tests
  - Comprehensive coverage of edge cases and circular references

- **Server Module**:
  - Added comprehensive helper and banner tests
  - Updated documentation with test coverage

- **Database Module**:
  - Added comprehensive tests for utility modules
  - Comprehensive test suite with improved type system
  - Reorganized transaction tests with 100% coverage

- **Codegen Module**:
  - Improved test coverage to 85.68% (47 → 61 tests)
  - Added 14 new tests across all subsystems

### Documentation

#### Core Concepts

- Added comprehensive framework documentation
- Updated db module documentation with schema and testing info
- Added comprehensive README for schema module

#### Modules

- **Route Module**: Added API Response helpers section with examples
- **Errors Module**: Added comprehensive test coverage section
- **Env Module**: Added comprehensive README documentation
- **Codegen Module**:
  - Updated documentation for new architecture
  - Added comprehensive custom generators guide

#### Philosophy & Architecture

- Added comprehensive philosophy documentation
  - Rails-inspired principles (Convention over Config, DRY, Omakase)
  - 7 core principles: Single Source of Truth, Proven Over Novel, Type Safety First
  - Design decisions: Why File-Based Routing, Why Contract-First, Why Single Project
  - What Superfunction Is Not section
- Renamed architecture/ → philosophy/ folder
- Improved deployment options documentation
  - Option 1: All-in-one deployment (recommended)
  - Option 2: Split deployment (Vercel + separate server)

#### Ecosystem

- Added module creation documentation
  - 8-step development workflow with code examples
  - Configuration options and API name generation
  - Custom generator examples and best practices
  - Publishing guide and troubleshooting section

## [0.1.0-alpha.64] - 2025-11-01

### Changed

#### @spfn/core

- **Codegen Architecture Simplification**:
  - **Removed legacy routes/ directory scanning**: Now only scans `lib/contracts/` directory
  - **Removed single file output mode**: Split-by-resource is now the only output mode
  - **Removed legacy generator naming**: Only `package:name` format supported (e.g., `@spfn/core:contract`)
  - **Simplified contract scanner**: Cleaner implementation with reduced complexity
  - **Updated all tests**: All 32 codegen tests updated to match new architecture

- **Breaking Changes**:
  - Contract files must be in `src/lib/contracts/` directory (no longer supports `src/routes/`)
  - Generator configuration must use `@spfn/core:contract` format (legacy `contract` name removed)
  - API client always outputs to directory structure (single file mode removed)

## [0.1.0-alpha.63] - 2025-11-01

### Enhanced

#### @spfn/core

- **API Client Generation Improvements**:
  - **Type Reuse**: API method signatures now reuse generated types instead of repeating `InferContract<typeof ...>` expressions
    - Before: `list: (options: { query?: InferContract<typeof getTeamsContract>['query'] }) => ...`
    - After: `list: (options: { query?: GetTeamsQuery }) => ...`
    - Improves code readability and maintainability

  - **Resource-Based File Splitting** (Default enabled):
    - API client now splits into separate files per resource: `src/lib/api/` directory structure
    - Before: Single `api.ts` file with all endpoints
    - After: Individual files (teams.ts, users.ts, etc.) + unified `index.ts`
    - Benefits:
      - ✅ File size stays manageable as your API grows
      - ✅ Types and APIs are co-located by resource
      - ✅ Better tree-shaking for optimal bundle size
      - ✅ Team members can work on different resources in parallel
    - Configuration: `splitByResource` option (default: `true`)
    - Legacy single-file mode still available with `splitByResource: false`

- **Documentation Updates**:
  - Updated codegen README with detailed split mode documentation
  - Added output mode comparison (split vs single file)
  - Added type reuse examples
  - Updated main README to reflect new API structure
  - Updated official documentation site

## [0.1.0-alpha.62] - 2025-10-30

### Fixed

#### @spfn/core

- **ESM File Extension Support**: Fixed comprehensive .mjs extension support across all file scanners
  - `contract-scanner.ts` now scans `.js` and `.mjs` files in lib/contracts/ directory (line 88-97)
  - `contract-scanner.ts` now removes all extensions (.ts, .js, .mjs) when generating import paths (line 401-412)
  - `config-generator.ts` now filters out `index.mjs` files from schema discovery (line 209-215)
  - Resolves codegen failures in production mode where built contract files (.mjs) were not being scanned
  - Ensures consistent file extension handling across all auto-discovery systems

## [0.1.0-alpha.61] - 2025-10-30

### Fixed

#### @spfn/core

- **ESM Config Loading**: Fixed server.config loading to support .mjs extension
  - `startServer()` now checks for `.spfn/server/server.config.mjs` before falling back to `.js`
  - Resolves "Unknown file extension .ts" error in production mode
  - Build output from tsup generates .mjs files which are now properly loaded

## [0.1.0-alpha.60] - 2025-10-29

### Breaking Changes

This is a major architectural update with several breaking changes. Upgrading from previous versions will require code modifications.

#### @spfn/core

- **Contract-based Architecture**: Complete migration from file-based routing to contract-based routing
  - ❌ **Removed**: `basePath` concept - contracts now define absolute paths directly
  - ❌ **Removed**: File-based path inference - routes no longer determine URLs from file structure
  - ✅ **Required**: All contracts must now be centralized in `src/lib/contracts/` directory
  - ✅ **Required**: Route handlers must import contracts using absolute paths (e.g., `@/lib/contracts/users`)
  - See [Migration Guide](#migration-guide-alpha60) below

- **Function Routes System Redesign**: External package routes now loaded directly without basePath
  - ❌ **Removed**: `loadWithBasePath()` method from auto-loader
  - ✅ **Added**: `loadExternalRoutes()` method for direct mounting
  - Function packages (e.g., `@spfn/cms`) now use absolute paths in contracts
  - Routes from function packages mount directly to main app (e.g., `/cms/labels`)

- **Strict Route File Convention**: Only `index.ts` and `index.js` files are recognized as route handlers
  - Prevents accidental loading of utility files, helpers, types, etc.
  - Route files must be named exactly `index.ts` or `index.js`
  - Example: `routes/users.ts` ❌ → `routes/users/index.ts` ✅

#### spfn (CLI)

- **@/ Alias Support**: Next.js-style import paths now supported in server code
  - Templates now use `@/lib/contracts/` instead of relative paths
  - `src/server/tsconfig.json` configured with baseUrl and paths mapping
  - `src/server/tsup.config.ts` includes esbuild alias configuration
  - Automatic tsup dependency installation added to `spfn init`

- **spfn add Command**: One-command installation for SPFN ecosystem packages
  - Automatically installs package and applies pre-generated migrations
  - No file copying - migrations execute directly from node_modules
  - Displays package-specific setup guide after installation
  - Example: `pnpm spfn add @spfn/cms`

- **Function Package Migrations**: Pre-generated migrations bundled with npm packages
  - Migrations included in package distribution (`files: ["dist", "migrations"]`)
  - `spfn.migrations.dir` field in package.json specifies migration location
  - Automatic schema creation (e.g., `CREATE SCHEMA IF NOT EXISTS spfn_cms`)
  - `spfn db push` and `spfn db migrate` automatically apply function migrations

#### @spfn/cms

- **tsup Build System**: Migrated from custom build to tsup bundler
  - Automatic ES module bundling with proper dependency handling
  - `@/` alias support in source code
  - Smaller bundle size with tree-shaking
  - Removed `.js` extensions from imports (tsup handles automatically)

- **Pre-generated Migrations**: Database migrations now bundled with package
  - Migrations generated during build: `npm run db:generate`
  - Post-generate script adds `CREATE SCHEMA IF NOT EXISTS spfn_cms`
  - Migrations included in npm package distribution
  - No migration file copying required on installation

### Added

#### @spfn/core

- **@/ Alias Resolution**: Added built-in support for Next.js-style import paths
  - Configure via `baseUrl` and `paths` in tsconfig.json
  - Works with both development (tsx) and production (built files)
  - Example: `import { userContract } from '@/lib/contracts/users'`

#### spfn (CLI)

- **Template Updates**: All templates now use modern import patterns
  - Routes use `@/lib/contracts/` imports
  - No `.js` extensions in source code
  - Clean, Next.js-familiar developer experience
  - `tsconfig.json` and `tsup.config.ts` included in templates

#### @spfn/cms

- **Optimized Bundle**: Smaller package size with better performance
  - Production-ready ES modules
  - Proper tree-shaking support
  - No runtime bundling required

### Fixed

#### spfn (CLI)

- **Template Configuration**: Added missing tsup dependency to package.json
  - Prevents "tsup not found" errors in fresh projects
  - Automatic installation via `spfn init`

### Migration Guide (alpha.60)

<details>
<summary>Click to expand migration guide</summary>

#### 1. Move Contracts to Centralized Location

**Before (alpha.56):**
```
src/server/routes/
  users/
    contract.ts          # ❌ Co-located contract
    index.ts            # Route handler
```

**After (alpha.60):**
```
src/lib/contracts/
  users.ts              # ✅ Centralized contract

src/server/routes/
  users/
    index.ts            # Route handler (imports from @/lib/contracts/users)
```

#### 2. Update Contract Paths

**Before:**
```typescript
// Contract defined absolute path
export const getUsersContract = {
  method: 'GET',
  path: '/users',  // ✅ Already absolute
} as const satisfies RouteContract;
```

**After:** (Same - contracts already used absolute paths!)
```typescript
// No changes needed for contract paths
export const getUsersContract = {
  method: 'GET',
  path: '/users',  // ✅ Still absolute
} as const satisfies RouteContract;
```

#### 3. Update Route Imports to Use @/ Alias

**Before:**
```typescript
import { getUsersContract } from './contract.js';
// or
import { getUsersContract } from '../../../lib/contracts/users.js';
```

**After:**
```typescript
import { getUsersContract } from '@/lib/contracts/users';
```

#### 4. Rename Non-Index Route Files

**Before:**
```
routes/
  users.ts              # ❌ Not recognized
  teams.ts              # ❌ Not recognized
```

**After:**
```
routes/
  users/
    index.ts            # ✅ Recognized
  teams/
    index.ts            # ✅ Recognized
```

#### 5. Update tsconfig.json and Add tsup.config.ts

**Add to src/server/tsconfig.json:**
```json
{
  "compilerOptions": {
    "baseUrl": "../..",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

**Add src/server/tsup.config.ts:**
```typescript
import { defineConfig } from 'tsup';
import path from 'path';

export default defineConfig({
    entry: {
        'routes/index': './routes/index.ts',
        'entities/index': './entities/index.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: false,
    target: 'es2022',
    outDir: '../../.spfn/server',
    splitting: false,
    esbuildOptions(options) {
        options.alias = {
            '@': path.resolve(__dirname, '../../src'),
        };
    },
});
```

#### 6. Install tsup Dependency

```bash
pnpm add -D tsup
```

#### 7. Update Function Package Imports (if using @spfn/cms)

**Before:**
```bash
pnpm add @spfn/cms
pnpm spfn db push
```

**After:** (Simpler!)
```bash
pnpm spfn add @spfn/cms  # One command does everything!
```

</details>

---

## Version History

- [0.1.0-alpha.60] - 2025-10-29 - Contract-based architecture, @/ alias support, spfn add command
- For older versions, see [CHANGELOG-v0.0.x-alpha.md](./CHANGELOG-v0.0.x-alpha.md)
