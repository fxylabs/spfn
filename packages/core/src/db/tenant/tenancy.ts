/**
 * Tenancy — one declaration for a set of tenant tables
 *
 * `defineTenancy({ tenants, authorize })` names the table that lists the
 * tenants and the rule for who may act for one. What it returns builds the rest:
 *
 * - `tenancy.table(schema, name, columns)` — a table shared by the tenants. It
 *   gets the tenant column, a foreign key to the tenant list, `unique(tenant, id)`
 *   and a row-level security policy that admits only the rows of the tenant in
 *   the transaction's `app.tenant_id` setting. With `{ visibleTo: 'userId' }` —
 *   a membership table — it also gets an index on that user column, and four
 *   policies in place of the one: reads admit the tenant's rows OR the rows of
 *   the user in `app.user_id`; inserts, updates and deletes still need the
 *   tenant.
 * - `tenancy.reference(name, () => table, { optional?, onDelete? })` — a column
 *   pointing at another tenancy table through a composite foreign key
 *   `(tenant, x_id) → (tenant, id)`, so the database refuses a row that points
 *   into another tenant.
 * - `tenancy.guard({ param } | { resolve })` — route middleware that reads the
 *   tenant id, runs `authorize`, and binds the request to that tenant.
 * - `tenancy.of(c)` — the tenant the guard bound.
 *
 * The tenant column is the property `tenantId` and the SQL column `tenant_id`;
 * `defineTenancy({ property, column })` renames either one.
 *
 * `tenantList(schema, name, columns, extraConfig?, { visibleThrough })` declares
 * the tenant list itself with policies: a transaction bound to a tenant sees
 * that tenant's row, one bound to a user the rows the user's memberships (a
 * `visibleTo` table of the tenancy over this list) point at. It is a separate
 * factory because the tenant list is declared before the tenancy that names it.
 *
 * Constraint names are fixed so migrations stay readable: `<table>_tenant_id_id_key`,
 * `<table>_tenant_id_fk`, `<table>_<reference>_fk`, `<table>_tenant_isolation`
 * (with the tenant column's own name in place of `tenant_id`). A name longer
 * than PostgreSQL's 63-byte identifier limit is cut to 54 bytes and suffixed
 * with a hash of the whole name, so two long names never truncate into one.
 *
 * @example
 * ```typescript
 * export const tenancy = defineTenancy({
 *     tenants: workspaces,
 *     authorize: async (c, tenantId) => memberRepository.isMember(tenantId, Number(getAuth(c).userId)),
 * });
 *
 * export const notes = tenancy.table(schema, 'notes', {
 *     id: id(),
 *     authorId: tenancy.reference('author', () => authors),
 *     title: text('title').notNull(),
 * });
 *
 * export const listNotes = route.get('/workspaces/:workspaceId/notes')
 *     .use([tenancy.guard({ param: 'workspaceId' })])
 *     .handler(async (c) => noteRepository.list(tenancy.of(c)));
 * ```
 */

import { createHash } from 'crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getColumns, getTableName, isTable, sql, type SQL } from 'drizzle-orm';
import {
    bigint,
    foreignKey as pgForeignKey,
    index,
    pgPolicy,
    unique,
    type AnyPgColumnBuilder,
    type PgBuildColumns,
    type PgBuildExtraConfigColumns,
    type PgColumn,
    type PgSchema,
    type PgTable,
    type PgTableExtraConfigValue,
    type PgTableWithColumns,
} from 'drizzle-orm/pg-core';
import { ForbiddenError, ValidationError } from '@spfn/core/errors';
import { defineMiddlewareFactory } from '../../route/define-middleware';
import { tenantKey } from '../schema/entity-helper';
import { claimTransactionForGuard, TENANT_SETTING, USER_SETTING } from '../transaction/tenant';
import { isTenantId } from './condition';
import {
    findTenancyMarker,
    findTenantColumn,
    registerTenancyTable,
    registerTenantList,
    type TenancyTableMarker,
} from './registry';
import { runWithRequestTenant } from './request-scope';

/** A table that lists tenants: anything with an `id` column. */
export type TenantListTable = PgTable & { id: PgColumn };

export interface TenancyOptions<TTenants extends TenantListTable = TenantListTable, TProperty extends string = 'tenantId'>
{
    /** The table whose rows are the tenants (a workspace table, or the users table). */
    tenants: TTenants;

