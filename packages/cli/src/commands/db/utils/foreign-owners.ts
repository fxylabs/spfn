/**
 * Who owns what `db push` manages, asked of the catalog after PostgreSQL
 * refused push a privilege (SQLSTATE 42501)
 *
 * A 42501 has many causes — a revoked schema privilege, an extension only a
 * superuser may create — and one of them has an ownership remedy: objects push
 * alters belong to a role other than the one it connects as (a database pushed
 * through DATABASE_URL before push connected as the owner, or through a
 * superuser's URL). That is a catalog fact, so the remedy is printed only when
 * the catalog shows such objects, with the role names the catalog gives:
 * `REASSIGN OWNED BY <their owner> TO <connected role>` for every owner but the
 * bootstrap superuser, for which PostgreSQL refuses REASSIGN OWNED outright, so
 * its objects get one `ALTER … OWNER TO <connected role>` each instead. The
 * objects are the managed schemas, their relations and their enum types (a
 * `pgEnum` created through a superuser's URL is the superuser's, and push's
 * `ALTER TYPE … ADD VALUE` needs its owner). It
 * leaves out what neither need move: an extension's members (PostGIS's
 * `spatial_ref_sys`, `pg_stat_statements`' views), which belong to the
 * extension, a sequence a column owns, which moves with its table, and the
 * objects initdb created.
 */

import { sql } from 'drizzle-orm';

import type { PushConnection } from './drizzle.js';

/** How many objects the remedy names before it says how many more there are */
const LISTED_OBJECTS = 5;

/** The bootstrap superuser's oid (BOOTSTRAP_SUPERUSERID): fixed, whatever the role is named. */
const BOOTSTRAP_SUPERUSER_OID = 10;

/** The first oid after initdb's (FirstNormalObjectId): every lower one is the system's. */
const FIRST_NORMAL_OBJECT_ID = 16384;

interface ForeignOwnedObject
{
    connectedRole: string;
    owner: string;
    /** Whether the owner is the bootstrap superuser, whose objects REASSIGN OWNED cannot move */
    bootstrap: boolean;
    /** What `ALTER … OWNER TO` names the object as: `SCHEMA`, `TABLE`, `SEQUENCE`, `VIEW`, … */
    kind: string;
    /** The object's name, quoted as an identifier, schema-qualified for a relation */
    object: string;
    /** A relation's or type's schema, unquoted; null for a schema */
    schema: string | null;
    /** The schema's, relation's or type's own name, unquoted */
    name: string;
}

/** A relation or type as a statement names it: schema and name, unquoted. */
interface Relation
{
    schema: string;
    name: string;
}

/**
 * The relations and enum types (not a table's row type) in `schemas` owned by
 * a role the connected one neither is nor inherits the privileges of
 * (`pg_has_role` … `USAGE`: ownership through membership counts as its own),
 * and those of `schemas` such a role owns without granting it CREATE — a
 * schema owned elsewhere that it may create in, such as `public` owned by
 * `pg_database_owner`, stops nothing push does. Extension members, sequences a
 * column owns (`ALTER TABLE … OWNER TO` moves them with their table, and
 * refuses them alone; the dependency rule is the sequences' own, since a
 * partition depends on its parent, and a partitioned table on itself, the
 * same way) and initdb's objects are left out. `connectedRole`, `owner` and
 * `object` come quoted as identifiers, ready for SQL.
 */
