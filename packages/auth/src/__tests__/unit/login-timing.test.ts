/**
 * loginService — user-enumeration timing equalization (S-L7)
 *
 * A login attempt for a non-existent account must still run the password verify
 * (against a dummy hash) so its response time matches a wrong-password attempt;
 * otherwise the presence/absence of bcrypt leaks whether the account exists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../server/repositories', () => ({
    usersRepository: {
        findByEmailOrPhoneOnPrimary: vi.fn(),
    },
}));

vi.mock('../../server/helpers', () => ({
    hashPassword: vi.fn(async () => '$2b$12$dummydummydummydummydummydummydummydummydummydummydu'),
    verifyPassword: vi.fn(async () => false),
    getDummyPasswordHash: vi.fn(async () => '$2b$12$dummydummydummydummydummydummydummydummydummydummydu'),
}));

vi.mock('../../server/events', () => ({
    authLoginEvent: { emit: vi.fn() },
    authRegisterEvent: { emit: vi.fn() },
}));

vi.mock('../../server/services/verification.service', () => ({
    validateVerificationToken: vi.fn(),
}));

import { loginService } from '../../server/services/auth.service';
import { usersRepository } from '../../server/repositories';
import { verifyPassword } from '../../server/helpers';
import { InvalidCredentialsError } from '@spfn/auth/errors';

const loginParams = {
    email: 'nobody@example.com',
    password: 'whatever-password',
    publicKey: 'pk',
    keyId: 'kid',
    fingerprint: 'fp',
    algorithm: 'ES256' as const,
};

describe('loginService — timing equalization for missing accounts', () =>
{
    beforeEach(() => vi.clearAllMocks());

    it('still runs verifyPassword when the account does not exist', async () =>
    {
        vi.mocked(usersRepository.findByEmailOrPhoneOnPrimary).mockResolvedValue(null);

        await expect(loginService(loginParams)).rejects.toBeInstanceOf(InvalidCredentialsError);

        // The dummy verify must run so a missing account isn't faster than a wrong password.
        expect(verifyPassword).toHaveBeenCalledTimes(1);
    });
});
