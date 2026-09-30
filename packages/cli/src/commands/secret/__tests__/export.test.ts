/**
 * `spfn secret export` — the case table, one test per row (E1–E9), run against
 * real `sops` and `age` with throwaway keys generated into a temp dir.
 *
 * Layers: the environment file `secrets/staging.enc.json`, the instance file
 * `secrets/staging.blue.enc.json`, and plaintext `--with` files. Every assertion
 * reads files or report text; no value is printed.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { parse } from 'dotenv';
import type { EnvSchema, EnvSchemaEntry } from '../../../utils/env-schema.js';
import { exportEnvFile, secretExport, type ExportReport, type ExportRequest } from '../export.js';

function entry(key: string, overrides: Partial<EnvSchemaEntry> = {}): EnvSchemaEntry
{
    return { key, type: 'string', description: key, ...overrides };
}

function parsePort(value: string): number
{
    if (!/^\d+$/.test(value))
    {
        throw new Error('Must be a valid number');
    }

    return Number(value);
}

const SCHEMA: EnvSchema = {
    API_KEY: entry('API_KEY', { required: true, sensitive: true }),
    ANALYTICS_KEY: entry('ANALYTICS_KEY', { sensitive: true }),
    DB_NAME: entry('DB_NAME', { required: true, layer: 'instance' }),
    PORT: entry('PORT', { type: 'number', required: true, layer: 'instance', validator: parsePort }),
    INSTANCE_TOKEN: entry('INSTANCE_TOKEN', { sensitive: true, layer: 'instance' }),
    LOG_FORMAT: entry('LOG_FORMAT', { required: true, default: 'json' }),
};

let keysDir: string;
let goodKey: string;
let otherKey: string;
let dir: string;

beforeAll(async () =>
{
    keysDir = mkdtempSync(join(tmpdir(), 'spfn-export-keys-'));
    goodKey = join(keysDir, 'good.txt');
    otherKey = join(keysDir, 'other.txt');
    await execa('age-keygen', ['-o', goodKey]);
    await execa('age-keygen', ['-o', otherKey]);
});

afterAll(() =>
{
    rmSync(keysDir, { recursive: true, force: true });
});

beforeEach(async () =>
{
    dir = mkdtempSync(join(tmpdir(), 'spfn-export-'));
    const { stdout: recipient } = await execa('age-keygen', ['-y', goodKey]);
    writeFileSync(join(dir, '.sops.yaml'), `creation_rules:\n  - path_regex: secrets/.*\\.enc\\.json$\n    age: ${recipient}\n`);
    vi.stubEnv('SOPS_AGE_KEY_FILE', goodKey);
});

afterEach(() =>
{
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
});

/** Encrypt values into `secrets/<name>.enc.json` under the `.sops.yaml` rule. */
async function encrypt(name: string, values: Record<string, string>): Promise<void>
{
    const relFile = `secrets/${name}.enc.json`;
    const { stdout } = await execa(
        'sops',
        ['encrypt', '--input-type', 'json', '--output-type', 'json', '--filename-override', relFile],
        { cwd: dir, input: JSON.stringify(values) },
    );

    mkdirSync(join(dir, 'secrets'), { recursive: true });
    writeFileSync(join(dir, relFile), stdout);
}

function writePlain(relFile: string, content: string): void
{
    mkdirSync(dirname(join(dir, relFile)), { recursive: true });
    writeFileSync(join(dir, relFile), content);
}

function request(overrides: Partial<ExportRequest> = {}): ExportRequest
{
    return {
        cwd: dir,
        target: { env: 'staging', instance: 'blue' },
        schema: SCHEMA,
        withFiles: ['computed.env'],
        out: 'out/app.env',
        ...overrides,
    };
}

function outPath(): string
{
    return join(dir, 'out/app.env');
}

function reportText(report: ExportReport): string
{
    return [...report.errors, ...report.warnings].join('\n');
}

