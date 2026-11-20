/**
 * @spfn/auth - `passwordChangeRequired` is enforced as a restricted session (#362)
 *
 * An account carrying the flag signs in to a session that reaches only the
 * routes leading to the change; the change clears it in its own transaction,
 * and the same session goes on unrestricted. The proxy's keeping of the cookie
 * on the new 403 is row T2 of nextjs-session-decision, and P8 (a route with no
 * `passwordChange` class fails at mount) is in unit/second-factor-policy.
 *
 * | Row | Checks | Unnoticed without it |
 * | --- | --- | --- |
 * | P1 | a flagged session's app route is 403 `PasswordChangeRequiredError` naming `['passwordChange']`, its handler never runs | the flag is still only reported: a seeded admin uses the app with the seeded password |
 * | P2 | the same session reaches `GET /_auth/session` (which reports the flag), `mfa/status` and sign-out | the person is locked out of the only way to clear it, or cannot tell why |
 * | P3 | after `PUT /_auth/password` the same session's app route is 200, and the session answers the flag false | a change that does not clear it, or a clear the next request does not read |
 * | P3b | the change's transaction failing after the clear leaves the flag set and the restriction in force | a clear written outside the transaction survives a change that rolled back |
 * | P4 | with a second factor to enrol too, an enrolment route and the change are both admitted, an app route is refused naming the password first; after the change the enrolment refusal remains | requiring every outstanding requirement deadlocks such an account; the wrong order names enrolment |
 * | P5 | a one-time token and an OAuth 2.1 access token of a flagged account are refused, and the token endpoint's refresh is `invalid_grant` | a door that never sees a route lets a flagged account act around the restriction |
 * | P6 | an enrolled, flagged account completes a new-device sign-in (`mfa/verify`), steps up, and changes the password | the step-up routes or the sign-in completion missing from the open set lock an enrolled account out |
 * | P7 | a password reset clears the restriction: the session it answers is admitted on an app route | a second clearing path forgotten |
 * | X1 | re-typing the current password as the new one is 400, and the flag stays set | the seeded password "changed" to itself clears the requirement |
 *
 * No secret, code or key value here is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import {
    configureTestAuthorizationServer,
    obtainCode,
    pkcePair,
    postToken,
    registerLoopbackClient,
    TEST_REDIRECT_URI,
    TEST_RESOURCE,
} from '../helpers/oauth2';
import { mfaTotp, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { deviceLinksRepository } from '@/server/repositories';
import { generateKeyPair, generateClientToken, type KeyPair } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { __resetChannelsForTests, configureChannels } from '@/server/lib/channels-config';
import { configureAuthorizationServer } from '@/server/lib/oauth2/config';
import { __resetSecondFactorPolicyForTests, configureSecondFactor } from '@/server/lib/second-factor-policy';

const sendEmail = vi.fn().mockResolvedValue({ success: true });

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return { ...actual, sendEmail: (...args: unknown[]) => sendEmail(...args) };
});

const { Hono: HonoApp } = await import('hono');
const { registerRoutes, route, defineRouter } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { mainAuthRouter } = await import('@/server/routes');
const { authenticate } = await import('@/server/middleware/authenticate');
const { oneTimeTokenAuth } = await import('@/server/middleware/one-time-token-auth');
const { getAuth } = await import('@/server/helpers/context');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { verifyAccessToken } = await import('@/server/services/oauth2-access-token.service');
const { settleLinkMail } = await import('@/server/lib/link-mail-delivery');
const { initOneTimeTokenManager } = await import('@/server/lib/one-time-token');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const EMAIL = 'seeded@pcr362.test';
const PASSWORD = 'SeededPassword123!';
const NEW_PASSWORD = 'ChosenPassword456!';
const RESET_PASSWORD = 'ResetPassword789!';

/** A signed-in device: what to sign requests with. */
interface Session
{
    authorization: string;
    keyId: string;
}

/** What the app's own handlers ran for. */
const handled: string[] = [];

function appRouter()
{
    const whoami = route.get('/app/whoami')
        .handler(async (c) =>
        {
            handled.push('whoami');

            return { userId: getAuth(c).userId };
        });

    // The OAuth 2.1 resource path as an app builds it.
    const resource = route.get('/app/resource')
        .skip(['auth'])
        .handler(async (c) =>
        {
            const bearer = c.raw.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
            const principal = await verifyAccessToken(bearer, TEST_RESOURCE);

            if (!principal)
            {
                return c.raw.json({ error: 'invalid_token' }, 401);
            }

            handled.push('resource');

            return { userId: principal.userId };
        });

    return defineRouter({ whoami, resource });
}

