/**
 * @spfn/auth - Server Lifecycle Hooks
 *
 * Provides lifecycle hooks for SPFN server initialization
 */

import type { AuthInitOptions } from './rbac';
import type { SSETokenStore } from '@spfn/core/event/sse';
import type { PurgeStrategy } from './types';
import type { AccountDeletionPurgeUser, PurgedAccount } from './lib/deletion-config';
import type { Hono } from 'hono';
import { ensureAdminExists } from './setup';
import { assertAppFromThisHono } from './lib/hono-copy';
import { authLogger } from './logger';
import { assertRoleEmailDomainPolicy, initializeAuth, normalizeStoredEmails } from './services';
import { initOneTimeTokenManager } from './lib/one-time-token';
import { optionKeys, readOptions } from './lib/stated-options';
import { AUTH_INIT_OPTIONS, readInitOptions } from './services/rbac.service';
import { settleLinkMail } from './lib/link-mail-delivery';
import { assertDeletionConsistent, assertSelfDeletionConsistent, configureDeletion } from './lib/deletion-config';
import { configureDeviceAuth } from './lib/device-auth-config';
import { configureDeviceLink } from './lib/device-link-config';
import { assertChannelsConsistent, configureChannels, type AuthChannelsOptions } from './lib/channels-config';
import {
    assertSecondFactorPolicy,
    configureSecondFactor,
    type SecondFactorOptions,
} from './lib/second-factor-policy';
import { assertSignInGuardConsistent, configureSignIn, type SignInGuardOptions } from './lib/sign-in-guard';
import { assertPasswordRuleConsistent, configurePasswordRule, type PasswordRuleOptions } from './lib/password-rule';
import {
    assertPasswordChangeGuardConsistent,
    configurePasswordChange,
    type PasswordChangeGuardOptions,
} from './lib/password-change-guard';
import { assertPasskeyHookConsistent, configurePasskeyHook, type PasskeyHookOptions } from './lib/passkey-hook';
import { assertOAuthRedirectUris } from './lib/oauth/redirect-uri-check';
import { assertAppleWebConfig } from './lib/oauth/apple-config-check';
import { assertAndroidAssetLinks, assertAppleRelayUrls } from './lib/oauth/android-config-check';
import {
    assertAuthorizationServerIssuer,
    configureAuthorizationServer,
    type AuthorizationServerOptions,
} from './lib/oauth2/config';

/**
 * Auth lifecycle configuration
 */
export interface AuthLifecycleConfig
{
    beforeInfrastructure?: () => Promise<void>;
    afterInfrastructure?: () => Promise<void>;
    afterRoutes?: (app: Hono) => Promise<void>;
    beforeShutdown?: () => Promise<void>;
}

/**
 * Create auth lifecycle hooks for server configuration
 *
 * Provides essential initialization hooks:
 * - `beforeInfrastructure`: Validates environment variables before DB connection
 * - `afterInfrastructure`: Sets up admin accounts and initializes RBAC after DB is ready
 * - `afterRoutes`: Refuses an app built by another copy of `hono` than this
 *   package's, when the second-factor policy makes the enrolment gate read routes
 * - `beforeShutdown`: Waits, bounded, for link mail and codes still being sent
 *   inline after a request answered, before the database closes. Queued mail
 *   is not its concern: the enqueue after a commit is an after-commit
 *   callback, which `@spfn/core`'s shutdown drain waits for
 *
 * @param options - Auth initialization options (custom roles, permissions, mappings)
 *
 * @example Basic usage
 * ```typescript
 * import { defineServerConfig } from '@spfn/core/server';
 * import { createAuthLifecycle } from '@spfn/auth';
 * import { appRouter } from './router';
 *
 * export default defineServerConfig()
 *   .port(8790)
 *   .routes(appRouter)
 *   .lifecycle(createAuthLifecycle())
 *   .build();
 * ```
 *
 * @example With custom roles and permissions
 * ```typescript
 * export default defineServerConfig()
 *   .port(8790)
 *   .routes(appRouter)
 *   .lifecycle(createAuthLifecycle({
 *     roles: [
 *       { name: 'project-manager', displayName: 'Project Manager', priority: 50 },
 *       { name: 'developer', displayName: 'Developer', priority: 30 },
 *     ],
 *     permissions: [
 *       { name: 'project:create', displayName: 'Create Project', category: 'custom' },
 *       { name: 'task:assign', displayName: 'Assign Task', category: 'custom' },
 *     ],
 *     rolePermissions: {
 *       'project-manager': ['project:create', 'task:assign'],
 *       'developer': ['task:complete'],
 *     },
 *     sessionTtl: '30d'
 *   }))
 *   .build();
 * ```
 *
 * @example With custom lifecycle hooks
 * ```typescript
 * // You can call lifecycle() multiple times - all hooks will be executed in order
 * export default defineServerConfig()
 *   .port(8790)
 *   .routes(appRouter)
 *   .lifecycle(createAuthLifecycle())  // Auth initialization runs first
 *   .lifecycle({
 *     afterInfrastructure: async () => {
 *       // This runs after auth initialization
 *       await myCustomSetup();
 *     }
 *   })
 *   .build();
 * ```
 */
