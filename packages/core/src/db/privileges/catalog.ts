/**
 * The app privileges step's database half: read what the catalog holds, and
 * apply the plan (plan.ts) in one transaction, as the owner
 *
 * The step never uses `ALTER DEFAULT PRIVILEGES`: it reads the access lists of
 * the managed schemas and of every relation in them, so a table created by any
 * role, a hand GRANT and a hand REVOKE are all seen, and issues only the
 * statements that bring them to the declaration. A second run issues none.
 */

import { sql } from 'drizzle-orm';

import { describeError } from '../../logger/error-description';
import { catalogRows, foreignOwnedObjects, type CatalogDb } from './ownership';
import {
    planAppPrivileges,
    type AppPrivilegesPlan,
    type AppPrivilegesTarget,
    type AppRoles,
    type CatalogRelation,
    type CatalogRole,
    type CatalogSchema,
    type ForeignOwnedRelation,
    type PrivilegeCatalog,
    type RelationKind,
    type RevokeGrantsByOthers,
} from './plan';

/** SQLSTATE dependent_privileges_exist: a REVOKE that would take an option other grants were made with. */
const DEPENDENT_PRIVILEGES_EXIST = '2BP01';

/** A connection that also opens a transaction: a drizzle database of either driver. */
export interface GrantDb extends CatalogDb
{
    transaction<T>(fn: (tx: CatalogDb) => Promise<T>): Promise<T>;
}

/**
 * What the catalog holds for `roles` on `schemas` and the queue schema
 * `queueSchema` — whose functions are read too — on the owner's connection.
 * Reads only, so it runs on a dry run's read-only connection. A role name
 * that is no role is listed in `missingRoles` and read no further:
 * PostgreSQL's role functions raise 42704 on it.
 */
export async function readPrivilegeCatalog(
    db: CatalogDb,
    schemas: readonly string[],
    roles: AppRoles,
    queueSchema?: string,
): Promise<PrivilegeCatalog>
{
    const named = [roles.app, ...(roles.read === undefined || roles.read === roles.app ? [] : [roles.read])];
    const roleNames = await existingRoles(db, named);
    const all = queueSchema === undefined ? schemas : [...schemas, queueSchema];

    return {
        roles: await readRoles(db, roleNames),
        missingRoles: named.filter(name => !roleNames.includes(name)),
        ...await readManagedObjects(db, schemas, roleNames, queueSchema),
        foreignOwned: await readForeignOwned(db, all, queueSchema),
        publicMayCreateInPublic: await publicMayCreateInPublic(db),
    };
}

/**
 * The schemas `schemas` and the queue schema `queueSchema` as `roleNames`
 * see them, and their relations — with the queue schema's functions: what
 * the plan compares, read the same way for the step and for `db status`.
 */
export async function readManagedObjects(
    db: CatalogDb,
    schemas: readonly string[],
    roleNames: string[],
    queueSchema?: string,
): Promise<Pick<PrivilegeCatalog, 'schemas' | 'relations'>>
{
    const all = queueSchema === undefined ? schemas : [...schemas, queueSchema];

    return {
        schemas: await readSchemas(db, all, roleNames),
        relations: [...await readRelations(db, all), ...(queueSchema === undefined ? [] : await readFunctions(db, queueSchema))],
    };
}

/** Whether PUBLIC may create in schema `public` (PostgreSQL before 15, unless revoked). */
export async function publicMayCreateInPublic(db: CatalogDb): Promise<boolean>
{
    const [publicCreate] = catalogRows(await db.execute(sql`
        SELECT coalesce(bool_or(pg_catalog.has_schema_privilege('public', n.oid, 'CREATE')), false) AS "mayCreate"
        FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'`));

    return publicCreate.mayCreate === true;
}

/** A REVOKE PostgreSQL refused because grants depend on the option it takes (2BP01). */
export interface RefusedRevoke
{
    readonly statement: string;
    /** The grants of what it revokes on its relation that roles other than the owner made: the dependent ones are among them */
    readonly grantsByOthers?: RevokeGrantsByOthers;
}

