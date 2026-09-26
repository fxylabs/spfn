/**
 * Device-code long poll: `waitMillis` on `/_auth/device/poll`.
 *
 * A poll that asks to wait is held while its record is pending, and the state
 * table in `device-auth.test.ts` is applied only once the wait ends. So every
 * row here is "what ends the wait" crossed with "what the table answers then".
 *
 * | record when the wait starts | during the wait | answer |
 * | --- | --- | --- |
 * | (no waitMillis, or 0) | — | at once, `intervalMillis` = configured interval |
 * | pending | approve | at once, approved, key registered |
 * | pending | deny | at once, DeviceAuthDenied |
 * | pending | TTL runs out | at expiry, DeviceAuthExpired, no key |
 * | pending | nothing, waitMillis ≥ interval | after waitMillis, pending, `intervalMillis` 0 |
 * | pending | nothing, waitMillis < interval | after waitMillis, pending, interval less the time waited |
 * | pending | waitMillis above maxWaitMs | after maxWaitMs, pending |
 * | pending | server starts shutting down | within a recheck, pending — not a cut connection |
 * | pending | a re-read fails (lost connection) | the wait ends and the request is judged — not a raw 500 |
 * | pending | device hangs up | wait ends, nothing parked, record still pending |
 * | pending | approved elsewhere (no wake), then device hangs up | not judged: record stays approved, no key |
 * | pending | approve committed elsewhere (no wake) | at the next recheck, approved |
 * | pending | MAX_WAITERS_PER_RECORD polls already waiting | at once, pending, configured interval |
 * | pending | two polls waiting, approve | one approved, the other NotFound |
 * | pending | approve rolled back | not woken; after waitMillis, pending |
 * | approved | account no longer active | refused; the spend rolls back, record stays approved |
 * | approved / denied / unknown | — | at once, as the state table says |
 * | approved | driver error while spending (e.g. unique violation) | the mapped error (409), with or without waitMillis |
 *
 * A global revocation sweeps only records with an owner, and a pending record has
 * none, so no poll is ever waiting on a record the sweep moves. The sweep's wake
 * is checked on its own, at the repository, so a later change that binds the user
 * earlier finds a waiting poll already woken.
 *
 * The wait is route middleware ahead of `Transactional()`, so every row is driven
 * through the route: that is the only place the wait and the judgement meet.
 *
 * Timing: a woken poll answers well under `WAIT_RECHECK_MS` (1s), and that gap is
 * what tells a wake from a recheck in the assertions below.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { users, userPublicKeys, deviceAuthorizations } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { deviceAuthorizationsRepository } from '@/server/repositories';
import {
    configureDeviceAuth,
    DEFAULT_DEVICE_AUTH_INTERVAL_MS,
} from '@/server/lib/device-auth-config';
import { parkedDeviceAuthCount, waitForDeviceAuthAnswer } from '@/server/lib/device-auth-waiters';
import { authenticate } from '@/server/middleware/authenticate';
import { getDatabase, runInTransaction } from '@spfn/core/db';
import { getShutdownManager } from '@spfn/core/server';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';

/** Under the 1s recheck: an answer this fast came from a wake. */
const WOKEN_WITHIN_MS = 800;

