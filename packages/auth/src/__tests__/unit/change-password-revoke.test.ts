/**
 * changePasswordService — a password change ends every other session (#4, #372)
 *
 * Every active key but the one the request signs with is revoked, so the other
 * sessions are logged out (backend authenticate verifies active keys only); the
 * caller's key is spared, as `revoke-all` spares it, unless `includeCurrent`.
 * Which key that is depends on the credential: a one-time token's is the key
 * that issued it, and an application profile holds none — its key id is the
 * verifier's, never a device key, even when it equals one's id.
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
        revokeAllActiveByUserIdExcept: vi.fn(async () => []),
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
import type { PrincipalCredential } from '../../server/services/admission.service';

describe('changePasswordService — session revocation', () =>
{
    beforeEach(() => vi.clearAllMocks());

    /** The key each credential kind spares — null: it revokes every key. */
    const SPARED: [string, PrincipalCredential, boolean | undefined, string | null][] = [
        ['a device key', { kind: 'deviceKey', keyId: 'key-of-the-calling-device' }, undefined, 'key-of-the-calling-device'],
        ['a device key with includeCurrent', { kind: 'deviceKey', keyId: 'key-of-the-calling-device' }, true, null],
        ['a one-time token', { kind: 'oneTimeToken', issuedByKeyId: 'key-that-issued-it' }, undefined, 'key-that-issued-it'],
        ['an application profile', { kind: 'appProfile', profile: 'partner', keyId: 'key-of-the-calling-device' }, undefined, null],
    ];

    it.each(SPARED)('%s: the change revokes every active key but the one it spares', async (_name, credential, includeCurrent, spared) =>
    {
        await changePasswordService({
            userId: 7,
            credential,
            currentPassword: 'old-password',
            newPassword: 'new-password',
            passwordHash: 'old-hash',
            includeCurrent,
        });

        expect(usersRepository.updatePassword).toHaveBeenCalledWith(7, 'new-hash', true);
        expect({
            all: keysRepository.revokeAllActiveByUserId.mock.calls,
            except: keysRepository.revokeAllActiveByUserIdExcept.mock.calls,
        }).toEqual(spared
            ? { all: [], except: [[7, spared, 'Revoked by password change']] }
            : { all: [[7, 'Revoked by password change']], except: [] });
    });

    it('refuses the device authorizations still in flight', async () =>
    {
        // Those are keys not yet handed out. A poll on an approved one would
        // register a fresh active key moments after the change revoked every
        // other, which is the opposite of "log the others out".
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
        expect(keysRepository.revokeAllActiveByUserIdExcept).not.toHaveBeenCalled();
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
        expect(keysRepository.revokeAllActiveByUserIdExcept).toHaveBeenCalledWith(7, 'key-of-the-calling-device', 'Revoked by password change');
    });
});