    /**
     * May the request act for `tenantId`? Runs in `tenancy.guard()` after the id
     * was read and validated. Anything but `true` refuses with 403; a throw
     * propagates unchanged.
     */
    authorize: (c: Context, tenantId: number) => boolean | Promise<boolean>;

    /** Name of the tenant column on every tenancy table. @default 'tenant_id' */
    column?: string;

    /**
     * Property key of the tenant column on every tenancy table's rows, e.g.
     * `workspaceId` for an app whose code already reads `row.workspaceId`. Pass a
     * string literal: the row types are keyed by it. Not `id`. @default 'tenantId'
     */
    property?: TProperty;
}

/** What deleting a referenced row does. `SET NULL` / `SET DEFAULT` would change the tenant column too. */
export type TenancyOnDelete = 'cascade' | 'restrict' | 'no action';

/** Where `tenancy.guard()` reads the tenant id: exactly one of the two. */
export type TenancyGuardOptions =
    | {
        /** A route parameter holding the id, e.g. `workspaceId` for `/workspaces/:workspaceId`. */
        param: string;
        resolve?: never;
    }
    | {
        /** A function returning the id, e.g. the signed-in user's id. A throw propagates unchanged. */
        resolve: (c: Context) => unknown;
        param?: never;
    };

export interface TenancyReferenceOptions
{
    /** Nullable column. A null reference is not checked. */
    optional?: boolean;

    /**
     * What deleting the referenced row does to this one: `cascade` deletes it,
     * `restrict` and `no action` refuse the delete while it points there (the
     * two differ only for a deferred check, and these foreign keys are not
     * deferrable).
     * @default 'cascade' for a required reference, 'no action' for an optional one
     */
    onDelete?: TenancyOnDelete;
}

/** Options of `tenancy.table`, after the columns or after the extra config. */
export interface TenancyTableOptions<TColumns extends Record<string, AnyPgColumnBuilder> = Record<string, AnyPgColumnBuilder>>
{
    /**
     * A second key: the property of an integer column naming a user — a
     * membership table's `userId`. Reads then admit the rows of the user bound
     * with `runInTransaction({ user })` or `TenantRepository._selectOfUser`
     * across every tenant, besides the tenant's rows; writes still need the
     * tenant. Not `id`, not the tenant property.
     */
    visibleTo?: Exclude<keyof TColumns & string, 'id'>;
}

/** A literal a `visibleThrough.where` condition compares a membership column with. */
export type TenantListWhereValue = string | number | boolean | null;

/** Options of `tenantList`. */
export interface TenantListOptions
{
    /** Who sees which rows besides the tenant's own transaction: the members, through their membership table. */
    visibleThrough: {
        /**
         * The membership table: a `tenancy.table` of a tenancy over this list,
         * declared with `visibleTo`. Called when drizzle reads the table, so it
         * may name a table defined later. Spell out the return type,
         * `(): PgTable => members`: the membership's type depends on this list
         * through the tenancy, and TypeScript cannot infer the circle.
         */
        table: () => PgTable;

        /**
         * Membership property → value a membership must have to count, e.g.
         * `{ status: 'active' }`. Rendered as SQL literals into the policy.
         */
        where?: Record<string, TenantListWhereValue>;
    };
}

type TenantColumns<TProperty extends string> = { [K in TProperty]: ReturnType<typeof tenantKey> };

type ExtraConfig<TColumns extends Record<string, AnyPgColumnBuilder>> =
    (self: PgBuildExtraConfigColumns<TColumns>) => PgTableExtraConfigValue[];

type BuiltTable<TSchema extends string, TTableName extends string, TColumns extends Record<string, AnyPgColumnBuilder>> =
    PgTableWithColumns<{
        name: TTableName;
        schema: TSchema;
        columns: PgBuildColumns<TTableName, TColumns>;
        dialect: 'pg';
    }>;

type RequiredReference = ReturnType<typeof requiredReferenceColumn>;

type OptionalReference = ReturnType<typeof optionalReferenceColumn>;

export interface Tenancy<TProperty extends string = 'tenantId'>
{
    /**
     * A table shared by the tenants; `columns` must include `id` and must not
     * include the tenant column. `{ visibleTo }` comes last, or fourth when
     * there is no extra config.
     */
    table<
        TSchema extends string,
        TTableName extends string,
        TColumns extends Record<string, AnyPgColumnBuilder> & { id: AnyPgColumnBuilder },
    >(
        schema: PgSchema<TSchema>,
        name: TTableName,
        columns: TColumns,
        options: TenancyTableOptions<TColumns>,
    ): BuiltTable<TSchema, TTableName, TColumns & TenantColumns<TProperty>>;
    table<
        TSchema extends string,
        TTableName extends string,
        TColumns extends Record<string, AnyPgColumnBuilder> & { id: AnyPgColumnBuilder },
    >(
        schema: PgSchema<TSchema>,
        name: TTableName,
        columns: TColumns,
        extraConfig?: ExtraConfig<TColumns & TenantColumns<TProperty>>,
        options?: TenancyTableOptions<TColumns>,
    ): BuiltTable<TSchema, TTableName, TColumns & TenantColumns<TProperty>>;

