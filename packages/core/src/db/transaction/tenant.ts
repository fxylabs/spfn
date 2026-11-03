/**
 * The tenant and the user of a transaction
 *
 * A tenancy table's row-level security policy compares each row with the
 * transaction-local setting `app.tenant_id`; a table declared with `visibleTo`
 * also admits the rows of the user in `app.user_id`. This module sets either
 * one and records, on the root transaction's context, which id it was set to.
 * The two are the same mechanism under two setting names — a binding:
 *
 * - `runInTransaction(fn, { tenant, user })` sets them right after the root `BEGIN`;
 * - otherwise the first TenantRepository call that needs one sets it
 *   (`_select(tenantId)` and its siblings the tenant, `_selectOfUser(userId)`
 *   the user);
 * - a later call for another id throws before any SQL runs.
 *
 * `set_config(..., true)` is local to the transaction, so the setting ends with
 * it — COMMIT or ROLLBACK — and a pooled connection never carries it into the
 * next transaction. Inside a savepoint it is local to the savepoint as well:
 * `ROLLBACK TO` restores the previous value. `promoteBindingClaims` and
 * `discardBindingClaims` keep the records in step with that.
 *
 * Inside a request `tenancy.guard()` authorized, the guard's tenant binds the
 * transaction as early as it can: a root transaction opened under the guard
 * without `{ tenant }` sets it right after its `BEGIN`
 * (`guardedTransactionTenant`), and a guard that runs inside an open, still
 * unbound transaction claims it (`claimTransactionForGuard`). A write a plain
 * BaseRepository sends — renaming the tenant in a `visibleThrough` tenant list —
 * then runs under the tenant without a TenantRepository call first. Both apply
 * only when the app has tenancy tables, so a `tenantKey()`-only app sends no
 * extra statement.
 *
 * The savepoint a setting lands in is the innermost one OPEN on the connection,
 * not the one the calling code runs in: a root-level call that runs beside a
 * nested `runInTransaction` (`Promise.all`) still sends its `set_config` into
 * that savepoint. So the runner reports every savepoint it opens
 * (`openBindingFrame`) and closes, and a claim records `openLevel`.
 *
 * @internal
 */

import { sql } from 'drizzle-orm';
import { TenantMismatchError, type TenantBindingKey } from '../tenant/errors';
import { listTenancyTables } from '../tenant/registry';
import { requestTenant } from '../tenant/request-scope';
import { getTransactionContext, type TransactionBinding, type TransactionContext } from './context';

/** The setting the tenancy policy reads. */
export const TENANT_SETTING = 'app.tenant_id';

/** The setting a `visibleTo` table's read policy, and a tenant list's, reads. */
export const USER_SETTING = 'app.user_id';

/** The setting each binding writes. */
const SETTINGS: Readonly<Record<TenantBindingKey, string>> = { tenant: TENANT_SETTING, user: USER_SETTING };

const BINDING_KEYS: readonly TenantBindingKey[] = ['tenant', 'user'];

/** Anything that runs a statement: a database, a transaction, a savepoint. */
interface StatementRunner
{
    execute(query: ReturnType<typeof sql>): PromiseLike<unknown>;
}

/**
 * Set the binding's setting for the rest of the transaction `db` runs in. Both
 * values are bound parameters; no SQL text is built from the id.
 */
export async function setBindingSetting(db: StatementRunner, key: TenantBindingKey, id: number): Promise<void>
{
    await db.execute(sql`select set_config(${SETTINGS[key]}, ${String(id)}, true)`);
}

/** Throw when the transaction is bound to an id other than `id` for `key`. */
export function assertTransactionBinding(context: TransactionContext, key: TenantBindingKey, id: number): void
{
    const bound = context[key].id;

    if (bound !== null && bound !== id)
    {
        throw new TenantMismatchError(bound, id, 'transaction', key);
    }
}

/**
 * Bind the transaction to `id` for `key` unless it already is, then wait until
 * the setting is in place.
 *
 * The record is written before the `set_config` is awaited, so a concurrent
 * call on the same transaction (`Promise.all`) sees it at once: one for the
 * same id waits on `ready`, one for another id throws.
 */
export async function claimTransactionBinding(context: TransactionContext, key: TenantBindingKey, id: number): Promise<void>
{
    const state = context[key];

    if (state.id === null)
    {
        state.id = id;
        state.level = state.openLevel;
        state.ready = setBindingSetting(context.tx, key, id);
    }

    assertTransactionBinding(context, key, id);

    await state.ready;
}

/**
 * The tenant a root transaction opened without `{ tenant }` binds to at BEGIN:
 * the one `tenancy.guard()` authorized the request for, when the app has
 * tenancy tables; otherwise none.
 */
export function guardedTransactionTenant(): number | undefined
{
    return listTenancyTables().length > 0 ? requestTenant() : undefined;
}

/**
 * Called by `tenancy.guard()` once it authorized `tenantId`: an open
 * transaction that is not bound to a tenant yet — `[Transactional(), guard]` —
 * is bound to it. One already bound is left alone; a TenantRepository call for
 * another tenant is refused by the guard check (R6) anyway.
 */
export async function claimTransactionForGuard(tenantId: number): Promise<void>
{
    const context = getTransactionContext();

    if (context && context.tenant.id === null && listTenancyTables().length > 0)
    {
        await claimTransactionBinding(context, 'tenant', tenantId);
    }
}

/**
 * A savepoint frame at `level` is about to open: from its SAVEPOINT on, a
 * setting made on the connection is local to it. Called before the SAVEPOINT is
 * sent, so a claim queued behind it is never recorded at the parent's level;
 * a SAVEPOINT that fails to open still settles through `discardBindingClaims`.
 */
export function openBindingFrame(context: TransactionContext, level: number): void
{
    for (const key of BINDING_KEYS)
    {
        context[key].openLevel = level;
    }
}

/**
 * A savepoint frame at `parentLevel + 1` resolved: a setting made inside it now
 * stands or falls with the parent.
 */
export function promoteBindingClaims(context: TransactionContext, parentLevel: number): void
{
    for (const key of BINDING_KEYS)
    {
        promoteClaim(context[key], parentLevel);
    }
}

/**
 * A savepoint frame at `parentLevel + 1` rolled back: `ROLLBACK TO` undid a
 * setting made inside it, so the record is cleared and the next call sets it
 * again.
 */
export function discardBindingClaims(context: TransactionContext, parentLevel: number): void
{
    for (const key of BINDING_KEYS)
    {
        discardClaim(context[key], parentLevel);
    }
}

function promoteClaim(state: TransactionBinding, parentLevel: number): void
{
    state.openLevel = parentLevel;

    if (state.level > parentLevel)
    {
        state.level = parentLevel;
    }
}

function discardClaim(state: TransactionBinding, parentLevel: number): void
{
    state.openLevel = parentLevel;

    if (state.id !== null && state.level > parentLevel)
    {
        state.id = null;
        state.level = 0;
        state.ready = Promise.resolve();
    }
}
