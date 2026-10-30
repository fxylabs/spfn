/**
 * @spfn/auth - Battle.net sign-in and session-initiated OAuth link/unlink (GitHub fxylabs/spfn#154)
 *
 * One test per row of the case table in artifacts/issue-154-battlenet-design.md
 * §7: L for a Battle.net sign-in, S for a link start, C for a link callback, U
 * for an unlink. Rows L6, L8, L9, L10 are provider-adapter rows and live in
 * unit/oauth-battlenet-provider.test.ts; C8 is in unit/oauth-link-state.test.ts.
 *
 * Real HTTP requests against the mounted auth router, signed the way a browser
 * session signs them. Battle.net itself is a stand-in registered under the
 * `battlenet` id: each authorization code names the identity its token response
 * establishes, so two callbacks in flight can carry two identities. The Next.js
 * proxy is not mounted, so the fields `oauthLinkInterceptor` injects are passed
 * in the body, and the CSRF cookie it sets is passed on the callback — except in
 * the S8/S9 rows, which run the interceptor itself.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp, resetMemoryRateLimitStore } from '../helpers/oauth2';
import {
    mfaChallenges,
    mfaVerifications,
    userProfiles,
    userPublicKeys,
    userSocialAccounts,
    users,
} from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken, type KeyPair } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { registerOAuthProvider, type NormalizedIdentity, type OAuthProvider } from '@/server/lib/oauth';
import { battlenetProvider } from '@/server/lib/oauth/battlenet-provider';
import { buildStartCookieName } from '@/server/lib/oauth/start-cookies';
import { createOAuthState, generateOAuthNonce } from '@/server/lib/oauth/state';
import { configureAuth } from '@/server/lib/config';
import { oauthLinkInterceptor } from '@/nextjs/interceptors/oauth';
import {
    authLoginEvent,
    authRegisterEvent,
    oauthLinkedEvent,
    oauthLinkRemovedEvent,
    oauthUnlinkedEvent,
} from '@/server/events';

const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const APP_URL = 'http://localhost:3000';
const RETURN_URL = '/settings/connections';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 7).toString('base64')}`;

/** Two Battle.net accounts, and the first one after a paid name change. */
const FLASH: NormalizedIdentity = {
    providerUserId: '100001', email: null, emailVerified: false, name: 'Flash#1234', handle: 'Flash#1234',
};
const FLASH_RENAMED: NormalizedIdentity = { ...FLASH, name: 'TheFlash#1234', handle: 'TheFlash#1234' };
const JAEDONG: NormalizedIdentity = {
    providerUserId: '100002', email: null, emailVerified: false, name: 'Jaedong#5678', handle: 'Jaedong#5678',
};

/** What each authorization code's token response establishes. */
const identities = new Map<string, NormalizedIdentity>([
    ['code-flash', FLASH],
    ['code-flash-renamed', FLASH_RENAMED],
    ['code-jaedong', JAEDONG],
]);

/** How many code exchanges reached the provider — a refused callback must not get that far. */
let exchanges = 0;

const standIn: OAuthProvider = {
    id: 'battlenet',
    isEnabled: () => true,
    getAuthUrl: (state: string) => `https://oauth.battle.example/authorize?state=${state}`,
    exchangeCodeForTokens: async (code: string) =>
    {
        exchanges += 1;

        return { accessToken: `access-${code}-${exchanges}`, expiresIn: 86400, identity: identities.get(code) };
    },
    getUserInfo: async () =>
    {
        throw new Error('the stand-in answers identity from the token response');
    },
};

/** A browser session: what to sign requests with, and the device key it is carried by. */
interface Session
{
    authorization: string;
    keyId: string;
}

/** A link start as the browser holds it: the state the provider will return, and the CSRF cookie. */
interface StartedLink
{
    state: string;
    cookie: string;
}

