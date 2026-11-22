/**
 * Push Identity
 *
 * Which objects drizzle-kit's push takes for one and the same on the database
 * and in the declaration, for push-steps.ts to read what drizzle-kit adds and
 * removes when it reported a kind removed and added. drizzle-kit exposes the
 * declared side (`generateDrizzleJson`) but not the database side, so these
 * are its rules as drizzle-kit 1.0.0-rc.4's api-postgres applies them in push:
 *
 * - which objects it introspects (`fromDatabase`, `fromDatabaseForDrizzle`):
 *   schemas with USAGE other than the system ones and `public`; tables
 *   (partitions included), views, materialized views, enums, and sequences no
 *   table column owns, in an admitted schema; a table's columns, constraints,
 *   policies and indexes — less the index a primary key or unique constraint
 *   uses; less the migrations table `drizzle.__drizzle_migrations`;
 * - which schemas it admits (`prepareSchemasFitler`): a `schemaFilter` entry
 *   is a minimatch glob, negated with `!`; a schema declared `.existing()` is
 *   never admitted, nor a view or materialized view declared `.existing()`;
 * - which objects are the same (`preserveEntityNames`): in push, a primary
 *   key, unique constraint, foreign key or index declared without a name
 *   takes the database's name of the one object of that table with the same
 *   definition — every field drizzle-kit compares but the name.
 */

import { is, sql } from 'drizzle-orm';
import { getMaterializedViewConfig, getViewConfig, isPgMaterializedView, isPgView, PgSchema } from 'drizzle-orm/pg-core';
// drizzle-kit 1.0.0-rc.4 reads schemaFilter with the minimatch 7.4.6 it bundles, as `new Minimatch(glob)`;
// minimatch 11 — the version the repository's override allows — reads a schema name's glob the same way
// (push-identity.test.ts holds the two to the same answers).
import { Minimatch } from 'minimatch';

import type { PushConnection } from './drizzle.js';

type Db = PushConnection['db'];

/** One object as drizzle-kit's DDL keys it — kind, schema, table, name — with the fields it compares. */
export interface SchemaObject
{
    entityType: string;
    schema?: string | null;
    table?: string | null;
    name: string;
    nameExplicit?: boolean;
    [field: string]: unknown;
}

/** The kinds whose unnamed declarations take the database's name (preserveEntityNames). */
const PRESERVED_KINDS = new Set(['pks', 'uniques', 'fks', 'indexes']);

/** drizzle-kit's system namespaces (`isSystemNamespace`). */
const isSystemSchema = (name: string) => name.startsWith('pg_toast') || name.startsWith('pg_temp_')
    || ['pg_default', 'pg_global', 'pg_catalog', 'information_schema', 'pscale_extensions'].includes(name);

/** A referential action column as drizzle-kit names its value (`parseOnType`). */
const action = (column: string) => sql.raw(`CASE ${column} WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'n' THEN 'SET NULL' `
    + `WHEN 'c' THEN 'CASCADE' ELSE 'SET DEFAULT' END`);

/** The names of `ordinals` (an attnum array) in table `relation`, in order. */
const columnNames = (ordinals: string, relation: string) => sql.raw(`ARRAY(SELECT a.attname FROM unnest(${ordinals}) WITH ORDINALITY u(n, o)
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = ${relation} AND a.attnum = u.n ORDER BY u.o)`);

/**
 * Every object of the kinds push-steps compares in every schema the role may
 * use, with the fields preserveEntityNames compares, in the order drizzle-kit
 * lists them: constraints by table, type and name, indexes by schema and name.
 */
