/**
 * Account-Exists Notices Repository
 *
 * The dedupe window of the "account already exists" notice, one row per
 * folded address. See the entity for why it is not a verification code.
 */

import { BaseRepository } from '@spfn/core/db';
import { eq, lte } from 'drizzle-orm';
import { accountExistsNotices } from '../entities/account-exists-notices';

export class AccountExistsNoticesRepository extends BaseRepository
{
    /**
     * Open a new notice window for `target` unless one is still running.
     *
     * One statement, so two signups racing on the same address cannot both
     * win: the insert takes an address never noticed, the conditional update
     * one whose window ended, and either way the row is returned only to the
     * caller that moved it.
     *
     * @returns Whether this caller opened the window and so sends the notice
     */
    async claimWindow(target: string, windowMs: number): Promise<boolean>
    {
        const now = new Date();
        const claimed = await this.db
            .insert(accountExistsNotices)
            .values({ target, sentAt: now })
            .onConflictDoUpdate({
                target: accountExistsNotices.target,
                set: { sentAt: now },
                setWhere: lte(accountExistsNotices.sentAt, new Date(now.getTime() - windowMs)),
            })
            .returning({ target: accountExistsNotices.target });

        return claimed.length > 0;
    }

    /** Forget an address — what purging the account it belongs to means. */
    async deleteByTarget(target: string): Promise<void>
    {
        await this.db.delete(accountExistsNotices).where(eq(accountExistsNotices.target, target));
    }
}

export const accountExistsNoticesRepository = new AccountExistsNoticesRepository();