/**
 * Options for createAuthLifecycle
 */
export interface AuthLifecycleOptions extends AuthInitOptions
{
    /**
     * One-time token configuration
     *
     * Enables one-time token issuance for direct API access
     * (file uploads, SSE streaming, etc.)
     *
     * @example
     * ```typescript
     * createAuthLifecycle({
     *     oneTimeToken: { ttl: 60000 },  // 60 seconds
     * })
     * ```
     */
    oneTimeToken?: {
        /**
         * Token time-to-live in milliseconds
         * @default 30000
         */
        ttl?: number;

        /**
         * Custom token store (e.g., CacheTokenStore for Redis/Valkey)
         *
         * When provided, tokens are stored in the external store instead of in-memory Map.
         * Required for multi-instance deployments where token issuance and verification
         * may happen on different server instances.
         *
         * @example
         * ```typescript
         * import { CacheTokenStore } from '@spfn/core/event/sse';
         * import { getCache } from '@spfn/core/cache';
         *
         * createAuthLifecycle({
         *     oneTimeToken: {
         *         store: new CacheTokenStore(getCache()),
         *     },
         * })
         * ```
         */
        store?: SSETokenStore;
    };

    /**
     * Account deletion/recovery lifecycle configuration
     *
     * Controls the grace-period request → recover → purge flow exposed by
     * `POST /_auth/deletion/request` and `POST /_auth/deletion/cancel`.
     * Registering the purge job itself is a separate step — see `authJobRouter`
     * (`@spfn/auth/server`) and the README, since job registration happens after
     * this lifecycle hook runs and can't be triggered from here.
     *
     * A later `createAuthLifecycle()` that omits it, or omits an option, leaves
     * what an earlier one stated as it is; one that states an option with
     * another value, or another `onBeforePurge`/`onPurge` function, refuses
     * boot in `afterInfrastructure`, naming both.
     *
     * @example
     * ```typescript
     * createAuthLifecycle({
     *     deletion: {
     *         gracePeriodDays: 14,
     *         purgeStrategy: 'anonymize',
     *         allowSelfImmediate: false,
     *         onBeforePurge: async (user) => {
     *             await appDataCleanup(user.id); // throw to skip this user this sweep
     *         },
     *         onPurge: async (account) => {
     *             await deletionNoticeOutbox.add(account); // database only: a job sends it
     *         },
     *     },
     * })
     * ```
     */
    deletion?: {
        /**
         * Days between a deletion request and the purge becoming eligible.
         * 0 = immediate (still goes through the same request/purge pipeline).
         * @default 30
         */
        gracePeriodDays?: number;

        /**
         * How the purge job destroys the account once the grace period elapses.
         * - 'anonymize': scrub PII, keep the row (deletion -> 'deleted') — recommended default
         * - 'hard-delete': physically remove the `users` row (cascades to child rows)
         * @default 'anonymize'
         */
        purgeStrategy?: PurgeStrategy;

        /**
         * Whether a self-service caller may pass `immediate: true` on
         * `POST /_auth/deletion/request` to skip the grace period entirely.
         * @default false
         */
        allowSelfImmediate?: boolean;

        /**
         * Cron schedule for the purge sweep. NOTE: this does not reach the static
         * `authJobRouter` export automatically — job schedules are fixed at
         * module-import time, before this lifecycle hook runs. For a non-default
         * cron, build the router yourself after this call with
         * `createAuthDeletionJobRouter({ purgeCron })` (see `@spfn/auth/server`).
         * @default '0 4 * * *'
         */
        purgeCron?: string;

        /**
         * The app's own I/O before a purge (the immediate inline path, the
         * admin entry point and the cron sweep), outside any transaction: called
         * once the primary read finds the account still `pending`, before the
         * purge transaction opens and without the account lock. Throw to skip
         * that user for this run — they stay `pending` and are retried on the
         * next sweep. A cancel may still win after it returns, so it can run for
         * a purge that never happens, and it runs again on every retry.
         */
        onBeforePurge?: (user: AccountDeletionPurgeUser) => Promise<void>;

        /**
         * The package sends no deletion notice; this hook is how an app learns
         * the address of an account it may no longer read. Called inside the
         * purge transaction, under the account lock, once the purge has claimed
         * the request and before its destructive writes (both strategies), with
         * `{ publicId, email, phone, purgeStrategy }` read under the lock. The
         * account's rows — its settings, the language among them — and the
         * app's own rows that a hard delete cascades away are still readable
         * through the transaction. Never published or queued.
         *
         * Database work only: it runs under the account lock. Write an outbox
         * row through the app's own repository — it joins this transaction, so
         * the row commits with the purge or not at all — and send from a job
         * after the commit. A hook that opens its own transaction
         * (`requiresNew`) and touches the account's rows never returns: it
         * waits on the lock the purge holds, and PostgreSQL does not see a
         * deadlock. A plain nested `runInTransaction` joins and is fine. A throw
         * rolls the purge back (no `auth.deletion.completed`); the request stays
         * `pending` and the next sweep calls it again.
         */
        onPurge?: (account: PurgedAccount) => Promise<void>;
    };

