/**
 * @spfn/auth - Authentication Middleware Tests
 *
 * Exercises the authenticate middleware step by step. The middleware decodes
 * the Bearer token to read its embedded keyId, loads the key + user via the
 * repositories, and verifies the signature — so we mock the jwt helpers and the
 * repositories the middleware actually depends on and drive each branch.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// The middleware imports decodeToken / verifyClientToken / the repositories from
// the '@spfn/auth/server' barrel (which resolves to the built package, not src),
// so the mock has to target that barrel for the middleware to see it.
vi.mock('@spfn/auth/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/auth/server')>();

    return {
        ...actual,
        decodeToken: vi.fn(),
        verifyClientToken: vi.fn(),
        keysRepository: { findActiveByKeyId: vi.fn(), updateLastUsedById: vi.fn().mockResolvedValue(undefined) },
        findUserWithEffectiveRole: vi.fn(),
        userProfilesRepository: { findLocaleByUserId: vi.fn().mockResolvedValue('en') },
        getPendingDeletionInfo: vi.fn(),
    };
});

import { authenticate } from '@/server/middleware/authenticate';
import {
    decodeToken,
    verifyClientToken,
    keysRepository,
    findUserWithEffectiveRole,
    userProfilesRepository,
    getPendingDeletionInfo,
} from '@spfn/auth/server';
import type { Context, Next } from 'hono';

const KEY_ID = 'test-key-id';

/** A valid, unexpired key record as returned by keysRepository.findActiveByKeyId. */
function validKeyRecord(overrides: Record<string, unknown> = {})
{
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 90);

    return {
        id: 1,
        keyId: KEY_ID,
        userId: 1,
        publicKey: 'mock-public-key',
        algorithm: 'ES256',
        isActive: true,
        expiresAt: futureDate,
        ...overrides,
    };
}

