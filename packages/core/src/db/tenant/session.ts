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
 * `_selectOfUser(userId)` runs under the same rules with the user in place of
 * the tenant (U1–U5): `app.user_id` instead of `app.tenant_id`, a transaction
 * bound to another user refuses it, and no guard check — a read by person is
 * allowed whatever tenant the request was authorized for.
 *
 * The short transaction sets `app.tenant_id` (or `app.user_id`) with
 * `set_config(..., true)` and ends with the query. It never enters the ambient transaction context, so it
 * has no hooks, nothing nests in it, and code after the query sees no
 * transaction. That is why the query receives its database as an argument here:
 * this is the one place it must not come from the context.
 *
 * @internal
 */

import type { PgTable } from 'drizzle-orm/pg-core';
import { getTransactionContext } from '../transaction/context';
import { assertTransactionBinding, claimTransactionBinding, setBindingSetting } from '../transaction/tenant';
import { assertTenantId, assertUserId } from './condition';
import type { TenantBindingKey } from './errors';
import { findTenancyMarker } from './registry';
import { assertRequestTenant } from './request-scope';

/** Whether the query reads only, which sends it to the read database. */
export type TenantAccess = 'read' | 'write';

/** What a query is scoped to: a tenant (`app.tenant_id`) or a user (`app.user_id`). */
export interface QueryBinding
{
    readonly key: TenantBindingKey;
    readonly id: number;
}

/** The part of a drizzle database the short transaction needs. */
interface TransactionOpener
{
    transaction(run: (tx: any) => Promise<unknown>, config?: { accessMode: 'read only' }): Promise<unknown>;
}

/**
 * Run `query` for a tenant under rules R1–R6, or for a user under U1–U5.
 *
 * @param outside - the database to use when no transaction is open: the
 *   repository's `readDb` for a read, its `db` for a write
 */
export async function runTenantQuery<TDb, TResult>(
    access: TenantAccess,
    binding: QueryBinding,
    tables: readonly PgTable[],
    outside: TDb,
    query: (db: TDb) => PromiseLike<TResult>,
): Promise<TResult>
{
    assertBinding(binding);

    const isolated = tables.some((table) => findTenancyMarker(table) !== undefined);
    const context = getTransactionContext();

    if (context)
    {
        await (isolated
            ? claimTransactionBinding(context, binding.key, binding.id)
            : assertTransactionBinding(context, binding.key, binding.id));

        return query(context.tx as TDb);
    }

    if (!isolated)
    {
        return query(outside);
    }

    return runShortTransaction(access, binding, outside as unknown as TransactionOpener, query as (db: unknown) => PromiseLike<TResult>);
}

/** A valid id, and — for a tenant — the one the request's guard authorized, if any. */
function assertBinding(binding: QueryBinding): void
{
    if (binding.key === 'user')
    {
        assertUserId(binding.id);

        return;
    }

    assertTenantId(binding.id);
    assertRequestTenant(binding.id);
}

async function runShortTransaction<TResult>(
    access: TenantAccess,
    binding: QueryBinding,
    database: TransactionOpener,
    query: (db: unknown) => PromiseLike<TResult>,
): Promise<TResult>
{
    const result = await database.transaction(async (tx) =>
    {
        await setBindingSetting(tx, binding.key, binding.id);

        return query(tx);
    }, access === 'read' ? { accessMode: 'read only' } : undefined);

    return result as TResult;
}
