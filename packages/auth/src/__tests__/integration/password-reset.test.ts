/**
 * @spfn/auth - Password Reset Integration Tests
 *
 * Real HTTP requests against the mounted auth router, one test per row of the
 * case table in the feature's design: P for the request, Q for the confirm, C
 * for the completion, S for the registration stamp the eligibility rule depends
 * on.
 *
 * The emailed token is read back from the mocked `sendEmail` call rather than
 * from the database, because the database only ever holds its hash — which is
 * itself asserted below.
 *
 * These run against the bare router, without the Next.js proxy interceptor, so
 * the fields the interceptor would inject (`setupSecret` and the device key) are
 * supplied directly in the body. The interceptor's own behaviour is covered in
 * unit/password-reset-interceptor.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import {
    deviceAuthorizations,
    passwordResetTokens,
    signupLinkTokens,
    userPublicKeys,
    users,
    verificationCodes,
} from '@/server/entities';
import { generateKeyPair } from '@/server/lib/crypto';
import { hashPassword } from '@/server/helpers/password';
import { authPasswordResetEvent } from '@/server/events';

const sendEmail = vi.fn().mockResolvedValue({ success: true });
const sendSMS = vi.fn().mockResolvedValue({ success: true });

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: (...args: unknown[]) => sendEmail(...args),
        sendSMS: (...args: unknown[]) => sendSMS(...args),
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
const NEW_PASSWORD = 'BrandNewPassword456!';

describe.skipIf(!dbAvailable)('Password reset', () =>
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
        await clearTables(getTestDb());
        await initializeAuth();
        sendEmail.mockClear();
        sendSMS.mockClear();
        // Rate-limit counters are process-local and would otherwise carry between
        // tests in this file.
        resetMemoryRateLimitStore();
        vi.restoreAllMocks();
    });

    function post(path: string, body: unknown)
    {
        return app.request(path, {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify(body),
        });
    }

    // ========================================================================
    // Accounts of each shape the eligibility rule distinguishes
    // ========================================================================

    interface SeedOptions
    {
        email?: string;
        phone?: string;
        password?: string | null;
        emailVerifiedAt?: Date | null;
        status?: 'active' | 'suspended' | 'pending_deletion';
    }

    async function seedUser(options: SeedOptions)
    {
        const userRole = await getRoleByName('user');
        const [row] = await getTestDb().insert(users).values({
            email: options.email ?? null,
            phone: options.phone ?? null,
            passwordHash: options.password === null ? null : await hashPassword(options.password ?? PASSWORD),
            emailVerifiedAt: options.emailVerifiedAt ?? null,
            status: options.status ?? 'active',
            roleId: userRole!.id,
        }).returning();

        return row;
    }

    /** The account shape the flow is built for: active, address proved. */
    async function seedResettable(email: string)
    {
        return await seedUser({ email, emailVerifiedAt: new Date() });
    }

    async function userRow(email: string)
    {
        const [row] = await getTestDb().select().from(users).where(eq(users.email, email)).limit(1);

        return row;
    }

    async function resetRows(email: string)
    {
        return getTestDb().select().from(passwordResetTokens).where(eq(passwordResetTokens.email, email));
    }

    // ========================================================================
    // Driving the three steps
    // ========================================================================

    function sentTemplates(): string[]
    {
        return sendEmail.mock.calls.map(([arg]) => arg?.template);
    }

    /** The token from the most recent password-reset email. */
    function emailedToken(): string
    {
        const sent = sendEmail.mock.calls.filter(([arg]) => arg?.template === 'password-reset');
        const call = sent[sent.length - 1];

        if (!call)
        {
            throw new Error('no password-reset email was sent');
        }

        return new URL(call[0].data.confirmUrl).searchParams.get('token')!;
    }

    /** Request a reset and return the token the mail carried. */
    async function requestReset(email: string, returnPath?: string): Promise<string>
    {
        const response = await post('/_auth/password/reset', returnPath === undefined ? { email } : { email, returnPath });
        expect(response.status).toBe(200);

        return emailedToken();
    }

    /** Request and confirm, returning the setup secret. */
    async function openSetupSession(email: string): Promise<string>
    {
        const response = await post('/_auth/password/reset/confirm', { token: await requestReset(email) });
        expect(response.status).toBe(200);

        return (await response.json()).setupSecret;
    }

    function completeBody(setupSecret: string, password = NEW_PASSWORD, extra: Record<string, unknown> = {})
    {
        const key = generateKeyPair('ES256');

        return {
            setupSecret,
            password,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
            ...extra,
        };
    }

    function login(email: string, password: string)
    {
        const key = generateKeyPair('ES256');

        return post('/_auth/login', {
            email,
            password,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });
    }

    /** Collect one event's payloads for the duration of a test. */
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

    /** Create an account through the six-digit-code register path. */
    async function registerViaOtp(target: string, targetType: 'email' | 'phone')
    {
        await post('/_auth/codes', { target, targetType, purpose: 'registration' });

        const [codeRow] = await getTestDb().select().from(verificationCodes)
            .where(and(eq(verificationCodes.target, target), eq(verificationCodes.purpose, 'registration')))
            .orderBy(desc(verificationCodes.createdAt))
            .limit(1);

        const verifyResponse = await post('/_auth/codes/verify', {
            target,
            targetType,
            code: codeRow.code,
            purpose: 'registration',
        });
        const { verificationToken } = await verifyResponse.json();

        const key = generateKeyPair('ES256');
        const response = await post('/_auth/register', {
            ...(targetType === 'email' ? { email: target } : { phone: target }),
            verificationToken,
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });

        expect(response.status).toBe(200);
    }

    // ========================================================================
    // P — POST /_auth/password/reset
    // ========================================================================

    describe('P — requesting a reset', () =>
    {
        it('row P1: mails a link to an active account whose address is verified', async () =>
        {
            await seedResettable('p1@example.com');

            const response = await post('/_auth/password/reset', { email: 'p1@example.com' });

            expect(response.status).toBe(200);
            expect((await response.json()).success).toBe(true);
            expect(sentTemplates()).toEqual(['password-reset']);
            expect(sendEmail.mock.calls[0][0].data.confirmUrl)
                .toMatch(/^https:\/\/app\.example\.com\/password\/reset\?token=/);
        });

        it('row P1: stores only the hash of the emailed token', async () =>
        {
            await seedResettable('p1-hash@example.com');
            const token = await requestReset('p1-hash@example.com');

            const [row] = await resetRows('p1-hash@example.com');

            expect(row.tokenHash).not.toBe(token);
            expect(row.tokenHash).toHaveLength(43); // base64url sha256
            expect(row.consumedAt).toBeNull();
        });

        it('row P2: mails a link to an account with a password but no verified stamp', async () =>
        {
            await seedUser({ email: 'p2@example.com', emailVerifiedAt: null });

            const response = await post('/_auth/password/reset', { email: 'p2@example.com' });

            expect(response.status).toBe(200);
            expect(sentTemplates()).toEqual(['password-reset']);
            expect(await resetRows('p2@example.com')).toHaveLength(1);
        });

        it('row P3: an unknown address gets no row and no mail', async () =>
        {
            const response = await post('/_auth/password/reset', { email: 'p3@example.com' });

            expect(response.status).toBe(200);
            expect(sendEmail).not.toHaveBeenCalled();
            expect(await resetRows('p3@example.com')).toHaveLength(0);
        });

        it('row P4: an OAuth-only account with no password and no verified stamp gets no mail', async () =>
        {
            await seedUser({ email: 'p4@example.com', password: null, emailVerifiedAt: null });

            const response = await post('/_auth/password/reset', { email: 'p4@example.com' });

            expect(response.status).toBe(200);
            expect(sendEmail).not.toHaveBeenCalled();
            expect(await resetRows('p4@example.com')).toHaveLength(0);
        });

        it.each([
            ['suspended' as const],
            ['pending_deletion' as const],
        ])('row P5: an account that is %s gets no mail', async (status) =>
        {
            await seedUser({ email: `p5-${status}@example.com`, emailVerifiedAt: new Date(), status });

            const response = await post('/_auth/password/reset', { email: `p5-${status}@example.com` });

            expect(response.status).toBe(200);
            expect(sendEmail).not.toHaveBeenCalled();
            expect(await resetRows(`p5-${status}@example.com`)).toHaveLength(0);
        });

        it('rows P1/P3/P4/P5: every answer is byte-identical', async () =>
        {
            await seedResettable('p-known@example.com');
            await seedUser({ email: 'p-oauth@example.com', password: null, emailVerifiedAt: null });
            await seedUser({ email: 'p-suspended@example.com', emailVerifiedAt: new Date(), status: 'suspended' });

            // `expiresAt` is `now + TTL` in both branches, so freezing the clock
            // is what makes "identical arithmetic" testable as "identical bytes".
            vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-07T12:00:00.000Z').getTime());

            const bodies = await Promise.all([
                'p-known@example.com',
                'p-unknown@example.com',
                'p-oauth@example.com',
                'p-suspended@example.com',
            ].map(async (email) =>
            {
                const response = await post('/_auth/password/reset', { email });
                expect(response.status).toBe(200);

                return await response.text();
            }));

            expect(new Set(bodies).size).toBe(1);
            expect(JSON.parse(bodies[0])).toEqual({
                success: true,
                expiresAt: '2026-09-07T12:30:00.000Z',
            });
        });

        it('row P6: a second request supersedes the live link', async () =>
        {
            await seedResettable('p6@example.com');
            const first = await requestReset('p6@example.com');
            await requestReset('p6@example.com');

            const response = await post('/_auth/password/reset/confirm', { token: first });

            expect(response.status).toBe(401);
        });

        it('row P6: a second request kills a setup session opened from the old link', async () =>
        {
            await seedResettable('p6-setup@example.com');
            const setupSecret = await openSetupSession('p6-setup@example.com');

            await requestReset('p6-setup@example.com');

            expect((await post('/_auth/password/reset/complete', completeBody(setupSecret))).status).toBe(401);
        });

        it('row P6: the newest link still opens', async () =>
        {
            await seedResettable('p6-new@example.com');
            await requestReset('p6-new@example.com');
            const second = await requestReset('p6-new@example.com');

            expect((await post('/_auth/password/reset/confirm', { token: second })).status).toBe(200);
        });

        it('row P7: refuses past the per-address limit without sending more mail', async () =>
        {
            await seedResettable('p7@example.com');

            for (let i = 0; i < 5; i++)
            {
                expect((await post('/_auth/password/reset', { email: 'p7@example.com' })).status).toBe(200);
            }

            const response = await post('/_auth/password/reset', { email: 'p7@example.com' });

            expect(response.status).toBe(429);
            expect(sentTemplates()).toHaveLength(5);
        });

        it.each([
            ['https://evil.example.com/steal', 'absolute URL'],
            ['//evil.example.com/steal', 'scheme-relative'],
            ['/../../etc/passwd', 'traversal'],
            ['not-a-path', 'not rooted'],
            ['/\\evil.example.com', 'backslash'],
        ])('row P8: refuses returnPath %s (%s)', async (returnPath) =>
        {
            await seedResettable('p8@example.com');

            const response = await post('/_auth/password/reset', { email: 'p8@example.com', returnPath });

            expect(response.status).toBe(400);
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('row P8: keeps a safe returnPath and hands it back at confirm', async () =>
        {
            await seedResettable('p8-ok@example.com');
            const token = await requestReset('p8-ok@example.com', '/account?tab=security');

            const response = await post('/_auth/password/reset/confirm', { token });

            expect((await response.json()).returnPath).toBe('/account?tab=security');
        });

        it('row P9: an OAuth-only account with a verified address may reset, and gains a password', async () =>
        {
            await seedUser({ email: 'p9@example.com', password: null, emailVerifiedAt: new Date() });

            const setupSecret = await openSetupSession('p9@example.com');
            expect(sentTemplates()).toEqual(['password-reset']);

            expect((await post('/_auth/password/reset/complete', completeBody(setupSecret))).status).toBe(200);
            expect((await login('p9@example.com', NEW_PASSWORD)).status).toBe(200);
        });
    });

    // ========================================================================
    // Q — POST /_auth/password/reset/confirm
    // ========================================================================

    describe('Q — confirming a link', () =>
    {
        it('row Q1: exchanges a live link for a setup session stored only as a hash', async () =>
        {
            await seedResettable('q1@example.com');
            const token = await requestReset('q1@example.com', '/back');

            const response = await post('/_auth/password/reset/confirm', { token });
            const body = await response.json();

            expect(response.status).toBe(200);
            expect(body.email).toBe('q1@example.com');
            expect(body.returnPath).toBe('/back');
            expect(body.setupSecret).toEqual(expect.any(String));

            const [row] = await resetRows('q1@example.com');
            expect(row.setupSecretHash).not.toBe(body.setupSecret);
            expect(row.setupSecretHash).toHaveLength(43);
            expect(row.consumedAt).not.toBeNull();
        });

        it('row Q2: refuses an unknown token', async () =>
        {
            expect((await post('/_auth/password/reset/confirm', { token: 'x'.repeat(43) })).status).toBe(401);
        });

        it('row Q3: refuses an expired link', async () =>
        {
            await seedResettable('q3@example.com');
            const token = await requestReset('q3@example.com');

            await getTestDb().update(passwordResetTokens)
                .set({ expiresAt: new Date(Date.now() - 60_000) })
                .where(eq(passwordResetTokens.email, 'q3@example.com'));

            expect((await post('/_auth/password/reset/confirm', { token })).status).toBe(401);
        });

        it('row Q4: refuses a second confirm and leaves the open setup session alone', async () =>
        {
            await seedResettable('q4@example.com');
            const token = await requestReset('q4@example.com');
            const first = await post('/_auth/password/reset/confirm', { token });
            const setupSecret = (await first.json()).setupSecret;

            expect((await post('/_auth/password/reset/confirm', { token })).status).toBe(401);
            expect((await post('/_auth/password/reset/complete', completeBody(setupSecret))).status).toBe(200);
        });

        it('row Q5: refuses a superseded link', async () =>
        {
            await seedResettable('q5@example.com');
            const first = await requestReset('q5@example.com');
            await requestReset('q5@example.com');

            expect((await post('/_auth/password/reset/confirm', { token: first })).status).toBe(401);
        });

        it('row Q6: refuses a link whose reset already completed', async () =>
        {
            await seedResettable('q6@example.com');
            const token = await requestReset('q6@example.com');
            const confirmed = await post('/_auth/password/reset/confirm', { token });
            await post('/_auth/password/reset/complete', completeBody((await confirmed.json()).setupSecret));

            expect((await post('/_auth/password/reset/confirm', { token })).status).toBe(401);
        });

        it('row Q7: two concurrent confirms produce exactly one setup session', async () =>
        {
            await seedResettable('q7@example.com');
            const token = await requestReset('q7@example.com');

            const responses = await Promise.all([
                post('/_auth/password/reset/confirm', { token }),
                post('/_auth/password/reset/confirm', { token }),
            ]);

            expect(responses.map(response => response.status).sort()).toEqual([200, 401]);
        });

        it('row Q8: refuses a link whose account stopped being active after it was issued', async () =>
        {
            await seedResettable('q8@example.com');
            const token = await requestReset('q8@example.com');

            await getTestDb().update(users)
                .set({ status: 'suspended' })
                .where(eq(users.email, 'q8@example.com'));

            expect((await post('/_auth/password/reset/confirm', { token })).status).toBe(401);

            const [row] = await resetRows('q8@example.com');
            expect(row.consumedAt).toBeNull();
        });

        it('row Q9: refuses past the confirm rate limit', async () =>
        {
            for (let i = 0; i < 10; i++)
            {
                await post('/_auth/password/reset/confirm', { token: 'y'.repeat(43) });
            }

            expect((await post('/_auth/password/reset/confirm', { token: 'y'.repeat(43) })).status).toBe(429);
        });
    });

    // ========================================================================
    // C — POST /_auth/password/reset/complete
    // ========================================================================

    describe('C — completing a reset', () =>
    {
        it('row C1: writes the new password, signs this browser in and marks the session done', async () =>
        {
            const user = await seedUser({ email: 'c1@example.com', emailVerifiedAt: null });
            const events = captureEvent(authPasswordResetEvent);
            const setupSecret = await openSetupSession('c1@example.com');
            const body = completeBody(setupSecret);

            const response = await post('/_auth/password/reset/complete', body);

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                userId: String(user.id),
                publicId: user.publicId,
                email: 'c1@example.com',
            });

            const after = await userRow('c1@example.com');
            expect(after.passwordHash).not.toBe(user.passwordHash);
            expect(after.passwordChangeRequired).toBe(false);
            expect(after.emailVerifiedAt).not.toBeNull();

            const [row] = await resetRows('c1@example.com');
            expect(row.completedAt).not.toBeNull();

            const keys = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.userId, user.id));
            expect(keys.filter(key => key.isActive).map(key => key.keyId)).toEqual([body.keyId]);

            expect(events).toEqual([{ userId: String(user.id), email: 'c1@example.com' }]);
        });

        it('row C1: revokes every earlier device key and denies pending device authorizations', async () =>
        {
            const user = await seedUser({ email: 'c1-revoke@example.com', emailVerifiedAt: new Date() });
            const db = getTestDb();
            const stale = generateKeyPair('ES256');

            await db.insert(userPublicKeys).values({
                userId: user.id,
                keyId: stale.keyId,
                publicKey: stale.publicKey,
                fingerprint: stale.fingerprint,
                algorithm: 'ES256',
            });
            const waiting = generateKeyPair('ES256');
            await db.insert(deviceAuthorizations).values({
                deviceCodeHash: 'device-code-hash-c1',
                userCode: 'CODEC1',
                publicKey: waiting.publicKey,
                keyId: waiting.keyId,
                fingerprint: waiting.fingerprint,
                algorithm: 'ES256',
                status: 'approved',
                userId: user.id,
                expiresAt: new Date(Date.now() + 600_000),
                approvedAt: new Date(),
            });

            const setupSecret = await openSetupSession('c1-revoke@example.com');
            const body = completeBody(setupSecret);

            expect((await post('/_auth/password/reset/complete', body)).status).toBe(200);

            const keys = await db.select().from(userPublicKeys).where(eq(userPublicKeys.userId, user.id));
            expect(keys.find(key => key.keyId === stale.keyId)!.isActive).toBe(false);
            expect(keys.find(key => key.keyId === body.keyId)!.isActive).toBe(true);

            const [authorization] = await db.select().from(deviceAuthorizations)
                .where(eq(deviceAuthorizations.userId, user.id));
            expect(authorization.status).toBe('denied');
        });

        it('row C2: refuses when no setup secret is presented', async () =>
        {
            const user = await seedResettable('c2@example.com');
            const key = generateKeyPair('ES256');

            const response = await post('/_auth/password/reset/complete', {
                password: NEW_PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            });

            expect(response.status).toBe(401);
            expect((await userRow('c2@example.com')).passwordHash).toBe(user.passwordHash);
        });

        it('row C3: refuses an unknown setup secret', async () =>
        {
            expect((await post('/_auth/password/reset/complete', completeBody('z'.repeat(43)))).status).toBe(401);
        });

        it('row C4: refuses an expired setup session', async () =>
        {
            await seedResettable('c4@example.com');
            const setupSecret = await openSetupSession('c4@example.com');

            await getTestDb().update(passwordResetTokens)
                .set({ setupExpiresAt: new Date(Date.now() - 60_000) })
                .where(eq(passwordResetTokens.email, 'c4@example.com'));

            expect((await post('/_auth/password/reset/complete', completeBody(setupSecret))).status).toBe(401);
        });

        it('row C5: refuses a second use of a completed setup session', async () =>
        {
            await seedResettable('c5@example.com');
            const setupSecret = await openSetupSession('c5@example.com');
            expect((await post('/_auth/password/reset/complete', completeBody(setupSecret))).status).toBe(200);

            const afterFirst = await userRow('c5@example.com');

            const response = await post('/_auth/password/reset/complete', completeBody(setupSecret, 'ThirdPassword789!'));

            expect(response.status).toBe(401);
            expect((await userRow('c5@example.com')).passwordHash).toBe(afterFirst.passwordHash);
        });

        it('row C6: refuses a password that fails the policy and leaves the session usable', async () =>
        {
            const user = await seedResettable('c6@example.com');
            const setupSecret = await openSetupSession('c6@example.com');

            const refused = await post('/_auth/password/reset/complete', completeBody(setupSecret, 'short'));

            expect(refused.status).toBe(400);
            expect((await userRow('c6@example.com')).passwordHash).toBe(user.passwordHash);
            expect((await resetRows('c6@example.com'))[0].completedAt).toBeNull();

            expect((await post('/_auth/password/reset/complete', completeBody(setupSecret))).status).toBe(200);
        });

        it('row C7: refuses a submit carrying no device key and leaves the session usable', async () =>
        {
            const user = await seedResettable('c7@example.com');
            const setupSecret = await openSetupSession('c7@example.com');

            const refused = await post('/_auth/password/reset/complete', { setupSecret, password: NEW_PASSWORD });

            expect(refused.status).toBe(400);
            expect((await userRow('c7@example.com')).passwordHash).toBe(user.passwordHash);
            expect((await resetRows('c7@example.com'))[0].completedAt).toBeNull();

            expect((await post('/_auth/password/reset/complete', completeBody(setupSecret))).status).toBe(200);
        });

        it('row C8: refuses when the account stopped being active after the session opened', async () =>
        {
            const user = await seedResettable('c8@example.com');
            const setupSecret = await openSetupSession('c8@example.com');

            await getTestDb().update(users)
                .set({ status: 'pending_deletion' })
                .where(eq(users.email, 'c8@example.com'));

            expect((await post('/_auth/password/reset/complete', completeBody(setupSecret))).status).toBe(401);
            expect((await userRow('c8@example.com')).passwordHash).toBe(user.passwordHash);
        });

        it('row C9: two concurrent completes write the password once and register one key', async () =>
        {
            const user = await seedResettable('c9@example.com');
            const setupSecret = await openSetupSession('c9@example.com');

            const responses = await Promise.all([
                post('/_auth/password/reset/complete', completeBody(setupSecret)),
                post('/_auth/password/reset/complete', completeBody(setupSecret)),
            ]);

            expect(responses.map(response => response.status).sort()).toEqual([200, 401]);

            const keys = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.userId, user.id));
            expect(keys.filter(key => key.isActive)).toHaveLength(1);
            expect((await resetRows('c9@example.com'))[0].completedAt).not.toBeNull();
        });

        it('row C10: the new password logs in and the old one does not', async () =>
        {
            await seedResettable('c10@example.com');
            const setupSecret = await openSetupSession('c10@example.com');
            expect((await post('/_auth/password/reset/complete', completeBody(setupSecret))).status).toBe(200);

            expect((await login('c10@example.com', NEW_PASSWORD)).status).toBe(200);
            expect((await login('c10@example.com', PASSWORD)).status).toBe(401);
        });

        it('row C11: a signup setup secret is not a reset setup secret', async () =>
        {
            const signupConfirm = await post('/_auth/signup/email/confirm', {
                token: await (async () =>
                {
                    await post('/_auth/signup/email', { email: 'c11-signup@example.com' });
                    const call = sendEmail.mock.calls.find(([arg]) => arg?.template === 'signup-link')!;

                    return new URL(call[0].data.confirmUrl).searchParams.get('token')!;
                })(),
            });
            const signupSecret = (await signupConfirm.json()).setupSecret;

            expect((await post('/_auth/password/reset/complete', completeBody(signupSecret))).status).toBe(401);

            const [signupRow] = await getTestDb().select().from(signupLinkTokens)
                .where(eq(signupLinkTokens.email, 'c11-signup@example.com'));
            expect(signupRow.completedAt).toBeNull();
        });

        it('row C11: a reset setup secret is not a signup setup secret', async () =>
        {
            await seedResettable('c11-reset@example.com');
            const resetSecret = await openSetupSession('c11-reset@example.com');
            const key = generateKeyPair('ES256');

            const response = await post('/_auth/signup/password', {
                setupSecret: resetSecret,
                password: NEW_PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            });

            expect(response.status).toBe(401);
            expect((await resetRows('c11-reset@example.com'))[0].completedAt).toBeNull();
        });

        it('row C12: the key the resetting browser already held is revoked with the rest', async () =>
        {
            const user = await seedResettable('c12@example.com');
            const signedIn = await login('c12@example.com', PASSWORD);
            expect(signedIn.status).toBe(200);

            const db = getTestDb();
            const [oldKey] = await db.select().from(userPublicKeys).where(eq(userPublicKeys.userId, user.id));

            // The browser still carries the session cookie for `oldKey`. Nothing
            // names that key in the request — `loginRegisterInterceptor` injects
            // `oldKeyId` only on the two sign-in paths — so the revoke-all is
            // what has to retire it.
            const setupSecret = await openSetupSession('c12@example.com');
            const body = completeBody(setupSecret);

            expect((await post('/_auth/password/reset/complete', body)).status).toBe(200);

            const keys = await db.select().from(userPublicKeys).where(eq(userPublicKeys.userId, user.id));
            expect(keys.find(key => key.keyId === oldKey.keyId)!.isActive).toBe(false);
            expect(keys.filter(key => key.isActive).map(key => key.keyId)).toEqual([body.keyId]);
        });
    });

    // ========================================================================
    // S — the stamp the eligibility rule reads
    // ========================================================================

    describe('S — emailVerifiedAt on registration', () =>
    {
        it('row S1: the six-digit-code register stamps the address it verified', async () =>
        {
            await registerViaOtp('s1@example.com', 'email');

            expect((await userRow('s1@example.com')).emailVerifiedAt).not.toBeNull();
        });

        it('row S2: the verified-email signup stamps the address its link proved', async () =>
        {
            await post('/_auth/signup/email', { email: 's2@example.com' });
            const call = sendEmail.mock.calls.find(([arg]) => arg?.template === 'signup-link')!;
            const token = new URL(call[0].data.confirmUrl).searchParams.get('token')!;
            const confirmed = await post('/_auth/signup/email/confirm', { token });
            const key = generateKeyPair('ES256');

            const response = await post('/_auth/signup/password', {
                setupSecret: (await confirmed.json()).setupSecret,
                password: PASSWORD,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            });

            expect(response.status).toBe(200);
            expect((await userRow('s2@example.com')).emailVerifiedAt).not.toBeNull();
        });

        it('row S3: a phone-only register stamps neither the email nor anything else new', async () =>
        {
            await registerViaOtp('+821012345678', 'phone');

            const [row] = await getTestDb().select().from(users).where(eq(users.phone, '+821012345678'));

            expect(row.email).toBeNull();
            expect(row.emailVerifiedAt).toBeNull();
            expect(row.phoneVerifiedAt).toBeNull();
        });
    });
});
