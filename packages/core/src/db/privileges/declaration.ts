/**
 * App privileges — what the app role may do on a table, declared next to it
 *
 * `appPrivileges(table, ['select', 'insert'])` — or, with column lists,
 * `appPrivileges(table, { select: true, update: ['status'] })` — records the
 * declaration as a
 * `Symbol.for(...)` property on the drizzle table object, the way
 * `tenancy.table` records its marker, so a tool that loads the app's schema
 * through another copy of `@spfn/core` than its own — the CLI, for one — reads
 * it there. A table without one has the default set.
 *
 * `spfn db generate` records the declarations in the migrations folder's
 * `privileges.json` (see manifest.ts); the privileges step brings the app role
 * to them (plan.ts, catalog.ts).
 */

import { getColumns, getTableName, isTable } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

/** Every privilege a declaration may name, in the order a list is normalised to. */
export const APP_PRIVILEGES = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] as const;

/** One table-level privilege of the app role. */
export type AppPrivilege = typeof APP_PRIVILEGES[number];

/** The privileges of a table that declares none. `truncate`, `references` and `trigger` are opt-ins. */
export const DEFAULT_APP_PRIVILEGES: readonly AppPrivilege[] = Object.freeze(['select', 'insert', 'update', 'delete']);

/**
 * The privileges PostgreSQL grants on a column as well as on a table, in the
 * order a declaration is normalised to. `delete`, `truncate` and `trigger`
 * act on whole rows or on the table: PostgreSQL has no column form of them.
 */
export const APP_COLUMN_PRIVILEGES = ['select', 'insert', 'update', 'references'] as const;

/** A privilege a declaration may limit to a list of columns. */
export type AppColumnPrivilege = typeof APP_COLUMN_PRIVILEGES[number];

/** Per privilege, the column names it is granted on: each list non-empty, sorted, without repeats. */
export type AppColumnPrivileges = { readonly [P in AppColumnPrivilege]?: readonly string[] };

/** The property names of `TTable`'s columns, where TypeScript knows them; any name otherwise. */
type ColumnKey<TTable> = TTable extends { _: { columns: infer TColumns } } ? Extract<keyof TColumns, string> : string;

/**
 * The object form of a declaration: per privilege, `true` for the whole
 * table, or — for `APP_COLUMN_PRIVILEGES` — a list of the table's column
 * properties. A privilege left out is not granted.
 */
export type AppPrivilegeDeclaration<TTable = unknown> = {
    readonly [P in AppPrivilege]?: P extends AppColumnPrivilege ? true | readonly ColumnKey<TTable>[] : true;
};

/**
 * Set on a table by `appPrivileges`. Its value is frozen: the normalised
 * privilege list when the declaration names no column list — the value
 * releases before column lists set — else `{ privileges, columns }` with the
 * table-level list and the column names per privilege.
 */
export const APP_PRIVILEGES_MARKER = Symbol.for('spfn.app.privileges');

/**
 * One table's privileges: its declared table-level list, or `'default'`; and,
 * when it declares any, its column lists. The schema and the table are two
 * fields, since a quoted identifier may itself hold a dot.
 */
export interface AppTablePrivileges
{
    /** The PostgreSQL schema; `public` for a table declared without one */
    readonly schema: string;
    readonly table: string;
    /** The table-level privileges; an empty list when the table declares column lists only */
    readonly privileges: readonly AppPrivilege[] | 'default';
    /** The column-level privileges, by column name; absent when the table declares none */
    readonly columns?: AppColumnPrivileges;
}

/** A declaration as the marker holds it. */
type MarkerValue = readonly AppPrivilege[] | { readonly privileges: readonly AppPrivilege[]; readonly columns: AppColumnPrivileges };

