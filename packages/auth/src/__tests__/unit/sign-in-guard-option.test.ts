/**
 * @spfn/auth - the `signIn` option is stated once (#361)
 *
 * One row: a second `createAuthLifecycle()` that states other functions must
 * refuse boot. Without it the second statement is silently ignored, and the
 * app believes a guard is in force that is not. The refusal is driven through
 * `afterInfrastructure`, which runs every assert before it touches the
 * database, as `second-factor-policy.test.ts` does.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { resetSignInGuardForTests, signInGuard } from '@/server/lib/sign-in-guard';
import { createAuthLifecycle } from '@/server/lifecycle';

describe('signIn option (#361)', () =>
{
    afterEach(() =>
    {
        resetSignInGuardForTests();
    });

    it('two constructions stating different guards refuse boot, and the first stays in force meanwhile', async () =>
    {
        const admit = async () => undefined;
        createAuthLifecycle({ signIn: { admit } });
        const second = createAuthLifecycle({ signIn: { admit: async () => ({ refuse: { code: 'LOCKED' } }) } });

        expect(signInGuard()?.admit).toBe(admit);
        await expect(second.afterInfrastructure!()).rejects.toThrow(/different signIn options in two calls: admit/);
    });
});
