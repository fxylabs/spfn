/**
 * The whole-app env list.
 *
 * Two halves are pinned here. Loading: the app's own schema modules come from
 * `spfn.config.js` `env.schemas` — TypeScript with path aliases included — and
 * a wrong path or a module without `envSchema` is an error that names the
 * path; installed `@spfn/*` packages join when their `./config` exports
 * `envSchema`. Merging: a key declared twice alike is one entry, a key declared
 * with a different type, `required`, `sensitive` or `layer` is an error naming both
 * sources, and the list groups entries by the source that declared them first.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
    groupBySource,
    loadAppSchemas,
    loadEnvList,
    mergeEnvSources,
    type EnvSource,
} from '../env-list.js';
import type { EnvSchemaEntry } from '../env-schema.js';

let appDir: string;

function write(path: string, content: string): void
{
    const fullPath = join(appDir, path);

    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
}

function writeAppConfig(config: Record<string, unknown>): void
{
    write('spfn.config.js', `export default ${JSON.stringify(config)};\n`);
}

/** An installed package with the given exports map and files. */
function installPackage(name: string, exports: Record<string, string>, files: Record<string, string> = {}): void
{
    write(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '0.0.0-test', type: 'module', exports }));

    for (const [file, source] of Object.entries(files))
    {
        write(`node_modules/${name}/${file}`, source);
    }
}

function entry(key: string, overrides: Partial<EnvSchemaEntry> = {}): EnvSchemaEntry
{
    return { key, type: 'string', description: `${key} description`, ...overrides };
}

function source(name: string, entries: EnvSchemaEntry[]): EnvSource
{
    return { name, schema: Object.fromEntries(entries.map((value) => [value.key, value])) };
}

beforeEach(() =>
{
    appDir = mkdtempSync(join(tmpdir(), 'spfn-env-list-'));
    write('package.json', JSON.stringify({ name: 'an-app', type: 'module' }));
});

afterEach(() =>
{
    rmSync(appDir, { recursive: true, force: true });
});

describe('the app\'s own schemas (spfn.config.js env.schemas)', () =>
{
    it('loads a TypeScript module that imports through a tsconfig path alias', async () =>
    {
        write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }));
        write('src/server/config/descriptions.ts', 'export const tokenDescription: string = \'API token for the billing provider\';\n');
        write('src/server/config/env.config.ts', [
            'import { tokenDescription } from \'@/server/config/descriptions\';',
            '',
            'interface Entry { key: string; type: \'string\'; description: string; required?: boolean; sensitive?: boolean }',
            '',
            'export const envSchema: Record<string, Entry> = {',
            '    BILLING_TOKEN: { key: \'BILLING_TOKEN\', type: \'string\', description: tokenDescription, required: true, sensitive: true },',
            '};',
            '',
        ].join('\n'));
        writeAppConfig({ env: { schemas: ['src/server/config/env.config.ts'] } });

        const sources = await loadAppSchemas(appDir);

        expect(sources.map((value) => value.name)).toEqual(['src/server/config/env.config.ts']);
        expect(sources[0]?.schema.BILLING_TOKEN?.description).toBe('API token for the billing provider');
    });

    it('names the path of a schema module that does not exist', async () =>
    {
        writeAppConfig({ env: { schemas: ['src/server/config/missing.ts'] } });

        await expect(loadAppSchemas(appDir)).rejects.toThrow('src/server/config/missing.ts does not exist');
    });

    it('names the path of a module that does not export envSchema', async () =>
    {
        write('src/server/config/env.config.ts', 'export const schema = {};\n');
        writeAppConfig({ env: { schemas: ['src/server/config/env.config.ts'] } });

        await expect(loadAppSchemas(appDir)).rejects.toThrow('src/server/config/env.config.ts does not export envSchema');
    });

    it('is empty when spfn.config.js names no schemas, as before the setting existed', async () =>
    {
        writeAppConfig({ ports: { server: 8790 } });

        expect(await loadAppSchemas(appDir)).toEqual([]);
    });
});

