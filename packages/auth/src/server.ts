/**
 * @spfn/auth/server
 *
 * Server-side Only Module
 * 서버 전용 모듈 (서버 컴포넌트 + 백엔드)
 *
 * Includes:
 * - Routes (auth endpoints)
 * - Repositories (user, verification-code)
 * - Helpers (jwt, password)
 * - Middleware (authenticate, requirePermissions, requireRole)
 * - Services (auth, verification, key, user, rbac, permission, role)
 * - RBAC (roles, permissions, types)
 * - Setup functions
 *
 * @note This module should only be imported in server-side code
 */

// ============================================================================
// Router
// ============================================================================
import '@spfn/auth/config';

/**
 * Auth router, serving `/_auth/*`
 *
 * Mount it with `.packages()`. As a plain entry (`auth: authRouter`) it is
 * served at the same paths, but its routes become the app's own to `AppRouter`
 * and the generated route map. It is defined with `packageName: '@spfn/auth'`,
 * so registration refuses a middleware declaring `skips` (`optionalAuth`,
 * `machineAuth`, …) at or above it — `authRouter.use([...])` included —
 * however it is mounted: its signed-in routes rely on the app's
 * `authenticate`.
 *
 * @example
 * ```typescript
 * import { authRouter, authenticate } from '@spfn/auth/server';
 * import { defineRouter } from '@spfn/core/route';
 *
 * export const appRouter = defineRouter({
 *   // ... app routes
 * })
 * .packages([authRouter])
 * .use([authenticate]);
 * ```
 */
export { mainAuthRouter as authRouter } from './server/routes/index.js';

// ============================================================================
// Services (Business Logic)
// ============================================================================

export * from './server/services/index';

// ============================================================================
// Repositories (DB access)
// ============================================================================

export * from './server/repositories/index';

// ============================================================================
// Helpers (JWT, Password)
// ============================================================================

export * from './server/helpers/index';

// ============================================================================
// Middleware
// ============================================================================

export * from './server/middleware/index';
export * from './server/entities';

// ============================================================================
// Types, Constants & Schemas
// ============================================================================

export * from './server/types';
export * from './server/routes/schema';  // TypeBox schemas for validation
export * from './server/lib';
export * from './server/logger';
// `buildOAuthErrorUrl(error, reason)` takes one of these (#126)
export { OAUTH_ERROR_REASONS, isOAuthErrorReason, type OAuthErrorReason } from './lib/oauth-error-reason';
export { OAUTH_LINK_OUTCOMES, isOAuthLinkOutcome, type OAuthLinkOutcome } from './lib/oauth-link-outcome';

// ============================================================================
// Lifecycle Hooks
// ============================================================================

export { createAuthLifecycle } from './server/lifecycle';
export type { AuthLifecycleOptions, AuthLifecycleConfig } from './server/lifecycle';
export type { AuthChannel, AuthChannelsOptions } from './server/lib/channels-config';
export type {
    SignInAdmission,
    SignInAttempt,
    SignInChannel,
    SignInFailureReason,
    SignInGuardOptions,
    SignInIdentifier,
    SignInOutcome,
    SignInStage,
} from './server/lib/sign-in-guard';
export type {
    PasswordChangeAdmission,
    PasswordChangeAttempt,
    PasswordChangeChannel,
    PasswordChangeGuardOptions,
} from './server/lib/password-change-guard';

// ============================================================================
// Jobs
// ============================================================================

/**
 * Register with `.jobs(authJobRouter)` in `server.config.ts` — job registration
 * is not automatic (see `server/jobs/deletion-purge.ts` for why). For a non-default
 * `deletion.purgeCron`, use `createAuthJobRouter({ purgeCron })` instead. The
 * router carries the deletion purge sweep and `auth.link-mail`, which is how the
 * two link flows send their mail off the request path; register only one router.
 */
export {
    authJobRouter,
    createAuthJobRouter,
    createAuthDeletionJobRouter,
    createAuthDeletionPurgeJob,
    createRevokeAllTokenPurgeJob,
    DEFAULT_REVOKE_ALL_TOKEN_PURGE_CRON,
    linkMailJob,
} from './server/jobs';

// ============================================================================
// Events
// ============================================================================

export {
    authLoginEvent,
    authRegisterEvent,
    authPasswordResetEvent,
    authPasswordChangedEvent,
    authDeviceRegisteredEvent,
    passkeyEnrolledEvent,
    passkeyRevokedEvent,
    mfaLockedEvent,
    invitationCreatedEvent,
    invitationAcceptedEvent,
    authDeletionRequestedEvent,
    authDeletionCancelledEvent,
    authDeletionCompletedEvent,
    oauthUnlinkedEvent,
    oauthLinkedEvent,
    oauthLinkRemovedEvent,
    AuthProviderSchema,
} from './server/events';

export type {
    AuthLoginPayload,
    AuthRegisterPayload,
    AuthPasswordResetPayload,
    AuthPasswordChangedPayload,
    AuthDeviceRegisteredPayload,
    DeviceRegistrationChannel,
    PasskeyEnrolledPayload,
    PasskeyRevokedPayload,
    MfaLockedPayload,
    InvitationCreatedPayload,
    InvitationAcceptedPayload,
    AuthDeletionRequestedPayload,
    AuthDeletionCancelledPayload,
    AuthDeletionCompletedPayload,
    OAuthUnlinkedPayload,
    OAuthLinkedPayload,
    OAuthLinkRemovedPayload,
} from './server/events';
