/**
 * Tenant conditions
 *
 * The checks and predicates TenantRepository puts in front of every query.
 *
 * @internal
 */

import { and, eq, getTableName } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { findTenantColumn, type TenantColumnRef } from './registry';

/** A condition argument as drizzle's `where` and join `on` accept it. */
export type ConditionInput = SQL | undefined | ((...args: any[]) => SQL | undefined);

/**
 * Reject anything that is not a positive safe integer before a query runs —
 * `eq(column, undefined)` would otherwise bind NULL and quietly match nothing.
 */
export function assertTenantId(tenantId: unknown): asserts tenantId is number
{
    if (typeof tenantId !== 'number' || !Number.isSafeInteger(tenantId) || tenantId <= 0)
    {
        throw new TypeError(`Tenant id must be a positive safe integer, received ${String(tenantId)}`);
    }
}

/** The tenant column of `table`, or an error when the table has none. */
export function requireTenantColumn(table: PgTable): TenantColumnRef
{
    const ref = findTenantColumn(table);

    if (!ref)
    {
        throw new Error(
            `Table "${getTableName(table)}" has no tenantKey() column; TenantRepository methods take tenant-aware tables only`,
        );
    }

    return ref;
}

/** `table.tenant = tenantId` for a tenant-aware table; throws for any other. */
export function tenantCondition(table: PgTable, tenantId: number): SQL
{
    return eq(requireTenantColumn(table).column, tenantId);
}

/** `table.tenant = tenantId` when `table` is tenant-aware, otherwise undefined. */
export function optionalTenantCondition(table: unknown, tenantId: number): SQL | undefined
{
    const ref = findTenantColumn(table);

    return ref ? eq(ref.column, tenantId) : undefined;
}

/**
 * `condition AND extra`, keeping drizzle's callback form when the caller used it.
 */
export function withCondition(condition: ConditionInput, extra: SQL | undefined): ConditionInput
{
    if (!extra)
    {
        return condition;
    }

    if (typeof condition === 'function')
    {
        return (...args: any[]) => and(condition(...args), extra);
    }

    return condition ? and(condition, extra) : extra;
}
