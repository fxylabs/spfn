/**
 * The app privileges step against a real PostgreSQL, two roles (#405)
 *
 * The owner is TEST_DATABASE_URL; the app role is TEST_APP_DATABASE_URL, or
 * the other role scripts/test-services.sh creates. A scratch app — schema
 * i405d_grant with `notes` (the default set) and `ledger` (declared
 * `['select', 'insert']`), and the fake function package @spfn/i163fix whose
 * manifest declares `spfn_i163fix.things` `['select']` — is pushed, migrated,
 * added or granted, and each row asserts what the app role holds
 * (`has_table_privilege`, which counts every path) and what a statement it
 * sends is allowed to do. What each row keeps from passing unnoticed:
 *
 * - P1 (B1, C1) after push the app cannot use a table, its sequence or the
 *   bookkeeping it reads; it can write the bookkeeping; an append-only
 *   declaration is lost when the table is created again;
 * - P2 (C2) a widened or narrowed declaration not taking effect on the next push;
 * - P3 (B2) a second run that issues statements again;
 * - P4 (B3) a grant-only step: a hand TRUNCATE, a column UPDATE or a PUBLIC
 *   DELETE surviving the step;
 * - P5 (B4) a table the owner cannot grant on, skipped with PostgreSQL's
 *   warning and a zero exit;
 * - P6 (B5, B6) statements issued with one role, or for an app that is the owner;
 * - P7 (B8) a dry run that grants — its statements run, so one that does not
 *   roll back — or prints no roles or plan;
 * - P8 (C3) migrate needing the entities, or ignoring the project manifest;
 * - P9 (C4) a function package's manifest left out of migrate and add;
 * - P10 a lost restriction or a missing grant — through any path, PUBLIC's
 *   included — invisible to `db status` and to Kit, which reads its `--json`;
 *   which declaration status read (a manifest left behind decides) unsaid;
 * - P11 (rv428 B1) a partition given the default set: the app writes to a
 *   select-only parent, and reads past its row-level security, through it;
 * - P12 (rv428 B2) on a project that only pushes, the `spfn db grant` a
 *   failed step advises seeing no project table and saying ✅, or not saying
 *   it read the entities;
 * - P13 with no manifest and no entity to load, `db grant` saying "nothing to
 *   change" and `db status` "holds what is declared"; migrate loading source;
 * - P14 (rv428 B3, rv428e B1) a grant the app passed on: PostgreSQL's 2BP01
 *   swallowed, or the statements before it applied (a partial apply), or the
 *   refused statement and the app's grant unnamed; a declared privilege kept
 *   WITH GRANT OPTION once that grant is gone, or the run not converging;
 * - P14b the same through `db grant --dry-run`: a dry run that changes the
 *   database, or does not report the refusal;
 * - P15 a DATABASE_APP_ROLE that names no role: a raw 42704, or a skipped step
 *   and exit 0, instead of the setting and the role named;
 * - P16 (rv428 R8) a view or materialized view of a managed schema left
 *   ungranted — the app gets 42501 where the hand SQL this replaces gave it
 *   access; a write on a view that runs with its owner's rights kept, or not
 *   reported by `db status`;
 * - P17 (rv428b X4, X4b) through such a view, the app updating or deleting
 *   rows of an append-only table, or inserting into a select-only one;
 * - P18 a `security_invoker` view held to SELECT, or written through past
 *   its table's declaration; its option read by its text, not as PostgreSQL
 *   reads it (`on`, `1`, `off`);
 * - P19 (rv428c B1) a `security_invoker` view with a DO INSTEAD rule or an
 *   INSTEAD OF trigger given the default set: the app inserts into a
 *   select-only table through it, with the view owner's rights;
 * - P20 (rv428 RV1) a declared privilege the app holds WITH GRANT OPTION — it
 *   can pass it on — read by `db status` as "holds what is declared", and
 *   missing from `--json`, while `db grant` revokes the option;
 * - P21 a column grant beyond the declaration, invisible to
 *   `has_table_privilege`, read by status as clean likewise;
 * - P23 (rv428i B1, N3) a single-role project — the app owns its tables —
 *   with a grant to PUBLIC on one: status reporting drift that `db grant`,
 *   without an owner URL or with the app's, never acts on, with or without a
 *   read role (the two-role setup's app role, read-only here); I1 never run
 *   where the app owns a relation or a read role is set;
 * - P22 (rv428i N1) a `DATABASE_READ_URL` that does not answer reported as
 *   the database being unreachable, unnamed, and hiding the app role's result;
 * - P24 (#435) CREATE on a managed schema granted to the app role, and USAGE
 *   on `drizzle` WITH GRANT OPTION: `db status` reading them as clean, `db
 *   grant` keeping them — the app still creates, and so owns, tables there —
 *   or a second run issuing statements again;
 * - I1, checked in P3, P4, P10, P11, P14b, P16, P18-P21, P23, P24: status and `db grant
 *   --dry-run` disagreeing on any (relation or schema, grantee, privilege, kind) —
 *   status reporting what the step does not change, or missing what it does
 *   (a grant option, a column grant, a PUBLIC grant, a sequence or a
 *   partition passing as clean); compared entry by entry, so a disagreement
 *   on one table cannot hide behind another's.
 *
 * Skipped, with the reason, where the app role cannot connect; a failure under
 * CI. Each row works in its own schemas and drops them, with every grant on
 * them; no role is created or altered, no default privilege set.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import postgres from 'postgres';

import { appUrl, OWNER_URL, requireDatabase, twoRoleUnavailability } from './helpers/test-database.js';
import { writeFunctionPackage } from './helpers/function-package.js';

const { dbPush } = await import('../push.js');
const { dbMigrate } = await import('../migrate.js');
const { dbGrant } = await import('../grant.js');
const { addCommand } = await import('../../add.js');
const { dbStatus, DB_STATUS_JSON_MARKER } = await import('../status.js');

const SCHEMAS = ['i405d_grant', 'spfn_i163fix', 'drizzle'];
const PACKAGE_SQL = 'CREATE SCHEMA spfn_i163fix;\n--> statement-breakpoint\nCREATE TABLE spfn_i163fix.things (id serial PRIMARY KEY);\n';
const PROJECT_SQL = 'CREATE SCHEMA i405d_grant;\n--> statement-breakpoint\n'
    + 'CREATE TABLE i405d_grant.notes (id serial PRIMARY KEY, body text);\n--> statement-breakpoint\n'
    + 'CREATE TABLE i405d_grant.ledger (id serial PRIMARY KEY, amount integer);\n';

/** A manifest as `spfn db generate` writes it. */
const manifest = (tables: { schema: string; table: string; privileges: string[] | 'default' }[]) => `${JSON.stringify({
    $comment: 'Generated from the entities\' appPrivileges() declarations. Do not edit: regenerate.',
    version: 1,
    default: ['select', 'insert', 'update', 'delete'],
    tables,
}, null, 4)}\n`;

