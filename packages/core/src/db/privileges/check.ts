/**
 * What `spfn db grant` would change for the app role, read as the app — so
 * `spfn db status` needs no owner URL
 *
 * Status and the step answer one question — does the app role hold exactly
 * what is declared? — so status is a view of the step's plan: it reads the
 * same catalog (catalog.ts: every access list entry with its grant option, and
 * every column grant) for the same roles (the app's, and the read role's when
 * `DATABASE_READ_URL` names another), runs the same plan (plan.ts) on it, and
 * keeps of the plan what concerns what the app role can do. Its drift is the
 * plan's `changes` for the app role, for PUBLIC and for a planned role the app
 * is a member of (the read role), whose grants the app holds too; a schema the
 * app cannot use is the plan's `withoutUsage`, and what it holds on a schema
 * beyond USAGE — CREATE, USAGE's grant option — the plan's `schemaChanges`,
 * for the same grantees; a grant to PUBLIC from another
 * grantor than the owner, which blocks the step, is the plan's
 * `publicGrantsByOthers`; a declared column the database does not have, which
 * blocks the step too, the plan's `absentColumns`, on any table, one the app
 * owns included. What the plan leaves the app holding another way —
 * as a member of a role it does not plan for, or from a grantor other than the
 * owner — is `heldElsewhere`, never drift. A relation a planned role owns, or
 * whose owner it inherits (the plan's `ownedRelations`), is outside the step
 * for every grantee, PUBLIC included: nothing is compared on it, and those the
 * app owns are counted apart. A schema the app owns, or whose owner it
 * inherits, gets no statement for it (`ownedSchemas`, named); one the read role
 * owns is compared for the app as any schema is.
 *
 * The catalog tables are readable by every role unless an administrator
 * revoked that, so the app reads what the owner reads (a refused read is an
 * error, never an empty catalog). What it cannot see is the owner's side: it
 * does not know which role `DATABASE_OWNER_URL` connects as, so not whether
 * that role may grant on each relation and schema, nor whether PostgreSQL
 * would refuse a REVOKE (2BP01) — status predicts no refusal; `spfn db grant
 * --dry-run` runs the statements and reports one.
 */

import { sql } from 'drizzle-orm';

import { publicMayCreateInPublic, readManagedObjects, readRoles } from './catalog';
import { catalogRows, type CatalogDb } from './ownership';
import {
    planAppPrivileges,
    type AbsentColumns,
    type AppPrivilegesTarget,
    type AppRoles,
    type ColumnGrant,
    type GranteeChange,
    type OwnedRelation,
    type PrivilegeCatalog,
    type RelationKind,
    type SchemaChange,
} from './plan';

/** What `spfn db grant` would change for one grantee on one managed relation. */
export interface AppPrivilegeDrift
{
    readonly schema: string;
    /** The relation: a table, view, materialized view or sequence */
    readonly table: string;
    readonly kind: RelationKind;
    /** The app role; a role it is a member of, whose grants it holds too; or null for PUBLIC, likewise */
    readonly grantee: string | null;
    /** `member of <role>` when `grantee` is a role the app is a member of; else null */
    readonly through: string | null;
    /** Declared, and not held: granted */
    readonly missing: readonly string[];
    /** Held, and not declared: revoked */
    readonly excess: readonly string[];
    /** Declared, and held `WITH GRANT OPTION`, so the app can pass it on: the option is revoked */
    readonly grantOption: readonly string[];
    /** Column grants not declared, as `update (amount)`: revoked */
    readonly columns: readonly string[];
    /** Declared column grants `spfn db grant` grants, as `update (status)`: not held, or held under a table-level grant of their privilege in `excess`, whose REVOKE takes them */
    readonly missingColumns: readonly string[];
    /** Declared column grants held `WITH GRANT OPTION`, as `update (status)`: the option is revoked */
    readonly columnGrantOption: readonly string[];
}

/** What `spfn db grant` would revoke on one managed schema from one grantee: anything beyond USAGE. */
export interface AppSchemaDrift
{
    readonly schema: string;
    /** The app role; a role it is a member of, whose grants it holds too; or null for PUBLIC, likewise */
    readonly grantee: string | null;
    /** `member of <role>` when `grantee` is a role the app is a member of; else null */
    readonly through: string | null;
    /** Held beyond USAGE (CREATE), so the app can create — and own — tables there: revoked */
    readonly excess: readonly string[];
    /** USAGE held `WITH GRANT OPTION`: the option is revoked */
    readonly grantOption: readonly string[];
}

