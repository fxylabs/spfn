/**
 * @spfn/auth - Second-Factor Verification Entity
 *
 * When each credential last proved the account's second factor. One row per
 * credential, which is what makes the step-up window mean "this device,
 * recently" rather than "somebody, somewhere, recently".
 *
 * The credential is the one a session presents and a procedure stamp records
 * (`lib/deferred-stamp.ts`): a device key by its key id, or an application's
 * auth profile by its name and the key id its verifier reported. Exactly one of
 * the two is set:
 *
 * - `key_id` for a device key: a foreign key onto `user_public_keys.key_id`, so
 *   the row dies with the device it belongs to — a revoked key cannot leave a
 *   verification behind for the next key that reuses its id, and deleting an
 *   account takes these with it. A rotation is the one moment the row moves
 *   rather than dying: rotating is already proof of the same device, so
 *   `rotateKeyService` and the login rotation carry the verification across.
 * - `profile` and `profile_key_id` for an application profile, whose key id is
 *   the verifier's and has no row in `user_public_keys`. A profile reporting a
 *   device key's id is still the profile: its record never lands on that key.
 */

import { sql } from 'drizzle-orm';
import { check, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { enumText, foreignKey, id, utcTimestamp } from '@spfn/core/db';
import { users } from './users';
import { userPublicKeys } from './user-public-keys';
import { authSchema } from './schema';

/**
 * Which credential satisfied the step-up.
 *
 * Recorded for the owner-facing audit an app may build on it, and for support:
 * "recovery" is the one that should be rare, and an account stepping up with
 * recovery codes repeatedly has lost its authenticator.
 */
export const MFA_VERIFICATION_METHODS = ['totp', 'recovery', 'passkey'] as const;

export type MfaVerificationMethod = typeof MFA_VERIFICATION_METHODS[number];

export const mfaVerifications = authSchema.table('mfa_verifications',
    {
        id: id(),

        userId: foreignKey('user', () => users.id),

        // The device key that proved it; null for an application profile.
        keyId: text('key_id')
            .references(() => userPublicKeys.keyId, { onDelete: 'cascade' }),

        // The application profile that proved it, and the key id its verifier
        // reported; both null for a device key.
        profile: text('profile'),
        profileKeyId: text('profile_key_id'),

        method: enumText('method', MFA_VERIFICATION_METHODS).notNull(),

        verifiedAt: utcTimestamp('verified_at').notNull().defaultNow(),
    },
    (table) => [
        // A credential has one most recent verification and nothing older is of
        // any interest. Device keys are unique across accounts; a profile's key
        // id is only the verifier's, so it is scoped to the account.
        uniqueIndex('mfa_verifications_key_id_idx').on(table.keyId),
        uniqueIndex('mfa_verifications_profile_idx').on(table.userId, table.profile, table.profileKeyId),

        check('mfa_verifications_one_credential', sql`(${table.keyId} IS NULL) = (${table.profile} IS NOT NULL)
            AND (${table.profile} IS NULL) = (${table.profileKeyId} IS NULL)`),
    ],
);

// Type exports
export type MfaVerification = typeof mfaVerifications.$inferSelect;
export type NewMfaVerification = typeof mfaVerifications.$inferInsert;
