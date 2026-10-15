/**
 * @spfn/auth - the primary-read repository methods admission uses (#133)
 *
 * Against a real database: the OnPrimary methods answer what their replica twins
 * answer — so switching admission to them changes no outcome — and they never
 * touch `readDb`. The test database has no replica, so the handle each method
 * reads through is observed directly with a spy on the `readDb` getter; the
 * replica twins are the positive control that the spy sees a read at all.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { userPublicKeys, users } from '@/server/entities';
import { keysRepository, usersRepository } from '@/server/repositories';
import { generateKeyPair } from '@/server/lib/crypto';

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

async function seedUser()
{
    const [row] = await getTestDb().insert(users).values({
        email: 'primary@example.com',
        roleId: (await getRoleByName('user'))!.id,
    }).returning();

    return row;
}

async function seedKey(userId: number, isActive: boolean)
{
    const keyPair = generateKeyPair('ES256');

    await getTestDb().insert(userPublicKeys).values({
        userId,
        keyId: keyPair.keyId,
        publicKey: keyPair.publicKey,
        fingerprint: keyPair.fingerprint,
        algorithm: keyPair.algorithm,
        isActive,
        revokedAt: isActive ? null : new Date(),
    });

    return keyPair.keyId;
}

/** Watch the `readDb` getter of one repository instance. */
function watchReplicaReads(repository: object)
{
    return vi.spyOn(repository as { readDb: unknown }, 'readDb', 'get');
}

describe.skipIf(!dbAvailable)('admission primary reads (#133)', () =>
{
    let userId: number;

    beforeAll(async () =>
    {
        await setupTestDb();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        userId = (await seedUser()).id;
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
    });

    describe('keysRepository.findByKeyIdOnPrimary', () =>
    {
        it('R1: returns an inactive key, so admission can still answer SESSION_REVOKED', async () =>
        {
            const keyId = await seedKey(userId, false);

            const row = await keysRepository.findByKeyIdOnPrimary(keyId);

            expect(row).toMatchObject({ keyId, userId, isActive: false });
            expect(row).toEqual(await keysRepository.findByKeyId(keyId));
        });

        it('R2: returns null for an unknown keyId', async () =>
        {
            expect(await keysRepository.findByKeyIdOnPrimary('key-never-registered')).toBeNull();
        });

        it('never reads the replica handle', async () =>
        {
            const keyId = await seedKey(userId, true);
            const replica = watchReplicaReads(keysRepository);

            expect(await keysRepository.findByKeyIdOnPrimary(keyId)).not.toBeNull();
            expect(replica).not.toHaveBeenCalled();

            await keysRepository.findByKeyId(keyId);
            expect(replica).toHaveBeenCalled();
        });
    });

    describe('keysRepository.findActiveByKeyIdOnPrimary', () =>
    {
        it('R3: returns null for an inactive key', async () =>
        {
            const keyId = await seedKey(userId, false);

            expect(await keysRepository.findActiveByKeyIdOnPrimary(keyId)).toBeNull();
        });

        it('returns an active key, as findActiveByKeyId does', async () =>
        {
            const keyId = await seedKey(userId, true);

            const row = await keysRepository.findActiveByKeyIdOnPrimary(keyId);

            expect(row).toMatchObject({ keyId, userId, isActive: true });
            expect(row).toEqual(await keysRepository.findActiveByKeyId(keyId));
        });

        it('never reads the replica handle', async () =>
        {
            const keyId = await seedKey(userId, true);
            const replica = watchReplicaReads(keysRepository);

            expect(await keysRepository.findActiveByKeyIdOnPrimary(keyId)).not.toBeNull();
            expect(replica).not.toHaveBeenCalled();

            await keysRepository.findActiveByKeyId(keyId);
            expect(replica).toHaveBeenCalled();
        });
    });

    describe('usersRepository.findByIdWithRoleOnPrimary', () =>
    {
        it('R4: answers the same shape and values as findByIdWithRole', async () =>
        {
            const onPrimary = await usersRepository.findByIdWithRoleOnPrimary(userId);

            expect(onPrimary).toEqual(await usersRepository.findByIdWithRole(userId));
            expect(onPrimary).toMatchObject({ user: { id: userId }, role: { name: 'user' } });
        });

        it('R4: answers null for an unknown user, as findByIdWithRole does', async () =>
        {
            expect(await usersRepository.findByIdWithRoleOnPrimary(userId + 1000)).toBeNull();
            expect(await usersRepository.findByIdWithRole(userId + 1000)).toBeNull();
        });

        it('never reads the replica handle', async () =>
        {
            const replica = watchReplicaReads(usersRepository);

            expect(await usersRepository.findByIdWithRoleOnPrimary(userId)).not.toBeNull();
            expect(replica).not.toHaveBeenCalled();

            await usersRepository.findByIdWithRole(userId);
            expect(replica).toHaveBeenCalled();
        });
    });
});