    /**
     * A `<name>_id` column referencing another table of this tenancy, within the
     * same tenant. `target` is called when drizzle reads the table, so it may
     * name a table defined later. A reference to its own table needs the return
     * type spelled out, as drizzle's `.references()` does: `(): PgTable => notes`.
     */
    reference(name: string, target: () => PgTable, options?: { optional?: false; onDelete?: TenancyOnDelete }): RequiredReference;
    reference(name: string, target: () => PgTable, options: { optional: true; onDelete?: TenancyOnDelete }): OptionalReference;

    /** Route middleware: read the tenant id, authorize it, bind the request to it. */
    guard(options: TenancyGuardOptions): MiddlewareHandler;

    /** The tenant `guard()` bound this request to; throws on a route without the guard. */
    of(c: Context | { raw: Context }): number;
}

interface ReferenceSpec
{
    readonly name: string;
    readonly target: () => PgTable;
    readonly onDelete: TenancyOnDelete;
}

/** What every table of one tenancy shares. */
interface TenancyShape
{
    readonly tenants: TenantListTable;
    /** The tenant column's property key on the table. */
    readonly property: string;
    readonly marker: TenancyTableMarker;
}

/** A reference column waiting for the table it is declared in, with its property key. */
interface PendingReference extends ReferenceSpec
{
    readonly key: string;
}

/** PostgreSQL truncates identifiers to 63 bytes. */
const MAX_IDENTIFIER_BYTES = 63;
const HASH_LENGTH = 8;

const ON_DELETE_ACTIONS: readonly TenancyOnDelete[] = ['cascade', 'restrict', 'no action'];

/** drizzle's data type families of the columns a `visibleTo` user id may live in. */
const INTEGER_DATA_TYPES: ReadonlySet<string> = new Set(['number', 'bigint']);

const referenceSpecs = new WeakMap<object, ReferenceSpec>();

/**
 * Declare a tenancy: the tenant list table and who may act for a tenant.
 *
 * @example
 * ```typescript
 * export const tenancy = defineTenancy({
 *     tenants: users,
 *     authorize: async (c, tenantId) => tenantId === Number(getAuth(c).userId),
 * });
 * ```
 */
export function defineTenancy<TTenants extends TenantListTable, const TProperty extends string = 'tenantId'>(
    options: TenancyOptions<TTenants, TProperty>,
): Tenancy<TProperty>
{
    assertTenancyOptions(options);

    const shape: TenancyShape = {
        tenants: options.tenants,
        property: options.property ?? 'tenantId',
        marker: {
            columnName: options.column ?? 'tenant_id',
            tenants: { schema: schemaOf(options.tenants), name: getTableName(options.tenants) },
        },
    };
    const guardedTenants = new WeakMap<Context, number>();

    return {
        table: ((schema: PgSchema<string>, name: string, columns: Record<string, AnyPgColumnBuilder>, fourth?: unknown, fifth?: unknown) =>
            createTenancyTable(schema, name, columns, configArguments(name, fourth, fifth), shape)) as Tenancy<TProperty>['table'],
        reference: createReference as Tenancy<TProperty>['reference'],
        guard: defineMiddlewareFactory('tenancyGuard', (guardOptions: TenancyGuardOptions) =>
            createGuard(tenantReader(guardOptions), options.authorize, guardedTenants)),
        of: (c) => guardedTenant(guardedTenants, c),
    };
}

/**
 * Declare the tenant list with its policies: a transaction bound to a tenant
 * sees that tenant's row, one bound to a user (`runInTransaction({ user })`,
 * `TenantRepository._selectOfUser`) sees the rows its memberships point at,
 * and one bound to neither errors. Creating a row needs no binding; updating or
 * deleting one needs that tenant's. Pass it to `defineTenancy({ tenants })` as
 * usual; the membership table is a `tenancy.table` of that tenancy declared
 * with `visibleTo`, and `{ visibleThrough }` names it.
 *
 * @example
 * ```typescript
 * export const workspaces = tenantList(schema, 'workspaces', {
 *     id: id(),
 *     name: text('name').notNull(),
 * }, {
 *     visibleThrough: { table: (): PgTable => members, where: { status: 'active' } },
 * });
 * ```
 */
