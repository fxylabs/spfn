/**
 * @spfn/auth - the app's sign-in guard (#361): `createAuthLifecycle({ signIn: { admit, settled } })`
 *
 * Each row names what would go unnoticed without it.
 *
 * 1. a sign-in channel that skips the guard — every channel, read from
 *    `DeviceRegistrationChannelSchema`, plus `mfa/verify` and `deletion/cancel`
 * 2. an app lock signing owners out as their keys expire (rotation, renewal)
 * 3. the refusal as a password oracle, or by its cost an account oracle
 * 4. a limit that is not a limit under concurrent attempts
 * 5. failures lost to a rollback (a route-wide `Transactional()` returning)
 * 6. sign-ins that escape a recorder that failed
 * 7. the second factor: a refusal between the 202 and `mfa/verify`, `succeeded`
 *    reported once, a step-up's typo counted as a sign-in failure
 * 8. the address the app is told: a spoofed `X-Forwarded-For`, or the 202's
 *    address standing in for `mfa/verify`'s
 * 9. `deletion/cancel` as a password oracle for a refused account
 * 10. an app that did not turn the guard on paying for it
 *
 * The app's side is what the README tells an app to write: a repository
 * extending `BaseRepository` whose writes join the package's transaction.
 * Its table lives in a schema of this file's own.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import postgres from 'postgres';
import { and, desc, eq, sql } from 'drizzle-orm';
import { generateKeyPair as generateJoseKeyPair, SignJWT, createRemoteJWKSet } from 'jose';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { enableBinding, FixtureAuthenticator } from '../helpers/webauthn-fixture';
import {
    accountDeletionRequests,
    mfaAttemptBudgets,
    mfaChallenges,
    mfaTotp,
    userInvitations,
    userPublicKeys,
    users,
    verificationCodes,
} from '@/server/entities';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { hashCredential } from '@/server/lib/link-credentials';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { authenticate } from '@/server/middleware/authenticate';
import { authDeviceRegisteredEvent, authLoginEvent, DeviceRegistrationChannelSchema, mfaLockedEvent } from '@/server/events';
import type { SignInAdmission, SignInAttempt, SignInOutcome } from '@/server/lib/sign-in-guard';

// The remote JWKS fetch is the only part of native sign-in that leaves the
// process; everything else about the id_token is verified for real.
vi.mock('jose', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('jose')>();

    return { ...actual, createRemoteJWKSet: vi.fn() };
});

const sendEmail = vi.fn().mockResolvedValue({ success: true });

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: (...args: unknown[]) => sendEmail(...args),
        sendSMS: vi.fn().mockResolvedValue({ success: true }),
    };
});

// Row 3 reads which hash every comparison was made against.
const { verifyPassword } = vi.hoisted(() => ({ verifyPassword: vi.fn() }));

vi.mock('@/server/helpers/password', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@/server/helpers/password')>();
    verifyPassword.mockImplementation(actual.verifyPassword);

    return { ...actual, verifyPassword };
});

const { BaseRepository, getDatabase, getTransactionContext } = await import('@spfn/core/db');
const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { settleLinkMail } = await import('@/server/lib/link-mail-delivery');
const { configureSignIn, resetSignInGuardForTests } = await import('@/server/lib/sign-in-guard');
const { getDummyPasswordHash, hashPassword } = await import('@/server/helpers/password');
const { registerOAuthProvider } = await import('@/server/lib/oauth');
const { createOAuthState, generateOAuthNonce } = await import('@/server/lib/oauth/state');
const { oauthCallbackService } = await import('@/server/services/oauth.service');
const { oauthNativeService } = await import('@/server/services/oauth-native.service');
const { requestAccountDeletionService } = await import('@/server/services/account-deletion.service');
const { SignInRefusedError } = await import('@spfn/auth/errors');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const CLIENT_TYPE_HEADER = 'x-test-client-type';
const ATTESTED_IP_HEADER = 'x-spfn-proxy-client-ip';
const PASSWORD = 'SecurePassword123!';
const WRONG_PASSWORD = 'NotThePassword123!';
const NEW_PASSWORD = 'BrandNewPassword456!';
const GOOGLE_ISS = 'https://accounts.google.com';
const NATIVE_CLIENT_ID = 'ios.example.com';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const LOCKED = { refuse: { code: 'LOCKED' } };

/** One row of the app's sign-in history, as the app's repository stores it. */
interface HistoryRow
{
    user_id: number | null;
    channel: string;
    stage: string;
    result: string;
    reason: string | null;
    key_id: string | null;
    ip: string | null;
    web_proxy: boolean;
}

/** The app's repository: its writes join whatever transaction the package holds. */
class SignInHistoryRepository extends BaseRepository
{
    async record(outcome: SignInOutcome): Promise<void>
    {
        await this.db.execute(sql`insert into sign_in_guard_test.history
            (user_id, channel, stage, result, reason, key_id, ip, web_proxy)
            values (${outcome.user?.id ?? null}, ${outcome.channel}, ${outcome.stage}, ${outcome.result},
                ${outcome.result === 'failed' ? outcome.reason : null}, ${outcome.keyId ?? null},
                ${outcome.ip ?? null}, ${outcome.webProxy})`);
    }

