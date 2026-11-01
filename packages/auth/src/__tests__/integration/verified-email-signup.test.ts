/**
 * @spfn/auth - Verified-Email Signup Integration Tests
 *
 * Real HTTP requests against the mounted auth router, one test per cell of the
 * case table in the feature's design (issue #75).
 *
 * The emailed token is read back from the mocked `sendEmail` call rather than
 * from the database, because the database only ever holds its hash — which is
 * itself asserted below.
 *
 * These run against the bare router, without the Next.js proxy interceptor, so
 * the fields the interceptor would inject (`setupSecret`, the device key) are
 * supplied directly in the body. The interceptor's own behaviour is covered in
 * unit/signup-link-interceptor.test.ts.
 *
 * F4 and F5 are rows of the #156 follow-up O1 case table: an account whose
 * address is stored in another case, written straight to the table as only an
 * install the boot backfill could not fold holds it.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { signupLinkTokens, users, verificationCodes } from '@/server/entities';
import { generateKeyPair } from '@/server/lib/crypto';

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

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'SecurePassword123!';

describe.skipIf(!dbAvailable)('Verified-email signup', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';
        process.env.SPFN_APP_URL = 'https://app.example.com';

        app = new Hono();
        registerRoutes(app, mainAuthRouter);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        sendEmail.mockClear();
        // Rate-limit counters are process-local and would otherwise carry between
        // tests in this file.
        resetMemoryRateLimitStore();
    });

    function post(path: string, body: unknown)
    {
        return app.request(path, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(body),
        });
    }

    /** The token from the most recent signup-link email. */
    function emailedToken(): string
    {
        const sent = sendEmail.mock.calls.filter(([arg]) => arg?.template === 'signup-link');
        const call = sent[sent.length - 1];

        if (!call)
        {
            throw new Error('no signup-link email was sent');
        }

        return new URL(call[0].data.confirmUrl).searchParams.get('token')!;
    }

    function sentTemplates(): string[]
    {
        return sendEmail.mock.calls.map(([arg]) => arg?.template);
    }

    /** Request a link and return the token it carried. */
    async function requestLink(email: string, returnPath?: string): Promise<string>
    {
        const res = await post('/_auth/signup/email', returnPath === undefined ? { email } : { email, returnPath });
        expect(res.status).toBe(200);

        return emailedToken();
    }

    /** Request and confirm, returning the setup secret. */
    async function openSetupSession(email: string): Promise<string>
    {
        const token = await requestLink(email);
        const res = await post('/_auth/signup/email/confirm', { token });
        expect(res.status).toBe(200);

        return (await res.json()).setupSecret;
    }

    function passwordBody(setupSecret: string, password = PASSWORD)
    {
        const key = generateKeyPair('ES256');

        return {
            setupSecret,
            password,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        };
    }

    /** Create a fully signed-up account through the link flow. */
    async function signUp(email: string, password = PASSWORD)
    {
        const setupSecret = await openSetupSession(email);

        return await post('/_auth/signup/password', passwordBody(setupSecret, password));
    }

    /**
     * Create an account through the six-digit-code path instead.
     *
     * Needed wherever a test has to make an address taken WITHOUT touching the
     * link flow: requesting another link supersedes the live one, so a test that
     * signs up twice through the link path proves supersession, not the
     * account-already-exists case it means to.
     */
    async function registerViaOtp(email: string)
    {
        await post('/_auth/codes', { target: email, targetType: 'email', purpose: 'registration' });

        const db = getTestDb();
        const [codeRow] = await db.select().from(verificationCodes)
            .where(and(eq(verificationCodes.target, email), eq(verificationCodes.purpose, 'registration')))
            .orderBy(desc(verificationCodes.createdAt))
            .limit(1);

        const verifyRes = await post('/_auth/codes/verify', {
            target: email,
            targetType: 'email',
            code: codeRow.code,
            purpose: 'registration',
        });
        const { verificationToken } = await verifyRes.json();

        const key = generateKeyPair('ES256');
        const res = await post('/_auth/register', {
            email,
            verificationToken,
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });

        expect(res.status).toBe(200);

        return { verificationToken };
    }

    // ========================================================================
    // A — POST /_auth/signup/email
    // ========================================================================

    describe('requesting a link', () =>
    {
        it('A1: issues a link for an address with no account', async () =>
        {
            const res = await post('/_auth/signup/email', { email: 'a1@example.com' });

            expect(res.status).toBe(200);
            expect((await res.json()).success).toBe(true);
            expect(sentTemplates()).toEqual(['signup-link']);
        });

        it('A1: stores only the hash of the emailed token', async () =>
        {
            const token = await requestLink('a1-hash@example.com');

            const db = getTestDb();
            const [row] = await db.select().from(signupLinkTokens)
                .where(eq(signupLinkTokens.email, 'a1-hash@example.com'));

            expect(row.tokenHash).not.toBe(token);
            expect(row.tokenHash).toHaveLength(43); // base64url sha256
        });

        it('A2: a second request supersedes the live link', async () =>
        {
            const first = await requestLink('a2@example.com');
            await requestLink('a2@example.com');

            const res = await post('/_auth/signup/email/confirm', { token: first });

            expect(res.status).toBe(400);
        });

        it('A2: the newest link still opens', async () =>
        {
            await requestLink('a2b@example.com');
            const second = await requestLink('a2b@example.com');

            const res = await post('/_auth/signup/email/confirm', { token: second });

            expect(res.status).toBe(200);
        });

        it('A3: issues a fresh link when the previous one expired', async () =>
        {
            await requestLink('a3@example.com');

            const db = getTestDb();
            await db.update(signupLinkTokens)
                .set({ expiresAt: new Date(Date.now() - 60_000) })
                .where(eq(signupLinkTokens.email, 'a3@example.com'));

            const fresh = await requestLink('a3@example.com');
            const res = await post('/_auth/signup/email/confirm', { token: fresh });

            expect(res.status).toBe(200);
        });

        it('A4: a new request kills a setup session opened from the old link', async () =>
        {
            const setupSecret = await openSetupSession('a4@example.com');

            await requestLink('a4@example.com');

            const res = await post('/_auth/signup/password', passwordBody(setupSecret));

            expect(res.status).toBe(401);
        });

        it('A6: notifies the owner instead of sending a link when the account exists', async () =>
        {
            await signUp('a6@example.com');
            sendEmail.mockClear();

            const res = await post('/_auth/signup/email', { email: 'a6@example.com' });

            expect(res.status).toBe(200);
            expect(sentTemplates()).toEqual(['account-exists']);
        });

        it('A6: answers identically whether or not the account exists', async () =>
        {
            await signUp('a6-known@example.com');

            const known = await post('/_auth/signup/email', { email: 'a6-known@example.com' });
            const unknown = await post('/_auth/signup/email', { email: 'a6-unknown@example.com' });

            expect(known.status).toBe(unknown.status);

            const knownBody = await known.json();
            const unknownBody = await unknown.json();

            expect(Object.keys(knownBody).sort()).toEqual(Object.keys(unknownBody).sort());
            expect(knownBody.success).toBe(unknownBody.success);
        });

        it('A6: repeats the owner notice at most once per window', async () =>
        {
            await signUp('a6-dedupe@example.com');
            sendEmail.mockClear();

            await post('/_auth/signup/email', { email: 'a6-dedupe@example.com' });
            await post('/_auth/signup/email', { email: 'a6-dedupe@example.com' });
            await post('/_auth/signup/email', { email: 'a6-dedupe@example.com' });

            expect(sentTemplates()).toEqual(['account-exists']);
        });

        it('A7: refuses past the per-address limit without sending more mail', async () =>
        {
            for (let i = 0; i < 5; i++)
            {
                expect((await post('/_auth/signup/email', { email: 'a7@example.com' })).status).toBe(200);
            }

            const res = await post('/_auth/signup/email', { email: 'a7@example.com' });

            expect(res.status).toBe(429);
            expect(sentTemplates()).toHaveLength(5);
        });

        it.each([
            ['https://evil.example.com/steal', 'absolute URL'],
            ['//evil.example.com/steal', 'scheme-relative'],
            ['/../../etc/passwd', 'traversal'],
            ['not-a-path', 'not rooted'],
            ['/\\evil.example.com', 'backslash'],
        ])('A8: refuses returnPath %s (%s)', async (returnPath) =>
        {
            const res = await post('/_auth/signup/email', { email: 'a8@example.com', returnPath });

            expect(res.status).toBe(400);
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('A8: keeps a safe returnPath and hands it back at confirm', async () =>
        {
            const token = await requestLink('a8-ok@example.com', '/welcome?step=2');

            const res = await post('/_auth/signup/email/confirm', { token });

            expect((await res.json()).returnPath).toBe('/welcome?step=2');
        });
    });

    // ========================================================================
    // B — POST /_auth/signup/email/confirm
    // ========================================================================

    describe('confirming a link', () =>
    {
        it('B1: exchanges a live link for a setup session', async () =>
        {
            const token = await requestLink('b1@example.com');

            const res = await post('/_auth/signup/email/confirm', { token });
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.email).toBe('b1@example.com');
            expect(body.setupSecret).toEqual(expect.any(String));
        });

        it('B1: stores only the hash of the setup secret', async () =>
        {
            const setupSecret = await openSetupSession('b1-hash@example.com');

            const db = getTestDb();
            const [row] = await db.select().from(signupLinkTokens)
                .where(eq(signupLinkTokens.email, 'b1-hash@example.com'));

            expect(row.setupSecretHash).not.toBe(setupSecret);
            expect(row.consumedAt).not.toBeNull();
        });

        it('B2: refuses an unknown token', async () =>
        {
            const res = await post('/_auth/signup/email/confirm', { token: 'x'.repeat(43) });

            expect(res.status).toBe(400);
        });

        it('B3: refuses an expired link', async () =>
        {
            const token = await requestLink('b3@example.com');

            const db = getTestDb();
            await db.update(signupLinkTokens)
                .set({ expiresAt: new Date(Date.now() - 60_000) })
                .where(eq(signupLinkTokens.email, 'b3@example.com'));

            const res = await post('/_auth/signup/email/confirm', { token });

            expect(res.status).toBe(400);
        });

        it('B4: refuses a second confirm and leaves the open setup session alone', async () =>
        {
            const token = await requestLink('b4@example.com');
            const first = await post('/_auth/signup/email/confirm', { token });
            const setupSecret = (await first.json()).setupSecret;

            const second = await post('/_auth/signup/email/confirm', { token });

            expect(second.status).toBe(400);
            expect((await post('/_auth/signup/password', passwordBody(setupSecret))).status).toBe(200);
        });

        it('B5: refuses a consumed link whose setup session has expired', async () =>
        {
            const token = await requestLink('b5@example.com');
            await post('/_auth/signup/email/confirm', { token });

            const db = getTestDb();
            await db.update(signupLinkTokens)
                .set({ setupExpiresAt: new Date(Date.now() - 60_000) })
                .where(eq(signupLinkTokens.email, 'b5@example.com'));

            const res = await post('/_auth/signup/email/confirm', { token });

            expect(res.status).toBe(400);
        });

        it('B7: refuses a link whose signup already completed', async () =>
        {
            const token = await requestLink('b7@example.com');
            const confirmed = await post('/_auth/signup/email/confirm', { token });
            await post('/_auth/signup/password', passwordBody((await confirmed.json()).setupSecret));

            const res = await post('/_auth/signup/email/confirm', { token });

            expect(res.status).toBe(400);
        });

        it('B8: refuses when the address gained an account after the link was issued', async () =>
        {
            const token = await requestLink('b8@example.com');

            // Through the six-digit-code path, so the link is not superseded —
            // the refusal has to come from the account existing, not from that.
            await registerViaOtp('b8@example.com');

            const db = getTestDb();
            const [row] = await db.select().from(signupLinkTokens)
                .where(eq(signupLinkTokens.email, 'b8@example.com'));
            expect(row.supersededAt).toBeNull();

            const res = await post('/_auth/signup/email/confirm', { token });

            expect(res.status).toBe(400);
        });

        it('B9: two concurrent confirms produce exactly one setup session', async () =>
        {
            const token = await requestLink('b9@example.com');

            const results = await Promise.all([
                post('/_auth/signup/email/confirm', { token }),
                post('/_auth/signup/email/confirm', { token }),
            ]);
            const statuses = results.map(r => r.status).sort();

            expect(statuses).toEqual([200, 400]);
        });

        it('B10: refuses past the confirm rate limit', async () =>
        {
            for (let i = 0; i < 10; i++)
            {
                await post('/_auth/signup/email/confirm', { token: 'y'.repeat(43) });
            }

            const res = await post('/_auth/signup/email/confirm', { token: 'y'.repeat(43) });

            expect(res.status).toBe(429);
        });
    });

    // ========================================================================
    // C — POST /_auth/signup/password
    // ========================================================================

    describe('setting the password', () =>
    {
        it('C1: creates the account, registers the device key and signs in', async () =>
        {
            const res = await signUp('c1@example.com');
            const body = await res.json();

            expect(res.status).toBe(200);
            expect(body.userId).toBeDefined();
            expect(body.email).toBe('c1@example.com');
        });

        it('C1: marks the setup session completed', async () =>
        {
            await signUp('c1-mark@example.com');

            const db = getTestDb();
            const [row] = await db.select().from(signupLinkTokens)
                .where(eq(signupLinkTokens.email, 'c1-mark@example.com'));

            expect(row.completedAt).not.toBeNull();
        });

        it('C1: the new account can log in with the password it set', async () =>
        {
            await signUp('c1-login@example.com');

            const key = generateKeyPair('ES256');
            const res = await post('/_auth/login', {
                email: 'c1-login@example.com',
                password: PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            });

            expect(res.status).toBe(200);
        });

        it('C2: refuses when no setup secret is presented', async () =>
        {
            const key = generateKeyPair('ES256');
            const res = await post('/_auth/signup/password', {
                password: PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            });

            expect(res.status).toBe(401);
        });

        it('C3: refuses an unknown setup secret', async () =>
        {
            const res = await post('/_auth/signup/password', passwordBody('z'.repeat(43)));

            expect(res.status).toBe(401);
        });

        it('C4: refuses an expired setup session', async () =>
        {
            const setupSecret = await openSetupSession('c4@example.com');

            const db = getTestDb();
            await db.update(signupLinkTokens)
                .set({ setupExpiresAt: new Date(Date.now() - 60_000) })
                .where(eq(signupLinkTokens.email, 'c4@example.com'));

            const res = await post('/_auth/signup/password', passwordBody(setupSecret));

            expect(res.status).toBe(401);
        });

        it('C5: refuses a second use of a completed setup session', async () =>
        {
            const setupSecret = await openSetupSession('c5@example.com');
            expect((await post('/_auth/signup/password', passwordBody(setupSecret))).status).toBe(200);

            const res = await post('/_auth/signup/password', passwordBody(setupSecret));

            expect(res.status).toBe(401);
        });

        it('C6: refuses when the address gained an account meanwhile', async () =>
        {
            const setupSecret = await openSetupSession('c6@example.com');

            // Through the six-digit-code path, so the setup session stays live
            // and the refusal is about the account, not about supersession.
            await registerViaOtp('c6@example.com');

            const res = await post('/_auth/signup/password', passwordBody(setupSecret));

            expect(res.status).toBe(409);
        });

        it('C6: writes no second account and no password onto the existing one', async () =>
        {
            const setupSecret = await openSetupSession('c6-intact@example.com');
            await registerViaOtp('c6-intact@example.com');

            await post('/_auth/signup/password', passwordBody(setupSecret, 'DifferentPassword456!'));

            // The original password still works, so nothing was overwritten.
            const key = generateKeyPair('ES256');
            const res = await post('/_auth/login', {
                email: 'c6-intact@example.com',
                password: PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            });

            expect(res.status).toBe(200);
        });

        it('C7: refuses a password that fails the policy', async () =>
        {
            const setupSecret = await openSetupSession('c7@example.com');

            const res = await post('/_auth/signup/password', passwordBody(setupSecret, 'short'));

            expect(res.status).toBe(400);
        });

        it('C7: leaves the setup session usable after a rejected password', async () =>
        {
            const setupSecret = await openSetupSession('c7-retry@example.com');
            await post('/_auth/signup/password', passwordBody(setupSecret, 'short'));

            const res = await post('/_auth/signup/password', passwordBody(setupSecret));

            expect(res.status).toBe(200);
        });

        it('C9: two concurrent submits create exactly one account', async () =>
        {
            const setupSecret = await openSetupSession('c9@example.com');

            const results = await Promise.all([
                post('/_auth/signup/password', passwordBody(setupSecret)),
                post('/_auth/signup/password', passwordBody(setupSecret)),
            ]);
            const succeeded = results.filter(r => r.status === 200);

            expect(succeeded).toHaveLength(1);
        });

        it('C11: refuses a submit carrying no device key', async () =>
        {
            const setupSecret = await openSetupSession('c11@example.com');

            const res = await post('/_auth/signup/password', { setupSecret, password: PASSWORD });

            expect(res.status).toBe(400);
        });
    });

    // ========================================================================
    // E — compatibility with the existing flows
    // ========================================================================

    describe('compatibility', () =>
    {
        it('E2: a verification token is not accepted as a setup secret', async () =>
        {
            const { verificationToken } = await registerViaOtp('e2-source@example.com');

            const res = await post('/_auth/signup/password', passwordBody(verificationToken));

            expect(res.status).toBe(401);
        });

        it('E3: a setup secret is not accepted as a verification token', async () =>
        {
            const setupSecret = await openSetupSession('e3@example.com');
            const key = generateKeyPair('ES256');

            const res = await post('/_auth/register', {
                email: 'e3@example.com',
                verificationToken: setupSecret,
                password: PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            });

            expect(res.status).toBe(400);
        });

        it('E4: an account created this way behaves like any password account', async () =>
        {
            await signUp('e4@example.com');

            const key = generateKeyPair('ES256');
            const wrongPassword = await post('/_auth/login', {
                email: 'e4@example.com',
                password: 'WrongPassword123!',
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            });

            expect(wrongPassword.status).toBe(401);
        });
    });

    describe('#156 O1: an address stored in another case', () =>
    {
        /** An account holding this stored email, written past the repository's normalisation. */
        async function insertRaw(email: string): Promise<void>
        {
            const userRole = await getRoleByName('user');
            await getTestDb().insert(users).values({ email, status: 'active', roleId: userRole!.id });
        }

        it('F4: a link request takes the account-exists branch, answered as for an unknown address', async () =>
        {
            await insertRaw('F4@Example.com');

            const known = await post('/_auth/signup/email', { email: 'f4@example.com' });
            const unknown = await post('/_auth/signup/email', { email: 'f4-unknown@example.com' });

            expect(known.status).toBe(200);
            expect(unknown.status).toBe(200);
            expect(Object.keys(await known.json()).sort()).toEqual(Object.keys(await unknown.json()).sort());
            expect(sentTemplates()).toEqual(['account-exists', 'signup-link']);
            expect((await getTestDb().select().from(signupLinkTokens)).map(row => row.email)).toEqual(['f4-unknown@example.com']);
        });

        it('F5: a link is refused when an account stored in another case appeared after it was issued', async () =>
        {
            const token = await requestLink('f5@example.com');
            await insertRaw('F5@Example.com');

            const res = await post('/_auth/signup/email/confirm', { token });

            expect(res.status).toBe(400);
            const [row] = await getTestDb().select().from(signupLinkTokens).where(eq(signupLinkTokens.email, 'f5@example.com'));
            expect(row!.setupSecretHash).toBeNull();
        });
    });
});
