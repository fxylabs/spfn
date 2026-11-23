/**
 * Which objects of the managed schemas belong to a role the connected one
 * cannot act for — one catalog query, two readers
 *
 * `spfn db push` asks it after PostgreSQL refused it a privilege, to print the
 * ownership remedy (the CLI's foreign-owners.ts); the app privileges step asks
 * it before it grants, since a GRANT on a table the connected role does not
 * own is a warning PostgreSQL issues and an unchanged access list, not an
 * error (catalog.ts).
 */

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';

/** Anything that runs a drizzle `sql` query: a drizzle database or transaction, of either driver. */
export interface CatalogDb
{
    execute(query: SQL): Promise<unknown>;
}

/** The bootstrap superuser's oid (BOOTSTRAP_SUPERUSERID): fixed, whatever the role is named. */
const BOOTSTRAP_SUPERUSER_OID = 10;

/** The first oid after initdb's (FirstNormalObjectId): every lower one is the system's. */
const FIRST_NORMAL_OBJECT_ID = 16384;

/** An object as `ALTER … OWNER TO` names it, and its owner. */
export interface OwnedObject
{
    /** Its owner, quoted as an identifier */
    owner: string;
    /** What `ALTER … OWNER TO` names the object as: `SCHEMA`, `TABLE`, `SEQUENCE`, `VIEW`, `FUNCTION`, … */
    kind: string;
    /** The object's name, quoted as an identifier, schema-qualified for a relation, type or function, a function's with its argument types */
    object: string;
}

export interface ForeignOwnedObject extends OwnedObject
{
    connectedRole: string;
    /** Whether the owner is the bootstrap superuser, whose objects REASSIGN OWNED cannot move */
    bootstrap: boolean;
    /** A relation's, type's or function's schema, unquoted; null for a schema */
    schema: string | null;
    /** The schema's, relation's, type's or function's own name, unquoted */
    name: string;
    /** A function's argument types; null for any other object */
    arguments: string | null;
}

/**
 * The relations and enum types (not a table's row type) in `schemas`, and the
 * plain functions of the queue schema `queueSchema` — of no other schema: a
 * project's trigger function is nothing push or the grant step alters —
 * owned by a role the connected one neither is nor inherits the privileges
 * of (`pg_has_role` … `USAGE`: ownership through membership counts as its
 * own),
 * and those of `schemas` such a role owns without granting it CREATE — a
 * schema owned elsewhere that it may create in, such as `public` owned by
 * `pg_database_owner`, stops nothing push does. Extension members, sequences a
 * column owns (`ALTER TABLE … OWNER TO` moves them with their table, and
 * refuses them alone; the dependency rule is the sequences' own, since a
 * partition depends on its parent, and a partitioned table on itself, the
 * same way) and initdb's objects are left out. `connectedRole`, `owner` and
 * `object` come quoted as identifiers, ready for SQL.
 */
export async function foreignOwnedObjects(db: CatalogDb, schemas: string[], queueSchema?: string): Promise<ForeignOwnedObject[]>
{
    const result = await db.execute(sql`
        SELECT quote_ident(current_user) AS "connectedRole", quote_ident(pg_catalog.pg_get_userbyid(o.owner)) AS owner,
            o.owner = ${sql.raw(String(BOOTSTRAP_SUPERUSER_OID))} AS bootstrap, o.kind, o.object, o.schema, o.name, o.arguments
        FROM (
            SELECT n.nspowner AS owner, 'SCHEMA' AS kind, quote_ident(n.nspname) AS object, NULL::text AS schema, n.nspname::text AS name,
                NULL::text AS arguments, 'pg_catalog.pg_namespace'::regclass AS classid, n.oid AS objid
            FROM pg_catalog.pg_namespace n
            WHERE n.nspname = ANY(${sql.param(schemas)}) AND NOT pg_catalog.has_schema_privilege(n.oid, 'CREATE')
            UNION ALL
            SELECT c.relowner,
                CASE c.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
                quote_ident(n.nspname) || '.' || quote_ident(c.relname), n.nspname::text, c.relname::text,
                NULL, 'pg_catalog.pg_class'::regclass, c.oid
            FROM pg_catalog.pg_class c
            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = ANY(${sql.param(schemas)}) AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
            UNION ALL
            SELECT t.typowner, 'TYPE', quote_ident(n.nspname) || '.' || quote_ident(t.typname), n.nspname::text, t.typname::text,
                NULL, 'pg_catalog.pg_type'::regclass, t.oid
            FROM pg_catalog.pg_type t
            JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = ANY(${sql.param(schemas)}) AND t.typtype = 'e'
            UNION ALL
            SELECT p.proowner, 'FUNCTION',
                quote_ident(n.nspname) || '.' || quote_ident(p.proname) || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
                n.nspname::text, p.proname::text, pg_catalog.pg_get_function_identity_arguments(p.oid),
                'pg_catalog.pg_proc'::regclass, p.oid
            FROM pg_catalog.pg_proc p
            JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = ${queueSchema ?? null} AND p.prokind = 'f'
        ) o
        WHERE NOT pg_catalog.pg_has_role(o.owner, 'USAGE')
            AND o.objid >= ${sql.raw(String(FIRST_NORMAL_OBJECT_ID))}
            AND NOT EXISTS (
                SELECT FROM pg_catalog.pg_depend d
                WHERE d.classid = o.classid AND d.objid = o.objid
                    AND (d.deptype = 'e' OR (o.kind = 'SEQUENCE' AND d.deptype IN ('a', 'i') AND d.refclassid = 'pg_catalog.pg_class'::regclass))
            )
        ORDER BY owner, object`);

    return catalogRows(result) as unknown as ForeignOwnedObject[];
}

