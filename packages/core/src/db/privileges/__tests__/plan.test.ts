/**
 * The app privileges plan (#405): catalog state and declarations in,
 * statements out — no database
 *
 * Each row names what would go unnoticed without it:
 * - G1 a table, sequence or schema the app cannot use after the step;
 * - G2 a second run that issues statements again (lock churn, no fixed point);
 * - G3 a grant-only step: a hand TRUNCATE, or an UPDATE on an append-only table, kept;
 * - G4 a column UPDATE surviving the table-level REVOKE's absence;
 * - G5 a PUBLIC grant reaching the app past the declaration;
 * - G6 the step revoking from a group role (another role changed), or staying silent about it;
 * - G7 the app able to write the migration bookkeeping, or the read role reading it;
 * - G8 a GRANT on a foreign-owned table — a PostgreSQL warning, not an error — applied silently;
 * - G9 statements issued for an app that is, or inherits, the owner;
 * - G10 the read role given more than SELECT;
 * - G11 a declared table that is not there going unreported;
 * - G12 a partition given a set of its own — the default one when undeclared —
 *   so the app gets round its root's declaration and row-level security;
 * - G13 `db status` comparing a partition with the default set, so a direct
 *   grant on it is no drift;
 * - G14 a declared privilege kept WITH GRANT OPTION, so the app can hand it to
 *   any role; or one from another grantor going unreported;
 * - G15 a grant the app made with an option the step takes: the plan
 *   blocking on it, or a REVOKE with CASCADE (PostgreSQL decides, and the step
 *   never cascades); the grants other roles made of a revoked privilege, on
 *   the relation or a column, missing from what a refusal is reported with —
 *   or the owner's own, or another privilege's, in it;
 * - G16 a PUBLIC grant from another grantor than the owner left in place, or
 *   revoked with a statement PostgreSQL refuses the owner;
 * - G17 a catalog holding more than the managed schemas — a caller's mistake —
 *   turned into a GRANT, a REVOKE or a block on a schema the step does not manage;
 * - G18 a configured role name that is no role planned for, or let through;
 * - G19 a view, materialized view or foreign table of a managed schema left
 *   ungranted (the app gets 42501), or given more than its set, by the step
 *   or in `db status`; a view running with its owner's rights given a write,
 *   which is a write on the tables under it whatever they declare; a
 *   `security_invoker` view held to SELECT, when it cannot widen anything;
 *   one with a write rule or an INSTEAD OF trigger, which writes with its
 *   owner's rights all the same, given the default set;
 * - G20 `db status` reading a grant option, a column grant, a PUBLIC grant, a
 *   sequence or a schema without USAGE as clean while `db grant` still has a
 *   statement for it; or counting as drift what `db grant` does not change (a
 *   privilege held through a group role, PUBLIC on a relation the app owns) —
 *   with status and the plan given the same catalog;
 * - G21 (rv428h X1, rv428i B1) a relation a planned role owns, or whose owner
 *   it inherits, given a statement when the owner can grant on it (a
 *   superuser) — for the app, a REVOKE it grants itself back; for PUBLIC or the
 *   read role, one a single-role project's `db grant` never runs, so status
 *   reports drift there that never clears — or compared by status;
 * - G22 (rv428h X2) a grant to PUBLIC from another grantor than the owner —
 *   the app holds it, the step is blocked — read by status as clean;
 * - G23 (rv428h X3) a privilege the app holds as a member of the read role,
 *   which the step revokes from the read role, reported by both commands as
 *   one `db grant` does not change, and missing from status's drift.
 * - G24 (#435) CREATE on a managed schema, or USAGE on it WITH GRANT OPTION,
 *   that the schema's owner gave the app: kept by the step — the app creates,
 *   and owns, tables there, or hands USAGE to any role — and read by status
 *   as clean; one from another grantor or a group role revoked, or unreported;
 *   the CREATE the app passed on missing from what a refusal (2BP01) lists;
 * - G25 (#435) a schema the app role alone owns given a statement — a REVOKE
 *   the owner grants itself back, drift that never clears — or compared by status;
 * - G26 (#435) PUBLIC's CREATE on a managed schema, which the app holds too,
 *   kept; or PUBLIC's CREATE on `public`, database-wide, revoked;
 * - G27 (i436f1) a schema the read role owns taken out of the plan for the
 *   app as well: the app without USAGE there — refused on every table of it,
 *   whose grants it still gets — `db status` clean, and `db grant` neither
 *   granting it nor blocked when the owner may not; PUBLIC's CREATE there,
 *   which the app holds too, kept.
 * - G28 (i436f2) on a schema the app role owns, with a read role planned,
 *   what the app holds there from another grantor reported as held elsewhere
 *   — `db status` warning that it holds, beyond USAGE, a privilege on a
 *   schema it owns — or what the read role holds there left out with it, or
 *   listed by `db status` as the app's.
 */

import { describe, expect, it } from 'vitest';

