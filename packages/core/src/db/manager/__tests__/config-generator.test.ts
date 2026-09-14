/**
 * Config Generator Unit Tests
 *
 * Tests drizzle config schema discovery:
 * - the entities folder is scanned, barrel files excluded
 * - when the scan finds no entity file, the registry (config.ts) is loaded alone
 * - env DRIZZLE_SCHEMA_PATH names the registry file; when the scan finds files and the
 *   registry exists too, the registry is reported (schemaRegistry) for the CLI to check
 * - an explicit entry is expanded the way drizzle-kit expands it: a file as-is, a
 *   directory one level deep, a glob with glob syntax and literal parentheses,
 *   nothing filtered; a missing file yields nothing
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getDrizzleConfig } from '../config-generator';
import { toPosixPath } from '../path-utils';

const DB_URL = 'postgresql://user:pass@localhost:5432/testdb';
const SCAN_GLOB = './src/server/entities/**/*.ts';

function schemasOf(config: { schema: string | string[] }): string[]
{
    return Array.isArray(config.schema) ? config.schema : [config.schema];
}

function expanded(cwd: string, schema?: string | string[])
{
    return getDrizzleConfig({
        databaseUrl: DB_URL,
        cwd,
        schema,
        expandGlobs: true,
        disablePackageDiscovery: true,
    });
}

