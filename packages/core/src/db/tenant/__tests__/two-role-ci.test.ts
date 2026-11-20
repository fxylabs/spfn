/**
 * The two-role harness fails a missing role only in CI — and `CI=false` is not
 * CI (#405).
 *
 * Both connections point at a port nothing listens on, so the owner cannot
 * connect and the harness has its reason without a database.
 */

import postgres from 'postgres';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { twoRoleUnavailability } from './tenancy-db';

const nowhere = postgres('postgresql://nobody@127.0.0.1:1/none', { max: 1, connect_timeout: 2, onnotice: () => undefined });

afterEach(() =>
{
    vi.unstubAllEnvs();
});

afterAll(async () =>
{
    await nowhere.end();
});

describe('a role that cannot connect', () =>
{
    it.each(['', 'false', 'FALSE', '0'])('is a skip reason with CI=%j', async (value) =>
    {
        vi.stubEnv('CI', value);

        await expect(twoRoleUnavailability(nowhere, nowhere, 'testuser'))
            .resolves.toBe('PostgreSQL not available at TEST_DATABASE_URL');
    });

    it('is a skip reason with CI unset', async () =>
    {
        vi.stubEnv('CI', undefined);

        await expect(twoRoleUnavailability(nowhere, nowhere, 'testuser'))
            .resolves.toBe('PostgreSQL not available at TEST_DATABASE_URL');
    });

    it.each(['true', '1', 'woodpecker'])('is a failure with CI=%j', async (value) =>
    {
        vi.stubEnv('CI', value);

        await expect(twoRoleUnavailability(nowhere, nowhere, 'testuser'))
            .rejects.toThrow('CI provides both roles — failing instead of skipping');
    });
});