/** What `applyAppPrivileges` did. */
export interface AppPrivilegesRun
{
    readonly plan: AppPrivilegesPlan;
    /** Whether the statements are in the database: not when blocked, refused or rolled back */
    readonly applied: boolean;
    /** The statement PostgreSQL refused, after which nothing was changed */
    readonly refused?: RefusedRevoke;
}

/** Carries a run out of a transaction that must roll back. */
class RolledBack
{
    constructor(readonly run: AppPrivilegesRun)
    {
    }
}

/**
 * Read the catalog, plan, and — unless the plan is blocked — run its
 * statements, all in one transaction on the owner's connection. Every REVOKE
 * is plain (RESTRICT): when PostgreSQL refuses one because grants depend on
 * the option it takes (2BP01), the transaction rolls back, nothing is changed,
 * and the run names the statement. With `rollback` (a dry run) the
 * statements run the same way and the transaction always rolls back, so what
 * PostgreSQL would refuse is known and nothing is changed.
 *
 * @throws any other database error, after the transaction rolled back
 */
export async function applyAppPrivileges(
    db: GrantDb,
    target: AppPrivilegesTarget,
    roles: AppRoles,
    options: { rollback?: boolean } = {},
): Promise<AppPrivilegesRun>
{
    const transaction = db.transaction(async tx =>
    {
        const plan = planAppPrivileges(await readPrivilegeCatalog(tx, target.schemas, roles, target.queue?.schema), target, roles);
        const refused = plan.blocked ? undefined : await runStatements(tx, plan);

        if (plan.blocked || refused !== undefined || options.rollback === true)
        {
            throw new RolledBack({ plan, applied: false, refused });
        }

        return { plan, applied: true };
    });

    return transaction.catch((error: unknown) => error instanceof RolledBack ? error.run : Promise.reject(error));
}

/** Run `plan`'s statements in order, up to the first PostgreSQL refuses with 2BP01, which is returned. */
async function runStatements(tx: CatalogDb, plan: AppPrivilegesPlan): Promise<RefusedRevoke | undefined>
{
    for (const statement of plan.statements)
    {
        const refused = await tx.execute(sql.raw(statement)).then(
            () => false,
            (error: unknown) => describeError(error, { stack: false }).code === DEPENDENT_PRIVILEGES_EXIST || Promise.reject(error),
        );

        if (refused)
        {
            return { statement, grantsByOthers: plan.grantsByOthers.find(entry => entry.statement === statement) };
        }
    }

    return undefined;
}

/** The names of `roleNames` that are roles, in order. */
async function existingRoles(db: CatalogDb, roleNames: string[]): Promise<string[]>
{
    const rows = catalogRows(await db.execute(sql`
        SELECT r.name FROM unnest(${sql.param(roleNames)}::text[]) WITH ORDINALITY AS r(name, position)
        WHERE EXISTS (SELECT FROM pg_catalog.pg_roles a WHERE a.rolname = r.name)
        ORDER BY r.position`));

    return rows.map(row => String(row.name));
}

/** Whether each role is or inherits the connected one, and which other roles it inherits. */
export async function readRoles(db: CatalogDb, roleNames: string[]): Promise<CatalogRole[]>
{
    const rows = catalogRows(await db.execute(sql`
        SELECT r.name, pg_catalog.pg_has_role(r.name, current_user, 'USAGE') AS "inheritsOwner",
            coalesce((
                SELECT json_agg(m.rolname::text ORDER BY m.rolname)
                FROM pg_catalog.pg_roles m
                WHERE m.rolname <> r.name AND pg_catalog.pg_has_role(r.name, m.oid, 'USAGE')
            ), '[]'::json) AS "memberOf"
        FROM unnest(${sql.param(roleNames)}::text[]) WITH ORDINALITY AS r(name, position)
        ORDER BY r.position`));

    return rows as unknown as CatalogRole[];
}