describe('getDrizzleConfig folder scan (no registry)', () =>
{
    let cwd: string;
    let entitiesDir: string;

    beforeEach(() =>
    {
        cwd = mkdtempSync(join(tmpdir(), 'spfn-config-gen-'));
        entitiesDir = join(cwd, 'src', 'server', 'entities');
        mkdirSync(join(entitiesDir, 'nested'), { recursive: true });

        writeFileSync(join(entitiesDir, 'user.entity.ts'), 'export const users = {};');
        writeFileSync(join(entitiesDir, 'nested', 'house.entity.ts'), 'export const houses = {};');
        writeFileSync(join(entitiesDir, 'nested', 'index.ts'), "export * from './house.entity';");
    });

    afterEach(() =>
    {
        rmSync(cwd, { recursive: true, force: true });
    });

    it('scans the entities folder recursively when the project has no registry', () =>
    {
        const config = expanded(cwd);
        const schemas = schemasOf(config);

        expect(schemas.some(s => s.endsWith('user.entity.ts'))).toBe(true);
        expect(schemas.some(s => s.endsWith('house.entity.ts'))).toBe(true);
        expect(schemas).toHaveLength(2);
        expect(config.schemaSource).toContain('scan');
    });

    it('keeps scanning the folder when a registry exists beside entity files', () =>
    {
        writeFileSync(join(entitiesDir, 'config.ts'), "export { users } from './user.entity';");

        const config = expanded(cwd);
        const schemas = schemasOf(config);

        expect(schemas).toHaveLength(2);
        expect(schemas.some(s => s.endsWith('config.ts'))).toBe(false);
        expect(config.schemaSource).toContain('scan');
    });

    it('excludes barrel files from the default scan (POSIX paths)', () =>
    {
        writeFileSync(join(entitiesDir, 'config.ts'), "export * from './user.entity';");

        const schemas = schemasOf(expanded(cwd));

        expect(schemas.some(s => s.endsWith('config.ts'))).toBe(false);
        expect(schemas.some(s => s.endsWith('index.ts'))).toBe(false);
        expect(schemas).toHaveLength(2);
        expect(new Set(schemas).size).toBe(schemas.length);
    });

    it('keeps barrel files in an explicit glob, as drizzle-kit does', () =>
    {
        const schemas = schemasOf(expanded(cwd, SCAN_GLOB));

        expect(schemas.some(s => s.endsWith('index.ts'))).toBe(true);
        expect(schemas).toHaveLength(3);
    });

    it('loads an explicitly named barrel as-is, the way drizzle-kit reads it', () =>
    {
        const barrel = join(entitiesDir, 'nested', 'index.ts');

        expect(schemasOf(expanded(cwd, barrel))).toEqual([barrel]);
    });

    it('loads an explicitly named entity file itself', () =>
    {
        const file = join(entitiesDir, 'user.entity.ts');

        expect(schemasOf(expanded(cwd, file))).toEqual([file]);
    });

    it('matches brace and multi-directory globs like drizzle-kit', () =>
    {
        expect(schemasOf(expanded(cwd, './src/server/entities/{user,missing}.entity.ts')))
            .toEqual([join(entitiesDir, 'user.entity.ts')]);
        expect(schemasOf(expanded(cwd, './src/**/*.entity.{ts,js}'))).toHaveLength(2);
        expect(schemasOf(expanded(cwd, './src/**/*'))).toHaveLength(3);
    });

    it('treats parentheses in a pattern or in the project path literally', () =>
    {
        const groupDir = join(cwd, 'src', 'server', '(workspace)', 'entities');
        mkdirSync(groupDir, { recursive: true });
        writeFileSync(join(groupDir, 'order.entity.ts'), 'export const orders = {};');

        expect(schemasOf(expanded(cwd, './src/server/(workspace)/entities/*.ts')))
            .toEqual([join(groupDir, 'order.entity.ts')]);
        expect(schemasOf(expanded(cwd, './src/server/(workspace)/entities')))
            .toEqual([join(groupDir, 'order.entity.ts')]);

        const parenCwd = join(cwd, 'Projects (2026)');
        const parenEntities = join(parenCwd, 'src', 'server', 'entities');
        mkdirSync(parenEntities, { recursive: true });
        writeFileSync(join(parenEntities, 'a.entity.ts'), 'export const a = {};');

        expect(schemasOf(expanded(parenCwd))).toEqual([join(parenEntities, 'a.entity.ts')]);
    });

    it('lists an explicitly named directory one level deep, as drizzle-kit does', () =>
    {
        const schemas = schemasOf(expanded(cwd, './src/server/entities'));

        expect(schemas).toEqual([join(entitiesDir, 'user.entity.ts')]);
    });

    it('reads an explicit glob only as deep as the pattern reaches, like drizzle-kit', () =>
    {
        writeFileSync(join(cwd, 'top.entity.ts'), 'export const top = {};');
        mkdirSync(join(cwd, '.next', 'cache'), { recursive: true });
        writeFileSync(join(cwd, '.next', 'cache', 'built.entity.ts'), 'export const built = {};');
        mkdirSync(join(cwd, 'node_modules', 'dep'), { recursive: true });
        writeFileSync(join(cwd, 'node_modules', 'dep', 'dep.entity.ts'), 'export const dep = {};');

        expect(schemasOf(expanded(cwd, '*.entity.ts'))).toEqual([join(cwd, 'top.entity.ts')]);
        expect(schemasOf(expanded(cwd, 'src/*/entities/*.entity.ts')))
            .toEqual([join(entitiesDir, 'user.entity.ts')]);
        // drizzle-kit's glob runs with dot: false, so dot-directories are skipped there too;
        // node_modules is skipped on purpose
        const deep = schemasOf(expanded(cwd, '**/*.entity.ts'));

        expect(deep.some(s => s.includes('.next'))).toBe(false);
        expect(deep.some(s => s.includes('node_modules'))).toBe(false);
    });

    it('follows a symlinked file and a symlinked directory one level deep, like drizzle-kit', () =>
    {
        mkdirSync(join(cwd, 'shared', 'deep'), { recursive: true });
        writeFileSync(join(cwd, 'shared', 'target.ts'), 'export const shared = {};');
        writeFileSync(join(cwd, 'shared', 'deep', 'deeper.ts'), 'export const deeper = {};');
        symlinkSync(join(cwd, 'shared', 'target.ts'), join(entitiesDir, 'linked.entity.ts'));
        symlinkSync(join(cwd, 'shared'), join(entitiesDir, 'shared'));
        symlinkSync(entitiesDir, join(cwd, 'shared', 'loop'));

        const schemas = schemasOf(expanded(cwd));

        expect(schemas.some(s => s.endsWith('linked.entity.ts'))).toBe(true);
        expect(schemas.some(s => s.endsWith(join('shared', 'target.ts')))).toBe(true);
        expect(schemas.some(s => s.endsWith('deeper.ts'))).toBe(false);
        expect(schemas.length).toBe(4);
    });

    it('lists a directory reached through a symlink and through its real path both', () =>
    {
        mkdirSync(join(entitiesDir, 'b', 'models'), { recursive: true });
        writeFileSync(join(entitiesDir, 'b', 'models', 'x.entity.ts'), 'export const x = {};');
        mkdirSync(join(entitiesDir, 'a'));
        symlinkSync(join(entitiesDir, 'b', 'models'), join(entitiesDir, 'a', 'aliasdir'));

        expect(schemasOf(expanded(cwd, './src/server/entities/*/models/*.ts')))
            .toEqual([join(entitiesDir, 'b', 'models', 'x.entity.ts')]);
    });

    it('reads the directories a glob matches one level deep, as drizzle-kit does', () =>
    {
        expect(schemasOf(expanded(cwd, './src/*/entities')))
            .toEqual([join(entitiesDir, 'user.entity.ts')]);
    });

    it.skipIf(process.getuid?.() === 0)('skips a directory it cannot read instead of throwing', () =>
    {
        mkdirSync(join(entitiesDir, 'locked'));
        writeFileSync(join(entitiesDir, 'locked', 'secret.entity.ts'), 'export const secret = {};');
        chmodSync(join(entitiesDir, 'locked'), 0o000);

        try
        {
            expect(schemasOf(expanded(cwd))).toHaveLength(2);
        }
        finally
        {
            chmodSync(join(entitiesDir, 'locked'), 0o755);
        }
    });

    it('accepts every extension drizzle-kit accepts and skips declaration files', () =>
    {
        writeFileSync(join(entitiesDir, 'report.entity.mts'), 'export const reports = {};');
        writeFileSync(join(entitiesDir, 'types.d.ts'), 'export type X = {};');
        writeFileSync(join(entitiesDir, 'legacy.d.mts'), 'export type Y = {};');

        const schemas = schemasOf(expanded(cwd, './src/server/entities'));

        expect(schemas).toEqual([join(entitiesDir, 'report.entity.mts'), join(entitiesDir, 'user.entity.ts')]);
    });

    it('skips a dangling symlink in an explicitly named directory', () =>
    {
        symlinkSync(join(cwd, 'removed.entity.ts'), join(entitiesDir, 'old.entity.ts'));

        expect(schemasOf(expanded(cwd, './src/server/entities'))).toEqual([join(entitiesDir, 'user.entity.ts')]);
    });
});

