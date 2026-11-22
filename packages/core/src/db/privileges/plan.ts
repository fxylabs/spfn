/**
 * The app privileges plan — catalog state and declarations in, the GRANT and
 * REVOKE statements that make the one equal the other out
 *
 * A pure function, so every rule below is a unit row: what it reads from the
 * database is `PrivilegeCatalog` (catalog.ts), what it is told is
 * `AppPrivilegesTarget` (the managed schemas and the tables' declarations).
 *
 * What each role is brought to, on the managed schemas only:
 *
 * | Object | App role | Read role (another role than the app's) | PUBLIC |
 * |---|---|---|---|
 * | schema | USAGE, nothing else | USAGE, except `drizzle`; nothing else | USAGE untouched; nothing else, except on `public` |
 * | table, foreign table | its declared set, else the default | `select` when the set has it | nothing |
 * | view | `select`; the default when every write through it is checked as the app | `select` | nothing |
 * | materialized view | `select` | `select` | nothing |
 * | sequence | USAGE | nothing | nothing |
 * | `drizzle` table | `select` | nothing | nothing |
 * | `drizzle` sequence | nothing | nothing | nothing |
 * | partition | nothing | nothing | nothing |
 *
 * drizzle declares views (`pgView`, `pgMaterializedView`) and push creates
 * them; `appPrivileges` takes a table only. A view runs with its owner's
 * rights on the tables under it, so a write granted on it is a write on them,
 * whatever they declare: it gets `select` only. It gets the default set only
 * when every write through it is checked against the app's own rights on
 * those tables: it is created `WITH (security_invoker)` (PostgreSQL 15+),
 * which PostgreSQL applies to the view's SELECT rule only, and has no other
 * rule (an ON INSERT, UPDATE or DELETE rule runs with the owner's rights) and
 * no INSTEAD OF trigger (whose function may be SECURITY DEFINER). A
 * materialized view, which is read and refreshed by its owner, gets `select`.
 *
 * A partition is storage of its parent, not a table the app is declared to
 * use: access goes through the root of its partition tree, whose declaration
 * and row-level security apply there. Anything held on a partition directly
 * would get round both, so all of it is revoked.
 *
 * "Brought to" counts the grants the table's owner gave the role itself:
 * missing ones are granted, any other is revoked, column grants included (a
 * declaration is table-level, so no column grant is declared), and so is the
 * grant option of a privilege it keeps (`REVOKE GRANT OPTION FOR`): a
 * declared set never carries one. What the role holds another way — as a
 * member of a role holding it, or from a grantor other than the owner, whose
 * grant the owner's REVOKE leaves in place — is reported, never revoked: the
 * step does not change other roles. A grant to another planned role (the app
 * a member of the read role) is that role's to plan: one the plan revokes is
 * not reported as held. PUBLIC is brought to nothing whoever
 * granted it.
 *
 * A schema is compared the same way, its access list (`nspacl`) read as a
 * relation's: USAGE is granted only when the role cannot use the schema at
 * all, by any path, and never revoked; anything else the schema's owner gave
 * a planned role — CREATE, with which it creates and so owns tables there,
 * and the grant option of USAGE — is revoked. PUBLIC keeps USAGE, which gives
 * the app nothing it does not hold and other roles the schema's functions and
 * types, and loses the CREATE the owner gave it, as on a relation — except on
 * `public`, the database's shared schema, where PUBLIC is every role of the
 * database and CREATE is its default before PostgreSQL 15: that is reported
 * (`publicMayCreateInPublic`), never revoked. What reaches a planned role
 * another way — as a member of a role the plan does not manage, from another
 * grantor, or through PUBLIC from another grantor — is reported
 * (`schemaHeldElsewhere`), never revoked. A REVOKE of CREATE takes no table
 * the role already created there: PostgreSQL keeps it, owned by that role,
 * which is the owned-relation case below. A planned role that owns a schema,
 * or inherits its owner (`ownedSchemas`), cannot be restricted there and gets
 * no statement on it; that says nothing about another planned role, which
 * still needs USAGE to reach its tables: it, and PUBLIC, whose grants reach
 * it, are planned there as on any schema. Only a schema every planned role
 * owns is outside the plan, as an owned relation is.
 *
 * Every REVOKE is plain (RESTRICT): the plan never cascades, which would
 * take a privilege from a role the step does not manage. Whether a REVOKE is
 * blocked by a grant that depends on the option it takes is PostgreSQL's to
 * decide, on running it (2BP01); the plan does not predict it. What it gives
 * the caller for that case is `grantsByOthers`: per REVOKE, the grants of the
 * privileges it names that a role other than the relation's owner made on that
 * relation — plain access list entries, among which any dependent grant is.
 * One grant it does see blocks the plan: one to PUBLIC from a grantor other
 * than the owner, which the owner's REVOKE leaves in place without an error
 * (PostgreSQL lets a role revoke only its own grants); it is listed
 * (`publicGrantsByOthers`) with the statement its grantor can run.
 *
 * Nothing is planned for a role that is the owner or inherits its privileges
 * (`ownerRoles`): it owns the tables in effect, and row-level security does
 * not apply to it. Likewise, a relation a planned role owns or whose owner it
 * inherits (`ownedRelations`) is outside the plan, for every grantee, PUBLIC
 * included, whoever is connected — that owner, a role inheriting it, or a
 * superuser: PostgreSQL does apply a REVOKE from a relation's owner (on 16,
 * `REVOKE DELETE … FROM` the owner leaves it 42501 on DELETE), but the owner
 * holds every grant option implicitly, grants itself and anyone the privilege
 * back at will, and needs none for ALTER, DROP or row-level security bypass.
 * Its declaration is not enforced, and planning PUBLIC there only when a
 * superuser is connected would make `db status`, which cannot tell who is,
 * disagree with the step in one setup or the other. `ALTER TABLE … OWNER TO`
 * the owner role brings it under the plan. A role name that is no
 * role (`missingRoles`), a relation another role owns, a schema the role
 * cannot use and the owner cannot grant, or a schema the owner cannot revoke
 * on (`foreignOwnedSchemas`), blocks the plan (`blocked`): the caller applies
 * none of it.
 */

