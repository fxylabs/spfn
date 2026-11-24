/**
 * @spfn/auth - the account lock refuses to be taken outside a transaction (#494)
 *
 * Outside a transaction `usersRepository.lockAccount` used to run anyway: the
 * row lock ended with its own statement, its bounded wait never reached the
 * `SELECT`, and nothing said so. It now refuses before any statement, in every
 * run.
 *
 * | Row | Checks | Unnoticed without it |
 * | --- | --- | --- |
 * | T3 | with no transaction and the lock assertion off, as in production, `lockAccount(id)` of a known account and `lockAccountByEmailOrPhone` of an email no account has both reject `AccountLockOutsideTransactionError`, and no statement reached the database | the refusal gated back behind the test-only assertion (production locks for one statement again, silently), or placed after the first statement for an unknown identifier — which would tell a known identifier from an unknown one |
 *
 * No secret here is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { users } from '@/server/entities';

const { getDatabase } = await import('@spfn/core/db');
const { usersRepository, AccountLockOutsideTransactionError } = await import('@/server/repositories');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

describe.skipIf(!dbAvailable)('the account lock outside a transaction (#494)', () =>
{
    let userId: number;

    beforeAll(async () =>
    {
        await setupTestDb();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();

        const [row] = await getTestDb().insert(users).values({
            email: 'owner@outside-transaction494.test',
            roleId: (await getRoleByName('user'))!.id,
        }).returning({ id: users.id });
        userId = Number(row!.id);

        // As in production: the refusal must not depend on the test-only assertion.
        vi.stubEnv('SPFN_AUTH_ASSERT_ACCOUNT_LOCK', '0');
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    /** Every statement the lock could send with no transaction open goes through the write instance. */
    function watchStatements()
    {
        const write = getDatabase('write')!;

        return [vi.spyOn(write, 'execute'), vi.spyOn(write, 'select')];
    }

    it('T3: lockAccount and lockAccountByEmailOrPhone refuse before any statement', async () =>
    {
        const statements = watchStatements();

        await expect(usersRepository.lockAccount(userId)).rejects.toBeInstanceOf(AccountLockOutsideTransactionError);
        await expect(usersRepository.lockAccountByEmailOrPhone('nobody@outside-transaction494.test'))
            .rejects.toBeInstanceOf(AccountLockOutsideTransactionError);

        statements.forEach(statement => expect(statement).not.toHaveBeenCalled());
    });
});
