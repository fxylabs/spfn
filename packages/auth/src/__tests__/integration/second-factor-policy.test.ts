/**
 * @spfn/auth - A second-factor policy (#309)
 *
 * One test per row of the #309 case table — S1–S19, R1–R7, K1–K5 — named for
 * its row. The boot rows B1–B7 and the classification's own guarantees are in
 * unit/second-factor-policy.test.ts.
 *
 * Driven at the routes, on the production path: the auth router and an app
 * router of its own mounted side by side behind server-level
 * `[authenticate, actor]`, where `actor` records the principal each request
 * reached it with. Unless a row says otherwise the policy is the table's:
 * `required: true`, `methods: ['passkey']`, `recoveryCodes: false`, device
 * channels off. Each "must not happen" is asserted against the tables or the
 * answer after the refusal, not left implied.
 *
 * Every test puts the policy and the channels back: the package's tests share
 * one fork, so a setting left behind would hold the next file to it.
 *
 * No secret, code or key value here is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import {
    configureTestAuthorizationServer,
    obtainCode,
    pkcePair,
    postToken,
    registerLoopbackClient,
    TEST_REDIRECT_URI,
    TEST_RESOURCE,
} from '../helpers/oauth2';
import {
    mfaChallenges,
    mfaRecoveryCodes,
    mfaTotp,
    mfaVerifications,
    passkeys,
    userPublicKeys,
    users,
} from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { mfaEnrolmentRepository } from '@/server/repositories';
import { generateKeyPair, generateClientToken, type KeyPair } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { authLoginEvent } from '@/server/events';
import { __resetChannelsForTests, configureChannels } from '@/server/lib/channels-config';
import { configureAuthorizationServer } from '@/server/lib/oauth2/config';
import {
    __resetSecondFactorPolicyForTests,
    configureSecondFactor,
    type SecondFactorOptions,
} from '@/server/lib/second-factor-policy';

const { Hono: HonoApp } = await import('hono');
const { registerRoutes, route, defineRouter } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { mainAuthRouter } = await import('@/server/routes');
const { authenticate, optionalAuth } = await import('@/server/middleware/authenticate');
const { opsTokenAuth, requireOpsScope } = await import('@/server/middleware/ops-token-auth');
const { getAuth, getOptionalAuth } = await import('@/server/helpers/context');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { disableMfaService } = await import('@/server/services/mfa.service');
const { issueOpsTokenService } = await import('@/server/services/ops-token.service');
const { verifyAccessToken } = await import('@/server/services/oauth2-access-token.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 7).toString('base64')}`;
const EMAIL = 'owner@sf309.test';

/** The table's policy. */
const TABLE_POLICY: SecondFactorOptions = { required: true, methods: ['passkey'], recoveryCodes: false };

/** A signed-in device: what to sign requests with, and its key. */
interface Session
{
    authorization: string;
    keyId: string;
}

/** What the app router's own handlers saw. */
const handled: string[] = [];

/** server-level `actor`: the principal each path reached it with. */
const seen = new Map<string, string | null>();

/** The app's own routes, mounted beside `mainAuthRouter`. */
function appRouter()
{
    const whoami = route.get('/app/whoami')
        .handler(async (c) =>
        {
            handled.push('whoami');

            return { userId: getAuth(c).userId };
        });

    const optional = route.get('/app/optional')
        .use([optionalAuth])
        .handler(async (c) =>
        {
            handled.push('optional');

            return { userId: getOptionalAuth(c)?.userId ?? null };
        });

    const ops = route.get('/app/ops')
        .use([opsTokenAuth, requireOpsScope('reports:read')])
        .handler(async () =>
        {
            handled.push('ops');

            return { ok: true };
        });

    // The OAuth 2.1 resource path as an app builds it: the bearer goes to
    // `verifyAccessToken`, and its refusal is the app's 401.
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

    return defineRouter({ whoami, optional, ops, resource });
}