describe('Authenticate Middleware', () =>
{
    let mockContext: Partial<Context>;
    let mockNext: Next;

    beforeEach(() =>
    {
        vi.clearAllMocks();
        vi.mocked(keysRepository.updateLastUsedById).mockResolvedValue(undefined as never);
        vi.mocked(userProfilesRepository.findLocaleByUserId).mockResolvedValue('en' as never);

        mockNext = vi.fn();
        mockContext = {
            req: { header: vi.fn() } as never,
            json: vi.fn((data, status) => ({ data, status })) as never,
            set: vi.fn(),
            // A Hono context that has set() has get(); the double needs both,
            // because authenticate reads the client identity the version
            // middleware leaves on the context. Undefined is the honest answer
            // here: these cases mount no version middleware.
            get: vi.fn(() => undefined),
        } as never;
    });

    /** Make the request present `Authorization: Bearer <token>`. */
    function withBearer(token = 'valid-token')
    {
        (mockContext.req!.header as ReturnType<typeof vi.fn>).mockImplementation(
            (name: string) => (name === 'Authorization' ? `Bearer ${token}` : undefined),
        );
    }

    describe('Header Validation', () =>
    {
        it('rejects a request without an Authorization header', async () =>
        {
            (mockContext.req!.header as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

            await expect(authenticate.handler(mockContext as Context, mockNext))
                .rejects.toThrow('Authentication header missing or invalid');
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('rejects a request with a non-Bearer Authorization header', async () =>
        {
            (mockContext.req!.header as ReturnType<typeof vi.fn>).mockImplementation(
                (name: string) => (name === 'Authorization' ? 'InvalidFormat token' : undefined),
            );

            await expect(authenticate.handler(mockContext as Context, mockNext))
                .rejects.toThrow('Authentication header missing or invalid');
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('rejects a token whose payload has no keyId', async () =>
        {
            withBearer();
            vi.mocked(decodeToken).mockReturnValue({} as never);

            await expect(authenticate.handler(mockContext as Context, mockNext))
                .rejects.toThrow('Invalid token: missing keyId');
            expect(mockNext).not.toHaveBeenCalled();
        });
    });

    describe('Key Validation', () =>
    {
        beforeEach(() =>
        {
            withBearer();
            vi.mocked(decodeToken).mockReturnValue({ keyId: KEY_ID } as never);
        });

        it('rejects an invalid or revoked key', async () =>
        {
            vi.mocked(keysRepository.findActiveByKeyId).mockResolvedValue(null as never);

            await expect(authenticate.handler(mockContext as Context, mockNext))
                .rejects.toThrow('Invalid or revoked key');
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('rejects an expired key', async () =>
        {
            const expiredDate = new Date();
            expiredDate.setDate(expiredDate.getDate() - 1);
            vi.mocked(keysRepository.findActiveByKeyId).mockResolvedValue(
                validKeyRecord({ expiresAt: expiredDate }) as never,
            );

            await expect(authenticate.handler(mockContext as Context, mockNext))
                .rejects.toThrow('Public key has expired');
            expect(mockNext).not.toHaveBeenCalled();
        });
    });

    describe('User Validation', () =>
    {
        beforeEach(() =>
        {
            withBearer();
            vi.mocked(decodeToken).mockReturnValue({ keyId: KEY_ID } as never);
            vi.mocked(keysRepository.findActiveByKeyId).mockResolvedValue(validKeyRecord() as never);
            // Signature verification passes for these tests
            vi.mocked(verifyClientToken).mockReturnValue({ keyId: KEY_ID, iss: 'spfn-client' } as never);
        });

        it('rejects when the user is not found', async () =>
        {
            vi.mocked(findUserWithEffectiveRole).mockResolvedValue(null as never);

            await expect(authenticate.handler(mockContext as Context, mockNext))
                .rejects.toThrow('User not found');
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('rejects when the user account is inactive', async () =>
        {
            vi.mocked(findUserWithEffectiveRole).mockResolvedValue({
                user: { id: 1, email: 'test@example.com', status: 'inactive' },
                role: null,
            } as never);

            await expect(authenticate.handler(mockContext as Context, mockNext))
                .rejects.toThrow('Account is inactive');
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('rejects when the user account is suspended', async () =>
        {
            vi.mocked(findUserWithEffectiveRole).mockResolvedValue({
                user: { id: 1, email: 'test@example.com', status: 'suspended' },
                role: null,
            } as never);

            await expect(authenticate.handler(mockContext as Context, mockNext))
                .rejects.toThrow('Account is suspended');
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('rejects a pending_deletion account with AccountPendingDeletionError, carrying purgeScheduledAt', async () =>
        {
            vi.mocked(findUserWithEffectiveRole).mockResolvedValue({
                user: { id: 1, email: 'test@example.com', status: 'pending_deletion' },
                role: null,
            } as never);
            const purgeScheduledAt = new Date('2030-01-01T00:00:00.000Z');
            vi.mocked(getPendingDeletionInfo).mockResolvedValue({ purgeScheduledAt } as never);

            const error = await authenticate.handler(mockContext as Context, mockNext).catch((e) => e);

            expect(error.name).toBe('AccountPendingDeletionError');
            expect(error.details).toMatchObject({
                status: 'pending_deletion',
                purgeScheduledAt: purgeScheduledAt.toISOString(),
            });
            expect(mockNext).not.toHaveBeenCalled();
        });
    });

    describe('Successful Authentication', () =>
    {
        it('attaches the auth context and calls next for a valid token + active user', async () =>
        {
            withBearer();
            vi.mocked(decodeToken).mockReturnValue({ keyId: KEY_ID } as never);
            vi.mocked(keysRepository.findActiveByKeyId).mockResolvedValue(validKeyRecord() as never);
            vi.mocked(verifyClientToken).mockReturnValue({ keyId: KEY_ID, iss: 'spfn-client' } as never);
            vi.mocked(findUserWithEffectiveRole).mockResolvedValue({
                user: { id: 1, email: 'test@example.com', status: 'active' },
                role: { name: 'user' },
            } as never);

            await authenticate.handler(mockContext as Context, mockNext);

            expect(mockContext.set).toHaveBeenCalledWith('auth', expect.objectContaining({
                userId: '1',
                keyId: KEY_ID,
                role: 'user',
                locale: 'en',
            }));
            expect(mockNext).toHaveBeenCalled();
        });
    });
});