export function tenantList<
    TSchema extends string,
    TTableName extends string,
    TColumns extends Record<string, AnyPgColumnBuilder> & { id: AnyPgColumnBuilder },
>(
    schema: PgSchema<TSchema>,
    name: TTableName,
    columns: TColumns,
    options: TenantListOptions,
): BuiltTable<TSchema, TTableName, TColumns>;
export function tenantList<
    TSchema extends string,
    TTableName extends string,
    TColumns extends Record<string, AnyPgColumnBuilder> & { id: AnyPgColumnBuilder },
>(
    schema: PgSchema<TSchema>,
    name: TTableName,
    columns: TColumns,
    extraConfig: ExtraConfig<TColumns> | undefined,
    options: TenantListOptions,
): BuiltTable<TSchema, TTableName, TColumns>;
export function tenantList(
    schema: PgSchema<string>,
    name: string,
    columns: Record<string, AnyPgColumnBuilder>,
    fourth: unknown,
    fifth?: unknown,
): PgTable
{
    const { extraConfig, options } = configArguments<TenantListOptions>(name, fourth, fifth);

    assertTenantListOptions(name, columns, options);

    const list = { schema: schema.schemaName, name };
    const table = schema.table(name, columns, (t: any) => [
        ...tenantListPolicies(list, options.visibleThrough),
        ...(extraConfig ? extraConfig(t) : []),
    ]);

    registerTenantList(table);

    return table;
}

function assertTenantListOptions(
    table: string,
    columns: Record<string, AnyPgColumnBuilder>,
    options: TenantListOptions | undefined,
): asserts options is TenantListOptions
{
    if (!columns.id)
    {
        throw new Error(`tenantList "${table}" has no id column; the tenant id is the row's id`);
    }

    if (typeof options?.visibleThrough?.table !== 'function')
    {
        throw new Error(`tenantList "${table}" takes { visibleThrough: { table: (): PgTable => membershipTable } }`);
    }

    const invalid = Object.entries(options.visibleThrough.where ?? {}).find(([, value]) => !isWhereLiteral(value));

    if (invalid)
    {
        throw new Error(
            `tenantList "${table}" visibleThrough.where "${invalid[0]}" takes a string, a finite number, a boolean or null; the policy holds it as a literal`,
        );
    }
}

function isWhereLiteral(value: unknown): value is TenantListWhereValue
{
    return value === null || typeof value === 'string' || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value));
}

/**
 * The tenant list's four policies. drizzle calls this while it reads the
 * table's config, after every module has loaded, so the membership table —
 * declared after the tenancy that names this list — is there to read.
 */
function tenantListPolicies(list: TenancyTableMarker['tenants'], visibleThrough: TenantListOptions['visibleThrough'])
{
    const { name } = list;
    const membership = visibleThrough.table();
    const marker = membershipMarker(list, membership);
    const id = sql.identifier('id');
    const strict = sql`${id} = ${sql.raw(TENANT_STRICT)}`;
    const members = sql.join([
        sql`EXISTS (SELECT 1 FROM ${qualifiedName(membership)} "m"`,
        sql`WHERE "m".${sql.identifier(marker.columnName)} = ${sql.identifier(name)}.${id}`,
        sql`AND "m".${sql.identifier(marker.visibleTo)} = ${sql.raw(USER_LENIENT)}${membershipConditions(name, membership, visibleThrough.where)})`,
    ], sql` `);
    const read = sql`${id} = ${sql.raw(TENANT_GUARDED)} OR ${members}`;

    return commandPolicies(name, { suffix: 'tenant_visibility', using: read }, sql`true`, strict);
}

/** The membership table's marker, when it is a `visibleTo` table of a tenancy over `list`; otherwise an error naming both. */
function membershipMarker(list: TenancyTableMarker['tenants'], membership: PgTable): TenancyTableMarker & { visibleTo: string }
{
    const { name } = list;
    const marker = findTenancyMarker(membership);
    const refuse = (reason: string) => new Error(
        `tenantList "${name}" visibleThrough.table() returned "${isTable(membership) ? getTableName(membership) : String(membership)}", ${reason}`,
    );

    if (!marker)
    {
        throw refuse('which is not a tenancy.table; declare the membership table with tenancy.table(..., { visibleTo })');
    }

    if (marker.tenants.name !== name || marker.tenants.schema !== list.schema)
    {
        throw refuse(`whose tenancy lists its tenants in "${marker.tenants.name}", not in "${name}"`);
    }

    if (!marker.visibleTo)
    {
        throw refuse('which declares no visibleTo; add { visibleTo: <user column> } to it');
    }

    return marker as TenancyTableMarker & { visibleTo: string };
}

