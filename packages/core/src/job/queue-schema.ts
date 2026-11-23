/**
 * The pg-boss queue schema as the database owner's side needs to know it —
 * its version, the SQL that installs or migrates it, and what the catalog
 * says about it
 *
 * The SQL is pg-boss's own static plans (`getConstructionPlans`,
 * `getMigrationPlans`), from the pg-boss this core pins exactly, so it always
 * matches the pg-boss the server runs. Each plan is one multi-statement string
 * — `BEGIN; …; COMMIT;` under pg-boss's advisory lock — to run whole in one
 * simple-protocol call.
 */

import { createRequire } from 'node:module';
import PgBoss from 'pg-boss';
import { sql, type SQL } from 'drizzle-orm';
import { catalogRows, isQueueSchemaName, quoteIdentifier, type CatalogDb, type OwnedObject } from '@spfn/core/db';
import { describeError } from '@spfn/core/logger';

/** A pg-boss migration: the schema version it leaves, the one it starts from, and its SQL each way. */
interface PgBossMigration
{
    readonly version: number;
    readonly previous: number;
    readonly install: readonly string[];
    readonly uninstall?: readonly string[];
}

const pgBossFile = createRequire(import.meta.url);

/** The pg-boss release core pins. */
export const PG_BOSS_RELEASE: string = pgBossFile('pg-boss/package.json').version;

/** The queue schema version the pinned pg-boss creates and runs on, from its `version.json`. */
export const QUEUE_SCHEMA_VERSION: number = pgBossFile('pg-boss/version.json').schema;

/**
 * The queue schema versions pg-boss's migration plans start from. Not in its
 * public API, read from its migration store: safe because core pins pg-boss
 * exactly.
 */
function migrationStarts(schema: string): number[]
{
    return pgBossMigrations(schema).map(migration => migration.previous);
}

function pgBossMigrations(schema: string): PgBossMigration[]
{
    const store: { getAll(schema: string): PgBossMigration[] } = pgBossFile('pg-boss/src/migrationStore.js');

    return store.getAll(schema);
}

/**
 * The owner's step that resolves a queue schema refusal: `owner` installs or
 * migrates the queue (`spfn db migrate`, `spfn db push`), `grant` grants the
 * app role its part (`spfn db grant`).
 */
export type QueueSchemaStep = 'owner' | 'grant';

/**
 * The queue schema refused at boot (`initBoss`): pg-boss would have to
 * install or migrate it as a role that may not, or cannot read it, or it is
 * not pg-boss's, or at a version pg-boss cannot migrate from. The message
 * names the schema, the versions where they matter, and what to do.
 */
export class JobQueueSchemaError extends Error
{
    /** The queue schema version this build's pg-boss runs on */
    readonly required: number = QUEUE_SCHEMA_VERSION;

    /**
     * @param schema - the queue schema
     * @param installed - its version; null when nothing is installed, absent when not read
     * @param step - the owner's step that resolves it; null where no spfn command does
     */
    constructor(readonly schema: string, readonly installed: number | null | undefined, readonly step: QueueSchemaStep | null, message: string)
    {
        super(message);
        this.name = 'JobQueueSchemaError';
    }
}

/**
 * A queue schema at a version the pinned pg-boss cannot migrate to
 * `QUEUE_SCHEMA_VERSION`: the owner step's `queueMigrationSql` and the boot
 * (`initBoss`) refuse it alike.
 */
export class QueueSchemaVersionError extends JobQueueSchemaError
{
    constructor(schema: string, override readonly installed: number, override readonly required: number, reason: string)
    {
        super(schema, installed, null, `Queue schema ${schema} is at pg-boss schema version ${installed}; pg-boss ${PG_BOSS_RELEASE} needs ${required}: ${reason}`);
        this.name = 'QueueSchemaVersionError';
    }
}

/**
 * The SQL that creates the queue schema `schema` at `QUEUE_SCHEMA_VERSION`,
 * the schema itself included (`CREATE SCHEMA IF NOT EXISTS`).
 *
 * @throws QueueSchemaNameError when `schema` is no queue schema name
 *     (`isQueueSchemaName`): pg-boss puts it in the SQL unquoted
 */
