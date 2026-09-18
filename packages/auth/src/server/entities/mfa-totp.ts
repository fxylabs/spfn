/**
 * @spfn/auth - TOTP Enrolment Entity
 *
 * One row per account that has started enrolling an authenticator app. The row
 * exists from the moment `totp/enroll` mints a secret; `confirmed_at` is what
 * turns it into a second factor, so an abandoned enrolment never gates anything
 * and is swept away a day later.
 *
 * `secret_enc` is the ciphertext `lib/mfa-cipher.ts` produces, bound to this
 * `user_id` by the AEAD's additional data. A row copied to another account does
 * not decrypt.
 */

import { bigint, integer, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, foreignKey, timestamps, utcTimestamp } from '@spfn/core/db';
import { users } from './users';
import { authSchema } from './schema';

/**
 * How many wrong codes an unconfirmed enrolment survives.
 *
 * Small, because the row is throwaway: five wrong codes means the person is
 * reading the wrong entry in their app, and starting over with a fresh secret
 * is both the remedy and the thing that resets the counter. A confirmed row is
 * never deleted this way — that would be a remote way to strip someone's second
 * factor.
 */
export const MFA_CONFIRM_ATTEMPT_LIMIT = 5;

export const mfaTotp = authSchema.table('mfa_totp',
    {
        id: id(),

        userId: foreignKey('user', () => users.id),

        // `enc:v2:<keyId>:<payload>` from lib/mfa-cipher.ts. Never logged.
        secretEnc: text('secret_enc').notNull(),

        // null while the first code is still outstanding. Non-null is what
        // `mfaEnrolled` reads, and what makes `enroll` a 409.
        confirmedAt: utcTimestamp('confirmed_at'),

        // The newest 30-second step this account has spent, so a code read off
        // the screen cannot be replayed inside its own window. Per account
        // rather than per device: the cost is that a second device signing in
        // within the same step is refused and retries on the next one.
        lastUsedStep: bigint('last_used_step', { mode: 'number' }),

        // Wrong codes against the unconfirmed row. Reset by a fresh `enroll`.
        failedConfirmAttempts: integer('failed_confirm_attempts').notNull().default(0),

        ...timestamps(),
    },
    (table) => [
        // One enrolment per account — a second row would be a second secret
        // nobody could tell apart from the first.
        uniqueIndex('mfa_totp_user_id_idx').on(table.userId),
    ],
);

// Type exports
export type MfaTotp = typeof mfaTotp.$inferSelect;
export type NewMfaTotp = typeof mfaTotp.$inferInsert;
