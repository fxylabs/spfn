/**
 * OAuth link callback (#154): the account's status is read after the account row
 * is locked.
 *
 * Found by the Codex reviewer on PR #290. A deletion request that held the row
 * and committed between an earlier status read and the lock let the link attach
 * the identity to an account already pending deletion. Row C10b: the status
 * change commits while the callback waits on the lock → the service refuses
 * with `AccountPendingDeletionError` (the route's `account_unavailable`), and no
 * social row is written.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { runInTransaction } from '@spfn/core/db';
import { AccountPendingDeletionError } from '@spfn/auth/errors';

import {
    clearTables,
    getTestDb,
    isDatabaseAvailable,
    setupTestDb,
    teardownTestDb,
} from '../helpers/db';
import { users, userSocialAccounts } from '@/server/entities';
import {
    battlenetProvider,
    registerOAuthProvider,
    type OAuthProvider,
} from '@/server/lib/oauth';
import { usersRepository } from '@/server/repositories';
import { oauthLinkCallbackService } from '@/server/services/oauth-link.service';

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const standIn: OAuthProvider = {
    id: 'battlenet',
    isEnabled: () => true,
    getAuthUrl: state => `https://oauth.example/authorize?state=${state}`,
    exchangeCodeForTokens: async () => ({
        accessToken: 'access-token',
        expiresIn: 3600,
        identity: {
            providerUserId: 'battle-account-1',
            email: null,
            emailVerified: false,
            name: 'Player#1234',
            handle: 'Player#1234',
        },
    }),
    getUserInfo: async () => 
    {
        throw new Error('identity is returned with the token'); 
    },
};

describe.skipIf(!dbAvailable)('OAuth link callback: status read under the row lock (#154 C10b)', () =>
{
    beforeAll(async () =>
    {
        await setupTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        registerOAuthProvider(standIn);
    });

    afterAll(async () =>
    {
        registerOAuthProvider(battlenetProvider);
        await teardownTestDb();
    });

    it('C10b: a pending_deletion that commits while the callback waits on the row lock leaves rows unchanged', async () =>
    {
        const role = await getRoleByName('user');
        const [user] = await getTestDb().insert(users).values({
            email: 'owner@example.com',
            roleId: role!.id,
            status: 'active',
        }).returning({ id: users.id });

        let announceBlockerReady!: () => void;
        let releaseBlocker!: () => void;
        const blockerReady = new Promise<void>(resolve => 
        {
            announceBlockerReady = resolve; 
        });
        const blockerMayCommit = new Promise<void>(resolve => 
        {
            releaseBlocker = resolve; 
        });

        // Hold an uncommitted status change and its user-row lock. The callback's
        // plain SELECT can still see the old active row, then it blocks on FOR UPDATE.
        const blocker = getTestDb().transaction(async tx =>
        {
            await tx.update(users)
                .set({ status: 'pending_deletion' })
                .where(eq(users.id, user!.id));
            announceBlockerReady();
            await blockerMayCommit;
        });
        await blockerReady;

        const originalLock = usersRepository.lockById.bind(usersRepository);
        let announceLockAttempt!: () => void;
        const lockAttempted = new Promise<void>(resolve => 
        {
            announceLockAttempt = resolve; 
        });
        vi.spyOn(usersRepository, 'lockById').mockImplementation(async userId =>
        {
            announceLockAttempt();
            await originalLock(userId);
        });

        const callback = runInTransaction(
            () => oauthLinkCallbackService({
                provider: 'battlenet',
                code: 'authorization-code',
                state: 'sealed-link-state',
                link: {
                    provider: 'battlenet',
                    userId: String(user!.id),
                    returnUrl: '/settings',
                    nonce: 'nonce',
                    startId: 'start-id',
                },
            }),
            { context: 'review:oauth-link-status-lock-race' },
        );

        await lockAttempted;
        releaseBlocker();
        await blocker;

        // The service refuses with the status error; the callback route turns it into
        // `oauthLink=account_unavailable` (rows C10 in oauth-link.test.ts).
        await expect(callback).rejects.toBeInstanceOf(AccountPendingDeletionError);
        expect(await getTestDb().select().from(userSocialAccounts)).toHaveLength(0);
    });
});