import { APP_PRIVILEGES, type AppPrivilege, type AppTablePrivileges } from './declaration';

/** The schema of the migration bookkeeping, which the app reads and never writes. */
export const BOOKKEEPING_SCHEMA = 'drizzle';

/** One entry of an access list: `grantee` null for PUBLIC. Privileges are lower case, as `APP_PRIVILEGES`. */
export interface CatalogGrant
{
    readonly grantee: string | null;
    readonly grantor: string;
    readonly privilege: string;
    /** Whether it is held `WITH GRANT OPTION`; absent, it is not */
    readonly grantable?: boolean;
}

export interface CatalogColumnGrant extends CatalogGrant
{
    readonly column: string;
}

/** What a relation of a managed schema is to the plan: a foreign table is a table. */
export type RelationKind = 'table' | 'view' | 'materialized view' | 'sequence';

/** A table (plain, partitioned or foreign), view, materialized view or sequence of a managed schema. */
export interface CatalogRelation
{
    readonly schema: string;
    readonly name: string;
    readonly kind: RelationKind;
    /** Whether it is a partition of another table, at any level (`relispartition`) */
    readonly partition: boolean;
    /** Whether a view's SELECT rule checks the rights of its user, not its owner, on the tables under it (`security_invoker`); absent, it does not */
    readonly securityInvoker?: boolean;
    /** Whether a view has a rewrite rule other than its SELECT rule, which runs with its owner's rights; absent, it has none */
    readonly writeRule?: boolean;
    /** Whether a view has an INSTEAD OF trigger; absent, it has none */
    readonly insteadOfTrigger?: boolean;
    readonly owner: string;
    readonly grants: readonly CatalogGrant[];
    readonly columnGrants: readonly CatalogColumnGrant[];
}

/** A managed schema that exists, as one of the planned roles sees it. */
export interface CatalogSchema
{
    readonly name: string;
    readonly role: string;
    /** Whether the role may use the schema, by any path */
    readonly usage: boolean;
    /** Whether the connected role owns the schema (or inherits its owner), so may grant on it */
    readonly mayGrant: boolean;
    readonly owner: string;
    /** The schema's access list (the owner's default one when it has none), the same for each role */
    readonly grants: readonly CatalogGrant[];
}

/** A planned role as the catalog knows it. */
export interface CatalogRole
{
    readonly name: string;
    /** Whether it is the connected role (the owner) or inherits its privileges */
    readonly inheritsOwner: boolean;
    /** Every other role whose privileges it inherits */
    readonly memberOf: readonly string[];
}

/** A relation of a managed schema that the connected role cannot grant on. */
export interface ForeignOwnedRelation
{
    readonly schema: string;
    readonly name: string;
    readonly kind: RelationKind;
    readonly owner: string;
}

/** What the plan reads from the database, as the owner. */
export interface PrivilegeCatalog
{
    readonly roles: readonly CatalogRole[];
    /** The planned role names that are no role in this database */
    readonly missingRoles: readonly string[];
    readonly schemas: readonly CatalogSchema[];
    readonly relations: readonly CatalogRelation[];
    readonly foreignOwned: readonly ForeignOwnedRelation[];
    /** Whether PUBLIC may create in schema `public` (PostgreSQL before 15, unless revoked) */
    readonly publicMayCreateInPublic: boolean;
}

/** What the plan is told: the managed schemas and the declarations of their tables. */
export interface AppPrivilegesTarget
{
    /** The project's schemas, each function package's, and `drizzle` */
    readonly schemas: readonly string[];
    /** The declared tables; a table of a managed schema without an entry has `defaults` */
    readonly tables: readonly AppTablePrivileges[];
    readonly defaults: readonly AppPrivilege[];
}

/** The roles to plan for: the app's, and the read role when it is another one. */
export interface AppRoles
{
    readonly app: string;
    readonly read?: string;
}

/**
 * A grant to PUBLIC on a relation from a grantor other than its owner, which
 * the owner's REVOKE leaves in place. `statement` is what `grantor` can run to
 * revoke it.
 */
