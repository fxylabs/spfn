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
        create: vi.fn(async () => ({ id: 7, expiresAt: new Date(Date.now() + 300_000) })),
        findDeliverable: vi.fn(async () => ({
            id: 7, target: 'new@example.com', targetType: 'email', purpose: 'registration', code: '123456',
        })),
    },
    accountExistsNoticesRepository: {
        claimWindow: vi.fn(),
    },
}));

import { sendVerificationCodeService } from '../../server/services/verification.service';
import { settleLinkMail } from '../../server/lib/link-mail-delivery';
import { accountExistsNoticesRepository, usersRepository, verificationCodesRepository } from '../../server/repositories';
import { authLogger } from '../../server/logger';

const reg = { target: 'taken@example.com', targetType: 'email' as const, purpose: 'registration' as const };

describe('sendVerificationCodeService — account-exists notice', () =>
{
    beforeEach(() => vi.clearAllMocks());

    it('notifies the owner (account-exists template) and returns a uniform response for an existing account', async () =>
    {
        vi.mocked(usersRepository.findByFoldedEmail).mockResolvedValue({ kind: 'account', user: { id: 1 } } as any);
        vi.mocked(accountExistsNoticesRepository.claimWindow).mockResolvedValue(true);

        const res = await sendVerificationCodeService(reg);
        await settleLinkMail();

        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail.mock.calls[0][0]).toMatchObject({ template: 'account-exists' });
        // A code row the verify route reads like any other, holding nothing that can match…
        expect(verificationCodesRepository.create).toHaveBeenCalledTimes(1);
        expect(verificationCodesRepository.create).toHaveBeenCalledWith(expect.objectContaining({ code: 'never-sent' }));
        // …and the response is the same shape as a real code send.
        expect(res).toMatchObject({ success: true });
        expect(typeof res.expiresAt).toBe('string');
    });

    it('dedupes: a recent notice suppresses re-sending', async () =>
    {
        vi.mocked(usersRepository.findByFoldedEmail).mockResolvedValue({ kind: 'account', user: { id: 1 } } as any);
        vi.mocked(accountExistsNoticesRepository.claimWindow).mockResolvedValue(false);

        const res = await sendVerificationCodeService(reg);
        await settleLinkMail();

        expect(sendEmail).not.toHaveBeenCalled();
        expect(verificationCodesRepository.create).toHaveBeenCalledTimes(1);
        expect(res).toMatchObject({ success: true });
        expect(typeof res.expiresAt).toBe('string');
    });

    it('sends the normal verification code for a new (non-existent) account', async () =>
    {
        vi.mocked(usersRepository.findByFoldedEmail).mockResolvedValue({ kind: 'none' });

        await sendVerificationCodeService({ ...reg, target: 'new@example.com' });
        await settleLinkMail();

        expect(sendEmail).toHaveBeenCalledTimes(1);
        expect(sendEmail.mock.calls[0][0]).toMatchObject({ template: 'verification-code' });
    });

    it('row L1: a refused notice is logged without the address it was for (#489)', async () =>
    {
        vi.mocked(usersRepository.findByFoldedEmail).mockResolvedValue({ kind: 'account', user: { id: 1 } } as any);
        vi.mocked(accountExistsNoticesRepository.claimWindow).mockResolvedValue(true);
        sendEmail.mockResolvedValueOnce({ success: false, error: 'provider refused' } as any);
        const spies = [authLogger.email, authLogger.sms, authLogger.service].flatMap(log =>
            (['debug', 'info', 'warn', 'error'] as const).map(level => vi.spyOn(log, level)));

        try
        {
            await sendVerificationCodeService(reg);
            await settleLinkMail();

            const calls = spies.flatMap(spy => spy.mock.calls);
            expect(calls.map(([message]) => message)).toContain('Failed to send account-exists notice');
            expect(JSON.stringify(calls)).not.toContain(reg.target);
        }
        finally
        {
            spies.forEach(spy => spy.mockRestore());
        }
    });
});