/** ` AND "m"."col" = literal` for each `where` entry, keyed by the membership table's properties. */
function membershipConditions(name: string, membership: PgTable, where: Record<string, TenantListWhereValue> | undefined): SQL
{
    const columns = getColumns(membership) as Record<string, PgColumn>;
    const conditions = Object.entries(where ?? {}).map(([key, value]) =>
    {
        const column = Object.hasOwn(columns, key) ? columns[key] : undefined;

        if (!column)
        {
            throw new Error(`tenantList "${name}" visibleThrough.where "${key}" is not a column of "${getTableName(membership)}"`);
        }

        return value === null
            ? sql` AND "m".${sql.identifier(column.name)} is null`
            : sql` AND "m".${sql.identifier(column.name)} = ${sql.raw(sqlLiteral(value))}`;
    });

    return sql.join(conditions);
}

/** A string quoted with `'` doubled, a number or a boolean, as SQL text. */
function sqlLiteral(value: string | number | boolean): string
{
    return typeof value === 'string' ? `'${value.replaceAll('\'', '\'\'')}'` : String(value);
}

function qualifiedName(table: PgTable): SQL
{
    const schema = schemaOf(table);
    const name = sql.identifier(getTableName(table));

    return schema ? sql`${sql.identifier(schema)}.${name}` : sql`${name}`;
}

/** The extra config and the options of a table factory, from its fourth and fifth arguments. */
interface ConfigArguments<TOptions>
{
    readonly extraConfig: ((self: any) => PgTableExtraConfigValue[]) | undefined;
    readonly options: TOptions | undefined;
}

/**
 * A function in fourth place is the extra config and the options follow it; an
 * object there is the options, with no extra config.
 */
function configArguments<TOptions>(table: string, fourth: unknown, fifth: unknown): ConfigArguments<TOptions>
{
    if (fourth === undefined || typeof fourth === 'function')
    {
        return { extraConfig: fourth as ConfigArguments<TOptions>['extraConfig'], options: fifth as TOptions | undefined };
    }

    if (typeof fourth !== 'object' || fourth === null || fifth !== undefined)
    {
        throw new Error(`Table "${table}" takes the extra config as a function and the options as an object, in that order`);
    }

    return { extraConfig: undefined, options: fourth as TOptions };
}

/**
 * `schema.table(name, { id, tenant column, ...columns })`, with the tenancy
 * constraints ahead of the app's own extra config, registered and marked.
 */
function createTenancyTable(
    schema: PgSchema<string>,
    name: string,
    columns: Record<string, AnyPgColumnBuilder>,
    { extraConfig, options }: ConfigArguments<TenancyTableOptions>,
    tenancyShape: TenancyShape,
): PgTable
{
    assertTableColumns(name, columns, tenancyShape);

    const userKey = visibleToKey(name, columns, options, tenancyShape);
    const shape = userKey === undefined
        ? tenancyShape
        : { ...tenancyShape, marker: { ...tenancyShape.marker, visibleTo: columnNameOf(columns[userKey]) ?? userKey } };
    const references = pendingReferences(columns);
    const { id: idColumn, ...rest } = columns;
    const table = schema.table(name, { id: idColumn, [shape.property]: tenantKey(shape.marker.columnName), ...rest }, (t: any) => [
        ...tenancyConstraints(name, t, references, shape, userKey),
        ...(extraConfig ? extraConfig(t) : []),
    ]);

    registerTenancyTable(table, shape.marker);

    return table;
}

/**
 * The `visibleTo` property, checked: a declared column other than `id` and the
 * tenant property, holding an integer. Undefined without the option.
 */
