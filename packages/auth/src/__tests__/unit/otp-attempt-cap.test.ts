/**
 * verifyCodeService — OTP attempt-cap enforcement (audit: critical)
 *
 * Repeated wrong guesses must lock the code, and a locked code must not be used
 * even with the right value. Both are conditions of the repository statements
 * (`spendAttempt`, `markAsUsed`, au4-A8); these rows pin how the service answers
 * when those statements refuse.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findValid, spendAttempt, markAsUsed } = vi.hoisted(() => ({
    findValid: vi.fn(),
    spendAttempt: vi.fn(async () => true),
    markAsUsed: vi.fn(async () => true),
}));

vi.mock('../../server/repositories', () => ({
    verificationCodesRepository: {
        findValidByTargetAndPurpose: findValid,
        spendAttempt,
        markAsUsed,
        create: vi.fn(),
        invalidatePreviousCodes: vi.fn(),
    },
    usersRepository: { findByEmail: vi.fn(), findByPhone: vi.fn() },
}));

import { verifyCodeService } from '../../server/services/verification.service';

const base = { target: 'a@b.com', targetType: 'email' as const, purpose: 'account_deletion' as const };
const future = new Date(Date.now() + 300_000);

describe('verifyCodeService — OTP attempt cap', () =>
{
    beforeEach(() => vi.clearAllMocks());

    it('locks once at the cap: a wrong guess the statement no longer counts is "too many attempts"', async () =>
    {
        findValid.mockResolvedValue({ id: 1, code: '123456', attempts: 4, usedAt: null, expiresAt: future });
        spendAttempt.mockResolvedValueOnce(false);

        await expect(verifyCodeService({ ...base, code: '000000' })).rejects.toThrow(/too many attempts/i);
    });

    it('stays locked even when the correct code is supplied after the cap — refused uncompared, as a wrong one is', async () =>
    {
        findValid.mockResolvedValue({ id: 1, code: '123456', attempts: 5, usedAt: null, expiresAt: future });

        await expect(verifyCodeService({ ...base, code: '123456' })).rejects.toThrow(/too many attempts/i);
        expect(markAsUsed).not.toHaveBeenCalled();
        expect(spendAttempt).not.toHaveBeenCalled();
    });

    it('a right code the use statement refuses (used by a concurrent request) is "already used or expired"', async () =>
    {
        findValid.mockResolvedValue({ id: 1, code: '123456', attempts: 2, usedAt: null, expiresAt: future });
        markAsUsed.mockResolvedValueOnce(false);

        await expect(verifyCodeService({ ...base, code: '123456' })).rejects.toThrow(/already used or expired/i);
        expect(markAsUsed).toHaveBeenCalledWith(1, 5, expect.any(Date));
    });

    it('counts a wrong guess while still under the cap', async () =>
    {
        findValid.mockResolvedValue({ id: 1, code: '123456', attempts: 2, usedAt: null, expiresAt: future });

        await expect(verifyCodeService({ ...base, code: '000000' })).rejects.toThrow(/invalid verification code/i);
        expect(spendAttempt).toHaveBeenCalledWith(1, 5);
    });
});
