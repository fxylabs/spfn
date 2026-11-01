/**
 * Core env schema — the database owner URL (#158 part 2, row O5)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { coreEnvSchema } from '../schema';
import { env } from '../index';

describe('core env schema', () =>
{
    afterEach(() =>
    {
        delete process.env.DATABASE_OWNER_URL;
    });

    it('O5 DATABASE_OWNER_URL is optional, sensitive and validated as a postgres URL', () =>
    {
        expect(coreEnvSchema.DATABASE_OWNER_URL).toMatchObject({ required: false, sensitive: true });
        expect(env.DATABASE_OWNER_URL).toBeUndefined();

        process.env.DATABASE_OWNER_URL = 'postgresql://owner:secret@localhost:5432/app';

        expect(env.DATABASE_OWNER_URL).toBe('postgresql://owner:secret@localhost:5432/app');

        process.env.DATABASE_OWNER_URL = 'mysql://owner@localhost/app';

        expect(() => env.DATABASE_OWNER_URL).toThrow();
    });

    it('O5 a rejected DATABASE_OWNER_URL value is not repeated in the error', () =>
    {
        process.env.DATABASE_OWNER_URL = 'mysql://owner:hunter2@localhost/app';

        const message = (() =>
        {
            try
            {
                return String(env.DATABASE_OWNER_URL);
            }
            catch (error)
            {
                return (error as Error).message;
            }
        })();

        expect(message).not.toContain('hunter2');
    });
});