function visibleToKey(
    table: string,
    columns: Record<string, AnyPgColumnBuilder>,
    options: TenancyTableOptions | undefined,
    shape: TenancyShape,
): string | undefined
{
    const key = options?.visibleTo as unknown;

    if (key === undefined)
    {
        return undefined;
    }

    if (typeof key !== 'string' || key === 'id' || key === shape.property)
    {
        throw new Error(`tenancy.table "${table}" { visibleTo: ${JSON.stringify(key)} } takes the property of a user column, not "id" or the tenant column`);
    }

    if (!Object.hasOwn(columns, key))
    {
        throw new Error(`tenancy.table "${table}" { visibleTo: "${key}" } names no column of the table; declare "${key}" in its columns`);
    }

    if (!INTEGER_DATA_TYPES.has(dataTypeOf(columns[key])))
    {
        throw new Error(`tenancy.table "${table}" { visibleTo: "${key}" } is not an integer column; visibleTo takes a bigint or integer user id column`);
    }

    return key;
}

function dataTypeOf(builder: AnyPgColumnBuilder): string
{
    const dataType = (builder as unknown as { config?: { dataType?: string } }).config?.dataType ?? '';

    return dataType.split(' ')[0];
}

function createReference(name: string, target: () => PgTable, options?: TenancyReferenceOptions): AnyPgColumnBuilder
{
    const optional = options?.optional === true;
    const onDelete = referenceOnDelete(name, options?.onDelete, optional);
    const column = optional ? optionalReferenceColumn(name) : requiredReferenceColumn(name);

    referenceSpecs.set(column, { name, target, onDelete });

    return column;
}

/** The delete action a reference asked for, or its default; anything else throws. */
function referenceOnDelete(name: string, onDelete: unknown, optional: boolean): TenancyOnDelete
{
    if (onDelete === undefined)
    {
        return optional ? 'no action' : 'cascade';
    }

    if (!ON_DELETE_ACTIONS.includes(onDelete as TenancyOnDelete))
    {
        throw new Error(
            `tenancy.reference('${name}') takes onDelete 'cascade', 'restrict' or 'no action', received ${JSON.stringify(onDelete)}; `
            + 'SET NULL and SET DEFAULT are not offered because the tenant column is part of the same foreign key',
        );
    }

    return onDelete as TenancyOnDelete;
}

/** The guard middleware: read the tenant, authorize it, run the rest bound to it. */
function createGuard(
    readTenant: (c: Context) => Promise<number>,
    authorize: TenancyOptions['authorize'],
    guardedTenants: WeakMap<Context, number>,
): MiddlewareHandler
{
    return async (c, next) =>
    {
        const tenantId = await readTenant(c);

        if (await authorize(c, tenantId) !== true)
        {
            throw new ForbiddenError({ message: 'Not allowed to access this tenant' });
        }

        guardedTenants.set(c, tenantId);
        await claimTransactionForGuard(tenantId);

        await runWithRequestTenant(tenantId, next);
    };
}

function guardedTenant(guardedTenants: WeakMap<Context, number>, c: Context | { raw: Context }): number
{
    const tenantId = guardedTenants.get('raw' in c ? c.raw : c);

    if (tenantId === undefined)
    {
        throw new Error('tenancy.of(c) was called on a route without tenancy.guard(); add the guard to the route');
    }

    return tenantId;
}

function requiredReferenceColumn(name: string)
{
    return bigint(`${name}_id`, { mode: 'number' }).notNull();
}

function optionalReferenceColumn(name: string)
{
    return bigint(`${name}_id`, { mode: 'number' });
}

function assertTenancyOptions(options: TenancyOptions<TenantListTable, string>): void
{
    if (!isTable(options?.tenants) || !(options.tenants as { id?: unknown }).id)
    {
        throw new Error('defineTenancy({ tenants }) takes the table that lists the tenants, with an id column');
    }

    if (typeof options.authorize !== 'function')
    {
        throw new Error('defineTenancy({ authorize }) takes a function (c, tenantId) => boolean');
    }

    if (options.column !== undefined && (typeof options.column !== 'string' || options.column === ''))
    {
        throw new Error('defineTenancy({ column }) takes a non-empty column name');
    }

    if (options.property !== undefined && (typeof options.property !== 'string' || options.property === '' || options.property === 'id'))
    {
        throw new Error('defineTenancy({ property }) takes a non-empty property name other than "id"');
    }
}

/** `columns` must have `id`, and must leave the tenant column — its property and its SQL name — to `tenancy.table`. */
function assertTableColumns(table: string, columns: Record<string, AnyPgColumnBuilder>, shape: TenancyShape): void
{
    const { property, marker: { columnName } } = shape;
    const declared = Object.entries(columns).find(([key, builder]) =>
        key === property || key === columnName || columnNameOf(builder) === columnName);

    if (declared)
    {
        throw new Error(
            `tenancy.table "${table}" declares "${declared[0]}"; the tenant column "${columnName}" is added by tenancy.table — remove it from the columns`,
        );
    }

    if (!columns.id)
    {
        throw new Error(`tenancy.table "${table}" has no id column; the tenant-scoped unique key and references need one`);
    }
}

