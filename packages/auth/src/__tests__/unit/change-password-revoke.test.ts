/**
 * changePasswordService — revoke all sessions on password change (#4)
 *
 * A password change must revoke every active key for the user, so existing
 * sessions are logged out (backend authenticate verifies active keys only).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
    usersRepository,
    keysRepository,
    deviceAuthorizationsRepository,
    deviceLinksRepository,
    verifyPassword,
    hashPassword,
    revokeAllOAuth2GrantsForUser,
    assertStepUp,
} = vi.hoisted(() => ({
    usersRepository: {
        findById: vi.fn(),
        findByIdOnPrimary: vi.fn(),
        lockAccount: vi.fn(async (id: number) => ({ id, passwordHash: 'old-hash' })),
        updatePassword: vi.fn(async () => undefined),
    },
    keysRepository: {
        revokeAllActiveByUserId: vi.fn(async () => []),
    },
    deviceAuthorizationsRepository: {
        denyAllActiveByUserId: vi.fn(async () => []),
    },
    deviceLinksRepository: {
        expireAllLiveByUserId: vi.fn(async () => []),
    },
    verifyPassword: vi.fn(async () => true),
    hashPassword: vi.fn(async () => 'new-hash'),
    revokeAllOAuth2GrantsForUser: vi.fn(async () => undefined),
    assertStepUp: vi.fn(async () => undefined),
}));

vi.mock('../../server/repositories', () => ({
    usersRepository,
    keysRepository,
    deviceAuthorizationsRepository,
    deviceLinksRepository,
}));
vi.mock('../../server/helpers', () => ({ hashPassword, verifyPassword }));
// No database here: the change's own transaction runs its callback as is.
vi.mock('@spfn/core/db', async (importOriginal) => ({
    ...await importOriginal<typeof import('@spfn/core/db')>(),
    runInTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../server/services/oauth2-grant.service', () => ({ revokeAllOAuth2GrantsForUser }));
// The second-factor gate has its own suites; here it only has to be reachable,
// since this service now calls it before doing anything else.
vi.mock('../../server/services/mfa.service', () => ({ assertStepUp }));

import { changePasswordService } from '../../server/services/auth.service';

describe('changePasswordService — session revocation', () =>
{
    beforeEach(() => vi.clearAllMocks());

    it('revokes all active keys after a successful password change', async () =>
    {
        await changePasswordService({
            userId: 7,
            credential: { kind: 'deviceKey', keyId: 'key-of-the-calling-device' },
            currentPassword: 'old-password',
            newPassword: 'new-password',
            passwordHash: 'old-hash',
        });

        expect(usersRepository.updatePassword).toHaveBeenCalledWith(7, 'new-hash', true);
        expect(keysRepository.revokeAllActiveByUserId).toHaveBeenCalledTimes(1);
        expect(keysRepository.revokeAllActiveByUserId).toHaveBeenCalledWith(7, expect.any(String));
    });

    it('refuses the device authorizations still in flight', async () =>
    {
        // Those are keys not yet handed out. A poll on an approved one would
        // register a fresh active key moments after the change revoked every
        // other, which is the opposite of "log me out everywhere".
        await changePasswordService({
            userId: 7,
            credential: { kind: 'deviceKey', keyId: 'key-of-the-calling-device' },
            currentPassword: 'old-password',
            newPassword: 'new-password',
            passwordHash: 'old-hash',
        });

        expect(deviceAuthorizationsRepository.denyAllActiveByUserId).toHaveBeenCalledWith(7);

        // And the OAuth grants, for the same reason one step further out.
        expect(revokeAllOAuth2GrantsForUser).toHaveBeenCalledWith(7);
    });

    it('refuses when the password changed while the current one was being verified', async () =>
    {
        // The hash read under the account lock is not the one the current
        // password was checked against: another change committed in between,
        // and the current password does not verify against the hash it stored.
        usersRepository.lockAccount
            .mockResolvedValueOnce({ id: 7, passwordHash: 'changed-meanwhile' })
            .mockResolvedValueOnce({ id: 7, passwordHash: 'changed-meanwhile' });
        usersRepository.findByIdOnPrimary.mockResolvedValueOnce({ id: 7, passwordHash: 'changed-meanwhile' });
        verifyPassword.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

        await expect(changePasswordService({
            userId: 7,
            credential: { kind: 'deviceKey', keyId: 'key-of-the-calling-device' },
            currentPassword: 'old-password',
            newPassword: 'new-password',
            passwordHash: 'old-hash',
        })).rejects.toMatchObject({ message: 'Current password is incorrect' });

        expect(verifyPassword).toHaveBeenLastCalledWith('old-password', 'changed-meanwhile');
        expect(usersRepository.updatePassword).not.toHaveBeenCalled();
        expect(keysRepository.revokeAllActiveByUserId).not.toHaveBeenCalled();
    });

    it('changes it when the stored hash moved but still holds the current password', async () =>
    {
        // A sign-in re-encoded the same password meanwhile: the proof is stale,
        // not wrong, and verifies again against what is stored now.
        usersRepository.lockAccount
            .mockResolvedValueOnce({ id: 7, passwordHash: 're-encoded' })
            .mockResolvedValueOnce({ id: 7, passwordHash: 're-encoded' });
        usersRepository.findByIdOnPrimary.mockResolvedValueOnce({ id: 7, passwordHash: 're-encoded' });

        await changePasswordService({
            userId: 7,
            credential: { kind: 'deviceKey', keyId: 'key-of-the-calling-device' },
            currentPassword: 'old-password',
            newPassword: 'new-password',
            passwordHash: 'old-hash',
        });

        expect(verifyPassword).toHaveBeenLastCalledWith('old-password', 're-encoded');
        expect(usersRepository.updatePassword).toHaveBeenCalledWith(7, 'new-hash', true);
        expect(keysRepository.revokeAllActiveByUserId).toHaveBeenCalledWith(7, 'Revoked by password change');
    });
});