    /** Wrong passwords recorded against the account: the policy's "after five". */
    async credentialFailures(userId: number): Promise<number>
    {
        const [row] = await this.db.execute<{ count: number }>(sql`select count(*)::int as count
            from sign_in_guard_test.history where user_id = ${userId} and result = 'failed' and reason = 'credential'`);

        return row!.count;
    }
}

const history = new SignInHistoryRepository();

/** What the guard does in the current row; the guard itself is stated once per row. */
const policy: {
    admit: (attempt: SignInAttempt) => Promise<SignInAdmission>;
    settled: (outcome: SignInOutcome) => Promise<void>;
} = {
    admit: async () => undefined,
    settled: outcome => history.record(outcome),
};

const guard = {
    admit: (attempt: SignInAttempt) => policy.admit(attempt),
    settled: (outcome: SignInOutcome) => policy.settled(outcome),
};

/** The app's policy: refuse after five recorded wrong passwords. */
async function lockAfterFive(attempt: SignInAttempt): Promise<SignInAdmission>
{
    return attempt.user && await history.credentialFailures(attempt.user.id) >= 5 ? LOCKED : undefined;
}

function deferred(): { promise: Promise<void>; resolve: () => void }
{
    let resolve!: () => void;
    const promise = new Promise<void>((settle) =>
    {
        resolve = settle;
    });

    return { promise, resolve };
}

/** Released once `count` callers have arrived. */
function barrier(count: number): { arrive: () => void; passed: Promise<void> }
{
    const all = deferred();
    let arrived = 0;

    return {
        arrive: () =>
        {
            arrived += 1;

            if (arrived === count)
            {
                all.resolve();
            }
        },
        passed: all.promise,
    };
}

