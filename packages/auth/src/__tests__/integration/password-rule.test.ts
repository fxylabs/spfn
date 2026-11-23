/**
 * @spfn/auth - one password rule, on every path that writes a password (#458)
 *
 * `createAuthLifecycle({ password: { validate } })` is asked before the hash is
 * computed on every path that writes one, and never inside a transaction. A
 * refusal is 400 `ValidationError` with the rule's messages on the password
 * field; a throw is 500 `PasswordRuleFailedError`; no rule is `PasswordSchema`
 * alone.
 *
 * | Row | Checks | Unnoticed without it |
 * | --- | --- | --- |
 * | P1 | the issue's repro: a temporary password, then `PUT /_auth/password` with a password the rule refuses is 400 `ValidationError` with the rule's message on `/newPassword` and no `value`; the temporary password still signs in, the refused one does not, the flag stays; the rule saw `channel: 'change'` and the account's identifiers | the change path never asks the rule: a flagged account swaps its temporary password for `aaaaaaaa` (204) |
 * | P2 | a change with a wrong current password and a refused new one answers the rule's 400, not 401 | the rule asked after the current password is checked: a stolen session learns a guessed current password is right from which refusal comes back, without changing anything |
 * | P3 | a reset completion with a refused password is 400 on `/password`, the flag and the old password stay, and the same setup session completes with an accepted one; the rule saw `channel: 'reset'` | the reset path skips the rule: the link sets a password the app refuses, forever |
 * | P4 | a reset completion for an account suspended since the link was confirmed answers the rule's 400 to a refused password, as for an active one | the rule asked after the account is read: its answer (400 vs the session refusal) tells whether the account is still there |
 * | P5 | `POST /_auth/register` with a refused password is the rule's 400 and creates no account; the rule saw `channel: 'register'`, the address and `userId: null` | the register route skips the rule: it creates accounts with a password the app refuses, forever |
 * | P6 | `POST /_auth/invitations/accept` with a refused password is the rule's 400, creates no account and leaves the invitation pending; it is then accepted with an accepted one | the invitation route skips the rule |
 * | P7 | admin seeding with a password the rule refuses creates no account; configured with an empty phone, the rule is asked about the null the row would store | a seeded temporary password the app refuses signs into a superadmin account; or the rule judges a phone (`''`) other than the one stored |
 * | P8 | `hashNewPassword` — the app's own writer — refuses with the rule's message | an operator-issued password skips the rule |
 * | P9 | a throwing rule is 500 `PasswordRuleFailedError` carrying none of its text, and the password is unchanged | a throw read as "no messages": the password the rule could not judge is accepted |
 * | P10 | with no rule, `PUT /_auth/password` accepts `aaaaaaaa` (204) | a default rule (`validatePasswordStrength`) switched on: every app without a rule starts refusing passwords it accepted |
 * | P11 | `POST /_auth/signup/password` with a refused password is the rule's 400 and creates no account; the same setup session then completes with an accepted one | the signup-link route skips the rule: the verified-email signup creates accounts with a password the app refuses |
 * | P12 | the rule's refusal carries the message a `PasswordSchema` failure of the same route carries (`Invalid request body`) | the two 400s of one field read differently (`Invalid body`), and a client keyed on the message treats the rule's as something else |
 * | P13 | while the rule runs on `POST /_auth/invitations/accept`, the invitation, its role and the inviter's account can each be locked `NOWAIT` from another connection, and no backend is idle in transaction | the rule asked after the claim: a slow rule holds the claimed invitation and the role (a second acceptance and every change to the role wait), and one past the transaction's idle timeout is a driver 500 instead of the rule's answer |
 * | P14 | while the rule runs on `POST /_auth/register`, `/_auth/signup/password`, `/_auth/password/reset/complete`, `PUT /_auth/password` and admin seeding, no backend is idle in transaction, and each completes | a transaction around the rule (route-wide, or the service's): a slow rule keeps a pooled connection for its whole duration, and past the idle timeout the request is a driver 500 |
 * | P15 | an invitation acceptance whose inviter's role changes under the judgement is judged again and accepted, the rule asked once | the rule asked inside the judged transaction: the retry asks it twice — a second breached-password lookup, and a rule that counts attempts counts two |
 * | P16 | a reset or signup-link setup session that expires while the rule runs is refused by the claim: the old password stays, no account is created | the session found live before the rule is trusted after it: a rule slow past the session's expiry completes a reset or a signup on an expired session |
 * | P17 | `POST /_auth/invitations/accept` with a token that names no invitation is 404, with one that names an expired or a cancelled invitation 410, and the rule is asked about none of them | the unlocked read before the rule refuses nothing: every bogus or stale token costs the app's rule (a breached-password lookup over the network) before the claim refuses it |
 * | P18 | a connection lost under `POST /_auth/register`, `/_auth/signup/password` and `/_auth/password/reset/complete` — the latter two on the read before the service's transaction — reaches `reportDatabaseError` | the routes without `Transactional()` report nothing: a dead pool behind them never counts toward the forced reconnect, and they answer 500 until something else trips it |
 * | P19 | a reset or signup-link setup session already used, superseded or expired is refused (`PasswordResetSessionError`, `InvalidSignupSetupSessionError`) and the rule is asked about neither | the read before the rule stops refusing a used, superseded or expired session: each such request costs the app's rule before the claim refuses it |
 * | P20 | `POST /_auth/register` with a verification token that does not verify, or that proved another address, is refused (`InvalidVerificationTokenError`, `VerificationTokenTargetMismatchError`) and the rule is not asked | the rule asked before the token is checked: any forged token, or one proven for the caller's own address, costs the app's rule for an address nobody proved |
 *
 * No secret, code or key value here is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { ValidationError } from '@spfn/core/errors';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { passwordResetTokens, roles, signupLinkTokens, userInvitations, users, verificationCodes } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { hashCredential } from '@/server/lib/link-credentials';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import {
    configurePasswordRule,
    resetPasswordRuleForTests,
    type PasswordRuleAnswer,
    type PasswordRuleSubject,
} from '@/server/lib/password-rule';

const sendEmail = vi.fn().mockResolvedValue({ success: true });

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return { ...actual, sendEmail: (...args: unknown[]) => sendEmail(...args) };
});

/** Every error handed to the reconnect trigger; the real one is not called, so no pool is rebuilt under the rows. */
const reported = vi.fn();

