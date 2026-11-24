/**
 * @spfn/auth - API Flow Integration Tests
 *
 * Real HTTP requests against the mounted auth router. Registration now goes
 * through the verification flow (send code → verify → token → register), so
 * these tests drive that flow: the OTP delivery is mocked (the code is still
 * persisted before sending) and read back from the database to complete the
 * verify step. Real key pairs are generated so the fingerprint check passes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, desc } from 'drizzle-orm';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { verificationCodes } from '@/server/entities';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';

// OTP delivery is a no-op in tests; the code is persisted before delivery, so
// the verify step reads it straight from the database.
vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: vi.fn().mockResolvedValue({ success: true }),
        sendSMS: vi.fn().mockResolvedValue({ success: true }),
    };
});

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe.skipIf(!dbAvailable)('API Flow Integration', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';

        app = new Hono();
        registerRoutes(app, mainAuthRouter);
        // Bare Hono app: register the SPFN error handler so thrown SerializableErrors
        // serialize to their real status (createServer does this automatically).
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
    });

    /**
     * Register a user through the full verification flow with a real key pair.
     * Returns the register Response plus the registered keyId (for login rotation).
     */
    async function registerViaFlow(email: string, password: string)
    {
        const key = generateKeyPair('ES256');

        // 1. Request a verification code (persisted before the mocked delivery)
        await app.request('/_auth/codes', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ target: email, targetType: 'email', purpose: 'registration' }),
        });

        // 2. Read the persisted code
        const db = getTestDb();
        const [codeRow] = await db.select().from(verificationCodes)
            .where(and(eq(verificationCodes.target, email), eq(verificationCodes.purpose, 'registration')))
            .orderBy(desc(verificationCodes.createdAt))
            .limit(1);

        // 3. Exchange the code for a verification token
        const verifyRes = await app.request('/_auth/codes/verify', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({ target: email, targetType: 'email', code: codeRow.code, purpose: 'registration' }),
        });
        const { verificationToken } = await verifyRes.json();

        // 4. Register with the verification token + real key material
        const response = await app.request('/_auth/register', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
                email,
                verificationToken,
                password,
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        });

        return { response, keyId: key.keyId };
    }

    it('should complete the full registration flow via HTTP', async () =>
    {
        const { response } = await registerViaFlow('test@example.com', 'SecurePassword123!');

        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data.userId).toBeDefined();
        expect(data.email).toBe('test@example.com');
        // Note: the session cookie is sealed by the Next.js API forwarding layer,
        // not the backend router, so it is not asserted in this bare-router test.
    });

    it('should complete the login → logout flow', async () =>
    {
        const { keyId: registerKeyId } = await registerViaFlow('login@example.com', 'Password123!');

        // Login, rotating from the register key to a fresh one
        const loginKey = generateKeyPair('ES256');
        const loginResponse = await app.request('/_auth/login', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
                email: 'login@example.com',
                password: 'Password123!',
                publicKey: loginKey.publicKey,
                keyId: loginKey.keyId,
                fingerprint: loginKey.fingerprint,
                algorithm: loginKey.algorithm,
                oldKeyId: registerKeyId,
            }),
        });

        expect(loginResponse.status).toBe(200);

        const loginData = await loginResponse.json();
        expect(loginData.userId).toBeDefined();

        // Logout, signed by the session's key, returns 204 No Content
        const logoutResponse = await app.request('/_auth/logout', {
            method: 'POST',
            headers: { Authorization: `Bearer ${generateClientToken({ keyId: loginKey.keyId }, loginKey.privateKey, 'ES256', { expiresIn: '5m' })}` },
        });
        expect(logoutResponse.status).toBe(204);
    });

    it('should reject invalid credentials', async () =>
    {
        const key = generateKeyPair('ES256');
        const response = await app.request('/_auth/login', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
                email: 'nonexistent@example.com',
                password: 'WrongPassword123!',
                publicKey: key.publicKey,
                keyId: key.keyId,
                fingerprint: key.fingerprint,
                algorithm: key.algorithm,
            }),
        });

        expect(response.status).toBe(401);
        expect((await response.json()).__type).toBeDefined();
    });

    // The route does not validate the key fields it declares for its
    // interceptor, so the fingerprint check is what a direct client's body reaches.
    it('answers a login whose publicKey is not a string as a fingerprint mismatch, not a 500 (#489)', async () =>
    {
        await registerViaFlow('no-key@example.com', 'Password123!');
        const statuses: number[] = [];

        for (const publicKey of [undefined, 12345])
        {
            const response = await app.request('/_auth/login', {
                method: 'POST',
                headers: JSON_HEADERS,
                body: JSON.stringify({
                    email: 'no-key@example.com',
                    password: 'Password123!',
                    publicKey,
                    keyId: 'no-key',
                    fingerprint: 'a'.repeat(64),
                    algorithm: 'ES256',
                }),
            });
            statuses.push(response.status);
        }

        expect(statuses).toEqual([400, 400]);
    });
});
