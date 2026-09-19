/**
 * beforeRegister hook (issue #12)
 *
 * App-injected pre-registration validator: configureAuth({ beforeRegister })
 * must run before the user row is created on every registration channel
 * (credentials / oauth / invitation) and reject the registration when it
 * throws. Without it, policy gates (age gate, domain restriction, block
 * list) are client-only and bypassable by calling the register API directly.
 *
 * Ordering contract: the hook runs AFTER built-in checks (verification
 * token, duplicate account) so existing error precedence is unchanged, and
 * it is NOT called when an OAuth login merely links to an existing account.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
    usersRepository,
    keysRepository,
    socialAccountsRepository,
    invitationsRepository,
    rolesRepository,
    validateVerificationToken,
    registerPublicKeyService,
    getRoleByName,
    hashPassword,
    verifyPassword,
    getDummyPasswordHash,
    events,
} = vi.hoisted(() =>
{
    const emitMock = () => ({ emit: vi.fn(async () => undefined) });

    return {
        usersRepository: {
            findByEmailOrPhone: vi.fn(),
            findByEmail: vi.fn(),
            create: vi.fn(),
            updateById: vi.fn(),
        },
        keysRepository: { create: vi.fn() },
        socialAccountsRepository: { create: vi.fn() },
        invitationsRepository: {
            findByToken: vi.fn(),
            updateStatus: vi.fn(),
        },
        rolesRepository: { findById: vi.fn() },
        validateVerificationToken: vi.fn(),
        registerPublicKeyService: vi.fn(async () => ({ pending: false, binding: 'none', expiresAt: null })),
        getRoleByName: vi.fn(async () => ({ id: 1, name: 'user' })),
        hashPassword: vi.fn(async () => 'hashed-password'),
        verifyPassword: vi.fn(),
        getDummyPasswordHash: vi.fn(),
        events: {
            authLoginEvent: emitMock(),
            authRegisterEvent: emitMock(),
            invitationCreatedEvent: emitMock(),
            invitationAcceptedEvent: emitMock(),
        },
    };
});

vi.mock('../../server/repositories', () => ({
    usersRepository,
    keysRepository,
    socialAccountsRepository,
    invitationsRepository,
    rolesRepository,
}));
vi.mock('../../server/services/verification.service', () => ({ validateVerificationToken }));
vi.mock('../../server/services/key.service', () => ({ registerPublicKeyService }));
vi.mock('../../server/services/role.service', () => ({ getRoleByName }));
// normalizeEmail is the real one: the services compare a token's target against
// the supplied address in canonical form, so a stub would make the comparison
// pass or fail for reasons unrelated to the hook under test.
vi.mock('../../server/helpers', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('../../server/helpers')>();

    return { ...actual, hashPassword, verifyPassword, getDummyPasswordHash };
});
vi.mock('../../server/events', () => events);

import { registerService } from '../../server/services/auth.service';
import { createOrLinkUser } from '../../server/services/oauth.service';
import { acceptInvitation } from '../../server/services/invitation.service';
import { configureAuth, type BeforeRegisterContext } from '../../server/lib/config';
// Package specifier (not a relative path) so `instanceof` matches the classes
// the services themselves throw.
import { RegistrationRejectedError, AccountAlreadyExistsError } from '@spfn/auth/errors';
import { generateKeyPair } from '../../server/lib/crypto';

// acceptInvitation은 키 자료를 직접 저장하는 유일한 경로라 알고리즘 검사를 자기가 한다.
// 자리표시자 문자열이면 훅에 닿기 전에 거절되므로, 여기서는 진짜 P-256 SPKI를 쓴다.
const INVITE_PUBLIC_KEY = generateKeyPair('ES256').publicKey;

const registerParams = {
    email: 'kid@example.com',
    verificationToken: 'token',
    password: 'secret',
    publicKey: 'pub',
    keyId: 'key-1',
    fingerprint: 'fp',
    metadata: { birthDate: '2015-01-01' },
};

function rejectAll()
{
    const contexts: BeforeRegisterContext[] = [];
    const hook = vi.fn(async (ctx: BeforeRegisterContext) =>
    {
        contexts.push(ctx);
        throw new RegistrationRejectedError({ message: 'Age requirement not met' });
    });

    return { hook, contexts };
}

describe('beforeRegister hook', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        validateVerificationToken.mockReturnValue({
            purpose: 'registration',
            target: 'kid@example.com',
            targetType: 'email',
        });
        usersRepository.findByEmailOrPhone.mockResolvedValue(null);
        usersRepository.findByEmail.mockResolvedValue(null);
        usersRepository.create.mockResolvedValue({
            id: 10,
            publicId: 'pub-10',
            email: 'kid@example.com',
            phone: null,
        });
    });

    afterEach(() => configureAuth({ beforeRegister: undefined }));

    describe('credentials (registerService)', () =>
    {
        it('rejects the registration before any user row is created', async () =>
        {
            const { hook, contexts } = rejectAll();
            configureAuth({ beforeRegister: hook });

            await expect(registerService(registerParams))
                .rejects.toBeInstanceOf(RegistrationRejectedError);

            expect(contexts[0]).toEqual({
                channel: 'credentials',
                email: 'kid@example.com',
                phone: undefined,
                metadata: { birthDate: '2015-01-01' },
            });
            expect(usersRepository.create).not.toHaveBeenCalled();
            expect(events.authRegisterEvent.emit).not.toHaveBeenCalled();
        });

        it('lets the registration through when the hook does not throw', async () =>
        {
            const hook = vi.fn(async () => undefined);
            configureAuth({ beforeRegister: hook });

            const result = await registerService(registerParams);

            expect(hook).toHaveBeenCalledTimes(1);
            expect(result).toMatchObject({ userId: '10', publicId: 'pub-10' });
            expect(usersRepository.create).toHaveBeenCalledTimes(1);
        });

        it('runs after the duplicate-account check (error precedence unchanged)', async () =>
        {
            const { hook } = rejectAll();
            configureAuth({ beforeRegister: hook });
            usersRepository.findByEmailOrPhone.mockResolvedValue({ id: 1 });

            await expect(registerService(registerParams))
                .rejects.toBeInstanceOf(AccountAlreadyExistsError);

            expect(hook).not.toHaveBeenCalled();
        });

        it('is a no-op when not configured (backward compatible)', async () =>
        {
            const result = await registerService(registerParams);

            expect(result).toMatchObject({ userId: '10' });
        });
    });

    describe('oauth (createOrLinkUser)', () =>
    {
        const identity = {
            providerUserId: 'g-1',
            email: 'kid@example.com',
            emailVerified: true,
        };

        it('rejects a new-user signup, passing provider and start metadata', async () =>
        {
            const { hook, contexts } = rejectAll();
            configureAuth({ beforeRegister: hook });

            await expect(createOrLinkUser('google', identity, undefined, { birthDate: '2015-01-01' }))
                .rejects.toBeInstanceOf(RegistrationRejectedError);

            expect(contexts[0]).toEqual({
                channel: 'oauth',
                provider: 'google',
                email: 'kid@example.com',
                emailVerified: true,
                metadata: { birthDate: '2015-01-01' },
            });
            expect(usersRepository.create).not.toHaveBeenCalled();
            expect(socialAccountsRepository.create).not.toHaveBeenCalled();
        });

        it('signals an unverified provider email so email-based policies can tell', async () =>
        {
            const { hook, contexts } = rejectAll();
            configureAuth({ beforeRegister: hook });

            await expect(createOrLinkUser('google', { ...identity, emailVerified: false }))
                .rejects.toBeInstanceOf(RegistrationRejectedError);

            expect(contexts[0]).toMatchObject({
                channel: 'oauth',
                email: 'kid@example.com',
                emailVerified: false,
            });
        });

        it('creates an OAuth-only user without trusting an unverified provider email', async () =>
        {
            const unverifiedIdentity = {
                providerUserId: 'naver-1',
                email: 'naver-user@example.com',
                emailVerified: false,
            };

            const result = await createOrLinkUser('naver', unverifiedIdentity);

            expect(result).toEqual({ userId: 10, isNewUser: true });
            expect(usersRepository.create).toHaveBeenCalledWith(expect.objectContaining({
                email: null,
                phone: null,
            }));
            expect(socialAccountsRepository.create).toHaveBeenCalledWith(expect.objectContaining({
                provider: 'naver',
                providerUserId: 'naver-1',
                providerEmail: 'naver-user@example.com',
            }));
        });

        it('does not run when linking a social account to an existing user', async () =>
        {
            const { hook } = rejectAll();
            configureAuth({ beforeRegister: hook });
            usersRepository.findByEmail.mockResolvedValue({ id: 7, emailVerifiedAt: new Date() });

            const result = await createOrLinkUser('google', identity);

            expect(hook).not.toHaveBeenCalled();
            expect(result).toEqual({ userId: 7, isNewUser: false });
        });
    });

    describe('invitation (acceptInvitation)', () =>
    {
        it('rejects the acceptance, passing the invitation metadata', async () =>
        {
            const { hook, contexts } = rejectAll();
            configureAuth({ beforeRegister: hook });
            invitationsRepository.findByToken.mockResolvedValue({
                id: 5,
                email: 'invitee@example.com',
                status: 'pending',
                expiresAt: new Date(Date.now() + 86_400_000),
                roleId: 2,
                invitedBy: 7,
                metadata: { team: 'design' },
            });
            rolesRepository.findById.mockResolvedValue({ id: 2, name: 'member' });

            await expect(acceptInvitation({
                token: 'invite-token',
                password: 'secret',
                publicKey: INVITE_PUBLIC_KEY,
                keyId: 'key-2',
                fingerprint: 'fp',
                algorithm: 'ES256',
            })).rejects.toBeInstanceOf(RegistrationRejectedError);

            expect(contexts[0]).toEqual({
                channel: 'invitation',
                email: 'invitee@example.com',
                metadata: { team: 'design' },
            });
            expect(usersRepository.create).not.toHaveBeenCalled();
            expect(invitationsRepository.updateStatus).not.toHaveBeenCalled();
        });

        it('normalizes a NULL metadata column to undefined (contract type)', async () =>
        {
            const { hook, contexts } = rejectAll();
            configureAuth({ beforeRegister: hook });
            invitationsRepository.findByToken.mockResolvedValue({
                id: 6,
                email: 'invitee@example.com',
                status: 'pending',
                expiresAt: new Date(Date.now() + 86_400_000),
                roleId: 2,
                invitedBy: 7,
                metadata: null,
            });
            rolesRepository.findById.mockResolvedValue({ id: 2, name: 'member' });

            await expect(acceptInvitation({
                token: 'invite-token',
                password: 'secret',
                publicKey: INVITE_PUBLIC_KEY,
                keyId: 'key-3',
                fingerprint: 'fp',
                algorithm: 'ES256',
            })).rejects.toBeInstanceOf(RegistrationRejectedError);

            expect(contexts[0].metadata).toBeUndefined();
        });
    });
});
