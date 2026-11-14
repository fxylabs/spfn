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

import { BaseRepository, type RepositoryDatabase } from '@spfn/core/db';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { and, eq, inArray, isNotNull, isNull, max, ne } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/pg-core';

import { mfaRecoveryCodes } from '../entities/mfa-recovery-codes';
import { mfaTotp } from '../entities/mfa-totp';
import { passkeys } from '../entities/passkeys';

/** The handle a read goes through: the replica-or-transaction one, or the primary. */
type Source = RepositoryDatabase<PostgresJsDatabase>;

/** Which methods count, as the second-factor policy lists them. */
export interface EnrolmentMethods
{
    totp: boolean;
    passkey: boolean;
}

export class MfaEnrolmentRepository extends BaseRepository
{
    /** Whether the account has a confirmed TOTP or a live second-factor passkey. */
    async isEnrolled(userId: number): Promise<boolean>
    {
        return await this.enrolledIn(this.readDb, userId, { totp: true, passkey: true });
    }

    /**
     * Whether the account has a second factor of one of the given methods.
     *
     * Both methods is `isEnrolled`, the same one statement; one method is that
     * method's half alone, still one statement. None is false without a query.
     */
    async isEnrolledIn(userId: number, methods: EnrolmentMethods): Promise<boolean>
    {
        return await this.enrolledIn(this.readDb, userId, methods);
    }

    /**
     * `isEnrolledIn` against the write primary, for the per-request admission:
     * a session that enrolled a moment ago must be admitted on its next request,
     * which a lagging replica would refuse.
     */
    async isEnrolledInOnPrimary(userId: number, methods: EnrolmentMethods): Promise<boolean>
    {
        return await this.enrolledIn(this.db, userId, methods);
    }

    private async enrolledIn(source: Source, userId: number, methods: EnrolmentMethods): Promise<boolean>
    {
        if (!methods.totp && !methods.passkey)
        {
            return false;
        }

        const totp = this.confirmedTotp(userId, source);
        const passkey = this.liveSecondFactorPasskeys(userId, undefined, source);
        const query = methods.totp && methods.passkey ? unionAll(totp, passkey) : methods.totp ? totp : passkey;

        return (await query.limit(1)).length > 0;
    }

    /**
     * Whether a listed second factor other than one passkey remains — what the
     * removal of that passkey's mark, or of the passkey, would leave.
     */
    async hasListedFactorBesides(
        userId: number,
        passkeyId: number,
        methods: EnrolmentMethods,
    ): Promise<boolean>
    {
        const otherPasskeys = this.liveSecondFactorPasskeys(userId, passkeyId);

        if (!methods.totp)
        {
            return methods.passkey && (await otherPasskeys.limit(1)).length > 0;
        }

        const rows = methods.passkey
            ? await unionAll(this.confirmedTotp(userId), otherPasskeys).limit(1)
            : await this.confirmedTotp(userId).limit(1);

        return rows.length > 0;
    }

    private confirmedTotp(userId: number, source: Source = this.readDb)
    {
        return source
            .select({ owner: mfaTotp.userId })
            .from(mfaTotp)
            .where(and(eq(mfaTotp.userId, userId), isNotNull(mfaTotp.confirmedAt)));
    }

    /** The other half of the union, as its own read for `status` to reuse. */
    private liveSecondFactorPasskeys(userId: number, exceptPasskeyId?: number, source: Source = this.readDb)
    {
        return source
            .select({ owner: passkeys.userId })
            .from(passkeys)
            .where(and(
                eq(passkeys.userId, userId),
                eq(passkeys.secondFactor, true),
                isNull(passkeys.revokedAt),
                exceptPasskeyId === undefined ? undefined : ne(passkeys.id, exceptPasskeyId),
            ));
    }

    /**
     * Whether the account holds a credential it could prove itself with,
     * whatever the policy lists: a live passkey, marked or not; a confirmed
     * TOTP; and, when `recoveryCodes`, an unspent code of the current
     * generation. One statement, on the write primary — the enrolment gate
     * reads it after taking the owner row's lock.
     */
    async holdsProofCredentialOnPrimary(userId: number, recoveryCodes: boolean): Promise<boolean>
    {
        const held = unionAll(this.confirmedTotp(userId, this.db), this.livePasskeys(userId));
        const query = recoveryCodes ? unionAll(held, this.unspentRecoveryCodes(userId)) : held;

        return (await query.limit(1)).length > 0;
    }

    private livePasskeys(userId: number)
    {
        return this.db
            .select({ owner: passkeys.userId })
            .from(passkeys)
            .where(and(eq(passkeys.userId, userId), isNull(passkeys.revokedAt)));
    }

    /** Codes of an earlier generation are left unspent and verify nothing, so only the current one counts. */
    private unspentRecoveryCodes(userId: number)
    {
        const currentGeneration = this.db
            .select({ generation: max(mfaRecoveryCodes.generation) })
            .from(mfaRecoveryCodes)
            .where(eq(mfaRecoveryCodes.userId, userId));

        return this.db
            .select({ owner: mfaRecoveryCodes.userId })
            .from(mfaRecoveryCodes)
            .where(and(
                eq(mfaRecoveryCodes.userId, userId),
                isNull(mfaRecoveryCodes.usedAt),
                inArray(mfaRecoveryCodes.generation, currentGeneration),
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
