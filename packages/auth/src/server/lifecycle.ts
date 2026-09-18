/**
 * @spfn/auth - Server Lifecycle Hooks
 *
 * Provides lifecycle hooks for SPFN server initialization
 */

import type { AuthInitOptions } from './rbac';
import type { SSETokenStore } from '@spfn/core/event/sse';
import type { PurgeStrategy } from './types';
import type { AccountDeletionPurgeUser } from './lib/deletion-config';
import { ensureAdminExists } from './setup';
import { authLogger } from './logger';
import { initializeAuth, normalizeStoredEmails } from './services';
import { initOneTimeTokenManager } from './lib/one-time-token';
import { configureDeletion } from './lib/deletion-config';
import { configureDeviceAuth } from './lib/device-auth-config';
import { assertOAuthRedirectUris } from './lib/oauth/redirect-uri-check';
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
}

/**
 * Create auth lifecycle hooks for server configuration
 *
 * Provides essential initialization hooks:
 * - `beforeInfrastructure`: Validates environment variables before DB connection
 * - `afterInfrastructure`: Sets up admin accounts and initializes RBAC after DB is ready
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
     * @example
     * ```typescript
     * createAuthLifecycle({
     *     deletion: {
     *         gracePeriodDays: 14,
     *         purgeStrategy: 'anonymize',
     *         allowSelfImmediate: false,
     *         sendNotifications: true,
     *         onBeforePurge: async (user) => {
     *             await appDataCleanup(user.id); // throw to skip this user this sweep
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
         * - 'anonymize': scrub PII, keep the row (status -> 'deleted') — recommended default
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
         * Whether to email users (when they have one on file) at request,
         * recovery, and final-purge time.
         * @default true
         */
        sendNotifications?: boolean;

        /**
         * Invoked immediately before a user is purged (both the immediate inline
         * path and the cron sweep). Throw to skip that user for this run — they
         * stay `pending` and are retried on the next sweep.
         */
        onBeforePurge?: (user: AccountDeletionPurgeUser) => Promise<void>;
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
}

export function createAuthLifecycle(options: AuthLifecycleOptions = {}): AuthLifecycleConfig
{
    // Synchronous, not inside afterInfrastructure: readers of getDeletionConfig()
    // (routes, the purge job handler) only run later, at request/handler time — but
    // createAuthDeletionJobRouter() may be called by the app right after this
    // constructor returns (same builder chain), and it needs the resolved config
    // immediately. See lib/deletion-config.ts for the full ordering rationale.
    configureDeletion(options.deletion);

    // Same reason, one step simpler: nothing but request handlers read this, and
    // they all run later — but resolving it here keeps every knob set in one place
    // and rules out a first request that is served under the defaults.
    configureDeviceAuth(options.deviceAuth);

    // Same again, and it is also what decides whether the authorization server
    // exists at all: every route under /_auth/oauth2/* reads this and answers
    // 404 on null. Registration of those routes happens at module-import time,
    // before this call, so "registered only when configured" is not available —
    // see routes/oauth2/http.ts.
    configureAuthorizationServer(options.authorizationServer);

    return {
        /**
         * Initialize auth system after database is ready
         *
         * Performs:
         * 0. Refuses boot on an OAuth redirect URI override off the web app origin,
         *    or on an authorization server issuer no client could use
         * 1. Ensures admin account exists (creates if missing)
         * 2. Initializes RBAC system with built-in + custom roles/permissions
         * 3. Initializes one-time token manager
         */
        afterInfrastructure: async () =>
        {
            // Deliberately here rather than synchronously beside configureDeviceAuth:
            // env is resolved at both points (startServer() calls loadEnv() before it
            // imports server.config.ts), but loadAndMergeConfig() catches a throw from
            // that import and continues on defaults — a refusal in the constructor
            // would leave the server listening without routes instead of refusing.
            // A throw here propagates out of initializeInfrastructure(), before
            // startHttpServer(), so the process exits without ever listening.
            assertOAuthRedirectUris();

            // Here and not beside configureAuthorizationServer above, for the
            // reason written one line up: a throw from the constructor is
            // swallowed by loadAndMergeConfig() and leaves the server listening
            // without routes, while a throw here propagates out of
            // initializeInfrastructure() and the process exits without ever
            // listening. Silent when no authorization server is configured.
            assertAuthorizationServerIssuer();

            await initializeAuth(options);
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
            initOneTimeTokenManager(options.oneTimeToken);
        },
    };
}