describe('getDrizzleConfig entity registry', () =>
{
    let cwd: string;
    let entitiesDir: string;
    let workspaceDir: string;

    beforeEach(() =>
    {
        cwd = mkdtempSync(join(tmpdir(), 'spfn-config-gen-'));
        entitiesDir = join(cwd, 'src', 'server', 'entities');
        workspaceDir = join(cwd, 'src', 'server', '(workspace)', 'entities');
        mkdirSync(entitiesDir, { recursive: true });
        mkdirSync(workspaceDir, { recursive: true });

        // Tables outside the scanned folder; the folder holds only the registry
        writeFileSync(join(workspaceDir, 'billing.entity.ts'), 'export const invoices = {};');
        writeFileSync(join(entitiesDir, 'config.ts'), "export * from '../(workspace)/entities/billing.entity';");
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        rmSync(cwd, { recursive: true, force: true });
    });

    it('loads the registry alone when the folder scan finds no entity file', () =>
    {
        const config = expanded(cwd);

        expect(schemasOf(config)).toEqual([join(entitiesDir, 'config.ts')]);
        expect(config.schemaSource).toBe('entity registry ./src/server/entities/config.ts');
        expect(config.schemaRegistry).toBeUndefined();
    });

    it('ignores a nested barrel-only folder the same way', () =>
    {
        mkdirSync(join(entitiesDir, 'nested'));
        writeFileSync(join(entitiesDir, 'nested', 'index.ts'), "export * from '../config';");

        expect(schemasOf(expanded(cwd))).toEqual([join(entitiesDir, 'config.ts')]);
    });

    it('names the registry file through env DRIZZLE_SCHEMA_PATH', () =>
    {
        mkdirSync(join(cwd, 'src', 'db'), { recursive: true });
        writeFileSync(join(cwd, 'src', 'db', 'schema.ts'), "export * from '../server/(workspace)/entities/billing.entity';");
        vi.stubEnv('DRIZZLE_SCHEMA_PATH', './src/db/schema.ts');

        const config = expanded(cwd);

        expect(schemasOf(config)).toEqual([join(cwd, 'src', 'db', 'schema.ts')]);
        expect(config.schemaSource).toBe('entity registry ./src/db/schema.ts');
    });

    it('picks the folder scan when it finds a file, and reports the registry for the CLI to check', () =>
    {
        writeFileSync(join(entitiesDir, 'legacy.entity.ts'), 'export const legacy = {};');

        const config = expanded(cwd);

        expect(schemasOf(config)).toEqual([join(entitiesDir, 'legacy.entity.ts')]);
        expect(config.schemaRegistry).toBe('./src/server/entities/config.ts');
    });

    it('reports no registry when the project has none', () =>
    {
        rmSync(join(entitiesDir, 'config.ts'));
        writeFileSync(join(entitiesDir, 'user.entity.ts'), 'export const users = {};');

        expect(expanded(cwd).schemaRegistry).toBeUndefined();
    });

    it('reports nothing when neither entity files nor a registry exist', () =>
    {
        rmSync(join(entitiesDir, 'config.ts'));

        const config = expanded(cwd);

        expect(schemasOf(config)).toEqual([]);
        expect(config.schemaSource).toContain('scan');
    });

    it('keeps the unexpanded registry path when globs are not expanded', () =>
    {
        const config = getDrizzleConfig({ databaseUrl: DB_URL, cwd, disablePackageDiscovery: true });

        expect(config.schema).toBe('./src/server/entities/config.ts');
    });
});

