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
 * objects initdb created. The query is `@spfn/core/db`'s `foreignOwnedObjects`,
 * which the app privileges step asks too.
 */

import { foreignOwnedObjects, type ForeignOwnedObject } from '@spfn/core/db';

import type { PushConnection } from './drizzle.js';

/** How many objects the remedy names before it says how many more there are */
const LISTED_OBJECTS = 5;

/** A relation or type as a statement names it: schema and name, unquoted. */
interface Relation
{
    schema: string;
    name: string;
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

/**
 * The remedy for a queue schema whose schema or objects (`objects`, not
 * empty) belong to a role the owner cannot act for — as when the app role
 * installed it at its start, or owns the schema while the owner owns the
 * objects in it: what the owner step leaves alone, then REASSIGN OWNED or one
 * ALTER … OWNER TO per bootstrap superuser's object, as for push, which leave
 * the owner holding the schema and every object in it, and `spfn db grant`
 * straight after, since the app holds nothing on what moves until it runs.
 * It says nothing of who migrates the queue meanwhile: the app role can only
 * where it owns the schema and every object, which `objects` does not show.
 */
export function queueOwnershipRemedy(schema: string, objects: ForeignOwnedObject[]): string
{
    const { connectedRole } = objects[0];
    const owners = [...new Set(objects.filter(entry => !entry.bootstrap).map(entry => entry.owner))];

    return [
        `⚠️  In queue schema ${schema} (jobs), another role than ${connectedRole}, the owner this step connects as, owns: ${listing(objects)}. `
            + 'pg-boss installs and migrates the queue only as the one role that owns the schema and every object in it, so nothing is '
            + 'installed, migrated or granted on the queue; the rest of the step goes on.',
        reassignOwned(objects.filter(entry => !entry.bootstrap), connectedRole),
        owners.length === 0 ? undefined : `   (REASSIGN OWNED moves everything ${owners.join(', ')} own${owners.length === 1 ? 's' : ''} in this database.)`,
        alterOwners(objects.filter(entry => entry.bootstrap), connectedRole),
        'Then run spfn db grant at once, best while jobs are paused: until it runs, the app role is refused on the queue\'s tables '
            + '(@spfn/core db README, "Database roles").',
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
