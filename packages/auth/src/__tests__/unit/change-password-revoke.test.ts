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
    verifyPassword,
    hashPassword,
    revokeAllOAuth2GrantsForUser,
} = vi.hoisted(() => ({
    usersRepository: {
        findById: vi.fn(),
        updatePassword: vi.fn(async () => undefined),
    },
    keysRepository: {
        revokeAllActiveByUserId: vi.fn(async () => []),
    },
    deviceAuthorizationsRepository: {
        denyAllActiveByUserId: vi.fn(async () => []),
    },
    verifyPassword: vi.fn(async () => true),
    hashPassword: vi.fn(async () => 'new-hash'),
    revokeAllOAuth2GrantsForUser: vi.fn(async () => undefined),
}));

vi.mock('../../server/repositories', () => ({
    usersRepository,
    keysRepository,
    deviceAuthorizationsRepository,
}));
vi.mock('../../server/helpers', () => ({ hashPassword, verifyPassword }));
vi.mock('../../server/services/oauth2-grant.service', () => ({ revokeAllOAuth2GrantsForUser }));

import { changePasswordService } from '../../server/services/auth.service';

describe('changePasswordService — session revocation', () =>
{
    beforeEach(() => vi.clearAllMocks());

    it('revokes all active keys after a successful password change', async () =>
    {
        await changePasswordService({
            userId: 7,
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
            currentPassword: 'old-password',
            newPassword: 'new-password',
            passwordHash: 'old-hash',
        });

        expect(deviceAuthorizationsRepository.denyAllActiveByUserId).toHaveBeenCalledWith(7);

        // And the OAuth grants, for the same reason one step further out.
        expect(revokeAllOAuth2GrantsForUser).toHaveBeenCalledWith(7);
    });
});