/** A complete, valid deployment: every required name in its own layer. */
async function writeValidLayers(): Promise<void>
{
    await encrypt('staging', { API_KEY: 'value-one' });
    await encrypt('staging.blue', { INSTANCE_TOKEN: 'value-two' });
    writePlain('computed.env', 'DB_NAME=app_blue\nPORT=4100\n');
    mkdirSync(join(dir, 'out'));
}

describe('spfn secret export — case table', () =>
{
    it('E1: a required name in no layer fails, names it, and writes nothing', async () =>
    {
        await writeValidLayers();
        await encrypt('staging', { ANALYTICS_KEY: 'value-three' });

        const report = await exportEnvFile(request());

        expect(report.written).toBe(false);
        expect(report.errors).toEqual(['API_KEY: required, and in none of the layers']);
        expect(existsSync(outPath())).toBe(false);
    });

    it('E2: a name in two layers fails, naming it and both layers', async () =>
    {
        await writeValidLayers();
        writePlain('computed.env', 'DB_NAME=app_blue\nPORT=4100\nINSTANCE_TOKEN=value-four\n');

        const report = await exportEnvFile(request());

        expect(report.written).toBe(false);
        expect(report.errors).toEqual(['INSTANCE_TOKEN: in more than one layer: instance and --with computed.env']);
        expect(existsSync(outPath())).toBe(false);
    });

    it('E2: a --with name that is also in the environment file is not a silent override', async () =>
    {
        await writeValidLayers();
        writePlain('computed.env', 'DB_NAME=app_blue\nPORT=4100\nAPI_KEY=value-five\n');

        const report = await exportEnvFile(request());

        expect(report.errors).toEqual(['API_KEY: in more than one layer: environment and --with computed.env']);
        expect(existsSync(outPath())).toBe(false);
    });

    it('E3: an instance-layer name in the environment file fails', async () =>
    {
        await writeValidLayers();
        await encrypt('staging', { API_KEY: 'value-one', INSTANCE_TOKEN: 'value-six' });
        await encrypt('staging.blue', {});

        const report = await exportEnvFile(request());

        expect(report.errors).toEqual(['INSTANCE_TOKEN: declared with layer "instance", but found in environment']);
        expect(existsSync(outPath())).toBe(false);
    });

    it('E4: an environment-layer name in a --with file fails', async () =>
    {
        await writeValidLayers();
        await encrypt('staging', {});
        writePlain('computed.env', 'DB_NAME=app_blue\nPORT=4100\nAPI_KEY=value-one\n');

        const report = await exportEnvFile(request());

        expect(report.errors).toEqual(['API_KEY: declared with layer "environment", but found in --with computed.env']);
        expect(existsSync(outPath())).toBe(false);
    });

    it('E5: a name in an encrypted file but not in the list is warned about by name and not written', async () =>
    {
        await writeValidLayers();
        await encrypt('staging', { API_KEY: 'value-one', RETIRED_KEY: 'value-seven' });

        const report = await exportEnvFile(request());

        expect(report.written).toBe(true);
        expect(report.warnings).toEqual(['RETIRED_KEY (in environment) is not in the env list — not written']);
        expect(reportText(report)).not.toContain('value-seven');
        expect(parse(readFileSync(outPath()))).not.toHaveProperty('RETIRED_KEY');
    });

    it('E6: a value failing its validator fails with name and reason, never the value', async () =>
    {
        await writeValidLayers();
        writePlain('computed.env', 'DB_NAME=app_blue\nPORT=port-value-eight\n');

        const report = await exportEnvFile(request());

        expect(report.errors).toEqual(['PORT: Must be a valid number']);
        expect(reportText(report)).not.toContain('port-value-eight');
        expect(existsSync(outPath())).toBe(false);
    });

    it('E6: a validator message that quotes the value is withheld', async () =>
    {
        await writeValidLayers();
        const schema = {
            ...SCHEMA,
            API_KEY: entry('API_KEY', {
                required: true,
                validator: (value: string) =>
                {
                    throw new Error(`bad key ${value}`);
                },
            }),
        };

        const report = await exportEnvFile(request({ schema }));

        expect(report.errors).toHaveLength(1);
        expect(report.errors[0]).toMatch(/^API_KEY: rejected by its validator/);
        expect(reportText(report)).not.toContain('value-one');
    });

    it('E7: an optional name in no layer is not written', async () =>
    {
        await writeValidLayers();

        const report = await exportEnvFile(request());

        expect(report.written).toBe(true);
        expect(Object.keys(parse(readFileSync(outPath())))).not.toContain('ANALYTICS_KEY');
        expect(Object.keys(parse(readFileSync(outPath())))).not.toContain('LOG_FORMAT');
    });

    it('E8: decryption without key access fails, writes nothing, and leaves an existing --out untouched', async () =>
    {
        await writeValidLayers();
        writeFileSync(outPath(), 'PREVIOUS=1\n', { mode: 0o644 });
        vi.stubEnv('SOPS_AGE_KEY_FILE', otherKey);

        const failure = await exportEnvFile(request()).then(() => undefined, (error: Error) => error);

        expect(failure?.message).toMatch(/sops could not decrypt .*staging\.enc\.json/);
        expect(failure?.message).not.toContain('value-one');
        expect(readFileSync(outPath(), 'utf-8')).toBe('PREVIOUS=1\n');
        expect(statSync(outPath()).mode & 0o777).toBe(0o644);
        expect(readdirSync(join(dir, 'out'))).toEqual(['app.env']);
    });

    it('E9: all pass — written by rename, mode 0600, content is exactly the merged names', async () =>
    {
        await writeValidLayers();
        writeFileSync(outPath(), 'PREVIOUS=1\n', { mode: 0o644 });

        const report = await exportEnvFile(request());

        expect(report).toEqual({
            written: true,
            errors: [],
            warnings: [],
            origins: {
                API_KEY: 'environment',
                INSTANCE_TOKEN: 'instance',
                DB_NAME: '--with computed.env',
                PORT: '--with computed.env',
            },
        });
        expect(parse(readFileSync(outPath()))).toEqual({
            API_KEY: 'value-one',
            INSTANCE_TOKEN: 'value-two',
            DB_NAME: 'app_blue',
            PORT: '4100',
        });
        expect(statSync(outPath()).mode & 0o777).toBe(0o600);
        expect(readdirSync(join(dir, 'out'))).toEqual(['app.env']);
    });
});