/**
 * Each existing managed schema, per role: whether it may use it, and whether
 * the connected role may grant on it; with the schema's owner and its access
 * list (the owner's default one when it has none), each entry with its grant
 * option. A grantee of 0 is PUBLIC.
 */
export async function readSchemas(db: CatalogDb, schemas: readonly string[], roleNames: string[]): Promise<CatalogSchema[]>
{
    const rows = catalogRows(await db.execute(sql`
        SELECT n.nspname::text AS name, r.name AS role,
            pg_catalog.has_schema_privilege(r.name, n.oid, 'USAGE') AS usage,
            pg_catalog.pg_has_role(n.nspowner, 'USAGE') AS "mayGrant",
            pg_catalog.pg_get_userbyid(n.nspowner)::text AS owner,
            (
                SELECT coalesce(json_agg(json_build_object(
                    'grantee', CASE a.grantee WHEN 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END,
                    'grantor', pg_catalog.pg_get_userbyid(a.grantor)::text,
                    'privilege', lower(a.privilege_type),
                    'grantable', a.is_grantable)), '[]'::json)
                FROM pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
            ) AS grants
        FROM pg_catalog.pg_namespace n
        CROSS JOIN unnest(${sql.param(roleNames)}::text[]) WITH ORDINALITY AS r(name, position)
        WHERE n.nspname = ANY(${sql.param([...schemas])}::text[])
        ORDER BY n.nspname, r.position`));

    return rows as unknown as CatalogSchema[];
}

/**
 * Whether the relation `c` is a view created `WITH (security_invoker)`
 * (PostgreSQL 15+): its option's value read as PostgreSQL reads it, by the
 * boolean input (`true`, `on`, `1`, `yes`, …), never by its text.
 */
export const SECURITY_INVOKER = sql`c.relkind = 'v' AND coalesce((
    SELECT o.option_value::boolean FROM pg_catalog.pg_options_to_table(c.reloptions) o
    WHERE o.option_name = 'security_invoker'), false)`;

/**
 * Whether the view `c` has a rewrite rule other than its SELECT rule (an ON
 * INSERT, UPDATE or DELETE rule), which runs with the view owner's rights
 * even on a `security_invoker` view.
 */
export const WRITE_RULE = sql`c.relkind = 'v' AND EXISTS (
    SELECT FROM pg_catalog.pg_rewrite r WHERE r.ev_class = c.oid AND r.ev_type <> '1')`;

/**
 * Whether the view `c` has an INSTEAD OF trigger, whose function — perhaps
 * SECURITY DEFINER — does the write in place of PostgreSQL's.
 */
export const INSTEAD_OF_TRIGGER = sql`c.relkind = 'v' AND EXISTS (
    SELECT FROM pg_catalog.pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal AND (t.tgtype::integer & 64) <> 0)`;

/** What the plan calls each kind of object `foreignOwnedObjects` names: a foreign table is a table. */
const RELATION_KINDS = new Map<string, RelationKind>([
    ['TABLE', 'table'],
    ['FOREIGN TABLE', 'table'],
    ['VIEW', 'view'],
    ['MATERIALIZED VIEW', 'materialized view'],
    ['SEQUENCE', 'sequence'],
    ['FUNCTION', 'function'],
]);

/**
 * Every table (plain, partitioned or foreign; a partition marked as one),
 * view (marked `security_invoker`, and whether it has a write rule or an
 * INSTEAD OF trigger), materialized view and
 * sequence of `schemas` — not an extension's member — with its table-level access list
 * (the owner's default one when it has none) and its columns' grants, each
 * with its grant option. A grantee of 0 is PUBLIC.
 */