/**
 * The statement that moves what `owners` (quoted, not the bootstrap superuser)
 * own to `target`, with who may run it; undefined when there are none.
 */
export function reassignOwnedLine(owners: readonly string[], target: string): string | undefined
{
    return owners.length === 0 ? undefined
        : `Move what ${owners.join(', ')} own${owners.length === 1 ? 's' : ''} to ${target} once, as a superuser or a role that is a member of both: `
            + `REASSIGN OWNED BY ${owners.join(', ')} TO ${target};`;
}

/**
 * One ALTER … OWNER TO `target` for each of `objects`, which the bootstrap
 * superuser owns: PostgreSQL refuses REASSIGN OWNED BY that role. Undefined
 * when there are none.
 */
export function alterOwnerLines(objects: readonly OwnedObject[], target: string): string | undefined
{
    return objects.length === 0 ? undefined
        : [
            `PostgreSQL refuses REASSIGN OWNED BY ${objects[0].owner}, the bootstrap superuser; as a superuser, give each of its objects to ${target}:`,
            ...objects.map(entry => `   ALTER ${entry.kind} ${entry.object} OWNER TO ${target};`),
        ].join('\n');
}

/**
 * The ownership remedy for the pg-boss queue schema, which pg-boss installs
 * and migrates only as the one role that owns the schema and every object in
 * it: move what `owners` (quoted: every role that owns part of the queue
 * and is to give it up) own to `target` — the bootstrap superuser's
 * `bootstrapObjects` one by one, since PostgreSQL refuses REASSIGN OWNED BY
 * that role — then run `spfn db grant`, which installs or migrates the queue
 * as the owner and grants the app role on it. The owner step (the CLI's queue
 * step) and the server's boot rule both end with it, so the two never name
 * different moves.
 */
export function queueOwnershipTransfer(owners: readonly string[], target: string, bootstrapObjects: readonly OwnedObject[] = []): string
{
    const reassigned = owners.filter(owner => !bootstrapObjects.some(entry => entry.owner === owner));

    return [
        reassignOwnedLine(reassigned, target),
        reassigned.length === 0 ? undefined : `   (REASSIGN OWNED moves everything ${reassigned.join(', ')} own${reassigned.length === 1 ? 's' : ''} in this database.)`,
        alterOwnerLines(bootstrapObjects, target),
        'Then run spfn db grant at once, best while jobs are paused: until it runs, the app role is refused on the queue\'s tables '
            + '(@spfn/core db README, "Database roles").',
    ].filter(Boolean).join('\n');
}

/** A query's rows, from node-postgres's `{ rows }` or postgres.js's array. */
export function catalogRows(result: unknown): Record<string, unknown>[]
{
    if (Array.isArray(result))
    {
        return result as Record<string, unknown>[];
    }

    const rows = (result as { rows?: unknown } | null | undefined)?.rows;

    return Array.isArray(rows) ? rows as Record<string, unknown>[] : [];
}