async function foreignOwnedObjects(db: PushConnection['db'], schemas: string[]): Promise<ForeignOwnedObject[]>
{
    const result = await db.execute(sql`
        SELECT quote_ident(current_user) AS "connectedRole", quote_ident(pg_catalog.pg_get_userbyid(o.owner)) AS owner,
            o.owner = ${sql.raw(String(BOOTSTRAP_SUPERUSER_OID))} AS bootstrap, o.kind, o.object, o.schema, o.name
        FROM (
            SELECT n.nspowner AS owner, 'SCHEMA' AS kind, quote_ident(n.nspname) AS object, NULL::text AS schema, n.nspname::text AS name,
                'pg_catalog.pg_namespace'::regclass AS classid, n.oid AS objid
            FROM pg_catalog.pg_namespace n
            WHERE n.nspname = ANY(${sql.param(schemas)}) AND NOT pg_catalog.has_schema_privilege(n.oid, 'CREATE')
            UNION ALL
            SELECT c.relowner,
                CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
                quote_ident(n.nspname) || '.' || quote_ident(c.relname), n.nspname::text, c.relname::text,
                'pg_catalog.pg_class'::regclass, c.oid
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ANY(${sql.param(schemas)}) AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
            UNION ALL
            SELECT t.typowner, 'TYPE', quote_ident(n.nspname) || '.' || quote_ident(t.typname), n.nspname::text, t.typname::text,
                'pg_catalog.pg_type'::regclass, t.oid
            FROM pg_catalog.pg_type t
            JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = ANY(${sql.param(schemas)}) AND t.typtype = 'e'
        ) o
        WHERE NOT pg_catalog.pg_has_role(o.owner, 'USAGE')
            AND o.objid >= ${sql.raw(String(FIRST_NORMAL_OBJECT_ID))}
            AND NOT EXISTS (
                SELECT FROM pg_catalog.pg_depend d
                WHERE d.classid = o.classid AND d.objid = o.objid
                    AND (d.deptype = 'e' OR (o.kind = 'SEQUENCE' AND d.deptype IN ('a', 'i') AND d.refclassid = 'pg_catalog.pg_class'::regclass))
            )
        ORDER BY owner, object`);

    return result.rows as ForeignOwnedObject[];
}

/** An identifier as drizzle-kit writes one: always double-quoted, a `"` inside doubled. */
const IDENTIFIER = '"((?:[^"]|"")+)"';

/**
 * The relation a statement acts on, in the forms drizzle-kit's push writes
 * (its api-postgres convertors) and its data-loss check reads, the relation
 * `"schema"."name"`, or `"name"` alone in `public`:
 *
 * - `ALTER TABLE [IF EXISTS] [ONLY] <relation> …`
 * - `ALTER|DROP TABLE|SEQUENCE|VIEW|MATERIALIZED VIEW [IF EXISTS] <relation> …`
 * - `CREATE [UNIQUE] INDEX [CONCURRENTLY] [IF NOT EXISTS] "<index>" ON [ONLY] <relation> …`
 * - `CREATE|ALTER POLICY "<policy>" ON <relation> …`, `DROP POLICY [IF EXISTS] "<policy>" ON <relation> …`
 * - `ALTER TYPE <type> …`, `DROP TYPE [IF EXISTS] <type> …`
 * - `select 1 from <relation> limit 1` (the data-loss check, while planning)
 *
 * The optional words are those PostgreSQL's grammar allows before the name of
 * each kind. The first relation after the keywords, so a column, or the table
 * a foreign key references, is never taken for it. `CREATE TABLE` has none: a
 * table it creates is no one's yet.
 */
const STATEMENT_TARGET = new RegExp('^\\s*(?:'
    + 'ALTER\\s+TABLE(?:\\s+IF\\s+EXISTS)?(?:\\s+ONLY)?'
    + '|(?:ALTER|DROP)\\s+(?:TABLE|SEQUENCE|(?:MATERIALIZED\\s+)?VIEW)(?:\\s+IF\\s+EXISTS)?'
    + `|CREATE\\s+(?:UNIQUE\\s+)?INDEX(?:\\s+CONCURRENTLY)?(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+${IDENTIFIER}\\s+ON(?:\\s+ONLY)?`
    + `|(?:(?:CREATE|ALTER)\\s+POLICY|DROP\\s+POLICY(?:\\s+IF\\s+EXISTS)?)\\s+${IDENTIFIER}\\s+ON`
    + '|ALTER\\s+TYPE|DROP\\s+TYPE(?:\\s+IF\\s+EXISTS)?'
    + '|SELECT\\s+1\\s+FROM'
    + `)\\s+(?:${IDENTIFIER}\\.)?${IDENTIFIER}`, 'i');

