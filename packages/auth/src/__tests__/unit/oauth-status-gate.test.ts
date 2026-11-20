/**
 * oauth.service.ts — assertActiveForOAuthSession (issue #9 OAuth gap fix)
 *
 * createOrLinkUser() never checked account status before a session (public key)
 * was registered — a suspended/inactive/pending-deletion user could still log in
 * via OAuth. Worse, the far more common "already-linked social account" branch in
 * oauthCallbackService/oauth-native's persistNativeLogin doesn't even call
 * createOrLinkUser, so patching only that function wouldn't have closed the gap.
 * The fix adds one check — assertActiveForOAuthSession — at the single point both
 * branches of both flows converge (right before registerPublicKeyService).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { usersRepository, accountDeletionRequestsRepository } = vi.hoisted(() => ({
    usersRepository: { findByIdOnPrimary: vi.fn() },
    accountDeletionRequestsRepository: { findPendingByUserIdOnPrimary: vi.fn() },
}));

vi.mock('../../server/repositories', () => ({ usersRepository, accountDeletionRequestsRepository }));

import { assertActiveForOAuthSession } from '../../server/services/oauth.service';
// Imported via the package specifier (matching how oauth.service.ts imports them) —
// a relative-path import would resolve a second module instance and `instanceof`
// would fail even for the "same" class.
import { AccountDisabledError, AccountPendingDeletionError } from '@spfn/auth/errors';

describe('assertActiveForOAuthSession', () =>
{
    beforeEach(() => vi.clearAllMocks());

    it('allows an active user through, answering the account it read', async () =>
    {
        const account = { id: 1, status: 'active', deletion: null };
        usersRepository.findByIdOnPrimary.mockResolvedValue(account);

        await expect(assertActiveForOAuthSession(1)).resolves.toBe(account);
    });

    it('blocks a suspended user with AccountDisabledError', async () =>
    {
        usersRepository.findByIdOnPrimary.mockResolvedValue({ id: 2, status: 'suspended', deletion: null });

        await expect(assertActiveForOAuthSession(2)).rejects.toBeInstanceOf(AccountDisabledError);
    });

    it('blocks a user pending deletion with AccountPendingDeletionError, carrying purgeScheduledAt', async () =>
    {
        usersRepository.findByIdOnPrimary.mockResolvedValue({ id: 3, status: 'active', deletion: 'pending' });
        const purgeScheduledAt = new Date('2030-01-01T00:00:00.000Z');
        accountDeletionRequestsRepository.findPendingByUserIdOnPrimary.mockResolvedValue({ purgeScheduledAt });

        const error = await assertActiveForOAuthSession(3).catch((e) => e);

        expect(error).toBeInstanceOf(AccountPendingDeletionError);
        expect(error.details).toMatchObject({
            status: 'pending_deletion',
            purgeScheduledAt: purgeScheduledAt.toISOString(),
        });
    });

    it('throws for a userId that no longer resolves to a user', async () =>
    {
        usersRepository.findByIdOnPrimary.mockResolvedValue(null);

        await expect(assertActiveForOAuthSession(999)).rejects.toThrow(/user not found/i);
    });

    it('reads the status from the write primary, not a replica (replica-lag guard)', async () =>
    {
        usersRepository.findByIdOnPrimary.mockResolvedValue({ id: 4, status: 'active' });

        await assertActiveForOAuthSession(4);

        // findByIdOnPrimary (not findById/readDb) — a mock providing only the
        // former would throw here if the implementation ever fell back to a
        // replica read.
        expect(usersRepository.findByIdOnPrimary).toHaveBeenCalledWith(4);
    });
});
