/**
 * The code routes answer alike whether or not an address has an account
 * (au4-A4, au4-B2).
 *
 * The "account exists" notice window used to be a never-sent code row, and the
 * verify route read it like a code: its attempt count survived a resend that,
 * for an address without an account, started a fresh code. Send, five wrong
 * guesses, send, one wrong guess answered "invalid code" for a stranger's
 * address and "too many attempts" for a customer's.
 *
 * The send itself waited for the mail provider when it sent a code and not when
 * the address had an account and the notice window was open, so how long it
 * took said which one it was (a12f1-F4). Neither branch waits for delivery now.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { users, verificationCodes } from '@/server/entities';

const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail,
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
const WITH_ACCOUNT = 'owner@example.com';
const WITHOUT_ACCOUNT = 'stranger@example.com';

type Step = { status: number; body: unknown };

describe.skipIf(!dbAvailable)('T3: the code routes do not tell an address with an account from one without', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';

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

        const userRole = await getRoleByName('user');
        await getTestDb().insert(users).values({ email: WITH_ACCOUNT, roleId: userRole!.id, emailVerifiedAt: new Date() });
    });

    /** Status and body, with what differs per request (instants, request ids) made comparable. */
    async function step(path: string, body: unknown): Promise<Step>
    {
        const response = await app.request(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
        const text = (await response.text())
            .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<instant>')
            .replace(/"requestId":"[0-9a-f]+"/g, '"requestId":"<id>"');

        return { status: response.status, body: JSON.parse(text) };
    }

    function send(target: string): Promise<Step>
    {
        return step('/_auth/codes', { target, targetType: 'email', purpose: 'registration' });
    }

    /** A six-digit guess that is not the code stored for the address. */
    async function wrongGuess(target: string): Promise<Step>
    {
        const [row] = await getTestDb().select({ code: verificationCodes.code }).from(verificationCodes)
            .where(and(eq(verificationCodes.target, target), eq(verificationCodes.purpose, 'registration')))
            .orderBy(desc(verificationCodes.id))
            .limit(1);
        const code = row?.code === '000000' ? '111111' : '000000';

        return step('/_auth/codes/verify', { target, targetType: 'email', code, purpose: 'registration' });
    }

    async function sendFiveWrongSendWrong(target: string): Promise<Step[]>
    {
        const steps = [await send(target)];

        for (let guess = 0; guess < 5; guess++)
        {
            steps.push(await wrongGuess(target));
        }

        steps.push(await send(target), await wrongGuess(target));

        return steps;
    }

    it('answers send, five wrong codes, send, one wrong code identically', async () =>
    {
        expect(await sendFiveWrongSendWrong(WITH_ACCOUNT)).toEqual(await sendFiveWrongSendWrong(WITHOUT_ACCOUNT));
    });

    it('answers a send for either address before the provider is released', async () =>
    {
        let release!: () => void;
        const released = new Promise<void>((resolve) =>
        {
            release = resolve;
        });
        sendEmail.mockImplementation(async () =>
        {
            await released;

            return { success: true };
        });

        const PROVIDER_HELD = 'still waiting on the provider';
        const answered = (target: string) => Promise.race([
            send(target).then(({ status }) => status),
            new Promise(resolve => setTimeout(resolve, 2_000, PROVIDER_HELD)),
        ]);

        expect(await answered(WITH_ACCOUNT)).toBe(200);
        expect(await answered(WITHOUT_ACCOUNT)).toBe(200);
        await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(2));

        release();
    });
});
