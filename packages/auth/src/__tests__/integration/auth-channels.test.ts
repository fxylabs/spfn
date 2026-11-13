/**
 * @spfn/auth - An app chooses which sign-in channels exist (#308)
 *
 * One test per row C2–C12 of the #308 case table. C1 is every other suite
 * staying green; C13 and the option's own validation are in
 * unit/auth-channels.test.ts.
 *
 * Driven against the mounted auth router with `authenticate` as the
 * server-level middleware, the way a real server mounts it, so a signed-in
 * route of a closed channel is shown to answer 404 rather than the global
 * middleware's 401. Social sign-in uses a Kakao stand-in whose codes and
 * id_tokens name the identity they establish, as oauth-email-match.test.ts
 * does; the real Kakao provider is put back after the file.
 *
 * Every test puts the channels back: the package's tests share one fork, so a
 * setting left behind would close a channel under the next file.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import {
    JSON_HEADERS,
    TEST_PASSWORD,
    createTestUser,
    mountAuthApp,
    resetMemoryRateLimitStore,
    signIn,
} from '../helpers/oauth2';
import {
    deviceAuthorizations,
    deviceLinks,
    passwordResetTokens,
    signupLinkTokens,
    userInvitations,
    userPublicKeys,
    userSocialAccounts,
    users,
    verificationCodes,
} from '@/server/entities';
import { generateKeyPair, type KeyPair } from '@/server/lib/crypto';
import { configureChannels, type AuthChannel } from '@/server/lib/channels-config';
import { registerOAuthProvider, type NormalizedIdentity, type OAuthProvider } from '@/server/lib/oauth';
import { kakaoProvider } from '@/server/lib/oauth/kakao-provider';
import { buildStartCookieName } from '@/server/lib/oauth/start-cookies';
import { createOAuthState, generateOAuthNonce } from '@/server/lib/oauth/state';
import type { VerificationPurpose } from '@/server/routes/schema';

const sendEmail = vi.fn().mockResolvedValue({ success: true });

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return { ...actual, sendEmail: (...args: unknown[]) => sendEmail(...args) };
});

const { runInTransaction } = await import('@spfn/core/db');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { startDeviceAuthService } = await import('@/server/services/device-auth.service');
const { issueDeviceLinkService } = await import('@/server/services/device-link.service');
const { requestSignupLinkService } = await import('@/server/services/signup-link.service');
const { requestPasswordResetService } = await import('@/server/services/password-reset.service');
const { sendVerificationCodeService } = await import('@/server/services/verification.service');

const dbAvailable = await isDatabaseAvailable();

const APP_URL = 'http://localhost:3000';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 9).toString('base64')}`;
const INVITATION_TOKEN = '33333333-3333-4333-8333-333333333333';
const UNKNOWN_LINK_ID = '44444444-4444-4444-8444-444444444444';

const NEW_IDENTITY: NormalizedIdentity = {
    providerUserId: 'ch308-new', email: 'new@ch308.test', emailVerified: true,
};
const LINKED_IDENTITY: NormalizedIdentity = {
    providerUserId: 'ch308-linked', email: 'linked@ch308.test', emailVerified: true,
};
const MATCHING_IDENTITY: NormalizedIdentity = {
    providerUserId: 'ch308-matching', email: 'owner@ch308.test', emailVerified: true,
};

const identities = new Map<string, NormalizedIdentity>([
    ['code-new', NEW_IDENTITY],
    ['code-linked', LINKED_IDENTITY],
    ['code-matching', MATCHING_IDENTITY],
]);

function kakaoStandIn(): OAuthProvider
{
    return {
        id: 'kakao',
        isEnabled: () => true,
        getAuthUrl: (state: string) => `https://kauth.ch308.example/authorize?state=${state}`,
        exchangeCodeForTokens: async (code: string) =>
            ({ accessToken: `access-${code}`, expiresIn: 86400, identity: identities.get(code) }),
        getUserInfo: async () =>
        {
            throw new Error('the stand-in answers identity from the token response');
        },
        verifyNativeIdToken: async (idToken: string) => identities.get(idToken)!,
    };
}

function deviceKeyBody(key: KeyPair = generateKeyPair('ES256'))
{
    return { publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm };
}

/** One request per route of a group, each with a body its validation would accept. */
interface GroupRoute
{
    key: string;
    path: string;
    body: Record<string, unknown>;
}

