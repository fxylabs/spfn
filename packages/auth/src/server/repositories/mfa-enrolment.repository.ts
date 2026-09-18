/**
 * MFA Enrolment Repository
 *
 * One question, asked on every sensitive route and at every device
 * registration: does this account have a second factor at all?
 *
 * It spans two tables — a confirmed `mfa_totp` row, or at least one live passkey
 * the owner marked as a second factor — so it lives here rather than in either
 * table's repository, and it is deliberately **one** statement. `assertStepUp`
 * asks it first and returns immediately when the answer is no, so an account
 * that never enrolled pays one round trip against two indexed lookups
 * (`mfa_totp_user_id_idx`, unique, and `passkeys_user_id_idx`) and nothing else:
 * no second query, and no passkey configuration read.
 *
 * `UNION ALL ... LIMIT 1` rather than two `EXISTS` counts, so Postgres stops at
 * the first row either side produces. Both halves select `user_id` — a column
 * rather than a literal, so the two sides agree on a shape without a raw-SQL
 * alias, and the value is thrown away either way.
 */

import { BaseRepository } from '@spfn/core/db';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';

import { mfaTotp } from '../entities/mfa-totp';
import { passkeys } from '../entities/passkeys';

export class MfaEnrolmentRepository extends BaseRepository
{
    /** Whether the account has a confirmed TOTP or a live second-factor passkey. */
    async isEnrolled(userId: number): Promise<boolean>
    {
        const confirmedTotp = this.readDb
            .select({ owner: mfaTotp.userId })
            .from(mfaTotp)
            .where(and(eq(mfaTotp.userId, userId), isNotNull(mfaTotp.confirmedAt)));

        const rows = await unionAll(confirmedTotp, this.liveSecondFactorPasskeys(userId)).limit(1);

        return rows.length > 0;
    }

    /** The other half of the union, as its own read for `status` to reuse. */
    private liveSecondFactorPasskeys(userId: number)
    {
        return this.readDb
            .select({ owner: passkeys.userId })
            .from(passkeys)
            .where(and(
                eq(passkeys.userId, userId),
                eq(passkeys.secondFactor, true),
                isNull(passkeys.revokedAt),
            ));
    }

    /** Whether at least one live passkey is marked as a second factor. */
    async hasSecondFactorPasskey(userId: number): Promise<boolean>
    {
        const rows = await this.liveSecondFactorPasskeys(userId).limit(1);

        return rows.length > 0;
    }
}

// Default instance export
export const mfaEnrolmentRepository = new MfaEnrolmentRepository();