describe('the app privileges step', () =>
{
    const owner = postgres(OWNER_URL, { max: 1, onnotice: () => undefined });
    const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
    let reachable = false;
    let twoRoles: string | undefined = 'beforeAll has not run';
    let appRole: string;
    let root: string;
    let previousCwd: string;
    let output: string[];

    beforeAll(async () =>
    {
        reachable = await requireDatabase(owner, 'app privileges integration tests');
        twoRoles = reachable ? await twoRoleUnavailability(owner, app) : 'PostgreSQL not available';
        appRole = twoRoles === undefined ? (await app`SELECT current_user AS role`)[0].role : '';
    });

    afterAll(async () =>
    {
        if (twoRoles === undefined)
        {
            await dropSchemas();
        }
        await Promise.all([owner.end(), app.end()]);
    });

    beforeEach(async ({ skip }) =>
    {
        skip(twoRoles !== undefined, twoRoles);

        await dropSchemas();
        root = mkdtempSync(join(__dirname, 'tmp-app-grants-'));
        previousCwd = process.cwd();
        process.chdir(root);
        output = [];
        process.env.DATABASE_URL = appUrl();
        process.env.DATABASE_OWNER_URL = OWNER_URL;
        for (const method of ['log', 'error'] as const)
        {
            vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void output.push(args.map(String).join(' ')));
        }
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);
    });

    afterEach(() =>
    {
        if (twoRoles !== undefined)
        {
            return;
        }

        process.chdir(previousCwd);
        delete process.env.DATABASE_URL;
        delete process.env.DATABASE_OWNER_URL;
        delete process.env.DATABASE_READ_URL;
        vi.restoreAllMocks();
        rmSync(root, { recursive: true, force: true });
    });

    async function dropSchemas(): Promise<void>
    {
        for (const schema of SCHEMAS)
        {
            await owner.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        }
    }

    let entityFile: string;

    /**
     * The entities push loads: `ledger` declares `ledgerPrivileges`. Each
     * declaration gets a file of its own, since a module is loaded once.
     */
    function writeEntities(ledgerPrivileges = "['select', 'insert']"): void
    {
        const entities = join(root, 'src', 'server', 'entities');

        entityFile = `./src/server/entities/grant-${ledgerPrivileges.replace(/\W+/g, '-')}.entity.ts`;
        mkdirSync(entities, { recursive: true });
        writeFileSync(join(root, entityFile),
            "import { pgSchema, serial, integer, text } from 'drizzle-orm/pg-core';\n"
            + "import { appPrivileges } from '@spfn/core/db';\n"
            + "export const grantSchema = pgSchema('i405d_grant');\n"
            + "export const notes = grantSchema.table('notes', { id: serial('id').primaryKey(), body: text('body') });\n"
            + `export const ledger = appPrivileges(grantSchema.table('ledger', { id: serial('id').primaryKey(), amount: integer('amount') }), ${ledgerPrivileges});\n`);
    }

    /** The function package, its migration creating `things`, its manifest declaring it read-only. */
    function writePackage(): void
    {
        writeFunctionPackage(root, '20260101000000_things', PACKAGE_SQL);
        writeFileSync(join(root, 'node_modules', '@spfn', 'i163fix', 'migrations', 'privileges.json'),
            manifest([{ schema: 'spfn_i163fix', table: 'things', privileges: ['select'] }]));
    }

    /** The project's migration and manifest, as `spfn db generate` leaves them; no entity file. */
    function writeProjectMigrations(sqlText = PROJECT_SQL, tables: Parameters<typeof manifest>[0] = [
        { schema: 'i405d_grant', table: 'ledger', privileges: ['select', 'insert'] },
        { schema: 'i405d_grant', table: 'notes', privileges: 'default' },
    ]): void
    {
        const folder = join(root, 'src', 'server', 'drizzle');

        mkdirSync(join(folder, '20260101000000_init'), { recursive: true });
        writeFileSync(join(folder, '20260101000000_init', 'migration.sql'), sqlText);
        writeFileSync(join(folder, 'privileges.json'), manifest(tables));
    }

    const push = (dryRun = false) => dbPush({ force: true, dryRun, schema: entityFile });

    /** Each privilege of `privileges` the app role holds on `table`, by any path. */
    async function held(table: string, privileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']): Promise<string[]>
    {
        const rows = await owner`
            SELECT p.privilege FROM unnest(${privileges}::text[]) AS p(privilege)
            WHERE has_table_privilege(${appRole}::name, ${table}::regclass, p.privilege)`;

        return rows.map(row => row.privilege);
    }

    /** The SQLSTATE `statement` fails with as the app role, or `ok`. */
    async function asApp(statement: string): Promise<string>
    {
        return app.unsafe(statement).then(() => 'ok', (error: { code?: string }) => error.code ?? 'error');
    }

    it('P1 after push the app uses every table and sequence as declared, reads the bookkeeping only, and an append-only table stays so when created again', async () =>
    {
        writeEntities();
        writePackage();

        await push();

        expect(await held('i405d_grant.notes')).toEqual(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
        expect(await held('i405d_grant.ledger')).toEqual(['SELECT', 'INSERT']);
        expect(await held('spfn_i163fix.things')).toEqual(['SELECT']);
        expect(await held('drizzle.__spfn_fn_i163fix_migrations')).toEqual(['SELECT']);
        expect(await asApp("INSERT INTO i405d_grant.notes (body) VALUES ('a')")).toBe('ok');
        expect(await asApp("UPDATE i405d_grant.notes SET body = 'b'")).toBe('ok');
        expect(await asApp('DELETE FROM i405d_grant.notes')).toBe('ok');
        expect(await asApp('INSERT INTO i405d_grant.ledger (amount) VALUES (1)')).toBe('ok');
        expect(await asApp('UPDATE i405d_grant.ledger SET amount = 2')).toBe('42501');
        expect(await asApp('SELECT * FROM spfn_i163fix.things')).toBe('ok');
        expect(await asApp('INSERT INTO spfn_i163fix.things DEFAULT VALUES')).toBe('42501');
        expect(await asApp('SELECT * FROM drizzle.__spfn_fn_i163fix_migrations')).toBe('ok');
        expect(await asApp("INSERT INTO drizzle.__spfn_fn_i163fix_migrations (hash) VALUES ('forged')")).toBe('42501');

        await owner.unsafe('DROP TABLE i405d_grant.ledger');
        await push();

        expect(await held('i405d_grant.ledger')).toEqual(['SELECT', 'INSERT']);
        expect(await asApp('UPDATE i405d_grant.ledger SET amount = 2')).toBe('42501');
    });

    it('P2 widening, then narrowing, a declaration takes effect on the next push', async () =>
    {
        writeEntities();
        await push();
        writeEntities("['select', 'insert', 'update']");
        await push();

        expect(await held('i405d_grant.ledger')).toEqual(['SELECT', 'INSERT', 'UPDATE']);
        expect(await asApp('UPDATE i405d_grant.ledger SET amount = 2')).toBe('ok');

        writeEntities("['select']");
        await push();

        expect(await held('i405d_grant.ledger')).toEqual(['SELECT']);
        expect(await asApp('INSERT INTO i405d_grant.ledger (amount) VALUES (1)')).toBe('42501');
    });

    it('P3 a second push issues no privilege statement', async () =>
    {
        writeEntities();
        writePackage();
        await push();
        output.length = 0;

        await push();

        expect(output.filter(line => /^\s*(GRANT|REVOKE) /.test(line))).toEqual([]);
        expect(output.join('\n')).toContain('match the declarations — nothing to change');
        await expectStatusAgreesWithDryRun();
    });

    it('P4 a hand TRUNCATE, a column UPDATE and a PUBLIC DELETE are revoked by the next run', async () =>
    {
        writeEntities();
        await push();
        await owner.unsafe(`GRANT TRUNCATE ON i405d_grant.notes TO "${appRole}"`);
        await owner.unsafe(`GRANT UPDATE (amount) ON i405d_grant.ledger TO "${appRole}"`);
        await owner.unsafe('GRANT DELETE ON i405d_grant.ledger TO PUBLIC');

        expect(await held('i405d_grant.notes')).toContain('TRUNCATE');
        expect(await held('i405d_grant.ledger')).toContain('DELETE');
        await expectStatusAgreesWithDryRun();

        await push();

        const [{ columnUpdate }] = await owner`SELECT has_any_column_privilege(${appRole}::name, 'i405d_grant.ledger'::regclass, 'UPDATE') AS "columnUpdate"`;

        expect(await held('i405d_grant.notes')).toEqual(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
        expect(await held('i405d_grant.ledger')).toEqual(['SELECT', 'INSERT']);
        expect(columnUpdate).toBe(false);
        expect(await asApp('TRUNCATE i405d_grant.notes')).toBe('42501');
        expect(await asApp('UPDATE i405d_grant.ledger SET amount = 3')).toBe('42501');
        expect(await asApp('DELETE FROM i405d_grant.ledger')).toBe('42501');
    });

    it('P5 a table of a managed schema the owner does not own: db grant exits 1 and names it, granting nothing', async () =>
    {
        writeProjectMigrations();
        await dbMigrate();
        await owner.unsafe(`REVOKE ALL ON i405d_grant.notes FROM "${appRole}"`);
        await owner.unsafe(`GRANT CREATE ON SCHEMA i405d_grant TO "${appRole}"`);
        await app.unsafe('CREATE TABLE i405d_grant.stray (id integer)');

        await expect(dbGrant()).rejects.toThrow('exit 1');

        expect(output.join('\n')).toContain(`❌ Privileges not applied: The owner cannot grant on table i405d_grant.stray (owner ${appRole})`);
        expect(await held('i405d_grant.notes')).toEqual([]);
    });

    it('P6 with no DATABASE_OWNER_URL, or the owner URL the app\'s role, push grants nothing and says why', async () =>
    {
        writeEntities();
        process.env.DATABASE_URL = OWNER_URL;
        delete process.env.DATABASE_OWNER_URL;

        await push();

        expect(output.join('\n')).toContain('DATABASE_OWNER_URL is not set, so the app connects as the role that owns the tables — nothing to grant, and row-level security does not apply to the app');
        expect(await held('i405d_grant.notes')).toEqual([]);

        output.length = 0;
        process.env.DATABASE_OWNER_URL = OWNER_URL;
        await push();

        expect(output.join('\n')).toContain('is the owner or inherits its privileges — nothing to grant and row-level security does not apply to it');
        expect(output.join('\n')).not.toContain('nothing to change');
        expect(output.filter(line => /^\s*(GRANT|REVOKE) /.test(line))).toEqual([]);
        expect(await held('i405d_grant.notes')).toEqual([]);
    });

    it('P7 db grant --dry-run and push --dry-run print the roles and the plan, and grant nothing', async () =>
    {
        writeEntities();
        await push(true);

        expect(output.join('\n')).toContain(`app role: ${appRole} (current_user of DATABASE_URL)`);
        expect(output.join('\n')).toContain('+ privileges for 2 new table(s)');
        expect((await owner`SELECT to_regnamespace('i405d_grant') AS schema`)[0].schema).toBe(null);

        writeProjectMigrations();
        delete process.env.DATABASE_OWNER_URL;
        process.env.DATABASE_URL = OWNER_URL;
        await dbMigrate();
        process.env.DATABASE_URL = appUrl();
        process.env.DATABASE_OWNER_URL = OWNER_URL;
        output.length = 0;

        await dbGrant({ dryRun: true });

        expect(output.join('\n')).toContain(`app role: ${appRole} (current_user of DATABASE_URL)`);
        expect(output.join('\n')).toContain(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "i405d_grant"."notes" TO "${appRole}";`);
        expect(output.join('\n')).toContain('Dry run: nothing was granted or revoked');
        expect(await held('i405d_grant.notes')).toEqual([]);
    });

    it('P8 migrate grants what the project manifest declares, with no entity file to load', async () =>
    {
        writeProjectMigrations();

        await dbMigrate();

        expect(await held('i405d_grant.notes')).toEqual(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
        expect(await held('i405d_grant.ledger')).toEqual(['SELECT', 'INSERT']);
        expect(await asApp("INSERT INTO i405d_grant.notes (body) VALUES ('a')")).toBe('ok');
        expect(await asApp('UPDATE i405d_grant.ledger SET amount = 2')).toBe('42501');
    });

    it('P9 migrate and spfn add apply a function package\'s own manifest', async () =>
    {
        writePackage();
        await dbMigrate();

        expect(await held('spfn_i163fix.things')).toEqual(['SELECT']);

        await dropSchemas();
        await addCommand.parseAsync(['@spfn/i163fix'], { from: 'user' });

        expect(await held('spfn_i163fix.things')).toEqual(['SELECT']);
        expect(await asApp('INSERT INTO spfn_i163fix.things DEFAULT VALUES')).toBe('42501');
    });

    it('P10 db status --json reports, as the app, what db grant would change for it and for PUBLIC', async () =>
    {
        writeProjectMigrations();
        await dbMigrate();
        await owner.unsafe('GRANT DELETE ON i405d_grant.ledger TO PUBLIC');
        await owner.unsafe(`REVOKE INSERT ON i405d_grant.notes FROM "${appRole}"`);
        output.length = 0;

        await dbStatus({ json: true });

        const line = output.find(entry => entry.startsWith(DB_STATUS_JSON_MARKER)) ?? '';
        const unchanged = { kind: 'table', through: null, missing: [], excess: [], grantOption: [], columns: [] };

        expect(JSON.parse(line.slice(DB_STATUS_JSON_MARKER.length)).privileges).toEqual({
            checked: true,
            source: 'manifest src/server/drizzle/privileges.json',
            checkedTables: 3,
            ownedTables: 0,
            drift: [
                { ...unchanged, schema: 'i405d_grant', table: 'ledger', grantee: null, excess: ['delete'] },
                { ...unchanged, schema: 'i405d_grant', table: 'notes', grantee: appRole, missing: ['insert'] },
            ],
            schemasWithoutUsage: [],
            schemaDrift: [],
            publicGrantsByOthers: [],
            heldElsewhere: [],
            schemaHeldElsewhere: [],
            ownedSchemas: [],
            publicMayCreateInPublic: false,
            readRole: { checked: true },
        });
        await expectStatusAgreesWithDryRun();
    });

    it('P11 a partition of a select-only parent: the app can neither write it directly nor read past the parent\'s policy, and status agrees', async () =>
    {
        writeProjectMigrations('CREATE SCHEMA i405d_grant;\n--> statement-breakpoint\n'
            + 'CREATE TABLE i405d_grant.events (tenant integer NOT NULL, body text) PARTITION BY LIST (tenant);\n--> statement-breakpoint\n'
            + 'CREATE TABLE i405d_grant.events_t1 PARTITION OF i405d_grant.events FOR VALUES IN (1);\n--> statement-breakpoint\n'
            + 'ALTER TABLE i405d_grant.events ENABLE ROW LEVEL SECURITY;\n--> statement-breakpoint\n'
            + 'CREATE POLICY none_visible ON i405d_grant.events USING (false);\n',
        [{ schema: 'i405d_grant', table: 'events', privileges: ['select'] }]);
        await dbMigrate();
        await owner.unsafe("INSERT INTO i405d_grant.events VALUES (1, 'secret')");

        expect(await asApp("INSERT INTO i405d_grant.events VALUES (1, 'x')")).toBe('42501');
        expect((await app.unsafe('SELECT count(*)::int AS n FROM i405d_grant.events'))[0].n).toBe(0);
        expect(await held('i405d_grant.events_t1')).toEqual([]);
        expect(await asApp('SELECT body FROM i405d_grant.events_t1')).toBe('42501');
        expect(await asApp("INSERT INTO i405d_grant.events_t1 VALUES (1, 'forged')")).toBe('42501');

        await owner.unsafe(`GRANT SELECT ON i405d_grant.events_t1 TO "${appRole}"`);
        output.length = 0;
        await dbStatus({ json: true });

        const line = output.find(entry => entry.startsWith(DB_STATUS_JSON_MARKER)) ?? '';

        expect(JSON.parse(line.slice(DB_STATUS_JSON_MARKER.length)).privileges.drift)
            .toEqual([{ schema: 'i405d_grant', table: 'events_t1', kind: 'table', grantee: appRole, through: null, missing: [], excess: ['select'], grantOption: [], columns: [] }]);
        await expectStatusAgreesWithDryRun();

        output.length = 0;
        process.env.DATABASE_OWNER_URL = OWNER_URL;
        await dbGrant();

        expect(output.join('\n')).toContain(`REVOKE SELECT ON TABLE "i405d_grant"."events_t1" FROM "${appRole}";`);
        expect(await held('i405d_grant.events_t1')).toEqual([]);
    });

    it('P12 push whose step fails says run spfn db grant; on a project that only pushes, that run grants the declared sets', async () =>
    {
        writeEntities();
        process.env.DATABASE_APP_ROLE = 'not_the_app_role';

        try
        {
            await expect(push()).rejects.toThrow('exit 1');
        }
        finally
        {
            delete process.env.DATABASE_APP_ROLE;
        }

        expect(output.join('\n')).toContain('Schema applied; no privilege was changed, so new tables have only what the database gives by default: '
            + 'DATABASE_APP_ROLE names the role not_the_app_role');
        expect(output.join('\n')).toContain('correct or remove DATABASE_APP_ROLE, then run spfn db grant');
        expect(await held('i405d_grant.notes')).toEqual([]);
        output.length = 0;

        await dbGrant();

        expect(output.join('\n')).toContain('The project\'s declarations: entities');
        expect(output.join('\n')).not.toContain('nothing to change');
        expect(await held('i405d_grant.notes')).toEqual(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
        expect(await held('i405d_grant.ledger')).toEqual(['SELECT', 'INSERT']);
    });

    it('P13 no manifest and no entity to load: db grant exits 1, db status reports the privileges unknown, migrate warns without loading source', async () =>
    {
        writeProjectMigrations();
        rmSync(join(root, 'src', 'server', 'drizzle', 'privileges.json'));
        await dbMigrate();

        expect(output.join('\n')).toContain('src/server/drizzle has no privileges.json');
        expect(await held('i405d_grant.notes')).toEqual([]);
        output.length = 0;

        await expect(dbGrant()).rejects.toThrow('exit 1');

        expect(output.join('\n')).toContain('❌ Privileges not applied: The project\'s tables cannot be seen: src/server/drizzle has no privileges.json, and no entity file was found');
        expect(output.join('\n')).not.toContain('nothing to change');
        output.length = 0;

        await dbStatus({ json: true });

        const line = output.find(entry => entry.startsWith(DB_STATUS_JSON_MARKER)) ?? '';
        const privileges = JSON.parse(line.slice(DB_STATUS_JSON_MARKER.length)).privileges;

        expect(privileges.checked).toBe(false);
        expect(privileges.detail).toContain('The project\'s tables cannot be seen');
    });

    /**
     * The app passes on SELECT of `notes`, which the owner gave it WITH GRANT
     * OPTION, to the owner role — the one other role two roles allow — and
     * holds a hand TRUNCATE on `ledger`, whose REVOKE runs before the refused one.
     */
    async function passOnSelect(): Promise<string>
    {
        writeProjectMigrations();
        await dbMigrate();
        const [{ role: ownerRole }] = await owner`SELECT current_user AS role`;

        await owner.unsafe(`GRANT TRUNCATE ON i405d_grant.ledger TO "${appRole}"`);
        await owner.unsafe(`GRANT SELECT ON i405d_grant.notes TO "${appRole}" WITH GRANT OPTION`);
        await app.unsafe(`GRANT SELECT ON i405d_grant.notes TO "${ownerRole}"`);
        output.length = 0;

        return ownerRole;
    }

    /** Whether the app role holds SELECT on `notes` with its grant option. */
    async function selectOption(): Promise<boolean>
    {
        const [{ option }] = await owner`SELECT has_table_privilege(${appRole}::name, 'i405d_grant.notes'::regclass, 'SELECT WITH GRANT OPTION') AS option`;

        return option;
    }

    it('P14 a grant the app passed on: PostgreSQL refuses the REVOKE, nothing is changed, the statement and the grant are named; once the app revokes it the run converges', async () =>
    {
        const ownerRole = await passOnSelect();

        await expect(dbGrant()).rejects.toThrow('exit 1');

        expect(output.join('\n')).toContain(`PostgreSQL refused REVOKE GRANT OPTION FOR SELECT ON TABLE "i405d_grant"."notes" FROM "${appRole}": `
            + 'other grants depend on the grant option it takes (2BP01).');
        expect(output.join('\n')).toContain(`     ${appRole} → ${ownerRole}: SELECT\n`);
        expect(await held('i405d_grant.ledger')).toEqual(['SELECT', 'INSERT', 'TRUNCATE']);
        expect(await selectOption()).toBe(true);

        await app.unsafe(`REVOKE SELECT ON i405d_grant.notes FROM "${ownerRole}"`);
        output.length = 0;
        await dbGrant();

        expect(output.join('\n')).toContain(`REVOKE GRANT OPTION FOR SELECT ON TABLE "i405d_grant"."notes" FROM "${appRole}";`);
        expect(await held('i405d_grant.ledger')).toEqual(['SELECT', 'INSERT']);
        expect(await selectOption()).toBe(false);

        output.length = 0;
        await dbGrant();

        expect(output.join('\n')).toContain('nothing to change');
    });

    it('P14b db grant --dry-run runs the statements and rolls back: the refusal is reported, the catalog unchanged', async () =>
    {
        const ownerRole = await passOnSelect();

        await dbGrant({ dryRun: true });

        expect(output.join('\n')).toContain(`REVOKE TRUNCATE ON TABLE "i405d_grant"."ledger" FROM "${appRole}";`);
        expect(output.join('\n')).toContain(`PostgreSQL refused REVOKE GRANT OPTION FOR SELECT ON TABLE "i405d_grant"."notes" FROM "${appRole}"`);
        expect(output.join('\n')).toContain(`     ${appRole} → ${ownerRole}: SELECT\n`);
        expect(output.join('\n')).toContain('Dry run: nothing was granted or revoked');
        expect(await held('i405d_grant.ledger')).toEqual(['SELECT', 'INSERT', 'TRUNCATE']);
        expect(await selectOption()).toBe(true);
        await expectStatusAgreesWithDryRun();
    });

    it('P15 DATABASE_APP_ROLE naming no role: migrate and db grant exit 1 naming the setting and the role, before any statement', async () =>
    {
        writeProjectMigrations();
        delete process.env.DATABASE_URL;
        process.env.DATABASE_APP_ROLE = 'i405d_no_such_role';

        try
        {
            await expect(dbMigrate()).rejects.toThrow('exit 1');

            expect(output.join('\n')).toContain('Schema applied; no privilege was changed, so new tables have only what the database gives by default: '
                + 'DATABASE_APP_ROLE names the role i405d_no_such_role, which does not exist in this database');
            expect(output.join('\n')).not.toContain('42704');
            expect(output.filter(line => /^\s*(GRANT|REVOKE) /.test(line))).toEqual([]);
            expect(await held('i405d_grant.notes')).toEqual([]);
            output.length = 0;

            await expect(dbGrant()).rejects.toThrow('exit 1');

            expect(output.join('\n')).toContain('❌ Privileges not applied: DATABASE_APP_ROLE names the role i405d_no_such_role');
        }
        finally
        {
            delete process.env.DATABASE_APP_ROLE;
        }
    });

    /** The privileges field of `db status --json`. */
    async function statusPrivileges(): Promise<Record<string, unknown>>
    {
        output.length = 0;
        await dbStatus({ json: true });

        const line = output.find(entry => entry.startsWith(DB_STATUS_JSON_MARKER)) ?? '';

        return JSON.parse(line.slice(DB_STATUS_JSON_MARKER.length)).privileges;
    }

    /**
     * I1: status's entries are the dry run's statements, one per relation,
     * grantee and privilege (and kind: GRANT, REVOKE, REVOKE GRANT OPTION FOR,
     * or a grant to PUBLIC its grantor must revoke) — never two counts, so two
     * disagreements cannot cancel out. The dry run connects as `ownerUrl`, or
     * runs without `DATABASE_OWNER_URL` when it is undefined; `role` is the
     * app role, whose schema USAGE status reports. A read role, when one is
     * set, gets no statement in these rows, so every statement is the app's or
     * PUBLIC's.
     */
    async function expectStatusAgreesWithDryRun(ownerUrl: string | undefined = OWNER_URL, role = appRole): Promise<void>
    {
        const status = statusEntries(await statusPrivileges() as unknown as StatusPrivileges, role);

        output.length = 0;
        if (ownerUrl === undefined)
        {
            delete process.env.DATABASE_OWNER_URL;
        }
        else
        {
            process.env.DATABASE_OWNER_URL = ownerUrl;
        }
        await dbGrant({ dryRun: true });

        const dryRun = dryRunEntries(output.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')));

        expect(status.sort(), `dry run ${JSON.stringify(output)}`).toEqual(dryRun.sort());
        output.length = 0;
    }

    it('P16 a view and a materialized view get SELECT; a write on the view is excess in status, and revoked', async () =>
    {
        writeProjectMigrations(PROJECT_SQL + '--> statement-breakpoint\nCREATE VIEW i405d_grant.notes_v AS SELECT * FROM i405d_grant.notes;\n'
            + '--> statement-breakpoint\nCREATE MATERIALIZED VIEW i405d_grant.notes_m AS SELECT * FROM i405d_grant.notes;\n');
        await dbMigrate();

        expect(await asApp('SELECT * FROM i405d_grant.notes_v')).toBe('ok');
        expect(await asApp('SELECT * FROM i405d_grant.notes_m')).toBe('ok');
        expect(await held('i405d_grant.notes_v')).toEqual(['SELECT']);
        expect(await held('i405d_grant.notes_m')).toEqual(['SELECT']);

        await owner.unsafe(`GRANT UPDATE, TRUNCATE ON i405d_grant.notes_v, i405d_grant.notes_m TO "${appRole}"`);

        expect(await statusPrivileges()).toMatchObject({ checked: true, drift: [
            { schema: 'i405d_grant', table: 'notes_m', missing: [], excess: ['update', 'truncate'] },
            { schema: 'i405d_grant', table: 'notes_v', missing: [], excess: ['update', 'truncate'] },
        ] });
        await expectStatusAgreesWithDryRun();

        process.env.DATABASE_OWNER_URL = OWNER_URL;
        output.length = 0;
        await dbGrant();

        expect(await held('i405d_grant.notes_v')).toEqual(['SELECT']);
        expect(await held('i405d_grant.notes_m')).toEqual(['SELECT']);
        expect(await statusPrivileges()).toMatchObject({ checked: true, checkedTables: 5, drift: [] });
        await expectStatusAgreesWithDryRun();
    });

    it('P17 through a view that runs as its owner the app writes nothing its tables declare away: no UPDATE or DELETE of an append-only table, no INSERT into a select-only one', async () =>
    {
        writeProjectMigrations(PROJECT_SQL + '--> statement-breakpoint\nCREATE VIEW i405d_grant.ledger_v AS SELECT * FROM i405d_grant.ledger;\n'
            + '--> statement-breakpoint\nCREATE TABLE i405d_grant.secrets (tenant integer NOT NULL, body text);\n'
            + '--> statement-breakpoint\nCREATE VIEW i405d_grant.secrets_v AS SELECT * FROM i405d_grant.secrets;\n', [
            { schema: 'i405d_grant', table: 'ledger', privileges: ['select', 'insert'] },
            { schema: 'i405d_grant', table: 'notes', privileges: 'default' },
            { schema: 'i405d_grant', table: 'secrets', privileges: ['select'] },
        ]);
        await dbMigrate();
        await owner.unsafe('INSERT INTO i405d_grant.ledger (amount) VALUES (100)');

        expect(await held('i405d_grant.ledger')).toEqual(['SELECT', 'INSERT']);
        expect(await asApp('UPDATE i405d_grant.ledger_v SET amount = 0')).toBe('42501');
        expect(await asApp('DELETE FROM i405d_grant.ledger_v')).toBe('42501');
        expect(await asApp("INSERT INTO i405d_grant.secrets_v VALUES (1, 'forged')")).toBe('42501');
        expect(await asApp('SELECT * FROM i405d_grant.ledger_v')).toBe('ok');
    });

    it('P18 (PostgreSQL 15+, skipped below) a security_invoker view gets the default set and writes exactly as far as its table allows', async ({ skip }) =>
    {
        const [{ version }] = await owner`SELECT current_setting('server_version_num')::int AS version`;

        skip(version < 150000, `security_invoker needs PostgreSQL 15; the server is ${version}`);
        writeProjectMigrations(PROJECT_SQL
            + '--> statement-breakpoint\nCREATE VIEW i405d_grant.ledger_iv WITH (security_invoker = on) AS SELECT * FROM i405d_grant.ledger;\n'
            + '--> statement-breakpoint\nCREATE VIEW i405d_grant.notes_iv WITH (security_invoker = 1) AS SELECT * FROM i405d_grant.notes;\n'
            + '--> statement-breakpoint\nCREATE VIEW i405d_grant.notes_ov WITH (security_invoker = off) AS SELECT * FROM i405d_grant.notes;\n');
        await dbMigrate();
        await owner.unsafe('INSERT INTO i405d_grant.ledger (amount) VALUES (100)');

        expect(await held('i405d_grant.ledger_iv')).toEqual(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
        expect(await held('i405d_grant.notes_iv')).toEqual(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
        expect(await held('i405d_grant.notes_ov')).toEqual(['SELECT']);
        expect(await asApp('INSERT INTO i405d_grant.ledger_iv (amount) VALUES (1)')).toBe('ok');
        expect(await asApp('UPDATE i405d_grant.ledger_iv SET amount = 0')).toBe('42501');
        expect(await asApp('DELETE FROM i405d_grant.ledger_iv')).toBe('42501');
        expect(await asApp("UPDATE i405d_grant.notes_iv SET body = 'x'")).toBe('ok');
        expect(await statusPrivileges()).toMatchObject({ checked: true, drift: [] });
        await expectStatusAgreesWithDryRun();
    });

    it('P19 (PostgreSQL 15+, skipped below) a security_invoker view with a DO INSTEAD rule or an INSTEAD OF trigger gets SELECT: the app inserts through neither into a select-only table', async ({ skip }) =>
    {
        const [{ version }] = await owner`SELECT current_setting('server_version_num')::int AS version`;

        skip(version < 150000, `security_invoker needs PostgreSQL 15; the server is ${version}`);
        writeProjectMigrations(PROJECT_SQL
            + '--> statement-breakpoint\nCREATE TABLE i405d_grant.secrets (tenant integer NOT NULL, body text);\n'
            + '--> statement-breakpoint\nCREATE VIEW i405d_grant.secrets_rv WITH (security_invoker) AS SELECT * FROM i405d_grant.secrets;\n'
            + '--> statement-breakpoint\nCREATE RULE secrets_rv_insert AS ON INSERT TO i405d_grant.secrets_rv DO INSTEAD INSERT INTO i405d_grant.secrets VALUES (NEW.tenant, NEW.body);\n'
            + '--> statement-breakpoint\nCREATE VIEW i405d_grant.secrets_tv WITH (security_invoker) AS SELECT * FROM i405d_grant.secrets;\n'
            + '--> statement-breakpoint\nCREATE FUNCTION i405d_grant.secrets_tv_insert() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO i405d_grant.secrets VALUES (NEW.tenant, NEW.body); RETURN NEW; END $$;\n'
            + '--> statement-breakpoint\nCREATE TRIGGER secrets_tv_insert INSTEAD OF INSERT ON i405d_grant.secrets_tv FOR EACH ROW EXECUTE FUNCTION i405d_grant.secrets_tv_insert();\n', [
            { schema: 'i405d_grant', table: 'ledger', privileges: ['select', 'insert'] },
            { schema: 'i405d_grant', table: 'notes', privileges: 'default' },
            { schema: 'i405d_grant', table: 'secrets', privileges: ['select'] },
        ]);
        await dbMigrate();

        expect(await held('i405d_grant.secrets_rv')).toEqual(['SELECT']);
        expect(await held('i405d_grant.secrets_tv')).toEqual(['SELECT']);
        expect(await asApp("INSERT INTO i405d_grant.secrets VALUES (1, 'forged')")).toBe('42501');
        expect(await asApp("INSERT INTO i405d_grant.secrets_rv VALUES (1, 'forged')")).toBe('42501');
        expect(await asApp("INSERT INTO i405d_grant.secrets_tv VALUES (1, 'forged')")).toBe('42501');
        expect(await asApp('SELECT * FROM i405d_grant.secrets_rv')).toBe('ok');
        expect(await statusPrivileges()).toMatchObject({ checked: true, drift: [] });
        await expectStatusAgreesWithDryRun();
    });

    /** The human `db status`, then the drift of its `--json`, after `grant` — as the owner — on the migrated app. */
    async function statusAfter(grant: string): Promise<{ text: string; drift: unknown }>
    {
        writeProjectMigrations();
        await dbMigrate();
        await owner.unsafe(grant);
        output.length = 0;
        await dbStatus();

        return { text: output.join('\n'), drift: (await statusPrivileges()).drift };
    }

    it('P20 (rv428 RV1) a declared privilege held WITH GRANT OPTION: status does not say "holds what is declared", and --json lists it', async () =>
    {
        const status = await statusAfter(`GRANT SELECT ON i405d_grant.notes TO "${appRole}" WITH GRANT OPTION`);

        expect(status.text).not.toContain('holds what is declared');
        expect(status.text).toContain('i405d_grant.notes: WITH GRANT OPTION on SELECT');
        expect(status.drift).toEqual([
            { schema: 'i405d_grant', table: 'notes', kind: 'table', grantee: appRole, through: null, missing: [], excess: [], grantOption: ['select'], columns: [] },
        ]);
        await expectStatusAgreesWithDryRun();
    });

    it('P21 a column grant beyond the declaration: status does not say "holds what is declared", and --json lists it', async () =>
    {
        const status = await statusAfter(`GRANT UPDATE (amount) ON i405d_grant.ledger TO "${appRole}"`);

        expect(status.text).not.toContain('holds what is declared');
        expect(status.text).toContain('i405d_grant.ledger: column grants UPDATE (amount)');
        expect(status.drift).toEqual([
            { schema: 'i405d_grant', table: 'ledger', kind: 'table', grantee: appRole, through: null, missing: [], excess: [], grantOption: [], columns: ['update (amount)'] },
        ]);
        await expectStatusAgreesWithDryRun();
    });

    it('P22 (rv428i N1) a DATABASE_READ_URL that does not answer: status reports the app role\'s part, and the read role\'s as not checked, naming the variable', async () =>
    {
        writeProjectMigrations();
        await dbMigrate();
        process.env.DATABASE_READ_URL = 'postgresql://nobody@127.0.0.1:1/none';
        output.length = 0;
        await dbStatus();

        expect(output.join('\n')).toContain('Not checked: the read role could not be looked up through DATABASE_READ_URL');
        expect(output.join('\n')).not.toContain('holds what is declared');

        await owner.unsafe('GRANT DELETE ON i405d_grant.ledger TO PUBLIC');
        output.length = 0;
        await dbStatus({ json: true });

        const lines = output.filter(entry => entry.startsWith(DB_STATUS_JSON_MARKER));
        const privileges = JSON.parse(lines[0].slice(DB_STATUS_JSON_MARKER.length)).privileges;

        expect(lines).toHaveLength(1);
        expect(privileges).toMatchObject({
            checked: true,
            drift: [{ schema: 'i405d_grant', table: 'ledger', grantee: null, excess: ['delete'] }],
            readRole: { checked: false },
        });
        expect(privileges.readRole.detail).toContain('DATABASE_READ_URL');
        expect(privileges.readRole.detail).toContain('ECONNREFUSED');
    });

    it('P23 (rv428i B1) a single role that owns its tables, PUBLIC granted on one: status shows the owned note and no drift, and agrees with db grant --dry-run, with and without a read role', async () =>
    {
        const [{ owner: ownerRole }] = await owner`SELECT current_user AS owner`;

        process.env.DATABASE_URL = OWNER_URL;
        delete process.env.DATABASE_OWNER_URL;
        writeProjectMigrations();
        await dbMigrate();
        await owner.unsafe('GRANT SELECT ON i405d_grant.notes TO PUBLIC');
        output.length = 0;
        await dbStatus();

        expect(output.join('\n')).toContain('🔐 The app role owns 3 managed table(s)');
        expect(output.join('\n')).not.toContain('differ from the declarations');
        expect(await statusPrivileges()).toMatchObject({ checked: true, ownedTables: 3, checkedTables: 0, drift: [], publicGrantsByOthers: [] });
        await expectStatusAgreesWithDryRun(undefined, ownerRole);
        await expectStatusAgreesWithDryRun(OWNER_URL, ownerRole);

        process.env.DATABASE_READ_URL = appUrl();

        expect(await statusPrivileges()).toMatchObject({ checked: true, ownedTables: 3, drift: [], readRole: { checked: true } });
        await expectStatusAgreesWithDryRun(undefined, ownerRole);
        await expectStatusAgreesWithDryRun(OWNER_URL, ownerRole);
    });

    it('P24 (#435) CREATE on a managed schema granted to the app: status reports it, db grant revokes it, the app\'s CREATE TABLE is refused, and a second run changes nothing', async () =>
    {
        writeProjectMigrations();
        await dbMigrate();
        await owner.unsafe(`GRANT CREATE ON SCHEMA i405d_grant TO "${appRole}"`);
        await owner.unsafe(`GRANT USAGE ON SCHEMA drizzle TO "${appRole}" WITH GRANT OPTION`);

        expect(await statusPrivileges()).toMatchObject({ checked: true, drift: [], schemaDrift: [
            { schema: 'drizzle', grantee: appRole, through: null, excess: [], grantOption: ['usage'] },
            { schema: 'i405d_grant', grantee: appRole, through: null, excess: ['create'], grantOption: [] },
        ] });
        await expectStatusAgreesWithDryRun();

        output.length = 0;
        await dbGrant();

        expect(output.join('\n')).toContain(`REVOKE CREATE ON SCHEMA "i405d_grant" FROM "${appRole}";`);
        expect(await asApp('CREATE TABLE i405d_grant.t (id integer)')).toBe('42501');
        expect(await asApp('CREATE TABLE drizzle.t (id integer)')).toBe('42501');
        expect(await asApp('SELECT * FROM i405d_grant.notes')).toBe('ok');

        output.length = 0;
        await dbGrant();

        expect(output.join('\n')).toContain('nothing to change');
        expect(await statusPrivileges()).toMatchObject({ checked: true, drift: [], schemaDrift: [] });
        await expectStatusAgreesWithDryRun();
    });
});

/** The fields of `db status --json`'s `privileges` that I1 compares. */
interface StatusPrivileges
{
    drift: { schema: string; table: string; grantee: string | null; missing: string[]; excess: string[]; grantOption: string[]; columns: string[] }[];
    schemasWithoutUsage: string[];
    schemaDrift: { schema: string; grantee: string | null; excess: string[]; grantOption: string[] }[];
    publicGrantsByOthers: { schema: string; table: string; privilege: string }[];
}

/**
 * One `kind|object|grantee|privilege` entry per privilege of each statement
 * status implies: `object` is `schema.table` or `schema <name>`, a column's
 * privilege `update (amount)`, `BLOCKED` a grant to PUBLIC its grantor revokes.
 */
function statusEntries(privileges: StatusPrivileges, appRole: string): string[]
{
    const entries = (kind: string, object: string, grantee: string, list: string[]) => list.map(privilege => `${kind}|${object}|${grantee}|${privilege.replaceAll('"', '')}`);

    return [
        ...privileges.drift.flatMap(entry =>
        {
            const of = (kind: string, list: string[]) => entries(kind, `${entry.schema}.${entry.table}`, entry.grantee ?? 'PUBLIC', list);

            return [...of('GRANT', entry.missing), ...of('REVOKE', entry.excess), ...of('REVOKE GRANT OPTION FOR', entry.grantOption), ...of('REVOKE', entry.columns)];
        }),
        ...privileges.schemasWithoutUsage.flatMap(schema => entries('GRANT', `schema ${schema}`, appRole, ['usage'])),
        ...privileges.schemaDrift.flatMap(entry => [
            ...entries('REVOKE', `schema ${entry.schema}`, entry.grantee ?? 'PUBLIC', entry.excess),
            ...entries('REVOKE GRANT OPTION FOR', `schema ${entry.schema}`, entry.grantee ?? 'PUBLIC', entry.grantOption),
        ]),
        ...privileges.publicGrantsByOthers.flatMap(grant => entries('BLOCKED', `${grant.schema}.${grant.table}`, 'PUBLIC', [grant.privilege])),
    ];
}

/** `statusEntries`' entries for the statements a dry run printed, and the REVOKEs it names for the grantors of grants to PUBLIC. */
function dryRunEntries(lines: string[]): string[]
{
    return lines.flatMap(line =>
    {
        const statement = /^\s*((?:GRANT|REVOKE) .+);$/.exec(line)?.[1];
        const blocked = /as \S+: (REVOKE .+ FROM PUBLIC);$/.exec(line)?.[1];

        return statement !== undefined ? statementEntries(statement, undefined) : blocked !== undefined ? statementEntries(blocked, 'BLOCKED') : [];
    });
}

/** One entry per privilege of `statement`, of `kind`, else its own: GRANT, REVOKE or REVOKE GRANT OPTION FOR. */
function statementEntries(statement: string, kind: string | undefined): string[]
{
    const [, verb, privileges, objectKind, object, grantee] = /^(GRANT|REVOKE GRANT OPTION FOR|REVOKE) (.+) ON (TABLE|SEQUENCE|SCHEMA) (\S+) (?:TO|FROM) (\S+)$/.exec(statement)
        ?? ['', statement, '', '', '', ''];
    const name = `${objectKind === 'SCHEMA' ? 'schema ' : ''}${object.replaceAll('"', '')}`;

    return [...privileges.matchAll(/(\w+)(?: \(([^)]*)\))?/g)].flatMap(([, privilege, columns]) => (columns === undefined ? [''] : columns.split(', '))
        .map(column => `${kind ?? verb}|${name}|${grantee.replaceAll('"', '')}|${privilege.toLowerCase()}${column === '' ? '' : ` (${column.replaceAll('"', '')})`}`));
}