vi.mock('@spfn/core/db', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/core/db')>();

    return { ...actual, reportDatabaseError: (error: unknown) => reported(error) };
});

const { Hono: HonoApp } = await import('hono');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { mainAuthRouter } = await import('@/server/routes');
const { authenticate } = await import('@/server/middleware/authenticate');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { usersRepository, passwordResetTokensRepository, signupLinkTokensRepository } = await import('@/server/repositories');
const { hashNewPassword } = await import('@/server/services/password-rule.service');
const { ensureAdminExists } = await import('@/server/setup');
const { settleLinkMail } = await import('@/server/lib/link-mail-delivery');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const EMAIL = 'temporary@rule458.test';
const PASSWORD = 'TemporaryPassword123!';
const WEAK = 'aaaaaaaa';
const CHOSEN = 'ChosenPassword456!';
const RULE_MESSAGE = 'Use at least one digit';
const INVITATION_TOKEN = '44444444-4444-4444-8444-444444444444';
const INVITED = 'invited@rule458.test';
const INVITER = 'inviter@rule458.test';

/** Every subject the rule was asked about, in order. */
const asked: PasswordRuleSubject[] = [];

/** The rule each row states; the function configured once below delegates to it. */
let ruleWith: (password: string) => PasswordRuleAnswer | Promise<PasswordRuleAnswer>;

/** Refuses a password without a digit — `aaaaaaaa` among them. */
function digitRule(password: string): PasswordRuleAnswer
{
    return /\d/.test(password) ? undefined : [RULE_MESSAGE];
}

/** The package's routes behind the global `authenticate`, as core assembles them. */
function mountApp(): Hono
{
    const app = new HonoApp();

    registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
    app.onError(ErrorHandler());

    return app;
}