const CATALOG = sql`
    WITH ns AS (SELECT oid, nspname FROM pg_catalog.pg_namespace WHERE pg_catalog.has_schema_privilege(oid, 'USAGE')),
    rel AS (SELECT c.*, ns.nspname FROM pg_catalog.pg_class c JOIN ns ON ns.oid = c.relnamespace)
    SELECT 'schemas' AS "entityType", NULL::text AS schema, NULL::text AS "table", nspname::text AS name, NULL::json AS fields, NULL::bigint AS position FROM ns
    UNION ALL
    SELECT CASE WHEN relkind IN ('v', 'm') THEN 'views' WHEN relkind = 'S' THEN 'sequences' ELSE 'tables' END, nspname, NULL, relname, NULL, NULL
    FROM rel WHERE relkind IN ('r', 'p', 'v', 'm')
        OR (relkind = 'S' AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class t ON t.oid = d.refobjid
            WHERE d.objid = rel.oid AND d.deptype IN ('a', 'i') AND t.relkind IN ('r', 'p')))
    UNION ALL
    SELECT 'enums', ns.nspname, NULL, t.typname, NULL, NULL FROM pg_catalog.pg_type t JOIN ns ON ns.oid = t.typnamespace WHERE t.typtype = 'e'
    UNION ALL
    SELECT 'columns', nspname, relname, a.attname, NULL, NULL
    FROM pg_catalog.pg_attribute a JOIN rel ON rel.oid = a.attrelid
    WHERE rel.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'policies', nspname, relname, p.polname, NULL, NULL FROM pg_catalog.pg_policy p JOIN rel ON rel.oid = p.polrelid
    UNION ALL
    SELECT CASE k.contype WHEN 'p' THEN 'pks' WHEN 'u' THEN 'uniques' WHEN 'f' THEN 'fks' ELSE 'checks' END, rel.nspname, rel.relname, k.conname,
        CASE k.contype
            WHEN 'p' THEN json_build_object('columns', ${columnNames('k.conkey', 'k.conrelid')})
            WHEN 'u' THEN json_build_object('columns', ${columnNames('k.conkey', 'k.conrelid')},
                'nullsNotDistinct', pg_catalog.pg_get_constraintdef(k.oid) LIKE '%NULLS NOT DISTINCT%')
            WHEN 'f' THEN json_build_object('columns', ${columnNames('k.conkey', 'k.conrelid')},
                'schemaTo', (SELECT n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = k.confrelid),
                'tableTo', (SELECT c.relname FROM pg_catalog.pg_class c WHERE c.oid = k.confrelid),
                'columnsTo', ${columnNames('k.confkey', 'k.confrelid')},
                'onUpdate', ${action('k.confupdtype')}, 'onDelete', ${action('k.confdeltype')})
        END,
        row_number() OVER (ORDER BY k.conrelid, k.contype, lower(k.conname))
    FROM pg_catalog.pg_constraint k JOIN rel ON rel.oid = k.conrelid
    WHERE rel.relkind IN ('r', 'p') AND k.contype IN ('p', 'u', 'f', 'c')
    UNION ALL
    SELECT 'indexes', i.nspname, t.relname, i.relname,
        json_build_object('method', am.amname, 'isUnique', x.indisunique, 'with', COALESCE(array_to_string(i.reloptions, ', '), ''),
            'where', pg_catalog.pg_get_expr(x.indpred, x.indrelid), 'keys', ${columnNames('x.indkey::int[]', 'x.indrelid')},
            'options', x.indoption::int[],
            'opclasses', ARRAY(SELECT json_build_object('name', o.opcname, 'default', o.opcdefault)
                FROM unnest(x.indclass) WITH ORDINALITY u(oid, n) JOIN pg_catalog.pg_opclass o ON o.oid = u.oid ORDER BY u.n)),
        row_number() OVER (ORDER BY lower(i.nspname), lower(i.relname))
    FROM pg_catalog.pg_index x JOIN rel i ON i.oid = x.indexrelid JOIN pg_catalog.pg_class t ON t.oid = x.indrelid
    JOIN pg_catalog.pg_am am ON am.oid = i.relam
    WHERE t.relkind IN ('r', 'p') AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k
        WHERE k.conindid = x.indexrelid AND ((k.contype = 'u' AND x.indisunique) OR (k.contype = 'p' AND x.indisprimary)))`;

interface CatalogRow
{
    entityType: string;
    schema: string | null;
    table: string | null;
    name: string;
    fields: Record<string, unknown> | null;
    position: string | null;
}

/**
 * The objects drizzle-kit's push introspects from `db` for `schemaFilter`
 * and the declarations in `imports`, keyed and ordered as it lists them.
 */
export async function existingObjects(db: Db, imports: Record<string, unknown>, schemaFilter: string[]): Promise<SchemaObject[]>
{
    const rows = ((await db.execute(CATALOG)).rows as CatalogRow[]).sort((a, b) => Number(a.position) - Number(b.position));
    const admitted = admission(schemaFilter, imports);
    const tables = new Set(rows.filter(row => row.entityType === 'tables' && admitted.table(row.schema!, row.name)).map(row => tableKey(row.schema, row.name)));
    const inScope = (row: CatalogRow) => row.table === null
        ? admittedTopLevel(row, admitted)
        : tables.has(tableKey(row.schema, row.table));

    return withoutMigrationsTable(rows.filter(inScope).map(toObject));
}

const tableKey = (schema: string | null | undefined, table: string | null | undefined) => JSON.stringify([schema, table]);

/** Whether drizzle-kit keeps a schema, table, view, enum or sequence row. */
function admittedTopLevel(row: CatalogRow, admitted: Admission): boolean
{
    if (row.entityType === 'schemas')
    {
        return row.name !== 'public' && admitted.schema(row.name);
    }

    return row.entityType === 'tables' || row.entityType === 'views'
        ? admitted.table(row.schema!, row.name)
        : admitted.schema(row.schema!);
}

/** A catalog row as drizzle-kit's DDL entity: a preserved kind's fields at the top, an index's columns built as drizzle-kit builds them. */
function toObject({ fields, position: _position, ...row }: CatalogRow): SchemaObject
{
    if (!fields)
    {
        return row;
    }

    return row.entityType === 'indexes'
        ? { ...row, ...indexFields(fields), concurrently: false }
        : { ...row, ...fields };
}