    /**
     * Device-code login configuration
     *
     * Controls the codes handed out by `POST /_auth/device/start` and obeyed by
     * `POST /_auth/device/poll`. Both values are announced to the waiting device
     * in the start response, so they are resolved here rather than read per call,
     * and both must be a positive whole number of milliseconds — the interval is
     * published as an integer and a fraction is refused at startup rather than
     * handed to a client that cannot decode it.
     *
     * @example
     * ```typescript
     * createAuthLifecycle({
     *     deviceAuth: {
     *         ttlMs: 5 * 60 * 1000,   // a code lives 5 minutes
     *         intervalMs: 3000,       // poll every 3 seconds
     *     },
     * })
     * ```
     */
    deviceAuth?: {
        /**
         * How long a device code stays usable, in milliseconds.
         * @default 600000 (10 minutes)
         */
        ttlMs?: number;

        /**
         * Poll interval the server asks the waiting device to keep, in milliseconds.
         * @default 5000
         */
        intervalMs?: number;

        /**
         * The longest a poll that sends `waitMillis` is held open, in milliseconds.
         * Keep it under the idle timeout of every proxy in front of the server.
         * @default 20000
         */
        maxWaitMs?: number;
    };

    /**
     * Device link configuration
     *
     * Controls the codes handed out by `POST /_auth/device/link/issue`. The poll
     * interval and the long-poll cap are `deviceAuth`'s: both flows wait the same
     * way behind the same proxies.
     *
     * @example
     * ```typescript
     * createAuthLifecycle({
     *     deviceLink: {
     *         ttlMs: 3 * 60 * 1000,   // a link code lives 3 minutes
     *     },
     * })
     * ```
     */
    deviceLink?: {
        /**
         * How long a link code stays usable, in milliseconds.
         * @default 300000 (5 minutes)
         */
        ttlMs?: number;
    };

    /**
     * OAuth 2.1 authorization server for MCP clients
     *
     * Opt-in, and the opt-in is this block. Without it `/_auth/oauth2/*` and
     * `/.well-known/oauth-authorization-server` answer 404, the boot check does
     * not run, and the application boots exactly as it did before this feature
     * existed. With it, Claude Code and Codex can register themselves, send the
     * account owner to a consent screen, and hold a token against `/mcp`.
     *
     * `scopes` is the one thing with no default: the names are the
     * application's own vocabulary, they are published in the metadata document
     * and shown on the consent screen, and there is nothing to derive them from.
     *
     * @example
     * ```typescript
     * createAuthLifecycle({
     *     authorizationServer: {
     *         scopes: {
     *             'mcp:read': 'Read your projects and tasks',
     *             'mcp:write': 'Create and edit your tasks',
     *         },
     *         defaultScopes: ['mcp:read'],
     *     },
     * })
     * ```
     */
    authorizationServer?: AuthorizationServerOptions;

