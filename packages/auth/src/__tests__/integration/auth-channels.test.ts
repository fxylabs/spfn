/**
 * @spfn/auth - An app chooses which sign-in channels exist (#308)
 *
 * One test per row C2–C12 of the #308 case table. C1 is every other suite
 * staying green; C13 and the option's own validation are in
 * unit/auth-channels.test.ts.
 *
 * Driven against the mounted auth router with `authenticate` as the
 * server-level middleware, the way a real server mounts it: a public route of
 * a closed channel answers 404 to everyone, a signed-in one answers the global
 * middleware's 401 to an anonymous caller and 404 to a signed-in one. Social sign-in uses a Kakao stand-in whose codes and
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
import { __resetChannelsForTests, configureChannels, type AuthChannel } from '@/server/lib/channels-config';
import { registerOAuthProvider, type NormalizedIdentity, type OAuthProvider } from '@/server/lib/oauth';
import { kakaoProvider } from '@/server/lib/oauth/kakao-provider';
import { buildStartCookieName } from '@/server/lib/oauth/start-cookies';
import { createOAuthState, generateOAuthNonce } from '@/server/lib/oauth/state';
import type { VerificationPurpose } from '@/server/routes/schema';
import { ROUTE_CHANNELS } from '@/server/routes/channels';
import { AUTH_SURFACE_OPERATIONS } from '@/server/client-proof/contract-types';
import { buildMobileContractBundle } from '@/server/client-proof/contract-bundle';

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
    /** Behind the global `auth` middleware, which answers an anonymous caller first. */
    signedIn: boolean;
}

const DEVICE_CODE_ROUTES: GroupRoute[] = [
    { key: 'startDeviceAuth', path: '/_auth/device/start', body: { ...deviceKeyBody(), deviceName: 'TV', platform: 'desktop' }, signedIn: false },
    { key: 'startDeviceAuthWeb', path: '/_auth/device/start/web', body: {}, signedIn: false },
    { key: 'pollDeviceAuth', path: '/_auth/device/poll', body: { deviceCode: 'unknown-device-code' }, signedIn: false },
    { key: 'getDeviceAuthInfo', path: '/_auth/device/info', body: { userCode: 'BCDF-GHJK' }, signedIn: true },
    { key: 'approveDeviceAuth', path: '/_auth/device/approve', body: { userCode: 'BCDF-GHJK' }, signedIn: true },
    { key: 'denyDeviceAuth', path: '/_auth/device/deny', body: { userCode: 'BCDF-GHJK' }, signedIn: true },
];

