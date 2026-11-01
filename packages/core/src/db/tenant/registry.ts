/**
 * Tenant column registry
 *
 * `tenantKey()` registers its column here while drizzle builds the table. Two
 * readers depend on it:
 *
 * - TenantRepository finds a table's tenant column — through an `alias()` too,
 *   because an alias column forwards `config` to the column it aliases.
 * - The development query warning lists every tenant-aware table, so it can
 *   check hand-written SQL that TenantRepository never saw.
 *
 * Registration happens inside drizzle's column build step, which is internal to
 * drizzle 1.0.0-rc.4. tenant-registry.test.ts pins that behaviour.
 *
 * @internal
 */

import { getColumns, getTableName, isTable } from 'drizzle-orm';
import type { Column } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

const TABLE_SCHEMA = Symbol.for('drizzle:Schema');

/** A tenant-aware table, as the development query warning matches it in SQL. */
export interface TenantTableEntry
{
    readonly schema: string | undefined;
    readonly name: string;
    readonly columnName: string;
}

/** The tenant column of one table: its property key and the column itself. */
export interface TenantColumnRef
{
    readonly key: string;
    readonly column: Column;
}

const tenantColumnConfigs = new WeakSet<object>();
const tenantColumnByTable = new WeakMap<object, Column>();
const tenantTables = new Map<string, TenantTableEntry>();

/**
 * Record `column` as the tenant column of `table`.
 *
 * Called once per table while drizzle builds it. A second tenant column on the
 * same table throws, so the mistake surfaces when the schema module loads.
 */
export function registerTenantColumn(table: object, column: Column): void
{
    const name = getTableName(table as PgTable);

    if (tenantColumnByTable.has(table))
    {
        throw new Error(`Table "${name}" declares more than one tenantKey() column`);
    }

    const schema = (table as Record<symbol, string | undefined>)[TABLE_SCHEMA];

    tenantColumnByTable.set(table, column);
    tenantColumnConfigs.add(configOf(column));
    tenantTables.set(`${schema ?? ''}.${name}`, { schema, name, columnName: column.name });
}

/**
 * The tenant column of a table or table alias, or undefined for anything else —
 * a table without `tenantKey()`, a subquery, a view, raw SQL.
 */
export function findTenantColumn(table: unknown): TenantColumnRef | undefined
{
    if (!isTable(table))
    {
        return undefined;
    }

    const entry = Object.entries(getColumns(table) as Record<string, Column>)
        .find(([, column]) => tenantColumnConfigs.has(configOf(column)));

    return entry ? { key: entry[0], column: entry[1] } : undefined;
}

/** Every tenant-aware table defined so far in this process. */
export function listTenantTables(): TenantTableEntry[]
{
    return [...tenantTables.values()];
}

function configOf(column: Column): object
{
    return (column as unknown as { config: object }).config;
}
