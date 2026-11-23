/**
 * `appPrivileges` and its manifest (#405, PR 3): the declaration is refused
 * where it is written, survives the table wrappers and a second copy of core,
 * and the manifest reader refuses what it cannot vouch for.
 *
 * | #  | situation                                                              | expected                                                  |
 * |----|------------------------------------------------------------------------|-----------------------------------------------------------|
 * | P1 | `'udpate'`, an empty list, a second different declaration on one table | AppPrivilegesError naming the table, at the call          |
 * | P2 | declared on a `tenancy.table` and a `createSchema().table` through one | another evaluation of the module reads both declarations, |
 * |    | evaluation of the module                                               | and the tenant list without one as `'default'`            |
 * | P4 | a manifest that is not JSON, of version 2, with a misspelt privilege,  | AppPrivilegesManifestError naming the file; the file the  |
 * |    | an entry without a schema, or one table listed twice                   | writer wrote reads back as written                        |
 * | R7 | `"a"."b.c"` declares [select], `"a.b"."c"` declares none               | two entries, schema and table apart, sorted by schema;    |
 * |    |                                                                        | the manifest reads them back the same                     |
 * | R8 | a migrations folder without `privileges.json`, with the writer's file, | `kind: 'none'` with the default set; the manifest; an     |
 * |    | with a malformed one                                                   | AppPrivilegesManifestError, never `'none'`                |
 * | R9 | `privileges.json` a dangling symlink, a symlink loop; a folder it may  | AppPrivilegesManifestError naming the file, never         |
 * |    | not list (not as root: root lists it), a file instead of a folder, no  | `'none'`: only a listing without the file is "no manifest"|
 * |    | folder at all                                                          |                                                           |
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgSchema, pgTable, text } from 'drizzle-orm/pg-core';

import { createSchema, id } from '../../schema';
import { defineTenancy } from '../../tenant';
import { appPrivileges, AppPrivilegesError, declaredAppPrivileges, type AppPrivilege } from '../declaration';
import {
    APP_PRIVILEGES_MANIFEST_FILE,
    AppPrivilegesManifestError,
    readAppPrivilegesManifest,
    readMigrationsAppPrivileges,
    writeAppPrivilegesManifest,
} from '../manifest';

describe('appPrivileges refuses a declaration that cannot stand (P1)', () =>
{
    const auditLog = () => pgTable('audit_log', { id: id() });

    it.each([
        ['a misspelt privilege', ['select', 'udpate'], /unknown privilege "udpate"/],
        ['an empty list', [], /declares no privileges/],
    ])('%s', (_case, privileges, message) =>
    {
        const attempt = () => appPrivileges(auditLog(), privileges as AppPrivilege[]);

        expect(attempt).toThrow(AppPrivilegesError);
        expect(attempt).toThrow(message);
        expect(attempt).toThrow(/^appPrivileges\(public\.audit_log\)/);
    });

    it('a second declaration that differs from the first', () =>
    {
        const table = appPrivileges(auditLog(), ['select', 'insert']);

        expect(() => appPrivileges(table, ['select', 'insert', 'update']))
            .toThrow(new AppPrivilegesError('public', 'audit_log', 'declared [select, insert, update], but the table already declares [select, insert]'));
    });
});

describe('a declaration survives the table wrappers and a second copy of core (P2)', () =>
{
    it('reads every declaration through another evaluation of the module', async () =>
    {
        const schema = createSchema('@acme/ledger');
        const workspaces = schema.table('workspaces', { id: id(), name: text('name') });
        const tenancy = defineTenancy({ tenants: workspaces, authorize: () => true });
        const entries = appPrivileges(tenancy.table(schema, 'entries', { id: id(), body: text('body') }), ['insert', 'select']);
        const events = appPrivileges(schema.table('events', { id: id() }), ['select', 'insert', 'delete']);

        vi.resetModules();
        const secondCopy = await import('../declaration');

        expect(secondCopy.declaredAppPrivileges([events, workspaces, entries, schema])).toEqual([
            { schema: 'acme_ledger', table: 'entries', privileges: ['select', 'insert'] },
            { schema: 'acme_ledger', table: 'events', privileges: ['select', 'insert', 'delete'] },
            { schema: 'acme_ledger', table: 'workspaces', privileges: 'default' },
        ]);
    });
});

describe('a schema or table name holding a dot stays apart from its neighbour (R7)', () =>
{
    const dotted = () => [
        appPrivileges(pgSchema('a').table('b.c', { id: id() }), ['select']),
        pgSchema('a.b').table('c', { id: id() }),
    ];
    const expected = [
        { schema: 'a', table: 'b.c', privileges: ['select'] },
        { schema: 'a.b', table: 'c', privileges: 'default' },
    ];

    it('lists "a"."b.c" and "a.b"."c" as two tables', () =>
    {
        expect(declaredAppPrivileges(dotted().reverse())).toEqual(expected);
    });

    it('the manifest reads them back as written', () =>
    {
        const dir = mkdtempSync(join(tmpdir(), 'spfn-privileges-'));

        try
        {
            expect(readAppPrivilegesManifest(writeAppPrivilegesManifest(dir, dotted())).tables).toEqual(expected);
        }
        finally
        {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('readAppPrivilegesManifest (P4)', () =>
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

    /** A manifest the writer would write, with `change` applied. */
    function manifestWith(change: Record<string, unknown>): string
    {
        return JSON.stringify({
            version: 1,
            default: ['select', 'insert', 'update', 'delete'],
            tables: [{ schema: 'app', table: 'notes', privileges: 'default' }],
            ...change,
        });
    }

    it.each([
        ['text that is not JSON', '{ "version": 1,', /cannot be read as JSON/],
        ['an unknown version', manifestWith({ version: 3 }), /has version 3; this @spfn\/core reads versions 1 and 2/],
        ['a misspelt privilege', manifestWith({ tables: [{ schema: 'app', table: 'audit', privileges: ['select', 'udpate'] }] }), /table entry 0 is malformed/],
        ['an entry without a schema', manifestWith({ tables: [{ table: 'audit', privileges: 'default' }] }), /table entry 0 is malformed/],
        ['tables as a map by name', manifestWith({ tables: { 'app.audit': 'default' } }), /"tables" is not a list/],
        ['one table listed twice', manifestWith({ tables: [
            { schema: 'app', table: 'audit', privileges: 'default' },
            { schema: 'app', table: 'audit', privileges: ['select'] },
        ] }), /table entry 1 lists \["app","audit"\] a second time/],
    ])('refuses %s, naming the file', (_case, text, message) =>
    {
        writeFileSync(file, text);

        expect(() => readAppPrivilegesManifest(file)).toThrow(AppPrivilegesManifestError);
        expect(() => readAppPrivilegesManifest(file)).toThrow(message);
        expect(() => readAppPrivilegesManifest(file)).toThrow(file);
    });

    it('reads back what the writer wrote', () =>
    {
        const notes = pgTable('notes', { id: id() });
        const audit = appPrivileges(pgTable('audit', { id: id() }), ['select', 'insert']);

        writeAppPrivilegesManifest(dir, [notes, audit]);

        expect(readAppPrivilegesManifest(file)).toEqual({
            version: 1,
            default: ['select', 'insert', 'update', 'delete'],
            tables: [
                { schema: 'public', table: 'audit', privileges: ['select', 'insert'] },
                { schema: 'public', table: 'notes', privileges: 'default' },
            ],
        });
        expect(readFileSync(file, 'utf8')).toMatch(/^\{\n {4}"\$comment": "Generated from/);
    });
});