export interface PublicGrantByOther
{
    readonly schema: string;
    readonly name: string;
    readonly grantor: string;
    /** The privilege, `update (column)` for a column's */
    readonly privilege: string;
    readonly statement: string;
}

/** An access list entry a role other than the relation's owner made: with a grant option it held. */
export interface GrantByOther
{
    readonly grantor: string;
    /** null for PUBLIC */
    readonly grantee: string | null;
    readonly privilege: string;
    /** The column, for a column's entry */
    readonly column?: string;
    readonly grantable: boolean;
}

/**
 * A REVOKE of the plan, and every grant of a privilege it names that a role
 * other than the object's owner made on that relation — relation-level and
 * column-level — or schema. PostgreSQL refuses the REVOKE (2BP01) when one of
 * them depends on the grant option it takes; which one, PostgreSQL decides.
 */
export interface RevokeGrantsByOthers
{
    readonly statement: string;
    readonly schema: string;
    /** The relation; absent for a REVOKE on the schema itself */
    readonly name?: string;
    readonly grants: readonly GrantByOther[];
}

/**
 * What the plan changes for one grantee on one relation: the comparison its
 * statements are written from, of the grants the relation's owner gave it.
 */
export interface GranteeChange
{
    readonly schema: string;
    readonly name: string;
    readonly kind: RelationKind;
    /** null for PUBLIC */
    readonly grantee: string | null;
    /** In its set, not held: granted */
    readonly missing: readonly string[];
    /** Held, not in its set: revoked */
    readonly excess: readonly string[];
    /** In its set, held `WITH GRANT OPTION`: the option is revoked */
    readonly grantOption: readonly string[];
    /** Column grants `excess` does not take with the table-level REVOKE: revoked */
    readonly columns: readonly { readonly privilege: string; readonly column: string }[];
}

/**
 * What the plan revokes from one grantee on one managed schema: what the
 * schema's owner gave it beyond USAGE.
 */
export interface SchemaChange
{
    readonly schema: string;
    /** null for PUBLIC */
    readonly grantee: string | null;
    /** Held beyond USAGE (CREATE): revoked */
    readonly excess: readonly string[];
    /** USAGE held `WITH GRANT OPTION`: the option is revoked */
    readonly grantOption: readonly string[];
}

/** A managed schema a planned role owns, or whose owner it inherits. */
export interface OwnedSchema
{
    readonly role: string;
    readonly schema: string;
}

/** A managed schema with something to revoke whose owner the connected role is not, nor inherits. */
export interface ForeignOwnedSchema
{
    readonly schema: string;
    readonly owner: string;
}

/** A privilege beyond USAGE a planned role holds on a managed schema that the owner's REVOKE does not take back. */
export interface SchemaPrivilegeHeldElsewhere
{
    readonly role: string;
    readonly schema: string;
    /** `create`, or `usage with grant option` */
    readonly privilege: string;
    /** `member of <role>`, `granted by <role>`, or `granted to PUBLIC by <role>` */
    readonly through: string;
}

/** A relation a planned role owns, or whose owner it inherits. */
export interface OwnedRelation
{
    readonly role: string;
    readonly schema: string;
    readonly name: string;
    readonly kind: RelationKind;
}

/** A privilege a planned role holds beyond its set that the owner's REVOKE does not take back. */
export interface PrivilegeHeldElsewhere
{
    readonly role: string;
    readonly schema: string;
    readonly name: string;
    readonly privilege: string;
    /** `member of <role>`, or `granted by <role>` */
    readonly through: string;
}

export interface AppPrivilegesPlan
{
    /** The statements to run, in order, as the owner, in one transaction */
    readonly statements: readonly string[];
    /** What the relation statements change, per relation and grantee; one with nothing to change is left out */
    readonly changes: readonly GranteeChange[];
    /** What the schema REVOKEs take, per schema and grantee; one with nothing to revoke is left out */
    readonly schemaChanges: readonly SchemaChange[];
    /** Each planned role and managed schema it cannot use, by any path: USAGE is granted, or the schema is in `ungrantableSchemas` */
    readonly withoutUsage: readonly { readonly schema: string; readonly role: string }[];
    /** Planned roles that are the owner or inherit it: nothing is planned for them */
    readonly ownerRoles: readonly string[];
    /** Each relation the owner may grant on that a planned role owns or inherits the owner of: nothing is planned there, for any grantee */
    readonly ownedRelations: readonly OwnedRelation[];
    /** Each managed schema and planned role that owns it or inherits its owner: no statement there for that role */
    readonly ownedSchemas: readonly OwnedSchema[];
    /** Role names that are no role: nothing is planned, and the plan is blocked */
    readonly missingRoles: readonly string[];
    readonly heldElsewhere: readonly PrivilegeHeldElsewhere[];
    readonly schemaHeldElsewhere: readonly SchemaPrivilegeHeldElsewhere[];
    /** Grants to PUBLIC the owner's REVOKE leaves in place: they block the plan */
    readonly publicGrantsByOthers: readonly PublicGrantByOther[];
    /** Each REVOKE of `statements` whose relation holds a grant of its privileges by another role than the owner */
    readonly grantsByOthers: readonly RevokeGrantsByOthers[];
    /** Declared tables of a managed schema the catalog does not hold */
    readonly absentTables: readonly { readonly schema: string; readonly table: string }[];
    /** Schemas a planned role cannot use and the owner cannot grant */
    readonly ungrantableSchemas: readonly { readonly schema: string; readonly role: string }[];
    readonly foreignOwned: readonly ForeignOwnedRelation[];
    /** Schemas with something to revoke that the owner cannot revoke on: they block the plan */
    readonly foreignOwnedSchemas: readonly ForeignOwnedSchema[];
    readonly publicMayCreateInPublic: boolean;
    /** Whether a missing role, a foreign-owned relation or schema, an ungrantable schema or a grant to PUBLIC by another role forbids applying it */
    readonly blocked: boolean;
}

