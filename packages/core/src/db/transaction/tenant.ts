/**
 * The tenant of a transaction
 *
 * A tenancy table's row-level security policy compares each row with the
 * transaction-local setting `app.tenant_id`. This module sets it and records,
 * on the root transaction's context, which tenant it was set to:
 *
 * - `runInTransaction(fn, { tenant })` sets it right after the root `BEGIN`;
 * - otherwise the first TenantRepository call on a tenancy table sets it;
 * - a later call for another tenant throws before any SQL runs.
 *
 * `set_config(..., true)` is local to the transaction, so the setting ends with
 * it — COMMIT or ROLLBACK — and a pooled connection never carries it into the
 * next transaction. Inside a savepoint it is local to the savepoint as well:
 * `ROLLBACK TO` restores the previous value. `promoteTenantClaim` and
 * `discardTenantClaim` keep the record in step with that.
 *
 * @internal
 */

import { sql } from 'drizzle-orm';
import { TenantMismatchError } from '../tenant/errors';
import type { TransactionContext, TransactionTenant } from './context';

/** The setting the tenancy policy reads. */
export const TENANT_SETTING = 'app.tenant_id';

/** Anything that runs a statement: a database, a transaction, a savepoint. */
interface StatementRunner
{
    execute(query: ReturnType<typeof sql>): PromiseLike<unknown>;
}

/**
 * Set `app.tenant_id` for the rest of the transaction `db` runs in. Both values
 * are bound parameters; no SQL text is built from the tenant id.
 */
export async function setTenantSetting(db: StatementRunner, tenantId: number): Promise<void>
{
    await db.execute(sql`select set_config(${TENANT_SETTING}, ${String(tenantId)}, true)`);
}

/** Throw when the transaction is bound to a tenant other than `tenantId`. */
export function assertTransactionTenant(context: TransactionContext, tenantId: number): void
{
    const { id } = context.tenant;

    if (id !== null && id !== tenantId)
    {
        throw new TenantMismatchError(id, tenantId, 'transaction');
    }
}

/**
 * Bind the transaction to `tenantId` unless it already is, then wait until the
 * setting is in place.
 *
 * The record is written before the `set_config` is awaited, so a concurrent
 * call on the same transaction (`Promise.all`) sees it at once: one for the
 * same tenant waits on `ready`, one for another tenant throws.
 */
export async function claimTransactionTenant(context: TransactionContext, tenantId: number): Promise<void>
{
    const state = context.tenant;

    if (state.id === null)
    {
        state.id = tenantId;
        state.level = context.level;
        state.ready = setTenantSetting(context.tx, tenantId);
    }

    assertTransactionTenant(context, tenantId);

    await state.ready;
}

/**
 * A savepoint frame at `parentLevel + 1` resolved: a setting made inside it now
 * stands or falls with the parent.
 */
export function promoteTenantClaim(state: TransactionTenant, parentLevel: number): void
{
    if (state.level > parentLevel)
    {
        state.level = parentLevel;
    }
}

/**
 * A savepoint frame at `parentLevel + 1` rolled back: `ROLLBACK TO` undid a
 * setting made inside it, so the record is cleared and the next call sets it
 * again.
 */
export function discardTenantClaim(state: TransactionTenant, parentLevel: number): void
{
    if (state.id !== null && state.level > parentLevel)
    {
        state.id = null;
        state.level = 0;
        state.ready = Promise.resolve();
    }
}
