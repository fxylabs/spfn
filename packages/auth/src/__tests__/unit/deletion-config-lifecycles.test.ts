/**
 * @spfn/auth - Deletion options stated by several createAuthLifecycle() calls (spfn/spfn#170)
 *
 * The rule the channels follow (`unit/auth-channels.test.ts` F3a–c): what was
 * stated holds, and a contradiction refuses boot. Each row, and what goes
 * unnoticed without it:
 *
 * | Row | Checks                                                       | Unnoticed without it                                |
 * |-----|--------------------------------------------------------------|-----------------------------------------------------|
 * | D1  | a later lifecycle stating no `deletion`, or other options,   | a completed notice that silently stops; a boot      |
 * |     | keeps the first one's `onPurge` and `allowSelfImmediate`     | refusal hidden by a reset `allowSelfImmediate`      |
 * | D2  | the same values and the same hook stated twice: no refusal   | an app sharing one options object refused boot      |
 * | D3  | one option stated with two values refuses boot naming both   | the second value silently overriding the first      |
 * | D4  | two different `onPurge` functions refuse boot naming both    | one of two hook owners silently never called        |
 */

import { describe, it, expect, afterEach } from 'vitest';

import { createAuthLifecycle } from '@/server/lifecycle';
import { __resetDeletionForTests, assertDeletionConsistent, getDeletionConfig } from '@/server/lib/deletion-config';

describe('deletion options across createAuthLifecycle() calls', () =>
{
    afterEach(() =>
    {
        __resetDeletionForTests();
    });

    it('D1: a later lifecycle that states no deletion, or other options, keeps the first one\'s', () =>
    {
        const onPurge = async () => undefined;
        createAuthLifecycle({ deletion: { onPurge, allowSelfImmediate: true } });
        createAuthLifecycle({});
        expect(getDeletionConfig()).toMatchObject({ onPurge, allowSelfImmediate: true });
        createAuthLifecycle({ deletion: { gracePeriodDays: 7 } });

        expect(getDeletionConfig()).toMatchObject({ onPurge, allowSelfImmediate: true, gracePeriodDays: 7 });
        expect(() => assertDeletionConsistent()).not.toThrow();
    });

    it('D2: the same values and the same hook stated twice are no contradiction', () =>
    {
        const deletion = { purgeStrategy: 'hard-delete' as const, onPurge: async () => undefined };
        createAuthLifecycle({ deletion });
        createAuthLifecycle({ deletion: { ...deletion } });

        expect(() => assertDeletionConsistent()).not.toThrow();
    });

    it('D3: one option stated with two values keeps the first, and afterInfrastructure refuses naming both', async () =>
    {
        createAuthLifecycle({ deletion: { gracePeriodDays: 14 } });
        const lifecycle = createAuthLifecycle({ deletion: { gracePeriodDays: 30 } });

        expect(getDeletionConfig().gracePeriodDays).toBe(14);
        await expect(lifecycle.afterInfrastructure!()).rejects.toThrow(/different deletion options in two calls: gracePeriodDays 14 and 30\b/);
    });

    it('D4: two different onPurge functions are two owners of one hook, refused naming both', async () =>
    {
        const firstOwner = async () => undefined;
        const secondOwner = async () => undefined;
        createAuthLifecycle({ deletion: { onPurge: firstOwner } });
        const lifecycle = createAuthLifecycle({ deletion: { onPurge: secondOwner } });

        expect(getDeletionConfig().onPurge).toBe(firstOwner);
        await expect(lifecycle.afterInfrastructure!()).rejects.toThrow(/onPurge by two different functions, 'firstOwner' and 'secondOwner' — one hook has one owner/);
    });
});