/**
 * The plan that brings `roles` to `target` on `catalog`. What `catalog` holds
 * outside `target.schemas` is ignored, whoever read it: the plan never names
 * a schema, or a relation of one, that it was not told to manage.
 */
export function planAppPrivileges(fullCatalog: PrivilegeCatalog, target: AppPrivilegesTarget, roles: AppRoles): AppPrivilegesPlan
{
    const catalog = managedCatalog(fullCatalog, target.schemas);
    const ownerRoles = catalog.roles.filter(role => role.inheritsOwner).map(role => role.name);
    const planned = ownerRoles.includes(roles.app) || catalog.missingRoles.length > 0 ? [] : catalog.roles.filter(role => !role.inheritsOwner);
    const schemaPlans = planSchemas(catalog.schemas.filter(schema => planned.some(role => role.name === schema.role)), planned, roles);
    const relationPlans = planned.length === 0 ? [] : planRelations(catalog, planned, desiredPrivileges(target, roles));
    const foreignOwned = planned.length === 0 ? [] : catalog.foreignOwned;
    const ungrantableSchemas = schemaPlans.flatMap(plan => plan.ungrantable);
    const foreignOwnedSchemas = schemaPlans.flatMap(plan => plan.foreignOwned);

    return {
        statements: [...schemaPlans, ...relationPlans].flatMap(plan => plan.statements.map(planned => planned.statement)),
        changes: relationPlans.flatMap(plan => plan.changes),
        schemaChanges: schemaPlans.flatMap(plan => plan.changes),
        withoutUsage: schemaPlans.flatMap(plan => plan.lacking),
        ownerRoles,
        ownedRelations: relationPlans.flatMap(plan => plan.owned),
        ownedSchemas: schemaPlans.flatMap(plan => plan.owned),
        missingRoles: catalog.missingRoles,
        heldElsewhere: relationPlans.flatMap(plan => plan.heldElsewhere),
        schemaHeldElsewhere: schemaPlans.flatMap(plan => plan.heldElsewhere),
        publicGrantsByOthers: relationPlans.flatMap(plan => plan.publicGrantsByOthers),
        grantsByOthers: [...schemaPlans, ...relationPlans].flatMap(plan => plan.grantsByOthers),
        absentTables: absentTables(catalog, target),
        ungrantableSchemas,
        foreignOwned,
        foreignOwnedSchemas,
        publicMayCreateInPublic: catalog.publicMayCreateInPublic,
        blocked: catalog.missingRoles.length > 0 || foreignOwned.length > 0 || ungrantableSchemas.length > 0 || foreignOwnedSchemas.length > 0
            || relationPlans.some(plan => plan.publicGrantsByOthers.length > 0),
    };
}

/** `catalog` less its schemas, relations and foreign-owned relations outside `schemas`. */
function managedCatalog(catalog: PrivilegeCatalog, schemas: readonly string[]): PrivilegeCatalog
{
    return {
        ...catalog,
        schemas: catalog.schemas.filter(schema => schemas.includes(schema.name)),
        relations: catalog.relations.filter(relation => schemas.includes(relation.schema)),
        foreignOwned: catalog.foreignOwned.filter(relation => schemas.includes(relation.schema)),
    };
}

/** Each relation's plan, the foreign-owned left out: nothing may be granted on them. */
function planRelations(
    catalog: PrivilegeCatalog,
    planned: readonly CatalogRole[],
    desired: DesiredPrivileges,
): RelationPlan[]
{
    const foreign = new Set(catalog.foreignOwned.map(relation => relationKey(relation.schema, relation.name)));

    return catalog.relations
        .filter(relation => !foreign.has(relationKey(relation.schema, relation.name)))
        .map(relation => planRelation(relation, planned, desired));
}

/** What `role` is brought to on `relation`; `null` for PUBLIC. */
type DesiredPrivileges = (relation: CatalogRelation, role: string | null) => readonly string[];

