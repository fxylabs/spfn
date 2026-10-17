/**
 * Boot-time check of the Sign in with Apple web configuration (fxylabs/spfn#142, case table C).
 *
 * The check reads the env it is handed, so every row passes its own object and
 * nothing leaks between rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertAppleWebConfig } from '@/server/lib/oauth/apple-config-check';

const IDS = {
    SPFN_AUTH_APPLE_SERVICES_ID: 'com.example.app.web',
    SPFN_AUTH_APPLE_TEAM_ID: 'TEAM123456',
    SPFN_AUTH_APPLE_KEY_ID: 'KEY9876543',
};

let p256Pem: string;
let rsaPem: string;
let dir: string;

/** The refusal message, or '' when the check passed. */
async function refusal(env: Record<string, string>): Promise<string>
{
    return await assertAppleWebConfig(env).then(() => '', (error: Error) => error.message);
}

beforeAll(() =>
{
    p256Pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
        .export({ type: 'pkcs8', format: 'pem' }) as string;
    rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
        .export({ type: 'pkcs8', format: 'pem' }) as string;
    dir = mkdtempSync(join(tmpdir(), 'apple142-check-'));
});

afterAll(() =>
{
    rmSync(dir, { recursive: true, force: true });
});

describe('assertAppleWebConfig', () =>
{
    it('C2: none of the five variables — no-op', async () =>
    {
        expect(await refusal({ SPFN_AUTH_APPLE_CLIENT_IDS: 'com.example.app' })).toBe('');
    });

    it('C3: the Services ID alone — names the Team ID, the Key ID and the key pair', async () =>
    {
        const message = await refusal({ SPFN_AUTH_APPLE_SERVICES_ID: IDS.SPFN_AUTH_APPLE_SERVICES_ID });

        expect(message).toContain('SPFN_AUTH_APPLE_TEAM_ID');
        expect(message).toContain('SPFN_AUTH_APPLE_KEY_ID');
        expect(message).toContain('SPFN_AUTH_APPLE_PRIVATE_KEY or SPFN_AUTH_APPLE_PRIVATE_KEY_FILE');
        expect(message).not.toContain('SPFN_AUTH_APPLE_SERVICES_ID is not set');
    });

    it('C4: both key variables — exactly one of the two', async () =>
    {
        const path = join(dir, 'both.p8');

        const message = await refusal({
            ...IDS,
            SPFN_AUTH_APPLE_PRIVATE_KEY: p256Pem,
            SPFN_AUTH_APPLE_PRIVATE_KEY_FILE: path,
        });

        expect(message).toMatch(/exactly one of SPFN_AUTH_APPLE_PRIVATE_KEY and SPFN_AUTH_APPLE_PRIVATE_KEY_FILE/);
    });

    it('C5: a key file that does not exist — names the variable', async () =>
    {
        const message = await refusal({ ...IDS, SPFN_AUTH_APPLE_PRIVATE_KEY_FILE: join(dir, 'missing.p8') });

        expect(message).toContain('SPFN_AUTH_APPLE_PRIVATE_KEY_FILE');
        expect(message).not.toContain('missing.p8');
    });

    it('C5: a relative key file path is refused by name', async () =>
    {
        const message = await refusal({ ...IDS, SPFN_AUTH_APPLE_PRIVATE_KEY_FILE: 'keys/AuthKey.p8' });

        expect(message).toMatch(/SPFN_AUTH_APPLE_PRIVATE_KEY_FILE must be an absolute path/);
    });

    it('C6: all three ids and a valid PEM — passes', async () =>
    {
        expect(await refusal({ ...IDS, SPFN_AUTH_APPLE_PRIVATE_KEY: p256Pem })).toBe('');
    });

    it('C7: an RSA PEM — refuses naming P-256, never echoing the key', async () =>
    {
        const message = await refusal({ ...IDS, SPFN_AUTH_APPLE_PRIVATE_KEY: rsaPem });

        expect(message).toMatch(/P-256/);
        expect(message).not.toContain(rsaPem.split('\n')[1]);
        expect(message).not.toContain('BEGIN PRIVATE KEY');
    });
});