describe('getDrizzleConfig packageFilter', () =>
{
    it('filters package schemas by packageFilter, also from a project path with brackets', () =>
    {
        const cwd = join(mkdtempSync(join(tmpdir(), 'spfn-config-gen-')), '[work]', 'app');
        const pkgDir = join(cwd, 'node_modules', '@spfn', 'fake-pkg');
        mkdirSync(join(pkgDir, 'entities'), { recursive: true });
        writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
            name: '@spfn/fake-pkg',
            spfn: { schemas: ['entities/*.ts'] },
        }));
        writeFileSync(join(pkgDir, 'entities', 'thing.entity.ts'), 'export const things = {};');

        const config = getDrizzleConfig({
            databaseUrl: DB_URL,
            cwd,
            packageFilter: '@spfn/fake-pkg',
        });

        const schemas = schemasOf(config);

        expect(schemas).toHaveLength(1);
        expect(schemas[0].endsWith('thing.entity.ts')).toBe(true);

        rmSync(join(cwd, '..', '..'), { recursive: true, force: true });
    });
});

describe('toPosixPath', () =>
{
    it('normalizes Windows separators to forward slashes', () =>
    {
        expect(toPosixPath('C:\\proj\\src\\server\\entities\\config.ts'))
            .toBe('C:/proj/src/server/entities/config.ts');
    });

    it('leaves POSIX paths unchanged', () =>
    {
        expect(toPosixPath('/proj/src/server/entities/user.entity.ts'))
            .toBe('/proj/src/server/entities/user.entity.ts');
    });
});