/** The app as core assembles it: its own routes first, then the package's, behind the global `authenticate`. */
function mountApp(): Hono
{
    const app = new HonoApp();
    const serverMiddlewares = [{ name: authenticate.name, handler: authenticate.handler }];

    registerRoutes(app, appRouter(), serverMiddlewares);
    registerRoutes(app, mainAuthRouter, serverMiddlewares);
    // A file-upload style route behind the one-time token door.
    app.post('/app/upload', oneTimeTokenAuth.handler, (c) =>
    {
        handled.push('upload');

        return c.json({ ok: true });
    });
    app.onError(ErrorHandler());

    return app;
}

describe.skipIf(!dbAvailable)('passwordChangeRequired is a restricted session (#362)', () =>
{
    let app: Hono;
    let userId: number;
    let ipCounter = 0;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = `active:${Buffer.alloc(32, 3).toString('base64')}`;
        process.env.SPFN_APP_URL = 'https://app.example.com';

        initOneTimeTokenManager();
        app = mountApp();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
        delete process.env.SPFN_APP_URL;
    });

    beforeEach(async () =>
    {
        __resetSecondFactorPolicyForTests();
        __resetChannelsForTests();
        handled.length = 0;
        sendEmail.mockClear();

        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        resetMemoryRateLimitStore();

        const [row] = await db.insert(users).values({
            email: EMAIL,
            passwordHash: await hashPassword(PASSWORD),
            roleId: (await getRoleByName('user'))!.id,
            emailVerifiedAt: new Date(),
            passwordChangeRequired: true,
        }).returning({ id: users.id });

        userId = Number(row!.id);
    });

    afterEach(() =>
    {
        vi.restoreAllMocks();
        __resetSecondFactorPolicyForTests();
        __resetChannelsForTests();
        configureAuthorizationServer(undefined);
    });

    // ========================================================================
    // Driving the routes
    // ========================================================================

    async function request(method: string, path: string, authorization?: string, body?: unknown): Promise<Response>
    {
        ipCounter += 1;
        const response = await app.request(path, {
            method,
            headers: {
                ...JSON_HEADERS,
                'x-forwarded-for': `198.51.100.${ipCounter % 250}`,
                ...authorization ? { Authorization: authorization } : {},
            },
            body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        });
        await settleLinkMail();

        return response;
    }

    function post(path: string, body: unknown, authorization?: string): Promise<Response>
    {
        return request('POST', path, authorization, body);
    }

    function signedBy(keyPair: KeyPair): Session
    {
        const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' });

        return { authorization: `Bearer ${token}`, keyId: keyPair.keyId };
    }

    function deviceKey(keyPair: KeyPair)
    {
        return { publicKey: keyPair.publicKey, keyId: keyPair.keyId, fingerprint: keyPair.fingerprint, algorithm: keyPair.algorithm };
    }

    async function passwordLogin(password = PASSWORD)
    {
        const keyPair = generateKeyPair('ES256');
        const response = await post('/_auth/login', { email: EMAIL, password, ...deviceKey(keyPair) });

        return { response, body: await response.json(), session: signedBy(keyPair) };
    }

    async function signIn(): Promise<Session>
    {
        const { response, body, session } = await passwordLogin();

        expect(response.status, JSON.stringify(body)).toBe(200);

        return session;
    }

    function changePassword(session: Session, currentPassword: string, newPassword: string): Promise<Response>
    {
        return request('PUT', '/_auth/password', session.authorization, { currentPassword, newPassword });
    }

    async function setFlag(value: boolean): Promise<void>
    {
        await getTestDb().update(users).set({ passwordChangeRequired: value }).where(eq(users.id, userId));
    }

    async function flag(): Promise<boolean>
    {
        const [row] = await getTestDb().select({ flag: users.passwordChangeRequired }).from(users).where(eq(users.id, userId));

        return row!.flag;
    }

    /** A refusal of a restricted session: its status, the class name the envelope carries, and the details. */
    async function expectRestricted(response: Response, code: string, requirements?: string[]): Promise<void>
    {
        const text = await response.text();
        const body = JSON.parse(text);

        expect(response.status, text).toBe(403);
        expect(body.error.code, text).toBe(code);

        if (requirements !== undefined)
        {
            expect(body.details?.requirements, text).toEqual(requirements);
        }
    }

    /** A reset link asked for, mailed and confirmed: the setup secret it hands out. */
    async function openResetSession(): Promise<string>
    {
        expect((await post('/_auth/password/reset', { email: EMAIL })).status).toBe(200);
        const mail = sendEmail.mock.calls.filter(([arg]) => arg?.template === 'password-reset').at(-1)!;
        const token = new URL(mail[0].data.confirmUrl).searchParams.get('token')!;
        const confirmed = await post('/_auth/password/reset/confirm', { token });
        expect(confirmed.status).toBe(200);

        return (await confirmed.json()).setupSecret;
    }

    function completeReset(setupSecret: string, password: string, keyPair: KeyPair): Promise<Response>
    {
        return post('/_auth/password/reset/complete', { setupSecret, password, ...deviceKey(keyPair) });
    }

    function codeFor(secret: string): string
    {
        return hotp(decodeBase32(secret), totpStep(Date.now()));
    }

    /** A TOTP confirmed on this session; each later code is fresh (the step is cleared after use). */
    async function enrolTotp(session: Session): Promise<string>
    {
        const enroll = await post('/_auth/mfa/totp/enroll', {}, session.authorization);
        expect(enroll.status, await enroll.clone().text()).toBe(200);
        const secret = (await enroll.json()).secret as string;
        const confirmed = await post('/_auth/mfa/totp/confirm', { code: codeFor(secret) }, session.authorization);
        expect(confirmed.status).toBe(200);
        await clearTotpStep();

        return secret;
    }

    async function clearTotpStep(): Promise<void>
    {
        await getTestDb().update(mfaTotp).set({ lastUsedStep: null });
    }

    // ========================================================================
    // Rows
    // ========================================================================

    it('P1: a flagged session is refused an app route with 403 PasswordChangeRequiredError naming the requirement', async () =>
    {
        const { body } = await passwordLogin();
        expect(body.passwordChangeRequired).toBe(true);
        const session = await signIn();

        await expectRestricted(await request('GET', '/app/whoami', session.authorization), 'PasswordChangeRequiredError', ['passwordChange']);
        await expectRestricted(await post('/_auth/keys/list', {}, session.authorization), 'PasswordChangeRequiredError', ['passwordChange']);
        expect(handled).toEqual([]);
    });

    it('P2: the flagged session reaches the session read (which reports the flag), mfa/status and sign-out', async () =>
    {
        const session = await signIn();

        const read = await request('GET', '/_auth/session', session.authorization);
        expect(read.status).toBe(200);
        expect(await read.json()).toMatchObject({ passwordChangeRequired: true });
        expect((await request('GET', '/_auth/mfa/status', session.authorization)).status).toBe(200);

        expect((await post('/_auth/logout', {}, session.authorization)).status).toBeLessThan(300);
        expect((await request('GET', '/_auth/session', session.authorization)).status).toBe(401);
    });

    it('P3: the change clears it, and the same session is admitted on its next request', async () =>
    {
        const session = await signIn();

        expect((await changePassword(session, PASSWORD, NEW_PASSWORD)).status).toBe(204);

        expect(await flag()).toBe(false);
        const whoami = await request('GET', '/app/whoami', session.authorization);
        expect(whoami.status).toBe(200);
        expect(await whoami.json()).toEqual({ userId: String(userId) });
        expect(await (await request('GET', '/_auth/session', session.authorization)).json()).toMatchObject({ passwordChangeRequired: false });
    });

    it('P3b: a change whose transaction fails after the clear leaves the flag set and the restriction in force', async () =>
    {
        const session = await signIn();
        // The last write of the change's transaction, after the password and the flag.
        vi.spyOn(deviceLinksRepository, 'expireAllLiveByUserId').mockImplementationOnce(async () =>
        {
            throw new Error('pcr362: the transaction fails after the clear');
        });

        expect((await changePassword(session, PASSWORD, NEW_PASSWORD)).status).toBe(500);

        expect(await flag()).toBe(true);
        await expectRestricted(await request('GET', '/app/whoami', session.authorization), 'PasswordChangeRequiredError', ['passwordChange']);
        expect(handled).toEqual([]);
    });

    it('P4: with a second factor to enrol too, the enrolment route and the change are both admitted, an app route names the password first', async () =>
    {
        configureChannels({ deviceCode: false, deviceLink: false });
        configureSecondFactor({ required: true, methods: ['totp'], recoveryCodes: false });
        const { body, session } = await passwordLogin();
        expect(body).toMatchObject({ passwordChangeRequired: true, secondFactorEnrolmentRequired: true });

        await expectRestricted(
            await request('GET', '/app/whoami', session.authorization),
            'PasswordChangeRequiredError',
            ['passwordChange', 'secondFactorEnrolment'],
        );
        // An enrolment route: admitted under the enrolment requirement alone.
        const enroll = await post('/_auth/mfa/totp/enroll', {}, session.authorization);
        expect(enroll.status, await enroll.clone().text()).toBe(200);
        // The change: admitted under the password requirement alone.
        expect((await changePassword(session, PASSWORD, NEW_PASSWORD)).status).toBe(204);

        await expectRestricted(await request('GET', '/app/whoami', session.authorization), 'SecondFactorEnrolmentRequiredError');
        expect(handled).toEqual([]);
    });

    it('P5: a one-time token and an OAuth 2.1 access token of a flagged account are refused; the refresh is invalid_grant', async () =>
    {
        await setFlag(false);
        configureTestAuthorizationServer();
        const session = await signIn();
        const issuedOtt = await post('/_auth/tokens', {}, session.authorization);
        expect(issuedOtt.status).toBe(200);
        const ott = (await issuedOtt.json()).token as string;
        const clientId = await registerLoopbackClient(app, 'pcr362-cli', [TEST_REDIRECT_URI], '203.0.113.91');
        const { verifier, challenge } = pkcePair('pcr362');
        const code = await obtainCode(app, session.authorization, { client_id: clientId }, challenge);
        const issued = await (await postToken(app, {
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            client_id: clientId,
            redirect_uri: TEST_REDIRECT_URI,
            resource: TEST_RESOURCE,
        })).json();
        await setFlag(true);

        await expectRestricted(await post(`/app/upload?token=${ott}`, {}), 'PasswordChangeRequiredError', ['passwordChange']);
        await expectRestricted(await request('GET', '/app/resource', `Bearer ${issued.access_token}`), 'PasswordChangeRequiredError');
        await expect(verifyAccessToken(issued.access_token, TEST_RESOURCE)).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
        const refreshed = await postToken(app, { grant_type: 'refresh_token', refresh_token: issued.refresh_token, client_id: clientId });
        expect(refreshed.status).toBe(400);
        expect((await refreshed.json()).error).toBe('invalid_grant');
        expect(handled).toEqual([]);
    });

    it('P6: an enrolled, flagged account completes a new-device sign-in, steps up, and changes the password', async () =>
    {
        await setFlag(false);
        const secret = await enrolTotp(await signIn());
        await setFlag(true);

        const pending = await passwordLogin();
        expect(pending.response.status).toBe(202);
        const verified = await post('/_auth/mfa/verify', { challenge: pending.body.challenge.secret, code: codeFor(secret) });
        expect(verified.status, await verified.clone().text()).toBe(200);
        expect(await verified.json()).toMatchObject({ passwordChangeRequired: true });
        await clearTotpStep();

        const steppedUp = await post('/_auth/mfa/step-up', { code: codeFor(secret) }, pending.session.authorization);
        expect(steppedUp.status, await steppedUp.clone().text()).toBeLessThan(300);
        expect((await changePassword(pending.session, PASSWORD, NEW_PASSWORD)).status).toBe(204);

        expect((await request('GET', '/app/whoami', pending.session.authorization)).status).toBe(200);
    });

    it('P7: a password reset clears the restriction — the session it answers is admitted on an app route', async () =>
    {
        const setupSecret = await openResetSession();
        const keyPair = generateKeyPair('ES256');

        const completed = await completeReset(setupSecret, RESET_PASSWORD, keyPair);

        expect(completed.status, await completed.clone().text()).toBe(200);
        expect(await flag()).toBe(false);
        expect((await request('GET', '/app/whoami', signedBy(keyPair).authorization)).status).toBe(200);
    });

    it('R1: a reset of a flagged account to its current password is 400 and keeps the flag; the same setup session then completes with another', async () =>
    {
        const setupSecret = await openResetSession();

        const refused = await completeReset(setupSecret, PASSWORD, generateKeyPair('ES256'));
        const text = await refused.text();

        expect(refused.status, text).toBe(400);
        expect(JSON.parse(text).error.code, text).toBe('ValidationError');
        expect(await flag()).toBe(true);
        expect((await passwordLogin()).response.status).toBe(200);

        const retried = await completeReset(setupSecret, RESET_PASSWORD, generateKeyPair('ES256'));

        expect(retried.status, await retried.clone().text()).toBe(200);
        expect(await flag()).toBe(false);
    });

    it('R1b: an unflagged account still resets to the password it had', async () =>
    {
        await setFlag(false);

        const completed = await completeReset(await openResetSession(), PASSWORD, generateKeyPair('ES256'));

        expect(completed.status, await completed.clone().text()).toBe(200);
        expect((await passwordLogin()).response.status).toBe(200);
    });

    it('X1: re-typing the current password as the new one is refused, and the requirement stays', async () =>
    {
        const session = await signIn();

        const refused = await changePassword(session, PASSWORD, PASSWORD);
        const text = await refused.text();

        expect(refused.status, text).toBe(400);
        expect(text).toContain('must differ from the current one');
        expect(await flag()).toBe(true);
        await expectRestricted(await request('GET', '/app/whoami', session.authorization), 'PasswordChangeRequiredError');
    });
});
