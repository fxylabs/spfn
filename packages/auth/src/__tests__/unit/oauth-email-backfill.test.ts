/**
 * backfillVerifiedEmail (issue #44)
 *
 * 과거 provider가 emailVerified=false를 보고해 users.email=null로 만들어진
 * 계정(네이버 등)은 provider 판정이 바뀐 뒤 재로그인하면 검증된 이메일이
 * 계정에 소급 저장되어야 한다. 같은 이메일을 가진 다른 계정이 있으면
 * 건너뛴다(unique 충돌·계정 탈취 방지).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { usersRepository, socialAccountsRepository } = vi.hoisted(() => ({
    usersRepository: {
        findById: vi.fn(),
        findByFoldedEmail: vi.fn(),
        updateById: vi.fn(),
    },
    socialAccountsRepository: {
        create: vi.fn(),
        findByProviderAndProviderId: vi.fn(),
        updateTokens: vi.fn(),
    },
}));

vi.mock('../../server/repositories', () => ({
    usersRepository,
    socialAccountsRepository,
}));

import { backfillVerifiedEmail } from '../../server/services/oauth.service';
import type { NormalizedIdentity } from '../../server/lib/oauth';

const verifiedIdentity: NormalizedIdentity = {
    providerUserId: 'naver-user-id',
    email: 'member@example.com',
    emailVerified: true,
};

describe('backfillVerifiedEmail', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
    });

    it('fills users.email and emailVerifiedAt when the account has no email', async () =>
    {
        usersRepository.findById.mockResolvedValue({ id: 1, email: null });
        usersRepository.findByFoldedEmail.mockResolvedValue({ kind: 'none' });

        await backfillVerifiedEmail(1, verifiedIdentity);

        expect(usersRepository.updateById).toHaveBeenCalledWith(1, {
            email: 'member@example.com',
            emailVerifiedAt: expect.any(Date),
        });
    });

    it('skips when the identity email is missing or unverified', async () =>
    {
        await backfillVerifiedEmail(1, { ...verifiedIdentity, email: null, emailVerified: false });
        await backfillVerifiedEmail(1, { ...verifiedIdentity, emailVerified: false });

        expect(usersRepository.findById).not.toHaveBeenCalled();
        expect(usersRepository.updateById).not.toHaveBeenCalled();
    });

    it('skips when the account already has an email', async () =>
    {
        usersRepository.findById.mockResolvedValue({ id: 1, email: 'existing@example.com' });

        await backfillVerifiedEmail(1, verifiedIdentity);

        expect(usersRepository.updateById).not.toHaveBeenCalled();
    });

    it('skips when another account already owns the email', async () =>
    {
        usersRepository.findById.mockResolvedValue({ id: 1, email: null });
        usersRepository.findByFoldedEmail.mockResolvedValue({ kind: 'account', user: { id: 2, email: 'member@example.com' } });

        await backfillVerifiedEmail(1, verifiedIdentity);

        expect(usersRepository.updateById).not.toHaveBeenCalled();
    });

    it('skips when case variants of the email are held by accounts it cannot choose between (#156)', async () =>
    {
        usersRepository.findById.mockResolvedValue({ id: 1, email: null });
        usersRepository.findByFoldedEmail.mockResolvedValue({ kind: 'ambiguous' });

        await backfillVerifiedEmail(1, verifiedIdentity);

        expect(usersRepository.updateById).not.toHaveBeenCalled();
    });
});