/** Long enough that a test finishing early proves the wait was cut short. */
const LONG_WAIT_MS = 5000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(!dbAvailable)('Device-code long poll', () =>
{
    let app: Hono;

    // One account and one source address per test, as in device-auth.test.ts:
    // every route here is rate limited by both.
    let testIndex = 0;
    let owner: string;
    let clientIp: string;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';

        app = new Hono();
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
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

        testIndex += 1;
        owner = `long-poll-${testIndex}@test.com`;
        clientIp = `10.1.${testIndex >> 8}.${testIndex & 0xff}`;

        const userRole = await getRoleByName('user');

        await db.insert(users).values({
            email: owner,
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        });
    });

    afterEach(() =>
    {
        configureDeviceAuth();

        // Every wait ends in its own test. A resolver left parked is a wait that
        // outlived the request it belonged to.
        expect(parkedDeviceAuthCount()).toBe(0);
    });

    async function signIn(): Promise<string>
    {
        const keyPair = generateKeyPair('ES256');

        const response = await post('/_auth/login', {
            email: owner,
            password: PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        });

        expect(response.status).toBe(200);

        const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', {
            expiresIn: '5m',
        });

        return `Bearer ${token}`;
    }

    function post(path: string, body: unknown, authorization?: string)
    {
        const headers: Record<string, string> = { ...JSON_HEADERS, 'x-forwarded-for': clientIp };

        if (authorization)
        {
            headers.Authorization = authorization;
        }

        return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    async function startDevice()
    {
        const keyPair = generateKeyPair('ES256');

        const response = await post('/_auth/device/start', {
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            deviceName: 'Terminal',
            platform: 'desktop',
        });

        expect(response.status).toBe(200);

        return { ...await response.json(), keyId: keyPair.keyId };
    }

    const approve = (userCode: string, authorization: string) =>
        post('/_auth/device/approve', { userCode }, authorization);
    const deny = (userCode: string, authorization: string) =>
        post('/_auth/device/deny', { userCode }, authorization);

    /** A poll, timed. `waitMillis` undefined sends the pre-long-poll body. */
    async function timedPoll(deviceCode: string, waitMillis?: number)
    {
        const startedAt = Date.now();
        const response = await post('/_auth/device/poll', { deviceCode, waitMillis });

        return { response, body: await response.json(), elapsed: Date.now() - startedAt };
    }

    /** A long poll the test can hang up on. */
    function abortablePoll(deviceCode: string, signal: AbortSignal): Promise<Response>
    {
        return Promise.resolve(app.request('/_auth/device/poll', {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': clientIp },
            body: JSON.stringify({ deviceCode, waitMillis: LONG_WAIT_MS }),
            signal,
        }));
    }

    /** Approve by writing the row, as another instance would: no wake reaches this process. */
    async function approveElsewhere(userCode: string)
    {
        await getDatabase('write')!
            .update(deviceAuthorizations)
            .set({ status: 'approved', userId: await ownerId(), approvedAt: new Date() })
            .where(eq(deviceAuthorizations.userCode, userCode.replace('-', '')));
    }

    function readRecord(userCode: string)
    {
        return getDatabase('write')!
            .select()
            .from(deviceAuthorizations)
            .where(eq(deviceAuthorizations.userCode, userCode.replace('-', '')))
            .then(rows => rows[0]);
    }

    function readKey(keyId: string)
    {
        return getDatabase('write')!
            .select()
            .from(userPublicKeys)
            .where(eq(userPublicKeys.keyId, keyId))
            .then(rows => rows[0]);
    }

    async function ownerId(): Promise<number>
    {
        const [user] = await getDatabase('write')!.select().from(users).where(eq(users.email, owner));

        return user.id;
    }

    describe('a poll that does not ask to wait', () =>
    {
        it.each([undefined, 0])('waitMillis %s answers pending at once with the configured interval', async (waitMillis) =>
        {
            const started = await startDevice();

            const { response, body, elapsed } = await timedPoll(started.deviceCode, waitMillis);

            expect(response.status).toBe(200);
            expect(body).toEqual({ status: 'pending', intervalMillis: DEFAULT_DEVICE_AUTH_INTERVAL_MS });
            expect(elapsed).toBeLessThan(WOKEN_WITHIN_MS);
        });

        it('a negative waitMillis is refused by the schema', async () =>
        {
            const started = await startDevice();

            const { response } = await timedPoll(started.deviceCode, -1);

            expect(response.status).toBe(400);
        });
    });

    describe('what ends a wait on a pending record', () =>
    {
        it('an approval answers at once, and the answer is the login', async () =>
        {
            const authorization = await signIn();
            const started = await startDevice();

            const polled = timedPoll(started.deviceCode, LONG_WAIT_MS);
            await sleep(100);
            expect((await approve(started.userCode, authorization)).status).toBe(200);

            const { response, body, elapsed } = await polled;

            expect(response.status).toBe(200);
            expect(body.status).toBe('approved');
            expect(elapsed).toBeLessThan(WOKEN_WITHIN_MS);
            expect(await readKey(started.keyId)).toBeDefined();
            expect((await readRecord(started.userCode)).status).toBe('consumed');
        });

        it('a refusal answers at once with DeviceAuthDenied', async () =>
        {
            const authorization = await signIn();
            const started = await startDevice();

            const polled = timedPoll(started.deviceCode, LONG_WAIT_MS);
            await sleep(100);
            expect((await deny(started.userCode, authorization)).status).toBe(204);

            const { response, body, elapsed } = await polled;

            expect(response.status).toBe(403);
            expect(body.error.code).toBe('DeviceAuthDeniedError');
            expect(elapsed).toBeLessThan(WOKEN_WITHIN_MS);
        });

        it('the TTL running out ends the wait at expiry with DeviceAuthExpired and no key', async () =>
        {
            const started = await startDevice();
            await getDatabase('write')!
                .update(deviceAuthorizations)
                .set({ expiresAt: new Date(Date.now() + 300) })
                .where(eq(deviceAuthorizations.userCode, started.userCode.replace('-', '')));

            const { response, body, elapsed } = await timedPoll(started.deviceCode, LONG_WAIT_MS);

            expect(response.status).toBe(400);
            expect(body.error.code).toBe('DeviceAuthExpiredError');
            expect(elapsed).toBeLessThan(LONG_WAIT_MS);
            expect(await readKey(started.keyId)).toBeUndefined();
        });

        it('nothing happening answers pending after the wait, telling the device to ask again at once', async () =>
        {
            configureDeviceAuth({ intervalMs: 1000 });
            const started = await startDevice();

            const { response, body, elapsed } = await timedPoll(started.deviceCode, 1200);

            expect(response.status).toBe(200);
            expect(body).toEqual({ status: 'pending', intervalMillis: 0 });
            expect(elapsed).toBeGreaterThanOrEqual(1200);
        });

        it('a wait shorter than the interval takes only what it waited off the interval', async () =>
        {
            // A client that obeys the answer must not be told to hammer the
            // route just because it asked to wait a moment.
            const started = await startDevice();

            const { body, elapsed } = await timedPoll(started.deviceCode, 300);

            expect(body.status).toBe('pending');
            expect(body.intervalMillis).toBeLessThanOrEqual(DEFAULT_DEVICE_AUTH_INTERVAL_MS - 300);
            expect(body.intervalMillis).toBeGreaterThanOrEqual(DEFAULT_DEVICE_AUTH_INTERVAL_MS - elapsed);
        });

        it('a wait longer than maxWaitMs is held for maxWaitMs', async () =>
        {
            configureDeviceAuth({ maxWaitMs: 600, intervalMs: 600 });
            const started = await startDevice();

            const { body, elapsed } = await timedPoll(started.deviceCode, 60_000);

            expect(body).toEqual({ status: 'pending', intervalMillis: 0 });
            expect(elapsed).toBeGreaterThanOrEqual(600);
            expect(elapsed).toBeLessThan(LONG_WAIT_MS);
        });

        it('the server starting to shut down ends the wait with a pending answer', async () =>
        {
            const started = await startDevice();

            const polled = timedPoll(started.deviceCode, LONG_WAIT_MS);
            await sleep(100);
            const draining = vi.spyOn(getShutdownManager(), 'isShuttingDown').mockReturnValue(true);

            try
            {
                const { response, body, elapsed } = await polled;

                expect(response.status).toBe(200);
                expect(body.status).toBe('pending');
                expect(elapsed).toBeLessThan(2000);
            }
            finally
            {
                draining.mockRestore();
            }
        });

        it('a re-read that fails ends the wait and the request is judged inside the transaction', async () =>
        {
            // The first read finds the record; every re-read after it fails, as a
            // dropped connection would. The wait must hand over, not throw.
            const started = await startDevice();
            const original = deviceAuthorizationsRepository.findByDeviceCodeHashOnPrimary.bind(deviceAuthorizationsRepository);
            let reads = 0;
            const failing = vi.spyOn(deviceAuthorizationsRepository, 'findByDeviceCodeHashOnPrimary')
                .mockImplementation(async (hash: string) =>
                {
                    reads += 1;

                    if (reads === 1)
                    {
                        return original(hash);
                    }

                    throw Object.assign(new Error('connection terminated'), { code: '08006', severity: 'FATAL' });
                });

            try
            {
                const { response, body, elapsed } = await timedPoll(started.deviceCode, LONG_WAIT_MS);

                expect(response.status).toBe(200);
                expect(body.status).toBe('pending');
                expect(elapsed).toBeLessThan(2000);
            }
            finally
            {
                failing.mockRestore();
            }
        });

        it('the device hanging up ends the wait and leaves the record pending', async () =>
        {
            const started = await startDevice();
            const controller = new AbortController();
            const startedAt = Date.now();

            const polled = abortablePoll(started.deviceCode, controller.signal);
            await sleep(100);
            controller.abort();
            await polled.catch(() => undefined);

            expect(Date.now() - startedAt).toBeLessThan(WOKEN_WITHIN_MS);
            expect(parkedDeviceAuthCount()).toBe(0);
            expect((await readRecord(started.userCode)).status).toBe('pending');
        });

        it('a device that hung up is not judged: an approval it can no longer hear stays uncollected', async () =>
        {
            // Approved where no wake reaches, then hung up before the recheck: the
            // wait ends on the abort with the record approved. Judging it would
            // spend the code for a device that never reads the answer.
            const started = await startDevice();
            const controller = new AbortController();

            const polled = abortablePoll(started.deviceCode, controller.signal);
            await sleep(100);
            await approveElsewhere(started.userCode);
            controller.abort();
            await polled.catch(() => undefined);
            await sleep(100);

            expect((await readRecord(started.userCode)).status).toBe('approved');
            expect(await readKey(started.keyId)).toBeUndefined();

            const collected = await timedPoll(started.deviceCode);

            expect(collected.body.status).toBe('approved');
            expect(await readKey(started.keyId)).toBeDefined();
        });

        it('past the per-record limit of waiting polls, one more is answered at once', async () =>
        {
            const started = await startDevice();
            const controllers = [1, 2, 3].map(() => new AbortController());
            const waiting = controllers.map(controller => abortablePoll(started.deviceCode, controller.signal));
            await sleep(200);

            const { body, elapsed } = await timedPoll(started.deviceCode, LONG_WAIT_MS);

            expect(body).toEqual({ status: 'pending', intervalMillis: DEFAULT_DEVICE_AUTH_INTERVAL_MS });
            expect(elapsed).toBeLessThan(WOKEN_WITHIN_MS);

            controllers.forEach(controller => controller.abort());
            await Promise.all(waiting.map(request => request.catch(() => undefined)));
        });

        it('an approval committed where no wake reaches is found by the recheck', async () =>
        {
            // Another instance's approval: the row moves, and this process's
            // waiters are never told.
            const started = await startDevice();

            const polled = timedPoll(started.deviceCode, LONG_WAIT_MS);
            await sleep(100);
            await approveElsewhere(started.userCode);

            const { body, elapsed } = await polled;

            expect(body.status).toBe('approved');
            expect(elapsed).toBeLessThan(2500);
            expect(await readKey(started.keyId)).toBeDefined();
        });

        it('two polls waiting on one code: the approval lets exactly one of them in', async () =>
        {
            const authorization = await signIn();
            const started = await startDevice();

            const first = timedPoll(started.deviceCode, LONG_WAIT_MS);
            const second = timedPoll(started.deviceCode, LONG_WAIT_MS);
            await sleep(100);
            await approve(started.userCode, authorization);

            const answers = await Promise.all([first, second]);
            const statuses = answers.map(answer => answer.response.status).sort();

            expect(statuses).toEqual([200, 404]);
            expect(answers.find(answer => answer.response.status === 404)!.body.error.code)
                .toBe('DeviceAuthNotFoundError');
        });

        it('an approval that rolls back wakes nobody, and the wait ends pending', async () =>
        {
            const started = await startDevice();
            const record = await readRecord(started.userCode);
            const userId = await ownerId();

            configureDeviceAuth({ intervalMs: 1000 });

            const polled = timedPoll(started.deviceCode, 1200);
            await sleep(100);
            await expect(runInTransaction(async () =>
            {
                await deviceAuthorizationsRepository.approve(record.id, userId);
                throw new Error('rolled back on purpose');
            })).rejects.toThrow('rolled back on purpose');

            const { body, elapsed } = await polled;

            expect(body).toEqual({ status: 'pending', intervalMillis: 0 });
            expect(elapsed).toBeGreaterThanOrEqual(1200);
            expect((await readRecord(started.userCode)).status).toBe('pending');
        });
    });

    describe('records a poll does not wait on', () =>
    {
        it('an approved record whose login fails keeps its approval: the spend rolls back with it', async () =>
        {
            const authorization = await signIn();
            const started = await startDevice();
            await approve(started.userCode, authorization);
            await getDatabase('write')!.update(users).set({ status: 'suspended' }).where(eq(users.email, owner));

            const refused = await timedPoll(started.deviceCode, LONG_WAIT_MS);

            expect(refused.response.status).toBe(403);
            expect(refused.body.error.code).toBe('AccountDisabledError');
            expect(refused.elapsed).toBeLessThan(WOKEN_WITHIN_MS);
            expect((await readRecord(started.userCode)).status).toBe('approved');
            expect(await readKey(started.keyId)).toBeUndefined();

            await getDatabase('write')!.update(users).set({ status: 'active' }).where(eq(users.email, owner));

            const collected = await timedPoll(started.deviceCode, LONG_WAIT_MS);

            expect(collected.body.status).toBe('approved');
            expect(await readKey(started.keyId)).toBeDefined();
        });

        it('a denied record answers DeviceAuthDenied at once', async () =>
        {
            const authorization = await signIn();
            const started = await startDevice();
            await deny(started.userCode, authorization);

            const { response, body, elapsed } = await timedPoll(started.deviceCode, LONG_WAIT_MS);

            expect(response.status).toBe(403);
            expect(body.error.code).toBe('DeviceAuthDeniedError');
            expect(elapsed).toBeLessThan(WOKEN_WITHIN_MS);
        });

        it('an unknown code answers NotFound at once', async () =>
        {
            const { response, body, elapsed } = await timedPoll('this-device-code-was-never-issued', LONG_WAIT_MS);

            expect(response.status).toBe(404);
            expect(body.error.code).toBe('DeviceAuthNotFoundError');
            expect(elapsed).toBeLessThan(WOKEN_WITHIN_MS);
        });
    });

    describe('the judgement stays inside Transactional()', () =>
    {
        // `Transactional()` is what turns a driver error into an answer a client
        // can read. The wait sits in front of it, so a poll that waited must be
        // judged inside it exactly as one that did not.
        it.each([undefined, LONG_WAIT_MS])('a unique violation while spending answers 409 (waitMillis %s)', async (waitMillis) =>
        {
            const authorization = await signIn();
            const started = await startDevice();
            await approve(started.userCode, authorization);

            const driverError = Object.assign(
                new Error('duplicate key value violates unique constraint "device_authorizations_device_code_hash_unique"'),
                { code: '23505', severity: 'ERROR' },
            );
            const spy = vi.spyOn(deviceAuthorizationsRepository, 'consumeApproved').mockRejectedValueOnce(driverError);

            try
            {
                const { response, body } = await timedPoll(started.deviceCode, waitMillis);

                expect(response.status).toBe(409);
                expect(body.error.code).toBe('DuplicateEntryError');
            }
            finally
            {
                spy.mockRestore();
            }

            expect((await readRecord(started.userCode)).status).toBe('approved');
        });
    });

    describe('the global revocation sweep', () =>
    {
        it('wakes whatever is parked on the records it refuses', async () =>
        {
            const authorization = await signIn();
            const started = await startDevice();
            await approve(started.userCode, authorization);
            const record = await readRecord(started.userCode);
            const startedAt = Date.now();

            const parked = waitForDeviceAuthAnswer(record.id, LONG_WAIT_MS);
            await deviceAuthorizationsRepository.denyAllActiveByUserId(await ownerId());
            await parked;

            expect(Date.now() - startedAt).toBeLessThan(WOKEN_WITHIN_MS);
        });
    });
});
