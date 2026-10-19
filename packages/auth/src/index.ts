// ============================================================================
// API Client
// ============================================================================

import { createApi } from '@spfn/core/nextjs';
import type { ApiConfig, Client } from '@spfn/core/nextjs';
import type { ErrorRegistryInput } from '@spfn/core/errors';
import { mainAuthRouter } from './server/routes';
import { authErrorRegistry } from './errors';

// ============================================================================
// Route Map (for RPC proxy)
// ============================================================================

export { routeMap as authRouteMap } from './generated/route-map';

/** The typed auth client: what `authApi` is and what `createAuthApi` returns. */
export type AuthApi = Client<typeof mainAuthRouter>;

/**
 * `createApi`'s configuration for the auth client
 *
 * `errorRegistry` takes an array only. `createApi` merges its core error registry
 * into an array, but a bare `ErrorRegistry` instance replaces that default instead —
 * the core HTTP errors (`NotFoundError`, …) would then no longer be restored.
 */
export type AuthApiConfig = Omit<ApiConfig, 'errorRegistry'> & { errorRegistry?: ErrorRegistryInput[] };

/**
 * Builds the auth client with the app's configuration; auth's error classes are always registered
 *
 * `authErrorRegistry` is registered last: the registry keys classes by name and a later
 * registration wins, so an auth error body restores the auth class even when an app
 * class carries the same name.
 *
 * @example
 * ```typescript
 * import { createAuthApi } from '@spfn/auth';
 *
 * export const authApi = createAuthApi({
 *     onOutcome: (outcome) => setServerStatus(outcome.ok ? 'up' : outcome.errorType),
 *     errorRegistry: [appErrorRegistry],
 * });
 * ```
 */
export function createAuthApi(config: AuthApiConfig = {}): AuthApi
{
    return createApi<typeof mainAuthRouter>({
        ...config,
        errorRegistry: [...(config.errorRegistry ?? []), authErrorRegistry],
    });
}

/**
 * Type-safe API client for auth routes, built with no app configuration
 *
 * Give the client your own hooks with `createAuthApi(config)`.
 *
 * @example
 * ```typescript
 * import { authApi } from '@spfn/auth';
 *
 * // Get current session
 * const session = await authApi.getAuthSession.call({});
 *
 * // Login
 * const result = await authApi.login.call({
 *     body: { email, password, fingerprint, publicKey, keyId }
 * });
 * ```
 */
export const authApi = createAuthApi();

// Router type for external use
export type AuthRouter = typeof mainAuthRouter;

// ============================================================================
// RBAC (Roles, Permissions, Types)
// ============================================================================

export type { AuthSession, UserProfile, ProfileInfo } from './lib';
export { UUID_PATTERN, EMAIL_PATTERN, BASE64_PATTERN, FINGERPRINT_PATTERN, PHONE_PATTERN } from './lib';
export * from './server/rbac';

// OAuth error redirect reason codes (#126) — `reason=` on the error URL
export { OAUTH_ERROR_REASONS, isOAuthErrorReason, type OAuthErrorReason } from './lib/oauth-error-reason';

// ============================================================================
// Types & Constants (Single Source of Truth)
// ============================================================================

// Export all types from types.ts
export type * from './server/types';

// Export runtime constants for validation and type narrowing
export {
    KEY_ALGORITHM,
    INVITATION_STATUSES,
    USER_STATUSES,
    SOCIAL_PROVIDERS,
    ACCOUNT_DELETION_REQUEST_STATUSES,
    ACCOUNT_DELETION_REQUESTED_BY,
    PURGE_STRATEGIES,
} from './server/types';

// Export verification types & constants from schema.ts (single source of truth)
export type { VerificationTargetType, VerificationPurpose } from './server/routes/schema';
export {
    VERIFICATION_TARGET_TYPES,
    VERIFICATION_PURPOSES,
} from './server/routes/schema';