export function queueInstallSql(schema: string): string
{
    return PgBoss.getConstructionPlans(queueSchemaName(schema));
}

/**
 * The SQL that migrates the queue schema `schema` from version `from` to
 * `QUEUE_SCHEMA_VERSION`. pg-boss itself builds a plan for a version older
 * than its first migration start — the plan of that start, which would run on
 * a schema it was not written for — so that is refused here.
 *
 * @throws QueueSchemaVersionError naming both versions when `from` is not
 *     older than `QUEUE_SCHEMA_VERSION`, or older than pg-boss migrates from
 * @throws QueueSchemaNameError when `schema` is no queue schema name
 */
export function queueMigrationSql(schema: string, from: number): string
{
    const unmigratable = queueMigrationRefusal(schema, from);

    if (unmigratable !== undefined)
    {
        throw unmigratable;
    }

    return PgBoss.getMigrationPlans(schema, String(from));
}

/**
 * Why the pinned pg-boss cannot migrate the queue schema `schema` from
 * version `from` to `QUEUE_SCHEMA_VERSION`; undefined when it can. Below its
 * oldest migration start the answer names the version to migrate to first,
 * with an earlier pg-boss release.
 *
 * @throws QueueSchemaNameError when `schema` is no queue schema name
 */
export function queueMigrationRefusal(schema: string, from: number): QueueSchemaVersionError | undefined
{
    const oldest = Math.min(...migrationStarts(queueSchemaName(schema)));

    if (from >= QUEUE_SCHEMA_VERSION)
    {
        return new QueueSchemaVersionError(schema, from, QUEUE_SCHEMA_VERSION, 'there is nothing to migrate');
    }

    if (!Number.isInteger(from) || from < oldest)
    {
        return new QueueSchemaVersionError(schema, from, QUEUE_SCHEMA_VERSION, `it migrates from version ${oldest} on. `
            + `Migrate it to version ${oldest} first, with the pg-boss release that runs on that schema version.`);
    }

    return undefined;
}

/** A queue schema name pg-boss's unquoted SQL breaks on, or that it and the catalog would read as two schemas (`isQueueSchemaName`). */
export class QueueSchemaNameError extends Error
{
    constructor(readonly schema: string)
    {
        super(`"${schema}" is no queue schema name: lower-case letters, digits and _, at most 50, not starting with a digit or pg_, and no PostgreSQL keyword but an unreserved one`);
        this.name = 'QueueSchemaNameError';
    }
}

function queueSchemaName(schema: string): string
{
    if (!isQueueSchemaName(schema))
    {
        throw new QueueSchemaNameError(schema);
    }

    return schema;
}

/** What the catalog says about the queue schema, to the connected role. */
export interface QueueSchemaState
{
    readonly schema: string;
    /** Whether the schema exists */
    readonly exists: boolean;
    /** Whether the connected role is its owner or inherits its owner's privileges */
    readonly ownsSchema: boolean;
    /**
     * Whether the connected role is, or inherits, the owner of every object
     * the schema holds (`SchemaObject`); true when it holds none. PostgreSQL
     * lets only an object's owner alter, replace or drop it, whoever owns
     * the schema.
     */
    readonly ownsObjects: boolean;
    /**
     * The roles through which the connected role owns the schema or objects
     * in it — itself, or a role it inherits — each once, quoted as
     * identifiers; empty where it owns nothing there. What the ownership
     * remedy moves (`queueOwnershipTransfer`).
     */
    readonly ownedBy: readonly string[];
    /**
     * Every role that owns the schema or an object in it — those of
     * `ownedBy` among them — each once, quoted as identifiers, the schema's
     * owner first; empty where there is no schema. pg-boss installs and
     * migrates the queue only as a role that owns, or inherits the owner of,
     * all of it.
     */
    readonly owners: readonly string[];
    /**
     * The schema and the objects in it the bootstrap superuser owns, as
     * `ALTER … OWNER TO` names them: PostgreSQL refuses REASSIGN OWNED BY
     * that role, so the ownership transfer moves each one by one.
     */
    readonly bootstrapOwned: readonly OwnedObject[];
    /** Whether the connected role may use the schema */
    readonly usage: boolean;
    /** Whether the connected role may create schemas in the database */
    readonly mayCreateOnDatabase: boolean;
    /**
     * Whether the schema is known not to be pg-boss's, so pg-boss may be
     * neither installed nor migrated there: it holds objects but not all of
     * pg-boss's tables and types, or an object pg-boss creates none of — a
     * project's table beside pg-boss's, a view named `version` — or, where
     * the role may read it, a `version` table that does not hold exactly one
     * integer. The objects come from the catalog, which every role may read.
     * Its version is then absent, never a number.
     */
    readonly notPgBoss: boolean;
    /**
     * The installed pg-boss schema version; null when nothing is installed and
     * pg-boss may be: there is no schema, or it holds no object at all.
     * Absent when the schema is not pg-boss's, or the role may not read it:
     * no USAGE on the schema, or no SELECT on `version`.
     */
    readonly version?: number | null;
}