const DEVICE_CODE_ROUTES: GroupRoute[] = [
    { key: 'startDeviceAuth', path: '/_auth/device/start', body: { ...deviceKeyBody(), deviceName: 'TV', platform: 'desktop' } },
    { key: 'startDeviceAuthWeb', path: '/_auth/device/start/web', body: {} },
    { key: 'pollDeviceAuth', path: '/_auth/device/poll', body: { deviceCode: 'unknown-device-code' } },
    { key: 'getDeviceAuthInfo', path: '/_auth/device/info', body: { userCode: 'BCDF-GHJK' } },
    { key: 'approveDeviceAuth', path: '/_auth/device/approve', body: { userCode: 'BCDF-GHJK' } },
    { key: 'denyDeviceAuth', path: '/_auth/device/deny', body: { userCode: 'BCDF-GHJK' } },
];

const DEVICE_LINK_ROUTES: GroupRoute[] = [
    { key: 'issueDeviceLink', path: '/_auth/device/link/issue', body: {} },
    { key: 'redeemDeviceLink', path: '/_auth/device/link/redeem', body: { userCode: 'BCDF-GHJK', ...deviceKeyBody() } },
    { key: 'redeemDeviceLinkWeb', path: '/_auth/device/link/redeem/web', body: { userCode: 'BCDF-GHJK' } },
    { key: 'getDeviceLinkStatus', path: '/_auth/device/link/status', body: { linkId: UNKNOWN_LINK_ID } },
    { key: 'confirmDeviceLink', path: '/_auth/device/link/confirm', body: { linkId: UNKNOWN_LINK_ID, choice: 10 } },
    { key: 'denyDeviceLink', path: '/_auth/device/link/deny', body: { linkId: UNKNOWN_LINK_ID } },
    { key: 'cancelDeviceLink', path: '/_auth/device/link/cancel', body: { linkId: UNKNOWN_LINK_ID } },
    { key: 'pollDeviceLink', path: '/_auth/device/link/poll', body: { deviceCode: 'unknown-device-code' } },
];