function mountApp(): Hono
{
    const app = new HonoApp();
    const serverMiddlewares = [
        { name: authenticate.name, handler: authenticate.handler },
        {
            name: 'actor',
            handler: async (c: Parameters<typeof authenticate.handler>[0], next: () => Promise<void>) =>
            {
                seen.set(c.req.path, (c.get('auth') as { userId?: string } | undefined)?.userId ?? null);
                await next();
            },
        },
    ];

    registerRoutes(app, mainAuthRouter, serverMiddlewares);
    registerRoutes(app, appRouter(), serverMiddlewares);
    app.onError(ErrorHandler());

    return app;
}

describe.skipIf(!dbAvailable)('second-factor policy (#309 case table)', () =>
{
    let app: Hono;
    let userId: number;
    let ipCounter = 0;
    const unsubscribers: (() => void)[] = [];

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;
        process.env.SPFN_APP_URL = 'https://app.example.com';

        app = mountApp();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
        delete process.env.SPFN_APP_URL;
    });

    beforeEach(async () =>
    {
        __resetSecondFactorPolicyForTests();
        __resetChannelsForTests();
        handled.length = 0;
        seen.clear();

        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        resetMemoryRateLimitStore();

        const [row] = await db.insert(users).values({
            email: EMAIL,
            passwordHash: await hashPassword(PASSWORD),
            roleId: (await getRoleByName('user'))!.id,
            emailVerifiedAt: new Date(),
        }).returning({ id: users.id });

        userId = Number(row!.id);
    });

    afterEach(() =>
    {
        unsubscribers.splice(0).forEach(unsubscribe => unsubscribe());
        __resetSecondFactorPolicyForTests();
        __resetChannelsForTests();
        configureAuthorizationServer(undefined);
    });

    // ========================================================================
    // Driving the routes
    // ========================================================================

    function usePolicy(options: SecondFactorOptions = TABLE_POLICY): void
    {
        configureChannels({ deviceCode: false, deviceLink: false });
        configureSecondFactor(options);
    }

    async function request(method: string, path: string, authorization?: string, body?: unknown): Promise<Response>
    {
        ipCounter += 1;

        return await app.request(path, {
            method,
            headers: {
                ...JSON_HEADERS,
                'x-forwarded-for': `198.51.100.${ipCounter % 250}`,
                ...authorization ? { Authorization: authorization } : {},
            },
            body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
        });
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
        return {
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        };
    }

    async function passwordLogin()
    {
        const keyPair = generateKeyPair('ES256');
        const response = await post('/_auth/login', { email: EMAIL, password: PASSWORD, ...deviceKey(keyPair) });

        return { response, body: await response.json(), session: signedBy(keyPair) };
    }

    /** A password sign-in that answered a session. */
    async function signIn(): Promise<Session>
    {
        const { response, session } = await passwordLogin();

        expect(response.status).toBe(200);

        return session;
    }

    function codeFor(secret: string): string
    {
        return hotp(decodeBase32(secret), totpStep(Date.now()));
    }

    /** Enrol a confirmed TOTP on this session; its secret and recovery codes. */
    async function enrolTotp(session: Session)
    {
        const enroll = await post('/_auth/mfa/totp/enroll', {}, session.authorization);
        expect(enroll.status).toBe(200);
        const secret = (await enroll.json()).secret as string;
        const confirmed = await post('/_auth/mfa/totp/confirm', { code: codeFor(secret) }, session.authorization);
        expect(confirmed.status).toBe(200);
        // The confirm spent the current step; a later valid code must not be a replay.
        await getTestDb().update(mfaTotp).set({ lastUsedStep: null });

        return { secret, recoveryCodes: (await confirmed.json()).recoveryCodes as string[] };
    }

    /** Register a passkey on this session; the authenticator and its id. */
    async function registerPasskey(session: Session)
    {
        const authenticator = await FixtureAuthenticator.create();
        const options = await post('/_auth/passkeys/register/options', {}, session.authorization);
        expect(options.status).toBe(200);
        const registered = await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({ challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID }),
        }, session.authorization);
        expect(registered.status).toBe(200);

        return { authenticator, passkeyId: (await registered.json()).passkeyId as string };
    }

    function mark(session: Session, passkeyId: string, secondFactor: boolean): Promise<Response>
    {
        return post('/_auth/mfa/passkey/mark', { passkeyId, secondFactor }, session.authorization);
    }

    /** Register a passkey and mark it as the second factor. */
    async function enrolPasskey(session: Session)
    {
        const passkey = await registerPasskey(session);
        expect((await mark(session, passkey.passkeyId, true)).status).toBe(200);

        return passkey;
    }

    /** Re-prove the passkey on this device, opening its step-up window. */
    async function stepUpWithPasskey(session: Session, authenticator: FixtureAuthenticator, counter: number)
    {
        const options = await post('/_auth/mfa/step-up/options', {}, session.authorization);
        const response = await post('/_auth/mfa/step-up', {
            response: authenticator.assert({ challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID, counter }),
        }, session.authorization);

        expect(response.status).toBe(204);
    }

    async function passkeySignIn(authenticator: FixtureAuthenticator, counter: number)
    {
        const keyPair = generateKeyPair('ES256');
        const options = await post('/_auth/passkeys/login/options', {});
        const response = await post('/_auth/passkeys/login/verify', {
            response: authenticator.assert({ challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID, counter }),
            ...deviceKey(keyPair),
        });

        return { response, body: await response.json(), session: signedBy(keyPair) };
    }

    async function expectRefused(response: Response, status: number, code: string, label = ''): Promise<void>
    {
        const text = await response.text();

        expect(response.status, `${label} ${text}`).toBe(status);
        expect(JSON.parse(text), label).toMatchObject({ code });
    }

    function captureLogins(): { secondFactorEnrolmentRequired: boolean }[]
    {
        const payloads: { secondFactorEnrolmentRequired: boolean }[] = [];
        unsubscribers.push(authLoginEvent.subscribe((payload) =>
        {
            payloads.push(payload);
        }));

        return payloads;
    }

    async function liveMarkedPasskeys(): Promise<number>
    {
        const rows = await getTestDb().select().from(passkeys)
            .where(and(eq(passkeys.userId, userId), eq(passkeys.secondFactor, true), isNull(passkeys.revokedAt)));

        return rows.length;
    }

    async function challengeFor(keyId: string)
    {
        const [row] = await getTestDb().select().from(mfaChallenges).where(eq(mfaChallenges.keyId, keyId));

        return row;
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId));

        return row;
    }

    async function unusedRecoveryCodes(): Promise<number>
    {
        const rows = await getTestDb().select().from(mfaRecoveryCodes)
            .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));

        return rows.length;
    }

    /** The account enrolled under the table's policy: a marked passkey, and the session that marked it. */
    async function passkeyEnrolledAccount()
    {
        usePolicy();
        const session = await signIn();
        const passkey = await enrolPasskey(session);

        return { session, ...passkey };
    }

    /**
     * The account as it stood before the policy: a confirmed TOTP and ten
     * recovery codes, enrolled under the defaults. Then the table's policy, and
     * a marked passkey enrolled under it.
     */
    async function accountFromBeforeThePolicy()
    {
        const before = await signIn();
        const totp = await enrolTotp(before);

        usePolicy();
        const session = await signIn();
        const passkey = await enrolPasskey(session);

        return { session, ...totp, ...passkey };
    }

    // ========================================================================
    // Sign-in and session
    // ========================================================================

    it('S1: an unenrolled password sign-in answers 200 with secondFactorEnrolmentRequired, and auth.login carries it', async () =>
    {
        usePolicy();
        const logins = captureLogins();

        const { response, body } = await passwordLogin();

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ mfaRequired: false, secondFactorEnrolmentRequired: true });
        expect(logins).toEqual([expect.objectContaining({ secondFactorEnrolmentRequired: true, mfaEnrolled: false })]);
    });

    it('S2: an unenrolled session is refused 403 on an auth route behind authenticate and on an app route, before the handler', async () =>
    {
        usePolicy();
        const session = await signIn();
        const [before] = await getTestDb().select().from(users).where(eq(users.id, userId));

        await expectRefused(await post('/_auth/keys/list', {}, session.authorization), 403, 'SECOND_FACTOR_ENROLMENT_REQUIRED', 'listKeys');
        await expectRefused(
            await request('PUT', '/_auth/password', session.authorization, { currentPassword: PASSWORD, newPassword: 'AnotherPassword456!' }),
            403,
            'SECOND_FACTOR_ENROLMENT_REQUIRED',
            'changePassword',
        );
        await expectRefused(await request('GET', '/app/whoami', session.authorization), 403, 'SECOND_FACTOR_ENROLMENT_REQUIRED', 'app');

        const [after] = await getTestDb().select().from(users).where(eq(users.id, userId));
        expect(after!.passwordHash).toBe(before!.passwordHash);
        expect(handled).toEqual([]);
    });

    it('S3: an unenrolled session on an optionalAuth route is handled as anonymous', async () =>
    {
        usePolicy();
        const session = await signIn();

        const response = await request('GET', '/app/optional', session.authorization);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ userId: null });
    });

    it('S4: an unenrolled session reaches every enrolment route allowed for [\'passkey\']', async () =>
    {
        usePolicy();
        const session = await signIn();

        const status = await request('GET', '/_auth/mfa/status', session.authorization);
        expect(status.status).toBe(200);
        expect(await status.json()).toEqual({ enrolled: false, methods: [], recoveryCodesRemaining: 0 });

        const authSession = await request('GET', '/_auth/session', session.authorization);
        expect(authSession.status).toBe(200);
        expect(await authSession.json()).toMatchObject({ userId, secondFactorEnrolmentRequired: true });

        const { passkeyId } = await registerPasskey(session);
        const listed = await post('/_auth/passkeys/list', {}, session.authorization);
        expect(listed.status).toBe(200);
        expect(await listed.json()).toEqual({ passkeys: [expect.objectContaining({ passkeyId })] });

        expect((await mark(session, passkeyId, true)).status).toBe(200);
    });

    it('S4: logout reaches an enrolment-only session', async () =>
    {
        usePolicy();
        const session = await signIn();

        expect((await post('/_auth/logout', {}, session.authorization)).status).toBe(204);
        expect((await keyRow(session.keyId))!.isActive).toBe(false);
    });

    it('S5: totp/enroll answers 404 SECOND_FACTOR_METHOD_DISABLED, and no TOTP row is written', async () =>
    {
        usePolicy();
        const session = await signIn();

        const response = await post('/_auth/mfa/totp/enroll', {}, session.authorization);
        const body = await response.json();

        expect(response.status).toBe(404);
        expect(body).toMatchObject({ code: 'SECOND_FACTOR_METHOD_DISABLED', details: { method: 'totp' } });
        expect(await getTestDb().select().from(mfaTotp)).toEqual([]);

        const confirm = await post('/_auth/mfa/totp/confirm', { code: '123456' }, session.authorization);
        expect(confirm.status).toBe(404);
        expect(await confirm.json()).toMatchObject({ details: { method: 'totp' } });
    });

    it('S6: registering and marking a passkey enrols the account, and the same session then passes', async () =>
    {
        usePolicy();
        const session = await signIn();

        await expectRefused(await post('/_auth/keys/list', {}, session.authorization), 403, 'SECOND_FACTOR_ENROLMENT_REQUIRED');

        await enrolPasskey(session);

        expect((await post('/_auth/keys/list', {}, session.authorization)).status).toBe(200);
        expect((await request('GET', '/app/whoami', session.authorization)).status).toBe(200);
        expect(await (await request('GET', '/_auth/session', session.authorization)).json())
            .not.toHaveProperty('secondFactorEnrolmentRequired');
    });

    it('S7: a passkey-enrolled account signing in by password on a new device answers 202 mfaRequired', async () =>
    {
        await passkeyEnrolledAccount();

        const { response, body, session } = await passwordLogin();

        expect(response.status).toBe(202);
        expect(body).toMatchObject({ mfaRequired: true, challenge: { secret: expect.any(String) } });
        expect(body).not.toHaveProperty('userId');
        expect((await keyRow(session.keyId))!.isActive).toBe(false);
    });

    it('S8: S7\'s challenge spent with a passkey assertion answers the session, flag absent', async () =>
    {
        const { authenticator } = await passkeyEnrolledAccount();
        const { body: pending } = await passwordLogin();

        const options = await post('/_auth/mfa/verify/options', { challenge: pending.challenge.secret });
        const verified = await post('/_auth/mfa/verify', {
            challenge: pending.challenge.secret,
            response: authenticator.assert({ challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID, counter: 1 }),
        });
        const body = await verified.json();

        expect(verified.status).toBe(200);
        expect(body).toMatchObject({ mfaRequired: false, userId: String(userId) });
        expect(body).not.toHaveProperty('secondFactorEnrolmentRequired');
    });

    it('S9: a valid TOTP code from before the policy is refused at mfa/verify, counted, and activates nothing', async () =>
    {
        const { secret } = await accountFromBeforeThePolicy();
        const { body: pending, session } = await passwordLogin();

        const response = await post('/_auth/mfa/verify', { challenge: pending.challenge.secret, code: codeFor(secret) });

        expect(response.status).toBe(401);
        expect((await challengeFor(session.keyId))!.attempts).toBe(1);
        expect((await keyRow(session.keyId))!.isActive).toBe(false);
    });

    it('S10: a valid recovery code from before the policy is refused at mfa/verify, counted, not spent, and activates nothing', async () =>
    {
        const { recoveryCodes } = await accountFromBeforeThePolicy();
        const { body: pending, session } = await passwordLogin();
        const unusedBefore = await unusedRecoveryCodes();

        const response = await post('/_auth/mfa/verify', { challenge: pending.challenge.secret, recoveryCode: recoveryCodes[0] });

        expect(response.status).toBe(401);
        expect((await challengeFor(session.keyId))!.attempts).toBe(1);
        expect((await keyRow(session.keyId))!.isActive).toBe(false);
        expect(unusedBefore).toBe(10);
        expect(await unusedRecoveryCodes()).toBe(10);
    });

    it('S11: an account holding only a TOTP from before the policy signs in as S1, and no challenge is opened', async () =>
    {
        await enrolTotp(await signIn());
        usePolicy();

        const { response, body, session } = await passwordLogin();

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ mfaRequired: false, secondFactorEnrolmentRequired: true });
        expect(await challengeFor(session.keyId)).toBeUndefined();
        expect((await keyRow(session.keyId))!.isActive).toBe(true);
    });

    it('S12: a session created before the policy was configured is refused as S2', async () =>
    {
        const session = await signIn();
        expect((await post('/_auth/keys/list', {}, session.authorization)).status).toBe(200);

        usePolicy();

        await expectRefused(await post('/_auth/keys/list', {}, session.authorization), 403, 'SECOND_FACTOR_ENROLMENT_REQUIRED');
        await expectRefused(await request('GET', '/app/whoami', session.authorization), 403, 'SECOND_FACTOR_ENROLMENT_REQUIRED');
    });

    it('S13: an OAuth 2.1 access token acting for an unenrolled person is refused 403', async () =>
    {
        configureTestAuthorizationServer();
        const session = await signIn();
        const clientId = await registerLoopbackClient(app, 'sf309-cli', [TEST_REDIRECT_URI], '203.0.113.90');
        const { verifier, challenge } = pkcePair('sf309');
        const code = await obtainCode(app, session.authorization, { client_id: clientId }, challenge);
        const issued = await postToken(app, {
            grant_type: 'authorization_code',
            code,
            code_verifier: verifier,
            client_id: clientId,
            redirect_uri: TEST_REDIRECT_URI,
            resource: TEST_RESOURCE,
        });
        const accessToken = (await issued.json()).access_token as string;

        expect((await request('GET', '/app/resource', `Bearer ${accessToken}`)).status).toBe(200);
        handled.length = 0;

        usePolicy();

        await expectRefused(await request('GET', '/app/resource', `Bearer ${accessToken}`), 403, 'SECOND_FACTOR_ENROLMENT_REQUIRED');
        await expect(verifyAccessToken(accessToken, TEST_RESOURCE))
            .rejects.toMatchObject({ code: 'SECOND_FACTOR_ENROLMENT_REQUIRED' });
        expect(handled).toEqual([]);
    });

    it('S14: a passkey-enrolled account signs in with its passkey: a session, no challenge', async () =>
    {
        const { authenticator } = await passkeyEnrolledAccount();

        const { response, body, session } = await passkeySignIn(authenticator, 1);

        expect(response.status).toBe(200);
        expect(body).toMatchObject({ mfaRequired: false, userId: String(userId) });
        expect(body).not.toHaveProperty('secondFactorEnrolmentRequired');
        expect(await challengeFor(session.keyId)).toBeUndefined();
        expect((await post('/_auth/keys/list', {}, session.authorization)).status).toBe(200);
    });

    it('S15: under methods [\'totp\'], a passkey sign-in from a new device is challenged', async () =>
    {
        const before = await signIn();
        await enrolTotp(before);
        const { authenticator } = await enrolPasskey(before);
        usePolicy({ required: true, methods: ['totp'] });

        const { response, body, session } = await passkeySignIn(authenticator, 1);

        expect(response.status).toBe(202);
        expect(body).toMatchObject({ mfaRequired: true, challenge: { secret: expect.any(String) } });
        expect((await challengeFor(session.keyId))!.channel).toBe('passkey');
        expect((await keyRow(session.keyId))!.isActive).toBe(false);
        expect((await post('/_auth/keys/list', {}, session.authorization)).status).toBe(401);
    });

    it('S16: an ops-token request works while the policy holds every unenrolled person', async () =>
    {
        usePolicy();
        const { token } = await issueOpsTokenService('sf309-reports', ['reports:read'], null);

        const response = await request('GET', '/app/ops', `Bearer ${token}`);

        expect(response.status).toBe(200);
        expect(handled).toEqual(['ops']);
    });

    it('S17: required: false with methods [\'passkey\'] — an unenrolled account works as today', async () =>
    {
        usePolicy({ required: false, methods: ['passkey'] });

        const { response, body, session } = await passwordLogin();

        expect(response.status).toBe(200);
        expect(body).not.toHaveProperty('secondFactorEnrolmentRequired');
        expect((await post('/_auth/keys/list', {}, session.authorization)).status).toBe(200);
        expect((await request('GET', '/app/whoami', session.authorization)).status).toBe(200);
        expect((await request('GET', '/app/optional', session.authorization)).status).toBe(200);
        expect(handled).toEqual(['whoami', 'optional']);
    });

    it('S18: no secondFactor option — a server-level middleware after auth sees the user on an enrolment, a non-enrolment and an app route', async () =>
    {
        const session = await signIn();
        // And the per-request admission reads no enrolment state at all.
        const admission = vi.spyOn(mfaEnrolmentRepository, 'isEnrolledInOnPrimary');

        await request('GET', '/_auth/mfa/status', session.authorization);
        await post('/_auth/keys/list', {}, session.authorization);
        await request('GET', '/app/whoami', session.authorization);
        await request('GET', '/app/optional', session.authorization);

        expect([seen.get('/_auth/mfa/status'), seen.get('/_auth/keys/list'), seen.get('/app/whoami')])
            .toEqual([String(userId), String(userId), String(userId)]);
        expect(admission).not.toHaveBeenCalled();
        admission.mockRestore();
    });

    it('S19: policy on, unenrolled — the same middleware sees the user on an enrolment route', async () =>
    {
        usePolicy();
        const session = await signIn();

        expect((await request('GET', '/_auth/mfa/status', session.authorization)).status).toBe(200);
        expect((await post('/_auth/passkeys/list', {}, session.authorization)).status).toBe(200);

        expect(seen.get('/_auth/mfa/status')).toBe(String(userId));
        expect(seen.get('/_auth/passkeys/list')).toBe(String(userId));
    });

    // ========================================================================
    // Removal (required: true)
    // ========================================================================

    it('R1: mfa/disable with one marked passkey answers 409, and no mark, TOTP or verification row changes', async () =>
    {
        const { session, authenticator } = await passkeyEnrolledAccount();
        await stepUpWithPasskey(session, authenticator, 1);
        const verificationsBefore = await getTestDb().select().from(mfaVerifications);

        await expectRefused(await post('/_auth/mfa/disable', {}, session.authorization), 409, 'SECOND_FACTOR_REQUIRED');

        expect(await liveMarkedPasskeys()).toBe(1);
        expect(await getTestDb().select().from(mfaTotp)).toEqual([]);
        expect(await getTestDb().select().from(mfaVerifications)).toEqual(verificationsBefore);
    });

    it('R2: unmarking the one marked passkey answers 409, and the mark stays', async () =>
    {
        const { session, authenticator, passkeyId } = await passkeyEnrolledAccount();
        await stepUpWithPasskey(session, authenticator, 1);

        await expectRefused(await mark(session, passkeyId, false), 409, 'SECOND_FACTOR_REQUIRED');

        expect(await liveMarkedPasskeys()).toBe(1);
    });

    it('R3: with two marked passkeys, unmarking one works', async () =>
    {
        const { session, authenticator, passkeyId } = await passkeyEnrolledAccount();
        await stepUpWithPasskey(session, authenticator, 1);
        await enrolPasskey(session);
        await stepUpWithPasskey(session, authenticator, 2);

        expect((await mark(session, passkeyId, false)).status).toBe(200);
        expect(await liveMarkedPasskeys()).toBe(1);
    });

    it('R4: revoking the one marked passkey answers 409, and it is not revoked', async () =>
    {
        const { session, authenticator, passkeyId } = await passkeyEnrolledAccount();
        await stepUpWithPasskey(session, authenticator, 1);

        await expectRefused(await post('/_auth/passkeys/revoke', { passkeyId }, session.authorization), 409, 'SECOND_FACTOR_REQUIRED');

        const [row] = await getTestDb().select().from(passkeys).where(eq(passkeys.id, Number(passkeyId)));
        expect(row!.revokedAt).toBeNull();
    });

    it('R5: disableMfaService called directly works, and the next request is refused as S2', async () =>
    {
        const { session } = await passkeyEnrolledAccount();
        expect((await post('/_auth/keys/list', {}, session.authorization)).status).toBe(200);

        await disableMfaService(userId);

        expect(await liveMarkedPasskeys()).toBe(0);
        await expectRefused(await post('/_auth/keys/list', {}, session.authorization), 403, 'SECOND_FACTOR_ENROLMENT_REQUIRED');
    });

    it('R6: required: false — disable, unmark and revoke of the last marked passkey work as today', async () =>
    {
        usePolicy({ required: false, methods: ['passkey'], recoveryCodes: false });
        const session = await signIn();
        const first = await enrolPasskey(session);
        await stepUpWithPasskey(session, first.authenticator, 1);

        expect((await mark(session, first.passkeyId, false)).status).toBe(200);
        expect(await liveMarkedPasskeys()).toBe(0);

        const second = await enrolPasskey(session);
        await stepUpWithPasskey(session, second.authenticator, 1);
        expect((await post('/_auth/mfa/disable', {}, session.authorization)).status).toBe(204);
        expect(await liveMarkedPasskeys()).toBe(0);

        expect((await mark(session, second.passkeyId, true)).status).toBe(200);
        await stepUpWithPasskey(session, second.authenticator, 2);
        expect((await post('/_auth/passkeys/revoke', { passkeyId: second.passkeyId }, session.authorization)).status).toBe(200);
    });

    it('R7: methods [\'passkey\'] — unmarking the one marked passkey beside a confirmed TOTP answers 409', async () =>
    {
        const { session, authenticator, passkeyId } = await accountFromBeforeThePolicy();
        await stepUpWithPasskey(session, authenticator, 1);

        await expectRefused(await mark(session, passkeyId, false), 409, 'SECOND_FACTOR_REQUIRED');

        expect(await liveMarkedPasskeys()).toBe(1);
    });

    // ========================================================================
    // Recovery codes (recoveryCodes: false)
    // ========================================================================

    it('K1: totp/confirm and the first passkey/mark answer no codes and write no recovery-code row', async () =>
    {
        usePolicy({ required: true, methods: ['totp', 'passkey'], recoveryCodes: false });
        const session = await signIn();

        const { recoveryCodes } = await enrolTotp(session);
        expect(recoveryCodes).toEqual([]);

        const { passkeyId } = await registerPasskey(session);
        const marked = await mark(session, passkeyId, true);
        expect(marked.status).toBe(200);
        expect(await marked.json()).not.toHaveProperty('recoveryCodes');

        expect(await getTestDb().select().from(mfaRecoveryCodes)).toEqual([]);
    });

    it('K2: recovery/regenerate answers 404 SECOND_FACTOR_METHOD_DISABLED, and the generation does not rise', async () =>
    {
        const { session, authenticator } = await accountFromBeforeThePolicy();
        await stepUpWithPasskey(session, authenticator, 1);
        const rowsBefore = await getTestDb().select().from(mfaRecoveryCodes);

        const response = await post('/_auth/mfa/recovery/regenerate', {}, session.authorization);

        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ code: 'SECOND_FACTOR_METHOD_DISABLED', details: { method: 'recoveryCodes' } });
        expect(await getTestDb().select().from(mfaRecoveryCodes)).toEqual(rowsBefore);
    });

    it('K3: mfa/step-up with a valid recovery code from before answers 401, spends nothing, opens no window', async () =>
    {
        const { recoveryCodes, authenticator } = await accountFromBeforeThePolicy();
        // A passkey sign-in: exempt from the challenge, and no window of its own.
        const { session } = await passkeySignIn(authenticator, 1);

        const response = await post('/_auth/mfa/step-up', { recoveryCode: recoveryCodes[0] }, session.authorization);

        expect(response.status).toBe(401);
        expect(await unusedRecoveryCodes()).toBe(10);
        expect(await getTestDb().select().from(mfaVerifications).where(eq(mfaVerifications.keyId, session.keyId))).toEqual([]);
    });

    it('K4: mfa/status reports recoveryCodesRemaining 0 while old rows exist', async () =>
    {
        const { session } = await accountFromBeforeThePolicy();

        const response = await request('GET', '/_auth/mfa/status', session.authorization);

        expect(await response.json()).toEqual({ enrolled: true, methods: ['passkey'], recoveryCodesRemaining: 0 });
        expect(await unusedRecoveryCodes()).toBe(10);
    });

    it('K5: recoveryCodes true with methods [\'passkey\'] — the first passkey/mark answers as it does with no policy', async () =>
    {
        const withoutPolicy = await signIn();
        const reference = await registerPasskey(withoutPolicy);
        const referenceAnswer = await (await mark(withoutPolicy, reference.passkeyId, true)).json();
        const referenceRows = (await getTestDb().select().from(mfaRecoveryCodes)).length;

        await getTestDb().delete(passkeys);
        usePolicy({ required: true, methods: ['passkey'], recoveryCodes: true });
        const session = await signIn();
        const { passkeyId } = await registerPasskey(session);
        const marked = await mark(session, passkeyId, true);

        expect(marked.status).toBe(200);
        expect(await marked.json()).toEqual(referenceAnswer);
        expect((await getTestDb().select().from(mfaRecoveryCodes)).length).toBe(referenceRows);
    });
});
