/**
 * Account Status Repository
 *
 * The one statement that writes `users.status`.
 *
 * Deliberately not exported from the package entry (`repositories/index.ts`
 * leaves it out): an application changes an account's status through
 * `setAccountStatus`, which ends the account's sessions in the same
 * transaction. A repository method an application could call would change the
 * column and clear nothing — the defect that function exists to end.
 */

import { and, eq } from 'drizzle-orm';

import { users } from '../entities/users';
import { AccountStateRepository, type AccountWrites } from './account-state.repository';
import type { AccountStatusSource, UserStatus } from '../types';

export class AccountStatusRepository extends AccountStateRepository
{
    static override readonly accountWrites: AccountWrites<AccountStatusRepository> = {
        setStatus: { account: id => id },
    };

    /**
     * Move the account from `from` to `status`, in one conditional statement.
     * Write primary.
     *
     * The source status is part of the statement, not of a read before it: a
     * status another writer committed in between is not overwritten, it makes
     * this write match no row.
     *
     * @returns whether the account was in `from` (for `'any'`: whether it exists)
     */
    async setStatus(id: number, status: UserStatus, from: AccountStatusSource): Promise<boolean>
    {
        const result = await this.db
            .update(users)
            .set({ status })
            .where(from === 'any' ? eq(users.id, id) : and(eq(users.id, id), eq(users.status, from)))
            .returning({ id: users.id });

        return result.length > 0;
    }
}

export const accountStatusRepository = new AccountStatusRepository();
