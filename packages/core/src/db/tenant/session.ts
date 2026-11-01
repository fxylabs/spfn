/**
 * Where a TenantRepository query runs (rules R1–R6)
 *
 * Every TenantRepository method hands its query to `runTenantQuery` together
 * with the tables it reads or writes:
 *
 * | Situation                                   | The query runs                                   |
 * | ------------------------------------------- | ------------------------------------------------ |
 * | R6 a guard authorized another tenant        | nowhere — TenantMismatchError                    |
 * | R5 transaction bound to another tenant      | nowhere — TenantMismatchError                    |
 * | R3/R4 inside a transaction, tenancy table   | in it, after binding it to the tenant if unbound |
 * | inside a transaction, `tenantKey()` only    | in it, unbound (part 1)                          |
 * | R1 no transaction, read, tenancy table      | in a short `READ ONLY` transaction on the read DB |
 * | R2 no transaction, write, tenancy table     | in a short transaction on the write DB           |
 * | no transaction, `tenantKey()` only          | on the read or write DB directly (part 1)        |
 *
 * The short transaction sets `app.tenant_id` with `set_config(..., true)` and
 * ends with the query. It never enters the ambient transaction context, so it
 * has no hooks, nothing nests in it, and code after the query sees no
 * transaction. That is why the query receives its database as an argument here:
 * this is the one place it must not come from the context.
 *
 * @internal
 */

import type { PgTable } from 'drizzle-orm/pg-core';
import { getTransactionContext } from '../transaction/context';
import { assertTransactionTenant, claimTransactionTenant, setTenantSetting } from '../transaction/tenant';
import { assertTenantId } from './condition';
import { findTenancyMarker } from './registry';
import { assertRequestTenant } from './request-scope';

/** Whether the query reads only, which sends it to the read database. */
export type TenantAccess = 'read' | 'write';

/** The part of a drizzle database the short transaction needs. */
interface TransactionOpener
{
    transaction(run: (tx: any) => Promise<unknown>, config?: { accessMode: 'read only' }): Promise<unknown>;
}

/**
 * Run `query` for `tenantId` under rules R1–R6.
 *
 * @param outside - the database to use when no transaction is open: the
 *   repository's `readDb` for a read, its `db` for a write
 */
export async function runTenantQuery<TDb, TResult>(
    access: TenantAccess,
    tenantId: number,
    tables: readonly PgTable[],
    outside: TDb,
    query: (db: TDb) => PromiseLike<TResult>,
): Promise<TResult>
{
    assertTenantId(tenantId);
    assertRequestTenant(tenantId);

    const isolated = tables.some((table) => findTenancyMarker(table) !== undefined);
    const context = getTransactionContext();

    if (context)
    {
        await (isolated ? claimTransactionTenant(context, tenantId) : assertTransactionTenant(context, tenantId));

        return query(context.tx as TDb);
    }

    if (!isolated)
    {
        return query(outside);
    }

    return runShortTransaction(access, tenantId, outside as unknown as TransactionOpener, query as (db: unknown) => PromiseLike<TResult>);
}

async function runShortTransaction<TResult>(
    access: TenantAccess,
    tenantId: number,
    database: TransactionOpener,
    query: (db: unknown) => PromiseLike<TResult>,
): Promise<TResult>
{
    const result = await database.transaction(async (tx) =>
    {
        await setTenantSetting(tx, tenantId);

        return query(tx);
    }, access === 'read' ? { accessMode: 'read only' } : undefined);

    return result as TResult;
}
