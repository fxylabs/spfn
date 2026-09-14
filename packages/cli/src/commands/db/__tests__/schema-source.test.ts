/**
 * `db push` schema source resolution
 *
 * push must read the schema the way `db generate` does: --schema, then
 * drizzle.config.ts (schema and schemaFilter), then the core default.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pgSchema, pgTable, integer } from 'drizzle-orm/pg-core';
import { getDrizzleConfig } from '@spfn/core/db';
import {
    resolvePushSchemaSource,
    readDrizzleConfigSchema,
    resolvePushSchemaFilter,
    resolveSchemaFiles,
    withoutFunctionPackageObjects,
    generateTempConfig,
} from '../utils/drizzle.js';

const DB = 'postgresql://user:pass@localhost:5432/testdb';

const table = (name: string) =>
    `import { pgTable, integer } from 'drizzle-orm/pg-core';\nexport const ${name} = pgTable('${name}', { id: integer('id') });\n`;

describe('resolvePushSchemaSource', () =>
{
    let cwd: string;

    beforeEach(() =>
    {
        cwd = mkdtempSync(join(tmpdir(), 'spfn-push-schema-'));
    });

    afterEach(() =>
    {
        rmSync(cwd, { recursive: true, force: true });
    });

    it('leaves the default resolution to core when there is no drizzle.config.ts', async () =>
    {
        expect(await resolvePushSchemaSource(undefined, cwd)).toBeUndefined();
    });

    it('reads schema and schemaFilter from drizzle.config.ts', async () =>
    {
        writeFileSync(join(cwd, 'drizzle.config.ts'),
            "export default { schema: './src/server/schema/registry.ts', schemaFilter: ['app'], dialect: 'postgresql' };");

        expect(await readDrizzleConfigSchema(cwd))
            .toEqual({ schema: './src/server/schema/registry.ts', schemaFilter: ['app'] });

        expect(await resolvePushSchemaSource(undefined, cwd))
            .toEqual({ schema: './src/server/schema/registry.ts', schemaFilter: ['app'], label: 'drizzle.config.ts' });
    });

    it('accepts the string form of schemaFilter that drizzle-kit accepts', async () =>
    {
        writeFileSync(join(cwd, 'drizzle.config.ts'), "export default { schema: './s.ts', schemaFilter: 'app' };");

        expect(await readDrizzleConfigSchema(cwd)).toEqual({ schema: './s.ts', schemaFilter: ['app'] });
    });

    it('unwraps a CommonJS-compiled config ({ default: { default } })', async () =>
    {
        writeFileSync(join(cwd, 'drizzle.config.ts'),
            "module.exports = { default: { schema: './src/schema.ts', schemaFilter: ['app'] } };");

        expect(await readDrizzleConfigSchema(cwd)).toEqual({ schema: './src/schema.ts', schemaFilter: ['app'] });
    });

    it('propagates a config that fails to load', async () =>
    {
        writeFileSync(join(cwd, 'drizzle.config.ts'), "throw new Error('DIRECT_URL required');");

        await expect(resolvePushSchemaSource(undefined, cwd)).rejects.toThrow('DIRECT_URL required');
    });

    it('ignores a drizzle.config.ts without a schema entry', async () =>
    {
        writeFileSync(join(cwd, 'drizzle.config.ts'), "export default { dialect: 'postgresql' };");

        expect(await resolvePushSchemaSource(undefined, cwd)).toBeUndefined();
    });

    it('lets --schema replace the files but keep a declared schemaFilter', async () =>
    {
        writeFileSync(join(cwd, 'drizzle.config.ts'), "export default { schema: './a.ts', schemaFilter: ['app'] };");

        expect(await resolvePushSchemaSource('./b.ts', cwd)).toEqual({ schema: './b.ts', schemaFilter: ['app'], label: '--schema' });
    });

    it('lets --schema bypass a drizzle.config.ts that cannot be loaded', async () =>
    {
        writeFileSync(join(cwd, 'drizzle.config.ts'), "throw new Error('DIRECT_URL required');");

        expect(await resolvePushSchemaSource('./b.ts', cwd)).toEqual({ schema: './b.ts', schemaFilter: undefined, label: '--schema' });
    });
});

describe('resolvePushSchemaFilter', () =>
{
    const audit = pgSchema('audit');
    const imports = {
        users: pgTable('users', { id: integer('id') }),
        auditLog: audit.table('log', { id: integer('id') }),
    };

    it('adds the schemas of the loaded tables to a declared filter, public included', () =>
    {
        expect(resolvePushSchemaFilter(['app'], imports)).toEqual(['app', 'public', 'audit']);
    });

    it('treats an empty declared filter as undeclared: drizzle-kit would diff every schema', () =>
    {
        expect(resolvePushSchemaFilter([], imports)).toEqual(['public', 'audit']);
    });

    it('sees a pgSchema that owns an enum or a sequence but no table', () =>
    {
        const billing = pgSchema('billing');
        const audit = pgSchema('audit');

        expect(resolvePushSchemaFilter(undefined, { billing, status: billing.enum('status', ['open']), seq: audit.sequence('invoice_no') }))
            .toEqual(['public', 'billing', 'audit']);
    });
});

describe('resolveSchemaFiles', () =>
{
    // Modules live inside the package so `drizzle-orm` resolves from them, and each
    // test gets its own directory because an imported module stays cached by path
    let root: string;
    let entities: string;
    let outside: string;

    beforeEach(() =>
    {
        root = mkdtempSync(join(__dirname, 'tmp-resolve-schema-'));
        entities = join(root, 'src', 'server', 'entities');
        outside = join(root, 'src', 'server', 'moved');
        mkdirSync(entities, { recursive: true });
        mkdirSync(outside, { recursive: true });
    });

    afterEach(() =>
    {
        rmSync(root, { recursive: true, force: true });
    });

    it('keeps the scan when every registry table is among the scanned files', async () =>
    {
        writeFileSync(join(entities, 'a.entity.ts'), table('a'));
        writeFileSync(join(entities, 'config.ts'), "export * from './a.entity';\n");

        const resolved = await resolveSchemaFiles(getDrizzleConfig({ databaseUrl: DB, cwd: root, expandGlobs: true, disablePackageDiscovery: true }), root);

        expect(resolved.files).toEqual([join(entities, 'a.entity.ts')]);
        expect(resolved.note).toBeUndefined();
    });

    it('loads the registry instead when it exports a table the scan lacks and the scan adds nothing', async () =>
    {
        writeFileSync(join(entities, 'a.entity.ts'), table('a'));
        writeFileSync(join(outside, 'b.entity.ts'), table('b'));
        writeFileSync(join(entities, 'config.ts'), "export * from './a.entity';\nexport * from '../moved/b.entity';\n");

        const resolved = await resolveSchemaFiles(getDrizzleConfig({ databaseUrl: DB, cwd: root, expandGlobs: true, disablePackageDiscovery: true }), root);

        expect(resolved.files).toEqual([join(entities, 'config.ts')]);
        expect(resolved.source).toBe('entity registry ./src/server/entities/config.ts');
        expect(resolved.note).toContain('exports b, which no file under src/server/entities/ defines');
        expect(Object.keys(resolved.imports ?? {}).sort()).toEqual(['a', 'b']);
    });

    it('stops when the folder and the registry each define what the other lacks', async () =>
    {
        writeFileSync(join(entities, 'legacy.entity.ts'), table('legacy'));
        writeFileSync(join(outside, 'b.entity.ts'), table('b'));
        writeFileSync(join(entities, 'config.ts'), "export * from '../moved/b.entity';\n");

        await expect(resolveSchemaFiles(getDrizzleConfig({ databaseUrl: DB, cwd: root, expandGlobs: true, disablePackageDiscovery: true }), root))
            .rejects.toThrow(/exports b which no file .* defines legacy which the registry does not export/);
    });

    it('counts a pgSchema object a folder file alone defines, so the conflict is reported', async () =>
    {
        writeFileSync(join(entities, 'audit-schema.ts'), "import { pgSchema } from 'drizzle-orm/pg-core';\nexport const auditSchema = pgSchema('audit');\n");
        writeFileSync(join(outside, 'b.entity.ts'), table('b'));
        writeFileSync(join(entities, 'config.ts'), "export * from '../moved/b.entity';\n");

        await expect(resolveSchemaFiles(getDrizzleConfig({ databaseUrl: DB, cwd: root, expandGlobs: true, disablePackageDiscovery: true }), root))
            .rejects.toThrow(/defines schema audit which the registry does not export/);
    });

    it('counts an enum only the registry reaches', async () =>
    {
        writeFileSync(join(entities, 'a.entity.ts'), table('a'));
        writeFileSync(join(outside, 'status.ts'), "import { pgEnum } from 'drizzle-orm/pg-core';\nexport const status = pgEnum('status', ['open']);\n");
        writeFileSync(join(entities, 'config.ts'), "export * from './a.entity';\nexport * from '../moved/status';\n");

        const resolved = await resolveSchemaFiles(getDrizzleConfig({ databaseUrl: DB, cwd: root, expandGlobs: true, disablePackageDiscovery: true }), root);

        expect(resolved.files).toEqual([join(entities, 'config.ts')]);
        expect(resolved.note).toContain('enum status');
    });

    it('loads nothing when the project has no registry', async () =>
    {
        writeFileSync(join(entities, 'a.entity.ts'), 'this is not valid typescript {{{');

        const resolved = await resolveSchemaFiles(getDrizzleConfig({ databaseUrl: DB, cwd: root, expandGlobs: true, disablePackageDiscovery: true }), root);

        expect(resolved.files).toEqual([join(entities, 'a.entity.ts')]);
        expect(resolved.imports).toBeUndefined();
    });
});

/**
 * A schema a function package owns — @spfn/mockfn → spfn_mockfn — belongs to the
 * package's own migrations. A registry re-exporting one of its tables for a
 * relation must not hand the rest of that schema to the project's push diff, nor
 * copy it into a project migration.
 */
