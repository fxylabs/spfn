/**
 * Tenant plan — which tables `spfn db tenant export` / `import` move, in which order
 *
 * A tenant table is a table with a `tenantKey()` column: a `tenancy.table` and a
 * table that only declares `tenantKey()` alike. They are found through the
 * `Symbol.for` markers `@spfn/core` leaves on the column and on a tenancy table,
 * never through core's registry or `instanceof`: the app's schema modules can
 * load another copy of `@spfn/core` than the CLI's, whose registry would be empty.
 *
 * The plan is the only source of identifiers the commands put in SQL and of the
 * file names they read and write; a manifest is compared against it, never used
 * in its place.
 */

import { getTableName, isTable } from 'drizzle-orm';
import { getTableConfig, type PgColumn, type PgTable } from 'drizzle-orm/pg-core';

/** Set to `true` on a `tenantKey()` column (core `TENANT_COLUMN_MARKER`). */
const TENANT_COLUMN_MARKER = Symbol.for('spfn.tenant.column');

/** Set on a `tenancy.table` table (core `TENANCY_TABLE_MARKER`). */
const TENANCY_TABLE_MARKER = Symbol.for('spfn.tenancy.table');

const TABLE_SCHEMA = Symbol.for('drizzle:Schema');

/** A table by schema and name. */
export interface TableName
{
    readonly schema: string;
    readonly name: string;
}

/** One tenant table as the commands move it. */
export interface PlanTable extends TableName
{
    readonly tenantColumn: string;
    /** Every stored column, generated (`GENERATED ALWAYS AS`) ones left out, in declaration order. */
    readonly columns: string[];
    readonly primaryKey: string[];
    /** `<schema>.<table>.copy`, inside the export folder. */
    readonly file: string;
}

/** A table listing tenants, with the column its tenancy tables' foreign key references. */
export interface TenantList extends TableName
{
    readonly idColumn: string;
}

export interface TenantPlan
{
    /** Referenced tables first. */
    readonly tables: PlanTable[];
    /** The tenant list tables `tenancy.table` tables point at; empty for `tenantKey()`-only apps. */
    readonly tenantLists: TenantList[];
}

interface TenancyTableMarker
{
    readonly columnName: string;
    readonly tenants: { readonly schema: string | undefined; readonly name: string };
}

interface Candidate
{
    readonly table: PgTable;
    readonly key: string;
    readonly tenantColumn: string;
}

/**
 * The plan for the tenant tables among the app schema's exports.
 *
 * Throws when the tables are none, or when their foreign keys form a cycle — a
 * reference of a table to itself is not one.
 */
export function buildTenantPlan(imports: Record<string, unknown>): TenantPlan
{
    const candidates = findTenantTables(imports);

    if (candidates.length === 0)
    {
        throw new Error('No tenant tables: the app schema has no table with a tenantKey() column');
    }

    const order = dependencyOrder(candidates);

    return {
        tables: order.map((candidate) => planTable(candidate)),
        tenantLists: tenantLists(candidates),
    };
}

/** `"name"`, with embedded quotes doubled. */
export function quoteIdent(name: string): string
{
    return `"${name.replaceAll('"', '""')}"`;
}

/** `"schema"."table"`. */
export function qualifiedName(table: TableName): string
{
    return `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
}

/** The table's stored columns, quoted, comma-separated. */
export function columnList(table: PlanTable): string
{
    return table.columns.map(quoteIdent).join(', ');
}

export function tableKey(table: TableName): string
{
    return `${table.schema}.${table.name}`;
}

function findTenantTables(imports: Record<string, unknown>): Candidate[]
{
    const tables = new Set(Object.values(imports).filter((value): value is PgTable => isTable(value)));

    return [...tables].flatMap((table) =>
    {
        const tenantColumn = getTableConfig(table).columns.find((column) => isTenantColumn(column))?.name
            ?? tenancyMarker(table)?.columnName;

        return tenantColumn ? [{ table, key: tableKey(nameOf(table)), tenantColumn }] : [];
    });
}

function isTenantColumn(column: PgColumn): boolean
{
    return (column as unknown as Record<symbol, unknown>)[TENANT_COLUMN_MARKER] === true;
}

function tenancyMarker(table: PgTable): TenancyTableMarker | undefined
{
    return (table as unknown as Record<symbol, TenancyTableMarker | undefined>)[TENANCY_TABLE_MARKER];
}

function nameOf(table: PgTable): TableName
{
    return {
        schema: (table as unknown as Record<symbol, string | undefined>)[TABLE_SCHEMA] ?? 'public',
        name: getTableName(table),
    };
}

function planTable({ table, tenantColumn }: Candidate): PlanTable
{
    const config = getTableConfig(table);
    const name = nameOf(table);
    const declaredKey = config.primaryKeys[0]?.columns.map((column) => column.name);

    return {
        ...name,
        tenantColumn,
        columns: config.columns.filter((column) => !column.generated).map((column) => column.name),
        primaryKey: declaredKey ?? config.columns.filter((column) => column.primary).map((column) => column.name),
        file: `${name.schema}.${name.name}.copy`,
    };
}

/** The tables each candidate references, among the candidates, itself left out. */
function dependencies(candidate: Candidate, keys: Set<string>): string[]
{
    return getTableConfig(candidate.table).foreignKeys
        .map((foreignKey) => tableKey(nameOf(foreignKey.reference().foreignTable)))
        .filter((key) => key !== candidate.key && keys.has(key));
}

/**
 * Depth-first: every table after the tables it references. Tables are visited
 * by name so the order does not depend on the order of the schema's exports.
 */
function dependencyOrder(candidates: Candidate[]): Candidate[]
{
    const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
    const keys = new Set(byKey.keys());
    const ordered: Candidate[] = [];
    const done = new Set<string>();

    const visit = (key: string, path: string[]): void =>
    {
        if (done.has(key)) return;

        if (path.includes(key))
        {
            throw new Error(`Foreign keys between tenant tables form a cycle: ${[...path.slice(path.indexOf(key)), key].join(' → ')}`);
        }

        const candidate = byKey.get(key)!;

        dependencies(candidate, keys).sort().forEach((dependency) => visit(dependency, [...path, key]));
        done.add(key);
        ordered.push(candidate);
    };

    [...keys].sort().forEach((key) => visit(key, []));

    return ordered;
}

function tenantLists(candidates: Candidate[]): TenantList[]
{
    const lists = new Map<string, TenantList>();

    for (const candidate of candidates)
    {
        const tenants = tenancyMarker(candidate.table)?.tenants;

        if (tenants)
        {
            const list = { schema: tenants.schema ?? 'public', name: tenants.name };

            lists.set(tableKey(list), { ...list, idColumn: tenantListColumn(candidate, tableKey(list)) });
        }
    }

    return [...lists.values()];
}

/** The column the tenant column's foreign key references in the list table; `id` without one. */
function tenantListColumn(candidate: Candidate, listKey: string): string
{
    const reference = getTableConfig(candidate.table).foreignKeys
        .map((foreignKey) => foreignKey.reference())
        .find((ref) => tableKey(nameOf(ref.foreignTable)) === listKey
            && ref.columns.length === 1 && ref.columns[0].name === candidate.tenantColumn);

    return reference?.foreignColumns[0].name ?? 'id';
}
