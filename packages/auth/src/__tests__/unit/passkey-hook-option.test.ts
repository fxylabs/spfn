/**
 * @spfn/auth - the `passkey` option is stated once (#493)
 *
 * One row: a second `createAuthLifecycle()` that states other functions must
 * refuse boot. Without it the second statement is silently ignored, and the
 * app believes its history hook is in force when the first call's is. The
 * refusal is driven through `afterInfrastructure`, which runs every assert
 * before it touches the database, as `sign-in-guard-option.test.ts` does.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { passkeyHook, resetPasskeyHookForTests } from '@/server/lib/passkey-hook';
import { createAuthLifecycle } from '@/server/lifecycle';

describe('passkey option (#493)', () =>
{
    afterEach(() =>
    {
        resetPasskeyHookForTests();
    });

    it('two constructions stating different hooks refuse boot, and the first stays in force meanwhile', async () =>
    {
        const enrolled = async () => undefined;
        createAuthLifecycle({ passkey: { enrolled } });
        const second = createAuthLifecycle({ passkey: { enrolled: async () => undefined } });

        expect(passkeyHook()?.enrolled).toBe(enrolled);
        await expect(second.afterInfrastructure!()).rejects.toThrow(/different passkey options in two calls: enrolled/);
    });
});