/**
 * An index's fields as drizzle-kit introspects them. Only its key columns
 * carry an option and an operator class; an expression keeps no value here,
 * since drizzle-kit names no index declared without a name on an expression,
 * so none is compared with one.
 */
function indexFields({ keys, options, opclasses, ...fields }: Record<string, unknown>): Record<string, unknown>
{
    const opclassOf = opclasses as { name: string; default: boolean }[];
    const columns = (keys as (string | null)[]).flatMap((value, i) =>
    {
        const option = (options as number[])[i];

        return option === undefined && value !== null ? [] : [{
            value: value ?? undefined,
            isExpression: value === null,
            asc: (option & 1) !== 1,
            nullsFirst: (option & 2) === 2,
            opclass: opclassOf[i].default ? null : opclassOf[i],
        }];
    });

    return { ...fields, columns };
}

/** drizzle-kit's `filterMigrationsSchema`: the migrations table is never diffed, nor `drizzle` when it holds nothing else. */
function withoutMigrationsTable(objects: SchemaObject[]): SchemaObject[]
{
    const isMigrations = (object: SchemaObject) => object.schema === 'drizzle'
        && (object.table ?? (object.entityType === 'tables' ? object.name : undefined)) === '__drizzle_migrations';
    const kept = objects.filter(object => !isMigrations(object) || !['tables', 'columns', 'pks'].includes(object.entityType));
    const drizzleHoldsTables = kept.some(object => object.entityType === 'tables' && object.schema === 'drizzle');

    return kept.filter(object => object.entityType !== 'schemas' || object.name !== 'drizzle' || drizzleHoldsTables);
}

interface Admission
{
    schema: (name: string) => boolean;
    table: (schema: string, name: string) => boolean;
}

/** drizzle-kit's entity filter for `schemaFilter`, the declarations in `imports` naming what is `.existing()`. */
function admission(schemaFilter: string[], imports: Record<string, unknown>): Admission
{
    const values = Object.values(imports);
    const existingSchemas = values.filter((value): value is PgSchema => is(value, PgSchema) && value.isExisting).map(value => value.schemaName);
    const existingViews = values.flatMap(value => existingView(value));
    const matchers = schemaFilter.map(glob => new Minimatch(glob));
    const schema = (name: string) => !isSystemSchema(name) && !existingSchemas.includes(name) && matchesGlobs(matchers, name);

    return {
        schema,
        table: (schemaName, name) => schema(schemaName) && !existingViews.some(view => view.schema === schemaName && view.name === name),
    };
}

/** As `prepareSchemasFitler` reads the globs: every glob that speaks of the name must admit it, and one must. */
function matchesGlobs(matchers: Minimatch[], name: string): boolean
{
    if (matchers.length === 0)
    {
        return true;
    }

    const flags = matchers.flatMap(matcher => matcher.negate && !matcher.match(name) ? [false] : matcher.match(name) ? [true] : []);

    return flags.length > 0 && flags.every(Boolean);
}

/** The schema and name of a view or materialized view declared `.existing()`. */
function existingView(value: unknown): { schema: string; name: string }[]
{
    const config = isPgView(value) ? getViewConfig(value) : isPgMaterializedView(value) ? getMaterializedViewConfig(value) : undefined;

    return config?.isExisting ? [{ schema: config.schema ?? 'public', name: config.name }] : [];
}

/**
 * `declared` with drizzle-kit's push renames applied (`preserveEntityNames`):
 * for each object of `existing` of a preserved kind, in drizzle-kit's order,
 * the one declared object of that kind with no name of its own and the same
 * fields takes its name.
 */
export function preserveEntityNames(existing: SchemaObject[], declared: SchemaObject[]): SchemaObject[]
{
    const renamed = declared.map(object => ({ ...object }));

    for (const { entityType, name, nameExplicit: _nameExplicit, ...fields } of existing.filter(object => PRESERVED_KINDS.has(object.entityType)))
    {
        const matches = renamed.filter(object => object.entityType === entityType && object.nameExplicit === false && matchesFields(object, fields));

        if (matches.length === 1)
        {
            matches[0].name = name;
        }
    }

    return renamed;
}

/** drizzle-kit's `matchesFilters`: every field the filter gives equals the object's. */
const matchesFields = (object: SchemaObject, fields: Record<string, unknown>) =>
    Object.entries(fields).every(([key, value]) => value === undefined || isEqual(object[key], value));

/** drizzle-kit's `isEqual`: deep, and `null` is not `undefined`. */
function isEqual(a: unknown, b: unknown): boolean
{
    if (typeof a !== typeof b)
    {
        return false;
    }
    if (Array.isArray(a) && Array.isArray(b))
    {
        return a.length === b.length && a.every((value, i) => isEqual(value, b[i]));
    }
    if (typeof a === 'object' && a !== b)
    {
        return a !== null && b !== null
            && [...new Set([...Object.keys(a), ...Object.keys(b as object)])].every(key => isEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
    }

    return a === b;
}
