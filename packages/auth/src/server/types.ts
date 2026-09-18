/**
 * @spfn/auth - Shared Types
 *
 * Common types and constants used across the auth package
 */

/**
 * Supported JWT signature algorithms
 *
 * - ES256: ECDSA with P-256 and SHA-256 (recommended, smaller keys)
 * - RS256: RSA with SHA-256 (fallback, larger keys)
 */
export const KEY_ALGORITHM = ['ES256', 'RS256'] as const;

/**
 * Key algorithm type derived from the const array
 */
export type KeyAlgorithmType = typeof KEY_ALGORITHM[number];

/**
 * Where a registered key lives, as the client declares it.
 *
 * Only for telling one entry apart from another in the key list — nothing is
 * authorized or refused by it, so a client that lies gains nothing. Stored via
 * `enumText`, so adding a value here needs no migration.
 */
export const KEY_PLATFORM = ['ios', 'android', 'web', 'desktop'] as const;

/**
 * Key platform type derived from the const array
 */
export type KeyPlatformType = typeof KEY_PLATFORM[number];

/** Longest device label accepted at registration, and what the list returns. */
export const KEY_DEVICE_NAME_MAX_LENGTH = 64;

/**
 * Whether a session's device key is tied to something that cannot be copied out
 * of the browser.
 *
 * `'none'` is every session this package issued before #97: a key that lives
 * ninety days, sealed inside the cookie, so a copy of that cookie signs exactly
 * as the original does for as long as the key lasts. `'passkey'` is the opt-in —
 * a key that lives hours instead, which only a fresh WebAuthn assertion may
 * replace, so the copy stops working at the first renewal.
 *
 * The same two values name the account setting (`users.session_binding`) and the
 * fact recorded on one key row (`user_public_keys.binding`). They are one list
 * because a key is bound exactly when the account that owns it asked for it, and
 * a second vocabulary would only invite the two to drift.
 *
 * Server-decided, always. Nothing on a request body chooses it — see
 * `registerPublicKeyService`.
 */
export const SESSION_BINDINGS = ['none', 'passkey'] as const;

/**
 * Session binding type derived from the const array
 */
export type SessionBindingType = typeof SESSION_BINDINGS[number];

/**
 * Invitation status enum values
 * Single source of truth for all invitation statuses
 */
export const INVITATION_STATUSES = ['pending', 'accepted', 'expired', 'cancelled'] as const;

/**
 * Invitation status type derived from the const array
 */
export type InvitationStatus = typeof INVITATION_STATUSES[number];

/**
 * User status enum values
 * Single source of truth for all user statuses
 *
 * - active: Normal operation (default)
 * - inactive: Deactivated (user request, dormant)
 * - suspended: Locked (security incident, ToS violation)
 * - pending_deletion: Deletion requested, within the grace period (recoverable)
 * - deleted: Grace period elapsed and the account was purged (anonymize mode only —
 *   hard-delete removes the row instead, so this status never appears for it)
 */
export const USER_STATUSES = ['active', 'inactive', 'suspended', 'pending_deletion', 'deleted'] as const;

/**
 * User status type derived from the const array
 */
export type UserStatus = typeof USER_STATUSES[number];

/**
 * Social provider enum values
 * Single source of truth for supported OAuth providers
 */
export const SOCIAL_PROVIDERS = ['google', 'apple', 'github', 'kakao', 'naver', 'superself'] as const;

/**
 * Social provider type derived from the const array
 */
export type SocialProvider = typeof SOCIAL_PROVIDERS[number];

/**
 * Account deletion request status enum values
 * Single source of truth for `account_deletion_requests.status`
 *
 * - pending: Awaiting the grace period (or immediate purge)
 * - cancelled: User (or admin) recovered the account before purge
 * - completed: The purge ran (row is kept as an audit record, never deleted)
 */
export const ACCOUNT_DELETION_REQUEST_STATUSES = ['pending', 'cancelled', 'completed'] as const;

/**
 * Account deletion request status type derived from the const array
 */
export type AccountDeletionRequestStatus = typeof ACCOUNT_DELETION_REQUEST_STATUSES[number];

/**
 * Who initiated an account deletion request
 */
export const ACCOUNT_DELETION_REQUESTED_BY = ['self', 'admin'] as const;

/**
 * Account deletion requester type derived from the const array
 */
export type AccountDeletionRequestedBy = typeof ACCOUNT_DELETION_REQUESTED_BY[number];

/**
 * Purge strategy enum values
 *
 * - anonymize: Scrub PII, keep the row (status becomes 'deleted') — default
 * - hard-delete: Physically remove the `users` row (cascades to child rows)
 */
export const PURGE_STRATEGIES = ['anonymize', 'hard-delete'] as const;

/**
 * Purge strategy type derived from the const array
 */
export type PurgeStrategy = typeof PURGE_STRATEGIES[number];
