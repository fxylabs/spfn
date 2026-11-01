/**
 * @spfn/auth - Auth events are published after the transaction commits
 *
 * Every route that signs a user up, signs one in or accepts an invitation runs
 * under `Transactional()`. An event emitted inline is published while that
 * transaction is still open: a subscriber reading from another connection cannot
 * see the account yet, and a mail or a webhook sent from it escapes even when the
 * transaction later rolls back.
 *
 * Two kinds of row per emit site. A PROBE row subscribes with a second database
 * connection and asks, at the moment the event arrives, whether the row the
 * event names is readable — true only once the transaction has committed. A
 * ROLLBACK row runs the service inside a transaction that throws after the emit
 * point and expects no event at all.
 *
 * The runner fires after-commit callbacks without awaiting them, so every row
 * reads its capture through `settled()` rather than straight after the response.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import postgres from 'postgres';
import { and, desc, eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp } from '../helpers/oauth2';
import { userInvitations, users, verificationCodes } from '@/server/entities';
import { generateKeyPair, type KeyPair } from '@/server/lib/crypto';
import { hashPassword } from '@/server/helpers/password';
import type { NormalizedIdentity } from '@/server/lib/oauth';

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: vi.fn().mockResolvedValue({ success: true }),
        sendSMS: vi.fn().mockResolvedValue({ success: true }),
    };
});

const { resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { runInTransaction } = await import('@spfn/core/db');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { authLoginEvent, authRegisterEvent, invitationAcceptedEvent } = await import('@/server/events');
const { registerOAuthProvider } = await import('@/server/lib/oauth');
const { battlenetProvider } = await import('@/server/lib/oauth/battlenet-provider');
const { buildStartCookieName } = await import('@/server/lib/oauth/start-cookies');
const { createOAuthState, generateOAuthNonce } = await import('@/server/lib/oauth/state');
const { oauthCallbackService } = await import('@/server/services/oauth.service');
const { createVerifiedAccount, loginService } = await import('@/server/services/auth.service');
const { acceptInvitation } = await import('@/server/services/invitation.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'SecurePassword123!';
const APP_URL = 'http://localhost:3000';
const INVITATION_TOKEN = '22222222-2222-4222-8222-222222222222';

const identities = new Map<string, NormalizedIdentity>([
    ['code-verified', {
        providerUserId: '200001', email: null, emailVerified: false, name: 'Boxer#1111', handle: 'Boxer#1111',
    }],
]);

/** The parts of an event a row subscribes to. */
interface Subscribable<TPayload>
{
    subscribe: (handler: (payload: TPayload) => void | Promise<void>) => () => void;
}

/** A Battle.net sign-in state as the sign-in interceptor seals it, and its CSRF nonce. */
interface StartedSignIn
{
    state: string;
    nonce: string;
    key: KeyPair;
}

