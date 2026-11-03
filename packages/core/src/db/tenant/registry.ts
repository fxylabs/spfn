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
 * `tenancy.table` adds a second record: the table is a tenancy table, whose
 * row-level security policy TenantRepository must set the tenant for, and the
 * tenancy boot check inspects. A tenancy table declared with `visibleTo` also
 * records its user column. A `tenantList({ visibleThrough })` table joins the
 * boot check's list without being a tenancy table: it has a policy, but no
 * tenant column and no marker.
 *
 * Besides these per-process maps, the tenant column and a tenancy table carry
 * `Symbol.for(...)` markers. A tool that loads the app's schema through a
 * different copy of `@spfn/core` than its own — the CLI, for one — finds them
 * there, where this module's maps would be empty.
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
    /** The `visibleTo` user column of a tenancy table that declares one. */
    readonly userColumnName?: string;
}

/** The tenant column of one table: its property key and the column itself. */
export interface TenantColumnRef
{
    readonly key: string;
    readonly column: Column;
}

/** Set to `true` on a `tenantKey()` column. */
export const TENANT_COLUMN_MARKER = Symbol.for('spfn.tenant.column');

/** Set on a `tenancy.table` table; its value is a TenancyTableMarker. */
export const TENANCY_TABLE_MARKER = Symbol.for('spfn.tenancy.table');

/**
 * What a tenancy table's marker records: its tenant column, its tenant list
 * table and, when it declares `visibleTo`, the user column's SQL name.
 */
export interface TenancyTableMarker
{
    readonly columnName: string;
    readonly tenants: { readonly schema: string | undefined; readonly name: string };
    readonly visibleTo?: string;
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
    (column as unknown as Record<symbol, boolean>)[TENANT_COLUMN_MARKER] = true;
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

/**
 * The tenancy tables of the process, on `globalThis` rather than in this
 * module: the boot check imports `@spfn/core/db` through the package entry,
 * which can be another copy of this module than the one the app's schema
 * registered its tables through (a bundler, a test runner resolving `src`
 * and `dist`). One process, one list.
 */
const TENANCY_TABLES_KEY = Symbol.for('spfn.tenancy.tables');

function tenancyTables(): Map<string, TenantTableEntry>
{
    const holder = globalThis as unknown as Record<symbol, Map<string, TenantTableEntry> | undefined>;

    return holder[TENANCY_TABLES_KEY] ??= new Map();
}

/**
 * Record `table` as a tenancy table and mark it. Called once by `tenancy.table`.
 * A `visibleTo` user column is added to the table's tenant column entry too,
 * which the development query warning reads.
 */
export function registerTenancyTable(table: PgTable, marker: TenancyTableMarker): void
{
    const { schema, name, key } = identityOf(table);
    const userColumn = marker.visibleTo ? { userColumnName: marker.visibleTo } : {};

    (table as unknown as Record<symbol, TenancyTableMarker>)[TENANCY_TABLE_MARKER] = marker;
    tenancyTables().set(key, { schema, name, columnName: marker.columnName, ...userColumn });

    const tenantEntry = tenantTables.get(key);

    if (tenantEntry)
    {
        tenantTables.set(key, { ...tenantEntry, ...userColumn });
    }
}

/**
 * Record a `tenantList({ visibleThrough })` table for the boot check. Its
 * `columnName` is `id`, the column its policy compares with the tenant.
 */
export function registerTenantList(table: PgTable): void
{
    const { schema, name, key } = identityOf(table);

    tenancyTables().set(key, { schema, name, columnName: 'id' });
}

function identityOf(table: PgTable): { schema: string | undefined; name: string; key: string }
{
    const schema = (table as unknown as Record<symbol, string | undefined>)[TABLE_SCHEMA];
    const name = getTableName(table);

    return { schema, name, key: `${schema ?? ''}.${name}` };
}

/**
 * The marker of a tenancy table, or of an `alias()` of one, or undefined for
 * anything else — a `tenantKey()`-only table included.
 */
export function findTenancyMarker(table: unknown): TenancyTableMarker | undefined
{
    return isTable(table) ? (table as unknown as Record<symbol, TenancyTableMarker | undefined>)[TENANCY_TABLE_MARKER] : undefined;
}

/**
 * The `visibleTo` user column of a tenancy table or an `alias()` of one, or
 * undefined for any table that declares none.
 */
export function findUserColumn(table: unknown): TenantColumnRef | undefined
{
    const columnName = findTenancyMarker(table)?.visibleTo;

    if (!columnName)
    {
        return undefined;
    }

    const entry = Object.entries(getColumns(table as PgTable) as Record<string, Column>)
        .find(([, column]) => column.name === columnName);

    return entry ? { key: entry[0], column: entry[1] } : undefined;
}

/** Every tenancy table — and `visibleThrough` tenant list — defined so far in this process. */
export function listTenancyTables(): TenantTableEntry[]
{
    return [...tenancyTables().values()];
}