describe('function package schemas', () =>
{
    const mockSchema = pgSchema('spfn_mockfn');
    const billing = pgSchema('billing');
    const imports = {
        profiles: pgTable('profiles', { id: integer('id') }),
        invoices: billing.table('invoices', { id: integer('id') }),
        users: mockSchema.table('users', { id: integer('id') }),
    };

    let cwd: string;

    /** A node_modules/@spfn/<name> that opts into migrations the way /tmp/rev8/G does */
    const installFunctionPackage = (root: string, name: string) =>
    {
        const packageDir = join(root, 'node_modules', '@spfn', name);

        mkdirSync(join(packageDir, 'migrations'), { recursive: true });
        writeFileSync(join(packageDir, 'migrations', '0000_init.sql'), '-- noop\n');
        writeFileSync(join(packageDir, 'package.json'),
            JSON.stringify({ name: `@spfn/${name}`, version: '1.0.0', spfn: { migrations: { dir: './migrations' } } }));
    };

    beforeEach(() =>
    {
        cwd = mkdtempSync(join(tmpdir(), 'spfn-function-package-'));
        installFunctionPackage(cwd, 'mockfn');
    });

    afterEach(() =>
    {
        rmSync(cwd, { recursive: true, force: true });
    });

    it('keeps a package schema out of the derived push filter, project schemas in', () =>
    {
        expect(resolvePushSchemaFilter(undefined, imports, cwd)).toEqual(['public', 'billing']);
    });

    it('leaves a declared schemaFilter verbatim, package schema and all', () =>
    {
        expect(resolvePushSchemaFilter(['spfn_mockfn'], imports, cwd)).toEqual(['spfn_mockfn', 'public', 'billing']);
    });

    it('derives the package schema again once the package ships no migrations', () =>
    {
        rmSync(join(cwd, 'node_modules'), { recursive: true, force: true });

        expect(resolvePushSchemaFilter(undefined, imports, cwd)).toEqual(['public', 'billing', 'spfn_mockfn']);
    });

    it('drops the package objects from the push imports, the pgSchema object included', () =>
    {
        expect(Object.keys(withoutFunctionPackageObjects({ ...imports, mockSchema, billing }, cwd)).sort())
            .toEqual(['billing', 'invoices', 'profiles']);
    });

    it('returns the imports untouched when no installed package ships migrations', () =>
    {
        rmSync(join(cwd, 'node_modules'), { recursive: true, force: true });

        expect(withoutFunctionPackageObjects(imports, cwd)).toBe(imports);
    });
});