    /**
     * Which channels this application offers: the ways into an account, and
     * the invitation and self-deletion routes
     *
     * Every key is optional: state only what changes. `signup`,
     * `passwordReset`, `deviceCode` and `deviceLink` — the channels this
     * option shipped with in 0.3 — are on unless stated `false`. Every other
     * channel — `passkeyLogin`, `invitations`, `selfDeletion`, and any a later
     * release adds — is off unless stated `true`, so an upgrade never opens
     * a way into an account. A key left out, or `undefined`, takes its
     * default. `channels` is a plain object: its prototype is `null` or the
     * `Object.prototype` of some realm. A key that is not a channel — every
     * own name, enumerable or not — a value that is not a boolean — read once
     * per channel — and a `channels` that is not a plain object (a class
     * instance, a `Map`, an array, `Object.create(other)`) throw here.
     *
     * A channel that is off answers 404 `CHANNEL_DISABLED`
     * (`ChannelDisabledError`) on each of its routes, before the route's rate
     * limit, long poll or transaction runs. A signed-in route still runs the global `auth` middleware first,
     * so an anonymous caller there is answered 401 and a signed-in one 404.
     *
     * The defaults hold only while no call states `channels`. A later
     * `createAuthLifecycle()` that omits `channels` leaves them as they are;
     * each call that states it resolves every channel — what it states, the
     * default for the rest — and one whose resolution differs from the
     * first's refuses boot in `afterInfrastructure`, every channel either
     * call resolved off staying off until then.
     *
     * - `signup` (on) — `register`, the verified-email signup link, and a
     *   verification code with `purpose: 'registration'`. Also refuses the
     *   account a first social sign-in would create (`SignupDisabledError`,
     *   403 `SIGNUP_DISABLED`); a sign-in whose identity is linked, or that
     *   attaches to an existing account under `oauthEmailMatch`, is untouched.
     * - `passwordReset` (on) — the reset link
     * - `deviceCode` (on) — device-code login
     * - `deviceLink` (on) — device link
     * - `passkeyLogin` (off) — passkey sign-in (`passkeys/login/options`,
     *   `passkeys/login/verify`). An app whose every sign-in is a password
     *   plus a passkey (`secondFactor: { required: true, methods: ['passkey'] }`)
     *   leaves it off, since a passkey sign-in with user verification needs no
     *   second factor. Registering a passkey and proving one as a second
     *   factor are on whatever it says.
     * - `invitations` (off) — every invitation route: create, list, resend,
     *   cancel, delete, and the public `invitations/:token` read and accept.
     *   Pending invitations stay pending and cannot be accepted while it is
     *   off; the app settles them with `cancelInvitation` / `deleteInvitation`.
     * - `selfDeletion` (off) — `POST /_auth/deletion/request` only.
     *   `deletion/cancel` and the `account_deletion` code stay on: a pending
     *   deletion blocks every sign-in, and closing its only way back would
     *   lock the person out until the purge. `deletion.allowSelfImmediate:
     *   true` refuses boot unless this is `true`, since it would be dead.
     *
     * Password sign-in has no key. Service functions ignore this setting and
     * stay callable by the application — the invitation services and admin
     * seeding create accounts whatever `signup` and `invitations` say.
     *
     * @example
     * ```typescript
     * createAuthLifecycle({
     *     channels: {
     *         signup: false,       // accounts are issued, not taken
     *         passkeyLogin: true,  // off unless stated
     *     },
     * })
     * ```
     */
    channels?: AuthChannelsOptions;

    /**
     * The application's second-factor policy
     *
     * Omitted, nothing changes: a second factor is something an account opts
     * into, with either method, and comes with recovery codes.
     *
     * - `required` (default `false`) — an account with none of the listed
     *   methods may only enrol one. Every signed-in route answers it 403
     *   `SECOND_FACTOR_ENROLMENT_REQUIRED` except the enrolment routes,
     *   `optionalAuth` reads it as anonymous, and its `LoginResult` carries
     *   `secondFactorEnrolmentRequired: true`. Removing the last listed factor
     *   through a route is 409 `SECOND_FACTOR_REQUIRED`; `disableMfaService`
     *   called by the application is the operator's re-issue path. Boot is
     *   refused while `channels.deviceCode` or `channels.deviceLink` is on.
     * - `methods` (default `['totp', 'passkey']`) — only these count as
     *   enrolled and are accepted as a proof; the others' second-factor routes
     *   answer 404 `SECOND_FACTOR_METHOD_DISABLED`. `['passkey']` raises passkey
     *   user verification to `required`. `[]` refuses boot.
     * - `recoveryCodes` (default `true`) — `false` issues none, accepts none,
     *   and answers `recovery/regenerate` with that 404.
     *
     * A later `createAuthLifecycle()` that omits it leaves it as it is; one
     * that states a different policy refuses boot in `afterInfrastructure`,
     * and the first statement stays in force until then.
     *
     * @example
     * ```typescript
     * createAuthLifecycle({
     *     channels: {
     *         deviceCode: false,   // refused at boot under required
     *         deviceLink: false,
     *     },
     *     secondFactor: { required: true, methods: ['passkey'], recoveryCodes: false },
     * })
     * ```
     */
    secondFactor?: SecondFactorOptions;