describe.skipIf(!dbAvailable)('the sign-in guard (#361)', () =>
{
    let app: Hono;
    let observer: ReturnType<typeof postgres>;
    let jwksPrivateKey: CryptoKey;
    let testIndex = 0;
    let clientIp: string;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';
        process.env.SPFN_APP_URL = 'https://app.example.com';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = `v1:${Buffer.alloc(32, 7).toString('base64')}`;

        // `clientType` is what proxy-guard sets on a request it verified as the
        // Next.js proxy's; the header stands in for that verdict.
        app = new Hono();
        app.use('*', async (c, next) =>
        {
            const declared = c.req.header(CLIENT_TYPE_HEADER);

            if (declared)
            {
                c.set('clientType', declared);
            }

            await next();
        });
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());

        await getTestDb().execute(sql`drop schema if exists sign_in_guard_test cascade`);
        await getTestDb().execute(sql`create schema sign_in_guard_test`);
        await getTestDb().execute(sql`create table sign_in_guard_test.history (
            id serial primary key, user_id bigint, channel text not null, stage text not null, result text not null,
            reason text, key_id text, ip text, web_proxy boolean not null)`);

        // `setupTestDb` points DATABASE_URL at the test database.
        observer = postgres(process.env.DATABASE_URL!, { max: 1 });
        await observer`select 1`;
    });

    afterAll(async () =>
    {
        resetSignInGuardForTests();
        await observer.end();
        await getTestDb().execute(sql`drop schema if exists sign_in_guard_test cascade`);
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await getTestDb().execute(sql`truncate sign_in_guard_test.history`);
        resetMemoryRateLimitStore();
        await initializeAuth();
        sendEmail.mockClear();
        verifyPassword.mockClear();

        testIndex += 1;
        clientIp = `198.51.102.${testIndex & 0xff}`;

        policy.admit = async () => undefined;
        policy.settled = outcome => history.record(outcome);
        resetSignInGuardForTests();
        configureSignIn(guard);

        const pair = await generateJoseKeyPair('RS256');
        jwksPrivateKey = pair.privateKey;
        vi.mocked(createRemoteJWKSet).mockReturnValue((async () => pair.publicKey) as never);
        vi.stubEnv('SPFN_AUTH_GOOGLE_NATIVE_CLIENT_IDS', NATIVE_CLIENT_ID);
    });

    afterEach(() =>
    {
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    interface RequestOptions
    {
        authorization?: string;
        userAgent?: string;
        /** Through the trusted proxy, which attests this address. */
        attestedIp?: string;
        forwardedFor?: string;
    }

    async function post(path: string, body: unknown, options: RequestOptions = {}): Promise<Response>
    {
        const headers: Record<string, string> = {
            ...JSON_HEADERS,
            'x-forwarded-for': options.forwardedFor ?? clientIp,
            'user-agent': options.userAgent ?? 'SignInGuardSuite/1.0',
        };

        if (options.authorization)
        {
            headers.Authorization = options.authorization;
        }

        if (options.attestedIp)
        {
            headers[CLIENT_TYPE_HEADER] = 'web';
            headers[ATTESTED_IP_HEADER] = options.attestedIp;
        }

        const response = await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
        await settleLinkMail();

        return response;
    }

    function deviceKeyBody()
    {
        const key = generateKeyPair('ES256');

        return { publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm };
    }

    async function seedUser(email: string, roleName = 'user')
    {
        const role = await getRoleByName(roleName);
        const [row] = await getTestDb().insert(users).values({
            email,
            passwordHash: await hashPassword(PASSWORD),
            emailVerifiedAt: new Date(),
            roleId: role!.id,
        }).returning();

        return row!;
    }

    function login(email: string, password: string, options: RequestOptions = {}, key = deviceKeyBody())
    {
        return post('/_auth/login', { email, password, ...key }, options);
    }

    /** A password sign-in that has to succeed, and the session it holds. */
    async function signIn(email: string, options: RequestOptions = {})
    {
        const key = generateKeyPair('ES256');
        const response = await login(email, PASSWORD, options, {
            publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm,
        });

        expect(response.status).toBe(200);

        return {
            key,
            authorization: `Bearer ${generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' })}`,
        };
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId)).limit(1);

        return row;
    }

    async function userByEmail(email: string)
    {
        const [row] = await getTestDb().select().from(users).where(eq(users.email, email)).limit(1);

        return row;
    }

    /** The app's history, read from a connection of its own: only what committed. */
    async function committedHistory(): Promise<HistoryRow[]>
    {
        return await observer<HistoryRow[]>`select user_id::int as user_id, channel, stage, result, reason, key_id, ip, web_proxy
            from sign_in_guard_test.history order by id`;
    }

    /** The token from the most recent mail of a template. */
    function emailedToken(template: string): string
    {
        const sent = sendEmail.mock.calls.filter(([arg]) => arg?.template === template);
        const call = sent[sent.length - 1];

        if (!call)
        {
            throw new Error(`no ${template} email was sent`);
        }

        return new URL(call[0].data.confirmUrl).searchParams.get('token')!;
    }

    /** @returns the body without the envelope's per-request id, for comparing two answers */
    async function expectRefused(response: Response): Promise<unknown>
    {
        const { error: { requestId: _requestId, ...envelope }, ...body } = await response.json();

        expect(response.status).toBe(403);
        expect(envelope).toMatchObject({ code: 'SignInRefusedError' });
        expect(body).toMatchObject({ details: { code: 'LOCKED' } });

        return { ...body, error: envelope };
    }

    async function expectRefusedService(run: Promise<unknown>): Promise<void>
    {
        const error = await run.then(() => null, (thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(SignInRefusedError);
        expect((error as InstanceType<typeof SignInRefusedError>).details).toMatchObject({ code: 'LOCKED' });
    }

    function refuseEveryone(): void
    {
        policy.admit = async () => LOCKED;
    }

    function codeFor(secret: string): string
    {
        return hotp(decodeBase32(secret), totpStep(Date.now()));
    }

    /** Enrol TOTP on `email`; the confirmation's step is forgotten so the next code is spendable. */
    async function enrolTotp(email: string): Promise<{ secret: string; authorization: string }>
    {
        const { authorization } = await signIn(email);
        const secret = (await (await post('/_auth/mfa/totp/enroll', {}, { authorization })).json()).secret as string;

        expect((await post('/_auth/mfa/totp/confirm', { code: codeFor(secret) }, { authorization })).status).toBe(200);
        await forgetUsedStep();

        return { secret, authorization };
    }

    async function forgetUsedStep(): Promise<void>
    {
        await getTestDb().update(mfaTotp).set({ lastUsedStep: null });
    }

    /** A sign-in from a new device of an enrolled account: the 202's challenge and key. */
    async function openChallenge(email: string, options: RequestOptions = {})
    {
        const key = deviceKeyBody();
        const response = await login(email, PASSWORD, options, key);

        expect(response.status).toBe(202);

        return { challenge: (await response.json()).challenge.secret as string, keyId: key.keyId };
    }

    async function challengeRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(mfaChallenges).where(eq(mfaChallenges.keyId, keyId));

        return row;
    }

    function capture<TPayload>(event: { subscribe: (handler: (payload: TPayload) => void) => () => void }): { seen: TPayload[]; stop: () => void }
    {
        const seen: TPayload[] = [];

        return { seen, stop: event.subscribe(payload => void seen.push(payload)) };
    }

    function afterCommitCallbacks(): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, 40));
    }

    // ========================================================================
    // Row 1 — every sign-in channel goes through the guard
    // ========================================================================

    /**
     * Each driver sets its channel up with the guard admitting, then refuses
     * everyone and makes the attempt: the answer has to be the app's refusal,
     * and the key it presented must not be usable.
     */
    const CHANNEL_DRIVERS: Record<string, () => Promise<void>> = {
        register: async () =>
        {
            const email = 'register@test.com';
            await post('/_auth/codes', { target: email, targetType: 'email', purpose: 'registration' });
            const [code] = await getTestDb().select().from(verificationCodes)
                .where(and(eq(verificationCodes.target, email), eq(verificationCodes.purpose, 'registration')))
                .orderBy(desc(verificationCodes.createdAt)).limit(1);
            const verified = await post('/_auth/codes/verify', { target: email, targetType: 'email', code: code!.code, purpose: 'registration' });
            const { verificationToken } = await verified.json();
            const key = deviceKeyBody();

            refuseEveryone();
            await expectRefused(await post('/_auth/register', { email, verificationToken, password: PASSWORD, ...key }));

            expect(await keyRow(key.keyId)).toBeUndefined();
            expect(await userByEmail(email)).toBeUndefined();
        },
        'signup-link': async () =>
        {
            const email = 'signup@test.com';
            expect((await post('/_auth/signup/email', { email })).status).toBe(200);
            const { setupSecret } = await (await post('/_auth/signup/email/confirm', { token: emailedToken('signup-link') })).json();
            const key = deviceKeyBody();

            refuseEveryone();
            await expectRefused(await post('/_auth/signup/password', { setupSecret, password: PASSWORD, ...key }));

            expect(await keyRow(key.keyId)).toBeUndefined();
            expect(await userByEmail(email)).toBeUndefined();
        },
        invitation: async () =>
        {
            const inviter = await seedUser('inviter@test.com', 'admin');
            const userRole = await getRoleByName('user');
            const token = '33333333-3333-4333-8333-333333333333';
            await getTestDb().insert(userInvitations).values({
                email: 'invited@test.com',
                tokenHash: hashCredential(token),
                roleId: userRole!.id,
                invitedBy: inviter.id,
                status: 'pending',
                expiresAt: new Date(Date.now() + 86_400_000),
            });
            const key = deviceKeyBody();

            refuseEveryone();
            await expectRefused(await post('/_auth/invitations/accept', { token, password: PASSWORD, ...key }));

            expect(await keyRow(key.keyId)).toBeUndefined();
            expect(await userByEmail('invited@test.com')).toBeUndefined();
        },
        password: async () =>
        {
            await seedUser('password@test.com');
            const key = deviceKeyBody();

            refuseEveryone();
            await expectRefused(await login('password@test.com', PASSWORD, {}, key));

            expect(await keyRow(key.keyId)).toBeUndefined();
        },
        oauth: async () =>
        {
            registerOAuthProvider({
                id: 'superself',
                isEnabled: () => true,
                pkce: 'S256',
                getAuthUrl: (state: string) => `https://mock.example.com/auth?state=${state}`,
                exchangeCodeForTokens: async () => ({ accessToken: 'a', refreshToken: 'r', expiresIn: 3600 }),
                getUserInfo: async () => ({ providerUserId: 'oauth-guard-1', email: 'oauth@test.com', emailVerified: true }),
            });
            const key = generateKeyPair('ES256');
            const nonce = generateOAuthNonce();
            const state = await createOAuthState({
                provider: 'superself', returnUrl: '/', publicKey: key.publicKey, keyId: key.keyId,
                fingerprint: key.fingerprint, algorithm: 'ES256', nonce,
            });

            refuseEveryone();
            await expectRefusedService(oauthCallbackService({ provider: 'superself', code: 'c', state, expectedNonce: [nonce], ip: clientIp }));

            expect(await keyRow(key.keyId)).toBeUndefined();
        },
        'oauth-native': async () =>
        {
            const key = generateKeyPair('ES256');
            const idToken = await new SignJWT({ email: 'native@test.com', email_verified: true, nonce: key.fingerprint })
                .setProtectedHeader({ alg: 'RS256' }).setIssuer(GOOGLE_ISS).setAudience(NATIVE_CLIENT_ID)
                .setSubject('native-guard-1').setIssuedAt().setExpirationTime('5m').sign(jwksPrivateKey);

            refuseEveryone();
            await expectRefusedService(oauthNativeService({
                provider: 'google', idToken, nonce: key.fingerprint, publicKey: key.publicKey, keyId: key.keyId,
                fingerprint: key.fingerprint, algorithm: 'ES256', ip: clientIp,
            }));

            expect(await keyRow(key.keyId)).toBeUndefined();
        },
        'device-code': async () =>
        {
            await seedUser('device@test.com');
            const { authorization } = await signIn('device@test.com');
            const device = deviceKeyBody();
            const { deviceCode, userCode } = await (await post('/_auth/device/start', device)).json();
            expect((await post('/_auth/device/approve', { userCode }, { authorization })).status).toBe(200);

            refuseEveryone();
            await expectRefused(await post('/_auth/device/poll', { deviceCode }));

            expect(await keyRow(device.keyId)).toBeUndefined();
        },
        'device-link': async () =>
        {
            await seedUser('link@test.com');
            const { authorization } = await signIn('link@test.com');
            const { linkId, userCode } = await (await post('/_auth/device/link/issue', {}, { authorization })).json();
            const device = deviceKeyBody();
            const { deviceCode, matchNumber } = await (await post('/_auth/device/link/redeem', { userCode, ...device })).json();
            expect((await post('/_auth/device/link/confirm', { linkId, choice: matchNumber }, { authorization })).status).toBe(200);

            refuseEveryone();
            await expectRefused(await post('/_auth/device/link/poll', { deviceCode }));

            expect(await keyRow(device.keyId)).toBeUndefined();
        },
        'password-reset': async () =>
        {
            await seedUser('reset@test.com');
            expect((await post('/_auth/password/reset', { email: 'reset@test.com' })).status).toBe(200);
            const { setupSecret } = await (await post('/_auth/password/reset/confirm', { token: emailedToken('password-reset') })).json();
            const key = deviceKeyBody();

            refuseEveryone();
            await expectRefused(await post('/_auth/password/reset/complete', { setupSecret, password: NEW_PASSWORD, ...key }));

            expect(await keyRow(key.keyId)).toBeUndefined();
        },
        passkey: async () =>
        {
            await seedUser('passkey@test.com');
            const { authorization } = await signIn('passkey@test.com');
            const authenticator = await FixtureAuthenticator.create();
            const registration = (await (await post('/_auth/passkeys/register/options', {}, { authorization })).json()).challenge;
            expect((await post('/_auth/passkeys/register/verify', {
                response: authenticator.attest({ challenge: registration, origin: ORIGIN, rpId: RP_ID }),
            }, { authorization })).status).toBe(200);
            const challenge = (await (await post('/_auth/passkeys/login/options', {})).json()).challenge;
            const key = deviceKeyBody();

            refuseEveryone();
            await expectRefused(await post('/_auth/passkeys/login/verify', {
                response: authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: 1 }),
                ...key,
            }));

            expect(await keyRow(key.keyId)).toBeUndefined();
        },
        'mfa-verify': async () =>
        {
            await seedUser('second@test.com');
            const { secret } = await enrolTotp('second@test.com');
            const { challenge, keyId } = await openChallenge('second@test.com');

            refuseEveryone();
            await expectRefused(await post('/_auth/mfa/verify', { challenge, code: codeFor(secret) }));

            expect((await keyRow(keyId))!.isActive).toBe(false);
        },
        'deletion-cancel': async () =>
        {
            const owner = await seedUser('cancel@test.com');
            await requestAccountDeletionService(owner.id, { requestedBy: 'admin' });

            refuseEveryone();
            await expectRefused(await post('/_auth/deletion/cancel', { email: 'cancel@test.com', password: PASSWORD }));

            expect((await userByEmail('cancel@test.com'))!.deletion).toBe('pending');
        },
    };

    /** Read from the schema the key service's `channel` is typed by, so a new channel without a driver fails. */
    const SIGN_IN_DOORS = [
        ...DeviceRegistrationChannelSchema.anyOf.map(literal => literal.const as string).filter(channel => channel !== 'renewal'),
        'mfa-verify',
        'deletion-cancel',
    ];

    it.each(SIGN_IN_DOORS)('row 1 — %s: a refusing admit answers SignInRefusedError and leaves no usable key', async (door) =>
    {
        const drive = CHANNEL_DRIVERS[door];

        expect(drive, `no driver for sign-in channel ${door}; add one to CHANNEL_DRIVERS`).toBeDefined();

        await drive!();
    });

    it.each([
        ['{}', {}],
        ['{ refuse: {} }', { refuse: {} }],
        ['an empty code', { refuse: { code: '' } }],
        ['a code of 65 characters', { refuse: { code: 'L'.repeat(65) } }],
        ['a message as the code', { refuse: { code: 'Locked until 2026-11-21 for user@example.com' } }],
    ])('row 1b — admit answers %s: 500, no session, nothing of the answer in the body', async (_name, answer) =>
    {
        await seedUser('malformed@test.com');
        policy.admit = async () => answer as SignInAdmission;
        const key = deviceKeyBody();

        const response = await login('malformed@test.com', PASSWORD, {}, key);

        expect(response.status).toBe(500);
        expect(await response.text()).not.toMatch(/LLLL|user@example\.com/);
        expect(await keyRow(key.keyId)).toBeUndefined();
    });

    // ========================================================================
    // Row 2 — rotation and renewal are not sign-ins
    // ========================================================================

    it('row 2 — a refusing admit leaves keys/rotate and session/renew working, and is never asked', async () =>
    {
        await seedUser('owner@test.com');
        const session = await signIn('owner@test.com', { attestedIp: '192.0.2.20' });
        const authenticator = await FixtureAuthenticator.create();
        const options = (await (await post('/_auth/passkeys/register/options', {}, { authorization: session.authorization, attestedIp: '192.0.2.20' })).json()).challenge;
        expect((await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({ challenge: options, origin: ORIGIN, rpId: RP_ID }),
        }, { authorization: session.authorization, attestedIp: '192.0.2.20' })).status).toBe(200);
        expect((await enableBinding(
            (path, body) => post(path, body, { authorization: session.authorization, attestedIp: '192.0.2.20' }),
            authenticator,
            { origin: ORIGIN, rpId: RP_ID },
        )).status).toBe(200);

        const asked: SignInAttempt[] = [];
        policy.admit = async (attempt) =>
        {
            asked.push(attempt);

            return LOCKED;
        };

        const renewed = generateKeyPair('ES256');
        const renewChallenge = (await (await post('/_auth/session/renew/options', {}, { authorization: session.authorization, attestedIp: '192.0.2.20' })).json()).challenge;
        const renewal = await post('/_auth/session/renew/verify', {
            response: authenticator.assert({ challenge: renewChallenge, origin: ORIGIN, rpId: RP_ID, counter: 2 }),
            publicKey: renewed.publicKey, keyId: renewed.keyId, fingerprint: renewed.fingerprint, algorithm: renewed.algorithm,
        }, { authorization: session.authorization, attestedIp: '192.0.2.20' });

        expect(renewal.status).toBe(200);
        expect((await keyRow(renewed.keyId))!.isActive).toBe(true);

        const rotated = generateKeyPair('ES256');
        const renewedAuthorization = `Bearer ${generateClientToken({ keyId: renewed.keyId }, renewed.privateKey, 'ES256', { expiresIn: '5m' })}`;
        const rotation = await post('/_auth/keys/rotate', {
            publicKey: rotated.publicKey, keyId: rotated.keyId, fingerprint: rotated.fingerprint, algorithm: rotated.algorithm,
        }, { authorization: renewedAuthorization, attestedIp: '192.0.2.20' });

        expect(rotation.status).toBe(200);
        expect((await keyRow(rotated.keyId))!.isActive).toBe(true);
        expect(asked).toEqual([]);
        expect((await committedHistory()).filter(row => row.key_id === renewed.keyId || row.key_id === rotated.keyId)).toEqual([]);
    });

    // ========================================================================
    // Row 3 — the refusal is neither a password nor an account oracle
    // ========================================================================

    it('row 3 — a refused account: right and wrong password answer alike, only the dummy hash is compared, as for an unknown identifier', async () =>
    {
        const owner = await seedUser('refused@test.com');
        policy.admit = async attempt => attempt.user?.id === owner.id ? LOCKED : undefined;
        const takeCalls = () =>
        {
            const calls = [...verifyPassword.mock.calls];
            verifyPassword.mockClear();

            return calls;
        };
        const dummy = await getDummyPasswordHash();

        const right = await login('refused@test.com', PASSWORD);
        const rightBody = await expectRefused(right);
        const rightCalls = takeCalls();

        const wrong = await login('refused@test.com', WRONG_PASSWORD);
        const wrongBody = await expectRefused(wrong);
        const wrongCalls = takeCalls();

        const unknown = await login('nobody@test.com', PASSWORD);
        expect(unknown.status).toBe(401);
        const unknownCalls = takeCalls();

        expect(wrongBody).toEqual(rightBody);
        expect(rightCalls.map(([, hash]) => hash)).toEqual([dummy]);
        expect(wrongCalls.map(([, hash]) => hash)).toEqual([dummy]);
        expect(unknownCalls.map(([, hash]) => hash)).toEqual([dummy]);
    });

    // ========================================================================
    // Row 4 — five is five for a sign-in that would get in
    // ========================================================================

    it('row 4 — "refuse after five": concurrent wrong attempts and a right one, held by gates — every failure recorded, no session after the fifth', async () =>
    {
        const owner = await seedUser('limit@test.com');

        for (let failure = 1; failure <= 4; failure++)
        {
            expect((await login('limit@test.com', WRONG_PASSWORD, { forwardedFor: `192.0.2.${failure}` })).status).toBe(401);
        }
        resetMemoryRateLimitStore();

        // Four requests: three wrong passwords and the right one. Each takes
        // its first admit — four failures recorded, so admitted — and none goes
        // on until all four have. The right one then waits until a wrong one has
        // written the fifth failure, under the account lock, not yet committed:
        // it reaches the lock behind it, and its deciding admit sees five.
        const contenders = ['wrong-a', 'wrong-b', 'wrong-c', 'right'];
        const firstAdmits = barrier(contenders.length);
        const fifthWritten = deferred();

        policy.admit = async (attempt) =>
        {
            const decision = await lockAfterFive(attempt);

            if (!getTransactionContext())
            {
                firstAdmits.arrive();
                await firstAdmits.passed;

                if (attempt.userAgent === 'right')
                {
                    await fifthWritten.promise;
                }
            }

            return decision;
        };
        policy.settled = async (outcome) =>
        {
            await history.record(outcome);

            if (outcome.result === 'failed' && await history.credentialFailures(owner.id) === 5)
            {
                fifthWritten.resolve();
            }
        };

        const rightKey = deviceKeyBody();
        const answers = await Promise.all(contenders.map((name, index) => login(
            'limit@test.com',
            name === 'right' ? PASSWORD : WRONG_PASSWORD,
            { userAgent: name, forwardedFor: `192.0.2.${10 + index}` },
            name === 'right' ? rightKey : deviceKeyBody(),
        )));

        for (const answer of answers)
        {
            await expectRefused(answer);
        }

        expect(await keyRow(rightKey.keyId)).toBeUndefined();
        const failures = (await committedHistory()).filter(row => row.result === 'failed');
        expect(failures.filter(row => row.reason === 'credential')).toHaveLength(7);
        expect((await committedHistory()).filter(row => row.result === 'succeeded')).toEqual([]);

        // Afterwards the right password is refused before it is compared.
        await expectRefused(await login('limit@test.com', PASSWORD, { forwardedFor: '192.0.2.30' }));
        expect(await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.userId, owner.id))).toEqual([]);
    });

    // ========================================================================
    // Row 5 — a failure survives its 401
    // ========================================================================

    it('row 5 — a wrong password: the app\'s record is committed and readable from another connection, and the answer is 401', async () =>
    {
        const owner = await seedUser('failure@test.com');
        const key = deviceKeyBody();

        const answer = await login('failure@test.com', WRONG_PASSWORD, {}, key);

        expect(answer.status).toBe(401);
        expect(await committedHistory()).toMatchObject([
            { user_id: owner.id, channel: 'password', stage: 'credential', result: 'failed', reason: 'credential', key_id: key.keyId },
        ]);
    });

    // ========================================================================
    // Row 6 — a recorder that throws stops the sign-in
    // ========================================================================

    it('row 6 — settled throws on a success: 500, the key is not live, no auth.login', async () =>
    {
        await seedUser('recorder@test.com');
        policy.settled = async (outcome) =>
        {
            if (outcome.result === 'succeeded')
            {
                throw new Error('the history store is down');
            }
        };
        const logins = capture(authLoginEvent);
        const key = deviceKeyBody();

        const answer = await login('recorder@test.com', PASSWORD, {}, key);
        await afterCommitCallbacks();
        logins.stop();

        expect(answer.status).toBe(500);
        expect(await keyRow(key.keyId)).toBeUndefined();
        expect(logins.seen).toEqual([]);
    });

    it('row 6b — settled throws on every failure at mfa/verify: the budget is still spent and locked, announced once, and the right code is refused', async () =>
    {
        const owner = await seedUser('budget@test.com');
        const { secret } = await enrolTotp('budget@test.com');
        const { challenge, keyId } = await openChallenge('budget@test.com');
        const locks = capture(mfaLockedEvent);
        policy.settled = async (outcome) =>
        {
            if (outcome.result === 'failed')
            {
                throw new Error('the history store is down');
            }

            await history.record(outcome);
        };

        for (let guess = 0; guess < 20; guess++)
        {
            resetMemoryRateLimitStore();
            expect((await post('/_auth/mfa/verify', { challenge, code: String(100000 + guess) })).status).toBe(500);
        }
        resetMemoryRateLimitStore();
        const right = await post('/_auth/mfa/verify', { challenge, code: codeFor(secret) });
        await afterCommitCallbacks();
        locks.stop();

        const [budget] = await getTestDb().select().from(mfaAttemptBudgets).where(eq(mfaAttemptBudgets.userId, owner.id));
        expect(budget?.lockedUntil).toBeTruthy();
        expect(right.status).toBe(500);
        expect((await keyRow(keyId))!.isActive).toBe(false);
        expect(locks.seen).toHaveLength(1);
    });

    // ========================================================================
    // Row 7 — the second factor
    // ========================================================================

    it('row 7a — refused between the 202 and mfa/verify: the refusal, the challenge unspent, nothing announced; let in again, the same challenge verifies', async () =>
    {
        await seedUser('between@test.com');
        const { secret } = await enrolTotp('between@test.com');
        const { challenge, keyId } = await openChallenge('between@test.com');
        const logins = capture(authLoginEvent);
        const devices = capture(authDeviceRegisteredEvent);

        refuseEveryone();
        await expectRefused(await post('/_auth/mfa/verify', { challenge, code: codeFor(secret) }));
        await afterCommitCallbacks();

        expect((await challengeRow(keyId))!.verifiedAt).toBeNull();
        expect((await keyRow(keyId))!.isActive).toBe(false);
        expect(logins.seen).toEqual([]);
        expect(devices.seen).toEqual([]);

        policy.admit = async () => undefined;
        const verified = await post('/_auth/mfa/verify', { challenge, code: codeFor(secret) });
        await afterCommitCallbacks();
        logins.stop();
        devices.stop();

        expect(verified.status).toBe(200);
        expect(logins.seen).toHaveLength(1);
    });

    it('row 7b — challenged at the 202, succeeded once at verification; a wrong verify proof is reported, a wrong step-up proof is not', async () =>
    {
        await seedUser('second@test.com');
        const { secret, authorization } = await enrolTotp('second@test.com');
        await getTestDb().execute(sql`truncate sign_in_guard_test.history`);

        const { challenge, keyId } = await openChallenge('second@test.com');
        expect(await committedHistory()).toMatchObject([{ result: 'challenged', stage: 'credential', key_id: keyId }]);

        expect((await post('/_auth/mfa/verify', { challenge, code: '000000' })).status).toBe(401);
        expect((await post('/_auth/mfa/step-up', { code: '000000' }, { authorization })).status).toBe(401);
        expect((await post('/_auth/mfa/verify', { challenge, code: codeFor(secret) })).status).toBe(200);

        expect(await committedHistory()).toMatchObject([
            { result: 'challenged', stage: 'credential', key_id: keyId },
            { result: 'failed', reason: 'secondFactor', stage: 'second-factor', channel: 'password', key_id: keyId },
            { result: 'succeeded', stage: 'second-factor', channel: 'password', key_id: keyId },
        ]);
        expect(await committedHistory()).toHaveLength(3);
    });

    // ========================================================================
    // Row 8 — the address the app is told
    // ========================================================================

    it('row 8 — behind the proxy the attested address reaches settled and a spoofed X-Forwarded-For does not; mfa/verify reports its own', async () =>
    {
        await seedUser('address@test.com');
        const { secret } = await enrolTotp('address@test.com');
        await getTestDb().execute(sql`truncate sign_in_guard_test.history`);

        const { challenge } = await openChallenge('address@test.com', { attestedIp: '192.0.2.40', forwardedFor: '203.0.113.66' });
        expect((await post('/_auth/mfa/verify', { challenge, code: codeFor(secret) }, { attestedIp: '192.0.2.41', forwardedFor: '203.0.113.67' })).status).toBe(200);

        expect(await committedHistory()).toMatchObject([
            { result: 'challenged', ip: '192.0.2.40', web_proxy: true },
            { result: 'succeeded', ip: '192.0.2.41', web_proxy: true },
        ]);
    });

    // ========================================================================
    // Row 9 — deletion/cancel on a refused account
    // ========================================================================

    it('row 9 — deletion/cancel on a refused account answers the refusal alike for the right and a wrong password, and cancels nothing', async () =>
    {
        const owner = await seedUser('cancel@test.com');
        await requestAccountDeletionService(owner.id, { requestedBy: 'admin' });
        refuseEveryone();

        const right = await expectRefused(await post('/_auth/deletion/cancel', { email: 'cancel@test.com', password: PASSWORD }));
        const wrong = await expectRefused(await post('/_auth/deletion/cancel', { email: 'cancel@test.com', password: WRONG_PASSWORD }));

        expect(wrong).toEqual(right);
        expect((await userByEmail('cancel@test.com'))!.deletion).toBe('pending');
        expect((await getTestDb().select().from(accountDeletionRequests))[0]!.status).toBe('pending');
    });

    // ========================================================================
    // Row 10 — no option, no cost
    // ========================================================================

    /** What one request sent to the database, by kind. */
    async function statementsOf(request: () => Promise<Response>): Promise<{ status: number; data: number; locks: number; begins: number; savepoints: number }>
    {
        const client = (getDatabase() as unknown as { $client: { options: { debug: unknown } } }).$client;
        const seen: string[] = [];
        const original = client.options.debug;
        client.options.debug = (_connection: number, query: string) => void seen.push(query.trim().toLowerCase());

        const response = await request().finally(() =>
        {
            client.options.debug = original;
        });
        const control = /^(begin|commit|rollback|savepoint|release|set local)/;

        return {
            status: response.status,
            data: seen.filter(query => !control.test(query)).length,
            locks: seen.filter(query => query.includes('for no key update')).length,
            begins: seen.filter(query => query.startsWith('begin')).length,
            savepoints: seen.filter(query => query.startsWith('savepoint')).length,
        };
    }

    it('row 10 — without the option a failed and a successful /login send what main sends: no extra query, lock or transaction', async () =>
    {
        resetSignInGuardForTests();
        await seedUser('plain@test.com');

        // Measured on main (dda2e1f4) with the same counter. A failure there
        // also ran inside the route's transaction (begin … rollback), which
        // the route no longer opens: one transaction fewer, nothing more.
        expect(await statementsOf(() => login('plain@test.com', WRONG_PASSWORD)))
            .toEqual({ status: 401, data: 1, locks: 0, begins: 0, savepoints: 0 });
        expect(await statementsOf(() => login('plain@test.com', PASSWORD)))
            .toEqual({ status: 200, data: 10, locks: 1, begins: 1, savepoints: 1 });
        expect(await committedHistory()).toEqual([]);
    });
});