/** The relation or type `statement` acts on (`STATEMENT_TARGET`); undefined for any other statement. */
export function statementTarget(statement: string | undefined): Relation | undefined
{
    const match = STATEMENT_TARGET.exec(statement ?? '');
    const [schema, name] = match?.slice(-2).map(identifier => identifier?.replaceAll('""', '"')) ?? [];

    return name === undefined ? undefined : { schema: schema ?? 'public', name };
}

/**
 * `objects` with the relation `failedStatement` acts on first; in the
 * catalog's order when the statement has no relation of its own, or none of
 * them is it.
 */
function targetFirst(objects: ForeignOwnedObject[], failedStatement: string | undefined): ForeignOwnedObject[]
{
    const target = statementTarget(failedStatement);
    const isTarget = (entry: ForeignOwnedObject) => target !== undefined && entry.schema === target.schema && entry.name === target.name;

    return [...objects.filter(isTarget), ...objects.filter(entry => !isTarget(entry))];
}

/**
 * The ownership remedy for the objects among `schemas` another role owns: the
 * first few, the one the failed statement acts on first, then REASSIGN OWNED
 * for their owners and one ALTER … OWNER TO for each object the bootstrap
 * superuser owns; undefined when there are none, or when the catalog could not
 * be read.
 */
export async function ownershipRemedy(
    db: PushConnection['db'],
    schemas: string[],
    failedStatement?: string,
): Promise<string | undefined>
{
    const objects = targetFirst(await foreignOwnedObjects(db, schemas).then(rows => rows, () => []), failedStatement);

    if (objects.length === 0)
    {
        return undefined;
    }

    const { connectedRole } = objects[0];

    return [
        `💡 spfn db push connects as ${connectedRole} (DATABASE_OWNER_URL), and objects it manages belong to another role: ${listing(objects)}.`,
        reassignOwned(objects.filter(entry => !entry.bootstrap), connectedRole),
        alterOwners(objects.filter(entry => entry.bootstrap), connectedRole),
        'Then run spfn db push again (@spfn/core db README, "Database roles").',
    ].filter(Boolean).join('\n');
}

/** The first few objects with their owners, and how many more there are. */
function listing(objects: ForeignOwnedObject[]): string
{
    const listed = objects.slice(0, LISTED_OBJECTS)
        .map(entry => `${['SCHEMA', 'TYPE'].includes(entry.kind) ? `${entry.kind.toLowerCase()} ` : ''}${entry.object} (owner ${entry.owner})`);
    const more = objects.length > LISTED_OBJECTS ? `, and ${objects.length - LISTED_OBJECTS} more` : '';

    return `${listed.join(', ')}${more}`;
}

/** REASSIGN OWNED for every owner of `objects`; undefined when there are none. */
function reassignOwned(objects: ForeignOwnedObject[], connectedRole: string): string | undefined
{
    const owners = [...new Set(objects.map(entry => entry.owner))];

    return owners.length === 0 ? undefined
        : `Move what ${owners.join(', ')} own${owners.length === 1 ? 's' : ''} to ${connectedRole} once, as a superuser or a role that is a member of both: `
            + `REASSIGN OWNED BY ${owners.join(', ')} TO ${connectedRole};`;
}

/**
 * One ALTER … OWNER TO for each of `objects`, which the bootstrap superuser
 * owns: PostgreSQL refuses REASSIGN OWNED BY that role. Undefined when there
 * are none.
 */
function alterOwners(objects: ForeignOwnedObject[], connectedRole: string): string | undefined
{
    return objects.length === 0 ? undefined
        : [
            `PostgreSQL refuses REASSIGN OWNED BY ${objects[0].owner}, the bootstrap superuser; as a superuser, give each of its objects to ${connectedRole}:`,
            ...objects.map(entry => `   ALTER ${entry.kind} ${entry.object} OWNER TO ${connectedRole};`),
        ].join('\n');
}