describe.skipIf(!dbAvailable)('An app chooses which sign-in channels exist (#308)', () =>
{
    let app: Hono;
    let ipCounter = 0;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        configureChannels();
        registerOAuthProvider(kakaoProvider);
        await teardownTestDb();
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();
        registerOAuthProvider(kakaoStandIn());
        vi.stubEnv('SPFN_APP_URL', APP_URL);
        sendEmail.mockClear();
    });

    afterEach(() =>
    {
        configureChannels();
        vi.unstubAllEnvs();
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    function nextIp(): string
    {
        ipCounter += 1;

        return `198.51.100.${ipCounter % 250 + 1}`;
    }

    function post(path: string, body: unknown, authorization?: string, ip = nextIp()): Promise<Response>
    {
        const headers: Record<string, string> = { ...JSON_HEADERS, 'x-forwarded-for': ip };

        if (authorization)
        {
            headers.Authorization = authorization;
        }

        return Promise.resolve(app.request(path, { method: 'POST', headers, body: JSON.stringify(body) }));
    }

    async function userRoleId(): Promise<number>
    {
        return (await getRoleByName('user'))!.id;
    }

    /** A signed-in caller of its own, so no two rows share a login rate limit. */
    async function signedInCaller(): Promise<string>
    {
        const email = `caller-${ipCounter}@ch308.test`;

        await createTestUser(email, await userRoleId());

        return await signIn(app, email, nextIp());
    }

    async function countOf(table: typeof users | typeof userSocialAccounts | typeof userPublicKeys): Promise<number>
    {
        return (await getTestDb().select().from(table)).length;
    }

    /**
     * The channel's 404 — `NotFoundError` itself, so a route that would have
     * answered its own not-found (an unknown device code) is not mistaken for
     * a closed one.
     */
    async function expectNotFound(response: Response, label: string): Promise<void>
    {
        const body = await response.text();

        expect(response.status, `${label}: ${body}`).toBe(404);
        expect(JSON.parse(body).error.code, label).toBe('NotFoundError');
    }

    /** A whole Kakao sign-in through the real web callback; where it redirected. */
    async function webSignIn(code: string): Promise<URL>
    {
        const key = generateKeyPair('ES256');
        const nonce = generateOAuthNonce();
        const state = await createOAuthState({
            provider: 'kakao',
            returnUrl: '/',
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
            nonce,
        });
        const response = await app.request(`/_auth/oauth/kakao/callback?${new URLSearchParams({ code, state })}`, {
            headers: { Cookie: `${buildStartCookieName('csrf', key.keyId)}=${nonce}` },
        });

        expect(response.status).toBe(302);

        return new URL(response.headers.get('location')!, APP_URL);
    }

    function nativeSignIn(code: string): Promise<Response>
    {
        const key = generateKeyPair('ES256');

        return post('/_auth/oauth/kakao/native', { idToken: code, nonce: key.fingerprint, ...deviceKeyBody(key) });
    }

    async function socialAccount(userId: number, identity: NormalizedIdentity): Promise<void>
    {
        await getTestDb().insert(userSocialAccounts).values({
            userId,
            provider: 'kakao',
            providerUserId: identity.providerUserId,
            providerEmail: identity.email,
        });
    }

    async function codeRows(purpose: VerificationPurpose)
    {
        return getTestDb().select().from(verificationCodes).where(eq(verificationCodes.purpose, purpose));
    }

    // ========================================================================
    // C2–C4: device-code login and device link
    // ========================================================================

    describe('deviceCode: false', () =>
    {
        it.each(DEVICE_CODE_ROUTES)('C2: $key answers 404 to an anonymous and a signed-in caller, and writes no row', async ({ key, path, body }) =>
        {
            const authorization = await signedInCaller();
            configureChannels({ deviceCode: false });

            await expectNotFound(await post(path, body), `${key} anonymous`);
            await expectNotFound(await post(path, body, authorization), `${key} signed in`);
            expect(await getTestDb().select().from(deviceAuthorizations)).toHaveLength(0);
        });

        it('C2: a closed route spends no rate-limit token — the first request after reopening is served', async () =>
        {
            const ip = nextIp();
            const body = { ...deviceKeyBody(), deviceName: 'TV', platform: 'desktop' };
            configureChannels({ deviceCode: false });

            for (let attempt = 0; attempt < 12; attempt += 1)
            {
                await expectNotFound(await post('/_auth/device/start', body, undefined, ip), `attempt ${attempt}`);
            }

            configureChannels();

            expect((await post('/_auth/device/start', body, undefined, ip)).status).toBe(200);
        });

        it('C3: device link stays open — a signed-in device issues a link', async () =>
        {
            const authorization = await signedInCaller();
            configureChannels({ deviceCode: false });

            const response = await post('/_auth/device/link/issue', {}, authorization);

            expect(response.status, await response.clone().text()).toBe(200);
            expect(await getTestDb().select().from(deviceLinks)).toHaveLength(1);
        });
    });

    describe('deviceLink: false', () =>
    {
        it.each(DEVICE_LINK_ROUTES)('C4: $key answers 404 to an anonymous and a signed-in caller, and writes no row', async ({ key, path, body }) =>
        {
            const authorization = await signedInCaller();
            configureChannels({ deviceLink: false });

            await expectNotFound(await post(path, body), `${key} anonymous`);
            await expectNotFound(await post(path, body, authorization), `${key} signed in`);
            expect(await getTestDb().select().from(deviceLinks)).toHaveLength(0);
        });
    });

    // ========================================================================
    // C5–C10: sign-up
    // ========================================================================

    describe('signup: false', () =>
    {
        it('C5: register and the three signup-link routes answer 404 and create no user', async () =>
        {
            configureChannels({ signup: false });
            const before = await countOf(users);

            await expectNotFound(await post('/_auth/register', {
                email: 'c5@ch308.test', verificationToken: 'token', password: TEST_PASSWORD, ...deviceKeyBody(),
            }), 'register');
            await expectNotFound(await post('/_auth/signup/email', { email: 'c5@ch308.test' }), 'requestSignupLink');
            await expectNotFound(await post('/_auth/signup/email/confirm', { token: 'x'.repeat(32) }), 'confirmSignupLink');
            await expectNotFound(await post('/_auth/signup/password', {
                password: TEST_PASSWORD, setupSecret: 'secret', ...deviceKeyBody(),
            }), 'completeSignup');

            expect(await countOf(users)).toBe(before);
            expect(await getTestDb().select().from(signupLinkTokens)).toHaveLength(0);
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('C6: a registration code is neither sent nor verified — 404, no code row, nothing sent', async () =>
        {
            configureChannels({ signup: false });

            await expectNotFound(await post('/_auth/codes', {
                target: 'c6@ch308.test', targetType: 'email', purpose: 'registration',
            }), 'sendVerificationCode');
            await expectNotFound(await post('/_auth/codes/verify', {
                target: 'c6@ch308.test', targetType: 'email', code: '123456', purpose: 'registration',
            }), 'verifyCode');

            expect(await codeRows('registration')).toHaveLength(0);
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('C7: a password-reset code is still sent', async () =>
        {
            configureChannels({ signup: false });

            const response = await post('/_auth/codes', {
                target: 'c7@ch308.test', targetType: 'email', purpose: 'password_reset',
            });

            expect(response.status, await response.clone().text()).toBe(200);
            expect(await codeRows('password_reset')).toHaveLength(1);
            expect(sendEmail).toHaveBeenCalledTimes(1);
        });

        it('C8: a first social sign-in that would create an account is refused, web and native, and writes nothing', async () =>
        {
            configureChannels({ signup: false });
            const before = [await countOf(users), await countOf(userSocialAccounts), await countOf(userPublicKeys)];

            const location = await webSignIn('code-new');
            const native = await nativeSignIn('code-new');

            expect(location.pathname).toBe('/auth/error');
            expect(location.searchParams.get('reason')).toBe('signup_disabled');
            expect(native.status).toBe(403);
            expect(JSON.parse(await native.text())).toMatchObject({ code: 'SIGNUP_DISABLED' });
            expect([await countOf(users), await countOf(userSocialAccounts), await countOf(userPublicKeys)]).toEqual(before);
        });

        it('C9: a sign-in whose identity is already linked signs in, web and native', async () =>
        {
            const userId = await createTestUser(LINKED_IDENTITY.email!, await userRoleId());
            await socialAccount(userId, LINKED_IDENTITY);
            configureChannels({ signup: false });

            const location = await webSignIn('code-linked');
            const native = await nativeSignIn('code-linked');

            expect(location.pathname, location.searchParams.get('error') ?? '').not.toBe('/auth/error');
            expect(Number(location.searchParams.get('userId'))).toBe(userId);
            expect(native.status, await native.clone().text()).toBe(200);
            expect(await countOf(users)).toBe(1);
        });

        it('C9: a first sign-in that attaches to an existing account by its verified email signs in', async () =>
        {
            const userId = await createTestUser(MATCHING_IDENTITY.email!, await userRoleId());
            configureChannels({ signup: false });

            const location = await webSignIn('code-matching');

            expect(location.pathname, location.searchParams.get('error') ?? '').not.toBe('/auth/error');
            expect(Number(location.searchParams.get('userId'))).toBe(userId);
            expect(await countOf(users)).toBe(1);
            expect(await countOf(userSocialAccounts)).toBe(1);
        });

        it('C10: an invitation is still accepted, and creates its account', async () =>
        {
            const inviterId = await createTestUser('inviter@ch308.test', await userRoleId());
            await getTestDb().insert(userInvitations).values({
                email: 'invitee@ch308.test',
                token: INVITATION_TOKEN,
                roleId: await userRoleId(),
                invitedBy: inviterId,
                status: 'pending',
                expiresAt: new Date(Date.now() + 86_400_000),
            });
            configureChannels({ signup: false });

            const response = await post('/_auth/invitations/accept', {
                token: INVITATION_TOKEN, password: TEST_PASSWORD, ...deviceKeyBody(),
            });

            expect(response.status, await response.clone().text()).toBe(200);
            expect(await getTestDb().select().from(users).where(eq(users.email, 'invitee@ch308.test'))).toHaveLength(1);
        });
    });

    // ========================================================================
    // C11: password reset
    // ========================================================================

    describe('passwordReset: false', () =>
    {
        it('C11: the three reset routes and a password-reset code answer 404; nothing is sent and no row is written', async () =>
        {
            await createTestUser('c11@ch308.test', await userRoleId());
            configureChannels({ passwordReset: false });

            await expectNotFound(await post('/_auth/password/reset', { email: 'c11@ch308.test' }), 'requestPasswordReset');
            await expectNotFound(await post('/_auth/password/reset/confirm', { token: 'x'.repeat(32) }), 'confirmPasswordReset');
            await expectNotFound(await post('/_auth/password/reset/complete', {
                password: TEST_PASSWORD, setupSecret: 'secret', ...deviceKeyBody(),
            }), 'completePasswordReset');
            await expectNotFound(await post('/_auth/codes', {
                target: 'c11@ch308.test', targetType: 'email', purpose: 'password_reset',
            }), 'sendVerificationCode');
            await expectNotFound(await post('/_auth/codes/verify', {
                target: 'c11@ch308.test', targetType: 'email', code: '123456', purpose: 'password_reset',
            }), 'verifyCode');

            expect(await getTestDb().select().from(passwordResetTokens)).toHaveLength(0);
            expect(await getTestDb().select().from(verificationCodes)).toHaveLength(0);
            expect(sendEmail).not.toHaveBeenCalled();
        });
    });

    // ========================================================================
    // C12: the service layer does not read the setting
    // ========================================================================

    describe('every channel off', () =>
    {
        const ALL_OFF: Record<AuthChannel, false> = {
            signup: false, passwordReset: false, deviceCode: false, deviceLink: false,
        };

        it('C12: each group\'s service function, called directly, still works', async () =>
        {
            const issuerId = await createTestUser('c12@ch308.test', await userRoleId());
            configureChannels(ALL_OFF);

            await startDeviceAuthService({ ...deviceKeyBody(), deviceName: 'TV', platform: 'desktop' });
            await runInTransaction(() => issueDeviceLinkService({ userId: issuerId, keyId: 'c12-issuer-key' }));
            await requestSignupLinkService({ email: 'c12-new@ch308.test' });
            await requestPasswordResetService({ email: 'c12@ch308.test' });
            await sendVerificationCodeService({ target: 'c12-code@ch308.test', targetType: 'email', purpose: 'registration' });

            expect(await getTestDb().select().from(deviceAuthorizations)).toHaveLength(1);
            expect(await getTestDb().select().from(deviceLinks)).toHaveLength(1);
            expect(await getTestDb().select().from(signupLinkTokens)).toHaveLength(1);
            expect(await getTestDb().select().from(passwordResetTokens)).toHaveLength(1);
            expect(await codeRows('registration')).toHaveLength(1);
        });
    });
});