export async function readRelations(db: CatalogDb, schemas: readonly string[]): Promise<CatalogRelation[]>
{
    const rows = catalogRows(await db.execute(sql`
        SELECT n.nspname::text AS schema, c.relname::text AS name,
            CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS kind,
            c.relispartition AS partition, ${SECURITY_INVOKER} AS "securityInvoker",
            ${WRITE_RULE} AS "writeRule", ${INSTEAD_OF_TRIGGER} AS "insteadOfTrigger", pg_catalog.pg_get_userbyid(c.relowner)::text AS owner,
            (
                SELECT coalesce(json_agg(json_build_object(
                    'grantee', CASE a.grantee WHEN 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END,
                    'grantor', pg_catalog.pg_get_userbyid(a.grantor)::text,
                    'privilege', lower(a.privilege_type),
                    'grantable', a.is_grantable)), '[]'::json)
                FROM pg_catalog.aclexplode(coalesce(c.relacl, pg_catalog.acldefault((CASE c.relkind WHEN 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))) a
            ) AS grants,
            (
                SELECT coalesce(json_agg(json_build_object(
                    'column', att.attname::text,
                    'grantee', CASE a.grantee WHEN 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END,
                    'grantor', pg_catalog.pg_get_userbyid(a.grantor)::text,
                    'privilege', lower(a.privilege_type),
                    'grantable', a.is_grantable)), '[]'::json)
                FROM pg_catalog.pg_attribute att
                CROSS JOIN LATERAL pg_catalog.aclexplode(att.attacl) a
                WHERE att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped AND att.attacl IS NOT NULL
            ) AS "columnGrants"
        FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY(${sql.param([...schemas])}::text[]) AND c.relkind IN ('r', 'p', 'f', 'v', 'm', 'S')
            AND NOT EXISTS (
                SELECT FROM pg_catalog.pg_depend d
                WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
            )
        ORDER BY n.nspname, c.relname`));

    return rows as unknown as CatalogRelation[];
}

/**
 * Every plain function of the queue schema `schema` — not an extension's
 * member — with its argument types and its access list (the owner's default
 * one, which grants PUBLIC EXECUTE, when it has none). A grantee of 0 is
 * PUBLIC.
 */
async function readFunctions(db: CatalogDb, schema: string): Promise<CatalogRelation[]>
{
    const rows = catalogRows(await db.execute(sql`
        SELECT n.nspname::text AS schema, p.proname::text AS name, 'function' AS kind, false AS partition,
            pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments, pg_catalog.pg_get_userbyid(p.proowner)::text AS owner,
            (
                SELECT coalesce(json_agg(json_build_object(
                    'grantee', CASE a.grantee WHEN 0 THEN NULL ELSE pg_catalog.pg_get_userbyid(a.grantee)::text END,
                    'grantor', pg_catalog.pg_get_userbyid(a.grantor)::text,
                    'privilege', lower(a.privilege_type),
                    'grantable', a.is_grantable)), '[]'::json)
                FROM pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
            ) AS grants,
            '[]'::json AS "columnGrants"
        FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = ${schema} AND p.prokind = 'f'
            AND NOT EXISTS (
                SELECT FROM pg_catalog.pg_depend d
                WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
            )
        ORDER BY p.proname, arguments`));

    return rows as unknown as CatalogRelation[];
}

/**
 * The relations of `schemas`, and the functions of the queue schema
 * `queueSchema`, the owner cannot grant on: `foreignOwnedObjects`, the push
 * remedy's query.
 */
async function readForeignOwned(db: CatalogDb, schemas: readonly string[], queueSchema: string | undefined): Promise<ForeignOwnedRelation[]>
{
    const objects = await foreignOwnedObjects(db, [...schemas], queueSchema);

    return objects
        .filter(object => RELATION_KINDS.has(object.kind))
        .map(object => ({
            schema: object.schema ?? '',
            name: object.name,
            kind: RELATION_KINDS.get(object.kind)!,
            ...(object.arguments === null ? {} : { arguments: object.arguments }),
            owner: object.owner,
        }));
}
