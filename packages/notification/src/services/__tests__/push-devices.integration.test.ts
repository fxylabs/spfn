/**
 * GitHub #116 device-token store: case table D1-D8. Each row that says what
 * must not happen asserts it (D3/D6 are the shared-device cases: the previous
 * owner must stop receiving).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getDatabase } from '@spfn/core/db';
import { pushDevices } from '../../entities';
import {
    registerPushDevice,
    unregisterPushDevice,
    listPushDevices,
    invalidatePushToken,
} from '../push-device.service';
import { setupTestDb, teardownTestDb, clearTables } from '../../__tests__/helpers/db';

const all = () => getDatabase('write').select().from(pushDevices);
const tokensOf = async (ownerId: string) => (await listPushDevices(ownerId)).map(d => d.token);

beforeAll(setupTestDb);
afterAll(teardownTestDb);
beforeEach(clearTables);

describe('#116 device store', () =>
{
    it('D1 new token: one active row for the owner', async () =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'tok-1', platform: 'ios' });

        expect(await tokensOf('A')).toEqual(['tok-1']);
    });

    it('D2 same token, same owner: last_seen bumped, still one row', async () =>
    {
        const first = await registerPushDevice({ ownerId: 'A', token: 'tok-1', platform: 'ios' });
        await new Promise(resolve => setTimeout(resolve, 5));
        const second = await registerPushDevice({ ownerId: 'A', token: 'tok-1', platform: 'ios' });

        expect(await all()).toHaveLength(1);
        expect(second.lastSeenAt.getTime()).toBeGreaterThan(first.lastSeenAt.getTime());
    });

    it('D3 token held by B, registered by A: moves to A, B no longer receives it', async () =>
    {
        await registerPushDevice({ ownerId: 'B', token: 'tok-1', platform: 'android' });
        await registerPushDevice({ ownerId: 'A', token: 'tok-1', platform: 'android' });

        expect(await tokensOf('A')).toEqual(['tok-1']);
        expect(await tokensOf('B')).toEqual([]);
        expect(await all()).toHaveLength(1);
    });

    it('D4 invalidated token registered again: reactivated', async () =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'tok-1', platform: 'ios' });
        await invalidatePushToken('tok-1', 'unregistered');
        await registerPushDevice({ ownerId: 'A', token: 'tok-1', platform: 'ios' });

        const [row] = await all();
        expect(row).toMatchObject({ invalidatedAt: null, invalidatedReason: null });
        expect(await tokensOf('A')).toEqual(['tok-1']);
    });

    it('D5 rotated token on the same device: old token retired as replaced, one active token', async () =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'old', platform: 'ios', deviceId: 'X' });
        await registerPushDevice({ ownerId: 'A', token: 'new', platform: 'ios', deviceId: 'X' });

        expect(await tokensOf('A')).toEqual(['new']);
        const old = (await all()).find(d => d.token === 'old');
        expect(old).toMatchObject({ invalidatedReason: 'replaced' });
    });

    it('D6 device X held by B, A registers a token for X: B loses X', async () =>
    {
        await registerPushDevice({ ownerId: 'B', token: 'b-tok', platform: 'ios', deviceId: 'X' });
        await registerPushDevice({ ownerId: 'A', token: 'a-tok', platform: 'ios', deviceId: 'X' });

        expect(await tokensOf('B')).toEqual([]);
        expect(await tokensOf('A')).toEqual(['a-tok']);
    });

    it('D7 unregister: invalidated, row kept', async () =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'tok-1', platform: 'web' });
        await unregisterPushDevice('tok-1');

        expect(await tokensOf('A')).toEqual([]);
        expect(await all()).toHaveLength(1);
        expect((await all())[0]).toMatchObject({ invalidatedReason: 'unregistered' });
    });

    it('D8 unregister an unknown token: no-op, no error', async () =>
    {
        await expect(unregisterPushDevice('nope')).resolves.toBeUndefined();
        expect(await all()).toHaveLength(0);
    });

    it('one owner keeps several devices active (multi-device is the default)', async () =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'phone', platform: 'ios', deviceId: 'P' });
        await registerPushDevice({ ownerId: 'A', token: 'tablet', platform: 'android', deviceId: 'T' });
        await registerPushDevice({ ownerId: 'A', token: 'browser', platform: 'web' });

        expect((await tokensOf('A')).sort()).toEqual(['browser', 'phone', 'tablet']);
    });

    it('an invalidation reason is not overwritten by a later invalidation', async () =>
    {
        await registerPushDevice({ ownerId: 'A', token: 'tok-1', platform: 'ios' });
        await invalidatePushToken('tok-1', 'sender_mismatch');
        await unregisterPushDevice('tok-1');

        expect((await all())[0]).toMatchObject({ invalidatedReason: 'sender_mismatch' });
    });

    it('N1 concurrent registrations for one device with different tokens: both succeed, one token stays active', async () =>
    {
        const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) =>
            registerPushDevice({ ownerId: 'A', token: `tok-${i}`, platform: 'ios', deviceId: 'X' })));

        expect(results.every(r => r.status === 'fulfilled')).toBe(true);
        expect(await listPushDevices('A')).toHaveLength(1);
    });
});
