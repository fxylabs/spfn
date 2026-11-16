/**
 * @spfn/auth - Second-Factor Attempt Budget Entity
 *
 * How many wrong second-factor proofs an account has had lately, and until when
 * it accepts none. One row per account that ever failed one, whatever route the
 * proof came through — `mfa/verify` for a new device, `mfa/step-up`, the TOTP
 * confirm — so repeating a sign-in, or moving to another route, buys no new
 * tries (au2-A2, au7-A2).
 *
 * The rule (`MFA_ATTEMPT_LIMIT` failures within any `MFA_ATTEMPT_WINDOW_MS`,
 * then `MFA_LOCK_MS` with no proof accepted) is kept by the statement that counts a
 * failure, not by code comparing a value it read: see
 * `MfaAttemptBudgetsRepository.spendFailure`.
 */

import { foreignKey, utcTimestamp } from '@spfn/core/db';
import { users } from './users';
import { authSchema } from './schema';

/** Wrong proofs an account may give within any `MFA_ATTEMPT_WINDOW_MS` before it is locked. */
export const MFA_ATTEMPT_LIMIT = 5;

/** The trailing window failures are counted in: the last fifteen minutes, whenever "now" is. */
export const MFA_ATTEMPT_WINDOW_MS = 15 * 60_000;

/** How long no second-factor proof is accepted, from the failure that reached the limit. */
export const MFA_LOCK_MS = 15 * 60_000;

export const mfaAttemptBudgets = authSchema.table('mfa_attempt_budgets',
    {
        // One budget per account, so the account is the key.
        userId: foreignKey('user', () => users.id).primaryKey(),

        // When the account's recent wrong proofs were counted: those inside the
        // trailing window as of the last one, at most `MFA_ATTEMPT_LIMIT`. Each
        // failure drops the ones the window has passed, so the count is always
        // "failures in the last fifteen minutes" — never a block that starts at
        // its first failure and lets a burst on either side of its edge through.
        failedAt: utcTimestamp('failed_at').array().notNull(),

        // Set by the failure that reached the limit, and only by it: until this
        // moment no proof is accepted, right or wrong, and no failure is
        // counted. null while the account is under the limit.
        lockedUntil: utcTimestamp('locked_until'),
    },
);

// Type exports
export type MfaAttemptBudget = typeof mfaAttemptBudgets.$inferSelect;
