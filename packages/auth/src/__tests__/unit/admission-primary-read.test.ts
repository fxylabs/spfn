/**
 * @spfn/auth - Admission reads the write primary, not a replica (#133)
 *
 * The key-lookup callers outside `authenticate` / `optionalAuth` / clientProofV1
 * (those three have their guards beside their own suites): session binding,
 * session renewal and the renewal middleware. A replica one commit behind would
 * answer a key registered a moment ago as unknown and a key revoked a moment ago
 * as live.
 *
 * Each mock gives the OnPrimary method a value and the replica twin a bare
 * vi.fn(), and every test asserts the twin was never called — a fallback to the
 * replica read shows up as a failed assertion, not as a missing export.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { keysRepository, usersRepository, bearerKeys, roles } = vi.hoisted(() => ({
    keysRepository: {
        findByKeyIdOnPrimary: vi.fn(),
        findByKeyId: vi.fn(),
    },
    usersRepository: {
        findById: vi.fn(),
    },
    bearerKeys: {
        findActiveByKeyIdOnPrimary: vi.fn(),
        findActiveByKeyId: vi.fn(),
        updateLastUsedById: vi.fn(async () => undefined),
    },
    roles: {
        findUserWithEffectiveRole: vi.fn(),
    },
}));

vi.mock('../../server/repositories', () => ({
    keysRepository,
    usersRepository,
    passkeysRepository: {},
    userProfilesRepository: { findLocaleByUserId: vi.fn(async () => 'en') },
}));
vi.mock('../../server/services/passkey.service', () => ({
    assertRecentAuthentication: vi.fn(async () => undefined),
    startRenewalCeremonyService: vi.fn(async () => ({ challenge: 'challenge' })),
    verifyRenewalAssertionService: vi.fn(async () => false),
}));
vi.mock('../../server/services/role-email-domain.service', () => roles);
// `authenticate.ts`, which the renewal middleware borrows `admitBearerKey` from,
// imports its key repository through the package entry.
vi.mock('@spfn/auth/server', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@spfn/auth/server')>()),
    decodeToken: vi.fn(() => ({ keyId: KEY_ID })),
    verifyClientToken: vi.fn(() => ({ keyId: KEY_ID })),
    keysRepository: bearerKeys,
}));

import type { Context } from 'hono';
import { keySessionBindingService } from '../../server/services/session-binding.service';
import { startSessionRenewService } from '../../server/services/session-renew.service';
import { authenticateForRenewal } from '../../server/middleware/authenticate-for-renewal';

const KEY_ID = 'key-primary';
const USER_ID = 3;
const HOUR_MS = 60 * 60 * 1000;

function boundKey()
{
    return {
        id: 1,
        keyId: KEY_ID,
        userId: USER_ID,
        publicKey: 'public-key',
        algorithm: 'ES256',
        isActive: true,
        binding: 'passkey',
        expiresAt: new Date(Date.now() + HOUR_MS),
    };
}

function bearerContext(): Context
{
    return {
        req: {
            header: vi.fn((name: string) => (name === 'Authorization' ? 'Bearer token' : undefined)),
            path: '/_auth/session/renew/options',
        },
        set: vi.fn(),
        get: vi.fn(() => undefined),
    } as never;
}

describe('admission reads the write primary (replica-lag guards, #133)', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
    });

    it('P6 keySessionBindingService: reads the key with findByKeyIdOnPrimary', async () =>
    {
        keysRepository.findByKeyIdOnPrimary.mockResolvedValue(boundKey());

        const answer = await keySessionBindingService(KEY_ID);

        expect(answer.sessionBinding).toBe('passkey');
        expect(keysRepository.findByKeyIdOnPrimary).toHaveBeenCalledWith(KEY_ID);
        expect(keysRepository.findByKeyId).not.toHaveBeenCalled();
    });

    it('P7 startSessionRenewService (admitForRenewal): reads the key with findByKeyIdOnPrimary', async () =>
    {
        keysRepository.findByKeyIdOnPrimary.mockResolvedValue(boundKey());
        usersRepository.findById.mockResolvedValue({ id: USER_ID, status: 'active' });

        await expect(startSessionRenewService({ expiredKeyId: KEY_ID })).resolves.toEqual({ challenge: 'challenge' });

        expect(keysRepository.findByKeyIdOnPrimary).toHaveBeenCalledWith(KEY_ID);
        expect(keysRepository.findByKeyId).not.toHaveBeenCalled();
    });

    it('P8 authenticateForRenewal: reads the key with findActiveByKeyIdOnPrimary', async () =>
    {
        bearerKeys.findActiveByKeyIdOnPrimary.mockResolvedValue(boundKey());
        roles.findUserWithEffectiveRole.mockResolvedValue({ user: { id: USER_ID, status: 'active' }, role: null });
        const next = vi.fn(async () => undefined);

        await authenticateForRenewal.handler(bearerContext(), next);

        expect(next).toHaveBeenCalled();
        expect(bearerKeys.findActiveByKeyIdOnPrimary).toHaveBeenCalledWith(KEY_ID);
        expect(bearerKeys.findActiveByKeyId).not.toHaveBeenCalled();
    });
});