function columnNameOf(builder: AnyPgColumnBuilder): string | undefined
{
    return (builder as unknown as { config?: { name?: string } }).config?.name;
}

function pendingReferences(columns: Record<string, AnyPgColumnBuilder>): PendingReference[]
{
    return Object.entries(columns).flatMap(([key, builder]) =>
    {
        const spec = referenceSpecs.get(builder);

        return spec ? [{ key, ...spec }] : [];
    });
}

/**
 * The constraints and policy every tenancy table gets. drizzle calls this while
 * it reads the table's config (`getTableConfig`, drizzle-kit), after every
 * module has loaded — which is what lets a reference point forward or at its
 * own table.
 */
function tenancyConstraints(
    table: string,
    t: Record<string, any>,
    references: PendingReference[],
    shape: TenancyShape,
    userKey: string | undefined,
): PgTableExtraConfigValue[]
{
    const { columnName, visibleTo } = shape.marker;
    const tenantColumn = t[shape.property];
    const isolation = sql`${sql.identifier(columnName)} = current_setting(${sql.raw(`'${TENANT_SETTING}'`)})::bigint`;
    const constraints = [
        unique(constraintName(table, `${columnName}_id_key`)).on(tenantColumn, t.id),
        pgForeignKey({ name: constraintName(table, `${columnName}_fk`), columns: [tenantColumn], foreignColumns: [shape.tenants.id] }),
        ...references.map((reference) => referenceForeignKey(table, t, reference, shape)),
        ...(visibleTo === undefined
            ? [pgPolicy(constraintName(table, 'tenant_isolation'), { using: isolation, withCheck: isolation })]
            : visibleToPolicies(table, columnName, visibleTo)),
    ];

    assertDistinctNames(table, constraints.map(nameOf));

    return userKey === undefined ? constraints : [...constraints, index(constraintName(table, `${visibleTo}_idx`)).on(t[userKey])];
}

/**
 * The settings the `visibleTo` and tenant list policies compare with, built in
 * one place. Text, not bound parameters: the policy lands in a migration file,
 * where drizzle-kit would write a parameter as `$1`.
 *
 * - TENANT_STRICT errors when no tenant is set — the single policy's read;
 * - TENANT_LENIENT and USER_LENIENT are NULL when unset, so they match nothing;
 * - TENANT_GUARDED is TENANT_STRICT unless a user is set, and TENANT_LENIENT
 *   when one is: a connection bound to neither still errors instead of
 *   returning nothing. A CASE evaluates only the branch it takes, which an OR
 *   of permissive policies does not promise.
 *
 * `nullif(..., '')` because a pooled connection keeps `''` once a transaction
 * that set the value has ended; `missing_ok` alone would cast that to bigint
 * and fail.
 */
const TENANT_STRICT = `current_setting('${TENANT_SETTING}')::bigint`;
const TENANT_LENIENT = `nullif(current_setting('${TENANT_SETTING}', true), '')`;
const USER_LENIENT = `nullif(current_setting('${USER_SETTING}', true), '')::bigint`;
const TENANT_GUARDED = `(case when nullif(current_setting('${USER_SETTING}', true), '') is null `
    + `then current_setting('${TENANT_SETTING}') else ${TENANT_LENIENT} end)::bigint`;

/** The four policies of a `visibleTo` table: read by tenant or user, write by tenant only. */
function visibleToPolicies(table: string, tenantColumn: string, userColumn: string)
{
    const tenant = sql.identifier(tenantColumn);
    const strict = sql`${tenant} = ${sql.raw(TENANT_STRICT)}`;
    const read = sql`${tenant} = ${sql.raw(TENANT_GUARDED)} OR ${sql.identifier(userColumn)} = ${sql.raw(USER_LENIENT)}`;

    return commandPolicies(table, { suffix: 'tenant_isolation', using: read }, strict, strict);
}

/**
 * One permissive policy per command, so the read policy cannot widen a write:
 * a `FOR ALL` policy applies to SELECT too, and permissive policies are OR-ed.
 */
