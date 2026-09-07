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
 * Auth router for explicit registration
 *
 * @example
 * ```typescript
 * import { authRouter } from '@spfn/auth';
 * import { defineRouter } from '@spfn/core/route';
 *
 * export const appRouter = defineRouter({
 *   auth: authRouter,  // Mounted at /_auth/*
 *   // ... other routes
 * });
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

// ============================================================================
// Lifecycle Hooks
// ============================================================================

export { createAuthLifecycle } from './server/lifecycle';
export type { AuthLifecycleOptions, AuthLifecycleConfig } from './server/lifecycle';

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
    linkMailJob,
} from './server/jobs';

// ============================================================================
// Events
// ============================================================================

export {
    authLoginEvent,
    authRegisterEvent,
    authPasswordResetEvent,
    invitationCreatedEvent,
    invitationAcceptedEvent,
    authDeletionRequestedEvent,
    authDeletionCancelledEvent,
    authDeletionCompletedEvent,
    oauthUnlinkedEvent,
    AuthProviderSchema,
} from './server/events';

export type {
    AuthLoginPayload,
    AuthRegisterPayload,
    AuthPasswordResetPayload,
    InvitationCreatedPayload,
    InvitationAcceptedPayload,
    AuthDeletionRequestedPayload,
    AuthDeletionCancelledPayload,
    AuthDeletionCompletedPayload,
    OAuthUnlinkedPayload,
} from './server/events';
