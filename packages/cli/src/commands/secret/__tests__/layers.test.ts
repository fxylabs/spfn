/**
 * Layer targeting for `set`/`list`/`generate`/`rotate`, and `check --env`.
 *
 * Pinned: `--all` without `--instance` takes `environment` names and names without
 * a layer, with it only names declared `instance`, and `local` takes everything;
 * a named key without a layer fits any target. `check` with a deployed `--env`
 * reads the names SOPS leaves in the clear — nothing is decrypted — and fails on
 * a name outside its declared layer or in both files.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvSchemaEntry } from '../../../utils/env-schema.js';
import { getSopsFile } from '../../../utils/secret-config.js';
import { assertTargetLayer, entriesForTarget, isValidInstance, targetLayer } from '../options.js';
import { secretCheck } from '../check.js';

const SHARED: EnvSchemaEntry = { key: 'API_KEY', type: 'string', description: 'shared', sensitive: true, layer: 'environment' };
const ANY_LAYER: EnvSchemaEntry = { key: 'SESSION_SECRET', type: 'string', description: 'either', sensitive: true };
const PER_INSTANCE: EnvSchemaEntry = { key: 'DB_PASSWORD', type: 'string', description: 'own', sensitive: true, layer: 'instance' };

describe('layer targeting', () =>
{
    it('maps a target to the layer its file holds', () =>
    {
        expect(targetLayer({ env: 'local' })).toBeUndefined();
        expect(targetLayer({ env: 'staging' })).toBe('environment');
        expect(targetLayer({ env: 'staging', instance: 'blue' })).toBe('instance');
    });

    it('L6: --all on an instance target takes explicit instance names only', () =>
    {
        const entries = [SHARED, ANY_LAYER, PER_INSTANCE];

        expect(entriesForTarget(entries, { env: 'local' })).toEqual(entries);
        expect(entriesForTarget(entries, { env: 'staging' })).toEqual([SHARED, ANY_LAYER]);
        expect(entriesForTarget(entries, { env: 'staging', instance: 'blue' })).toEqual([PER_INSTANCE]);
    });

    it('accepts a named key without a layer on any target, and refuses one declared for the other layer', () =>
    {
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        vi.spyOn(process, 'exit').mockImplementation(((code?: number) =>
        {
            throw new Error(`exit ${code}`);
        }) as never);

        expect(() => assertTargetLayer(ANY_LAYER, { env: 'staging' })).not.toThrow();
        expect(() => assertTargetLayer(ANY_LAYER, { env: 'staging', instance: 'blue' })).not.toThrow();
        expect(() => assertTargetLayer(SHARED, { env: 'staging', instance: 'blue' })).toThrow('exit 1');
        expect(() => assertTargetLayer(PER_INSTANCE, { env: 'staging' })).toThrow('exit 1');
        vi.restoreAllMocks();
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
        writeFileSync(join(dir, 'env.schema.js'), `export const envSchema = ${JSON.stringify({ API_KEY: SHARED, SESSION_SECRET: ANY_LAYER, DB_PASSWORD: PER_INSTANCE })};\n`);
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

    it('L7: a name without layer in the instance file gets no placement flag', async () =>
    {
        writeNames('secrets/staging.enc.json', ['API_KEY']);
        writeNames('secrets/staging.blue.enc.json', ['DB_PASSWORD', 'SESSION_SECRET']);

        await secretCheck({ env: 'staging', instance: 'blue' });

        expect(output.join('\n')).not.toContain('SESSION_SECRET');
        expect(output.join('\n')).toContain('No plaintext secret leaks found');
    });

    it('fails on a name without layer in both files', async () =>
    {
        writeNames('secrets/staging.enc.json', ['API_KEY', 'SESSION_SECRET']);
        writeNames('secrets/staging.blue.enc.json', ['SESSION_SECRET']);

        await expect(secretCheck({ env: 'staging', instance: 'blue' })).rejects.toThrow('exit 1');
        expect(output.join('\n')).toMatch(/SESSION_SECRET.*both.*secrets\/staging\.enc\.json.*secrets\/staging\.blue\.enc\.json/);
    });

    it('passes when every name is in its own layer', async () =>
    {
        writeNames('secrets/staging.enc.json', ['API_KEY']);
        writeNames('secrets/staging.blue.enc.json', ['DB_PASSWORD']);

        await secretCheck({ env: 'staging', instance: 'blue' });

        expect(output.join('\n')).toContain('No plaintext secret leaks found');
    });
});
