/**
 * @spfn/auth - the app's seat inside a passkey's enrolment and revocation (#493)
 *
 * `createAuthLifecycle({ passkey: { enrolled, revoked } })` runs inside the
 * transaction that writes or revokes the passkey row, after that write and
 * before the commit, under the account lock — at three call sites:
 * registration (`keepPasskey`), the owner's removal (`revokePasskeyService`)
 * and the operator's reset (`resetSecondFactorService`). Each call site has a
 * row that the hook's own write commits with the act and one that it rolls
 * back with it.
 *
 * | Row | Checks | Unnoticed without it |
 * | --- | --- | --- |
 * | H1 | a throwing `enrolled` is 500 `PasskeyHookFailedError` (`hook: 'enrolled'`, `path: 'register'`) carrying none of the hook's text; no passkey row, the hook's own row gone, the challenge still live, no `auth.passkey.enrolled` | the defect of #493: `enrolled` told after the commit, or its throw swallowed — the passkey kept and the app's history row missing, with nothing to say so |
 * | H2 | `enrolled` is handed the event's payload, and its repository write commits with the passkey | a registration that never tells the hook, or tells it with another passkey's id: the app's row is missing or wrong while every route answers 200 |
 * | H3 | the owner's removal tells `revoked` with `reason: 'user'`; its write commits with the revocation | a removal that skips the hook: the history keeps no revocation and nothing fails |
 * | H4 | a throwing `revoked` on the owner's removal is 500 `PasskeyHookFailedError` (`path: 'revoke'`); the passkey is still live, the hook's row gone, no `auth.passkey.revoked` | `revoked` told after the route's commit: the passkey revoked and the app's row missing |
 * | H5 | the operator's reset of two passkeys tells `revoked` once per passkey, each with `reason: 'operator'`, and both writes commit with the reset | a reset revoking several passkeys that tells the hook once, or not at all: one revocation missing from the history, unnoticed |
 * | H6 | a throw on the reset's second passkey rejects `PasskeyHookFailedError` (`path: 'reset'`) and rolls the whole reset back, the first passkey's row included: both passkeys still live, no event | the reset's hook run outside its transaction: the passkeys revoked and the history holding one of two rows |
 * | H7 | application code calling `revokePasskeyService` from a route without `Transactional()`, the account-lock assertion off as in production: a throwing `revoked` is 500 and the passkey is still live, the hook's row gone | the service relying on its caller for the transaction: the revocation and the hook's row each autocommit behind a 500 saying the passkey is live, and `auth.passkey.revoked` is never published — the suite's lock assertion throws first and hides it |
 * | H8 | under a policy requiring a passkey, the account-lock assertion off as in production, a throwing `enrolled` that sees the passkey marked and the step-up recorded rolls both back with the passkey | the mark or the step-up written outside the act's transaction: an enrolled account, or a step-up window, for a passkey that does not exist |
 *
 * No secret, code or key value here is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { mfaVerifications, passkeys, users, webauthnChallenges } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { configurePasskeyHook, resetPasskeyHookForTests, type PasskeyRevocation } from '@/server/lib/passkey-hook';
import type { PasskeyEnrolledPayload } from '@/server/events';
import { __resetChannelsForTests, configureChannels } from '@/server/lib/channels-config';
import { __resetSecondFactorPolicyForTests, configureSecondFactor } from '@/server/lib/second-factor-policy';

const { Hono: HonoApp } = await import('hono');
const { BaseRepository } = await import('@spfn/core/db');
const { registerRoutes, route, defineRouter } = await import('@spfn/core/route');
const { Type } = await import('@sinclair/typebox');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { mainAuthRouter } = await import('@/server/routes');
const { authenticate } = await import('@/server/middleware/authenticate');
const { getAuth } = await import('@/server/helpers');
const { revokePasskeyService } = await import('@/server/services/passkey.service');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { resetSecondFactorService } = await import('@/server/services/mfa.service');
const { passkeyEnrolledEvent, passkeyRevokedEvent } = await import('@/server/events');
const { PasskeyHookFailedError } = await import('@spfn/auth/errors');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const EMAIL = 'owner@passkey-hook493.test';
const PASSWORD = 'Password123!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';

/** The app's own history, as an app keeps it: a repository extending `BaseRepository`. */
class HistoryRepository extends BaseRepository
{
    async add(userId: string, passkeyId: string, action: string): Promise<void>
    {
        await this.db.execute(sql`insert into passkey_hook_test.history (user_id, passkey_id, action)
            values (${Number(userId)}, ${passkeyId}, ${action})`);
    }

