/**
 * `spfn db generate` writes the privileges manifest (#405, PR 3)
 *
 * The manifest lists the tables of the configuration the run hands
 * drizzle-kit — the project's drizzle.config.ts, else the generated one — and
 * sits in that configuration's `out`, beside the migrations it describes.
 *
 * | #  | situation                                                          | expected                                                     |
 * |----|--------------------------------------------------------------------|--------------------------------------------------------------|
 * | P3 | an entity file exports `notes` (no declaration), then `audit`      | `src/server/drizzle/privileges.json` lists both, sorted, as  |
 * |    | (`appPrivileges(…, ['insert', 'select'])`); generate runs twice    | declared or `"default"`; the second run writes the same bytes |
 * | R1 | own drizzle.config.ts, DATABASE_URL unset                          | the manifest is written; no exit 1                           |
 * | R2 | two entity files both export `items` (`items_a` declared, `items_b`)| both tables reach the manifest, `items_a` with its list     |
 * | R4 | own drizzle.config.ts with `out: './drizzle'`                      | `drizzle/privileges.json`; `src/server/drizzle` not created  |
 * | R5 | an entity file exports a table of a function package's schema     | the package's table is left out of the project manifest      |
 * |    | (`spfn_fakepkg`, the package ships migrations) beside its own      |                                                              |
 * | R6 | two tables of one name declare different lists; a module fails to | exit 1 before drizzle-kit runs; no manifest                  |
 * |    | load                                                               |                                                              |
 * | R7 | an entity file exports `ledger` as `default` beside `notes`, a     | the tables drizzle-kit migrates (`Object.values` of the      |
 * |    | table inside an exported object and one inside an exported array   | module): `ledger` and `notes`, not the nested two            |
 * | R8 | own drizzle.config.ts with a `**` glob over a tree holding a       | real drizzle-kit migrates the tables the manifest lists:     |
 * |    | `(billing)/[tenant]` folder, a nested `node_modules` and a dot-dir | `invoices`, not the node_modules or the dot-directory table  |
 * | R9 | `privileges.json` cannot be written (a directory holds its name:   | after "Migrations generated", the error names the manifest  |
 * |    | refused as root too)                                               | file, says the migrations were written, to rerun; exit 1    |
 *
 * drizzle-kit is replaced by a recorder: a changed declaration changes no DDL,
 * so drizzle-kit generates nothing then, and the manifest must be written anyway.
 * R8 runs the real one, by its path under this node, to compare the two sets.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/drizzle.js', async (importOriginal) => ({
    ...await importOriginal<typeof import('../utils/drizzle.js')>(),
    runDrizzleKit: vi.fn(async () => undefined),
}));

const { dbGenerate } = await import('../generate.js');
const { runDrizzleKit } = await import('../utils/drizzle.js');

const EXPECTED = `{
    "$comment": "Generated from the entities' appPrivileges() declarations. Do not edit: regenerate.",
    "version": 1,
    "default": [
        "select",
        "insert",
        "update",
        "delete"
    ],
    "tables": [
        {
            "schema": "acme",
            "table": "audit",
            "privileges": [
                "select",
                "insert"
            ]
        },
        {
            "schema": "acme",
            "table": "notes",
            "privileges": "default"
        }
    ]
}
`;

const DRIZZLE_KIT_BIN = join(dirname(createRequire(import.meta.url).resolve('drizzle-kit')), 'bin.cjs');

const PG = "import { integer, pgTable } from 'drizzle-orm/pg-core';\n";
const DECLARE = "import { appPrivileges } from '@spfn/core/db';\n";

describe('db generate writes the privileges manifest', () =>
{
    let root: string;
    let previousCwd: string;
    let previousUrl: string | undefined;
    let printed: string[];

    const entity = (name: string, source: string) => writeFileSync(join(root, 'src', 'server', 'entities', name), source);
    const ownConfig = (out?: string) => writeFileSync(join(root, 'drizzle.config.ts'),
        `export default { dialect: 'postgresql', schema: './src/server/entities/*.ts'${out ? `, out: '${out}'` : ''} };\n`);
    const tablesIn = (out: string) => JSON.parse(readFileSync(join(root, out, 'privileges.json'), 'utf8')).tables;
    // A run that fails shows what the command printed, which the console spies otherwise swallow
    const generate = () => dbGenerate().catch((error: unknown) => expect.fail(`${error}; db generate printed:\n${printed.join('\n')}`));
    // The generated-config path needs a URL; nothing connects to it (drizzle-kit is the recorder)
    const generatedConfigUrl = () => process.env.DATABASE_URL = 'postgresql://nobody@127.0.0.1:1/none';

    beforeEach(() =>
    {
        previousCwd = process.cwd();
        previousUrl = process.env.DATABASE_URL;
        // Each row states its own URL: CI's environment holds one or not depending on how the suite is started
        delete process.env.DATABASE_URL;
        printed = [];
        // Under this package, so the entity file resolves drizzle-orm and @spfn/core
        root = mkdtempSync(join(__dirname, 'tmp-generate-privileges-'));
        mkdirSync(join(root, 'src', 'server', 'entities'), { recursive: true });
        process.chdir(root);
        vi.mocked(runDrizzleKit).mockClear();
        vi.spyOn(process, 'exit').mockImplementation((code) =>
        {
            throw new Error(`process.exit(${code})`);
        });
        vi.spyOn(console, 'log').mockImplementation((...args) => printed.push(args.join(' ')));
        vi.spyOn(console, 'error').mockImplementation((...args) => printed.push(args.join(' ')));
    });

    afterEach(() =>
    {
        process.chdir(previousCwd);
        if (previousUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousUrl;
        rmSync(root, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('P3: lists every table as declared, and a second run writes the same bytes', async () =>
    {
        entity('acme.entity.ts', "import { integer, pgSchema } from 'drizzle-orm/pg-core';\n" + DECLARE
            + "export const acme = pgSchema('acme');\n"
            + "export const notes = acme.table('notes', { id: integer('id') });\n"
            + "export const audit = appPrivileges(acme.table('audit', { id: integer('id') }), ['insert', 'select']);\n");
        generatedConfigUrl();
        const manifest = join(root, 'src', 'server', 'drizzle', 'privileges.json');

        await generate();
        const first = readFileSync(manifest, 'utf8');

        await generate();

        expect(readFileSync(manifest, 'utf8')).toBe(first);
        expect(first).toBe(EXPECTED);
    });

    it('R1: own drizzle.config.ts and no DATABASE_URL: the manifest is written, the command does not exit 1', async () =>
    {
        ownConfig('./src/server/drizzle');
        entity('notes.entity.ts', PG + "export const notes = pgTable('notes', { id: integer('id') });\n");

        await generate();

        expect(tablesIn('src/server/drizzle')).toEqual([{ schema: 'public', table: 'notes', privileges: 'default' }]);
        expect(runDrizzleKit).toHaveBeenCalledWith('generate', expect.stringMatching(/^\.\/drizzle\.config\.\d+\.\d+\.temp\.ts$/), undefined);
    });

    it('R2: two entity files export one name: both tables, and the declaration, reach the manifest', async () =>
    {
        entity('a.entity.ts', PG + DECLARE + "export const items = appPrivileges(pgTable('items_a', { id: integer('id') }), ['select']);\n");
        entity('b.entity.ts', PG + "export const items = pgTable('items_b', { id: integer('id') });\n");
        generatedConfigUrl();

        await generate();

        expect(tablesIn('src/server/drizzle')).toEqual([
            { schema: 'public', table: 'items_a', privileges: ['select'] },
            { schema: 'public', table: 'items_b', privileges: 'default' },
        ]);
    });

    it('R4: a custom out: the manifest sits beside the migrations of the run, and src/server/drizzle stays absent', async () =>
    {
        ownConfig('./drizzle');
        entity('notes.entity.ts', PG + "export const notes = pgTable('notes', { id: integer('id') });\n");

        await generate();

        expect(tablesIn('drizzle')).toEqual([{ schema: 'public', table: 'notes', privileges: 'default' }]);
        expect(existsSync(join(root, 'src', 'server', 'drizzle'))).toBe(false);
    });

    it('R5: a function package\'s table is left out of the project manifest', async () =>
    {
        const fakePackage = join(root, 'node_modules', '@spfn', 'fakepkg');

        mkdirSync(join(fakePackage, 'migrations'), { recursive: true });
        writeFileSync(join(fakePackage, 'package.json'), JSON.stringify({ name: '@spfn/fakepkg', spfn: { migrations: { dir: './migrations' } } }));
        ownConfig();
        entity('mixed.entity.ts', "import { integer, pgSchema, pgTable } from 'drizzle-orm/pg-core';\n"
            + "export const owned = pgSchema('spfn_fakepkg').table('owned', { id: integer('id') });\n"
            + "export const notes = pgTable('notes', { id: integer('id') });\n");

        await generate();

        expect(tablesIn('drizzle')).toEqual([{ schema: 'public', table: 'notes', privileges: 'default' }]);
    });

    it('R7: a table exported as default is in the manifest, as in the migration; nested ones are in neither', async () =>
    {
        ownConfig();
        entity('ledger.entity.ts', PG
            + "export default pgTable('ledger', { id: integer('id') });\n"
            + "export const notes = pgTable('notes', { id: integer('id') });\n"
            + "export const nested = { inner: pgTable('nested_inner', { id: integer('id') }) };\n"
            + "export const list = [pgTable('listed', { id: integer('id') })];\n");

        await generate();

        expect(tablesIn('drizzle')).toEqual([
            { schema: 'public', table: 'ledger', privileges: 'default' },
            { schema: 'public', table: 'notes', privileges: 'default' },
        ]);
    });

    it('R8: drizzle-kit reads the files the manifest is made from: no nested node_modules, no dot-directory', async () =>
    {
        const file = (path: string, table: string) =>
        {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), PG + `export const t = pgTable('${table}', { id: integer('id') });\n`);
        };
        file('src/server/entities/(billing)/[tenant]/invoices.ts', 'invoices');
        file('src/server/entities/node_modules/vendor/vendored.ts', 'vendored');
        file('src/server/entities/.drafts/draft.ts', 'draft');
        writeFileSync(join(root, 'drizzle.config.ts'),
            "export default { dialect: 'postgresql', schema: './src/server/entities/**/*.ts', out: './drizzle' };\n");
        vi.mocked(runDrizzleKit).mockImplementationOnce(async (command, configPath) =>
        {
            execFileSync(process.execPath, [DRIZZLE_KIT_BIN, command, `--config=${configPath}`], { cwd: root, stdio: 'pipe' });
        });

        await generate();

        const migrated = readdirSync(join(root, 'drizzle'), { recursive: true, encoding: 'utf8' })
            .filter(path => path.endsWith('.sql'))
            .flatMap(path => [...readFileSync(join(root, 'drizzle', path), 'utf8').matchAll(/CREATE TABLE "(\w+)"/g)].map(match => match[1]));

        expect(migrated).toEqual(['invoices']);
        expect(tablesIn('drizzle').map((entry: { table: string }) => entry.table)).toEqual(migrated);
    });

    it('R9: a manifest that cannot be written: the error names it, says the migrations are there, and to rerun', async () =>
    {
        ownConfig('./drizzle');
        entity('notes.entity.ts', PG + "export const notes = pgTable('notes', { id: integer('id') });\n");
        mkdirSync(join(root, 'drizzle', 'privileges.json'), { recursive: true });

        await expect(dbGenerate()).rejects.toThrow('process.exit(1)');

        expect(runDrizzleKit).toHaveBeenCalled();
        expect(printed.slice(0, 2).map(line => line.trim())).toEqual([
            '✅ Migrations generated successfully',
            '❌ Failed to write drizzle/privileges.json; the migrations were written to ./drizzle. '
                + 'Fix what stopped the write (below) and rerun `spfn db generate`: it writes the manifest, and no second migration for the same schema',
        ]);
        expect(printed[2]).toMatch(/EISDIR/);
    });

    it.each([
        ['two tables of one name declare different lists', [
            ['a.entity.ts', PG + DECLARE + "export const a = appPrivileges(pgTable('items', { id: integer('id') }), ['select']);\n"],
            ['b.entity.ts', PG + "export const b = pgTable('items', { id: integer('id') });\n"],
        ]],
        ['a schema module fails to load', [
            ['a.entity.ts', PG + DECLARE + "export const a = appPrivileges(pgTable('items', { id: integer('id') }), ['udpate'] as never);\n"],
        ]],
    ])('R6: %s: the run stops before drizzle-kit, and no manifest is written', async (_case, files) =>
    {
        files.forEach(([name, source]) => entity(name, source));

        await expect(dbGenerate()).rejects.toThrow('process.exit(1)');

        expect(runDrizzleKit).not.toHaveBeenCalled();
        expect(existsSync(join(root, 'src', 'server', 'drizzle', 'privileges.json'))).toBe(false);
    });
});
