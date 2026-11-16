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
        // The admission's one primary read: the account, its role and the key.
        findByIdWithRoleAndKeyOnPrimary: vi.fn(),
        findById: vi.fn(),
    },
    bearerKeys: {
        findWithAccountEpochOnPrimary: vi.fn(),
        findActiveByKeyId: vi.fn(),
        updateLastUsedById: vi.fn(async () => undefined),
    },
    // `role-email-domain.service`, mocked whole below: the admission applies the
    // role in force to its primary read through `resolveRoleInForce`.
    roles: {
        findUserWithEffectiveRole: vi.fn(),
        resolveRoleInForce: vi.fn(async (read: { role: unknown }) => read.role),
    },
}));

vi.mock('../../server/repositories', () => ({
    keysRepository,
    usersRepository,
    passkeysRepository: {},
    userSettingsRepository: { findLocaleByUserId: vi.fn(async () => 'en') },
    accountDeletionRequestsRepository: { findPendingByUserIdOnPrimary: vi.fn(async () => null) },
}));
vi.mock('../../server/services/passkey.service', () => ({
    assertRecentAuthentication: vi.fn(async () => undefined),
    startRenewalCeremonyService: vi.fn(async () => ({ challenge: 'challenge' })),
    checkRenewalAssertionService: vi.fn(async () => null),
}));
vi.mock('../../server/services/role-email-domain.service', () => roles);
// `authenticate.ts`, which the renewal middleware borrows `admitBearerKey` from,
// imports its key repository through the package entry.
vi.mock('@spfn/auth/server', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@spfn/auth/server')>()),
    decodeToken: vi.fn(() => ({ keyId: KEY_ID })),
    verifyClientToken: vi.fn(() => ({ payload: { keyId: KEY_ID } })),
    keysRepository: bearerKeys,
}));

import type { Context } from 'hono';
import { keySessionBindingService } from '../../server/services/session-binding.service';
import { startSessionRenewService, finishSessionRenewService } from '../../server/services/session-renew.service';
import { authenticateForRenewal } from '../../server/middleware/authenticate-for-renewal';
// Same module the service throws from — a relative path resolves to a different
// alias and instanceof/toThrow(Class) comes out false.
import { SessionRenewalRefusedError } from '@spfn/auth/errors';

const KEY_ID = 'key-primary';
const USER_ID = 3;
const HOUR_MS = 60 * 60 * 1000;

/** What the admission reads on the primary for a renewal: the account, its role, the key. */
function admissionRow(status = 'active')
{
    return { user: { id: USER_ID, status, keyEpoch: 0 }, role: null, key: boundKey() };
}

function boundKey()
{
    return {
        id: 1,
        keyId: KEY_ID,
        userId: USER_ID,
        publicKey: 'public-key',
        algorithm: 'ES256',
        isActive: true,
        keyEpoch: 0,
        accountKeyEpoch: 0,
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

    it('P7 startSessionRenewService (admitForRenewal): reads the key and the account on the primary', async () =>
    {
        keysRepository.findByKeyIdOnPrimary.mockResolvedValue(boundKey());
        usersRepository.findByIdWithRoleAndKeyOnPrimary.mockResolvedValue(admissionRow());

        await expect(startSessionRenewService({ expiredKeyId: KEY_ID })).resolves.toEqual({ challenge: 'challenge' });

        expect(keysRepository.findByKeyIdOnPrimary).toHaveBeenCalledWith(KEY_ID);
        expect(keysRepository.findByKeyId).not.toHaveBeenCalled();
        expect(usersRepository.findByIdWithRoleAndKeyOnPrimary).toHaveBeenCalledWith(USER_ID, KEY_ID);
        expect(usersRepository.findById).not.toHaveBeenCalled();
    });

    it('P9 finishSessionRenewService (admitForRenewal): reads the account on the primary before the assertion refusal', async () =>
    {
        keysRepository.findByKeyIdOnPrimary.mockResolvedValue(boundKey());
        usersRepository.findByIdWithRoleAndKeyOnPrimary.mockResolvedValue(admissionRow());

        await expect(finishSessionRenewService({
            expiredKeyId: KEY_ID,
            response: {} as never,
            keyId: 'key-new',
            publicKey: 'public-key-new',
            fingerprint: 'fingerprint-new',
        })).rejects.toThrow(SessionRenewalRefusedError);

        expect(usersRepository.findByIdWithRoleAndKeyOnPrimary).toHaveBeenCalledWith(USER_ID, KEY_ID);
        expect(usersRepository.findById).not.toHaveBeenCalled();
    });

    it('P10 startSessionRenewService: a primary answer of a suspended account refuses without consulting the replica', async () =>
    {
        keysRepository.findByKeyIdOnPrimary.mockResolvedValue(boundKey());
        usersRepository.findByIdWithRoleAndKeyOnPrimary.mockResolvedValue(admissionRow('suspended'));

        await expect(startSessionRenewService({ expiredKeyId: KEY_ID })).rejects.toThrow(SessionRenewalRefusedError);

        expect(usersRepository.findByIdWithRoleAndKeyOnPrimary).toHaveBeenCalledWith(USER_ID, KEY_ID);
        expect(usersRepository.findById).not.toHaveBeenCalled();
    });

    it('P8 authenticateForRenewal: reads the key with findWithAccountEpochOnPrimary', async () =>
    {
        bearerKeys.findWithAccountEpochOnPrimary.mockResolvedValue(boundKey());
        usersRepository.findByIdWithRoleAndKeyOnPrimary.mockResolvedValue(admissionRow());
        const next = vi.fn(async () => undefined);

        await authenticateForRenewal.handler(bearerContext(), next);

        expect(next).toHaveBeenCalled();
        expect(bearerKeys.findWithAccountEpochOnPrimary).toHaveBeenCalledWith(KEY_ID);
        expect(bearerKeys.findActiveByKeyId).not.toHaveBeenCalled();
        expect(usersRepository.findByIdWithRoleAndKeyOnPrimary).toHaveBeenCalledWith(USER_ID, KEY_ID);
        expect(roles.findUserWithEffectiveRole).not.toHaveBeenCalled();
    });
});
