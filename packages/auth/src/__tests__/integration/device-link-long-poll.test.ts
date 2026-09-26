/**
 * Device-link long polls: `waitMillis` on the issuer's `status` and on the new
 * device's `poll`.
 *
 * A request that asks to wait is held while its link waits on the other party,
 * and the state table in `device-link.test.ts` is applied only once the wait
 * ends. So every row here is "what ends the wait" crossed with "what the table
 * answers then".
 *
 * | who | link when the wait starts | during the wait | answer |
 * | --- | --- | --- | --- |
 * | issuer | issued | a device redeems | at once, redeemed with choices |
 * | issuer | approved | the device collects | at once, consumed |
 * | issuer | issued | the same key issues again | at once, DeviceLinkExpired |
 * | issuer | issued | nothing | after waitMillis, issued |
 * | issuer | issued | waitMillis above maxWaitMs | after maxWaitMs, issued |
 * | issuer | redeemed | — | at once: the issuer is the one to act |
 * | stranger | any | — | at once, NotFound |
 * | device | redeemed | confirm | at once, approved, key registered |
 * | device | redeemed | deny | at once, DeviceLinkDenied |
 * | device | redeemed | wrong number | at once, DeviceLinkDenied |
 * | device | redeemed | cancel | at once, DeviceLinkExpired |
 * | device | redeemed | revoke-all sparing the issuer | at once, DeviceLinkExpired |
 * | device | redeemed | issuer's key revoked, no wake | at the next recheck, DeviceLinkExpired |
 * | device | redeemed | approved elsewhere, no wake | at the next recheck, approved |
 * | device | redeemed | TTL runs out | at expiry, DeviceLinkExpired, no key |
 * | device | redeemed | nothing, waitMillis ≥ interval | after waitMillis, pending, `intervalMillis` 0 |
 * | device | redeemed | server starts shutting down | within a recheck, pending |
 * | device | redeemed | device hangs up | wait ends, nothing parked, link unchanged |
 * | device | redeemed | three requests already waiting | at once, pending, configured interval |
 *
 * Timing: a woken request answers well under the 1s recheck, and that gap is
 * what tells a wake from a recheck in the assertions below.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { users, userPublicKeys, deviceLinks } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { configureDeviceAuth, DEFAULT_DEVICE_AUTH_INTERVAL_MS } from '@/server/lib/device-auth-config';
import { parkedDeviceLinkCount } from '@/server/lib/device-link-waiters';
import { authenticate } from '@/server/middleware/authenticate';
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

interface Issuer
{
    authorization: string;
    keyId: string;
}

describe.skipIf(!dbAvailable)('Device-link long polls', () =>
{
    let app: Hono;

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
        await clearTables(getTestDb());
        await initializeAuth();

        testIndex += 1;
        owner = `link-long-poll-${testIndex}@test.com`;
        clientIp = `10.3.${testIndex >> 8}.${testIndex & 0xff}`;

        await getTestDb().insert(users).values({
            email: owner,
            passwordHash: await hashPassword(PASSWORD),
            roleId: await userRoleId(),
            emailVerifiedAt: new Date(),
        });
    });

    afterEach(() =>
    {
        configureDeviceAuth();

        // Every wait ends in its own test. A resolver left parked is a wait that
        // outlived the request it belonged to.
        expect(parkedDeviceLinkCount()).toBe(0);
    });

    async function userRoleId(): Promise<number>
    {
        const role = await getRoleByName('user');

        if (!role)
        {
            throw new Error('initializeAuth did not seed the user role');
        }

        return role.id;
    }

    async function signIn(): Promise<Issuer>
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

        return { authorization: `Bearer ${token}`, keyId: keyPair.keyId };
    }

    function post(path: string, body: unknown, authorization?: string, signal?: AbortSignal)
    {
        const headers: Record<string, string> = { ...JSON_HEADERS, 'x-forwarded-for': clientIp };

        if (authorization)
        {
            headers.Authorization = authorization;
        }

        return Promise.resolve(app.request(path, { method: 'POST', headers, body: JSON.stringify(body), signal }));
    }

    async function issue(issuer: Issuer): Promise<{ linkId: string; userCode: string }>
    {
        const response = await post('/_auth/device/link/issue', {}, issuer.authorization);
        expect(response.status).toBe(200);

        return await response.json();
    }

    async function redeem(userCode: string)
    {
        const keyPair = generateKeyPair('ES256');

        const response = await post('/_auth/device/link/redeem', {
            userCode,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            deviceName: 'New phone',
            platform: 'android',
        });

        expect(response.status).toBe(200);

        const body = await response.json() as { deviceCode: string; matchNumber: number };

        return { ...body, keyId: keyPair.keyId };
    }

    async function redeemedLink()
    {
        const issuer = await signIn();
        const link = await issue(issuer);
        const device = await redeem(link.userCode);

        return { issuer, link, device };
    }

    const confirm = (linkId: string, choice: number, issuer: Issuer) =>
        post('/_auth/device/link/confirm', { linkId, choice }, issuer.authorization);

    /** A request, timed. */
    async function timed(request: Promise<Response>)
    {
        const startedAt = Date.now();
        const response = await request;

        return { response, body: await response.json(), elapsed: Date.now() - startedAt };
    }

    const timedStatus = (linkId: string, issuer: Issuer, waitMillis?: number) =>
        timed(post('/_auth/device/link/status', { linkId, waitMillis }, issuer.authorization));

    const timedPoll = (deviceCode: string, waitMillis?: number) =>
        timed(post('/_auth/device/link/poll', { deviceCode, waitMillis }));

    function readLink(linkId: string)
    {
        return getTestDb()
            .select()
            .from(deviceLinks)
            .where(eq(deviceLinks.linkId, linkId))
            .then(rows => rows[0]);
    }

    function keysOf(keyId: string)
    {
        return getTestDb()
            .select()
            .from(userPublicKeys)
            .where(eq(userPublicKeys.keyId, keyId));
    }

    describe('the issuer\'s status', () =>
    {
        it('a device redeeming the code wakes it with the device and its choices', async () =>
        {
            const issuer = await signIn();
            const link = await issue(issuer);

            const waiting = timedStatus(link.linkId, issuer, LONG_WAIT_MS);
            await sleep(200);
            const device = await redeem(link.userCode);

            const { response, body, elapsed } = await waiting;

            expect(response.status).toBe(200);
            expect(body.status).toBe('redeemed');
            expect(body.choices).toContain(device.matchNumber);
            expect(elapsed).toBeLessThan(200 + WOKEN_WITHIN_MS);
        });

        it('the device collecting its approval wakes it with consumed', async () =>
        {
            const { issuer, link, device } = await redeemedLink();
            expect((await confirm(link.linkId, device.matchNumber, issuer)).status).toBe(200);

            const waiting = timedStatus(link.linkId, issuer, LONG_WAIT_MS);
            await sleep(200);
            expect((await timedPoll(device.deviceCode)).body.status).toBe('approved');

            const { body, elapsed } = await waiting;

            expect(body.status).toBe('consumed');
            expect(elapsed).toBeLessThan(200 + WOKEN_WITHIN_MS);
        });

        it('a newer link from the same key wakes it, and the old link answers expired', async () =>
        {
            const issuer = await signIn();
            const link = await issue(issuer);

            const waiting = timedStatus(link.linkId, issuer, LONG_WAIT_MS);
            await sleep(200);
            await issue(issuer);

            const { response, body, elapsed } = await waiting;

            expect(response.status).toBe(400);
            expect(body.error.code).toBe('DeviceLinkExpiredError');
            expect(elapsed).toBeLessThan(200 + WOKEN_WITHIN_MS);
        });

        it('nothing happening answers issued after the wait', async () =>
        {
            const issuer = await signIn();
            const link = await issue(issuer);

            const { body, elapsed } = await timedStatus(link.linkId, issuer, 600);

            expect(body.status).toBe('issued');
            expect(elapsed).toBeGreaterThanOrEqual(600);
            expect(elapsed).toBeLessThan(LONG_WAIT_MS);
        });

        it('a wait above maxWaitMs is cut to it', async () =>
        {
            configureDeviceAuth({ maxWaitMs: 400 });
            const issuer = await signIn();
            const link = await issue(issuer);

            const { body, elapsed } = await timedStatus(link.linkId, issuer, LONG_WAIT_MS);

            expect(body.status).toBe('issued');
            expect(elapsed).toBeGreaterThanOrEqual(400);
            expect(elapsed).toBeLessThan(2000);
        });

        it('a redeemed link is answered at once — the issuer is the one who has to act', async () =>
        {
            const { issuer, link } = await redeemedLink();

            const { body, elapsed } = await timedStatus(link.linkId, issuer, LONG_WAIT_MS);

            expect(body.status).toBe('redeemed');
            expect(elapsed).toBeLessThan(WOKEN_WITHIN_MS);
        });

        it('another device of the same account is not held, and is told the link does not exist', async () =>
        {
            const issuer = await signIn();
            const other = await signIn();
            const link = await issue(issuer);

            const { response, body, elapsed } = await timedStatus(link.linkId, other, LONG_WAIT_MS);

            expect(response.status).toBe(404);
            expect(body.error.code).toBe('DeviceLinkNotFoundError');
            expect(elapsed).toBeLessThan(WOKEN_WITHIN_MS);
        });
    });

    describe('the new device\'s poll', () =>
    {
        it('confirm wakes it with the login, and the key is registered', async () =>
        {
            const { issuer, link, device } = await redeemedLink();

            const waiting = timedPoll(device.deviceCode, LONG_WAIT_MS);
            await sleep(200);
            expect((await confirm(link.linkId, device.matchNumber, issuer)).status).toBe(200);

            const { body, elapsed } = await waiting;

            expect(body.status).toBe('approved');
            expect(elapsed).toBeLessThan(200 + WOKEN_WITHIN_MS);
            expect(await keysOf(device.keyId)).toHaveLength(1);
        });

        it('deny wakes it with a refusal', async () =>
        {
            const { issuer, link, device } = await redeemedLink();

            const waiting = timedPoll(device.deviceCode, LONG_WAIT_MS);
            await sleep(200);
            await post('/_auth/device/link/deny', { linkId: link.linkId }, issuer.authorization);

            const { response, body, elapsed } = await waiting;

            expect(response.status).toBe(403);
            expect(body.error.code).toBe('DeviceLinkDeniedError');
            expect(elapsed).toBeLessThan(200 + WOKEN_WITHIN_MS);
        });

        it('a wrong number wakes it with a refusal', async () =>
        {
            const { issuer, link, device } = await redeemedLink();
            const wrong = device.matchNumber === 99 ? 98 : device.matchNumber + 1;

            const waiting = timedPoll(device.deviceCode, LONG_WAIT_MS);
            await sleep(200);
            expect((await confirm(link.linkId, wrong, issuer)).status).toBe(400);

            const { response, elapsed } = await waiting;

            expect(response.status).toBe(403);
            expect(elapsed).toBeLessThan(200 + WOKEN_WITHIN_MS);
        });

        it('cancel wakes it with expired', async () =>
        {
            const { issuer, link, device } = await redeemedLink();

            const waiting = timedPoll(device.deviceCode, LONG_WAIT_MS);
            await sleep(200);
            await post('/_auth/device/link/cancel', { linkId: link.linkId }, issuer.authorization);

            const { response, body, elapsed } = await waiting;

            expect(response.status).toBe(400);
            expect(body.error.code).toBe('DeviceLinkExpiredError');
            expect(elapsed).toBeLessThan(200 + WOKEN_WITHIN_MS);
        });

        it('a revoke-all that spares the issuer wakes it with expired', async () =>
        {
            const { issuer, device } = await redeemedLink();

            const waiting = timedPoll(device.deviceCode, LONG_WAIT_MS);
            await sleep(200);
            expect((await post('/_auth/keys/revoke-all', {}, issuer.authorization)).status).toBe(200);

            const { response, elapsed } = await waiting;

            expect(response.status).toBe(400);
            expect(elapsed).toBeLessThan(200 + WOKEN_WITHIN_MS);
        });

        it('the issuing key revoked with no wake is found by the recheck', async () =>
        {
            const { issuer, device } = await redeemedLink();

            const waiting = timedPoll(device.deviceCode, LONG_WAIT_MS);
            await sleep(200);
            await getTestDb()
                .update(userPublicKeys)
                .set({ isActive: false, revokedAt: new Date() })
                .where(eq(userPublicKeys.keyId, issuer.keyId));

            const { response, body, elapsed } = await waiting;

            expect(response.status).toBe(400);
            expect(body.error.code).toBe('DeviceLinkExpiredError');
            expect(elapsed).toBeLessThan(2500);
        });

        it('an approval committed where no wake reaches is found by the recheck', async () =>
        {
            const { link, device } = await redeemedLink();

            const waiting = timedPoll(device.deviceCode, LONG_WAIT_MS);
            await sleep(200);
            await getTestDb()
                .update(deviceLinks)
                .set({ status: 'approved', approvedAt: new Date() })
                .where(eq(deviceLinks.linkId, link.linkId));

            const { body, elapsed } = await waiting;

            expect(body.status).toBe('approved');
            expect(elapsed).toBeLessThan(2500);
        });

        it('the TTL running out ends the wait expired, and registers nothing', async () =>
        {
            const { link, device } = await redeemedLink();

            await getTestDb()
                .update(deviceLinks)
                .set({ expiresAt: new Date(Date.now() + 600) })
                .where(eq(deviceLinks.linkId, link.linkId));

            const { response, elapsed } = await timedPoll(device.deviceCode, LONG_WAIT_MS);

            expect(response.status).toBe(400);
            expect(elapsed).toBeLessThan(2000);
            expect(await keysOf(device.keyId)).toHaveLength(0);
        });

        it('nothing happening answers pending with nothing left of the interval to wait', async () =>
        {
            configureDeviceAuth({ intervalMs: 500 });
            const { device } = await redeemedLink();

            const { body, elapsed } = await timedPoll(device.deviceCode, 600);

            expect(body).toEqual({ status: 'pending', intervalMillis: 0 });
            expect(elapsed).toBeGreaterThanOrEqual(600);
        });

        it('the server starting to shut down ends the wait with a pending answer', async () =>
        {
            const { device } = await redeemedLink();

            const polled = timedPoll(device.deviceCode, LONG_WAIT_MS);
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

        it('a device that hangs up leaves nothing parked and the link as it was', async () =>
        {
            const { link, device } = await redeemedLink();
            const controller = new AbortController();

            const polled = post(
                '/_auth/device/link/poll',
                { deviceCode: device.deviceCode, waitMillis: LONG_WAIT_MS },
                undefined,
                controller.signal,
            ).catch(() => undefined);
            await sleep(200);
            controller.abort();
            await polled;
            await sleep(50);

            expect(parkedDeviceLinkCount()).toBe(0);
            expect((await readLink(link.linkId)).status).toBe('redeemed');
        });

        it('past the per-link limit of waiting requests, one more is answered at once', async () =>
        {
            const { device } = await redeemedLink();
            const controllers = [1, 2, 3].map(() => new AbortController());
            const waiting = controllers.map(controller => post(
                '/_auth/device/link/poll',
                { deviceCode: device.deviceCode, waitMillis: LONG_WAIT_MS },
                undefined,
                controller.signal,
            ));
            await sleep(200);

            const { body, elapsed } = await timedPoll(device.deviceCode, LONG_WAIT_MS);

            expect(body).toEqual({ status: 'pending', intervalMillis: DEFAULT_DEVICE_AUTH_INTERVAL_MS });
            expect(elapsed).toBeLessThan(WOKEN_WITHIN_MS);

            controllers.forEach(controller => controller.abort());
            await Promise.all(waiting.map(request => request.catch(() => undefined)));
        });
    });
});
