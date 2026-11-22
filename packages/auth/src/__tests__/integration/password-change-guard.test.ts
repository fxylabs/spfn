/**
 * @spfn/auth - the app's seat inside a password change (#434)
 *
 * `createAuthLifecycle({ passwordChange: { admit, changed } })` runs inside the
 * transaction that writes the new password, under the account lock, on the two
 * paths that clear `passwordChangeRequired`: `PUT /_auth/password` and a
 * completed reset. `auth.password.changed` is published after the change commits.
 *
 * | Row | Checks | Unnoticed without it |
 * | --- | --- | --- |
 * | G1 | a refusing `admit` is 403 `PasswordChangeRefusedError` with the app's code; the old password still signs in, the new one does not, the flag stays set, `changed` is not told | a refusal asked after the write, or ignored: an expired temporary password is exchanged for a real one |
 * | G2 | a throwing `changed` is 500 `PasswordChangeHookFailedError` carrying none of the hook's text; the old password still signs in, the flag stays, the hook's own row is gone, no `auth.password.changed` | `changed` run after the commit: the change stands and the app's "set up" row is missing, with the address in the 500 |
 * | G3 | `admit` and `changed` see `required: true` on a flagged account's change and `false` on its next one, `channel: 'change'` | `required` read after the flag was cleared, or not at all: the app cannot tell a first set-up from an ordinary change |
 * | G4 | the hook's own repository write commits with the change | the app's write lands outside the change's transaction or is dropped |
 * | G5 | `auth.password.changed` arrives once, after the commit (an observer connection already reads the flag cleared), with `required` | an event published inside the transaction: a notice for a change a reader cannot see, or that rolls back |
 * | G6 | a reset of a flagged account is asked with `channel: 'reset'`: a refusal keeps the old password and the flag, and the same setup session completes once admitted; no `auth.password.changed` | a reset clearing the flag without the app's say — the set-up guard bypassed through the link |
 * | G7 | registration and invitation acceptance, which write a password and set no flag, never ask the guard | a creation path asked as a change, with a `user` that does not exist yet to the app |
 * | G8 | a throwing `admit` is 500 `PasswordChangeHookFailedError` carrying none of the hook's text; the old password still signs in, the flag stays, `changed` is not told | `admit` called outside `runHook`: its error reaches the error handler as itself, the hook's text and the address with it |
 *
 * No secret, code or key value here is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { userInvitations, userProfiles, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { hashCredential } from '@/server/lib/link-credentials';
import { generateKeyPair, generateClientToken, type KeyPair } from '@/server/lib/crypto';
import {
    configurePasswordChange,
    resetPasswordChangeGuardForTests,
    type PasswordChangeAdmission,
    type PasswordChangeAttempt,
} from '@/server/lib/password-change-guard';

const sendEmail = vi.fn().mockResolvedValue({ success: true });

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return { ...actual, sendEmail: (...args: unknown[]) => sendEmail(...args) };
});

const { Hono: HonoApp } = await import('hono');
const { BaseRepository, runInTransaction } = await import('@spfn/core/db');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { mainAuthRouter } = await import('@/server/routes');
const { authenticate } = await import('@/server/middleware/authenticate');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { createVerifiedAccount } = await import('@/server/services/auth.service');
const { acceptInvitation } = await import('@/server/services/invitation.service');
const { settleLinkMail } = await import('@/server/lib/link-mail-delivery');
const { authPasswordChangedEvent } = await import('@/server/events');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const EMAIL = 'temporary@pcg434.test';
const PASSWORD = 'TemporaryPassword123!';
const NEW_PASSWORD = 'ChosenPassword456!';
const SECOND_PASSWORD = 'AnotherPassword789!';
const INVITATION_TOKEN = '33333333-3333-4333-8333-333333333333';

/** The app's own row a hook writes, as an app does: a repository extending `BaseRepository`. */
class SetupRepository extends BaseRepository
{
    async markSetUp(userId: number): Promise<void>
    {
        await this.db.insert(userProfiles).values({ userId, displayName: 'set up' });
    }
}

const setups = new SetupRepository();

/** What each hook was handed, in order. */
const seen: Array<{ hook: 'admit' | 'changed'; userId: number; required: boolean; channel: string }> = [];

/** Each row's behaviour; the functions configured once below delegate to these. */
let admitWith: (attempt: PasswordChangeAttempt) => PasswordChangeAdmission | Promise<PasswordChangeAdmission>;
let changedWith: (attempt: PasswordChangeAttempt) => void | Promise<void>;

function record(hook: 'admit' | 'changed', { user, required, channel }: PasswordChangeAttempt): void
{
    seen.push({ hook, userId: user.id, required, channel });
}

/** The package's routes behind the global `authenticate`, as core assembles them. */
function mountApp(): Hono
{
    const app = new HonoApp();

    registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
    app.onError(ErrorHandler());

    return app;
}