/** The catalog's facts on the queue schema and its `version` table. */
interface QueueSchemaFacts
{
    readonly exists: boolean;
    readonly ownsSchema: boolean;
    /** The schema's owner, quoted as an identifier; null when there is no schema */
    readonly schemaOwner: string | null;
    /** Whether the schema's owner is the bootstrap superuser */
    readonly schemaOwnerBootstrap: boolean;
    readonly usage: boolean;
    readonly mayCreateOnDatabase: boolean;
    readonly mayReadVersion: boolean;
    readonly objects: readonly SchemaObject[];
    /** The `version` table as read with the facts (`readQueueSchemaFactsAndVersion`); null where not read */
    readonly versionRead: VersionRead | null;
}

/** The `version` table as one statement read it with the catalog's facts. */
interface VersionRead
{
    /** Whether the table read is the `version` table the statement's catalog rows show */
    readonly fromVersionTable: boolean | null;
    /** The `version` column of up to two of its rows, each null where it is no integer; null for no row */
    readonly versions: readonly unknown[] | null;
}

/**
 * An object the queue schema holds as `DROP SCHEMA` without CASCADE refuses
 * for — not its default privileges, nor what hangs on a table (indexes,
 * constraints, row types) — as `<kind> <name>`: `table` (plain or
 * partitioned) or `type`; a function as `function <name>(<argument types>)`,
 * the types as the catalog spells them (`oidvectortypes`); any other kind
 * by its catalog. A
 * partition attached to the schema's `job` table is one pg-boss's
 * `create_queue` makes for a partitioned queue, under a name it derives from
 * the queue's (`j<sha224>`). `owned` is whether the connected role is, or
 * inherits, its owner; false for a kind whose owner is not read.
 */
interface SchemaObject
{
    readonly object: string;
    readonly jobPartition: boolean;
    readonly owned: boolean;
    /** Its owner, quoted as an identifier; null for a kind whose owner is not read */
    readonly owner: string | null;
    /** The object as `ALTER … OWNER TO` names it, where the bootstrap superuser owns it; null otherwise */
    readonly bootstrapOwned: OwnedObject | null;
}

/** pg-boss's objects in a queue schema, from its own SQL (`pgBossObjects`). */
interface PgBossObjects
{
    /** The tables and types every pg-boss schema it migrates holds: those its construction plan creates and no migration does */
    readonly required: readonly string[];
    /** Every object its construction plan or a migration either way creates */
    readonly created: ReadonlySet<string>;
}

const CREATE_STATEMENT = /CREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|TYPE|FUNCTION)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\.(\w+)\s*(?:\(([^)]*)\))?/gi;

/**
 * pg-boss's objects in the queue schema `schema`, read from the SQL of the
 * pinned pg-boss — its construction plan and its migrations' — so a pg-boss
 * release that adds, drops or renames one changes them with it. A table or
 * type a migration creates is one an older schema may lack, so it is not
 * required. Tables `create_queue` names at run time (`%I`) are no name here:
 * they are told apart as partitions of `job`. A function is its name and its
 * argument types, so a project's function of a pg-boss name with other
 * arguments is no object of pg-boss's.
 */
function pgBossObjects(schema: string): PgBossObjects
{
    const migrated = pgBossMigrations(schema).flatMap(migration => [...migration.install, ...migration.uninstall ?? []]);
    const constructed = createdObjects(queueInstallSql(schema), schema);
    const migratedObjects = createdObjects(migrated.join(';\n'), schema);

    return {
        required: constructed.filter(object => !object.startsWith('function ') && !migratedObjects.includes(object)),
        created: new Set([...constructed, ...migratedObjects]),
    };
}

