/**
 * sendVerificationCodeService — account-exists notice on registration (S-L7 follow-up)
 *
 * Requesting a registration code for an already-registered target must:
 *  - notify the owner with the 'account-exists' template (not a usable code),
 *  - return the SAME response shape as a new account (no enumeration),
 *  - dedupe repeat notices (anti email-bomb),
 * while a new target still gets the normal 'verification-code' path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendEmail, sendSMS } = vi.hoisted(() => ({
    sendEmail: vi.fn(async (_opts: { to: string; template: string; data?: unknown }) => ({ success: true })),
    sendSMS: vi.fn(async (_opts: { to: string; template: string; data?: unknown }) => ({ success: true })),
}));

vi.mock('@spfn/notification/server', () => ({ sendEmail, sendSMS }));

vi.mock('../../server/repositories', () => ({
    usersRepository: {
        findByFoldedEmail: vi.fn(),
        findByPhone: vi.fn(),
    },
    verificationCodesRepository: {
        findValidByTargetAndPurpose: vi.fn(),
        invalidatePreviousCodes: vi.fn(async () => undefined),
        create: vi.fn(async () => ({ expiresAt: new Date(Date.now() + 300_000) })),
    },
}));

import { sendVerificationCodeService } from '../../server/services/verification.service';
import { usersRepository, verificationCodesRepository } from '../../server/repositories';

const reg = { target: 'taken@example.com', targetType: 'email' as const, purpose: 'registration' as const };

describe('sendVerificationCodeService — account-exists notice', () =>
{
    beforeEach(() => vi.clearAllMocks());

    it('notifies the owner (account-exists template) and returns a uniform response for an existing account', async () =>
    {
        vi.mocked(usersRepository.findByFoldedEmail).mockResolvedValue({ kind: 'account', user: { id: 1 } } as any);
        vi.mocked(verificationCodesRepository.findValidByTargetAndPurpose).mockResolvedValue(null as any);

        const res = await sendVerificationCodeService(reg);

        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail.mock.calls[0][0]).toMatchObject({ template: 'account-exists' });
        // A dedupe marker is written…
        expect(verificationCodesRepository.create).toHaveBeenCalledTimes(1);
        // …and the response is the same shape as a real code send.
        expect(res).toMatchObject({ success: true });
        expect(typeof res.expiresAt).toBe('string');
    });

    it('dedupes: a recent notice suppresses re-sending', async () =>
    {
        vi.mocked(usersRepository.findByFoldedEmail).mockResolvedValue({ kind: 'account', user: { id: 1 } } as any);
        vi.mocked(verificationCodesRepository.findValidByTargetAndPurpose).mockResolvedValue({ id: 9 } as any);

        const res = await sendVerificationCodeService(reg);

        expect(sendEmail).not.toHaveBeenCalled();
        expect(verificationCodesRepository.create).not.toHaveBeenCalled();
        expect(res).toMatchObject({ success: true });
        expect(typeof res.expiresAt).toBe('string');
    });

    it('sends the normal verification code for a new (non-existent) account', async () =>
    {
        vi.mocked(usersRepository.findByFoldedEmail).mockResolvedValue({ kind: 'none' });

        await sendVerificationCodeService({ ...reg, target: 'new@example.com' });

        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail.mock.calls[0][0]).toMatchObject({ template: 'verification-code' });
    });
});
