/**
 * @spfn/auth - Link Mail Delivery Integration Tests
 *
 * One `it` per row of the case table in the feature's design: T for the request
 * path, W for the worker, D for the delivery mode, G for the confirm-path guard
 * a pending row has to survive.
 *
 * What the rows are really asserting is that the request no longer pays for the
 * mail. An address with an account and an address without one both leave the
 * endpoint after the same database work, and everything that used to make them
 * take different amounts of time now happens in `auth.link-mail`.
 *
 * The fake boss. `getBoss` is mocked so the delivery mode can be driven from a
 * test, and `linkMailJob.send` is pointed at the same fake: the real `.send()`
 * resolves `getBoss` inside `@spfn/core`'s own bundle, which a module mock in
 * this package cannot reach. `drainLinkMail()` then plays the captured payloads
 * back through the real handler, which is what a worker does.
 */

import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { passwordResetTokens, signupLinkTokens, users, verificationCodes } from '@/server/entities';
import { generateKeyPair } from '@/server/lib/crypto';
import { hashPassword } from '@/server/helpers/password';
import type { LinkMailPayload } from '@/server/jobs/link-mail';

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

const { boss, bossState } = vi.hoisted(() => ({
    boss: { send: vi.fn() },
    bossState: { present: true },
}));

vi.mock('@spfn/core/job', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/core/job')>();

    return {
        ...actual,
        getBoss: () => (bossState.present ? boss : null),
    };
});

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { linkMailJob } = await import('@/server/jobs/link-mail');
const { resetLinkMailFallbackWarning } = await import('@/server/lib/link-mail-delivery');
const { authLogger } = await import('@/server/logger');

// See the file comment: the definition's own `send` would reach for the real
// pg-boss, so the enqueue is pointed at the fake the `getBoss` mock hands out.
linkMailJob.send = (async (payload: LinkMailPayload) =>
    await boss.send(linkMailJob.name, payload)) as typeof linkMailJob.send;

// `JobDef['run']` is a conditional type on the payload, and a payload that is a
// union distributes it into three call signatures TypeScript will not let a
// caller choose between. There is one job and one payload type.
const runLinkMail = linkMailJob.run as (payload: LinkMailPayload) => Promise<void>;

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'SecurePassword123!';
const NEW_PASSWORD = 'BrandNewPassword456!';