    /**
     * The application's sign-in guard
     *
     * Omitted, nothing changes: no extra query, lock or transaction on any
     * sign-in. Stated, the app is asked whether each sign-in may go on and is
     * told how each one ended.
     *
     * - `admit(attempt, call)` — answer `{ refuse: { code } }` to refuse: the
     *   client gets 403 `SignInRefusedError` with `details.code`. Asked where a
     *   key is minted (every sign-in channel) and at the second-factor
     *   completion (`call` `'deciding'`); a password sign-in, `deletion/cancel`
     *   and `mfa/verify` ask it first before the credential is compared
     *   (`'before-proof'`) — the one place to count an attempt — and again
     *   once a wrong one is recorded (`'after-failure'`). A refused account is
     *   compared against a dummy hash and refused whatever the password was.
     *   Never asked on renewal or key rotation.
     * - `settled(outcome)` — `succeeded` once a session exists, `challenged` on
     *   a 202, `failed` with a `reason` for every attempt that names an account
     *   or a credential, refusals included. A failure is recorded in a
     *   transaction of its own, committed before the answer; a wrong credential
     *   checked before any transaction has `admit` asked again there, and a
     *   refusal decided inside the session's transaction is told once that
     *   transaction has rolled back.
     *
     * Each runs in a transaction of the package's, holding the account's lock,
     * and an app repository extending `BaseRepository` joins it. The
     * `'before-proof'` call has one of its own, committed before the
     * comparison whatever it answers, so concurrent attempts on one account
     * take turns at an app's count; a throw there rolls it back. Database work
     * only, and fast: no mail, no network call. Never lock a second account. On
     * OAuth a contended sign-in runs them twice, the first run rolled back. See
     * the README, "Sign-in guard".
     *
     * A later `createAuthLifecycle()` that omits it leaves it as it is; one
     * that states other functions refuses boot in `afterInfrastructure`.
     *
     * @example
     * ```typescript
     * createAuthLifecycle({
     *     signIn: {
     *         admit: async ({ user }, call) =>
     *         {
     *             if (!user)
     *             {
     *                 return undefined;
     *             }
     *
     *             const attempts = call === 'before-proof'
     *                 ? await signInAttempts.add(user.id)
     *                 : await signInAttempts.count(user.id);
     *
     *             return attempts > 5 ? { refuse: { code: 'LOCKED' } } : undefined;
     *         },
     *         settled: async (outcome) =>
     *         {
     *             if (outcome.result === 'succeeded' && outcome.user)
     *             {
     *                 await signInAttempts.clear(outcome.user.id);
     *             }
     *         },
     *     },
     * })
     * ```
     */
    signIn?: SignInGuardOptions;

    /**
     * The application's seat inside a password change
     *
     * Omitted, nothing changes. Stated, both run inside the transaction that
     * writes the new password, under the account lock, on the two paths that
     * set a password the person chose and clear `passwordChangeRequired`:
     * `PUT /_auth/password` (`channel: 'change'`) and a completed reset link
     * (`'reset'`). `required` is true when the account carried the flag.
     *
     * - `admit(attempt)` — before anything is written. Answer
     *   `{ refuse: { code } }` to refuse: nothing is written, the client gets
     *   403 `PasswordChangeRefusedError` with `details.code`.
     * - `changed(attempt)` — once the change is written and the sessions it
     *   ends are ended. A throw rolls the change back.
     *
     * A throw from either is 500 `PasswordChangeHookFailedError`, which keeps
     * only the thrown value's class and SQLSTATE. An app repository extending
     * `BaseRepository` joins the change's transaction: its write commits with
     * the change or not at all. Database work only, and fast; never open a
     * `requiresNew` transaction that touches the account, which waits on the
     * lock the change holds. See the README, "The password-change guard".
     *
     * A later `createAuthLifecycle()` that omits it leaves it as it is; one
     * that states other functions refuses boot in `afterInfrastructure`.
     *
     * @example
     * ```typescript
     * createAuthLifecycle({
     *     passwordChange: {
     *         admit: async ({ user, required }) => required && await setups.isExpired(user.id)
     *             ? { refuse: { code: 'TEMPORARY_PASSWORD_EXPIRED' } }
     *             : undefined,
     *         changed: async ({ user, required }) => { if (required) await setups.complete(user.id); },
     *     },
     * })
     * ```
     */
    passwordChange?: PasswordChangeGuardOptions;

