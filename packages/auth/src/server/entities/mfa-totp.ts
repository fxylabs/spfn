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

        // The procedure stamp (`lib/deferred-stamp.ts`): the credential that
        // started this — a device key's id, or an application profile's name
        // and reported key id — and the account's key generation then.
        // Completion admits only that credential, of that generation, as the
        // account is now. null on a row written before the stamp existed —
        // refused at completion
        startedByKeyId: text('started_by_key_id'),
        startedByProfile: text('started_by_profile'),
        keyEpoch: integer('key_epoch'),

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