/** The table above, as a function of relation and role. */
function desiredPrivileges(target: AppPrivilegesTarget, roles: AppRoles): DesiredPrivileges
{
    const declared = new Map(target.tables.map(entry => [relationKey(entry.schema, entry.table), entry.privileges]));

    return (relation, role) =>
    {
        const bookkeeping = relation.schema === BOOKKEEPING_SCHEMA;

        if (role === null || (relation.kind === 'sequence' && (bookkeeping || role !== roles.app)))
        {
            return [];
        }

        if (relation.kind === 'sequence')
        {
            return ['usage'];
        }

        const tableSet = appRelationPrivileges(target, relation, declared);

        return role === roles.app ? tableSet : bookkeeping ? [] : tableSet.filter(privilege => privilege === 'select');
    };
}

/** A relation as the app role's set on it depends on it. */
export type AppRelation = Pick<CatalogRelation, 'schema' | 'name' | 'kind' | 'partition' | 'securityInvoker' | 'writeRule' | 'insteadOfTrigger'>;

/**
 * The set the app role is brought to on a relation that is no sequence:
 * nothing on a partition; `select` in `drizzle`, on a materialized view and
 * on a view a write through which is not checked as the app; `target.defaults`
 * on one whose writes are; else the table's declaration in `target`, else
 * `target.defaults`. `declared` is `target.tables` by key, when the caller
 * has it.
 */
export function appRelationPrivileges(
    target: AppPrivilegesTarget,
    relation: AppRelation,
    declared = new Map(target.tables.map(entry => [relationKey(entry.schema, entry.table), entry.privileges])),
): readonly string[]
{
    const declaration = declared.get(relationKey(relation.schema, relation.name)) ?? 'default';

    if (relation.partition)
    {
        return [];
    }

    if (relation.schema === BOOKKEEPING_SCHEMA || relation.kind === 'materialized view' || (relation.kind === 'view' && !writesCheckedAsUser(relation)))
    {
        return ['select'];
    }

    return relation.kind === 'view' || declaration === 'default' ? target.defaults : declaration;
}

/**
 * Whether every write through a view is checked against its user's own
 * rights on the tables under it: `security_invoker`, which covers the SELECT
 * rule only, and no other rule nor INSTEAD OF trigger to write past it.
 */
function writesCheckedAsUser(relation: AppRelation): boolean
{
    return relation.securityInvoker === true && relation.writeRule !== true && relation.insteadOfTrigger !== true;
}

/** `public`, the database's shared schema: PUBLIC there is every role of the database, so its PUBLIC entries are reported, never planned. */
const SHARED_SCHEMA = 'public';

/** Each managed schema's plan, from its rows: one per planned role. */
function planSchemas(rows: readonly CatalogSchema[], planned: readonly CatalogRole[], roles: AppRoles): SchemaPlan[]
{
    return [...new Set(rows.map(row => row.name))].map(name => planSchema(rows.filter(row => row.name === name), planned, roles));
}

/**
 * USAGE for each planned role that cannot use the schema — the read role
 * needs none on `drizzle` — and a REVOKE of what the schema's owner gave a
 * planned role, or PUBLIC, beyond it. A planned role that owns the schema or
 * inherits its owner gets no statement there and is listed as `owned`; the
 * other planned roles, and PUBLIC, whose grants reach them, are planned as on
 * any schema; when every planned role owns it, nothing is planned there.
 * `rows` share the schema's name, owner, access list and `mayGrant`.
 */
function planSchema(rows: readonly CatalogSchema[], planned: readonly CatalogRole[], roles: AppRoles): SchemaPlan
{
    const [schema] = rows;
    const owners = planned.filter(role => role.name === schema.owner || role.memberOf.includes(schema.owner));
    const owned = owners.map(role => ({ role: role.name, schema: schema.name }));
    const others = rows.filter(row => !owners.some(role => role.name === row.role));

    if (others.length === 0)
    {
        return { ...NO_SCHEMA_PLAN, owned };
    }

    const lacking = others.filter(row => !row.usage && (row.role === roles.app || row.name !== BOOKKEEPING_SCHEMA))
        .map(row => ({ schema: row.name, role: row.role }));
    const changes = [...others.map(row => row.role), ...(schema.name === SHARED_SCHEMA ? [] : [null])]
        .map(grantee => schemaChange(schema, grantee))
        .filter(change => change.excess.length + change.grantOption.length > 0);
    const statements = [
        ...lacking.map(entry => ({ statement: `GRANT USAGE ON SCHEMA ${quoteIdentifier(entry.schema)} TO ${quoteIdentifier(entry.role)}`, revokes: [] })),
        ...changes.flatMap(schemaChangeStatements),
    ];

    return {
        lacking,
        ungrantable: schema.mayGrant ? [] : lacking,
        foreignOwned: schema.mayGrant || changes.length === 0 ? [] : [{ schema: schema.name, owner: schema.owner }],
        changes,
        owned,
        statements: schema.mayGrant ? statements : [],
        heldElsewhere: planned.filter(role => !owners.includes(role)).flatMap(role => schemaHeldElsewhere(schema, role, changes)),
        grantsByOthers: schema.mayGrant ? statements.flatMap(planned => schemaRevokeGrantsByOthers(schema, planned)) : [],
    };
}