function createdObjects(statements: string, schema: string): string[]
{
    return [...statements.matchAll(CREATE_STATEMENT)]
        .filter(([, , objectSchema]) => objectSchema === schema)
        .map(([, kind, , name, parameters]) => kind.toUpperCase() === 'FUNCTION'
            ? `function ${name}(${argumentTypes(parameters ?? '')})`
            : `${kind.toLowerCase()} ${name}`);
}

/**
 * The argument types of a parameter list as pg-boss's SQL declares it —
 * `name type, …` — joined as the catalog's `oidvectortypes` lists them. A
 * pg-boss release spelling a type otherwise than the catalog (`int` for
 * `integer`) reads every install as not pg-boss's: loud, never lenient.
 */
function argumentTypes(parameters: string): string
{
    return parameters.split(',').map(parameter => parameter.trim().split(/\s+/).slice(1).join(' ')).join(', ');
}

/**
 * Read the queue schema's state for the connected role. The schema, its
 * owner, the privileges and the objects it holds come from the catalog, which
 * every role may read; it is pg-boss's when it holds all of pg-boss's tables
 * and types and nothing pg-boss does not create (`pgBossObjects`).
 *
 * The state returned is the one a single statement saw, under its one
 * snapshot: the schema, its objects, its `version` table and that table's
 * rows are rows that statement read, the table checked to be the `version`
 * table its catalog rows show (`readQueueSchemaFactsAndVersion`); the
 * privileges are the catalog's as that statement runs. PostgreSQL refuses a
 * SELECT on `<schema>.version` where the table is missing or the role may not
 * read it (42P01, 42501 — even `to_regclass` raises 42501 in a schema without
 * USAGE), so the catalog is read first, without the version. Only where that
 * statement shows a pg-boss schema whose `version` the role may read is a
 * second one sent, reading the catalog again together with the version, and
 * the state returned is the second's. A statement is the one unit of snapshot
 * that holds on every connection: a pool hands each statement to any of its
 * connections, so a transaction across statements is not one.
 *
 * pg-boss's install plan is one transaction, its INSERT into `version` last,
 * so a snapshot holds the schema as it was before or all of pg-boss's —
 * never an empty `version` table, nor some of its tables.
 *
 * @throws QueueSchemaNameError when `schema` is no queue schema name, before
 *     the catalog is read: the catalog would be asked about another schema
 *     than pg-boss's SQL names
 * @throws QueueSchemaChangedError when the schema or its `version` table is
 *     dropped or replaced, or the role's privilege on either revoked, while
 *     the state is read
 */
export async function readQueueSchemaState(db: CatalogDb, schema: string): Promise<QueueSchemaState>
{
    queueSchemaName(schema);
    const facts = await readQueueSchemaFacts(db, schema);

    return queueSchemaState(schema, mayReadVersion(facts, schema) ? await readQueueSchemaFactsAndVersion(db, schema) : facts);
}

/**
 * The queue schema or its `version` table was dropped or replaced, or the
 * connected role's privilege on either revoked, while its state was read
 * (`readQueueSchemaState`). Reading it again reads the schema as it is now.
 */
export class QueueSchemaChangedError extends Error
{
    constructor(readonly schema: string, options?: ErrorOptions)
    {
        super(`Queue schema ${schema} or its version table was dropped or replaced, or the connected role's privilege on either revoked, while its state was read`, options);
        this.name = 'QueueSchemaChangedError';
    }
}

/** Whether `facts` show a pg-boss schema whose `version` table the connected role may read. */
function mayReadVersion(facts: QueueSchemaFacts, schema: string): boolean
{
    return facts.objects.length > 0 && holdsPgBossAlone(facts.objects, schema) && facts.usage && facts.mayReadVersion;
}