const DEVICE_LINK_ROUTES: GroupRoute[] = [
    { key: 'issueDeviceLink', path: '/_auth/device/link/issue', body: {}, signedIn: true },
    { key: 'redeemDeviceLink', path: '/_auth/device/link/redeem', body: { userCode: 'BCDF-GHJK', ...deviceKeyBody() }, signedIn: false },
    { key: 'redeemDeviceLinkWeb', path: '/_auth/device/link/redeem/web', body: { userCode: 'BCDF-GHJK' }, signedIn: false },
    { key: 'getDeviceLinkStatus', path: '/_auth/device/link/status', body: { linkId: UNKNOWN_LINK_ID }, signedIn: true },
    { key: 'confirmDeviceLink', path: '/_auth/device/link/confirm', body: { linkId: UNKNOWN_LINK_ID, choice: 10 }, signedIn: true },
    { key: 'denyDeviceLink', path: '/_auth/device/link/deny', body: { linkId: UNKNOWN_LINK_ID }, signedIn: true },
    { key: 'cancelDeviceLink', path: '/_auth/device/link/cancel', body: { linkId: UNKNOWN_LINK_ID }, signedIn: true },
    { key: 'pollDeviceLink', path: '/_auth/device/link/poll', body: { deviceCode: 'unknown-device-code' }, signedIn: false },
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
        __resetChannelsForTests();
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
        __resetChannelsForTests();
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
     * The channel's 404 — `ChannelDisabledError` itself, naming the channel, so
     * a route that would have answered its own not-found (an unknown device
     * code) is not mistaken for a closed one.
     */
    async function expectChannelClosed(response: Response, channel: AuthChannel, label: string): Promise<void>
    {
        const body = await response.text();

        expect(response.status, `${label}: ${body}`).toBe(404);
        expect(JSON.parse(body), label).toMatchObject({
            error: { code: 'ChannelDisabledError' },
            code: 'CHANNEL_DISABLED',
            details: { channel },
        });
    }

    /** What a closed route answers an anonymous caller: the channel's 404 if public, the global 401 if signed in. */
    async function expectAnonymousRefused(response: Response, route: GroupRoute, channel: AuthChannel): Promise<void>
    {
        if (route.signedIn)
        {
            expect(response.status, `${route.key} anonymous`).toBe(401);
        }
        else
        {
            await expectChannelClosed(response, channel, `${route.key} anonymous`);
        }
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
        it.each(DEVICE_CODE_ROUTES)('C2: $key refuses an anonymous caller (404, or 401 when signed in) and answers a signed-in one 404, writing no row', async (route) =>
        {
            const authorization = await signedInCaller();
            configureChannels({ deviceCode: false });

            await expectAnonymousRefused(await post(route.path, route.body), route, 'deviceCode');
            await expectChannelClosed(await post(route.path, route.body, authorization), 'deviceCode', `${route.key} signed in`);
            expect(await getTestDb().select().from(deviceAuthorizations)).toHaveLength(0);
        });

        it('C2: a closed route spends no rate-limit token — the first request after reopening is served', async () =>
        {
            const ip = nextIp();
            const body = { ...deviceKeyBody(), deviceName: 'TV', platform: 'desktop' };
            configureChannels({ deviceCode: false });

            for (let attempt = 0; attempt < 12; attempt += 1)
            {
                await expectChannelClosed(await post('/_auth/device/start', body, undefined, ip), 'deviceCode', `attempt ${attempt}`);
            }

            __resetChannelsForTests();

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
        it.each(DEVICE_LINK_ROUTES)('C4: $key refuses an anonymous caller (404, or 401 when signed in) and answers a signed-in one 404, writing no row', async (route) =>
        {
            const authorization = await signedInCaller();
            configureChannels({ deviceLink: false });

            await expectAnonymousRefused(await post(route.path, route.body), route, 'deviceLink');
            await expectChannelClosed(await post(route.path, route.body, authorization), 'deviceLink', `${route.key} signed in`);
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

            await expectChannelClosed(await post('/_auth/register', {
                email: 'c5@ch308.test', verificationToken: 'token', password: TEST_PASSWORD, ...deviceKeyBody(),
            }), 'signup', 'register');
            await expectChannelClosed(await post('/_auth/signup/email', { email: 'c5@ch308.test' }), 'signup', 'requestSignupLink');
            await expectChannelClosed(await post('/_auth/signup/email/confirm', { token: 'x'.repeat(32) }), 'signup', 'confirmSignupLink');
            await expectChannelClosed(await post('/_auth/signup/password', {
                password: TEST_PASSWORD, setupSecret: 'secret', ...deviceKeyBody(),
            }), 'signup', 'completeSignup');

            expect(await countOf(users)).toBe(before);
            expect(await getTestDb().select().from(signupLinkTokens)).toHaveLength(0);
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('C6: a registration code is neither sent nor verified — 404, no code row, nothing sent', async () =>
        {
            configureChannels({ signup: false });

            await expectChannelClosed(await post('/_auth/codes', {
                target: 'c6@ch308.test', targetType: 'email', purpose: 'registration',
            }), 'signup', 'sendVerificationCode');
            await expectChannelClosed(await post('/_auth/codes/verify', {
                target: 'c6@ch308.test', targetType: 'email', code: '123456', purpose: 'registration',
            }), 'signup', 'verifyCode');

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

            await expectChannelClosed(await post('/_auth/password/reset', { email: 'c11@ch308.test' }), 'passwordReset', 'requestPasswordReset');
            await expectChannelClosed(await post('/_auth/password/reset/confirm', { token: 'x'.repeat(32) }), 'passwordReset', 'confirmPasswordReset');
            await expectChannelClosed(await post('/_auth/password/reset/complete', {
                password: TEST_PASSWORD, setupSecret: 'secret', ...deviceKeyBody(),
            }), 'passwordReset', 'completePasswordReset');
            await expectChannelClosed(await post('/_auth/codes', {
                target: 'c11@ch308.test', targetType: 'email', purpose: 'password_reset',
            }), 'passwordReset', 'sendVerificationCode');
            await expectChannelClosed(await post('/_auth/codes/verify', {
                target: 'c11@ch308.test', targetType: 'email', code: '123456', purpose: 'password_reset',
            }), 'passwordReset', 'verifyCode');

            expect(await getTestDb().select().from(passwordResetTokens)).toHaveLength(0);
            expect(await getTestDb().select().from(verificationCodes)).toHaveLength(0);
            expect(sendEmail).not.toHaveBeenCalled();
        });
    });

    // ========================================================================
    // The mobile contract declares what a closed channel answers
    // ========================================================================

    describe('signup, deviceCode and deviceLink off', () =>
    {
        it('every contract operation on a gated route answers a code the bundle lists, and the bundle marks it', async () =>
        {
            const bundle = buildMobileContractBundle();
            const listed = (bundle.errors as { code: string }[]).map(error => error.code);
            const exported = new Map((bundle.operations as { id: string; closedChannel?: { error: string } }[])
                .map(operation => [operation.id, operation]));
            const gated = AUTH_SURFACE_OPERATIONS.filter(operation => ROUTE_CHANNELS[operation.route!] !== 'always');
            const authorization = await signedInCaller();
            configureChannels({ signup: false, deviceCode: false, deviceLink: false });

            expect(gated.map(operation => operation.id).sort()).toEqual([
                'auth.device.approve', 'auth.device.deny', 'auth.device.info', 'auth.device.poll', 'auth.device.start',
                'auth.deviceLink.poll', 'auth.deviceLink.redeem', 'auth.enroll.register',
            ]);

            for (const operation of gated)
            {
                const signedIn = operation.authProfile !== 'none';
                const response = await post(operation.path, {}, signedIn ? authorization : undefined);
                const code: string = JSON.parse(await response.text()).error.code;

                expect(response.status, operation.id).toBe(404);
                expect(listed, operation.id).toContain(code);
                expect(exported.get(operation.id)?.closedChannel?.error, operation.id).toBe(code);
            }
        });
    });

    // ========================================================================
    // The gate leaves the server-level chain as it is
    // ========================================================================

    describe('no channels option', () =>
    {
        /** The auth router behind server-level `[authenticate, actor]`, `actor` recording each path's principal. */
        async function mountWithActor(seen: Map<string, string | null>): Promise<Hono>
        {
            const { Hono: HonoApp } = await import('hono');
            const { registerRoutes } = await import('@spfn/core/route');
            const { ErrorHandler } = await import('@spfn/core/middleware');
            const { mainAuthRouter } = await import('@/server/routes');
            const { authenticate } = await import('@/server/middleware/authenticate');
            const actorApp = new HonoApp();

            registerRoutes(actorApp, mainAuthRouter, [
                { name: authenticate.name, handler: authenticate.handler },
                {
                    name: 'actor',
                    handler: async (c, next) =>
                    {
                        seen.set(c.req.path, (c.get('auth') as { userId?: string } | undefined)?.userId ?? null);
                        await next();
                    },
                },
            ]);
            actorApp.onError(ErrorHandler());

            return actorApp;
        }

        it('a server-level middleware after auth sees the principal on a signed-in route, gated or not', async () =>
        {
            const seen = new Map<string, string | null>();
            const actorApp = await mountWithActor(seen);
            const authorization = await signedInCaller();
            const paths = ['/_auth/keys/list', '/_auth/device/info', '/_auth/device/link/issue'];

            for (const path of paths)
            {
                await actorApp.request(path, {
                    method: 'POST',
                    headers: { ...JSON_HEADERS, 'x-forwarded-for': nextIp(), Authorization: authorization },
                    body: JSON.stringify(path === '/_auth/device/info' ? { userCode: 'BCDF-GHJK' } : {}),
                });
            }

            expect(paths.map(path => seen.get(path))).toEqual(paths.map(() => expect.stringMatching(/^\d+$/)));
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