describe('merging sources', () =>
{
    it('keeps one entry for a key two sources declare identically', () =>
    {
        const list = mergeEnvSources([
            source('@spfn/alpha', [entry('SHARED_URL', { required: true })]),
            source('@spfn/beta', [entry('SHARED_URL', { required: true, description: 'worded differently' })]),
        ]);

        expect(Object.keys(list.schema)).toEqual(['SHARED_URL']);
        expect(list.declaredBy.SHARED_URL).toEqual(['@spfn/alpha', '@spfn/beta']);
    });

    it('is an error naming the key and both sources when the value types differ', () =>
    {
        const merge = () => mergeEnvSources([
            source('@spfn/alpha', [entry('RETRY_LIMIT', { type: 'number' })]),
            source('src/server/config/env.config.ts', [entry('RETRY_LIMIT', { type: 'string' })]),
        ]);

        expect(merge).toThrow('RETRY_LIMIT: @spfn/alpha declares "number" (optional), '
            + 'src/server/config/env.config.ts declares "string" (optional)');
    });

    it('is an error when one source says url and the other string — no type is equivalent to another', () =>
    {
        const merge = () => mergeEnvSources([
            source('@spfn/alpha', [entry('API_URL', { type: 'url' })]),
            source('@spfn/beta', [entry('API_URL', { type: 'string' })]),
        ]);

        expect(merge).toThrow('API_URL: @spfn/alpha declares "url" (optional), @spfn/beta declares "string" (optional)');
    });

    it('is an error, not a merge to the stricter flag, when only required differs', () =>
    {
        const merge = () => mergeEnvSources([
            source('@spfn/alpha', [entry('API_URL', { required: true })]),
            source('@spfn/beta', [entry('API_URL')]),
        ]);

        expect(merge).toThrow('API_URL: @spfn/alpha declares "string" (required), @spfn/beta declares "string" (optional)');
    });

    it('is an error when only sensitive differs', () =>
    {
        const merge = () => mergeEnvSources([
            source('@spfn/alpha', [entry('SIGNING_KEY', { sensitive: true })]),
            source('@spfn/beta', [entry('SIGNING_KEY')]),
        ]);

        expect(merge).toThrow('SIGNING_KEY: @spfn/alpha declares "string" (optional, sensitive), '
            + '@spfn/beta declares "string" (optional)');
    });

    it('is an error when only layer differs, and an unset layer is environment', () =>
    {
        const merge = () => mergeEnvSources([
            source('@spfn/alpha', [entry('DB_NAME', { layer: 'instance' })]),
            source('@spfn/beta', [entry('DB_NAME')]),
        ]);

        expect(merge).toThrow('DB_NAME: @spfn/alpha declares "string" (optional, instance layer), '
            + '@spfn/beta declares "string" (optional)');
        expect(() => mergeEnvSources([
            source('@spfn/alpha', [entry('API_KEY', { layer: 'environment' })]),
            source('@spfn/beta', [entry('API_KEY')]),
        ])).not.toThrow();
    });

    it('names every disagreeing key in one error', () =>
    {
        const merge = () => mergeEnvSources([
            source('@spfn/alpha', [entry('FIRST', { required: true }), entry('SECOND', { type: 'number' })]),
            source('@spfn/beta', [entry('FIRST'), entry('SECOND')]),
        ]);

        expect(merge).toThrow(/FIRST: [\s\S]*SECOND: /);
    });

    it('groups entries under the source that declares them first', () =>
    {
        const list = mergeEnvSources([
            source('src/server/config/env.config.ts', [entry('APP_SECRET'), entry('SHARED_URL')]),
            source('@spfn/alpha', [entry('SHARED_URL'), entry('ALPHA_KEY')]),
            source('@spfn/beta', [entry('SHARED_URL')]),
        ]);

        expect(groupBySource(list).map((group) => [group.source, group.entries.map((value) => value.key)])).toEqual([
            ['src/server/config/env.config.ts', ['APP_SECRET', 'SHARED_URL']],
            ['@spfn/alpha', ['ALPHA_KEY']],
        ]);
    });
});

describe('loadEnvList', () =>
{
    const alphaConfig = 'export const envSchema = { ALPHA_KEY: { key: \'ALPHA_KEY\', type: \'string\', description: \'alpha\', sensitive: true } };\n';

    beforeEach(() =>
    {
        write('package.json', JSON.stringify({
            name: 'an-app',
            type: 'module',
            dependencies: { '@spfn/alpha': '*', '@spfn/beta': '*', '@spfn/gamma': '*', 'left-pad': '*' },
        }));
        installPackage('@spfn/alpha', { './config': './config.js' }, { 'config.js': alphaConfig });
        installPackage('@spfn/beta', { '.': './index.js' }, { 'index.js': 'export {};\n' });
        installPackage('@spfn/gamma', { './config': './config.js' }, { 'config.js': 'export const env = {};\n' });
        write('src/server/config/env.config.js', 'export const envSchema = { APP_TOKEN: { key: \'APP_TOKEN\', type: \'string\', description: \'app\' } };\n');
        writeAppConfig({ env: { schemas: ['src/server/config/env.config.js'] } });
    });

    it('without -p: the app\'s schemas, then each installed @spfn/* package exporting envSchema', async () =>
    {
        const list = await loadEnvList({}, appDir);

        expect(list.sources.map((value) => value.name)).toEqual(['src/server/config/env.config.js', '@spfn/alpha']);
        expect(Object.keys(list.schema)).toEqual(['APP_TOKEN', 'ALPHA_KEY']);
    });

    it('with -p: that one package only', async () =>
    {
        const list = await loadEnvList({ package: '@spfn/alpha' }, appDir);

        expect(list.sources.map((value) => value.name)).toEqual(['@spfn/alpha']);
        expect(Object.keys(list.schema)).toEqual(['ALPHA_KEY']);
    });

    it('fails, naming the package, when a package config exists but cannot be imported', async () =>
    {
        installPackage('@spfn/alpha', { './config': './config.js' }, { 'config.js': 'throw new Error(\'broken on import\');\n' });

        await expect(loadEnvList({}, appDir)).rejects.toThrow('Failed to load package @spfn/alpha: broken on import');
    });
});
