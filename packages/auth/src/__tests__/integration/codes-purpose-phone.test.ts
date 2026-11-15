/**
 * What a verification code may be sent for and to (au4-A9).
 *
 * Codes were sent for purposes nothing consumes (`login`, `email_change`,
 * `phone_change`, `password_reset`) and to any string named as a phone number.
 * (A phone signup stamping `phoneVerifiedAt`, au4-A13, is row S3 of
 * password-reset.test.ts.)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { users, verificationCodes } from '@/server/entities';

const { sendEmail, sendSMS } = vi.hoisted(() => ({
    sendEmail: vi.fn(),
    sendSMS: vi.fn(),
}));

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return { ...actual, sendEmail, sendSMS };
});

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { settleLinkMail } = await import('@/server/lib/link-mail-delivery');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe.skipIf(!dbAvailable)('Verification code purposes and targets', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();

        app = new Hono();
        registerRoutes(app, mainAuthRouter);
        app.onError(ErrorHandler({ includeStack: false, enableLogging: false }));
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();
        sendEmail.mockReset().mockResolvedValue({ success: true });
        sendSMS.mockReset().mockResolvedValue({ success: true });
    });

    async function post(path: string, body: unknown): Promise<Response>
    {
        return await app.request(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
    }

    it('refuses a purpose nothing consumes with 400', async () =>
    {
        const response = await post('/_auth/codes', { target: 'user@example.com', targetType: 'email', purpose: 'login' });

        expect(response.status).toBe(400);
        expect(sendEmail).not.toHaveBeenCalled();
    });

    it('refuses a phone target that is not E.164 with 400 and sends nothing', async () =>
    {
        const response = await post('/_auth/codes', { target: '010-1234-5678', targetType: 'phone', purpose: 'registration' });

        expect(response.status).toBe(400);
        expect(sendSMS).not.toHaveBeenCalled();
        expect(await getTestDb().select().from(verificationCodes)).toHaveLength(0);
    });

    it.each([
        ['the plus-addressed address', 'owner+oauth@example.com'],
        ['an internationalised domain joined with a ZWNJ (U+200C)', 'owner@\u0646\u0627\u0645\u0647\u200C\u0627\u06CC.ir'],
    ])('sends an account_deletion code to %s of an account with no password', async (_name, email) =>
    {
        const userRole = await getRoleByName('user');
        await getTestDb().insert(users).values({
            email,
            passwordHash: null,
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        });

        const response = await post('/_auth/codes', { target: email, targetType: 'email', purpose: 'account_deletion' });

        expect(response.status).toBe(200);
        await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: email })));
    });

    it('refuses a phone number named as an email target with 400 and sends nothing', async () =>
    {
        const response = await post('/_auth/codes', { target: '+821012345678', targetType: 'email', purpose: 'registration' });

        expect(response.status).toBe(400);
        expect(sendEmail).not.toHaveBeenCalled();
        expect(await getTestDb().select().from(verificationCodes)).toHaveLength(0);
    });

    it.each([
        ['a bare @', '@', 'account_deletion'],
        ['an empty local part', '@example.com', 'account_deletion'],
        ['an empty domain', 'owner@', 'account_deletion'],
        ['two @', 'owner@relay@example.com', 'account_deletion'],
        ['a CR/LF header injection', 'owner@example.com\r\nBcc: victim@example.com', 'account_deletion'],
        ['an embedded space', 'own er@example.com', 'account_deletion'],
        ['a right-to-left override', 'owner@exa\u202Emple.com', 'account_deletion'],
        ['an invisible zero-width space', 'owner@exa\u200Bmple.com', 'account_deletion'],
        ['a 200 KB local part', `${'a'.repeat(200 * 1024)}@example.com`, 'account_deletion'],
        ['a registration address register would refuse', 'owner+oauth@example.com', 'registration'],
    ])('B2: refuses %s as an email target with 400, stores nothing and sends nothing', async (_name, target, purpose) =>
    {
        const response = await post('/_auth/codes', { target, targetType: 'email', purpose });
        await settleLinkMail();

        expect(response.status).toBe(400);
        expect(sendEmail).not.toHaveBeenCalled();
        expect(await getTestDb().select().from(verificationCodes)).toHaveLength(0);
    });
});