describe.skipIf(!dbAvailable)('auth events are published after the transaction commits', () =>
{
    let app: Hono;
    let observer: ReturnType<typeof postgres>;
    let unsubscribers: Array<() => void>;
    let testIndex = 0;
    let clientIp: string;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';
        // The web callback stores the provider's tokens, which are encrypted at rest.
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = `v1:${Buffer.alloc(32, 7).toString('base64')}`;
        app = await mountAuthApp();
        // `setupTestDb` points DATABASE_URL at the test database.
        observer = postgres(process.env.DATABASE_URL!, { max: 1 });
        // Connected now, so no row's first look waits out a connect that would
        // outlast the commit it is meant to precede.
        await observer`select 1`;
    });

    afterAll(async () =>
    {
        registerOAuthProvider(battlenetProvider);
        await observer.end();
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();
        registerOAuthProvider({
            id: 'battlenet',
            isEnabled: () => true,
            getAuthUrl: (state: string) => `https://oauth.battle.example/authorize?state=${state}`,
            exchangeCodeForTokens: async (code: string) =>
                ({ accessToken: `access-${code}`, expiresIn: 86400, identity: identities.get(code) }),
            getUserInfo: async () =>
            {
                throw new Error('the stand-in answers identity from the token response');
            },
        });
        vi.stubEnv('SPFN_APP_URL', APP_URL);

        testIndex += 1;
        clientIp = `198.51.101.${testIndex & 0xff}`;
        unsubscribers = [];
    });

    afterEach(() =>
    {
        // The events are module singletons and every suite in this package runs
        // in one fork, so a handler left behind would collect another file's rows.
        unsubscribers.forEach(unsubscribe => unsubscribe());
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    // ========================================================================
    // Harness
    // ========================================================================

    /** Let the after-commit queue drain: the runner fires it without awaiting. */
    async function settled(): Promise<void>
    {
        await new Promise((resolve) => setTimeout(resolve, 30));
    }

    function capture<TPayload>(event: Subscribable<TPayload>): TPayload[]
    {
        const seen: TPayload[] = [];
        unsubscribers.push(event.subscribe((payload) => void seen.push(payload)));

        return seen;
    }

    /**
     * For each delivery of `event`, what `look` answered from the observer
     * connection at the moment the event arrived. One entry per delivery, so a
     * row that expects `[true]` also asserts the event came exactly once.
     *
     * The handler awaits the look, so an emit that awaits its handlers holds
     * still until the read is answered — an inline emit then reads while the
     * transaction is open, instead of racing its commit.
     */
    function visibilityAtEvent<TPayload>(
        event: Subscribable<TPayload>,
        look: (payload: TPayload) => Promise<boolean>,
    ): () => Promise<boolean[]>
    {
        const looks: Array<Promise<boolean>> = [];
        unsubscribers.push(event.subscribe(async (payload) =>
        {
            const answer = look(payload);
            looks.push(answer);
            await answer;
        }));

        return async () =>
        {
            await settled();

            return await Promise.all(looks);
        };
    }

    async function userIsVisible({ userId }: { userId: string }): Promise<boolean>
    {
        const rows = await observer<{ id: number }[]>`select id from spfn_auth.users where id = ${Number(userId)}`;

        return rows.length === 1;
    }

    function keyCountIs(expected: number): (payload: { userId: string }) => Promise<boolean>
    {
        return async ({ userId }) =>
        {
            const [row] = await observer<{ count: number }[]>`
                select count(*)::int as count from spfn_auth.user_public_keys where user_id = ${Number(userId)}`;

            return row!.count === expected;
        };
    }

    function post(path: string, body: unknown): Promise<Response>
    {
        return Promise.resolve(app.request(path, {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': clientIp },
            body: JSON.stringify(body),
        }));
    }

    function deviceKeyBody(key = generateKeyPair('ES256'))
    {
        return { publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm };
    }

    async function seedUser(email: string): Promise<number>
    {
        const userRole = await getRoleByName('user');
        const [row] = await getTestDb().insert(users).values({
            email,
            passwordHash: await hashPassword(PASSWORD),
            emailVerifiedAt: new Date(),
            roleId: userRole!.id,
        }).returning({ id: users.id });

        return Number(row!.id);
    }

    async function seedInvitation(email: string): Promise<void>
    {
        const userRole = await getRoleByName('user');

        await getTestDb().insert(userInvitations).values({
            email,
            token: INVITATION_TOKEN,
            roleId: userRole!.id,
            invitedBy: await seedUser(`inviter-${email}`),
            status: 'pending',
            expiresAt: new Date(Date.now() + 86_400_000),
        });
    }

    async function invitationStatus(): Promise<string>
    {
        const [row] = await getTestDb().select().from(userInvitations)
            .where(eq(userInvitations.token, INVITATION_TOKEN));

        return row!.status;
    }

    async function userCount(): Promise<number>
    {
        return (await getTestDb().select().from(users)).length;
    }

    async function startSignIn(): Promise<StartedSignIn>
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

        return { state, nonce, key };
    }

    /** A whole web sign-in through the routed callback, which runs under `Transactional()`. */
    async function signIn(code: string): Promise<URL>
    {
        const started = await startSignIn();
        const params = new URLSearchParams({ code, state: started.state });
        const response = await app.request(`/_auth/oauth/battlenet/callback?${params}`, {
            headers: {
                Cookie: `${buildStartCookieName('csrf', started.key.keyId)}=${started.nonce}`,
                'x-forwarded-for': clientIp,
            },
        });

        expect(response.status).toBe(302);

        return new URL(response.headers.get('location')!, APP_URL);
    }

    function signedInUserOf(location: URL): number
    {
        expect(location.pathname).not.toBe('/auth/error');

        return Number(location.searchParams.get('userId'));
    }

    /** Register through the six-digit-code flow, as `/_auth/register` requires. */
    async function registerViaCode(email: string): Promise<Response>
    {
        await post('/_auth/codes', { target: email, targetType: 'email', purpose: 'registration' });

        const [codeRow] = await getTestDb().select().from(verificationCodes)
            .where(and(eq(verificationCodes.target, email), eq(verificationCodes.purpose, 'registration')))
            .orderBy(desc(verificationCodes.createdAt))
            .limit(1);
        const verified = await post('/_auth/codes/verify', {
            target: email, targetType: 'email', code: codeRow!.code, purpose: 'registration',
        });
        const { verificationToken } = await verified.json();

        return await post('/_auth/register', { email, verificationToken, password: PASSWORD, ...deviceKeyBody() });
    }

    /** Run `work` in a transaction that throws once it has finished, and swallow that throw. */
    async function rolledBack(work: () => Promise<unknown>): Promise<void>
    {
        await expect(runInTransaction(async () =>
        {
            await work();

            throw new Error('rolled back after the emit point');
        })).rejects.toThrow('rolled back');
        await settled();
    }

    // ========================================================================
    // Web OAuth callback (oauthCallbackService)
    // ========================================================================

    describe('web OAuth callback', () =>
    {
        it('PROBE: a new web sign-up publishes auth.register only after its user commits', async () =>
        {
            const visibility = visibilityAtEvent(authRegisterEvent, userIsVisible);

            signedInUserOf(await signIn('code-verified'));

            expect(await visibility()).toEqual([true]);
        });

        it('PROBE: a returning web sign-in publishes auth.login only after its new key commits', async () =>
        {
            const userId = signedInUserOf(await signIn('code-verified'));
            await settled();
            const visibility = visibilityAtEvent(authLoginEvent, keyCountIs(2));
            const registers = capture(authRegisterEvent);

            expect(signedInUserOf(await signIn('code-verified'))).toBe(userId);

            expect(await visibility()).toEqual([true]);
            expect(registers).toEqual([]);
        });

        it('ROLLBACK: a new web sign-up whose transaction rolls back publishes no auth.register', async () =>
        {
            const registers = capture(authRegisterEvent);
            const started = await startSignIn();
            const usersBefore = await userCount();

            await rolledBack(() => oauthCallbackService({
                provider: 'battlenet',
                code: 'code-verified',
                state: started.state,
                expectedNonce: [started.nonce],
                ip: clientIp,
            }));

            expect(registers).toEqual([]);
            expect(await userCount()).toBe(usersBefore);
        });

        it('ROLLBACK: a returning web sign-in whose transaction rolls back publishes no auth.login', async () =>
        {
            signedInUserOf(await signIn('code-verified'));
            await settled();
            const logins = capture(authLoginEvent);
            const started = await startSignIn();

            await rolledBack(() => oauthCallbackService({
                provider: 'battlenet',
                code: 'code-verified',
                state: started.state,
                expectedNonce: [started.nonce],
                ip: clientIp,
            }));

            expect(logins).toEqual([]);
        });

        it('a publish that fails after the commit leaves the sign-up committed and the redirect a success', async () =>
        {
            vi.spyOn(authRegisterEvent, 'emit').mockRejectedValue(new Error('broker unreachable'));

            const userId = signedInUserOf(await signIn('code-verified'));
            await settled();

            expect(authRegisterEvent.emit).toHaveBeenCalledTimes(1);
            expect(await userIsVisible({ userId: String(userId) })).toBe(true);
        });
    });

    // ========================================================================
    // Password register and login (auth.service)
    // ========================================================================

    describe('password register and login', () =>
    {
        it('PROBE: /_auth/register publishes auth.register only after its user commits', async () =>
        {
            const visibility = visibilityAtEvent(authRegisterEvent, userIsVisible);

            expect((await registerViaCode('register@test.com')).status).toBe(200);

            expect(await visibility()).toEqual([true]);
        });

        it('ROLLBACK: createVerifiedAccount in a transaction that rolls back publishes no auth.register', async () =>
        {
            const registers = capture(authRegisterEvent);
            const usersBefore = await userCount();

            await rolledBack(() => createVerifiedAccount({
                email: 'rollback@test.com',
                password: PASSWORD,
                ...deviceKeyBody(),
                channel: 'register',
            }));

            expect(registers).toEqual([]);
            expect(await userCount()).toBe(usersBefore);
        });

        it('PROBE: /_auth/login publishes auth.login only after its new key commits', async () =>
        {
            await seedUser('login@test.com');
            const visibility = visibilityAtEvent(authLoginEvent, keyCountIs(1));

            const response = await post('/_auth/login', { email: 'login@test.com', password: PASSWORD, ...deviceKeyBody() });

            expect(response.status).toBe(200);
            expect(await visibility()).toEqual([true]);
        });

        it('ROLLBACK: loginService in a transaction that rolls back publishes no auth.login', async () =>
        {
            await seedUser('login-rollback@test.com');
            const logins = capture(authLoginEvent);

            await rolledBack(() => loginService({
                email: 'login-rollback@test.com',
                password: PASSWORD,
                ...deviceKeyBody(),
            }));

            expect(logins).toEqual([]);
        });
    });

    // ========================================================================
    // Invitation acceptance (invitation.service)
    // ========================================================================

    describe('invitation acceptance', () =>
    {
        it('PROBE: /_auth/invitations/accept publishes auth.invitation.accepted only after its user commits', async () =>
        {
            await seedInvitation('invitee@test.com');
            const visibility = visibilityAtEvent(invitationAcceptedEvent, userIsVisible);

            const response = await post('/_auth/invitations/accept', {
                token: INVITATION_TOKEN, password: PASSWORD, ...deviceKeyBody(),
            });

            expect(response.status).toBe(200);
            expect(await visibility()).toEqual([true]);
        });

        it('ROLLBACK: acceptInvitation in a transaction that rolls back publishes no auth.invitation.accepted', async () =>
        {
            await seedInvitation('invitee-rollback@test.com');
            const accepted = capture(invitationAcceptedEvent);

            await rolledBack(() => acceptInvitation({ token: INVITATION_TOKEN, password: PASSWORD, ...deviceKeyBody() }));

            expect(accepted).toEqual([]);
            expect(await invitationStatus()).toBe('pending');
        });
    });
});