/** A declaration, normalised: what `AppTablePrivileges` carries beside the table's name. */
type Declared = Pick<AppTablePrivileges, 'privileges' | 'columns'>;

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
 * Declare what the app role may do on `table`, and return the table, so it
 * wraps `pgTable`, `schema.table` and `tenancy.table` alike — as a list of
 * table-level privileges:
 *
 * ```typescript
 * export const auditLog = appPrivileges(schema.table('audit_log', { ... }), ['select', 'insert']);
 * ```
 *
 * or as an object, where a privilege is `true` (the whole table) or, for
 * `select`, `insert`, `update` and `references`, a list of the table's column
 * properties, which the declaration records by their column names:
 *
 * ```typescript
 * export const outbox = appPrivileges(schema.table('outbox', { ... }), { select: true, insert: true, update: ['status', 'messageId'] });
 * ```
 *
 * An object without a column list is the same declaration as its list.
 *
 * A list is checked against what drizzle — the access path of every
 * repository — sends: an `insert` list names every column but a GENERATED
 * ALWAYS one, and an `update` list each column with `$onUpdate`
 * (`timestamps()`' `updatedAt`), since drizzle names those in every such
 * statement and PostgreSQL would refuse each one.
 *
 * @throws AppPrivilegesError on an unknown privilege, no privilege, an empty
 * column list, a column list on `delete`, `truncate` or `trigger`, a property
 * that is no column of the table, an `insert` or `update` list drizzle's
 * statements cannot keep to, or a table that already declares another set
 */
export function appPrivileges<TTable extends PgTable>(table: TTable, privileges: readonly AppPrivilege[] | AppPrivilegeDeclaration<TTable>): TTable
{
    const name = tableName(table);
    const normalised = Array.isArray(privileges) ? normalisePrivileges(name, privileges) : normaliseDeclaration(name, table, privileges as AppPrivilegeDeclaration);
    const holder = table as unknown as Record<symbol, MarkerValue | undefined>;
    const existing = holder[APP_PRIVILEGES_MARKER];

    if (existing && !sameDeclaration(declaredOn(table), declaredOf(normalised)))
    {
        throw new AppPrivilegesError(name.schema, name.table, `declared ${describe(declaredOf(normalised))}, but the table already declares ${describe(declaredOn(table))}`);
    }

    holder[APP_PRIVILEGES_MARKER] = normalised;

    return table;
}

/**
 * The privileges of every table among `values` — a schema module's exports,
 * say — sorted by schema, then table: the declared list and column lists, or
 * `'default'` for a table that declares none. A table reached twice is listed once. Values that
 * are not tables are skipped. The marker is read by its `Symbol.for` key, so a
 * table declared through any copy of `@spfn/core` counts.
 *
 * @throws AppPrivilegesError when two tables of one name declare different sets
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

        const entry = { ...tableName(value), ...declaredOn(value) };
        const key = JSON.stringify([entry.schema, entry.table]);
        const seen = byTable.get(key);

        if (seen !== undefined && !sameDeclaration(seen, entry))
        {
            throw new AppPrivilegesError(entry.schema, entry.table, `two tables of this name declare ${describe(seen)} and ${describe(entry)}`);
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

function declaredOn(table: unknown): Declared
{
    const marker = (table as Record<symbol, MarkerValue | undefined>)[APP_PRIVILEGES_MARKER];

    return marker === undefined ? { privileges: 'default' } : declaredOf(marker);
}

function declaredOf(marker: MarkerValue): Declared
{
    return Array.isArray(marker) ? { privileges: marker } : marker as Declared;
}

/** Whether `value` is one of `APP_PRIVILEGES`. */
export function isAppPrivilege(value: unknown): value is AppPrivilege
{
    return (APP_PRIVILEGES as readonly unknown[]).includes(value);
}

/**
 * `privileges` checked and in `APP_PRIVILEGES` order, without repeats, frozen.
 * `name` names the table in the error; `named` is every privilege the
 * declaration names, column lists' included, when it is an object.
 *
 * @throws AppPrivilegesError on a value that is not a list, nothing named or an unknown privilege
 */
function normalisePrivileges(name: TableName, privileges: readonly unknown[], named: readonly unknown[] = privileges): readonly AppPrivilege[]
{
    if (!Array.isArray(privileges) || named.length === 0)
    {
        throw new AppPrivilegesError(name.schema, name.table, 'declares no privileges; name at least one');
    }

    const unknown = named.filter(privilege => !isAppPrivilege(privilege));

    if (unknown.length > 0)
    {
        throw new AppPrivilegesError(name.schema, name.table, `unknown privilege ${unknown.map(value => JSON.stringify(value)).join(', ')}; allowed: ${APP_PRIVILEGES.join(', ')}`);
    }

    return Object.freeze(APP_PRIVILEGES.filter(privilege => privileges.includes(privilege)));
}

/**
 * The object form checked and normalised: the list `normalisePrivileges`
 * returns when it names no column list, else the table-level list and, per
 * privilege in `APP_COLUMN_PRIVILEGES` order, the column names of the listed
 * properties, sorted, without repeats — frozen.
 *
 * @throws AppPrivilegesError on a value that is no object, an unknown
 * privilege, a value other than `true` or a column list, a column list on a
 * table-level privilege, an empty list, a property that is no column, or an
 * `insert` or `update` list drizzle's statements cannot keep to
 */
function normaliseDeclaration(name: TableName, table: PgTable, declaration: AppPrivilegeDeclaration): MarkerValue
{
    if (typeof declaration !== 'object' || declaration === null)
    {
        throw new AppPrivilegesError(name.schema, name.table, 'declares neither a privilege list nor an object of privileges');
    }

    const entries = Object.entries(declaration as Record<string, unknown>);
    const listed = entries.filter(([, value]) => value !== true);

    listed.forEach(([privilege, value]) => checkColumnList(name, privilege, value));

    const tableLevel = normalisePrivileges(name, entries.filter(([, value]) => value === true).map(([privilege]) => privilege), entries.map(([privilege]) => privilege));

    if (listed.length === 0)
    {
        return tableLevel;
    }

    const columns = APP_COLUMN_PRIVILEGES
        .filter(privilege => listed.some(([key]) => key === privilege))
        .map(privilege => [privilege, columnNames(name, table, declaration[privilege] as readonly string[])]);

    listed.forEach(([privilege, value]) => checkDrizzleColumns(name, table, privilege, value as readonly string[]));

    return Object.freeze({ privileges: tableLevel, columns: Object.freeze(Object.fromEntries(columns)) as AppColumnPrivileges });
}

/** @throws AppPrivilegesError unless `value` is a non-empty list for a privilege that takes one */
function checkColumnList(name: TableName, privilege: string, value: unknown): void
{
    if (!isAppPrivilege(privilege))
    {
        return;
    }

    if (!Array.isArray(value))
    {
        throw new AppPrivilegesError(name.schema, name.table, `${privilege}: ${JSON.stringify(value) ?? String(value)} is neither true nor a list of columns; leave out a privilege the table does not grant`);
    }

    if (!(APP_COLUMN_PRIVILEGES as readonly string[]).includes(privilege))
    {
        throw new AppPrivilegesError(name.schema, name.table, `${privilege} takes no column list: PostgreSQL grants ${privilege.toUpperCase()} on the whole table only; `
            + `declare ${privilege}: true, or leave it out (column lists: ${APP_COLUMN_PRIVILEGES.join(', ')})`);
    }

    if (value.length === 0)
    {
        throw new AppPrivilegesError(name.schema, name.table, `${privilege} lists no column; name at least one, or leave ${privilege} out`);
    }
}

/**
 * The column names of `properties` on `table`, sorted, without repeats.
 *
 * @throws AppPrivilegesError on a property that is no column of the table
 */
function columnNames(name: TableName, table: PgTable, properties: readonly string[]): readonly string[]
{
    const columns = getColumns(table) as Record<string, { name: string } | undefined>;
    const unknown = properties.filter(property => !Object.hasOwn(columns, property));

    if (unknown.length > 0)
    {
        throw new AppPrivilegesError(name.schema, name.table, `no column property ${unknown.map(property => JSON.stringify(property)).join(', ')}; `
            + `its columns: ${Object.keys(columns).join(', ')}`);
    }

    return Object.freeze([...new Set(properties.map(property => columns[property]!.name))].sort(compareText));
}

/** What `checkDrizzleColumns` reads of a drizzle column. */
interface DrizzleColumn
{
    readonly name: string;
    readonly onUpdateFn?: unknown;
    readonly generated?: { readonly type?: string };
    readonly generatedIdentity?: { readonly type?: string };
}

/**
 * Per privilege, the columns every drizzle statement of it names, and why:
 * PostgreSQL checks the privilege of each column a statement names, so a list
 * leaving one out refuses every such statement (42501). Read from drizzle-orm's
 * pg-core dialect: `buildInsertQuery` names every column `shouldDisableInsert`
 * keeps — all but a GENERATED ALWAYS column or identity — with `DEFAULT` for
 * one not given; `buildUpdateSet` adds each column with an `onUpdateFn`.
 * `select` and `references` have none: `select({ … })` names the columns it
 * reads, and drizzle sends nothing that needs REFERENCES.
 */
const DRIZZLE_NAMES: Partial<Record<AppColumnPrivilege, { names: (column: DrizzleColumn) => boolean; why: string }>> = {
    insert: {
        names: column => !generatedAlways(column),
        why: 'drizzle\'s insert() names every column but a GENERATED ALWAYS one, DEFAULT for one not given',
    },
    update: {
        names: column => column.onUpdateFn !== undefined,
        why: 'drizzle\'s update() sets each column with $onUpdate (timestamps()\' updatedAt) on every update',
    },
};

/** Whether drizzle's insert() leaves `column` out: GENERATED ALWAYS, as a generated column or an identity. */
function generatedAlways(column: DrizzleColumn): boolean
{
    return [column.generated, column.generatedIdentity].some(generated => generated !== undefined && generated.type !== 'byDefault');
}

/**
 * @throws AppPrivilegesError when `properties`, the list of `privilege`, leaves
 * out a column every drizzle statement of that privilege names
 */
function checkDrizzleColumns(name: TableName, table: PgTable, privilege: string, properties: readonly string[]): void
{
    const rule = DRIZZLE_NAMES[privilege as AppColumnPrivilege];

    if (rule === undefined)
    {
        return;
    }

    const columns = getColumns(table) as Record<string, DrizzleColumn>;
    const left = Object.keys(columns).filter(property => rule.names(columns[property]) && !properties.includes(property));

    if (left.length > 0)
    {
        throw new AppPrivilegesError(name.schema, name.table, `${privilege} leaves out ${left.join(', ')}: ${rule.why}, and PostgreSQL checks `
            + `${privilege.toUpperCase()} on each column named, so every ${privilege}() through a repository would be refused (42501); `
            + `list ${left.length === 1 ? 'it' : 'them'} too, or declare ${privilege}: true`);
    }
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

function sameDeclaration(a: Declared, b: Declared): boolean
{
    return describe(a) === describe(b);
}

/** `the default set`, or `[select, insert, update (message_id, status)]`. */
function describe(declared: Declared): string
{
    if (declared.privileges === 'default')
    {
        return 'the default set';
    }

    const columns = APP_COLUMN_PRIVILEGES.flatMap(privilege =>
        declared.columns?.[privilege] === undefined ? [] : [`${privilege} (${declared.columns[privilege].join(', ')})`]);

    return `[${[...declared.privileges, ...columns].join(', ')}]`;
}