describe('readMigrationsAppPrivileges: no file is the default set, a broken file an error (R8)', () =>
{
    let dir: string;

    beforeEach(() =>
    {
        dir = mkdtempSync(join(tmpdir(), 'spfn-privileges-'));
    });

    afterEach(() =>
    {
        rmSync(dir, { recursive: true, force: true });
    });

    it('a folder without privileges.json: every table has the default set', () =>
    {
        expect(readMigrationsAppPrivileges(dir)).toEqual({ kind: 'none', default: ['select', 'insert', 'update', 'delete'] });
    });

    it('a folder with the writer\'s file: its manifest', () =>
    {
        const file = writeAppPrivilegesManifest(dir, [appPrivileges(pgTable('audit', { id: id() }), ['select'])]);

        expect(readMigrationsAppPrivileges(dir)).toEqual({
            kind: 'manifest',
            file,
            manifest: { version: 1, default: ['select', 'insert', 'update', 'delete'], tables: [{ schema: 'public', table: 'audit', privileges: ['select'] }] },
        });
    });

    it('a folder with a malformed privileges.json: the manifest error, not "none"', () =>
    {
        writeFileSync(join(dir, APP_PRIVILEGES_MANIFEST_FILE), '{ "version": 1,');

        expect(() => readMigrationsAppPrivileges(dir)).toThrow(AppPrivilegesManifestError);
    });
});

describe('readMigrationsAppPrivileges: only a listing without the file is "no manifest" (R9)', () =>
{
    let dir: string;

    const file = () => join(dir, APP_PRIVILEGES_MANIFEST_FILE);
    const asRoot = process.getuid?.() === 0;

    beforeEach(() =>
    {
        dir = mkdtempSync(join(tmpdir(), 'spfn-privileges-'));
    });

    afterEach(() =>
    {
        chmodSync(dir, 0o700);
        rmSync(dir, { recursive: true, force: true });
    });

    it.each([
        ['privileges.json is a dangling symlink', () => symlinkSync(join(dir, 'gone.json'), file())],
        ['privileges.json is a symlink loop', () => symlinkSync(APP_PRIVILEGES_MANIFEST_FILE, file())],
    ])('%s: the manifest error naming the file', (_case, arrange) =>
    {
        arrange();

        expect(() => readMigrationsAppPrivileges(dir)).toThrow(AppPrivilegesManifestError);
        expect(() => readMigrationsAppPrivileges(dir)).toThrow(file());
    });

    it.skipIf(asRoot)('a folder it may not list: the manifest error naming the file', () =>
    {
        chmodSync(dir, 0o300);

        expect(() => readMigrationsAppPrivileges(dir)).toThrow(AppPrivilegesManifestError);
        expect(() => readMigrationsAppPrivileges(dir)).toThrow(`${file()}: cannot tell whether it exists`);
        expect(() => readMigrationsAppPrivileges(dir)).toThrow('EACCES');
    });

    it.each([
        ['a file instead of a folder', 'ENOTDIR', () => writeFileSync(join(dir, 'migrations'), '')],
        ['no folder at all', 'ENOENT', () => undefined],
    ])('%s: the manifest error naming the file', (_case, code, arrange) =>
    {
        arrange();
        const migrations = join(dir, 'migrations');

        expect(() => readMigrationsAppPrivileges(migrations)).toThrow(AppPrivilegesManifestError);
        expect(() => readMigrationsAppPrivileges(migrations)).toThrow(`${join(migrations, APP_PRIVILEGES_MANIFEST_FILE)}: cannot tell whether it exists`);
        expect(() => readMigrationsAppPrivileges(migrations)).toThrow(code);
    });
});