describe.skipIf(!dbAvailable)('Link mail delivery', () =>
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
        sendEmail.mockReset();
        sendEmail.mockResolvedValue({ success: true });
        sendSMS.mockReset();
        sendSMS.mockResolvedValue({ success: true });
        boss.send.mockReset();
        boss.send.mockResolvedValue('job-1');
        bossState.present = true;
        delete process.env.SPFN_AUTH_LINK_MAIL_DELIVERY;
        resetLinkMailFallbackWarning();
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

    // ========================================================================
    // The queue, faked
    // ========================================================================

    /** Payloads handed to the queue since the last drain, in order. */
    function enqueued(): LinkMailPayload[]
    {
        return boss.send.mock.calls.map(([, payload]) => payload as LinkMailPayload);
    }

    /** Run every queued job the way a worker would, oldest first. */
    async function drainLinkMail(): Promise<void>
    {
        const payloads = enqueued();
        boss.send.mockClear();

        for (const payload of payloads)
        {
            await runLinkMail(payload);
        }
    }

    // ========================================================================
    // Accounts, rows and the credentials the mail carries
    // ========================================================================

    /** The account shape the reset flow is built for: active, address proved. */
    async function seedResettable(email: string)
    {
        const userRole = await getRoleByName('user');
        const [row] = await getTestDb().insert(users).values({
            email,
            passwordHash: await hashPassword(PASSWORD),
            emailVerifiedAt: new Date(),
            status: 'active',
            roleId: userRole!.id,
        }).returning();

        return row;
    }

    function resetRows(email: string)
    {
        return getTestDb().select().from(passwordResetTokens)
            .where(eq(passwordResetTokens.email, email))
            .orderBy(passwordResetTokens.id);
    }

    function signupRows(email: string)
    {
        return getTestDb().select().from(signupLinkTokens)
            .where(eq(signupLinkTokens.email, email))
            .orderBy(signupLinkTokens.id);
    }

    function templatesSent(): string[]
    {
        return sendEmail.mock.calls.map(([arg]) => arg?.template);
    }

    /** The token from the most recent mail of a template, as the user would see it. */
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

    /** The stored form of an emailed token — the only form the database holds. */
    function hashOf(token: string): string
    {
        return crypto.createHash('sha256').update(token).digest('base64url');
    }

    function completeBody(setupSecret: string, password = NEW_PASSWORD)
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

    /** Warnings this feature emitted, ignoring the service logger's other users. */
    function fallbackWarnings(calls: unknown[][]): unknown[][]
    {
        return calls.filter(([message]) => String(message).includes('auth.link-mail'));
    }

    /**
     * The "sent nothing, answered anyway" lines, ignoring the email logger's other
     * users — the issue functions log a refused send of their own before throwing.
     */
    function inlineSendErrors(calls: unknown[][]): unknown[][]
    {
        return calls.filter(([message]) => String(message) === 'Link mail was not sent on the request path');
    }

    /** Everything a log call would show, flattened, so a row can assert what it omits. */
    function loggedText(call: unknown[]): string
    {
        return JSON.stringify(call, (_key, value) => (value instanceof Error ? value.message : value));
    }

    // ========================================================================
    // T — the request path
    // ========================================================================

    describe('T — what a request does', () =>
    {
        it('row T1: an eligible reset writes a token-less row, queues the mail and sends none', async () =>
        {
            await seedResettable('t1@example.com');

            const response = await post('/_auth/password/reset', { email: 't1@example.com' });

            expect(response.status).toBe(200);
            expect((await response.json()).success).toBe(true);

            const rows = await resetRows('t1@example.com');
            expect(rows).toHaveLength(1);
            expect(rows[0].tokenHash).toBeNull();

            expect(enqueued()).toEqual([{ kind: 'password-reset', rowId: rows[0].id }]);
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('row T2: an address with no account answers the same and queues nothing', async () =>
        {
            await seedResettable('t2-known@example.com');

            const known = await post('/_auth/password/reset', { email: 't2-known@example.com' });
            boss.send.mockClear();

            const unknown = await post('/_auth/password/reset', { email: 't2-unknown@example.com' });

            expect(unknown.status).toBe(known.status);
            expect(Object.keys(await unknown.json()).sort()).toEqual(Object.keys(await known.json()).sort());
            expect(await resetRows('t2-unknown@example.com')).toHaveLength(0);
            expect(enqueued()).toEqual([]);
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('row T3: a new signup address writes a token-less row and queues the link', async () =>
        {
            const response = await post('/_auth/signup/email', { email: 't3@example.com' });

            expect(response.status).toBe(200);

            const rows = await signupRows('t3@example.com');
            expect(rows).toHaveLength(1);
            expect(rows[0].tokenHash).toBeNull();

            expect(enqueued()).toEqual([{ kind: 'signup-link', rowId: rows[0].id }]);
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('row T4: an existing signup address queues the owner notice and sends none', async () =>
        {
            await seedResettable('t4@example.com');

            const response = await post('/_auth/signup/email', { email: 't4@example.com' });

            expect(response.status).toBe(200);
            expect(enqueued()).toEqual([
                { kind: 'account-exists', target: 't4@example.com', targetType: 'email' },
            ]);
            expect(sendEmail).not.toHaveBeenCalled();

            // The dedupe window is bookkeeping, and bookkeeping stays on the request.
            const notices = await getTestDb().select().from(verificationCodes)
                .where(and(
                    eq(verificationCodes.target, 't4@example.com'),
                    eq(verificationCodes.purpose, 'registration'),
                ));
            expect(notices).toHaveLength(1);
        });

        it('row T4: a second request inside the window queues nothing', async () =>
        {
            await seedResettable('t4-window@example.com');

            await post('/_auth/signup/email', { email: 't4-window@example.com' });
            boss.send.mockClear();

            const second = await post('/_auth/signup/email', { email: 't4-window@example.com' });

            expect(second.status).toBe(200);
            expect(enqueued()).toEqual([]);
        });

        it('row T5: a second reset before the worker ran supersedes the first and queues both', async () =>
        {
            await seedResettable('t5@example.com');

            await post('/_auth/password/reset', { email: 't5@example.com' });
            await post('/_auth/password/reset', { email: 't5@example.com' });

            const rows = await resetRows('t5@example.com');
            expect(rows).toHaveLength(2);
            expect(rows[0].supersededAt).not.toBeNull();
            expect(rows[1].supersededAt).toBeNull();
            expect(rows[1].tokenHash).toBeNull();

            expect(enqueued()).toEqual([
                { kind: 'password-reset', rowId: rows[0].id },
                { kind: 'password-reset', rowId: rows[1].id },
            ]);
        });
    });

    // ========================================================================
    // W — the worker
    // ========================================================================

    describe('W — what the worker does', () =>
    {
        it('row W1: a pending reset row is issued, mailed, and the link then confirms', async () =>
        {
            await seedResettable('w1@example.com');
            await post('/_auth/password/reset', { email: 'w1@example.com' });

            await drainLinkMail();

            expect(templatesSent()).toEqual(['password-reset']);

            const token = emailedToken('password-reset');
            const [row] = await resetRows('w1@example.com');
            expect(row.tokenHash).toBe(hashOf(token));
            expect(row.tokenHash).not.toBe(token);

            const confirm = await post('/_auth/password/reset/confirm', { token });
            expect(confirm.status).toBe(200);
        });

        it('row W2: a pending signup row is issued, mailed, and the link then confirms', async () =>
        {
            await post('/_auth/signup/email', { email: 'w2@example.com' });

            await drainLinkMail();

            expect(templatesSent()).toEqual(['signup-link']);

            const token = emailedToken('signup-link');
            const [row] = await signupRows('w2@example.com');
            expect(row.tokenHash).toBe(hashOf(token));

            const confirm = await post('/_auth/signup/email/confirm', { token });
            expect(confirm.status).toBe(200);
        });

        it('row W3: a row superseded before the worker ran gets no hash and no mail', async () =>
        {
            await seedResettable('w3@example.com');
            await post('/_auth/password/reset', { email: 'w3@example.com' });
            await post('/_auth/password/reset', { email: 'w3@example.com' });

            const [supersededJob] = enqueued();
            await runLinkMail(supersededJob);

            const rows = await resetRows('w3@example.com');
            expect(rows[0].tokenHash).toBeNull();
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('row W4: a row expired before the worker ran gets no hash and no mail', async () =>
        {
            await seedResettable('w4@example.com');
            await post('/_auth/password/reset', { email: 'w4@example.com' });

            const [row] = await resetRows('w4@example.com');
            await getTestDb().update(passwordResetTokens)
                .set({ expiresAt: new Date(Date.now() - 60_000) })
                .where(eq(passwordResetTokens.id, row.id));

            await drainLinkMail();

            expect((await resetRows('w4@example.com'))[0].tokenHash).toBeNull();
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('row W5: a refused send throws, and the retry mints a link that replaces the first', async () =>
        {
            await seedResettable('w5@example.com');
            await post('/_auth/password/reset', { email: 'w5@example.com' });
            const [payload] = enqueued();

            sendEmail.mockResolvedValueOnce({ success: false, error: 'provider refused' });
            await expect(runLinkMail(payload)).rejects.toThrow('password-reset row');

            const firstToken = emailedToken('password-reset');
            await runLinkMail(payload);
            const secondToken = emailedToken('password-reset');

            expect(sendEmail).toHaveBeenCalledTimes(2);
            expect(secondToken).not.toBe(firstToken);
            expect((await resetRows('w5@example.com'))[0].tokenHash).toBe(hashOf(secondToken));

            expect((await post('/_auth/password/reset/confirm', { token: firstToken })).status).toBe(401);
            expect((await post('/_auth/password/reset/confirm', { token: secondToken })).status).toBe(200);
        });

        it('row W6: an account-exists payload sends the owner notice once', async () =>
        {
            await runLinkMail({ kind: 'account-exists', target: 'w6@example.com', targetType: 'email' });

            expect(templatesSent()).toEqual(['account-exists']);
            expect(sendEmail.mock.calls[0][0].to).toBe('w6@example.com');
        });

        it('row W7: an unknown kind is refused and sends nothing', async () =>
        {
            await expect(runLinkMail({ kind: 'welcome' } as unknown as LinkMailPayload))
                .rejects.toThrow('unknown payload kind');
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('row W7: a link payload with no rowId is refused and sends nothing', async () =>
        {
            await expect(runLinkMail({ kind: 'signup-link' } as unknown as LinkMailPayload))
                .rejects.toThrow('carries no rowId');
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('row W7: nothing the worker enqueues or mails carries the credential', async () =>
        {
            await seedResettable('w7-payload@example.com');
            await post('/_auth/password/reset', { email: 'w7-payload@example.com' });

            expect(JSON.stringify(enqueued())).not.toMatch(/token|secret|https?:/i);
        });
    });

    // ========================================================================
    // D — the delivery mode
    // ========================================================================

    describe('D — who sends the mail', () =>
    {
        it('row D1: with no pg-boss, auto sends on the request and issues the row there', async () =>
        {
            bossState.present = false;
            await seedResettable('d1@example.com');

            const response = await post('/_auth/password/reset', { email: 'd1@example.com' });

            expect(response.status).toBe(200);
            expect(templatesSent()).toEqual(['password-reset']);
            expect(boss.send).not.toHaveBeenCalled();

            const [row] = await resetRows('d1@example.com');
            expect(row.tokenHash).toBe(hashOf(emailedToken('password-reset')));
        });

        it('row D2: with pg-boss up and the queue in place, auto queues and sends nothing', async () =>
        {
            await seedResettable('d2@example.com');

            await post('/_auth/password/reset', { email: 'd2@example.com' });

            expect(boss.send).toHaveBeenCalledTimes(1);
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('row D3: a queue nobody registered falls back to an inline send and warns once', async () =>
        {
            const warn = vi.spyOn(authLogger.service, 'warn');
            boss.send.mockRejectedValue(new Error('Queue auth.link-mail does not exist'));
            await seedResettable('d3-a@example.com');
            await seedResettable('d3-b@example.com');

            const first = await post('/_auth/password/reset', { email: 'd3-a@example.com' });
            const second = await post('/_auth/password/reset', { email: 'd3-b@example.com' });

            expect(first.status).toBe(200);
            expect(second.status).toBe(200);
            expect(templatesSent()).toEqual(['password-reset', 'password-reset']);

            const warnings = fallbackWarnings(warn.mock.calls);
            expect(warnings).toHaveLength(1);
            expect(String(warnings[0])).toContain('authJobRouter');

            warn.mockRestore();
        });

        it('row D4: queued mode never falls back — the enqueue failure surfaces', async () =>
        {
            process.env.SPFN_AUTH_LINK_MAIL_DELIVERY = 'queued';
            boss.send.mockRejectedValue(new Error('Queue auth.link-mail does not exist'));
            await seedResettable('d4@example.com');

            const response = await post('/_auth/password/reset', { email: 'd4@example.com' });

            expect(response.status).toBe(500);
            expect(sendEmail).not.toHaveBeenCalled();
        });

        it('row D5: inline mode sends on the request even with pg-boss up', async () =>
        {
            process.env.SPFN_AUTH_LINK_MAIL_DELIVERY = 'inline';
            await seedResettable('d5@example.com');

            const response = await post('/_auth/password/reset', { email: 'd5@example.com' });

            expect(response.status).toBe(200);
            expect(templatesSent()).toEqual(['password-reset']);
            expect(boss.send).not.toHaveBeenCalled();
        });

        it('row D7: an enqueue that failed for another reason surfaces instead of hiding', async () =>
        {
            const warn = vi.spyOn(authLogger.service, 'warn');
            boss.send.mockRejectedValue(new Error('connection terminated unexpectedly'));
            await seedResettable('d7@example.com');

            const response = await post('/_auth/password/reset', { email: 'd7@example.com' });

            expect(response.status).toBe(500);
            expect(sendEmail).not.toHaveBeenCalled();
            expect(fallbackWarnings(warn.mock.calls)).toHaveLength(0);

            warn.mockRestore();
        });

        it('row D8: inline mode, a refused send is logged and the request still answers 200', async () =>
        {
            process.env.SPFN_AUTH_LINK_MAIL_DELIVERY = 'inline';
            const error = vi.spyOn(authLogger.email, 'error');
            sendEmail.mockResolvedValue({ success: false, error: 'provider refused' });
            await seedResettable('d8@example.com');

            const response = await post('/_auth/password/reset', { email: 'd8@example.com' });

            expect(response.status).toBe(200);
            expect((await response.json()).success).toBe(true);

            // The row is issued before the send is attempted, so the hash is
            // written and the link in the mail that never left is the live one.
            const [row] = await resetRows('d8@example.com');
            expect(row.tokenHash).not.toBeNull();

            const logged = inlineSendErrors(error.mock.calls);
            expect(logged).toHaveLength(1);
            expect(logged[0][1]).toMatchObject({ kind: 'password-reset', rowId: row.id });
            expect(loggedText(logged[0])).not.toMatch(/d8@example\.com|https?:/i);

            error.mockRestore();
        });

        it('row D9: with no pg-boss, a send that throws is logged and the request still answers 200', async () =>
        {
            bossState.present = false;
            const error = vi.spyOn(authLogger.email, 'error');
            sendEmail.mockRejectedValue(new Error('smtp connection reset'));
            await seedResettable('d9@example.com');

            const response = await post('/_auth/password/reset', { email: 'd9@example.com' });

            expect(response.status).toBe(200);
            expect(boss.send).not.toHaveBeenCalled();

            const logged = inlineSendErrors(error.mock.calls);
            expect(logged).toHaveLength(1);
            expect(logged[0][1]).toMatchObject({ kind: 'password-reset' });

            error.mockRestore();
        });

        it('row D10: the missing-queue fallback that then fails to send warns once and logs once', async () =>
        {
            const warn = vi.spyOn(authLogger.service, 'warn');
            const error = vi.spyOn(authLogger.email, 'error');
            boss.send.mockRejectedValue(new Error('Queue auth.link-mail does not exist'));
            sendEmail.mockResolvedValue({ success: false, error: 'provider refused' });
            await seedResettable('d10@example.com');

            const response = await post('/_auth/password/reset', { email: 'd10@example.com' });

            expect(response.status).toBe(200);
            expect(fallbackWarnings(warn.mock.calls)).toHaveLength(1);
            expect(inlineSendErrors(error.mock.calls)).toHaveLength(1);

            warn.mockRestore();
            error.mockRestore();
        });

        it('row D11: the worker still throws on a refused send, so pg-boss retries', async () =>
        {
            await seedResettable('d11@example.com');
            await post('/_auth/password/reset', { email: 'd11@example.com' });
            const [payload] = enqueued();

            sendEmail.mockResolvedValue({ success: false, error: 'provider refused' });

            await expect(runLinkMail(payload)).rejects.toThrow('password-reset row');
        });

        it('row D12: inline mode, a provider outage answers eligible and ineligible alike', async () =>
        {
            process.env.SPFN_AUTH_LINK_MAIL_DELIVERY = 'inline';
            sendEmail.mockResolvedValue({ success: false, error: 'provider refused' });
            await seedResettable('d12-known@example.com');

            // `expiresAt` is `now + TTL` in both branches, so freezing the clock is
            // what makes "identical arithmetic" testable as "identical bytes".
            const now = vi.spyOn(Date, 'now')
                .mockReturnValue(new Date('2026-09-07T12:00:00.000Z').getTime());

            const known = await post('/_auth/password/reset', { email: 'd12-known@example.com' });
            const unknown = await post('/_auth/password/reset', { email: 'd12-unknown@example.com' });

            expect(known.status).toBe(200);
            expect(unknown.status).toBe(known.status);
            expect(await unknown.text()).toBe(await known.text());

            now.mockRestore();
        });
    });

    // ========================================================================
    // G — the confirm path, while a row is still pending
    // ========================================================================

    describe('G — a row with no token yet', () =>
    {
        it('row G1: a reset link cannot be confirmed before the worker issued it', async () =>
        {
            await seedResettable('g1@example.com');
            await post('/_auth/password/reset', { email: 'g1@example.com' });

            const response = await post('/_auth/password/reset/confirm', {
                token: crypto.randomBytes(32).toString('base64url'),
            });

            expect(response.status).toBe(401);
            expect((await resetRows('g1@example.com'))[0].tokenHash).toBeNull();
        });

        it('row G1: a signup link cannot be confirmed before the worker issued it', async () =>
        {
            await post('/_auth/signup/email', { email: 'g1-signup@example.com' });

            const response = await post('/_auth/signup/email/confirm', {
                token: crypto.randomBytes(32).toString('base64url'),
            });

            // The signup flow answers an unknown token with 400 and the reset flow
            // with 401; a pending row is refused as the unknown token it looks like
            // — a null hash matches no lookup — not as a state of its own.
            expect(response.status).toBe(400);
            expect((await signupRows('g1-signup@example.com'))[0].tokenHash).toBeNull();
        });

        it('row G2: the whole signup completes through the queue', async () =>
        {
            await post('/_auth/signup/email', { email: 'g2-signup@example.com' });
            await drainLinkMail();

            const confirm = await post('/_auth/signup/email/confirm', { token: emailedToken('signup-link') });
            expect(confirm.status).toBe(200);

            const complete = await post('/_auth/signup/password', completeBody((await confirm.json()).setupSecret));
            expect(complete.status).toBe(200);

            const [row] = await signupRows('g2-signup@example.com');
            expect(row.completedAt).not.toBeNull();
        });

        it('row G2: the whole reset completes through the queue', async () =>
        {
            await seedResettable('g2-reset@example.com');
            await post('/_auth/password/reset', { email: 'g2-reset@example.com' });
            await drainLinkMail();

            const confirm = await post('/_auth/password/reset/confirm', { token: emailedToken('password-reset') });
            expect(confirm.status).toBe(200);

            const complete = await post('/_auth/password/reset/complete', completeBody((await confirm.json()).setupSecret));
            expect(complete.status).toBe(200);

            const [row] = await resetRows('g2-reset@example.com');
            expect(row.completedAt).not.toBeNull();
        });
    });
});