describe.skipIf(!dbAvailable)('the password-change guard (#434)', () =>
{
    let app: Hono;
    let observer: ReturnType<typeof postgres>;
    let userId: number;
    let ipCounter = 0;
    let unsubscribe: () => void;
    let changedEvents: Array<{ userId: string; required: boolean; flagAtEvent: boolean }>;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';
        process.env.SPFN_APP_URL = 'https://app.example.com';

        configurePasswordChange({
            admit: (attempt) =>
            {
                record('admit', attempt);

                return admitWith(attempt);
            },
            changed: async (attempt) =>
            {
                record('changed', attempt);
                await changedWith(attempt);
            },
        });

        app = mountApp();
        // `setupTestDb` points DATABASE_URL at the test database.
        observer = postgres(process.env.DATABASE_URL!, { max: 1 });
        await observer`select 1`;
    });

    afterAll(async () =>
    {
        resetPasswordChangeGuardForTests();
        await observer.end();
        delete process.env.SPFN_APP_URL;
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        seen.length = 0;
        admitWith = () => undefined;
        changedWith = () => undefined;
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

        changedEvents = [];
        unsubscribe = authPasswordChangedEvent.subscribe(async (payload) =>
        {
            const [{ flag }] = await observer<Array<{ flag: boolean }>>`
                select password_change_required as flag from spfn_auth.users where id = ${userId}`;
            changedEvents.push({ ...payload, flagAtEvent: flag });
        });
    });

    afterEach(() =>
    {
        unsubscribe();
    });

    // ========================================================================
    // Harness
    // ========================================================================

    async function request(method: string, path: string, body: unknown, authorization?: string): Promise<Response>
    {
        ipCounter += 1;
        const response = await app.request(path, {
            method,
            headers: {
                ...JSON_HEADERS,
                'x-forwarded-for': `198.51.100.${ipCounter % 250}`,
                ...authorization ? { Authorization: authorization } : {},
            },
            body: JSON.stringify(body),
        });
        await settleLinkMail();

        return response;
    }

    function deviceKey(keyPair: KeyPair = generateKeyPair('ES256'))
    {
        return { publicKey: keyPair.publicKey, keyId: keyPair.keyId, fingerprint: keyPair.fingerprint, algorithm: keyPair.algorithm };
    }

    /** A password sign-in with a fresh key: its status, and the Authorization header of its session. */
    async function signIn(password: string): Promise<{ status: number; authorization: string }>
    {
        const keyPair = generateKeyPair('ES256');
        const response = await request('POST', '/_auth/login', { email: EMAIL, password, ...deviceKey(keyPair) });
        const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' });

        return { status: response.status, authorization: `Bearer ${token}` };
    }

    async function changePassword(currentPassword: string, newPassword: string): Promise<Response>
    {
        const session = await signIn(currentPassword);
        expect(session.status).toBe(200);

        return request('PUT', '/_auth/password', { currentPassword, newPassword }, session.authorization);
    }

    async function flag(): Promise<boolean>
    {
        const [row] = await getTestDb().select({ flag: users.passwordChangeRequired }).from(users).where(eq(users.id, userId));

        return row!.flag;
    }

    async function setUpRows(): Promise<number>
    {
        return (await getTestDb().select().from(userProfiles).where(eq(userProfiles.userId, userId))).length;
    }

    /** Let the after-commit queue drain: the runner fires it without awaiting. */
    async function settled(): Promise<void>
    {
        await new Promise((resolve) => setTimeout(resolve, 30));
    }

    /** A reset link asked for, mailed and confirmed: the setup secret it hands out. */
    async function openResetSession(): Promise<string>
    {
        expect((await request('POST', '/_auth/password/reset', { email: EMAIL })).status).toBe(200);
        const mail = sendEmail.mock.calls.filter(([arg]) => arg?.template === 'password-reset').at(-1)!;
        const token = new URL(mail[0].data.confirmUrl).searchParams.get('token')!;
        const confirmed = await request('POST', '/_auth/password/reset/confirm', { token });
        expect(confirmed.status).toBe(200);

        return (await confirmed.json()).setupSecret;
    }

    // ========================================================================
    // Rows
    // ========================================================================

    it('G1: a refusing admit is 403 with the app\'s code, and nothing is written', async () =>
    {
        admitWith = () => ({ refuse: { code: 'TEMPORARY_PASSWORD_EXPIRED' } });

        const refused = await changePassword(PASSWORD, NEW_PASSWORD);
        const body = await refused.json();

        expect(refused.status, JSON.stringify(body)).toBe(403);
        expect(body.error.code).toBe('PasswordChangeRefusedError');
        expect(body.details.code).toBe('TEMPORARY_PASSWORD_EXPIRED');
        expect(await flag()).toBe(true);
        expect((await signIn(PASSWORD)).status).toBe(200);
        expect((await signIn(NEW_PASSWORD)).status).toBe(401);
        expect(seen.map(call => call.hook)).toEqual(['admit']);
    });

    it('G2: a throwing changed rolls the change and the hook\'s own row back, and says nothing the hook said', async () =>
    {
        changedWith = async ({ user }) =>
        {
            await setups.markSetUp(user.id);

            throw new Error(`could not finish the set-up of ${user.email}`);
        };

        const failed = await changePassword(PASSWORD, NEW_PASSWORD);
        const text = await failed.text();
        await settled();

        expect(failed.status, text).toBe(500);
        expect(JSON.parse(text).error.code).toBe('PasswordChangeHookFailedError');
        expect(text).not.toContain(EMAIL);
        expect(await flag()).toBe(true);
        expect(await setUpRows()).toBe(0);
        expect((await signIn(PASSWORD)).status).toBe(200);
        expect((await signIn(NEW_PASSWORD)).status).toBe(401);
        expect(changedEvents).toEqual([]);
    });

    it('G3: both hooks see required true on the flagged change and false on the next one', async () =>
    {
        expect((await changePassword(PASSWORD, NEW_PASSWORD)).status).toBe(204);
        expect((await changePassword(NEW_PASSWORD, SECOND_PASSWORD)).status).toBe(204);

        expect(seen).toEqual([
            { hook: 'admit', userId, required: true, channel: 'change' },
            { hook: 'changed', userId, required: true, channel: 'change' },
            { hook: 'admit', userId, required: false, channel: 'change' },
            { hook: 'changed', userId, required: false, channel: 'change' },
        ]);
    });

    it('G4: the hook\'s own repository write commits with the change', async () =>
    {
        changedWith = async ({ user, required }) =>
        {
            if (required)
            {
                await setups.markSetUp(user.id);
            }
        };

        expect((await changePassword(PASSWORD, NEW_PASSWORD)).status).toBe(204);

        expect(await setUpRows()).toBe(1);
        expect(await flag()).toBe(false);
    });

    it('G5: auth.password.changed arrives once, after the commit, with required', async () =>
    {
        expect((await changePassword(PASSWORD, NEW_PASSWORD)).status).toBe(204);
        await settled();

        expect(changedEvents).toEqual([{ userId: String(userId), required: true, flagAtEvent: false }]);
    });

    it('G6: a reset is asked as channel reset; a refusal keeps the old password and the flag, and the setup session completes once admitted', async () =>
    {
        admitWith = () => ({ refuse: { code: 'TEMPORARY_PASSWORD_EXPIRED' } });
        const setupSecret = await openResetSession();

        const refused = await request('POST', '/_auth/password/reset/complete', { setupSecret, password: NEW_PASSWORD, ...deviceKey() });
        const body = await refused.json();

        expect(refused.status, JSON.stringify(body)).toBe(403);
        expect(body.error.code).toBe('PasswordChangeRefusedError');
        expect(await flag()).toBe(true);
        expect((await signIn(PASSWORD)).status).toBe(200);

        admitWith = () => undefined;
        const completed = await request('POST', '/_auth/password/reset/complete', { setupSecret, password: NEW_PASSWORD, ...deviceKey() });
        await settled();

        expect(completed.status).toBe(200);
        expect(await flag()).toBe(false);
        expect(seen).toEqual([
            { hook: 'admit', userId, required: true, channel: 'reset' },
            { hook: 'admit', userId, required: true, channel: 'reset' },
            { hook: 'changed', userId, required: true, channel: 'reset' },
        ]);
        expect(changedEvents).toEqual([]);
    });

    it('G7: registration and invitation acceptance never ask the guard', async () =>
    {
        await runInTransaction(() => createVerifiedAccount({
            email: 'registered@pcg434.test',
            password: PASSWORD,
            ...deviceKey(),
            channel: 'register',
        }));

        const [inviter] = await getTestDb().insert(users).values({
            email: 'inviter@pcg434.test',
            roleId: (await getRoleByName('admin'))!.id,
            emailVerifiedAt: new Date(),
        }).returning({ id: users.id });
        await getTestDb().insert(userInvitations).values({
            email: 'invited@pcg434.test',
            tokenHash: hashCredential(INVITATION_TOKEN),
            roleId: (await getRoleByName('user'))!.id,
            invitedBy: inviter!.id,
            status: 'pending',
            expiresAt: new Date(Date.now() + 86_400_000),
        });
        await runInTransaction(() => acceptInvitation({ token: INVITATION_TOKEN, password: PASSWORD, ...deviceKey() }));

        expect(await getTestDb().select({ id: users.id }).from(users)).toHaveLength(4);
        expect(seen).toEqual([]);
    });

    it('G8: a throwing admit is 500 PasswordChangeHookFailedError, says nothing the hook said, and nothing is written', async () =>
    {
        admitWith = ({ user }) =>
        {
            throw new Error(`could not look up the temporary password of ${user.email}`);
        };

        const failed = await changePassword(PASSWORD, NEW_PASSWORD);
        const text = await failed.text();

        expect(failed.status, text).toBe(500);
        expect(JSON.parse(text).error.code).toBe('PasswordChangeHookFailedError');
        expect(text).not.toContain(EMAIL);
        expect(await flag()).toBe(true);
        expect((await signIn(PASSWORD)).status).toBe(200);
        expect((await signIn(NEW_PASSWORD)).status).toBe(401);
        expect(seen.map(call => call.hook)).toEqual(['admit']);
    });
});
