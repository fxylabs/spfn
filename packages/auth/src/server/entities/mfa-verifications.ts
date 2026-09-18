/**
 * @spfn/auth - Second-Factor Verification Entity
 *
 * When each device last proved the account's second factor. One row per device
 * key, which is what makes the step-up window mean "this device, recently"
 * rather than "somebody, somewhere, recently".
 *
 * `key_id` is the primary key and a foreign key onto `user_public_keys.key_id`,
 * so the row dies with the device it belongs to — a revoked key cannot leave a
 * verification behind for the next key that reuses its id, and deleting an
 * account takes these with it. A rotation is the one moment the row moves
 * rather than dying: rotating is already proof of the same device, so
 * `rotateKeyService` and the login rotation carry the verification across, or
 * the window would silently expire every time the proxy rotated a key.
 */

import { text } from 'drizzle-orm/pg-core';
import { enumText, foreignKey, utcTimestamp } from '@spfn/core/db';
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
        // The device key that proved it. Primary key: a device has one most
        // recent verification and nothing older is of any interest.
        keyId: text('key_id')
            .primaryKey()
            .references(() => userPublicKeys.keyId, { onDelete: 'cascade' }),

        userId: foreignKey('user', () => users.id),

        method: enumText('method', MFA_VERIFICATION_METHODS).notNull(),

        verifiedAt: utcTimestamp('verified_at').notNull().defaultNow(),
    },
);

// Type exports
export type MfaVerification = typeof mfaVerifications.$inferSelect;
export type NewMfaVerification = typeof mfaVerifications.$inferInsert;