    /**
     * The application's seat inside a passkey's enrolment and revocation
     *
     * Omitted, nothing changes. Stated, each runs inside the transaction that
     * writes or revokes the passkey row, after that write and before the
     * commit, under the account lock the act already holds — once per
     * passkey, on every path:
     *
     * - `enrolled({ userId, passkeyId, label? })` — every registration
     *   (`POST /_auth/passkeys/register/verify`: first set-up and adding a
     *   passkey), once everything it writes is written;
     * - `revoked({ userId, passkeyId, reason })` — the owner's removal
     *   (`POST /_auth/passkeys/revoke`, `reason: 'user'`) and the operator's
     *   `resetSecondFactorService` (`'operator'`), once for each passkey it
     *   revokes.
     *
     * Each is handed the payload its after-commit event
     * (`auth.passkey.enrolled`, `auth.passkey.revoked`) carries; the events
     * are published as before. A throw rolls the act back — the whole reset,
     * on the operator's — and answers 500 `PasskeyHookFailedError`, which
     * keeps only the thrown value's class and SQLSTATE. An app repository
     * extending `BaseRepository` joins the transaction: its write commits with
     * the passkey's change or not at all. Database work only, and fast; never
     * open a `requiresNew` transaction that touches the account, which waits
     * on the lock the act holds, and never lock a second account. See the
     * README, "The passkey hook".
     *
     * A later `createAuthLifecycle()` that omits it leaves it as it is; one
     * that states other functions refuses boot in `afterInfrastructure`.
     *
     * @example
     * ```typescript
     * createAuthLifecycle({
     *     passkey: {
     *         enrolled: async ({ userId, passkeyId }) => { await history.add(userId, 'passkey-enrolled', passkeyId); },
     *         revoked: async ({ userId, passkeyId, reason }) => { await history.add(userId, `passkey-revoked:${reason}`, passkeyId); },
     *     },
     * })
     * ```
     */
    passkey?: PasskeyHookOptions;

    /**
     * The application's rule for a new password
     *
     * Omitted, nothing changes: a new password is held to `PasswordSchema`
     * (8 to 256 characters) alone. Stated, `validate(password, subject)` is
     * asked on every path that writes a password hash — `register`,
     * `signup-link`, `invitation`, `change`, `reset`, admin seeding (`seed`)
     * and the app's own `hashNewPassword` (`operator`) — before the hash is
     * computed, and on the package's paths before any transaction opens: a
     * slow rule holds no lock and no connection. `subject` is `{ channel, userId, email, phone }`: identifiers,
     * never an account row; `userId` is null where no account exists yet.
     *
     * - Answer nothing or `[]` to accept.
     * - Answer the app's messages to refuse: 400 `ValidationError`, one entry
     *   per message in `fields`, on the password field (`/password`, or
     *   `/newPassword` on `PUT /_auth/password`), the shape a `PasswordSchema`
     *   failure has, without `value`. Nothing is hashed or written.
     * - A throw is 500 `PasswordRuleFailedError`, which keeps only the thrown
     *   value's class and SQLSTATE; never an acceptance.
     *
     * Sync or async. `validatePasswordStrength` is not applied unless the
     * rule calls it. See the README, "The password rule".
     *
     * A later `createAuthLifecycle()` that omits it leaves it as it is; one
     * that states another function refuses boot in `afterInfrastructure`.
     *
     * @example
     * ```typescript
     * createAuthLifecycle({
     *     password: {
     *         validate: (password, { email }) => [
     *             ...validatePasswordStrength(password).errors,
     *             ...(email && password.toLowerCase().includes(email.split('@')[0].toLowerCase())
     *                 ? ['The password must not contain your account name']
     *                 : []),
     *         ],
     *     },
     * })
     * ```
     */
    password?: PasswordRuleOptions;
}