    /** What the act has written so far, read in its transaction: the passkey's mark and the account's step-ups. */
    async written(userId: string, passkeyId: string): Promise<{ marked: boolean; stepUps: number }>
    {
        const [passkey] = await this.db.select().from(passkeys).where(eq(passkeys.id, Number(passkeyId)));
        const stepUps = await this.db.select().from(mfaVerifications).where(eq(mfaVerifications.userId, Number(userId)));

        return { marked: passkey!.secondFactor, stepUps: stepUps.length };
    }
}

const history = new HistoryRepository();

/** Application code calling the exported service from a route of its own, without `Transactional()`. */
const appRouter = defineRouter({
    appRevoke: route.post('/app/passkeys/revoke')
        .input({ body: Type.Object({ passkeyId: Type.String() }) })
        .handler(async (c) =>
        {
            const { body } = await c.data();
            const { userId, credential } = getAuth(c);

            return await revokePasskeyService({ userId: Number(userId), credential, passkeyId: body.passkeyId });
        }),
});

/** What each hook was handed, in order. */
const seen: Array<{ hook: 'enrolled'; passkey: PasskeyEnrolledPayload } | { hook: 'revoked'; passkey: PasskeyRevocation }> = [];

/** Each row's behaviour; the functions configured once below delegate to these. */
let enrolledWith: (passkey: PasskeyEnrolledPayload) => Promise<void>;
let revokedWith: (passkey: PasskeyRevocation) => Promise<void>;

