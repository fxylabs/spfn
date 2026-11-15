/**
 * backfillVerifiedEmail (issue #44)
 *
 * 과거 provider가 emailVerified=false를 보고해 users.email=null로 만들어진
 * 계정(네이버 등)은 provider 판정이 바뀐 뒤 재로그인하면 검증된 이메일이
 * 계정에 소급 저장되어야 한다. 같은 이메일을 가진 다른 계정이 있으면
 * 건너뛴다(unique 충돌·계정 탈취 방지) — 그 판단은 저장소의 조건부 UPDATE가 한다.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { usersRepository, socialAccountsRepository } = vi.hoisted(() => ({
    usersRepository: {
        fillEmailIfUnheld: vi.fn(),
    },
    socialAccountsRepository: {},
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

/**
 * Which accounts may receive the address is the repository statement's rule —
 * see integration/oauth-email-backfill.test.ts, which runs it against the
 * database. Here: when it is asked, and that its failure is not hidden.
 */
describe('backfillVerifiedEmail', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
    });

    it('offers a verified email to the account', async () =>
    {
        usersRepository.fillEmailIfUnheld.mockResolvedValue(true);

        await backfillVerifiedEmail(1, verifiedIdentity);

        expect(usersRepository.fillEmailIfUnheld).toHaveBeenCalledWith(1, 'member@example.com');
    });

    it('skips when the identity email is missing or unverified', async () =>
    {
        await backfillVerifiedEmail(1, { ...verifiedIdentity, email: null, emailVerified: false });
        await backfillVerifiedEmail(1, { ...verifiedIdentity, emailVerified: false });

        expect(usersRepository.fillEmailIfUnheld).not.toHaveBeenCalled();
    });

    it('lets a failure of the statement through instead of continuing the sign-in', async () =>
    {
        usersRepository.fillEmailIfUnheld.mockRejectedValue(new Error('connection lost'));

        await expect(backfillVerifiedEmail(1, verifiedIdentity)).rejects.toThrow('connection lost');
    });
});
