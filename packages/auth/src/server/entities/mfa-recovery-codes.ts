/**
 * @spfn/auth - Recovery Codes Entity
 *
 * The ten single-use codes an enrolled account is shown once. Only the hash is
 * stored, and it is a **password** hash rather than the unsalted SHA-256 the
 * link flows use — a code a human transcribes is short enough that a leaked
 * dump of unsalted hashes falls to an offline sweep. `lib/recovery-codes.ts`
 * sets out the reasoning.
 *
 * Codes come in generations. Regenerating raises the generation rather than
 * deleting the old rows, so a code someone wrote down last year is refused with
 * the same body as one that never existed, and the history of which generation
 * a code was spent from survives.
 */

import { index, integer, text } from 'drizzle-orm/pg-core';
import { id, foreignKey, timestamps, utcTimestamp } from '@spfn/core/db';
import { users } from './users';
import { authSchema } from './schema';

export const mfaRecoveryCodes = authSchema.table('mfa_recovery_codes',
    {
        id: id(),

        userId: foreignKey('user', () => users.id),

        // Raised by one on every regeneration. Only the account's newest
        // generation is ever consulted.
        generation: integer('generation').notNull(),

        // bcrypt, from the package's password hasher. Never logged, and never
        // looked up by — verification walks the account's unused codes.
        codeHash: text('code_hash').notNull(),

        // Set by the call that spent it. Single use, for good.
        usedAt: utcTimestamp('used_at'),

        ...timestamps(),
    },
    (table) => [
        // Every read is "this account's codes of this generation". Not unique:
        // a hash is bcrypt, so two rows never collide, and a global uniqueness
        // constraint would be a rule about other accounts' codes.
        index('mfa_recovery_codes_user_generation_idx').on(table.userId, table.generation),
    ],
);

// Type exports
export type MfaRecoveryCode = typeof mfaRecoveryCodes.$inferSelect;
export type NewMfaRecoveryCode = typeof mfaRecoveryCodes.$inferInsert;