describe.skipIf(!dbAvailable)('the passkey hook (#493)', () =>
{
    let app: Hono;
    let userId: number;
    let enrolledEvents: unknown[];
    let revokedEvents: unknown[];
    let unsubscribe: Array<() => void>;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;

        configurePasskeyHook({
            enrolled: async (passkey) =>
            {
                seen.push({ hook: 'enrolled', passkey });
                await enrolledWith(passkey);
            },
            revoked: async (passkey) =>
            {
                seen.push({ hook: 'revoked', passkey });
                await revokedWith(passkey);
            },
        });

        app = new HonoApp();
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        registerRoutes(app, appRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());

        await getTestDb().execute(sql`drop schema if exists passkey_hook_test cascade`);
        await getTestDb().execute(sql`create schema passkey_hook_test`);
        await getTestDb().execute(sql`create table passkey_hook_test.history (
            id serial primary key, user_id bigint not null, passkey_id text not null, action text not null)`);
    });

    afterAll(async () =>
    {
        resetPasskeyHookForTests();
        await getTestDb().execute(sql`drop schema if exists passkey_hook_test cascade`);
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        seen.length = 0;
        enrolledWith = async () => undefined;
        revokedWith = async () => undefined;

        const db = getTestDb();
        await clearTables(db);
        await db.execute(sql`truncate passkey_hook_test.history`);
        await initializeAuth();
        resetMemoryRateLimitStore();

        const [row] = await db.insert(users).values({
            email: EMAIL,
            passwordHash: await hashPassword(PASSWORD),
            roleId: (await getRoleByName('user'))!.id,
            emailVerifiedAt: new Date(),
        }).returning({ id: users.id });
        userId = Number(row!.id);

        enrolledEvents = [];
        revokedEvents = [];
        unsubscribe = [
            passkeyEnrolledEvent.subscribe(payload => void enrolledEvents.push(payload)),
            passkeyRevokedEvent.subscribe(payload => void revokedEvents.push(payload)),
        ];
    });

    afterEach(() =>
    {
        unsubscribe.forEach(stop => stop());
        vi.unstubAllEnvs();
        __resetSecondFactorPolicyForTests();
        __resetChannelsForTests();
    });

    // ========================================================================
    // Harness
    // ========================================================================

    async function post(path: string, body: unknown, authorization: string): Promise<Response>
    {
        return await app.request(path, {
            method: 'POST',
            headers: { ...JSON_HEADERS, Authorization: authorization },
            body: JSON.stringify(body),
        });
    }

    /** A password sign-in: the authorization a fresh session signs its requests with. */
    async function signIn(): Promise<string>
    {
        const keyPair = generateKeyPair('ES256');
        const response = await app.request('/_auth/login', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
                email: EMAIL,
                password: PASSWORD,
                publicKey: keyPair.publicKey,
                keyId: keyPair.keyId,
                fingerprint: keyPair.fingerprint,
                algorithm: keyPair.algorithm,
            }),
        });

        expect(response.status).toBe(200);

        return `Bearer ${generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' })}`;
    }

    /** A full registration ceremony: the verify response. */
    async function enroll(authorization: string, label: string): Promise<Response>
    {
        const options = await post('/_auth/passkeys/register/options', {}, authorization);
        expect(options.status).toBe(200);
        const { challenge } = await options.json();
        const authenticator = await FixtureAuthenticator.create();

        return post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({ challenge, origin: ORIGIN, rpId: RP_ID }),
            label,
        }, authorization);
    }

    /** Enrol with the hook doing nothing, and forget what it saw: setup for the revocation rows. */
    async function enrolled(authorization: string, label: string): Promise<string>
    {
        const response = await enroll(authorization, label);
        expect(response.status).toBe(200);
        seen.length = 0;
        enrolledEvents.length = 0;
        await getTestDb().execute(sql`truncate passkey_hook_test.history`);

        return (await response.json()).passkeyId;
    }

    async function historyRows(): Promise<Array<{ passkey_id: string; action: string }>>
    {
        return [...await getTestDb().execute<{ passkey_id: string; action: string }>(
            sql`select passkey_id, action from passkey_hook_test.history order by passkey_id::bigint`,
        )];
    }

    async function passkeyRows()
    {
        return getTestDb().select().from(passkeys).where(eq(passkeys.userId, userId)).orderBy(passkeys.id);
    }

    /** The after-commit events have had their turn. */
    async function settled(): Promise<void>
    {
        await new Promise(resolve => setTimeout(resolve, 30));
    }

    // ========================================================================
    // Registration
    // ========================================================================

    it('H1: a throwing enrolled rolls the registration and the hook\'s own row back, and says nothing the hook said', async () =>
    {
        enrolledWith = async ({ userId: owner, passkeyId }) =>
        {
            await history.add(owner, passkeyId, 'enrolled');

            throw new Error(`no history for ${EMAIL}`);
        };

        const failed = await enroll(await signIn(), 'Laptop');
        const text = await failed.text();
        await settled();

        expect(failed.status, text).toBe(500);
        expect(JSON.parse(text).error.code).toBe('PasskeyHookFailedError');
        expect(text).not.toContain(EMAIL);
        expect(seen.map(call => call.hook)).toEqual(['enrolled']);
        expect(await passkeyRows()).toEqual([]);
        expect(await historyRows()).toEqual([]);
        expect((await getTestDb().select().from(webauthnChallenges).where(eq(webauthnChallenges.kind, 'registration')))
            .map(challenge => challenge.consumedAt)).toEqual([null]);
        expect(enrolledEvents).toEqual([]);
    });

    it('H8: a throwing enrolled rolls back the second-factor mark and the step-up the registration wrote', async () =>
    {
        configureChannels({ deviceCode: false, deviceLink: false });
        configureSecondFactor({ required: true, methods: ['passkey'], recoveryCodes: false });
        // As in production: the account-lock assertion would refuse a write made outside the act before this row could see it.
        vi.stubEnv('SPFN_AUTH_ASSERT_ACCOUNT_LOCK', '0');
        const inside: Array<{ marked: boolean; stepUps: number }> = [];
        enrolledWith = async ({ userId: owner, passkeyId }) =>
        {
            inside.push(await history.written(owner, passkeyId));

            throw new Error(`no history for ${EMAIL}`);
        };

        const failed = await enroll(await signIn(), 'Laptop');
        const text = await failed.text();

        expect(failed.status, text).toBe(500);
        expect(JSON.parse(text).error.code).toBe('PasskeyHookFailedError');
        expect(inside).toEqual([{ marked: true, stepUps: 1 }]);
        expect({
            passkeys: await passkeyRows(),
            stepUps: await getTestDb().select().from(mfaVerifications).where(eq(mfaVerifications.userId, userId)),
        }).toEqual({ passkeys: [], stepUps: [] });
    });

    it('H2: enrolled is handed the event\'s payload, and its write commits with the passkey', async () =>
    {
        enrolledWith = async ({ userId: owner, passkeyId }) => history.add(owner, passkeyId, 'enrolled');

        const response = await enroll(await signIn(), 'Laptop');
        await settled();

        expect(response.status).toBe(200);
        const { passkeyId } = await response.json();
        const payload = { userId: String(userId), passkeyId, label: 'Laptop' };
        expect(seen).toEqual([{ hook: 'enrolled', passkey: payload }]);
        expect(enrolledEvents).toEqual([payload]);
        expect(await historyRows()).toEqual([{ passkey_id: passkeyId, action: 'enrolled' }]);
        expect((await passkeyRows()).map(row => String(row.id))).toEqual([passkeyId]);
    });

    // ========================================================================
    // The owner's removal
    // ========================================================================

    it('H3: the owner\'s removal tells revoked with reason user, and its write commits with the revocation', async () =>
    {
        const authorization = await signIn();
        const passkeyId = await enrolled(authorization, 'Laptop');
        revokedWith = async ({ userId: owner, passkeyId: revoked, reason }) => history.add(owner, revoked, `revoked:${reason}`);

        const response = await post('/_auth/passkeys/revoke', { passkeyId }, authorization);
        await settled();

        expect(response.status).toBe(200);
        expect(seen).toEqual([{ hook: 'revoked', passkey: { userId: String(userId), passkeyId, reason: 'user' } }]);
        expect(await historyRows()).toEqual([{ passkey_id: passkeyId, action: 'revoked:user' }]);
        expect((await passkeyRows())[0]!.revokedAt).not.toBeNull();
        expect(revokedEvents).toEqual([{ userId: String(userId), passkeyId, reason: 'user' }]);
    });

    it('H4: a throwing revoked on the owner\'s removal keeps the passkey live and the hook\'s row out', async () =>
    {
        const authorization = await signIn();
        const passkeyId = await enrolled(authorization, 'Laptop');
        revokedWith = async ({ userId: owner, passkeyId: revoked }) =>
        {
            await history.add(owner, revoked, 'revoked');

            throw new Error(`no history for ${EMAIL}`);
        };

        const failed = await post('/_auth/passkeys/revoke', { passkeyId }, authorization);
        const text = await failed.text();
        await settled();

        expect(failed.status, text).toBe(500);
        expect(JSON.parse(text).error.code).toBe('PasskeyHookFailedError');
        expect(text).not.toContain(EMAIL);
        expect(await historyRows()).toEqual([]);
        expect((await passkeyRows())[0]!.revokedAt).toBeNull();
        expect(revokedEvents).toEqual([]);
    });

    it('H7: the service called by the application outside a transaction — a throwing revoked keeps the passkey live', async () =>
    {
        const authorization = await signIn();
        const passkeyId = await enrolled(authorization, 'Laptop');
        // As in production: the account-lock assertion is a test instrument (account-lock.ts) and would throw first.
        vi.stubEnv('SPFN_AUTH_ASSERT_ACCOUNT_LOCK', '0');
        revokedWith = async ({ userId: owner, passkeyId: revoked }) =>
        {
            await history.add(owner, revoked, 'revoked');

            throw new Error(`no history for ${EMAIL}`);
        };

        const failed = await post('/app/passkeys/revoke', { passkeyId }, authorization);
        const text = await failed.text();
        await settled();

        expect(failed.status, text).toBe(500);
        expect(JSON.parse(text).error.code).toBe('PasskeyHookFailedError');
        expect({ history: await historyRows(), revokedAt: (await passkeyRows())[0]!.revokedAt })
            .toEqual({ history: [], revokedAt: null });
    });

    // ========================================================================
    // The operator's reset
    // ========================================================================

    it('H5: the operator\'s reset tells revoked once per passkey, reason operator, and both writes commit with it', async () =>
    {
        const authorization = await signIn();
        const first = await enrolled(authorization, 'Laptop');
        const second = await enrolled(authorization, 'Phone');
        revokedWith = async ({ userId: owner, passkeyId, reason }) => history.add(owner, passkeyId, `revoked:${reason}`);

        await resetSecondFactorService(userId);
        await settled();

        const revocations = [first, second].map(passkeyId => ({ userId: String(userId), passkeyId, reason: 'operator' }));
        expect(seen.map(call => call.passkey).sort(byPasskeyId)).toEqual(revocations);
        expect(await historyRows()).toEqual([
            { passkey_id: first, action: 'revoked:operator' },
            { passkey_id: second, action: 'revoked:operator' },
        ]);
        expect((await passkeyRows()).every(row => row.revokedAt !== null)).toBe(true);
        expect((revokedEvents as typeof revocations).sort(byPasskeyId)).toEqual(revocations);
    });

    it('H6: a throw on the reset\'s second passkey rolls the whole reset back, the first one\'s row included', async () =>
    {
        const authorization = await signIn();
        await enrolled(authorization, 'Laptop');
        await enrolled(authorization, 'Phone');
        revokedWith = async ({ userId: owner, passkeyId }) =>
        {
            await history.add(owner, passkeyId, 'revoked');

            if (seen.length === 2)
            {
                throw new Error(`no history for ${EMAIL}`);
            }
        };

        const failure = await resetSecondFactorService(userId).catch((error: unknown) => error);
        await settled();

        expect(failure).toBeInstanceOf(PasskeyHookFailedError);
        expect(failure).toMatchObject({ hook: 'revoked', path: 'reset', userId, hookErrorClass: 'Error' });
        expect((failure as Error).message).not.toContain(EMAIL);
        expect(seen).toHaveLength(2);
        expect(await historyRows()).toEqual([]);
        expect((await passkeyRows()).map(row => row.revokedAt)).toEqual([null, null]);
        expect(revokedEvents).toEqual([]);
    });
});

function byPasskeyId(a: { passkeyId: string }, b: { passkeyId: string }): number
{
    return Number(a.passkeyId) - Number(b.passkeyId);
}