function queueSchemaState(schema: string, { objects, versionRead, ...facts }: QueueSchemaFacts): QueueSchemaState
{
    const state = {
        schema,
        exists: facts.exists,
        ownsSchema: facts.ownsSchema,
        ownsObjects: objects.every(object => object.owned),
        ownedBy: [...new Set([...facts.ownsSchema && facts.schemaOwner !== null ? [facts.schemaOwner] : [],
            ...objects.flatMap(object => object.owned && object.owner !== null ? [object.owner] : [])])],
        owners: [...new Set([...facts.schemaOwner === null ? [] : [facts.schemaOwner],
            ...objects.flatMap(object => object.owner === null ? [] : [object.owner]).sort()])],
        bootstrapOwned: [...facts.schemaOwnerBootstrap && facts.schemaOwner !== null ? [{ owner: facts.schemaOwner, kind: 'SCHEMA', object: schema }] : [],
            ...objects.flatMap(object => object.bootstrapOwned === null ? [] : [object.bootstrapOwned])],
        usage: facts.usage,
        mayCreateOnDatabase: facts.mayCreateOnDatabase,
    };

    if (objects.length === 0)
    {
        return { ...state, notPgBoss: false, version: null };
    }

    if (!holdsPgBossAlone(objects, schema))
    {
        return { ...state, notPgBoss: true };
    }

    if (!facts.usage || !facts.mayReadVersion)
    {
        return { ...state, notPgBoss: false };
    }

    const versions = versionRead?.versions;

    return versions?.length === 1 && Number.isInteger(versions[0])
        ? { ...state, notPgBoss: false, version: versions[0] as number }
        : { ...state, notPgBoss: true };
}

/** Whether `objects` are every table and type pg-boss requires, and nothing it does not create or attach to `job`. */
function holdsPgBossAlone(objects: readonly SchemaObject[], schema: string): boolean
{
    const pgBoss = pgBossObjects(schema);

    return objects.every(({ object, jobPartition }) => jobPartition || pgBoss.created.has(object))
        && pgBoss.required.every(required => objects.some(({ object }) => object === required));
}

/** The bootstrap superuser's oid (BOOTSTRAP_SUPERUSERID): fixed, whatever the role is named. */
const BOOTSTRAP_SUPERUSER_OID = 10;

/** The objects of the namespace `n` of the enclosing query, as a JSON array of `SchemaObject`. */
const SCHEMA_OBJECTS = sql`
    SELECT json_agg(json_build_object(
        'object', CASE
            WHEN c.relkind IN ('r', 'p') THEN 'table ' || c.relname
            WHEN t.oid IS NOT NULL THEN 'type ' || t.typname
            WHEN p.oid IS NOT NULL THEN 'function ' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')'
            ELSE pg_catalog.pg_describe_object(d.classid, d.objid, d.objsubid)
        END,
        'jobPartition', coalesce(c.relispartition AND EXISTS (
            SELECT FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class job ON job.oid = i.inhparent
            WHERE i.inhrelid = c.oid AND job.relnamespace = n.oid AND job.relname = 'job'
        ), false),
        'owned', coalesce(pg_catalog.pg_has_role(coalesce(c.relowner, t.typowner, p.proowner), 'USAGE'), false),
        'owner', quote_ident(pg_catalog.pg_get_userbyid(coalesce(c.relowner, t.typowner, p.proowner))),
        'bootstrapOwned', CASE WHEN coalesce(c.relowner, t.typowner, p.proowner) = ${sql.raw(String(BOOTSTRAP_SUPERUSER_OID))} THEN json_build_object(
            'owner', quote_ident(pg_catalog.pg_get_userbyid(${sql.raw(String(BOOTSTRAP_SUPERUSER_OID))})),
            'kind', CASE WHEN p.oid IS NOT NULL THEN 'FUNCTION' WHEN t.oid IS NOT NULL THEN 'TYPE'
                WHEN c.relkind = 'S' THEN 'SEQUENCE' WHEN c.relkind = 'v' THEN 'VIEW' WHEN c.relkind = 'm' THEN 'MATERIALIZED VIEW'
                WHEN c.relkind = 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
            'object', quote_ident(n.nspname) || '.' || quote_ident(coalesce(c.relname, t.typname, p.proname))
                || coalesce('(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')', '')) END))
    FROM pg_catalog.pg_depend d
    LEFT JOIN pg_catalog.pg_class c ON d.classid = 'pg_catalog.pg_class'::regclass AND c.oid = d.objid
    LEFT JOIN pg_catalog.pg_type t ON d.classid = 'pg_catalog.pg_type'::regclass AND t.oid = d.objid
    LEFT JOIN pg_catalog.pg_proc p ON d.classid = 'pg_catalog.pg_proc'::regclass AND p.oid = d.objid
    WHERE d.refclassid = 'pg_catalog.pg_namespace'::regclass AND d.refobjid = n.oid AND d.deptype = 'n'`;