describe('spfn secret export — options', () =>
{
    it('refuses to run without --out', async () =>
    {
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(secretExport({ env: 'staging' })).rejects.toThrow('exit 1');
        expect(exit).toHaveBeenCalledWith(1);
    });

    it('with --instance and no instance file, merges only the environment file and --with', async () =>
    {
        await writeValidLayers();
        rmSync(join(dir, 'secrets/staging.blue.enc.json'));

        const report = await exportEnvFile(request());

        expect(report.written).toBe(true);
        expect(Object.values(report.origins)).not.toContain('instance');
        expect(Object.keys(parse(readFileSync(outPath()))).sort()).toEqual(['API_KEY', 'DB_NAME', 'PORT']);
    });

    it('resolves relative --out and --with from the working directory', async () =>
    {
        await writeValidLayers();
        writePlain('deploy/computed.env', 'DB_NAME=app_blue\nPORT=4100\n');

        const report = await exportEnvFile(request({ withFiles: ['deploy/computed.env'], out: 'out/../out/app.env' }));

        expect(report.origins.PORT).toBe('--with deploy/computed.env');
        expect(existsSync(outPath())).toBe(true);
    });

    it('fails clearly when the --out directory does not exist', async () =>
    {
        await writeValidLayers();

        await expect(exportEnvFile(request({ out: 'missing/app.env' }))).rejects.toThrow(/--out: directory .*missing does not exist/);
    });

    it('fails clearly when a --with file does not exist', async () =>
    {
        await writeValidLayers();

        await expect(exportEnvFile(request({ withFiles: ['absent.env'] }))).rejects.toThrow(/--with file not found: .*absent\.env/);
    });
});