function commandPolicies(table: string, read: { suffix: string; using: SQL }, insertCheck: SQL, strict: SQL)
{
    return [
        pgPolicy(constraintName(table, read.suffix), { for: 'select', using: read.using }),
        pgPolicy(constraintName(table, 'tenant_insert'), { for: 'insert', withCheck: insertCheck }),
        pgPolicy(constraintName(table, 'tenant_update'), { for: 'update', using: strict, withCheck: strict }),
        pgPolicy(constraintName(table, 'tenant_delete'), { for: 'delete', using: strict }),
    ];
}

function referenceForeignKey(table: string, t: Record<string, any>, reference: PendingReference, shape: TenancyShape)
{
    const target = reference.target();
    const targetMarker = findTenancyMarker(target);

    if (!targetMarker || !sameTenancy(targetMarker, shape.marker))
    {
        throw new Error(
            `tenancy.reference('${reference.name}') on "${table}" points at "${isTable(target) ? getTableName(target) : String(target)}", `
            + 'which is not a tenancy.table of the same tenancy; use foreignKey() for an ordinary table',
        );
    }

    const targetColumns = target as unknown as { id: PgColumn };

    return pgForeignKey({
        name: constraintName(table, `${reference.name}_fk`),
        columns: [t[shape.property], t[reference.key]],
        foreignColumns: [findTenantColumn(target)!.column as PgColumn, targetColumns.id],
    }).onDelete(reference.onDelete);
}

function sameTenancy(left: TenancyTableMarker, right: TenancyTableMarker): boolean
{
    return left.columnName === right.columnName
        && left.tenants.schema === right.tenants.schema
        && left.tenants.name === right.tenants.name;
}

function nameOf(constraint: PgTableExtraConfigValue): string
{
    const named = constraint as unknown as { name?: string; reference?: () => { name?: string } };

    return named.name ?? named.reference?.().name ?? '';
}

function assertDistinctNames(table: string, names: string[]): void
{
    const duplicate = names.find((name, index) => names.indexOf(name) !== index);

    if (duplicate)
    {
        throw new Error(`tenancy.table "${table}" would create two constraints named "${duplicate}"; rename the reference`);
    }
}

/**
 * `<table>_<suffix>`, or — past 63 bytes, where PostgreSQL would truncate it and
 * two names could become one — its first 54 bytes, `_`, and 8 hex digits of a
 * hash of the whole name.
 */
export function constraintName(table: string, suffix: string): string
{
    const full = `${table}_${suffix}`;

    if (Buffer.byteLength(full) <= MAX_IDENTIFIER_BYTES)
    {
        return full;
    }

    const hash = createHash('sha256').update(full).digest('hex').slice(0, HASH_LENGTH);

    return `${truncateBytes(full, MAX_IDENTIFIER_BYTES - HASH_LENGTH - 1)}_${hash}`;
}

function truncateBytes(text: string, maxBytes: number): string
{
    let result = '';

    for (const char of text)
    {
        if (Buffer.byteLength(result + char) > maxBytes)
        {
            break;
        }

        result += char;
    }

    return result;
}

function schemaOf(table: PgTable): string | undefined
{
    return (table as unknown as Record<symbol, string | undefined>)[Symbol.for('drizzle:Schema')];
}

/** Read the tenant id the guard was told to; checked when `tenancy.guard()` is called. */
function tenantReader(options: TenancyGuardOptions): (c: Context) => Promise<number>
{
    const { param, resolve } = (options ?? {}) as { param?: unknown; resolve?: unknown };

    if ((param === undefined) === (resolve === undefined))
    {
        throw new Error('tenancy.guard() takes exactly one of { param } or { resolve }');
    }

    if (param !== undefined)
    {
        if (typeof param !== 'string' || param === '')
        {
            throw new Error('tenancy.guard({ param }) takes a route parameter name');
        }

        return async (c) => tenantFromParam(c.req.param(param), param);
    }

    if (typeof resolve !== 'function')
    {
        throw new Error('tenancy.guard({ resolve }) takes a function (c) => tenant id');
    }

    return async (c) => tenantFromResolve(await resolve(c));
}

function tenantFromParam(raw: string | undefined, param: string): number
{
    const tenantId = /^[1-9][0-9]*$/.test(raw ?? '') ? Number(raw) : NaN;

    if (!isTenantId(tenantId))
    {
        throw new ValidationError({
            message: `Route parameter "${param}" must be a tenant id (a positive integer)`,
            fields: [{ path: param, message: 'must be a positive integer' }],
        });
    }

    return tenantId;
}

function tenantFromResolve(value: unknown): number
{
    if (!isTenantId(value))
    {
        throw new ValidationError({ message: 'The tenant id resolved for this request is not a positive integer' });
    }

    return value;
}