/** A privilege beyond USAGE the app role holds on a managed schema in a way `spfn db grant` does not change. */
export interface AppSchemaPrivilegeHeldElsewhere
{
    readonly schema: string;
    /** `create`, or `usage with grant option` */
    readonly privilege: string;
    /** `member of <role>`, `granted by <role>`, or `granted to PUBLIC by <role>` */
    readonly through: string;
}

/** A privilege the app role holds beyond its declaration in a way `spfn db grant` does not change. */
export interface AppPrivilegeHeldElsewhere
{
    readonly schema: string;
    readonly table: string;
    /** The privilege, `update (column)` for a column's, `… with grant option` for a declared one's option */
    readonly privilege: string;
    /** `member of <role>`, or `granted by <role>` */
    readonly through: string;
}

/** A grant to PUBLIC, so to the app, from another grantor than the owner: `spfn db grant` is blocked until `grantor` runs `statement`. */
export interface AppPublicGrantByOther
{
    readonly schema: string;
    readonly table: string;
    /** The privilege, `update (column)` for a column's */
    readonly privilege: string;
    readonly grantor: string;
    readonly statement: string;
}

/** What the app role holds on the managed relations, as `checkAppPrivileges` reads it. */
export interface AppPrivilegesCheck
{
    /** What `spfn db grant` would change on the relations, in its order */
    readonly drift: readonly AppPrivilegeDrift[];
    /** The managed schemas the app role cannot use: `spfn db grant` grants USAGE */
    readonly schemasWithoutUsage: readonly string[];
    /** What `spfn db grant` would revoke on the schemas, in its order */
    readonly schemaDrift: readonly AppSchemaDrift[];
    /** Grants to PUBLIC the owner cannot revoke: they block `spfn db grant` */
    readonly publicGrantsByOthers: readonly AppPublicGrantByOther[];
    /** What it holds beyond its declarations that `spfn db grant` reports and does not change */
    readonly heldElsewhere: readonly AppPrivilegeHeldElsewhere[];
    /** What it holds on the schemas beyond USAGE that `spfn db grant` reports and does not change */
    readonly schemaHeldElsewhere: readonly AppSchemaPrivilegeHeldElsewhere[];
    /** Columns a table's column lists name that the table does not have: `spfn db grant` refuses until the migration that adds them has run */
    readonly absentColumns: readonly AbsentColumns[];
    /** The managed schemas the app role owns or inherits the owner of: no `spfn db grant` statement for it there, and what it holds there not compared; with a read role, PUBLIC's and the read role's grants there are, as on any schema */
    readonly ownedSchemas: readonly string[];
    /** How many managed tables, views and materialized views the app role owns or inherits the owner of: declared, not enforced */
    readonly ownedTables: number;
    /** How many managed tables, views and materialized views were compared — none a planned role owns; their sequences are compared too */
    readonly checkedTables: number;
    /** Whether PUBLIC may create in schema `public` (PostgreSQL before 15) */
    readonly publicMayCreateInPublic: boolean;
}

/**
 * Read, on the app role's connection, the catalog of `target.schemas` and of
 * the queue schema `target.queue` — what the step reads (`readManagedObjects`)
 * — for the app role and `read` — the read role, when there is one — and
 * compare it as `compareAppPrivileges` does. Neither role is taken for the
 * owner, whom the app cannot name, and no schema, relation or function for
 * one the owner cannot grant on: the owner is taken to own every schema
 * (`mayGrant`), so a queue the owner installed is compared by the queue's
 * rule, as the step plans it.
 */