/** One schema's plan, as `planSchema` describes it. */
interface SchemaPlan
{
    lacking: { schema: string; role: string }[];
    ungrantable: { schema: string; role: string }[];
    foreignOwned: ForeignOwnedSchema[];
    changes: SchemaChange[];
    owned: OwnedSchema[];
    statements: PlannedStatement[];
    heldElsewhere: SchemaPrivilegeHeldElsewhere[];
    grantsByOthers: RevokeGrantsByOthers[];
}

const NO_SCHEMA_PLAN: SchemaPlan = { lacking: [], ungrantable: [], foreignOwned: [], changes: [], owned: [], statements: [], heldElsewhere: [], grantsByOthers: [] };

/** What the schema's owner gave `grantee` beyond USAGE, and the grant option of USAGE; PUBLIC can hold no option. */
function schemaChange(schema: CatalogSchema, grantee: string | null): SchemaChange
{
    const fromOwner = schema.grants.filter(grant => grant.grantee === grantee && grant.grantor === schema.owner);

    return {
        schema: schema.name,
        grantee,
        excess: fromOwner.filter(grant => grant.privilege !== 'usage').map(grant => grant.privilege),
        grantOption: fromOwner.filter(grant => grant.privilege === 'usage' && grant.grantable === true).map(grant => grant.privilege),
    };
}

/** REVOKE the excess, which takes its grant option too, then the grant option of USAGE. */
function schemaChangeStatements(change: SchemaChange): PlannedStatement[]
{
    const object = `SCHEMA ${quoteIdentifier(change.schema)}`;
    const role = granteeName(change.grantee);

    return [
        ...(change.excess.length > 0 ? [{ statement: `REVOKE ${privilegeList(change.excess)} ON ${object} FROM ${role}`, revokes: change.excess }] : []),
        ...(change.grantOption.length > 0
            ? [{ statement: `REVOKE GRANT OPTION FOR ${privilegeList(change.grantOption)} ON ${object} FROM ${role}`, revokes: change.grantOption }]
            : []),
    ];
}

/** `planned`, when it is a REVOKE, with the grants of what it revokes on `schema` that another role than its owner made; else nothing. */
function schemaRevokeGrantsByOthers(schema: CatalogSchema, planned: PlannedStatement): RevokeGrantsByOthers[]
{
    const grants = schema.grants
        .filter(grant => grant.grantor !== schema.owner && planned.revokes.includes(grant.privilege))
        .map(({ grantor, grantee, privilege, grantable }) => ({ grantor, grantee, privilege, grantable: grantable === true }));

    return grants.length === 0 ? [] : [{ statement: planned.statement, schema: schema.name, grants }];
}

/**
 * What `role` holds on `schema` beyond USAGE that `changes` leave: through a
 * role it is a member of — unless the plan revokes that role's grant — from
 * another grantor, or through PUBLIC from another grantor (on `public`,
 * `publicMayCreateInPublic` reports PUBLIC); USAGE's grant option included.
 */
function schemaHeldElsewhere(schema: CatalogSchema, role: CatalogRole, changes: readonly SchemaChange[]): SchemaPrivilegeHeldElsewhere[]
{
    const revoked = (grant: CatalogGrant) => grant.grantor === schema.owner
        && changes.some(change => change.grantee === grant.grantee && change.excess.includes(grant.privilege));
    const throughOf = (grant: CatalogGrant) => grant.grantee === role.name
        ? (grant.grantor === schema.owner ? undefined : `granted by ${grant.grantor}`)
        : grant.grantee === null
            ? (grant.grantor === schema.owner || schema.name === SHARED_SCHEMA ? undefined : `granted to PUBLIC by ${grant.grantor}`)
            : (role.memberOf.includes(grant.grantee) && !revoked(grant) ? `member of ${grant.grantee}` : undefined);
    const optionOnly = (grant: CatalogGrant) => grant.privilege === 'usage' && grant.grantable === true && grant.grantee === role.name;
    const entries = schema.grants
        .filter(grant => grant.privilege !== 'usage' || optionOnly(grant))
        .flatMap(grant =>
        {
            const through = throughOf(grant);
            const privilege = optionOnly(grant) ? `${grant.privilege} with grant option` : grant.privilege;

            return through === undefined ? [] : [{ role: role.name, schema: schema.name, privilege, through }];
        });

    return entries.filter((entry, index) => entries.findIndex(other => sameEntry(entry, other)) === index);
}

/** A statement of the plan, and the privileges it revokes: none for a GRANT. */
interface PlannedStatement
{
    readonly statement: string;
    readonly revokes: readonly string[];
}

/** One relation's changes and statements, the planned roles that own it, what the statements leave held elsewhere, and what other roles granted on it. */
interface RelationPlan
{
    changes: GranteeChange[];
    owned: OwnedRelation[];
    statements: PlannedStatement[];
    heldElsewhere: PrivilegeHeldElsewhere[];
    publicGrantsByOthers: PublicGrantByOther[];
    grantsByOthers: RevokeGrantsByOthers[];
}

/**
 * The statements for one relation, for PUBLIC and each planned role, and what
 * they leave held elsewhere; none when a planned role owns it or inherits its
 * owner, which is then listed as `owned` by each such role.
 */