import { compareAppPrivileges, type AppPrivilegeDrift } from '../check';
import { planAppPrivileges, type AppPrivilegesTarget, type CatalogGrant, type CatalogRelation, type CatalogSchema, type PrivilegeCatalog } from '../plan';
import { DEFAULT_APP_PRIVILEGES } from '../declaration';

const OWNER = 'app_owner';
const APP = 'app_user';

const table = (name: string, grants: CatalogGrant[] = [], columnGrants: CatalogRelation['columnGrants'] = [], schema = 'acme'): CatalogRelation =>
    ({ schema, name, kind: 'table', partition: false, owner: OWNER, grants: [...ownerGrants('table'), ...grants], columnGrants });

const sequence = (name: string, grants: CatalogGrant[] = [], schema = 'acme'): CatalogRelation =>
    ({ schema, name, kind: 'sequence', partition: false, owner: OWNER, grants: [...ownerGrants('sequence'), ...grants], columnGrants: [] });

/** The owner's own entries of a default access list: never a statement. */
function ownerGrants(kind: 'table' | 'sequence', owner = OWNER): CatalogGrant[]
{
    const privileges = kind === 'table' ? ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'] : ['usage', 'select', 'update'];

    return privileges.map(privilege => ({ grantee: owner, grantor: owner, privilege }));
}

/** A table `owner` owns, with its default access list and `grants`. */
const ownedBy = (owner: string, name: string, grants: CatalogGrant[] = []): CatalogRelation =>
    ({ ...table(name), owner, grants: [...ownerGrants('table', owner), ...grants] });

/** A managed schema as `role` sees it: usable, the owner's, with the owner's default access list. */
const schemaRow = (name: string, role = APP, facts: Partial<CatalogSchema> = {}): CatalogSchema =>
    ({ name, role, usage: true, mayGrant: true, owner: OWNER, grants: ['usage', 'create'].map(privilege => ({ grantee: OWNER, grantor: OWNER, privilege, grantable: true })), ...facts });

const toApp = (...privileges: string[]): CatalogGrant[] => privileges.map(privilege => ({ grantee: APP, grantor: OWNER, privilege }));

function catalog(relations: CatalogRelation[], overrides: Partial<PrivilegeCatalog> = {}): PrivilegeCatalog
{
    return {
        roles: [{ name: APP, inheritsOwner: false, memberOf: [] }],
        missingRoles: [],
        schemas: [...new Set(relations.map(relation => relation.schema))].map(name => schemaRow(name)),
        relations,
        foreignOwned: [],
        publicMayCreateInPublic: false,
        ...overrides,
    };
}

/** A drift entry of the app role's on `acme.<table>`, nothing changed but `changes`. */
const drift = (table: string, changes: Partial<AppPrivilegeDrift> = {}): AppPrivilegeDrift =>
    ({ schema: 'acme', table, kind: 'table', grantee: APP, through: null, missing: [], excess: [], grantOption: [], columns: [], ...changes });

const target = (tables: AppPrivilegesTarget['tables'] = [], schemas = ['acme', 'drizzle']): AppPrivilegesTarget =>
    ({ schemas, tables, defaults: DEFAULT_APP_PRIVILEGES });

const DEFAULT_TO_APP = toApp(...DEFAULT_APP_PRIVILEGES);

const appendOnly = { schema: 'acme', table: 'ledger', privileges: ['select', 'insert'] } as const;

