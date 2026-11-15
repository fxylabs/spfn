/**
 * verifyCodeService — OTP attempt-cap enforcement (audit: critical)
 *
 * The attempt cap must be checked BEFORE the code comparison, so repeated wrong
 * guesses actually lock the code. Previously the cap ran only after a correct
 * match (the wrong-code branch returned early), making it dead code → unlimited
 * OTP brute force (account takeover via password_reset).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findValid, incrementAttempts, markAsUsed } = vi.hoisted(() => ({
    findValid: vi.fn(),
    incrementAttempts: vi.fn(async () => undefined),
    markAsUsed: vi.fn(async () => undefined),
}));

vi.mock('../../server/repositories', () => ({
    verificationCodesRepository: {
        findValidByTargetAndPurpose: findValid,
        incrementAttempts,
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

    it('locks once at the cap, before comparing the code, on a wrong guess', async () =>
    {
        findValid.mockResolvedValue({ id: 1, code: '123456', attempts: 5, usedAt: null, expiresAt: future });

        await expect(verifyCodeService({ ...base, code: '000000' })).rejects.toThrow(/too many attempts/i);
        // Cap is enforced before the wrong-code branch, so it must NOT increment further.
        expect(incrementAttempts).not.toHaveBeenCalled();
    });

    it('stays locked even when the correct code is supplied after the cap', async () =>
    {
        findValid.mockResolvedValue({ id: 1, code: '123456', attempts: 5, usedAt: null, expiresAt: future });

        await expect(verifyCodeService({ ...base, code: '123456' })).rejects.toThrow(/too many attempts/i);
        expect(markAsUsed).not.toHaveBeenCalled();
    });

    it('increments on a wrong guess while still under the cap', async () =>
    {
        findValid.mockResolvedValue({ id: 1, code: '123456', attempts: 2, usedAt: null, expiresAt: future });

        await expect(verifyCodeService({ ...base, code: '000000' })).rejects.toThrow();
        expect(incrementAttempts).toHaveBeenCalledTimes(1);
    });
});