/**
 * drizzle-kit `generate` loads the schema files itself and reads no schemaFilter,
 * so a file reaching a package's table would be copied into a project migration.
 */
describe('generateTempConfig', () =>
{
    let root: string;
    let entities: string;
    let outside: string;
    let previousCwd: string;

    beforeEach(() =>
    {
        previousCwd = process.cwd();
        root = mkdtempSync(join(__dirname, 'tmp-temp-config-'));
        entities = join(root, 'src', 'server', 'entities');
        outside = join(root, 'src', 'server', 'moved');
        mkdirSync(entities, { recursive: true });
        mkdirSync(outside, { recursive: true });
        mkdirSync(join(root, 'node_modules', '@spfn', 'mockfn', 'migrations'), { recursive: true });
        writeFileSync(join(root, 'node_modules', '@spfn', 'mockfn', 'migrations', '0000_init.sql'), '-- noop\n');
        writeFileSync(join(root, 'node_modules', '@spfn', 'mockfn', 'package.json'),
            JSON.stringify({ name: '@spfn/mockfn', version: '1.0.0', spfn: { migrations: { dir: './migrations' } } }));
        writeFileSync(join(root, 'node_modules', '@spfn', 'mockfn', 'entities.js'),
            "import { pgSchema, integer } from 'drizzle-orm/pg-core';\n"
            + "export const mockSchema = pgSchema('spfn_mockfn');\n"
            + "export const users = mockSchema.table('users', { id: integer('id') });\n");
        process.env.DATABASE_URL = DB;
        process.chdir(root);
    });

    afterEach(() =>
    {
        process.chdir(previousCwd);
        rmSync(root, { recursive: true, force: true });
    });

    it('refuses when the registry the schema falls back to re-exports a package table', async () =>
    {
        writeFileSync(join(outside, 'profile.entity.ts'), table('profiles'));
        writeFileSync(join(entities, 'config.ts'),
            "export * from '../moved/profile.entity';\nexport { users } from '../../../node_modules/@spfn/mockfn/entities.js';\n");

        await expect(generateTempConfig({ reconcile: true }))
            .rejects.toThrow(/reaches users \(@spfn\/mockfn\), which the package migrates itself/);
    });

    it('refuses over the package pgSchema object alone', async () =>
    {
        writeFileSync(join(outside, 'profile.entity.ts'), table('profiles'));
        writeFileSync(join(entities, 'config.ts'),
            "export * from '../moved/profile.entity';\n"
            + "export { mockSchema } from '../../../node_modules/@spfn/mockfn/entities.js';\n");

        await expect(generateTempConfig({ reconcile: true }))
            .rejects.toThrow(/reaches schema spfn_mockfn \(@spfn\/mockfn\)/);
    });

    it('writes the folder scan for the scaffold layout, package installed or not', async () =>
    {
        writeFileSync(join(entities, 'a.entity.ts'), table('a'));
        writeFileSync(join(entities, 'config.ts'), "export * from './a.entity';\n");

        const rendered = await generateTempConfig({ reconcile: true });

        expect(rendered).toContain(join(entities, 'a.entity.ts'));
        expect(rendered).not.toContain('config.ts');
    });

    it('keeps a project-owned pgSchema in the registry it falls back to', async () =>
    {
        writeFileSync(join(outside, 'billing.entity.ts'),
            "import { pgSchema, integer } from 'drizzle-orm/pg-core';\n"
            + "export const billing = pgSchema('billing');\n"
            + "export const invoices = billing.table('invoices', { id: integer('id') });\n");
        writeFileSync(join(entities, 'config.ts'), "export * from '../moved/billing.entity';\n");

        expect(await generateTempConfig({ reconcile: true })).toContain(join(entities, 'config.ts'));
    });
});
