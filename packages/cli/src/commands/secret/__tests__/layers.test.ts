/**
 * Layer targeting for `set`/`list`/`generate`/`rotate`, and `check --env`.
 *
 * Pinned: without `--instance` a deployed target holds `environment` names, with
 * it `instance` names, and `local` holds everything; `check` with a deployed
 * `--env` reads the names SOPS leaves in the clear — nothing is decrypted — and
 * fails on a name in the wrong layer's file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvSchemaEntry } from '../../../utils/env-schema.js';
import { getSopsFile } from '../../../utils/secret-config.js';
import { entriesForTarget, isValidInstance, targetLayer } from '../options.js';
import { secretCheck } from '../check.js';

const SHARED: EnvSchemaEntry = { key: 'API_KEY', type: 'string', description: 'shared', sensitive: true };
const PER_INSTANCE: EnvSchemaEntry = { key: 'DB_PASSWORD', type: 'string', description: 'own', sensitive: true, layer: 'instance' };

describe('layer targeting', () =>
{
    it('maps a target to the layer its file holds', () =>
    {
        expect(targetLayer({ env: 'local' })).toBeUndefined();
        expect(targetLayer({ env: 'staging' })).toBe('environment');
        expect(targetLayer({ env: 'staging', instance: 'blue' })).toBe('instance');
    });

    it('keeps the entries of the target layer', () =>
    {
        expect(entriesForTarget([SHARED, PER_INSTANCE], { env: 'local' })).toEqual([SHARED, PER_INSTANCE]);
        expect(entriesForTarget([SHARED, PER_INSTANCE], { env: 'staging' })).toEqual([SHARED]);
        expect(entriesForTarget([SHARED, PER_INSTANCE], { env: 'staging', instance: 'blue' })).toEqual([PER_INSTANCE]);
    });

    it('names the instance file beside the environment file', () =>
    {
        expect(getSopsFile('/app', 'staging').relFile).toBe('secrets/staging.enc.json');
        expect(getSopsFile('/app', 'staging', 'blue').relFile).toBe('secrets/staging.blue.enc.json');
    });

    it('accepts lowercase instance names only', () =>
    {
        expect(isValidInstance('blue-2')).toBe(true);
        expect(isValidInstance('Blue')).toBe(false);
        expect(isValidInstance('blue.green')).toBe(false);
        expect(isValidInstance('../blue')).toBe(false);
    });
});

describe('spfn secret check --env', () =>
{
    let dir: string;
    let previousCwd: string;
    let output: string[];

    beforeEach(() =>
    {
        dir = mkdtempSync(join(tmpdir(), 'spfn-check-'));
        previousCwd = process.cwd();
        process.chdir(dir);
        output = [];
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void output.push(args.join(' ')));
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);
        writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
        writeFileSync(join(dir, 'spfn.config.js'), 'export default { env: { schemas: ["env.schema.js"] } };\n');
        writeFileSync(join(dir, 'env.schema.js'), `export const envSchema = ${JSON.stringify({ API_KEY: SHARED, DB_PASSWORD: PER_INSTANCE })};\n`);
        mkdirSync(join(dir, 'secrets'));
    });

    afterEach(() =>
    {
        process.chdir(previousCwd);
        vi.restoreAllMocks();
        rmSync(dir, { recursive: true, force: true });
    });

    /** An encrypted-file stand-in: SOPS keeps names readable, so names are all check reads. */
    function writeNames(relFile: string, names: string[]): void
    {
        const body = Object.fromEntries(names.map((name) => [name, 'ENC[AES256_GCM,data:x,type:str]']));
        writeFileSync(join(dir, relFile), JSON.stringify({ ...body, sops: {} }));
    }

    it('fails on an instance-layer name in the environment file', async () =>
    {
        writeNames('secrets/staging.enc.json', ['API_KEY', 'DB_PASSWORD']);

        await expect(secretCheck({ env: 'staging' })).rejects.toThrow('exit 1');
        expect(output.join('\n')).toMatch(/DB_PASSWORD.*layer "instance".*secrets\/staging\.enc\.json/);
    });

    it('fails on an environment-layer name in the instance file and warns on an unlisted one', async () =>
    {
        writeNames('secrets/staging.enc.json', ['API_KEY']);
        writeNames('secrets/staging.blue.enc.json', ['API_KEY', 'RETIRED_KEY']);

        await expect(secretCheck({ env: 'staging', instance: 'blue' })).rejects.toThrow('exit 1');
        expect(output.join('\n')).toMatch(/API_KEY.*layer "environment".*secrets\/staging\.blue\.enc\.json/);
        expect(output.join('\n')).toMatch(/RETIRED_KEY.*not in the env list/);
    });

    it('passes when every name is in its own layer', async () =>
    {
        writeNames('secrets/staging.enc.json', ['API_KEY']);
        writeNames('secrets/staging.blue.enc.json', ['DB_PASSWORD']);

        await secretCheck({ env: 'staging', instance: 'blue' });

        expect(output.join('\n')).toContain('No plaintext secret leaks found');
    });
});
