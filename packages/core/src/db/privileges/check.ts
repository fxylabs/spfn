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
 * app cannot use is the plan's `withoutUsage`; a grant to PUBLIC from another
 * grantor than the owner, which blocks the step, is the plan's
 * `publicGrantsByOthers`. What the plan leaves the app holding another way —
 * as a member of a role it does not plan for, or from a grantor other than the
 * owner — is `heldElsewhere`, never drift. A relation a planned role owns, or
 * whose owner it inherits (the plan's `ownedRelations`), is outside the step
 * for every grantee, PUBLIC included: nothing is compared on it, and those the
 * app owns are counted apart.
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

import { publicMayCreateInPublic, readRelations, readRoles, readSchemas } from './catalog';
import { catalogRows, type CatalogDb } from './ownership';
import {
    planAppPrivileges,
    type AppPrivilegesTarget,
    type AppRoles,
    type GranteeChange,
    type OwnedRelation,
    type PrivilegeCatalog,
    type RelationKind,
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
    /** Column grants, never declared, as `update (amount)`: revoked */
    readonly columns: readonly string[];
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
    /** Grants to PUBLIC the owner cannot revoke: they block `spfn db grant` */
    readonly publicGrantsByOthers: readonly AppPublicGrantByOther[];
    /** What it holds beyond its declarations that `spfn db grant` reports and does not change */
    readonly heldElsewhere: readonly AppPrivilegeHeldElsewhere[];
    /** How many managed tables, views and materialized views the app role owns or inherits the owner of: declared, not enforced */
    readonly ownedTables: number;
    /** How many managed tables, views and materialized views were compared — none a planned role owns; their sequences are compared too */
    readonly checkedTables: number;
    /** Whether PUBLIC may create in schema `public` (PostgreSQL before 15) */
    readonly publicMayCreateInPublic: boolean;
}

/**
 * Read, on the app role's connection, the catalog of `target.schemas` for the
 * app role and `read` — the read role, when there is one — and compare it as
 * `compareAppPrivileges` does. Neither role is taken for the owner, whom the
 * app cannot name, and no relation for one the owner cannot grant on.
 */
export async function checkAppPrivileges(db: CatalogDb, target: AppPrivilegesTarget, read?: string): Promise<AppPrivilegesCheck>
{
    const [current] = catalogRows(await db.execute(sql`SELECT current_user::text AS name`));
    const app = String(current.name);
    const roleNames = read === undefined || read === app ? [app] : [app, read];

    return compareAppPrivileges({
        roles: (await readRoles(db, roleNames)).map(role => ({ ...role, inheritsOwner: false })),
        missingRoles: [],
        schemas: await readSchemas(db, target.schemas, roleNames),
        relations: await readRelations(db, target.schemas),
        foreignOwned: [],
        publicMayCreateInPublic: await publicMayCreateInPublic(db),
    }, target, { app, read });
}

/**
 * The step's plan for `roles` on `catalog` against `target`, as far as it
 * concerns what the app role can do: the changes for it, for PUBLIC and for a
 * role it is a member of; its schemas without USAGE; the grants to PUBLIC that
 * block the plan; what the plan leaves it holding. Nothing the owner alone can
 * see is in a catalog read as the app, so the plan is never asked whether it
 * is blocked otherwise.
 */
export function compareAppPrivileges(catalog: PrivilegeCatalog, target: AppPrivilegesTarget, roles: AppRoles): AppPrivilegesCheck
{
    const plan = planAppPrivileges(catalog, target, roles);
    const memberOf = catalog.roles.find(role => role.name === roles.app)?.memberOf ?? [];

    return {
        drift: plan.changes
            .filter(change => change.grantee === null || change.grantee === roles.app || memberOf.includes(change.grantee))
            .map(change => driftOf(change, roles.app)),
        schemasWithoutUsage: plan.withoutUsage.filter(entry => entry.role === roles.app).map(entry => entry.schema),
        publicGrantsByOthers: plan.publicGrantsByOthers.map(({ schema, name, privilege, grantor, statement }) => ({ schema, table: name, privilege, grantor, statement })),
        heldElsewhere: plan.heldElsewhere.filter(entry => entry.role === roles.app)
            .map(({ schema, name, privilege, through }) => ({ schema, table: name, privilege, through })),
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
        columns: change.columns.map(grant => `${grant.privilege} (${grant.column})`),
    };
}

/** `owned` once per relation, whichever planned roles own it. */
function distinctRelations(owned: readonly OwnedRelation[]): OwnedRelation[]
{
    return [...new Map(owned.map(relation => [`${relation.schema}.${relation.name}`, relation])).values()];
}

/** How many of `relations` are no sequence. */
function tableCount(relations: readonly { readonly kind: RelationKind }[]): number
{
    return relations.filter(relation => relation.kind !== 'sequence').length;
}