function planRelation(relation: CatalogRelation, planned: readonly CatalogRole[], desired: DesiredPrivileges): RelationPlan
{
    const owners = planned.filter(role => role.name === relation.owner || role.memberOf.includes(relation.owner));

    if (owners.length > 0)
    {
        return {
            changes: [],
            owned: owners.map(role => ({ role: role.name, schema: relation.schema, name: relation.name, kind: relation.kind })),
            statements: [],
            heldElsewhere: [],
            publicGrantsByOthers: [],
            grantsByOthers: [],
        };
    }

    const changes = [...planned.map(role => role.name), null]
        .map(grantee => granteeChange(relation, grantee, desired(relation, grantee)))
        .filter(changesSomething);
    const statements = changes.flatMap(changeStatements);

    return {
        changes,
        owned: [],
        statements,
        heldElsewhere: planned.flatMap(role => heldElsewhere(relation, role, desired(relation, role.name), changes)),
        publicGrantsByOthers: publicGrantsByOthers(relation),
        grantsByOthers: statements.flatMap(planned => revokeGrantsByOthers(relation, planned)),
    };
}

/**
 * What `grantee` lacks of `wanted` from the owner, what else the owner gave
 * it, the grant option of what it keeps, and each column grant the
 * table-level REVOKE does not already take.
 */
function granteeChange(relation: CatalogRelation, grantee: string | null, wanted: readonly string[]): GranteeChange
{
    const fromOwner = (grant: CatalogGrant) => grant.grantee === grantee && grant.grantor === relation.owner;
    const held = new Set(relation.grants.filter(fromOwner).map(grant => grant.privilege));
    const excess = [...held].filter(privilege => !wanted.includes(privilege));

    return {
        schema: relation.schema,
        name: relation.name,
        kind: relation.kind,
        grantee,
        missing: wanted.filter(privilege => !held.has(privilege)),
        excess,
        grantOption: relation.grants.filter(grant => fromOwner(grant) && grant.grantable === true && wanted.includes(grant.privilege)).map(grant => grant.privilege),
        columns: relation.columnGrants.filter(grant => fromOwner(grant) && !excess.includes(grant.privilege)).map(({ privilege, column }) => ({ privilege, column })),
    };
}

function changesSomething(change: GranteeChange): boolean
{
    return change.missing.length + change.excess.length + change.grantOption.length + change.columns.length > 0;
}

/** GRANT what is missing, REVOKE the excess, then the grant options, then the column grants. */
function changeStatements(change: GranteeChange): PlannedStatement[]
{
    const object = objectName(change);
    const role = granteeName(change.grantee);

    const statements: (PlannedStatement | undefined)[] = [
        change.missing.length > 0 ? { statement: `GRANT ${privilegeList(change.missing)} ON ${object} TO ${role}`, revokes: [] } : undefined,
        change.excess.length > 0 ? { statement: `REVOKE ${privilegeList(change.excess)} ON ${object} FROM ${role}`, revokes: change.excess } : undefined,
        change.grantOption.length > 0
            ? { statement: `REVOKE GRANT OPTION FOR ${privilegeList(change.grantOption)} ON ${object} FROM ${role}`, revokes: change.grantOption }
            : undefined,
        ...columnRevokes(change.columns).map(list => ({ statement: `REVOKE ${list.columns} ON ${object} FROM ${role}`, revokes: [list.privilege] })),
    ];

    return statements.filter((planned): planned is PlannedStatement => planned !== undefined);
}

/** Each grant to PUBLIC on `relation`, table-level or on a column, from a grantor other than its owner. */
function publicGrantsByOthers(relation: CatalogRelation): PublicGrantByOther[]
{
    return accessEntries(relation)
        .filter(grant => grant.grantee === null && grant.grantor !== relation.owner)
        .map(grant =>
        {
            const columnList = grant.column === undefined ? '' : ` (${quoteIdentifier(grant.column)})`;

            return {
                schema: relation.schema,
                name: relation.name,
                grantor: grant.grantor,
                privilege: `${grant.privilege}${columnList}`,
                statement: `REVOKE ${grant.privilege.toUpperCase()}${columnList} ON ${objectName(relation)} FROM PUBLIC`,
            };
        });
}

/** `planned`, when it is a REVOKE, with the grants of what it revokes on `relation` that another role than the owner made; else nothing. */
function revokeGrantsByOthers(relation: CatalogRelation, planned: PlannedStatement): RevokeGrantsByOthers[]
{
    const grants = accessEntries(relation)
        .filter(grant => grant.grantor !== relation.owner && planned.revokes.includes(grant.privilege))
        .map(({ grantor, grantee, privilege, column, grantable }) => ({ grantor, grantee, privilege, ...(column === undefined ? {} : { column }), grantable: grantable === true }));

    return grants.length === 0 ? [] : [{ statement: planned.statement, schema: relation.schema, name: relation.name, grants }];
}

/** Every entry of `relation`'s access lists: its own, then its columns', each with its column. */
function accessEntries(relation: CatalogRelation): (CatalogGrant & { readonly column?: string })[]
{
    return [...relation.grants, ...relation.columnGrants];
}