/**
 * The catalog's facts on the queue schema, in one statement, with
 * `versionRead` as its column of that name. Its objects (`SchemaObject`) are
 * its namespace dependencies; none when there is no such schema.
 */
async function readQueueSchemaFacts(db: CatalogDb, schema: string, versionRead: SQL = sql`NULL::json`): Promise<QueueSchemaFacts>
{
    const [facts] = catalogRows(await db.execute(sql`
        SELECT n.oid IS NOT NULL AS exists,
            coalesce(pg_catalog.pg_has_role(n.nspowner, 'USAGE'), false) AS "ownsSchema",
            quote_ident(pg_catalog.pg_get_userbyid(n.nspowner)) AS "schemaOwner",
            coalesce(n.nspowner = ${sql.raw(String(BOOTSTRAP_SUPERUSER_OID))}, false) AS "schemaOwnerBootstrap",
            coalesce(pg_catalog.has_schema_privilege(n.oid, 'USAGE'), false) AS usage,
            pg_catalog.has_database_privilege(current_database(), 'CREATE') AS "mayCreateOnDatabase",
            coalesce(pg_catalog.has_table_privilege(v.oid, 'SELECT'), false) AS "mayReadVersion",
            coalesce((${SCHEMA_OBJECTS}), '[]'::json) AS objects,
            ${versionRead} AS "versionRead"
        FROM (SELECT 1) one
        LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = ${schema}
        LEFT JOIN pg_catalog.pg_class v ON v.relnamespace = n.oid AND v.relname = 'version' AND v.relkind IN ('r', 'p')`));

    return facts as unknown as QueueSchemaFacts;
}

/** What PostgreSQL raises on a SELECT on a table that is gone, or that the role may no longer read. */
const SCHEMA_CHANGED = ['42P01', '42501'];

/**
 * The catalog's facts on the queue schema and, from the same statement, its
 * `version` table read (`VersionRead`): the `version` column of up to two
 * rows — null where that column is no integer, or missing (PostgreSQL then
 * reads `version` as the whole row).
 *
 * PostgreSQL resolves `<schema>.version` when it parses the statement and
 * locks that table, but it takes the snapshot the catalog rows are read under
 * later, at execution: a schema renamed, and another created under its name,
 * in between is the one the catalog rows show, while the rows read are the
 * renamed one's. So the table's oid is resolved again in the same parse,
 * as a constant (`'<schema>.version'::regclass`) in the select list of the
 * subquery whose FROM names the table — PostgreSQL parses a FROM, and locks
 * its tables, before the select list — and compared with the `version` table
 * of the catalog rows.
 *
 * @throws QueueSchemaChangedError when the table or the schema is gone, or
 *     the role may no longer read it (42P01, 42501), or the table read is not
 *     the `version` table the catalog rows show
 */
async function readQueueSchemaFactsAndVersion(db: CatalogDb, schema: string): Promise<QueueSchemaFacts>
{
    const table = `${quoteIdentifier(schema)}.version`;
    const facts = await readQueueSchemaFacts(db, schema, sql`(
        SELECT json_build_object(
            'versions', json_agg(CASE WHEN pg_catalog.pg_typeof(version) = 'pg_catalog.int4'::pg_catalog.regtype THEN version END),
            'fromVersionTable', v.oid = ${sql.raw(`'${table}'`)}::pg_catalog.regclass)
        FROM (SELECT version FROM ${sql.raw(table)} LIMIT 2) r)`)
        .catch((error: unknown) => Promise.reject(SCHEMA_CHANGED.includes(String(describeError(error, { stack: false }).code))
            ? new QueueSchemaChangedError(schema, { cause: error })
            : error));

    if (facts.versionRead?.fromVersionTable !== true)
    {
        throw new QueueSchemaChangedError(schema);
    }

    return facts;
}