export async function checkAppPrivileges(db: CatalogDb, target: AppPrivilegesTarget, read?: string): Promise<AppPrivilegesCheck>
{
    const [current] = catalogRows(await db.execute(sql`SELECT current_user::text AS name`));
    const app = String(current.name);
    const roleNames = read === undefined || read === app ? [app] : [app, read];
    const { schemas, relations } = await readManagedObjects(db, target.schemas, roleNames, target.queue?.schema);

    return compareAppPrivileges({
        roles: (await readRoles(db, roleNames)).map(role => ({ ...role, inheritsOwner: false })),
        missingRoles: [],
        schemas: schemas.map(schema => ({ ...schema, mayGrant: true })),
        relations,
        foreignOwned: [],
        publicMayCreateInPublic: await publicMayCreateInPublic(db),
    }, target, { app, read });
}

/**
 * The step's plan for `roles` on `catalog` against `target`, as far as it
 * concerns what the app role can do: the changes for it, for PUBLIC and for a
 * role it is a member of, on relations and schemas; its schemas without
 * USAGE; the schemas it owns; the grants to PUBLIC that
 * block the plan; what the plan leaves it holding. Nothing the owner alone can
 * see is in a catalog read as the app, so the plan is never asked whether it
 * is blocked otherwise.
 */
export function compareAppPrivileges(catalog: PrivilegeCatalog, target: AppPrivilegesTarget, roles: AppRoles): AppPrivilegesCheck
{
    const plan = planAppPrivileges(catalog, target, roles);
    const memberOf = catalog.roles.find(role => role.name === roles.app)?.memberOf ?? [];
    const reachesApp = (change: { readonly grantee: string | null }) => change.grantee === null || change.grantee === roles.app || memberOf.includes(change.grantee);

    return {
        drift: plan.changes.filter(reachesApp).map(change => driftOf(change, roles.app)),
        schemasWithoutUsage: plan.withoutUsage.filter(entry => entry.role === roles.app).map(entry => entry.schema),
        schemaDrift: plan.schemaChanges.filter(reachesApp).map(change => schemaDriftOf(change, roles.app)),
        publicGrantsByOthers: plan.publicGrantsByOthers.map(({ schema, name, privilege, grantor, statement }) => ({ schema, table: name, privilege, grantor, statement })),
        heldElsewhere: plan.heldElsewhere.filter(entry => entry.role === roles.app)
            .map(({ schema, name, privilege, through }) => ({ schema, table: name, privilege, through })),
        schemaHeldElsewhere: plan.schemaHeldElsewhere.filter(entry => entry.role === roles.app).map(({ schema, privilege, through }) => ({ schema, privilege, through })),
        absentColumns: plan.absentColumns,
        ownedSchemas: plan.ownedSchemas.filter(entry => entry.role === roles.app).map(entry => entry.schema),
        ownedTables: tableCount(plan.ownedRelations.filter(relation => relation.role === roles.app)),
        checkedTables: tableCount(catalog.relations) - tableCount(distinctRelations(plan.ownedRelations)),
        publicMayCreateInPublic: plan.publicMayCreateInPublic,
    };
}

function driftOf(change: GranteeChange, app: string): AppPrivilegeDrift
{
    return {
        schema: change.schema,
        table: change.name,
        kind: change.kind,
        grantee: change.grantee,
        through: change.grantee === null || change.grantee === app ? null : `member of ${change.grantee}`,
        missing: change.missing,
        excess: change.excess,
        grantOption: change.grantOption,
        columns: change.columns.map(columnText),
        missingColumns: change.missingColumns.map(columnText),
        columnGrantOption: change.columnGrantOption.map(columnText),
    };
}

/** `update (status)`. */
function columnText(grant: ColumnGrant): string
{
    return `${grant.privilege} (${grant.column})`;
}

function schemaDriftOf(change: SchemaChange, app: string): AppSchemaDrift
{
    return {
        schema: change.schema,
        grantee: change.grantee,
        through: change.grantee === null || change.grantee === app ? null : `member of ${change.grantee}`,
        excess: change.excess,
        grantOption: change.grantOption,
    };
}

/** `owned` once per relation, whichever planned roles own it. */
function distinctRelations(owned: readonly OwnedRelation[]): OwnedRelation[]
{
    return [...new Map(owned.map(relation => [`${relation.schema}.${relation.name}`, relation])).values()];
}

/** How many of `relations` are no sequence nor function. */
function tableCount(relations: readonly { readonly kind: RelationKind }[]): number
{
    return relations.filter(relation => relation.kind !== 'sequence' && relation.kind !== 'function').length;
}