describe.skipIf(!dbAvailable)('Battle.net sign-in and OAuth link/unlink (#154)', () =>
{
    let app: Hono;
    let ownerId: number;
    let otherId: number;
    let ipCounter = 0;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = 'localhost';
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = APP_URL;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        registerOAuthProvider(battlenetProvider);
        await teardownTestDb();
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();
        registerOAuthProvider(standIn);
        vi.stubEnv('SPFN_APP_URL', APP_URL);
        exchanges = 0;

        ownerId = await createUser('owner@test.com');
        otherId = await createUser('other@test.com');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
        vi.useRealTimers();
        configureAuth({ beforeRegister: undefined });
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    async function createUser(email: string): Promise<number>
    {
        const userRole = await getRoleByName('user');
        const [row] = await getTestDb().insert(users).values({
            email,
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        }).returning({ id: users.id });

        return Number(row!.id);
    }

    function nextIp(): string
    {
        ipCounter += 1;

        return `198.51.154.${ipCounter % 250 + 1}`;
    }

    function post(path: string, body: unknown, authorization?: string): Promise<Response>
    {
        return Promise.resolve(app.request(path, {
            method: 'POST',
            headers: {
                ...JSON_HEADERS,
                'x-forwarded-for': nextIp(),
                ...(authorization ? { Authorization: authorization } : {}),
            },
            body: JSON.stringify(body),
        }));
    }

    function sessionFor(key: KeyPair): Session
    {
        const token = generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' });

        return { authorization: `Bearer ${token}`, keyId: key.keyId };
    }

    async function signIn(email: string): Promise<Session>
    {
        const key = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email,
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });

        expect(response.status).toBe(200);

        return sessionFor(key);
    }

    async function ageSession(session: Session, minutes: number): Promise<void>
    {
        await getTestDb()
            .update(userPublicKeys)
            .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
            .where(eq(userPublicKeys.keyId, session.keyId));
    }

    /** Enrol TOTP from this session; the confirming device is stepped up by it. */
    async function enrolSecondFactor(session: Session): Promise<void>
    {
        const enroll = await post('/_auth/mfa/totp/enroll', {}, session.authorization);
        expect(enroll.status).toBe(200);

        const secret = (await enroll.json()).secret as string;
        const code = hotp(decodeBase32(secret), totpStep(Date.now()));
        const confirm = await post('/_auth/mfa/totp/confirm', { code }, session.authorization);
        expect(confirm.status).toBe(200);
    }

    async function forgetStepUp(session: Session): Promise<void>
    {
        await getTestDb().delete(mfaVerifications).where(eq(mfaVerifications.keyId, session.keyId));
    }

    function linkStartRequest(session: Session | null, body: Record<string, unknown> = {}): Promise<Response>
    {
        return post('/_auth/oauth/battlenet/link', {
            returnUrl: RETURN_URL,
            nonce: generateOAuthNonce(),
            startId: generateOAuthNonce(),
            ...body,
        }, session?.authorization);
    }

    /** Start a link exactly as the interceptor would, and keep what the browser keeps. */
    async function startLink(session: Session, body: Record<string, unknown> = {}): Promise<StartedLink>
    {
        const nonce = generateOAuthNonce();
        const startId = generateOAuthNonce();
        const response = await linkStartRequest(session, { nonce, startId, ...body });

        expect(response.status).toBe(200);

        const { authUrl } = await response.json() as { authUrl: string };

        return {
            state: new URL(authUrl).searchParams.get('state')!,
            cookie: `${buildStartCookieName('csrf', startId)}=${nonce}`,
        };
    }

    async function callback(
        state: string,
        query: Record<string, string>,
        cookie: string | null,
        provider = 'battlenet',
    ): Promise<{ location: URL; setCookie: string }>
    {
        const params = new URLSearchParams({ ...query, state });
        const response = await app.request(`/_auth/oauth/${provider}/callback?${params}`, {
            headers: cookie ? { Cookie: cookie } : {},
        });

        expect(response.status).toBe(302);

        return {
            location: new URL(response.headers.get('location')!, APP_URL),
            setCookie: response.headers.get('set-cookie') ?? '',
        };
    }

    /** Finish a link with the identity `code` names; the outcome the browser lands on. */
    async function finishLink(started: StartedLink, code: string): Promise<URL>
    {
        return (await callback(started.state, { code }, started.cookie)).location;
    }

    /** A Battle.net sign-in, start to callback, the way the sign-in interceptor and route run it. */
    async function battlenetSignIn(code: string): Promise<{ location: URL; key: KeyPair }>
    {
        const key = generateKeyPair('ES256');
        const nonce = generateOAuthNonce();
        const state = await createOAuthState({
            provider: 'battlenet',
            returnUrl: '/',
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
            nonce,
        });
        const { location } = await callback(state, { code }, `${buildStartCookieName('csrf', key.keyId)}=${nonce}`);

        return { location, key };
    }

    async function socialRows()
    {
        return await getTestDb().select().from(userSocialAccounts);
    }

    async function linkOf(userId: number)
    {
        const [row] = await getTestDb().select().from(userSocialAccounts).where(and(
            eq(userSocialAccounts.userId, userId),
            eq(userSocialAccounts.provider, 'battlenet'),
        ));

        return row;
    }

    async function keyCount(): Promise<number>
    {
        return (await getTestDb().select().from(userPublicKeys)).length;
    }

    function captureEvent<TPayload>(
        event: { subscribe: (handler: (payload: TPayload) => void) => unknown },
    ): TPayload[]
    {
        const seen: TPayload[] = [];
        event.subscribe((payload) =>
        {
            seen.push(payload);
        });

        return seen;
    }

    function outcomeOf(location: URL): { path: string; oauthLink: string | null; provider: string | null }
    {
        return {
            path: location.pathname,
            oauthLink: location.searchParams.get('oauthLink'),
            provider: location.searchParams.get('provider'),
        };
    }

    function linked(outcome: string): { path: string; oauthLink: string; provider: string }
    {
        return { path: RETURN_URL, oauthLink: outcome, provider: 'battlenet' };
    }

    function errorReasonOf(location: URL): string | null
    {
        expect(location.pathname).toBe('/auth/error');

        return location.searchParams.get('reason');
    }

    // ========================================================================
    // 7-1. Battle.net sign-in
    // ========================================================================

    describe('7-1 sign-in', () =>
    {
        it('L1: a new identity makes a new account with no email, keeps the BattleTag, and announces both ids', async () =>
        {
            const registered = captureEvent(authRegisterEvent);

            const { location } = await battlenetSignIn('code-flash');
            const userId = Number(location.searchParams.get('userId'));

            expect(location.searchParams.get('isNewUser')).toBe('true');
            expect(userId).not.toBe(ownerId);
            expect(userId).not.toBe(otherId);

            const [user] = await getTestDb().select().from(users).where(eq(users.id, userId));
            expect(user!.email).toBeNull();
            expect(await linkOf(userId)).toMatchObject({ providerUserId: '100001', providerHandle: 'Flash#1234' });

            const [profile] = await getTestDb().select().from(userProfiles).where(eq(userProfiles.userId, userId));
            expect(profile!.displayName).toBe('Flash#1234');

            expect(registered).toEqual([expect.objectContaining({
                userId: String(userId),
                provider: 'battlenet',
                providerUserId: '100001',
                providerHandle: 'Flash#1234',
            })]);
        });

        it('L2: a beforeRegister refusal makes no account and no social row', async () =>
        {
            configureAuth({
                beforeRegister: (ctx) =>
                {
                    if (ctx.provider === 'battlenet')
                    {
                        throw new Error('Battle.net sign-up is closed');
                    }
                },
            });
            const usersBefore = (await getTestDb().select().from(users)).length;

            const { location } = await battlenetSignIn('code-flash');

            expect(location.pathname).toBe('/auth/error');
            expect((await getTestDb().select().from(users)).length).toBe(usersBefore);
            expect(await socialRows()).toHaveLength(0);
        });

        it('L3: a known identity signs in to its account and the login carries the BattleTag', async () =>
        {
            const first = await battlenetSignIn('code-flash');
            const userId = first.location.searchParams.get('userId');
            const logins = captureEvent(authLoginEvent);

            const again = await battlenetSignIn('code-flash');

            expect(again.location.searchParams.get('userId')).toBe(userId);
            expect(again.location.searchParams.get('isNewUser')).toBe('false');
            expect(await socialRows()).toHaveLength(1);
            expect(logins).toEqual([expect.objectContaining({
                userId, provider: 'battlenet', providerUserId: '100001', providerHandle: 'Flash#1234',
            })]);
        });

        it('L4: a changed BattleTag replaces the stored one and reaches the login event; the display name stays', async () =>
        {
            const first = await battlenetSignIn('code-flash');
            const userId = Number(first.location.searchParams.get('userId'));
            const logins = captureEvent(authLoginEvent);

            await battlenetSignIn('code-flash-renamed');

            expect((await linkOf(userId))!.providerHandle).toBe('TheFlash#1234');
            expect(logins[0]).toMatchObject({ providerHandle: 'TheFlash#1234' });

            const [profile] = await getTestDb().select().from(userProfiles).where(eq(userProfiles.userId, userId));
            expect(profile!.displayName).toBe('Flash#1234');
        });

        it('L5: an identity linked from a session signs in to the account that linked it', async () =>
        {
            const session = await signIn('owner@test.com');
            await finishLink(await startLink(session), 'code-flash');

            const { location } = await battlenetSignIn('code-flash');

            expect(location.searchParams.get('userId')).toBe(String(ownerId));
            expect(location.searchParams.get('isNewUser')).toBe('false');
        });

        it('L7: a suspended account is refused and gets no session key', async () =>
        {
            const first = await battlenetSignIn('code-flash');
            const userId = Number(first.location.searchParams.get('userId'));
            await getTestDb().update(users).set({ status: 'suspended' }).where(eq(users.id, userId));
            const keysBefore = await keyCount();

            const { location } = await battlenetSignIn('code-flash');

            expect(errorReasonOf(location)).toBe('account_unavailable');
            expect(await keyCount()).toBe(keysBefore);
        });
    });

    // ========================================================================
    // 7-2. Link start
    // ========================================================================

    describe('7-2 link start', () =>
    {
        it('S1: without a session it is 401', async () =>
        {
            const response = await linkStartRequest(null);

            expect(response.status).toBe(401);
        });

        it('S2: a provider that is not configured is refused before any state is made', async () =>
        {
            registerOAuthProvider({ ...standIn, isEnabled: () => false });
            const session = await signIn('owner@test.com');

            const response = await linkStartRequest(session);

            expect(response.status).toBe(400);
        });

        it('S3: an enrolled account past its step-up window is refused STEP_UP_REQUIRED', async () =>
        {
            const session = await signIn('owner@test.com');
            await enrolSecondFactor(session);
            await forgetStepUp(session);

            const response = await linkStartRequest(session);

            expect(response.status).toBe(403);
            expect((await response.json()).code).toBe('STEP_UP_REQUIRED');
        });

        it('S3b: an enrolled account that stepped up on this device may start', async () =>
        {
            const session = await signIn('owner@test.com');
            await enrolSecondFactor(session);

            expect((await linkStartRequest(session)).status).toBe(200);
        });

        it('S4: an account with no second factor is not asked to step up', async () =>
        {
            const session = await signIn('owner@test.com');

            expect((await linkStartRequest(session)).status).toBe(200);
        });

        it('S5: a session key older than the window, with no password or a wrong one, is refused RECENT_AUTH_REQUIRED', async () =>
        {
            const session = await signIn('owner@test.com');
            await ageSession(session, 11);

            const without = await linkStartRequest(session);
            const wrong = await linkStartRequest(session, { currentPassword: 'Wrong123!' });

            expect(without.status).toBe(403);
            expect((await without.json()).code).toBe('RECENT_AUTH_REQUIRED');
            expect(wrong.status).toBe(403);
        });

        it('S6: a session key older than the window with the right password may start', async () =>
        {
            const session = await signIn('owner@test.com');
            await ageSession(session, 11);

            expect((await linkStartRequest(session, { currentPassword: PASSWORD })).status).toBe(200);
        });

        it('S7: an account that already holds a Battle.net identity is refused OAUTH_PROVIDER_ALREADY_LINKED', async () =>
        {
            const session = await signIn('owner@test.com');
            await finishLink(await startLink(session), 'code-flash');

            const response = await linkStartRequest(session);

            expect(response.status).toBe(409);
            expect((await response.json()).code).toBe('OAUTH_PROVIDER_ALREADY_LINKED');
        });

        it('S8: a returnUrl off the app is refused by the interceptor and by the route', async () =>
        {
            const ctx = {
                path: '/_auth/oauth/battlenet/link',
                body: { returnUrl: '//evil.com' },
                metadata: {},
            } as unknown as RequestInterceptorContext;
            const next = vi.fn(async () => undefined);

            await oauthLinkInterceptor.request?.(ctx, next);

            expect(ctx.abort?.status).toBe(400);
            expect(next).not.toHaveBeenCalled();

            const session = await signIn('owner@test.com');
            const direct = await linkStartRequest(session, { returnUrl: 'https://evil.com' });

            expect(direct.status).toBe(400);
        });

        it('S8b: a start that did not come through the interceptor is refused', async () =>
        {
            const session = await signIn('owner@test.com');

            const response = await linkStartRequest(session, { nonce: undefined, startId: undefined });

            expect(response.status).toBe(400);
        });

        it('S9: the interceptor injects the CSRF pair and the start sets one CSRF cookie and nothing else', async () =>
        {
            const requestCtx = {
                path: '/_auth/oauth/battlenet/link',
                body: { returnUrl: RETURN_URL },
                metadata: {} as Record<string, unknown>,
            } as unknown as RequestInterceptorContext;

            await oauthLinkInterceptor.request?.(requestCtx, vi.fn(async () => undefined));

            expect(requestCtx.body).toMatchObject({
                returnUrl: RETURN_URL,
                nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
                startId: expect.stringMatching(/^[0-9a-f]{32}$/),
            });

            const session = await signIn('owner@test.com');
            const keysBefore = await keyCount();
            const response = await linkStartRequest(session, requestCtx.body as Record<string, unknown>);

            expect(response.status).toBe(200);
            expect(await keyCount()).toBe(keysBefore);

            const responseCtx = {
                response: { ok: true, status: 200 },
                cookies: new Map<string, string>(),
                setCookies: [],
                metadata: requestCtx.metadata,
            } as unknown as ResponseInterceptorContext;

            await oauthLinkInterceptor.response?.(responseCtx, vi.fn(async () => undefined));

            const { nonce, startId } = requestCtx.body as { nonce: string; startId: string };
            expect(responseCtx.setCookies).toEqual([expect.objectContaining({
                name: buildStartCookieName('csrf', startId),
                value: nonce,
                options: expect.objectContaining({ httpOnly: true, sameSite: 'lax', maxAge: 600 }),
            })]);
        });
    });

    // ========================================================================
    // 7-3. Link callback
    // ========================================================================

    describe('7-3 link callback', () =>
    {
        it('C1: a new identity is attached to the session\'s account and announced', async () =>
        {
            const session = await signIn('owner@test.com');
            const announced = captureEvent(oauthLinkedEvent);

            const location = await finishLink(await startLink(session), 'code-flash');

            expect(outcomeOf(location)).toEqual(linked('linked'));
            expect(location.origin).toBe(APP_URL);
            expect(await linkOf(ownerId)).toMatchObject({
                providerUserId: '100001',
                providerHandle: 'Flash#1234',
                providerEmail: null,
            });
            expect(announced).toEqual([{
                userId: String(ownerId), provider: 'battlenet', providerUserId: '100001', providerHandle: 'Flash#1234',
            }]);

            const [profile] = await getTestDb().select().from(userProfiles).where(eq(userProfiles.userId, ownerId));
            expect(profile).toBeUndefined();
        });

        it('C2: an identity another account holds is refused, and neither account changes', async () =>
        {
            const otherSession = await signIn('other@test.com');
            await finishLink(await startLink(otherSession), 'code-flash');
            const before = await linkOf(otherId);
            const announced = captureEvent(oauthLinkedEvent);

            const session = await signIn('owner@test.com');
            const location = await finishLink(await startLink(session), 'code-flash');

            expect(outcomeOf(location)).toEqual(linked('linked_elsewhere'));
            expect(await linkOf(ownerId)).toBeUndefined();
            expect(await linkOf(otherId)).toEqual(before);
            expect(announced).toHaveLength(0);
        });

        it('C3: linking again an identity the account already holds keeps one row, refreshes it, and announces nothing new', async () =>
        {
            const session = await signIn('owner@test.com');
            const first = await startLink(session);
            const second = await startLink(session);
            const announced = captureEvent(oauthLinkedEvent);

            await finishLink(first, 'code-flash');
            const before = await linkOf(ownerId);
            const location = await finishLink(second, 'code-flash-renamed');

            expect(outcomeOf(location)).toEqual(linked('linked'));
            expect(await socialRows()).toHaveLength(1);

            const after = await linkOf(ownerId);
            expect(after!.id).toBe(before!.id);
            expect(after!.providerHandle).toBe('TheFlash#1234');
            expect(after!.accessToken).not.toBe(before!.accessToken);
            expect(announced).toHaveLength(1);
        });

        it('C4: a second identity for an account that gained one meanwhile is refused; the first stays', async () =>
        {
            const session = await signIn('owner@test.com');
            const first = await startLink(session);
            const second = await startLink(session);

            await finishLink(first, 'code-flash');
            const location = await finishLink(second, 'code-jaedong');

            expect(outcomeOf(location)).toEqual(linked('provider_already_linked'));
            expect(await socialRows()).toHaveLength(1);
            expect((await linkOf(ownerId))!.providerUserId).toBe('100001');
        });

        it('C5: no CSRF cookie is refused no_cookie before the code is exchanged', async () =>
        {
            const session = await signIn('owner@test.com');
            const started = await startLink(session);

            const { location } = await callback(started.state, { code: 'code-flash' }, null);

            expect(errorReasonOf(location)).toBe('no_cookie');
            expect(exchanges).toBe(0);
            expect(await socialRows()).toHaveLength(0);
        });

        it('C6: a CSRF cookie holding another value is refused invalid_state before the code is exchanged', async () =>
        {
            const session = await signIn('owner@test.com');
            const started = await startLink(session);
            const forged = `${started.cookie.split('=')[0]}=${generateOAuthNonce()}`;

            const { location } = await callback(started.state, { code: 'code-flash' }, forged);

            expect(errorReasonOf(location)).toBe('invalid_state');
            expect(exchanges).toBe(0);
            expect(await socialRows()).toHaveLength(0);
        });

        it('C7: a link finished after ten minutes is refused expired', async () =>
        {
            const session = await signIn('owner@test.com');
            const started = await startLink(session);

            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(Date.now() + 11 * 60_000);

            const { location } = await callback(started.state, { code: 'code-flash' }, started.cookie);

            expect(errorReasonOf(location)).toBe('expired');
            expect(await socialRows()).toHaveLength(0);
        });

        it('C9: a link state brought to another provider\'s callback is refused invalid_state', async () =>
        {
            const session = await signIn('owner@test.com');
            const started = await startLink(session);

            const { location } = await callback(started.state, { code: 'code-flash' }, started.cookie, 'github');

            expect(errorReasonOf(location)).toBe('invalid_state');
            expect(exchanges).toBe(0);
            expect(await socialRows()).toHaveLength(0);
        });

        it.each(['suspended', 'pending_deletion'] as const)(
            'C10: an account that became %s meanwhile is refused account_unavailable',
            async (status) =>
            {
                const session = await signIn('owner@test.com');
                const started = await startLink(session);
                await getTestDb().update(users).set({ status }).where(eq(users.id, ownerId));

                const location = await finishLink(started, 'code-flash');

                expect(outcomeOf(location)).toEqual(linked('account_unavailable'));
                expect(await socialRows()).toHaveLength(0);
            },
        );

        it('C11: a person who declines at Battle.net returns cancelled; a provider error returns provider_error', async () =>
        {
            const session = await signIn('owner@test.com');
            const declined = await startLink(session);
            const broken = await startLink(session);

            const cancelled = await callback(declined.state, { error: 'access_denied' }, declined.cookie);
            const failed = await callback(broken.state, { error: 'server_error' }, broken.cookie);

            expect(outcomeOf(cancelled.location)).toEqual(linked('cancelled'));
            expect(outcomeOf(failed.location)).toEqual(linked('provider_error'));
            expect(exchanges).toBe(0);
            expect(await socialRows()).toHaveLength(0);
        });

        it('C12: two accounts linking one identity at once — one wins, the other is told it is taken', async () =>
        {
            const ownerLink = await startLink(await signIn('owner@test.com'));
            const otherLink = await startLink(await signIn('other@test.com'));

            const outcomes = await Promise.all([
                finishLink(ownerLink, 'code-flash'),
                finishLink(otherLink, 'code-flash'),
            ]);

            expect(outcomes.map(location => outcomeOf(location).oauthLink).sort())
                .toEqual(['linked', 'linked_elsewhere']);
            expect(await socialRows()).toHaveLength(1);
        });

        it('C13: one account linking two identities at once — one wins, the other is told one is held', async () =>
        {
            const session = await signIn('owner@test.com');
            const first = await startLink(session);
            const second = await startLink(session);

            const outcomes = await Promise.all([
                finishLink(first, 'code-flash'),
                finishLink(second, 'code-jaedong'),
            ]);

            expect(outcomes.map(location => outcomeOf(location).oauthLink).sort())
                .toEqual(['linked', 'provider_already_linked']);
            expect(await socialRows()).toHaveLength(1);
        });

        it('C14: the callback expires its CSRF cookie, so opening the same URL again without it is no_cookie', async () =>
        {
            const session = await signIn('owner@test.com');
            const started = await startLink(session);

            const first = await callback(started.state, { code: 'code-flash' }, started.cookie);
            const replay = await callback(started.state, { code: 'code-flash' }, null);

            expect(first.setCookie).toContain(`${started.cookie.split('=')[0]}=;`);
            expect(errorReasonOf(replay.location)).toBe('no_cookie');
            expect(await socialRows()).toHaveLength(1);
        });

        it('C15: a link registers no session key, announces no login, and opens no second-factor challenge', async () =>
        {
            const session = await signIn('owner@test.com');
            await enrolSecondFactor(session);
            const started = await startLink(session);
            const keysBefore = await keyCount();
            const logins = captureEvent(authLoginEvent);

            const location = await finishLink(started, 'code-flash');

            expect(outcomeOf(location)).toEqual(linked('linked'));
            expect(await keyCount()).toBe(keysBefore);
            expect(logins).toHaveLength(0);
            expect(await getTestDb().select().from(mfaChallenges)).toHaveLength(0);
        });
    });

    // ========================================================================
    // 7-4. Unlink
    // ========================================================================

    describe('7-4 unlink', () =>
    {
        function unlink(session: Session, body: Record<string, unknown> = {}): Promise<Response>
        {
            return post('/_auth/oauth/battlenet/unlink', body, session.authorization);
        }

        async function linkedOwner(): Promise<Session>
        {
            const session = await signIn('owner@test.com');
            await finishLink(await startLink(session), 'code-flash');

            return session;
        }

        it('U1: an account with another way in detaches the identity and its tokens, announced as link_removed only', async () =>
        {
            const session = await linkedOwner();
            const removed = captureEvent(oauthLinkRemovedEvent);
            const providerUnlinked = captureEvent(oauthUnlinkedEvent);

            const response = await unlink(session);

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({ provider: 'battlenet' });
            expect(await socialRows()).toHaveLength(0);
            expect(removed).toEqual([{ userId: String(ownerId), provider: 'battlenet', providerUserId: '100001' }]);
            expect(providerUnlinked).toHaveLength(0);
        });

        it('U2: an account with no Battle.net identity is 404', async () =>
        {
            const session = await signIn('owner@test.com');

            expect((await unlink(session)).status).toBe(404);
        });

        it('U3: the last way into an account is refused LAST_RECOVERY_CREDENTIAL and stays', async () =>
        {
            const { location, key } = await battlenetSignIn('code-flash');
            const userId = Number(location.searchParams.get('userId'));

            const response = await unlink(sessionFor(key));

            expect(response.status).toBe(409);
            expect((await response.json()).code).toBe('LAST_RECOVERY_CREDENTIAL');
            expect(await linkOf(userId)).toBeDefined();
        });

        it('U4: an enrolled account past its step-up window is refused and the identity stays', async () =>
        {
            const session = await linkedOwner();
            await enrolSecondFactor(session);
            await forgetStepUp(session);

            const response = await unlink(session);

            expect(response.status).toBe(403);
            expect((await response.json()).code).toBe('STEP_UP_REQUIRED');
            expect(await linkOf(ownerId)).toBeDefined();
        });

        it('U5: a session key older than the window with no password is refused and the identity stays', async () =>
        {
            const session = await linkedOwner();
            await ageSession(session, 11);

            const response = await unlink(session);

            expect(response.status).toBe(403);
            expect((await response.json()).code).toBe('RECENT_AUTH_REQUIRED');
            expect(await linkOf(ownerId)).toBeDefined();

            expect((await unlink(session, { currentPassword: PASSWORD })).status).toBe(200);
        });

        it('U6: after an unlink, a Battle.net sign-in with that identity makes a new account', async () =>
        {
            await unlink(await linkedOwner());

            const { location } = await battlenetSignIn('code-flash');

            expect(location.searchParams.get('isNewUser')).toBe('true');
            expect(location.searchParams.get('userId')).not.toBe(String(ownerId));
        });

        it('U7: after an unlink, another account may link the identity', async () =>
        {
            await unlink(await linkedOwner());

            const location = await finishLink(await startLink(await signIn('other@test.com')), 'code-flash');

            expect(outcomeOf(location)).toEqual(linked('linked'));
            expect((await linkOf(otherId))!.providerUserId).toBe('100001');
        });
    });
});
