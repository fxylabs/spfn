/**
 * `spfn secret list` with a deployed `--env`.
 *
 * Pinned: status comes from the names SOPS leaves in the clear, so nothing is
 * decrypted; a name in the target's file that the whole-app list does not
 * declare is shown as "not in list", by name only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnvSchemaEntry } from '../../../utils/env-schema.js';
import { secretList } from '../list.js';

const SHARED: EnvSchemaEntry = { key: 'API_KEY', type: 'string', description: 'shared', sensitive: true };
const PER_INSTANCE: EnvSchemaEntry = { key: 'DB_PASSWORD', type: 'string', description: 'own', sensitive: true, layer: 'instance' };

/** Stands in for an encrypted value; it must never reach the output. */
const CIPHERTEXT = 'ENC[AES256_GCM,data:x,type:str]';

describe('spfn secret list --env', () =>
{
    let dir: string;
    let previousCwd: string;
    let output: string[];

    beforeEach(() =>
    {
        dir = mkdtempSync(join(tmpdir(), 'spfn-list-'));
        previousCwd = process.cwd();
        process.chdir(dir);
        output = [];
        vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => void output.push(args.join(' ')));
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

    function writeNames(relFile: string, names: string[]): void
    {
        const body = Object.fromEntries(names.map((name) => [name, CIPHERTEXT]));
        writeFileSync(join(dir, relFile), JSON.stringify({ ...body, sops: {} }));
    }

    it('marks a name in the environment file that is not in the list', async () =>
    {
        writeNames('secrets/staging.enc.json', ['API_KEY', 'RETIRED_KEY']);

        await secretList({ env: 'staging' });

        const text = output.join('\n');

        expect(text).toMatch(/API_KEY/);
        expect(text).toMatch(/RETIRED_KEY.*not in list/);
        expect(text).not.toMatch(/API_KEY.*not in list/);
        expect(text).not.toContain('ENC[');
    });

    it('marks a name in the instance file that is not in the list', async () =>
    {
        writeNames('secrets/staging.enc.json', ['API_KEY']);
        writeNames('secrets/staging.blue.enc.json', ['DB_PASSWORD', 'OLD_INSTANCE_KEY']);

        await secretList({ env: 'staging', instance: 'blue' });

        const text = output.join('\n');

        expect(text).toMatch(/OLD_INSTANCE_KEY.*not in list/);
        expect(text).not.toMatch(/DB_PASSWORD.*not in list/);
    });

    it('marks nothing when every name is in the list', async () =>
    {
        writeNames('secrets/staging.enc.json', ['API_KEY']);

        await secretList({ env: 'staging' });

        expect(output.join('\n')).not.toContain('not in list');
    });
});