/** Every option `createAuthLifecycle` reads: `initializeAuth`'s, and its own. */
const LIFECYCLE_OPTIONS = optionKeys<AuthLifecycleOptions>({
    roles: true,
    permissions: true,
    rolePermissions: true,
    sessionTtl: true,
    userSettings: true,
    profileFields: true,
    oneTimeToken: true,
    deletion: true,
    deviceAuth: true,
    deviceLink: true,
    authorizationServer: true,
    channels: true,
    secondFactor: true,
    signIn: true,
    passwordChange: true,
    passkey: true,
    password: true,
});

/**
 * The options of `read` that `initializeAuth` reads, read now as it reads
 * them: the roles, permissions and mappings boot declares are copies taken at
 * this call, which a later change to the application's arrays does not reach
 * (#477).
 */
function initOptions(read: Partial<AuthLifecycleOptions>): AuthInitOptions
{
    return readInitOptions(Object.fromEntries(AUTH_INIT_OPTIONS.filter(key => Object.hasOwn(read, key)).map(key => [key, read[key]])));
}

export function createAuthLifecycle(options: AuthLifecycleOptions = {}): AuthLifecycleConfig
{
    // Read once, here, as every option object inside it is by its own reader:
    // a name that is not an option — `chanels` — is refused at this call
    // rather than left out for its default, and nothing below reads `options`
    // again (#477).
    const read = readOptions<AuthLifecycleOptions>('createAuthLifecycle', options, LIFECYCLE_OPTIONS);
    const init = initOptions(read);

    // Synchronous, not inside afterInfrastructure: readers of getDeletionConfig()
    // (routes, the purge job handler) only run later, at request/handler time — but
    // createAuthDeletionJobRouter() may be called by the app right after this
    // constructor returns (same builder chain), and it needs the resolved config
    // immediately. See lib/deletion-config.ts for the full ordering rationale.
    // An omitted option leaves an earlier call's as it is; a contradicting one
    // is refused below, in afterInfrastructure.
    configureDeletion(read.deletion);

    // Same reason, one step simpler: nothing but request handlers read this, and
    // they all run later — but resolving it here keeps every knob set in one place
    // and rules out a first request that is served under the defaults.
    configureDeviceAuth(read.deviceAuth);
    configureDeviceLink(read.deviceLink);

    // Same again, and it is also what decides whether the authorization server
    // exists at all: every route under /_auth/oauth2/* reads this and answers
    // 404 on null. Registration of those routes happens at module-import time,
    // before this call, so "registered only when configured" is not available —
    // see routes/oauth2/http.ts.
    configureAuthorizationServer(read.authorizationServer);

    // Same again: every gated route reads this at request time and answers 404
    // for a channel that is off — see routes/channels.ts. An unknown key or a
    // value that is not a boolean throws here: that is known from this call
    // alone. An omitted option leaves an earlier call's channels as they are;
    // a contradicting one is refused below, in afterInfrastructure.
    configureChannels(read.channels);

    // Same again: the enrolment check in `authenticate`, the method gates and
    // the proof checks read it at request time. Omitted leaves it as it is; a
    // contradicting statement is refused below, in afterInfrastructure.
    configureSecondFactor(read.secondFactor);

    // Same again: every sign-in reads it at request time. Omitted leaves it as
    // it is; a contradicting statement is refused below, in afterInfrastructure.
    configureSignIn(read.signIn);
    configurePasswordChange(read.passwordChange);
    configurePasskeyHook(read.passkey);
    // Before afterInfrastructure, where admin seeding asks it.
    configurePasswordRule(read.password);

    return {
        /**
         * Initialize auth system after database is ready
         *
         * Performs:
         * 0. Refuses boot on an OAuth redirect URI override off the web app origin,
         *    on a partial Sign in with Apple web setup, on an Android relay or
         *    assetlinks.json setup that cannot work, on an authorization
         *    server issuer no client could use, or on two lifecycles that
         *    stated different channels or deletion options
         * 1. Ensures admin account exists (creates if missing)
         * 2. Initializes RBAC system with built-in + custom roles/permissions
         * 3. Refuses boot on an SPFN_AUTH_ROLE_EMAIL_DOMAINS policy that cannot work
         * 4. Initializes one-time token manager
         */
        afterInfrastructure: async () =>
        {
            // Either place refuses the boot: a throw here propagates out of
            // initializeInfrastructure(), and a throw from the constructor makes
            // server.config fail to load, which startServer() refuses as well —
            // in both cases before anything listens. The boot refusals are kept
            // together here because some cannot run earlier: the Apple web key
            // import is async, and the channel and second-factor checks need
            // every createAuthLifecycle() call to have run.
            assertOAuthRedirectUris();
            // Same reasoning; refuses a partial Sign in with Apple web setup or a key that
            // does not import. Silent when none of its five variables is set.
            await assertAppleWebConfig();
            // Same reasoning; refuses an Android relay URL that is not an https App Link,
            // relay URLs without the Apple web flow, and a partial or malformed
            // assetlinks.json pair. Silent when none of the three variables is set.
            assertAppleRelayUrls();
            assertAndroidAssetLinks();

            // Here beside the other boot refusals rather than beside
            // configureAuthorizationServer above. Silent when no authorization
            // server is configured.
            assertAuthorizationServerIssuer();
            // Same reasoning: two createAuthLifecycle() calls that stated
            // different channels. Silent when at most one stated them.
            assertChannelsConsistent();
            // Same reasoning: two createAuthLifecycle() calls that stated one
            // deletion option differently, or two owners of one purge hook.
            // Silent when at most one stated each.
            assertDeletionConsistent();
            // Same reasoning, after the channels and the deletion options it
            // reads: allowSelfImmediate beside a selfDeletion channel that is
            // off, as it is unless stated true.
            assertSelfDeletionConsistent();
            // Same reasoning, after the channels it reads: a contradicting
            // second statement, no method listed, a required factor beside a
            // device channel that proves none, passkey-only beside a weaker
            // user verification, TOTP-only with no keyring. Silent when no
            // policy was stated.
            assertSecondFactorPolicy();
            // Same reasoning: two createAuthLifecycle() calls that stated
            // different sign-in guards. Silent when at most one stated one.
            assertSignInGuardConsistent();
            // Same reasoning, for the password-change guard.
            assertPasswordChangeGuardConsistent();
            // Same reasoning, for the passkey hook.
            assertPasskeyHookConsistent();
            // Same reasoning, for the password rule.
            assertPasswordRuleConsistent();

            await initializeAuth(init);
            // Before any account is looked up: the repository folds addresses to
            // canonical form now, so a row still stored in mixed case would not
            // be found by its owner.
            //
            // Reported rather than thrown. The backfill repairs old rows; it is
            // not what makes this instance able to serve, and a rolling deploy
            // can fail it for reasons that resolve themselves — an instance
            // still running the old code can register the very address this is
            // folding a row onto, between the conflict check and the rewrite.
            // Refusing to boot on that would take the service down to fix
            // something the next boot retries anyway.
            try
            {
                await normalizeStoredEmails();
            }
            catch (error)
            {
                authLogger.service.error(
                    'Stored email normalization did not complete. Addresses stay as they are, so an account '
                    + 'stored in mixed case cannot sign in until a later boot succeeds.',
                    { error },
                );
            }

            // Unconditional, and safe to be: admin seeding looks an account up
            // in whatever form it was stored, so it recognizes an admin this
            // backfill has not reached and skips it rather than making a second
            // one. Making it wait on the backfill instead would mean a failure
            // over here — or a capitalization clash between two unrelated
            // ordinary accounts — leaves an install with no administrator and
            // nothing but a log line saying so.
            await ensureAdminExists();

            // After seeding and RBAC init, so the roles it looks for and the
            // superadmins it counts are the ones this instance will serve.
            await assertRoleEmailDomainPolicy();
            initOneTimeTokenManager(read.oneTimeToken);
        },

        /**
         * Refuses the boot when the server's app was built by another copy of
         * Hono than this package's: the gate could not read a single request's
         * route. It reads one for every restricted session — an account that
         * must change its password (#362), which seeding makes in any app, or
         * one the second-factor policy holds to enrolling — so it is asked of
         * every app, policy or not. Core runs this hook for the app it
         * configures, not for a custom `app.ts`; there the first such request
         * is refused instead.
         */
        afterRoutes: async (app) =>
        {
            assertAppFromThisHono(app);
        },

        /**
         * A request answers before its link mail or code is sent or queued
         * (`deliverLinkMail`); this waits for the inline sends, at most ten
         * seconds and at most what core's hooks' budget leaves it, while the
         * database is still open (see `settleLinkMail` for what is logged
         * when either bound ends it). Queued sends were waited for by core's
         * drain, before this hook.
         */
        beforeShutdown: () => settleLinkMail(),
    };
}
