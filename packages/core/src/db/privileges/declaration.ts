/**
 * App privileges — what the app role may do on a table, declared next to it
 *
 * `appPrivileges(table, ['select', 'insert'])` records the declaration as a
 * `Symbol.for(...)` property on the drizzle table object, the way
 * `tenancy.table` records its marker, so a tool that loads the app's schema
 * through another copy of `@spfn/core` than its own — the CLI, for one — reads
 * it there. A table without one has the default set.
 *
 * Nothing grants or revokes from this yet: `spfn db generate` records the
 * declarations in the migrations folder's `privileges.json` (see manifest.ts).
 */

import { getTableName, isTable } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

/** Every privilege a declaration may name, in the order a list is normalised to. */
export const APP_PRIVILEGES = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] as const;

/** One table-level privilege of the app role. */
export type AppPrivilege = typeof APP_PRIVILEGES[number];

/** The privileges of a table that declares none. `truncate`, `references` and `trigger` are opt-ins. */
export const DEFAULT_APP_PRIVILEGES: readonly AppPrivilege[] = Object.freeze(['select', 'insert', 'update', 'delete']);

/** Set on a table by `appPrivileges`; its value is the normalised, frozen privilege list. */
export const APP_PRIVILEGES_MARKER = Symbol.for('spfn.app.privileges');

/**
 * One table's privileges: its declared list, or `'default'`. The schema and
 * the table are two fields, since a quoted identifier may itself hold a dot.
 */
export interface AppTablePrivileges
{
    /** The PostgreSQL schema; `public` for a table declared without one */
    readonly schema: string;
    readonly table: string;
    readonly privileges: readonly AppPrivilege[] | 'default';
}

const TABLE_SCHEMA = Symbol.for('drizzle:Schema');

/**
 * A privilege declaration that cannot stand: an unknown privilege, an empty
 * list, a second declaration that differs from the first, or two tables of
 * one name declaring different lists. Thrown where the declaration is written,
 * so the schema module fails to load.
 */
export class AppPrivilegesError extends Error
{
    /** The table's schema. */
    readonly schema: string;
    /** The table. */
    readonly table: string;

    constructor(schema: string, table: string, detail: string)
    {
        super(`appPrivileges(${schema}.${table}): ${detail}`);

        this.name = 'AppPrivilegesError';
        this.schema = schema;
        this.table = table;
    }
}

/**
 * Declare what the app role may do on `table`, table-level, and return the
 * table, so it wraps `pgTable`, `schema.table` and `tenancy.table` alike:
 *
 * ```typescript
 * export const auditLog = appPrivileges(schema.table('audit_log', { ... }), ['select', 'insert']);
 * ```
 *
 * @throws AppPrivilegesError on an unknown privilege, an empty list, or a
 * table that already declares a different list
 */
export function appPrivileges<TTable extends PgTable>(table: TTable, privileges: readonly AppPrivilege[]): TTable
{
    const name = tableName(table);
    const normalised = normalisePrivileges(name, privileges);
    const holder = table as unknown as Record<symbol, readonly AppPrivilege[] | undefined>;
    const existing = holder[APP_PRIVILEGES_MARKER];

    if (existing && !samePrivileges(existing, normalised))
    {
        throw new AppPrivilegesError(name.schema, name.table, `declared [${normalised.join(', ')}], but the table already declares [${existing.join(', ')}]`);
    }

    holder[APP_PRIVILEGES_MARKER] = normalised;

    return table;
}

/**
 * The privileges of every table among `values` — a schema module's exports,
 * say — sorted by schema, then table: the declared list, or `'default'` for a
 * table that declares none. A table reached twice is listed once. Values that
 * are not tables are skipped. The marker is read by its `Symbol.for` key, so a
 * table declared through any copy of `@spfn/core` counts.
 *
 * @throws AppPrivilegesError when two tables of one name declare different lists
 */
export function declaredAppPrivileges(values: Iterable<unknown>): AppTablePrivileges[]
{
    const byTable = new Map<string, AppTablePrivileges>();

    for (const value of values)
    {
        if (!isTable(value))
        {
            continue;
        }

        const entry = { ...tableName(value), privileges: declaredOn(value) };
        const key = JSON.stringify([entry.schema, entry.table]);
        const seen = byTable.get(key);

        if (seen !== undefined && !samePrivileges(seen.privileges, entry.privileges))
        {
            throw new AppPrivilegesError(entry.schema, entry.table, `two tables of this name declare ${describe(seen.privileges)} and ${describe(entry.privileges)}`);
        }

        byTable.set(key, entry);
    }

    return [...byTable.values()].sort(compareTables);
}

/** Order by schema, then table, by UTF-16 code unit, so the order is the same everywhere. */
function compareTables(a: { schema: string; table: string }, b: { schema: string; table: string }): number
{
    return compareText(a.schema, b.schema) || compareText(a.table, b.table);
}

function compareText(a: string, b: string): number
{
    return a < b ? -1 : a > b ? 1 : 0;
}

function declaredOn(table: unknown): readonly AppPrivilege[] | 'default'
{
    return (table as Record<symbol, readonly AppPrivilege[] | undefined>)[APP_PRIVILEGES_MARKER] ?? 'default';
}

/** Whether `value` is one of `APP_PRIVILEGES`. */
export function isAppPrivilege(value: unknown): value is AppPrivilege
{
    return (APP_PRIVILEGES as readonly unknown[]).includes(value);
}

/**
 * `privileges` checked and in `APP_PRIVILEGES` order, without repeats, frozen.
 * `name` names the table in the error.
 *
 * @throws AppPrivilegesError on a value that is not a list, an empty list or an unknown privilege
 */
function normalisePrivileges(name: TableName, privileges: readonly unknown[]): readonly AppPrivilege[]
{
    if (!Array.isArray(privileges) || privileges.length === 0)
    {
        throw new AppPrivilegesError(name.schema, name.table, 'declares no privileges; name at least one');
    }

    const unknown = privileges.filter(privilege => !isAppPrivilege(privilege));

    if (unknown.length > 0)
    {
        throw new AppPrivilegesError(name.schema, name.table, `unknown privilege ${unknown.map(value => JSON.stringify(value)).join(', ')}; allowed: ${APP_PRIVILEGES.join(', ')}`);
    }

    return Object.freeze(APP_PRIVILEGES.filter(privilege => privileges.includes(privilege)));
}

interface TableName
{
    schema: string;
    table: string;
}

/** A table's schema and name; `public` for a table declared without a schema. */
function tableName(table: unknown): TableName
{
    return {
        schema: (table as Record<symbol, string | undefined>)[TABLE_SCHEMA] ?? 'public',
        table: getTableName(table as PgTable),
    };
}

function samePrivileges(a: readonly AppPrivilege[] | 'default', b: readonly AppPrivilege[] | 'default'): boolean
{
    return describe(a) === describe(b);
}

function describe(privileges: readonly AppPrivilege[] | 'default'): string
{
    return privileges === 'default' ? 'the default set' : `[${privileges.join(', ')}]`;
}