describe.skipIf(!dbAvailable)('the password rule (#458)', () =>
{
    let app: Hono;
    let userId: number;
    let ipCounter = 0;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_VERIFICATION_TOKEN_SECRET = 'test-verification-token-secret-min-32-chars';
        process.env.SPFN_APP_URL = 'https://app.example.com';
        app = mountApp();
    });

    afterAll(async () =>
    {
        resetPasswordRuleForTests();
        delete process.env.SPFN_APP_URL;
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        asked.length = 0;
        ruleWith = digitRule;
        resetPasswordRuleForTests();
        configurePasswordRule({
            validate: (password, subject) =>
            {
                asked.push(subject);

                return ruleWith(password);
            },
        });
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

    function deviceKey()
    {
        const { publicKey, keyId, fingerprint, algorithm } = generateKeyPair('ES256');

        return { publicKey, keyId, fingerprint, algorithm };
    }

    /** A password sign-in with a fresh key: its status, and the Authorization header of its session. */
    async function signIn(password: string): Promise<{ status: number; authorization: string }>
    {
        const keyPair = generateKeyPair('ES256');
        const { publicKey, keyId, fingerprint, algorithm } = keyPair;
        const response = await request('POST', '/_auth/login', { email: EMAIL, password, publicKey, keyId, fingerprint, algorithm });
        const token = generateClientToken({ keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' });

        return { status: response.status, authorization: `Bearer ${token}` };
    }

    async function changePassword(currentPassword: string, newPassword: string): Promise<Response>
    {
        const session = await signIn(PASSWORD);
        expect(session.status).toBe(200);

        return request('PUT', '/_auth/password', { currentPassword, newPassword }, session.authorization);
    }

    async function flag(): Promise<boolean>
    {
        const [row] = await getTestDb().select({ flag: users.passwordChangeRequired }).from(users).where(eq(users.id, userId));

        return row!.flag;
    }

    async function accountsNamed(email: string): Promise<number>
    {
        return (await getTestDb().select({ id: users.id }).from(users).where(eq(users.email, email))).length;
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

    /** The answer is the rule's refusal: 400 `ValidationError`, its message on `path`, nothing of the password. */
    async function expectRuleRefusal(response: Response, path: string): Promise<void>
    {
        const text = await response.text();
        const body = JSON.parse(text);

        expect(response.status, text).toBe(400);
        expect(body.error.code).toBe('ValidationError');
        expect(body.fields).toEqual([{ path, message: RULE_MESSAGE }]);
        expect(text).not.toContain(WEAK);
    }

    /** A registration verification token for `email`, through the six-digit-code flow. */
    async function registrationToken(email: string): Promise<string>
    {
        await request('POST', '/_auth/codes', { target: email, targetType: 'email', purpose: 'registration' });
        const [row] = await getTestDb().select().from(verificationCodes)
            .where(and(eq(verificationCodes.target, email), eq(verificationCodes.purpose, 'registration')))
            .orderBy(desc(verificationCodes.createdAt))
            .limit(1);
        const verified = await request('POST', '/_auth/codes/verify', { target: email, targetType: 'email', code: row!.code, purpose: 'registration' });
        expect(verified.status).toBe(200);

        return (await verified.json()).verificationToken;
    }

    async function register(email: string, password: string): Promise<Response>
    {
        return request('POST', '/_auth/register', { email, verificationToken: await registrationToken(email), password, ...deviceKey() });
    }

    /** A signup link asked for, mailed and confirmed: the setup secret it hands out. */
    async function openSignupSession(email: string): Promise<string>
    {
        expect((await request('POST', '/_auth/signup/email', { email })).status).toBe(200);
        const mail = sendEmail.mock.calls.filter(([arg]) => arg?.template === 'signup-link').at(-1)!;
        const token = new URL(mail[0].data.confirmUrl).searchParams.get('token')!;
        const confirmed = await request('POST', '/_auth/signup/email/confirm', { token });
        expect(confirmed.status).toBe(200);

        return (await confirmed.json()).setupSecret;
    }

    /** A pending invitation to `INVITED` for the `user` role, sent by an admin: its id. */
    async function invite(): Promise<number>
    {
        const [inviter] = await getTestDb().insert(users).values({
            email: INVITER,
            roleId: (await getRoleByName('admin'))!.id,
            emailVerifiedAt: new Date(),
        }).returning({ id: users.id });
        const [invitation] = await getTestDb().insert(userInvitations).values({
            email: INVITED,
            tokenHash: hashCredential(INVITATION_TOKEN),
            roleId: (await getRoleByName('user'))!.id,
            invitedBy: inviter!.id,
            status: 'pending',
            expiresAt: new Date(Date.now() + 86_400_000),
        }).returning({ id: userInvitations.id });

        return Number(invitation!.id);
    }

    async function acceptInvitation(password: string): Promise<Response>
    {
        return request('POST', '/_auth/invitations/accept', { token: INVITATION_TOKEN, password, ...deviceKey() });
    }

    /** Whether another connection can take the lock `query` asks for at once: `free`, or the SQLSTATE it got (55P03). */
    async function lockFromOutside(query: SQL): Promise<string>
    {
        return getTestDb().execute(query).then(
            () => 'free',
            (error: { code?: string; cause?: { code?: string } }) => error.cause?.code ?? error.code ?? 'failed',
        );
    }

    /** Backends of this database waiting inside an open transaction. */
    async function idleInTransaction(): Promise<number>
    {
        const [row] = await getTestDb().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND state = 'idle in transaction'`);

        return Number(row!.n);
    }

    async function expectRuleRejection(promise: Promise<unknown>, path: string): Promise<void>
    {
        const error = await promise.then(() => null, (thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).fields).toEqual([{ path, message: RULE_MESSAGE }]);
    }

    // ========================================================================
    // Rows
    // ========================================================================

    it('P1: a temporary password cannot be replaced by one the rule refuses', async () =>
    {
        await expectRuleRefusal(await changePassword(PASSWORD, WEAK), '/newPassword');

        expect(await flag()).toBe(true);
        expect((await signIn(PASSWORD)).status).toBe(200);
        expect((await signIn(WEAK)).status).toBe(401);
        expect(asked).toEqual([{ channel: 'change', userId, email: EMAIL, phone: null }]);
    });

    it('P2: a wrong current password with a refused new one gets the rule\'s answer, not the credential\'s', async () =>
    {
        await expectRuleRefusal(await changePassword('NotTheCurrentPassword1!', WEAK), '/newPassword');
    });

    it('P3: a reset is held to the rule, and the setup session completes once the password is accepted', async () =>
    {
        const setupSecret = await openResetSession();

        await expectRuleRefusal(
            await request('POST', '/_auth/password/reset/complete', { setupSecret, password: WEAK, ...deviceKey() }),
            '/password',
        );
        expect(await flag()).toBe(true);
        expect((await signIn(PASSWORD)).status).toBe(200);

        const completed = await request('POST', '/_auth/password/reset/complete', { setupSecret, password: CHOSEN, ...deviceKey() });

        expect(completed.status, await completed.clone().text()).toBe(200);
        expect(await flag()).toBe(false);
        expect(asked).toEqual([
            { channel: 'reset', userId, email: EMAIL, phone: null },
            { channel: 'reset', userId, email: EMAIL, phone: null },
        ]);
    });

    it('P4: on a reset the rule answers alike whether the account is still active', async () =>
    {
        const setupSecret = await openResetSession();
        await getTestDb().update(users).set({ status: 'suspended' }).where(eq(users.id, userId));

        await expectRuleRefusal(
            await request('POST', '/_auth/password/reset/complete', { setupSecret, password: WEAK, ...deviceKey() }),
            '/password',
        );
    });

    it('P5: the register route creates no account with a password the rule refuses', async () =>
    {
        const email = 'registered@rule458.test';

        await expectRuleRefusal(await register(email, WEAK), '/password');
        expect(await accountsNamed(email)).toBe(0);
        expect(asked).toEqual([{ channel: 'register', userId: null, email, phone: null }]);
    });

    it('P6: the invitation route accepts no password the rule refuses, and the invitation stays pending', async () =>
    {
        const invitationId = await invite();

        await expectRuleRefusal(await acceptInvitation(WEAK), '/password');
        expect(await accountsNamed(INVITED)).toBe(0);
        const [pending] = await getTestDb().select().from(userInvitations).where(eq(userInvitations.id, invitationId));
        expect(pending!.status).toBe('pending');

        const accepted = await acceptInvitation(CHOSEN);

        expect(accepted.status, await accepted.clone().text()).toBe(200);
        expect(await accountsNamed(INVITED)).toBe(1);
        expect(asked).toEqual([
            { channel: 'invitation', userId: null, email: INVITED, phone: null },
            { channel: 'invitation', userId: null, email: INVITED, phone: null },
        ]);
    });

    it('P7: admin seeding creates no account with a password the rule refuses', async () =>
    {
        process.env.SPFN_AUTH_ADMIN_ACCOUNTS = JSON.stringify([{ email: 'seeded@rule458.test', phone: '', password: WEAK, role: 'superadmin' }]);

        try
        {
            await ensureAdminExists();
        }
        finally
        {
            delete process.env.SPFN_AUTH_ADMIN_ACCOUNTS;
        }

        expect(await accountsNamed('seeded@rule458.test')).toBe(0);
        expect(asked).toEqual([{ channel: 'seed', userId: null, email: 'seeded@rule458.test', phone: null }]);
    });

    it('P8: hashNewPassword, the app\'s own writer, is held to the rule', async () =>
    {
        await expectRuleRejection(hashNewPassword(WEAK, { userId }), '/password');
        expect(asked).toEqual([{ channel: 'operator', userId, email: null, phone: null }]);
    });

    it('P9: a throwing rule is a 500 that says nothing it said, and the password is unchanged', async () =>
    {
        ruleWith = () =>
        {
            throw new Error(`deny list unreachable while judging ${EMAIL}`);
        };

        const failed = await changePassword(PASSWORD, CHOSEN);
        const text = await failed.text();

        expect(failed.status, text).toBe(500);
        expect(JSON.parse(text).error.code).toBe('PasswordRuleFailedError');
        expect(text).not.toContain(EMAIL);
        expect(text).not.toContain(CHOSEN);
        expect(await flag()).toBe(true);
        expect((await signIn(CHOSEN)).status).toBe(401);
    });

    it('P10: with no rule, a new password is held to PasswordSchema alone', async () =>
    {
        resetPasswordRuleForTests();

        expect((await changePassword(PASSWORD, WEAK)).status).toBe(204);
        expect((await signIn(WEAK)).status).toBe(200);
    });

    it('P11: the signup-link route creates no account with a password the rule refuses, and the session completes once it accepts one', async () =>
    {
        const email = 'linked@rule458.test';
        const setupSecret = await openSignupSession(email);

        await expectRuleRefusal(
            await request('POST', '/_auth/signup/password', { setupSecret, password: WEAK, ...deviceKey() }),
            '/password',
        );
        expect(await accountsNamed(email)).toBe(0);

        const completed = await request('POST', '/_auth/signup/password', { setupSecret, password: CHOSEN, ...deviceKey() });

        expect(completed.status, await completed.clone().text()).toBe(200);
        expect(await accountsNamed(email)).toBe(1);
        expect(asked).toEqual([
            { channel: 'signup-link', userId: null, email, phone: null },
            { channel: 'signup-link', userId: null, email, phone: null },
        ]);
    });

    it('P12: the rule\'s refusal says what a PasswordSchema failure of the same route says', async () =>
    {
        const email = 'message@rule458.test';
        const schema = await register(email, 'Short1!');
        const rule = await register(email, WEAK);
        const schemaBody = await schema.json();
        const ruleBody = await rule.json();

        expect(schema.status).toBe(400);
        expect(schemaBody.fields.map((field: { path: string }) => field.path)).toEqual(['/password']);
        expect(rule.status).toBe(400);
        expect(ruleBody.fields).toEqual([{ path: '/password', message: RULE_MESSAGE }]);
        expect(ruleBody.error.message).toBe(schemaBody.error.message);
    });

    it('P13: while the rule runs on an invitation, nothing is locked and no transaction is open', async () =>
    {
        const invitationId = await invite();
        const roleId = (await getRoleByName('user'))!.id;
        const seen: Record<string, string | number> = {};
        ruleWith = async () =>
        {
            seen.invitation = await lockFromOutside(sql`SELECT 1 FROM ${userInvitations} WHERE ${userInvitations.id} = ${invitationId} FOR UPDATE NOWAIT`);
            seen.role = await lockFromOutside(sql`SELECT 1 FROM ${roles} WHERE ${roles.id} = ${roleId} FOR UPDATE NOWAIT`);
            seen.inviter = await lockFromOutside(sql`SELECT 1 FROM ${users} WHERE ${users.email} = ${INVITER} FOR NO KEY UPDATE NOWAIT`);
            seen.idleInTransaction = await idleInTransaction();

            return undefined;
        };

        const accepted = await acceptInvitation(CHOSEN);

        expect(accepted.status, await accepted.clone().text()).toBe(200);
        expect(seen).toEqual({ invitation: 'free', role: 'free', inviter: 'free', idleInTransaction: 0 });
    });

    it('P14: while the rule runs on register, the signup link, a reset, a change and seeding, no transaction is open', async () =>
    {
        const idle: number[] = [];
        ruleWith = async () =>
        {
            idle.push(await idleInTransaction());

            return undefined;
        };

        const registered = await register('opened@rule458.test', CHOSEN);
        expect(registered.status, await registered.clone().text()).toBe(200);

        const linked = await request('POST', '/_auth/signup/password', {
            setupSecret: await openSignupSession('linked@rule458.test'),
            password: CHOSEN,
            ...deviceKey(),
        });
        expect(linked.status, await linked.clone().text()).toBe(200);

        const reset = await request('POST', '/_auth/password/reset/complete', { setupSecret: await openResetSession(), password: CHOSEN, ...deviceKey() });
        expect(reset.status, await reset.clone().text()).toBe(200);

        const session = await signIn(CHOSEN);
        const changed = await request('PUT', '/_auth/password', { currentPassword: CHOSEN, newPassword: 'AnotherChosen789!' }, session.authorization);
        expect(changed.status, await changed.clone().text()).toBe(204);

        process.env.SPFN_AUTH_ADMIN_ACCOUNTS = JSON.stringify([{ email: 'seeded@rule458.test', password: CHOSEN, role: 'superadmin' }]);
        await ensureAdminExists().finally(() => delete process.env.SPFN_AUTH_ADMIN_ACCOUNTS);
        expect(await accountsNamed('seeded@rule458.test')).toBe(1);

        expect(asked.map(subject => subject.channel)).toEqual(['register', 'signup-link', 'reset', 'change', 'seed']);
        expect(idle).toEqual([0, 0, 0, 0, 0]);
    });

    it('P15: an invitation judged again after its inviter\'s role moved asks the rule once', async () =>
    {
        await invite();
        const superadminRole = (await getRoleByName('superadmin'))!.id;
        const findAuthority = usersRepository.findAuthorityOnPrimary.bind(usersRepository);
        let movedUnderJudgement = false;
        const stale = vi.spyOn(usersRepository, 'findAuthorityOnPrimary').mockImplementationOnce(async (id) =>
        {
            const read = await findAuthority(id);
            await getTestDb().update(users).set({ roleId: superadminRole }).where(eq(users.email, INVITER));
            movedUnderJudgement = true;

            return read;
        });

        const accepted = await acceptInvitation(CHOSEN).finally(() => stale.mockRestore());

        expect(accepted.status, await accepted.clone().text()).toBe(200);
        expect(movedUnderJudgement).toBe(true);
        expect(asked.map(subject => subject.channel)).toEqual(['invitation']);
    });

    it('P16: a setup session that expires while the rule runs is refused by the claim', async () =>
    {
        const expire = (table: typeof passwordResetTokens | typeof signupLinkTokens) => async () =>
        {
            await getTestDb().update(table).set({ setupExpiresAt: new Date(Date.now() - 1000) });

            return undefined;
        };

        const resetSecret = await openResetSession();
        ruleWith = expire(passwordResetTokens);
        const reset = await request('POST', '/_auth/password/reset/complete', { setupSecret: resetSecret, password: CHOSEN, ...deviceKey() });

        expect((await reset.json()).error?.code).toBe('PasswordResetSessionError');
        expect((await signIn(PASSWORD)).status).toBe(200);

        const email = 'expired@rule458.test';
        const signupSecret = await openSignupSession(email);
        ruleWith = expire(signupLinkTokens);
        const linked = await request('POST', '/_auth/signup/password', { setupSecret: signupSecret, password: CHOSEN, ...deviceKey() });

        expect((await linked.json()).error?.code).toBe('InvalidSignupSetupSessionError');
        expect(await accountsNamed(email)).toBe(0);
        expect(asked.map(subject => subject.channel)).toEqual(['reset', 'signup-link']);
    });

    it('P17: unknown, expired and cancelled invitation tokens are refused before the rule is asked', async () =>
    {
        const unknown = await request('POST', '/_auth/invitations/accept', { token: '55555555-5555-4555-8555-555555555555', password: WEAK, ...deviceKey() });
        expect(unknown.status, await unknown.clone().text()).toBe(404);

        const invitationId = await invite();
        await getTestDb().update(userInvitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(userInvitations.id, invitationId));
        const expired = await acceptInvitation(WEAK);
        expect(expired.status, await expired.clone().text()).toBe(410);

        await getTestDb().update(userInvitations).set({ status: 'cancelled', expiresAt: new Date(Date.now() + 86_400_000) }).where(eq(userInvitations.id, invitationId));
        const cancelled = await acceptInvitation(WEAK);

        expect(cancelled.status, await cancelled.clone().text()).toBe(410);
        expect(asked).toEqual([]);
    });

    it('P18: register, the signup link and a reset hand a lost connection to the reconnect trigger', async () =>
    {
        const lost = () => Object.assign(new Error('connection ended'), { code: 'CONNECTION_ENDED' });

        const email = 'lost@rule458.test';
        const verificationToken = await registrationToken(email);
        const signupSecret = await openSignupSession('lost-link@rule458.test');
        const resetSecret = await openResetSession();
        reported.mockClear();

        const duringRegister = lost();
        const duplicateCheck = vi.spyOn(usersRepository, 'findByFoldedEmail').mockRejectedValueOnce(duringRegister);
        const registered = await request('POST', '/_auth/register', { email, verificationToken, password: CHOSEN, ...deviceKey() })
            .finally(() => duplicateCheck.mockRestore());

        const duringSignup = lost();
        const signupRead = vi.spyOn(signupLinkTokensRepository, 'findBySetupSecretHash').mockRejectedValueOnce(duringSignup);
        const linked = await request('POST', '/_auth/signup/password', { setupSecret: signupSecret, password: CHOSEN, ...deviceKey() })
            .finally(() => signupRead.mockRestore());

        const duringReset = lost();
        const resetRead = vi.spyOn(passwordResetTokensRepository, 'findLiveSetupBySecretHash').mockRejectedValueOnce(duringReset);
        const reset = await request('POST', '/_auth/password/reset/complete', { setupSecret: resetSecret, password: CHOSEN, ...deviceKey() })
            .finally(() => resetRead.mockRestore());

        expect([registered.status, linked.status, reset.status]).toEqual([500, 500, 500]);
        const handed = reported.mock.calls.map(([error]) => error);
        expect([duringRegister, duringSignup, duringReset].map(error => handed.includes(error))).toEqual([true, true, true]);
    });

    it('P19: a used, superseded or expired setup session is refused before the rule is asked', async () =>
    {
        const now = new Date();
        const spoiled = [{ completedAt: now }, { supersededAt: now }, { setupExpiresAt: new Date(Date.now() - 1000) }];

        // Each session is spoiled and presented before the next is opened: opening one supersedes the one before.
        const resetRefusals: string[] = [];
        for (const spoil of spoiled)
        {
            const setupSecret = await openResetSession();
            await getTestDb().update(passwordResetTokens).set(spoil).where(eq(passwordResetTokens.setupSecretHash, hashCredential(setupSecret)));
            const reset = await request('POST', '/_auth/password/reset/complete', { setupSecret, password: CHOSEN, ...deviceKey() });
            resetRefusals.push((await reset.json()).error?.code);
        }

        const signupRefusals: string[] = [];
        for (const spoil of spoiled)
        {
            const setupSecret = await openSignupSession('spoiled@rule458.test');
            await getTestDb().update(signupLinkTokens).set(spoil).where(eq(signupLinkTokens.setupSecretHash, hashCredential(setupSecret)));
            const linked = await request('POST', '/_auth/signup/password', { setupSecret, password: CHOSEN, ...deviceKey() });
            signupRefusals.push((await linked.json()).error?.code);
        }

        expect(resetRefusals).toEqual(Array(3).fill('PasswordResetSessionError'));
        expect(signupRefusals).toEqual(Array(3).fill('InvalidSignupSetupSessionError'));
        expect(asked).toEqual([]);
    });

    it('P20: a register with a token that does not prove the address is refused before the rule is asked', async () =>
    {
        const forged = await request('POST', '/_auth/register', { email: 'forged@rule458.test', verificationToken: 'not-a-token', password: CHOSEN, ...deviceKey() });
        const borrowed = await request('POST', '/_auth/register', { email: 'victim@rule458.test', verificationToken: await registrationToken('caller@rule458.test'), password: CHOSEN, ...deviceKey() });

        expect([(await forged.json()).error?.code, (await borrowed.json()).error?.code]).toEqual(['InvalidVerificationTokenError', 'VerificationTokenTargetMismatchError']);
        expect(asked).toEqual([]);
    });
});
