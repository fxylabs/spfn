/**
 * Column lists in `appPrivileges` (#460) — the declaration, its manifest, and
 * what a manifest of the previous format still plans — no database
 *
 * Each row names what would go unnoticed without it:
 * - K1 a column list on a privilege PostgreSQL grants table-wide only
 *   (`delete`), an empty list, a value other than `true` or a list, or a
 *   property the table does not have — a renamed one — accepted where it is
 *   written: the table declares less than it says (an empty list grants
 *   nothing), or `spfn db generate` writes what PostgreSQL refuses at grant
 *   time. The type rows fail `tsc` when the type accepts them.
 * - K2 the manifest recording property names (`messageId`) where PostgreSQL
 *   needs column names (`message_id`), or calling a file with column lists
 *   version 1, which a reader of version 1 reads without its column lists — so
 *   an older CLI revokes the column grant, or grants nothing, without a word.
 * - K3 a manifest written by 0.4.0-beta.4 planned differently now: its bytes
 *   and its plan against a fixture taken from main before the change, so a
 *   project that declares no column list sees no change at all.
 * - K4 the read role given SELECT on the whole table where the app may read
 *   only some of its columns, or nothing where it may read them.
 * - K5 a version 2 file whose column lists are malformed — a list on
 *   `delete`, an empty or unsorted list, a privilege both table-level and on
 *   columns — read as a declaration.
 * - K6 an `insert` or `update` list drizzle's own statements cannot keep to
 *   accepted: the issue's declaration on a `timestamps()` table, whose every
 *   drizzle `update()` also sets `updated_at`, or an `insert` list leaving out
 *   a column drizzle's `insert()` names — `db generate`, `db grant` and `db
 *   status` all pass, and the app's first write is a 42501 in production; or
 *   the exception wrong — a GENERATED ALWAYS column, which drizzle never
 *   names, demanded, or a BY DEFAULT identity, which it does, let off.
 * - K7 a declared column grant the app holds as a member of a group, or from
 *   another grantor, reported as "beyond its declaration" — by `db grant` and
 *   `db status` alike — while an undeclared one held so goes unreported.
 * - K8 (rv462b Codex) a declared column absent from a table the app role owns,
 *   or whose owner it inherits: not found, so a one-role project's `db status`
 *   says nothing of it and the step is not blocked, where it is for a table
 *   the app does not own.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { integer, pgSchema, pgTable, serial, text } from 'drizzle-orm/pg-core';

import { timestamps } from '../../schema/entity-helper';

import { appPrivileges, AppPrivilegesError } from '../declaration';
import { APP_PRIVILEGES_MANIFEST_FILE, AppPrivilegesManifestError, readAppPrivilegesManifest, renderAppPrivilegesManifest } from '../manifest';
import { planAppPrivileges, type AppPrivilegesTarget, type CatalogRelation, type PrivilegeCatalog } from '../plan';

const FIXTURE = join(__dirname, 'fixtures', 'manifest-v1');

const outbox = () => pgTable('outbox', { id: serial('id').primaryKey(), status: text('status'), messageId: text('message_id'), body: text('body') });

describe('appPrivileges refuses a column list that cannot stand (K1)', () =>
{
    it.each([
        // @ts-expect-error -- DELETE has no column form: a list there is a type error
        ['a list on delete', () => appPrivileges(outbox(), { select: true, delete: ['status'] }), /delete takes no column list: PostgreSQL grants DELETE on the whole table only/],
        ['an empty list', () => appPrivileges(outbox(), { select: true, update: [] }), /update lists no column/],
        // @ts-expect-error -- `false` is no declaration: leave the privilege out
        ['false', () => appPrivileges(outbox(), { select: true, update: false }), /update: false is neither true nor a list of columns/],
        // @ts-expect-error -- a property the table does not have (renamed from `messageId`)
        ['a property the table does not have', () => appPrivileges(outbox(), { update: ['status', 'msgId'] }), /no column property "msgId"; its columns: id, status, messageId, body/],
        ['the column name instead of the property', () => appPrivileges(outbox(), { update: ['message_id' as 'messageId'] }), /no column property "message_id"/],
        ['an object naming nothing', () => appPrivileges(outbox(), {}), /declares no privileges/],
    ])('%s', (_case, attempt, message) =>
    {
        expect(attempt).toThrow(AppPrivilegesError);
        expect(attempt).toThrow(message);
        expect(attempt).toThrow(/^appPrivileges\(public\.outbox\)/);
    });
});

describe('appPrivileges refuses a list drizzle\'s statements cannot keep to (K6)', () =>
{
    const stamped = () => pgTable('outbox', {
        id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
        seq: integer('seq').generatedByDefaultAsIdentity(),
        status: text('status'),
        shout: text('shout').generatedAlwaysAs(sql`upper(status)`),
        ...timestamps(),
    });

    it('an update list without the $onUpdate column', () =>
    {
        expect(() => appPrivileges(stamped(), { select: true, insert: true, update: ['status'] }))
            .toThrow(/^appPrivileges\(public\.outbox\): update leaves out updatedAt: drizzle's update\(\) sets each column with \$onUpdate .* refused \(42501\)/);
    });

    it('an insert list without a column drizzle\'s insert() names: every one but a GENERATED ALWAYS one', () =>
    {
        expect(() => appPrivileges(stamped(), { select: true, insert: ['status'] }))
            .toThrow(/^appPrivileges\(public\.outbox\): insert leaves out seq, createdAt, updatedAt: drizzle's insert\(\) names every column but a GENERATED ALWAYS one/);
    });

    it('accepts lists naming what drizzle sends', () =>
    {
        expect(() => appPrivileges(stamped(), { select: true, insert: ['seq', 'status', 'createdAt', 'updatedAt'], update: ['status', 'updatedAt'] })).not.toThrow();
    });
});

describe('the manifest records column names, as version 2 (K2)', () =>
{
    it('maps each property to its column, sorted, beside the table-level list', () =>
    {
        const text = renderAppPrivilegesManifest([appPrivileges(outbox(), { select: true, insert: true, update: ['status', 'messageId', 'status'] })]);
        const manifest = JSON.parse(text);

        expect(manifest.version).toBe(2);
        expect(manifest.tables).toEqual([
            { schema: 'public', table: 'outbox', privileges: ['select', 'insert'], columns: { update: ['message_id', 'status'] } },
        ]);
    });

    it('reads back what it wrote', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'spfn-privileges-'));

        try
        {
            const file = join(dir, APP_PRIVILEGES_MANIFEST_FILE);

            writeFileSync(file, renderAppPrivilegesManifest([appPrivileges(outbox(), { select: ['id', 'status'], update: ['status'] })]));

            expect(readAppPrivilegesManifest(file).tables).toEqual([
                { schema: 'public', table: 'outbox', privileges: [], columns: { select: ['id', 'status'], update: ['status'] } },
            ]);
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('a manifest of the previous format plans exactly what it did (K3)', () =>
{
    const acme = pgSchema('acme');
    const declarations = () => [
        appPrivileges(acme.table('outbox', { id: serial('id').primaryKey(), status: text('status'), messageId: text('message_id') }), { select: true, insert: true }),
        appPrivileges(acme.table('ledger', { id: serial('id').primaryKey(), amount: integer('amount') }), ['select', 'insert', 'references']),
        acme.table('notes', { id: serial('id').primaryKey(), body: text('body') }),
    ];

    it('the same declarations are written as the same bytes, version 1', () =>
    {
        expect(renderAppPrivilegesManifest(declarations())).toBe(readFileSync(join(FIXTURE, 'privileges.json'), 'utf8'));
    });

    it('its plan is main\'s, byte for byte; the column fields it adds are empty', () =>
    {
        const manifest = readAppPrivilegesManifest(join(FIXTURE, 'privileges.json'));
        const target: AppPrivilegesTarget = {
            schemas: ['acme', 'drizzle'],
            tables: manifest.tables.map(entry => ({ ...entry, privileges: entry.privileges === 'default' ? manifest.default : entry.privileges })),
            defaults: manifest.default,
        };
        const catalog = JSON.parse(readFileSync(join(FIXTURE, 'catalog.json'), 'utf8')) as PrivilegeCatalog;
        const plan = planAppPrivileges(catalog, target, { app: 'app_user', read: 'app_read' });
        const { absentColumns, ...planned } = plan;
        const added = [...absentColumns, ...plan.changes.flatMap(change => [...change.missingColumns, ...change.columnGrantOption])];
        const asOnMain = { ...planned, changes: plan.changes.map(({ missingColumns: _granted, columnGrantOption: _option, ...change }) => change) };

        expect(added).toEqual([]);
        expect(`${JSON.stringify(asOnMain, null, 4)}\n`).toBe(readFileSync(join(FIXTURE, 'plan.json'), 'utf8'));
    });
});

describe('the read role and column lists (K4)', () =>
{
    const OWNER = 'app_owner';
    const relation = (name: string, facts: Partial<CatalogRelation> = {}): CatalogRelation => ({
        schema: 'acme', name, kind: 'table', partition: false, owner: OWNER,
        grants: [{ grantee: OWNER, grantor: OWNER, privilege: 'select' }], columnGrants: [], columns: ['id', 'status', 'body'], ...facts,
    });
    const catalog: PrivilegeCatalog = {
        roles: [{ name: 'app_user', inheritsOwner: false, memberOf: [] }, { name: 'app_read', inheritsOwner: false, memberOf: [] }],
        missingRoles: [],
        schemas: [],
        relations: [relation('outbox'), relation('outbox_2026', { partition: true })],
        foreignOwned: [],
        publicMayCreateInPublic: false,
    };
    const columns = { select: ['id', 'status'], update: ['status'] };

    it('gets the app\'s SELECT column list, never its other lists; a partition gets none', () =>
    {
        const target: AppPrivilegesTarget = {
            schemas: ['acme'],
            tables: [
                { schema: 'acme', table: 'outbox', privileges: ['insert'], columns },
                { schema: 'acme', table: 'outbox_2026', privileges: ['insert'], columns },
            ],
            defaults: [],
        };

        expect(planAppPrivileges(catalog, target, { app: 'app_user', read: 'app_read' }).statements).toEqual([
            'GRANT INSERT ON TABLE "acme"."outbox" TO "app_user"',
            'GRANT SELECT ("id", "status") ON TABLE "acme"."outbox" TO "app_user"',
            'GRANT UPDATE ("status") ON TABLE "acme"."outbox" TO "app_user"',
            'GRANT SELECT ("id", "status") ON TABLE "acme"."outbox" TO "app_read"',
        ]);
    });
});

describe('a column grant held another way is beyond the declaration only when undeclared (K7)', () =>
{
    const OWNER = 'app_owner';
    const grant = (column: string, grantee: string, grantor = OWNER) => ({ column, grantee, grantor, privilege: 'update' });
    const catalog: PrivilegeCatalog = {
        roles: [{ name: 'app_user', inheritsOwner: false, memberOf: ['app_group'] }],
        missingRoles: [],
        schemas: [],
        relations: [{
            schema: 'acme', name: 'outbox', kind: 'table', partition: false, owner: OWNER,
            grants: [{ grantee: OWNER, grantor: OWNER, privilege: 'select' }, { grantee: 'app_user', grantor: OWNER, privilege: 'select' }],
            columnGrants: [grant('status', 'app_user'), grant('status', 'app_group'), grant('status', 'app_user', 'other_owner'), grant('body', 'app_group')],
            columns: ['id', 'status', 'body'],
        }],
        foreignOwned: [],
        publicMayCreateInPublic: false,
    };
    const target: AppPrivilegesTarget = {
        schemas: ['acme'],
        tables: [{ schema: 'acme', table: 'outbox', privileges: ['select'], columns: { update: ['status'] } }],
        defaults: [],
    };

    it('the group\'s and the other grantor\'s UPDATE (status) are not reported; the group\'s UPDATE (body) is', () =>
    {
        expect(planAppPrivileges(catalog, target, { app: 'app_user' }).heldElsewhere).toEqual([
            { role: 'app_user', schema: 'acme', name: 'outbox', privilege: 'update (body)', through: 'member of app_group' },
        ]);
    });
});

describe('a declared column the table does not have is found whoever owns the table (K8)', () =>
{
    const catalog = (owner: string, inheritsOwner: boolean): PrivilegeCatalog => ({
        roles: [{ name: 'app_user', inheritsOwner, memberOf: [] }],
        missingRoles: [],
        schemas: [],
        relations: [{
            schema: 'acme', name: 'outbox', kind: 'table', partition: false, owner,
            grants: [{ grantee: owner, grantor: owner, privilege: 'select' }], columnGrants: [], columns: ['id'],
        }],
        foreignOwned: [],
        publicMayCreateInPublic: false,
    });
    const target: AppPrivilegesTarget = {
        schemas: ['acme'],
        tables: [{ schema: 'acme', table: 'outbox', privileges: [], columns: { update: ['status'] } }],
        defaults: [],
    };

    it.each([
        ['the app role owns it', catalog('app_user', false)],
        ['the app role inherits its owner', catalog('app_owner', true)],
    ])('%s: absent and blocking', (_state, owned) =>
    {
        const plan = planAppPrivileges(owned, target, { app: 'app_user' });

        expect(plan.absentColumns).toEqual([{ schema: 'acme', table: 'outbox', columns: ['status'] }]);
        expect(plan.blocked).toBe(true);
    });
});

describe('readAppPrivilegesManifest refuses malformed column lists (K5)', () =>
{
    let dir: string;
    let file: string;

    beforeEach(() =>
    {
        dir = mkdtempSync(join(tmpdir(), 'spfn-privileges-'));
        file = join(dir, APP_PRIVILEGES_MANIFEST_FILE);
    });

    afterEach(() =>
    {
        rmSync(dir, { recursive: true, force: true });
    });

    it.each([
        ['a list on delete', { privileges: ['select'], columns: { delete: ['status'] } }],
        ['an empty list', { privileges: ['select'], columns: { update: [] } }],
        ['an unsorted list', { privileges: ['select'], columns: { update: ['status', 'message_id'] } }],
        ['a privilege both table-level and on columns', { privileges: ['select', 'update'], columns: { update: ['status'] } }],
        ['no privilege at all', { privileges: [], columns: {} }],
        ['column lists on "default"', { privileges: 'default', columns: { update: ['status'] } }],
    ])('%s', (_case, entry) =>
    {
        writeFileSync(file, JSON.stringify({ version: 2, default: ['select', 'insert', 'update', 'delete'], tables: [{ schema: 'app', table: 'outbox', ...entry }] }));

        expect(() => readAppPrivilegesManifest(file)).toThrow(AppPrivilegesManifestError);
        expect(() => readAppPrivilegesManifest(file)).toThrow(/table entry 0 is malformed/);
    });
});