/** `TABLE "schema"."name"`, or `SEQUENCE …`, as a GRANT names it. */
function objectName(relation: Pick<CatalogRelation, 'schema' | 'name' | 'kind'>): string
{
    return `${relation.kind === 'sequence' ? 'SEQUENCE' : 'TABLE'} ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.name)}`;
}

function granteeName(grantee: string | null): string
{
    return grantee === null ? 'PUBLIC' : quoteIdentifier(grantee);
}

/** `UPDATE ("a", "b")` per privilege, in privilege order. */
function columnRevokes(grants: GranteeChange['columns']): { privilege: string; columns: string }[]
{
    const byPrivilege = new Map<string, string[]>();

    for (const grant of grants)
    {
        byPrivilege.set(grant.privilege, [...(byPrivilege.get(grant.privilege) ?? []), grant.column]);
    }

    return sortPrivileges([...byPrivilege.keys()])
        .map(privilege => ({ privilege, columns: `${privilege.toUpperCase()} (${[...new Set(byPrivilege.get(privilege))].sort().map(quoteIdentifier).join(', ')})` }));
}

/**
 * What `role` holds on `relation` beyond `wanted` that the plan's `changes`
 * leave: through a role it is a member of — unless the plan revokes that
 * role's grant — or granted by another grantor; table-level or on a column,
 * a wanted privilege's grant option included.
 */
function heldElsewhere(relation: CatalogRelation, role: CatalogRole, wanted: readonly string[], changes: readonly GranteeChange[]): PrivilegeHeldElsewhere[]
{
    const throughOf = (grant: CatalogGrant & { readonly column?: string }) => grant.grantee === role.name
        ? (grant.grantor === relation.owner ? undefined : `granted by ${grant.grantor}`)
        : (grant.grantee !== null && role.memberOf.includes(grant.grantee) && !revokedBy(changes, relation, grant) ? `member of ${grant.grantee}` : undefined);
    const optionOnly = (grant: CatalogGrant) => wanted.includes(grant.privilege) && grant.grantable === true && grant.grantee === role.name;
    const entries = [...relation.grants, ...relation.columnGrants]
        .filter(grant => !wanted.includes(grant.privilege) || optionOnly(grant))
        .flatMap(grant =>
        {
            const through = throughOf(grant);
            const held = 'column' in grant ? `${grant.privilege} (${grant.column})` : grant.privilege;
            const privilege = optionOnly(grant) ? `${held} with grant option` : held;

            return through === undefined ? [] : [{ role: role.name, schema: relation.schema, name: relation.name, privilege, through }];
        });

    return entries.filter((entry, index) => entries.findIndex(other => sameEntry(entry, other)) === index);
}

/** Whether `changes` revoke `grant`: the owner's, of a privilege the plan takes from its grantee, table-level or on its column. */
function revokedBy(changes: readonly GranteeChange[], relation: CatalogRelation, grant: CatalogGrant & { readonly column?: string }): boolean
{
    const change = changes.find(entry => entry.grantee !== null && entry.grantee === grant.grantee);

    return grant.grantor === relation.owner && change !== undefined
        && (change.excess.includes(grant.privilege) || change.columns.some(column => column.privilege === grant.privilege && column.column === grant.column));
}

function sameEntry(a: Pick<PrivilegeHeldElsewhere, 'privilege' | 'through'>, b: Pick<PrivilegeHeldElsewhere, 'privilege' | 'through'>): boolean
{
    return a.privilege === b.privilege && a.through === b.through;
}

/** The declared tables of a managed schema, `drizzle` aside, that the catalog does not hold. */
function absentTables(catalog: PrivilegeCatalog, target: AppPrivilegesTarget): { schema: string; table: string }[]
{
    const present = new Set(catalog.relations.filter(relation => relation.kind === 'table').map(relation => relationKey(relation.schema, relation.name)));

    return target.tables
        .filter(entry => target.schemas.includes(entry.schema) && entry.schema !== BOOKKEEPING_SCHEMA)
        .filter(entry => !present.has(relationKey(entry.schema, entry.table)))
        .map(({ schema, table }) => ({ schema, table }));
}

/** Privileges in `APP_PRIVILEGES` order, then any other (`usage`, `maintain`) by name. */
function sortPrivileges(privileges: readonly string[]): string[]
{
    const rank = (privilege: string) => (APP_PRIVILEGES as readonly string[]).indexOf(privilege);
    const ordered = (APP_PRIVILEGES as readonly string[]).filter(privilege => privileges.includes(privilege));

    return [...ordered, ...privileges.filter(privilege => rank(privilege) < 0).sort()];
}

function privilegeList(privileges: readonly string[]): string
{
    return sortPrivileges(privileges).map(privilege => privilege.toUpperCase()).join(', ');
}

function relationKey(schema: string, name: string): string
{
    return JSON.stringify([schema, name]);
}

/** `name` as a PostgreSQL identifier: double-quoted, a `"` inside doubled. */
export function quoteIdentifier(name: string): string
{
    return `"${name.replaceAll('"', '""')}"`;
}