describe('planAppPrivileges', () =>
{
    it('G1 grants a fresh table the default set, its sequence USAGE, and a schema the app cannot use USAGE', () =>
    {
        const state = catalog([table('notes'), sequence('notes_id_seq')], {
            schemas: [schemaRow('acme', APP, { usage: false })],
        });

        expect(planAppPrivileges(state, target(), { app: APP }).statements).toEqual([
            'GRANT USAGE ON SCHEMA "acme" TO "app_user"',
            'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "acme"."notes" TO "app_user"',
            'GRANT USAGE ON SEQUENCE "acme"."notes_id_seq" TO "app_user"',
        ]);
    });

    it('G2 a catalog that already matches the declarations gives no statement', () =>
    {
        const state = catalog([
            table('ledger', toApp('select', 'insert')),
            table('notes', toApp('select', 'insert', 'update', 'delete')),
            sequence('notes_id_seq', toApp('usage')),
            table('__drizzle_migrations', toApp('select'), [], 'drizzle'),
        ]);

        expect(planAppPrivileges(state, target([appendOnly]), { app: APP }).statements).toEqual([]);
    });

    it('G3 revokes what the app holds beyond its set: a hand TRUNCATE, and UPDATE/DELETE on an append-only table', () =>
    {
        const state = catalog([
            table('ledger', toApp('select', 'insert', 'update', 'delete')),
            table('notes', toApp('select', 'insert', 'update', 'delete', 'truncate')),
        ]);

        expect(planAppPrivileges(state, target([appendOnly]), { app: APP }).statements).toEqual([
            'REVOKE UPDATE, DELETE ON TABLE "acme"."ledger" FROM "app_user"',
            'REVOKE TRUNCATE ON TABLE "acme"."notes" FROM "app_user"',
        ]);
    });

    it('G4 revokes a column grant, unless the table-level REVOKE of that privilege already takes it', () =>
    {
        const columnUpdate = (column: string) => ({ column, grantee: APP, grantor: OWNER, privilege: 'update' });
        const state = catalog([
            table('ledger', toApp('select', 'insert', 'update'), [columnUpdate('amount')]),
            table('notes', toApp('select', 'insert', 'update', 'delete'), [columnUpdate('title'), columnUpdate('body')]),
        ]);

        expect(planAppPrivileges(state, target([appendOnly]), { app: APP }).statements).toEqual([
            'REVOKE UPDATE ON TABLE "acme"."ledger" FROM "app_user"',
            'REVOKE UPDATE ("body", "title") ON TABLE "acme"."notes" FROM "app_user"',
        ]);
    });

    it('G5 revokes every grant to PUBLIC on a managed table and sequence', () =>
    {
        const toPublic = (...privileges: string[]) => privileges.map(privilege => ({ grantee: null, grantor: OWNER, privilege }));
        const state = catalog([
            table('notes', [...toApp('select', 'insert', 'update', 'delete'), ...toPublic('select', 'update')]),
            sequence('notes_id_seq', [...toApp('usage'), ...toPublic('usage')]),
        ]);

        expect(planAppPrivileges(state, target(), { app: APP }).statements).toEqual([
            'REVOKE SELECT, UPDATE ON TABLE "acme"."notes" FROM PUBLIC',
            'REVOKE USAGE ON SEQUENCE "acme"."notes_id_seq" FROM PUBLIC',
        ]);
    });

    it('G6 reports, and does not revoke, what reaches the app through a group role or from another grantor', () =>
    {
        const state = catalog([table('ledger', [
            ...toApp('select', 'insert'),
            { grantee: 'writers', grantor: OWNER, privilege: 'update' },
            { grantee: 'writers', grantor: OWNER, privilege: 'select' },
            { grantee: APP, grantor: 'delegate', privilege: 'delete' },
        ])], { roles: [{ name: APP, inheritsOwner: false, memberOf: ['writers'] }] });

        const plan = planAppPrivileges(state, target([appendOnly]), { app: APP });

        expect(plan.statements).toEqual([]);
        expect(plan.heldElsewhere).toEqual([
            { role: APP, schema: 'acme', name: 'ledger', privilege: 'update', through: 'member of writers' },
            { role: APP, schema: 'acme', name: 'ledger', privilege: 'delete', through: 'granted by delegate' },
        ]);
    });

    it('G7 the app may only read the bookkeeping, and the read role gets nothing there', () =>
    {
        const state = catalog([
            table('__drizzle_migrations', toApp('select', 'insert', 'update', 'delete'), [], 'drizzle'),
            sequence('__drizzle_migrations_id_seq', toApp('usage'), 'drizzle'),
        ], {
            roles: [{ name: APP, inheritsOwner: false, memberOf: [] }, { name: 'app_reader', inheritsOwner: false, memberOf: [] }],
            schemas: [schemaRow('drizzle', APP, { usage: false }), schemaRow('drizzle', 'app_reader', { usage: false })],
        });

        expect(planAppPrivileges(state, target(), { app: APP, read: 'app_reader' }).statements).toEqual([
            'GRANT USAGE ON SCHEMA "drizzle" TO "app_user"',
            'REVOKE INSERT, UPDATE, DELETE ON TABLE "drizzle"."__drizzle_migrations" FROM "app_user"',
            'REVOKE USAGE ON SEQUENCE "drizzle"."__drizzle_migrations_id_seq" FROM "app_user"',
        ]);
    });

    it('G8 a table another role owns, or a schema the owner cannot grant, blocks the plan and is named', () =>
    {
        const foreign = { schema: 'acme', name: 'imported', kind: 'table' as const, owner: 'app_user' };
        const foreignOwned = planAppPrivileges(catalog([table('notes'), { ...table('imported'), owner: 'app_user' }], { foreignOwned: [foreign] }), target(), { app: APP });
        const ungrantable = planAppPrivileges(catalog([table('notes')], {
            schemas: [schemaRow('acme'), schemaRow('public', APP, { usage: false, mayGrant: false })],
        }), target([], ['acme', 'public', 'drizzle']), { app: APP });

        expect(foreignOwned.blocked).toBe(true);
        expect(foreignOwned.foreignOwned).toEqual([foreign]);
        expect(foreignOwned.statements.some(statement => statement.includes('"imported"'))).toBe(false);
        expect(ungrantable.blocked).toBe(true);
        expect(ungrantable.ungrantableSchemas).toEqual([{ schema: 'public', role: APP }]);
    });

    it('G9 an app that is, or inherits, the owner gets no statement at all — PUBLIC revokes included', () =>
    {
        const state = catalog([table('notes', [{ grantee: null, grantor: OWNER, privilege: 'select' }])], {
            roles: [{ name: APP, inheritsOwner: true, memberOf: [OWNER] }],
            schemas: [schemaRow('acme', APP, { usage: false })],
        });

        const plan = planAppPrivileges(state, target(), { app: APP });

        expect(plan.statements).toEqual([]);
        expect(plan.ownerRoles).toEqual([APP]);
        expect(plan.blocked).toBe(false);
    });

    it('G10 the read role is brought to SELECT where the table declares it, and to nothing elsewhere', () =>
    {
        const insertOnly = { schema: 'acme', table: 'inbox', privileges: ['insert'] } as const;
        const toReader = (...privileges: string[]) => privileges.map(privilege => ({ grantee: 'app_reader', grantor: OWNER, privilege }));
        const state = catalog([
            table('inbox', [...toApp('insert'), ...toReader('select')]),
            table('notes', [...toApp('select', 'insert', 'update', 'delete'), ...toReader('insert')]),
            sequence('notes_id_seq', [...toApp('usage'), ...toReader('usage')]),
        ], { roles: [{ name: APP, inheritsOwner: false, memberOf: [] }, { name: 'app_reader', inheritsOwner: false, memberOf: [] }] });

        expect(planAppPrivileges(state, target([insertOnly]), { app: APP, read: 'app_reader' }).statements).toEqual([
            'REVOKE SELECT ON TABLE "acme"."inbox" FROM "app_reader"',
            'GRANT SELECT ON TABLE "acme"."notes" TO "app_reader"',
            'REVOKE INSERT ON TABLE "acme"."notes" FROM "app_reader"',
            'REVOKE USAGE ON SEQUENCE "acme"."notes_id_seq" FROM "app_reader"',
        ]);
    });

    it('G11 a declared table of a managed schema that the catalog does not hold is reported', () =>
    {
        const plan = planAppPrivileges(catalog([table('notes')]), target([appendOnly, { schema: 'elsewhere', table: 'x', privileges: 'default' }]), { app: APP });

        expect(plan.absentTables).toEqual([{ schema: 'acme', table: 'ledger' }]);
    });

    it('G12 a partition, at any level, gets nothing directly: what the app holds there is revoked, the root keeps its declaration', () =>
    {
        const partition = (name: string, grants: CatalogGrant[] = []) => ({ ...table(name, grants), partition: true });
        const state = catalog([
            table('events', toApp('select')),
            partition('events_t1', [...toApp('select', 'insert', 'update', 'delete'), { grantee: null, grantor: OWNER, privilege: 'select' }]),
            partition('events_t1_a'),
        ]);
        const plan = planAppPrivileges(state, target([{ schema: 'acme', table: 'events', privileges: ['select'] }]), { app: APP });

        expect(plan.statements).toEqual([
            'REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE "acme"."events_t1" FROM "app_user"',
            'REVOKE SELECT ON TABLE "acme"."events_t1" FROM PUBLIC',
        ]);
    });

    it('G13 db status reports what the app holds on a partition as excess', () =>
    {
        const partition = (name: string, grants: CatalogGrant[] = []) => ({ ...table(name, grants), partition: true });
        const events = { schema: 'acme', table: 'events', privileges: ['select'] } as const;
        const state = catalog([table('events', toApp('select')), partition('events_t1', toApp('select', 'insert')), partition('events_t2')]);

        expect(compareAppPrivileges(state, target([events]), { app: APP }).drift).toEqual([drift('events_t1', { excess: ['select', 'insert'] })]);
    });

    it('G14 the grant option of a declared privilege is revoked, the privilege kept; one from another grantor is reported', () =>
    {
        const state = catalog([table('notes', [
            ...toApp('insert', 'update', 'delete'),
            { grantee: APP, grantor: OWNER, privilege: 'select', grantable: true },
            { grantee: APP, grantor: 'delegate', privilege: 'insert', grantable: true },
        ])]);
        const plan = planAppPrivileges(state, target(), { app: APP });

        expect(plan.statements).toEqual(['REVOKE GRANT OPTION FOR SELECT ON TABLE "acme"."notes" FROM "app_user"']);
        expect(plan.blocked).toBe(false);
        expect(plan.heldElsewhere).toEqual([
            { role: APP, schema: 'acme', name: 'notes', privilege: 'insert with grant option', through: 'granted by delegate' },
        ]);
    });

    it('G15 a grant the app made with an option the step takes neither blocks the plan nor cascades: its REVOKE carries the grants other roles made', () =>
    {
        const state = catalog([table('ledger', [
            ...toApp('select', 'insert'),
            { grantee: APP, grantor: OWNER, privilege: 'truncate', grantable: true },
            { grantee: 'auditor', grantor: APP, privilege: 'truncate' },
            { grantee: 'auditor', grantor: APP, privilege: 'select' },
        ], [
            { column: 'amount', grantee: APP, grantor: OWNER, privilege: 'update', grantable: true },
            { column: 'amount', grantee: 'clerk', grantor: APP, privilege: 'update', grantable: true },
            { column: 'amount', grantee: 'intern', grantor: 'clerk', privilege: 'update' },
        ])]);
        const plan = planAppPrivileges(state, target([appendOnly]), { app: APP });

        expect(plan.blocked).toBe(false);
        expect(plan.statements).toEqual([
            'REVOKE TRUNCATE ON TABLE "acme"."ledger" FROM "app_user"',
            'REVOKE UPDATE ("amount") ON TABLE "acme"."ledger" FROM "app_user"',
        ]);
        expect(plan.grantsByOthers).toEqual([
            {
                statement: 'REVOKE TRUNCATE ON TABLE "acme"."ledger" FROM "app_user"', schema: 'acme', name: 'ledger',
                grants: [{ grantor: APP, grantee: 'auditor', privilege: 'truncate', grantable: false }],
            },
            {
                statement: 'REVOKE UPDATE ("amount") ON TABLE "acme"."ledger" FROM "app_user"', schema: 'acme', name: 'ledger',
                grants: [
                    { grantor: APP, grantee: 'clerk', privilege: 'update', column: 'amount', grantable: true },
                    { grantor: 'clerk', grantee: 'intern', privilege: 'update', column: 'amount', grantable: false },
                ],
            },
        ]);
    });

    it('G16 PUBLIC is brought to nothing whoever granted it: the owner\'s grant is revoked, another grantor\'s blocks the plan', () =>
    {
        const state = catalog([table('notes', [
            ...toApp('select', 'insert', 'update', 'delete'),
            { grantee: null, grantor: OWNER, privilege: 'select' },
            { grantee: null, grantor: 'delegate', privilege: 'delete' },
        ])]);
        const plan = planAppPrivileges(state, target(), { app: APP });

        expect(plan.statements).toEqual(['REVOKE SELECT ON TABLE "acme"."notes" FROM PUBLIC']);
        expect(plan.blocked).toBe(true);
        expect(plan.publicGrantsByOthers).toEqual([
            { schema: 'acme', name: 'notes', grantor: 'delegate', privilege: 'delete', statement: 'REVOKE DELETE ON TABLE "acme"."notes" FROM PUBLIC' },
        ]);
    });

    it('G17 what the catalog holds outside target.schemas is ignored: no statement, report or block names it', () =>
    {
        const state = catalog([
            table('notes', toApp('select', 'insert', 'update', 'delete')),
            table('accounts', [{ grantee: null, grantor: OWNER, privilege: 'select' }], [], 'other_app'),
            { ...table('imported', [], [], 'other_app'), owner: 'someone' },
        ], {
            schemas: [
                schemaRow('acme'),
                schemaRow('other_app', APP, { usage: false, mayGrant: false }),
            ],
            foreignOwned: [{ schema: 'other_app', name: 'imported', kind: 'table', owner: 'someone' }],
        });
        const plan = planAppPrivileges(state, target([], ['acme']), { app: APP });

        expect(plan.statements).toEqual([]);
        expect(plan.blocked).toBe(false);
        expect(plan.ungrantableSchemas).toEqual([]);
        expect(plan.foreignOwned).toEqual([]);
    });

    it('G18 a role name that is no role blocks the plan, which plans nothing', () =>
    {
        const state = catalog([table('notes')], { roles: [], missingRoles: [APP], schemas: [] });
        const plan = planAppPrivileges(state, target(), { app: APP });

        expect(plan.blocked).toBe(true);
        expect(plan.missingRoles).toEqual([APP]);
        expect(plan.statements).toEqual([]);
    });

    it('G19 a foreign table is a table; a view SELECT, or the default set when security_invoker with no write rule or INSTEAD OF trigger; a materialized view SELECT; excess is revoked, and status agrees', () =>
    {
        type ViewFacts = Pick<CatalogRelation, 'securityInvoker' | 'writeRule' | 'insteadOfTrigger'>;

        const relation = (name: string, kind: CatalogRelation['kind'], grants: CatalogGrant[] = [], facts: ViewFacts = {}) => ({ ...table(name, grants), kind, ...facts });
        const state = catalog([
            relation('imported', 'table'),
            relation('ledger_v', 'view', toApp('select', 'insert', 'update', 'delete')),
            relation('notes_iv', 'view', toApp('select', 'truncate'), { securityInvoker: true }),
            relation('notes_rv', 'view', DEFAULT_TO_APP, { securityInvoker: true, writeRule: true }),
            relation('notes_tv', 'view', DEFAULT_TO_APP, { securityInvoker: true, insteadOfTrigger: true }),
            relation('totals_m', 'materialized view', toApp('select', 'insert')),
        ]);
        const plan = planAppPrivileges(state, target([{ schema: 'acme', table: 'imported', privileges: ['select'] }]), { app: APP });

        expect(plan.statements).toEqual([
            'GRANT SELECT ON TABLE "acme"."imported" TO "app_user"',
            'REVOKE INSERT, UPDATE, DELETE ON TABLE "acme"."ledger_v" FROM "app_user"',
            'GRANT INSERT, UPDATE, DELETE ON TABLE "acme"."notes_iv" TO "app_user"',
            'REVOKE TRUNCATE ON TABLE "acme"."notes_iv" FROM "app_user"',
            'REVOKE INSERT, UPDATE, DELETE ON TABLE "acme"."notes_rv" FROM "app_user"',
            'REVOKE INSERT, UPDATE, DELETE ON TABLE "acme"."notes_tv" FROM "app_user"',
            'REVOKE INSERT ON TABLE "acme"."totals_m" FROM "app_user"',
        ]);
        expect(compareAppPrivileges(state, target([{ schema: 'acme', table: 'imported', privileges: ['select'] }]), { app: APP }).drift).toEqual([
            drift('imported', { missing: ['select'] }),
            drift('ledger_v', { kind: 'view', excess: ['insert', 'update', 'delete'] }),
            drift('notes_iv', { kind: 'view', missing: ['insert', 'update', 'delete'], excess: ['truncate'] }),
            drift('notes_rv', { kind: 'view', excess: ['insert', 'update', 'delete'] }),
            drift('notes_tv', { kind: 'view', excess: ['insert', 'update', 'delete'] }),
            drift('totals_m', { kind: 'materialized view', excess: ['insert'] }),
        ]);
    });

    it('G20 db status reports as drift exactly what the plan changes for the app role and PUBLIC; what it holds another way apart', () =>
    {
        const state = catalog([
            table('ledger', [...toApp('select'), { grantee: APP, grantor: OWNER, privilege: 'insert', grantable: true }, { grantee: 'staff', grantor: OWNER, privilege: 'truncate' }],
                [{ column: 'amount', grantee: APP, grantor: OWNER, privilege: 'update' }]),
            sequence('ledger_id_seq'),
            table('notes', [...DEFAULT_TO_APP, { grantee: null, grantor: OWNER, privilege: 'select' }]),
            ownedBy(APP, 'mine', [{ grantee: null, grantor: APP, privilege: 'insert' }]),
        ], {
            roles: [{ name: APP, inheritsOwner: false, memberOf: ['staff'] }],
            schemas: [schemaRow('acme', APP, { usage: false, mayGrant: false })],
        });
        const declared = target([appendOnly, { schema: 'acme', table: 'mine', privileges: 'default' }]);
        const status = compareAppPrivileges(state, declared, { app: APP });
        const plan = planAppPrivileges(state, declared, { app: APP });

        expect(status.drift).toEqual([
            drift('ledger', { grantOption: ['insert'], columns: ['update (amount)'] }),
            drift('ledger_id_seq', { kind: 'sequence', missing: ['usage'] }),
            drift('notes', { grantee: null, excess: ['select'] }),
        ]);
        expect(status.schemasWithoutUsage).toEqual(['acme']);
        expect(status.heldElsewhere).toEqual([{ schema: 'acme', table: 'ledger', privilege: 'truncate', through: 'member of staff' }]);
        expect({ ownedTables: status.ownedTables, checkedTables: status.checkedTables }).toEqual({ ownedTables: 1, checkedTables: 2 });
        expect(plan.statements).toEqual([
            'REVOKE GRANT OPTION FOR INSERT ON TABLE "acme"."ledger" FROM "app_user"',
            'REVOKE UPDATE ("amount") ON TABLE "acme"."ledger" FROM "app_user"',
            'GRANT USAGE ON SEQUENCE "acme"."ledger_id_seq" TO "app_user"',
            'REVOKE SELECT ON TABLE "acme"."notes" FROM PUBLIC',
        ]);
    });

    it('G21 a relation a planned role owns, or whose owner it inherits, is outside the plan for every grantee, PUBLIC and the read role included, and status compares nothing on it', () =>
    {
        const READ = 'app_read';
        const state = catalog([
            ownedBy(APP, 'mine', [{ grantee: null, grantor: APP, privilege: 'delete' }, { grantee: null, grantor: 'staff', privilege: 'truncate' }]),
            ownedBy('owners', 'shared', [{ grantee: APP, grantor: 'owners', privilege: 'truncate', grantable: true }]),
            table('notes', DEFAULT_TO_APP),
        ], {
            roles: [{ name: APP, inheritsOwner: false, memberOf: ['owners'] }, { name: READ, inheritsOwner: false, memberOf: [] }],
            schemas: [schemaRow('acme'), schemaRow('acme', READ)],
        });
        const plan = planAppPrivileges(state, target(), { app: APP, read: READ });
        const status = compareAppPrivileges(state, target(), { app: APP, read: READ });

        expect(plan.blocked).toBe(false);
        expect(plan.statements).toEqual(['GRANT SELECT ON TABLE "acme"."notes" TO "app_read"']);
        expect(plan.ownedRelations).toEqual([
            { role: APP, schema: 'acme', name: 'mine', kind: 'table' },
            { role: APP, schema: 'acme', name: 'shared', kind: 'table' },
        ]);
        expect([plan.publicGrantsByOthers, plan.heldElsewhere, plan.grantsByOthers]).toEqual([[], [], []]);
        expect(status.drift).toEqual([]);
        expect(status.publicGrantsByOthers).toEqual([]);
        expect({ ownedTables: status.ownedTables, checkedTables: status.checkedTables }).toEqual({ ownedTables: 2, checkedTables: 1 });
    });

    it('G22 a grant to PUBLIC from another grantor than the owner blocks the plan, and status lists it with the REVOKE its grantor runs', () =>
    {
        const state = catalog([table('notes', [
            ...DEFAULT_TO_APP,
            { grantee: 'staff', grantor: OWNER, privilege: 'truncate', grantable: true },
            { grantee: null, grantor: 'staff', privilege: 'truncate' },
        ])]);
        const plan = planAppPrivileges(state, target(), { app: APP });
        const status = compareAppPrivileges(state, target(), { app: APP });

        expect(plan.blocked).toBe(true);
        expect(plan.statements).toEqual([]);
        expect(status.drift).toEqual([]);
        expect(status.publicGrantsByOthers).toEqual([
            { schema: 'acme', table: 'notes', privilege: 'truncate', grantor: 'staff', statement: 'REVOKE TRUNCATE ON TABLE "acme"."notes" FROM PUBLIC' },
        ]);
    });

    it('G23 what the app holds as a member of the read role, which the plan revokes from the read role, is drift through it, not held elsewhere', () =>
    {
        const READ = 'app_read';
        const state = catalog([table('notes', [
            ...DEFAULT_TO_APP,
            { grantee: READ, grantor: OWNER, privilege: 'select' },
            { grantee: READ, grantor: OWNER, privilege: 'truncate' },
        ])], {
            roles: [{ name: APP, inheritsOwner: false, memberOf: [READ] }, { name: READ, inheritsOwner: false, memberOf: [] }],
            schemas: [schemaRow('acme'), schemaRow('acme', READ)],
        });
        const plan = planAppPrivileges(state, target(), { app: APP, read: READ });
        const status = compareAppPrivileges(state, target(), { app: APP, read: READ });

        expect(plan.statements).toEqual(['REVOKE TRUNCATE ON TABLE "acme"."notes" FROM "app_read"']);
        expect(plan.heldElsewhere).toEqual([]);
        expect(status.drift).toEqual([drift('notes', { grantee: READ, through: `member of ${READ}`, excess: ['truncate'] })]);
        expect(status.heldElsewhere).toEqual([]);
    });

    it('G24 CREATE on a managed schema and the grant option of USAGE, from its owner, are revoked, and status agrees; from another grantor or a group role, reported', () =>
    {
        const toAppOnSchema = (privilege: string, grantor = OWNER) => ({ grantee: APP, grantor, privilege, grantable: true });
        const passedOn = { grantee: 'auditor', grantor: APP, privilege: 'create' };
        const acme = schemaRow('acme', APP, { grants: [...schemaRow('acme').grants, toAppOnSchema('usage'), toAppOnSchema('create'), passedOn] });
        const shared = schemaRow('shared', APP, { grants: [...schemaRow('shared').grants, toAppOnSchema('create', 'delegate'), { grantee: 'staff', grantor: OWNER, privilege: 'create' }] });
        const state = catalog([table('notes', DEFAULT_TO_APP)], { schemas: [acme, shared], roles: [{ name: APP, inheritsOwner: false, memberOf: ['staff'] }] });
        const plan = planAppPrivileges(state, target([], ['acme', 'shared']), { app: APP });
        const status = compareAppPrivileges(state, target([], ['acme', 'shared']), { app: APP });

        expect(plan.statements).toEqual([
            'REVOKE CREATE ON SCHEMA "acme" FROM "app_user"',
            'REVOKE GRANT OPTION FOR USAGE ON SCHEMA "acme" FROM "app_user"',
        ]);
        expect(plan.schemaHeldElsewhere).toEqual([
            { role: APP, schema: 'shared', privilege: 'create', through: 'granted by delegate' },
            { role: APP, schema: 'shared', privilege: 'create', through: 'member of staff' },
        ]);
        expect(plan.grantsByOthers).toEqual([
            { statement: 'REVOKE CREATE ON SCHEMA "acme" FROM "app_user"', schema: 'acme', grants: [{ ...passedOn, grantable: false }] },
        ]);
        expect(status.schemaDrift).toEqual([{ schema: 'acme', grantee: APP, through: null, excess: ['create'], grantOption: ['usage'] }]);
        expect(status.schemaHeldElsewhere).toHaveLength(2);
    });

    it('G25 a schema the app role alone owns is outside the plan, and status compares nothing on it', () =>
    {
        const appOwned = { owner: APP, grants: [{ grantee: APP, grantor: APP, privilege: 'create', grantable: true }, { grantee: null, grantor: APP, privilege: 'create' }] };
        const state = catalog([table('notes', DEFAULT_TO_APP)], { schemas: [schemaRow('acme', APP, appOwned)] });
        const plan = planAppPrivileges(state, target([], ['acme']), { app: APP });
        const status = compareAppPrivileges(state, target([], ['acme']), { app: APP });

        expect(plan.statements).toEqual([]);
        expect(plan.ownedSchemas).toEqual([{ role: APP, schema: 'acme' }]);
        expect([plan.schemaChanges, plan.schemaHeldElsewhere, plan.withoutUsage]).toEqual([[], [], []]);
        expect([status.schemaDrift, status.ownedSchemas]).toEqual([[], ['acme']]);
    });

    it('G26 PUBLIC\'s CREATE from the owner is revoked on a managed schema and left on public, which publicMayCreateInPublic reports; another grantor\'s is reported', () =>
    {
        const toPublic = (grantor = OWNER) => ({ grantee: null, grantor, privilege: 'create' });
        const state = catalog([table('notes', DEFAULT_TO_APP)], {
            schemas: [
                schemaRow('acme', APP, { grants: [...schemaRow('acme').grants, toPublic(), toPublic('delegate')] }),
                schemaRow('public', APP, { grants: [...schemaRow('public').grants, toPublic()] }),
            ],
            publicMayCreateInPublic: true,
        });
        const plan = planAppPrivileges(state, target([], ['acme', 'public']), { app: APP });

        expect(plan.statements).toEqual(['REVOKE CREATE ON SCHEMA "acme" FROM PUBLIC']);
        expect(plan.schemaHeldElsewhere).toEqual([{ role: APP, schema: 'acme', privilege: 'create', through: 'granted to PUBLIC by delegate' }]);
        expect(compareAppPrivileges(state, target([], ['acme', 'public']), { app: APP }).schemaDrift)
            .toEqual([{ schema: 'acme', grantee: null, through: null, excess: ['create'], grantOption: [] }]);
    });

    it('G27 on a schema the read role owns, the app is planned as on any schema: USAGE granted, or blocked when the owner may not grant, PUBLIC\'s CREATE revoked; status reports it', () =>
    {
        const READ = 'app_read';
        const readOwned = { owner: READ, grants: [{ grantee: READ, grantor: READ, privilege: 'create', grantable: true }] };
        const ledger = { ...readOwned, grants: [...readOwned.grants, { grantee: null, grantor: READ, privilege: 'create' }] };
        const state = (mayGrant: boolean) => catalog([table('notes', [...DEFAULT_TO_APP, { grantee: READ, grantor: OWNER, privilege: 'select' }])], {
            roles: [{ name: APP, inheritsOwner: false, memberOf: [] }, { name: READ, inheritsOwner: false, memberOf: [] }],
            schemas: [
                schemaRow('acme', APP, { ...readOwned, usage: false, mayGrant }), schemaRow('acme', READ, { ...readOwned, mayGrant }),
                schemaRow('ledger', APP, { ...ledger, mayGrant }), schemaRow('ledger', READ, { ...ledger, mayGrant }),
            ],
        });
        const roles = { app: APP, read: READ };
        const plan = planAppPrivileges(state(true), target([], ['acme', 'ledger']), roles);
        const refused = planAppPrivileges(state(false), target([], ['acme', 'ledger']), roles);
        const status = compareAppPrivileges(state(true), target([], ['acme', 'ledger']), roles);

        expect(plan.statements).toEqual(['GRANT USAGE ON SCHEMA "acme" TO "app_user"', 'REVOKE CREATE ON SCHEMA "ledger" FROM PUBLIC']);
        expect(plan.ownedSchemas).toEqual([{ role: READ, schema: 'acme' }, { role: READ, schema: 'ledger' }]);
        expect([refused.blocked, refused.statements, refused.ungrantableSchemas]).toEqual([true, [], [{ schema: 'acme', role: APP }]]);
        expect([status.schemasWithoutUsage, status.schemaDrift.map(entry => [entry.schema, entry.grantee]), status.ownedSchemas]).toEqual([['acme'], [['ledger', null]], []]);
    });

    it('G28 on a schema the app role owns, with a read role planned, what the read role holds from another grantor is held elsewhere and what the app holds is not', () =>
    {
        const READ = 'app_read';
        const fromDelegate = (grantee: string) => ({ grantee, grantor: 'delegate', privilege: 'create' });
        const appOwned = { owner: APP, grants: [{ grantee: APP, grantor: APP, privilege: 'create', grantable: true }, fromDelegate(APP), fromDelegate(READ)] };
        const state = catalog([table('notes', DEFAULT_TO_APP)], {
            roles: [{ name: APP, inheritsOwner: false, memberOf: [] }, { name: READ, inheritsOwner: false, memberOf: [] }],
            schemas: [schemaRow('acme', APP, appOwned), schemaRow('acme', READ, appOwned)],
        });
        const roles = { app: APP, read: READ };

        expect(planAppPrivileges(state, target([], ['acme']), roles).schemaHeldElsewhere)
            .toEqual([{ role: READ, schema: 'acme', privilege: 'create', through: 'granted by delegate' }]);
        expect(compareAppPrivileges(state, target([], ['acme']), roles).schemaHeldElsewhere).toEqual([]);
    });
});
