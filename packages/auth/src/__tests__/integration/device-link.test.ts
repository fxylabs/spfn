/**
 * Device link, driven end to end against the mounted auth router.
 *
 * A signed-in device (the issuer) asks for a code and shows it; a new device with
 * no key redeems it with its public key and shows a two-digit match number; the
 * issuer picks that number out of three; the new device's next poll is its login.
 *
 * One test per row of the state table the feature was specified by (R1–R18),
 * named after the row, then the cases beyond it: the redeem race, the issuer
 * signing out between redeem and confirm, a key left behind by a refused link,
 * key material that does not hold together, and the row-level facts — the device
 * code stored as a hash, the choices fixed per record.
 *
 * | id | state | call (who) | result | next |
 * | --- | --- | --- | --- | --- |
 * | R1 | — | issue (issuer) | linkId, userCode, expiresAtMillis | issued |
 * | R2 | issued | issue again (same key) | previous → expired | issued |
 * | R3 | issued | redeem (device) | deviceCode, matchNumber, expiresAtMillis, intervalMillis | redeemed |
 * | R4 | redeemed / approved / denied / consumed | redeem | 404 | unchanged |
 * | R5 | unknown / expired | redeem | 404 / 400 | unchanged |
 * | R6 | issued | status | issued | unchanged |
 * | R7 | redeemed | status | redeemed + device + three fixed choices | unchanged |
 * | R8 | redeemed | confirm, right number | 200 | approved |
 * | R9 | redeemed | confirm, wrong number | 400, no second pick | denied |
 * | R10 | redeemed | deny | 200 | denied |
 * | R11 | any | status / confirm / deny / cancel by another key or account | 404 | unchanged |
 * | R12 | approved | poll | login; key registered under the issuer's account | consumed |
 * | R13 | redeemed | poll | pending + intervalMillis | unchanged |
 * | R14 | denied | poll | 403 | unchanged |
 * | R15 | past expiry | any call | 400 expired | expired |
 * | R16 | issued / redeemed | issuer's key revoked or signed out | expired at the next call | expired |
 * | R17 | issued / redeemed | cancel | 200 | expired |
 * | R18 | approved | two polls at once | one registers the key, the other 404 | consumed |
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { users, userPublicKeys, deviceLinks } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { hashDeviceCode } from '@/server/lib/device-code';
import { DEFAULT_DEVICE_AUTH_INTERVAL_MS } from '@/server/lib/device-auth-config';
import { DEFAULT_DEVICE_LINK_TTL_MS } from '@/server/lib/device-link-config';
import { deviceLinksRepository } from '@/server/repositories';
import { authenticate } from '@/server/middleware/authenticate';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';

const UNKNOWN_USER_CODE = 'ZZZZ-ZZZZ';
const UNKNOWN_LINK_ID = '00000000-0000-4000-8000-000000000000';

/** A signed-in device: what it signs requests with, and which key it is. */
interface Issuer
{
    authorization: string;
    keyId: string;
}

describe.skipIf(!dbAvailable)('Device link', () =>
{
    let app: Hono;

    // Every route here is rate limited, by client IP and — where there is one —
    // by the calling account, so each test gets its own of both, as in
    // device-auth.test.ts.
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
        owner = `link-owner-${testIndex}@test.com`;
        clientIp = `10.2.${testIndex >> 8}.${testIndex & 0xff}`;

        await createUser(owner);
    });

    async function createUser(email: string)
    {
        await getTestDb().insert(users).values({
            email,
            passwordHash: await hashPassword(PASSWORD),
            roleId: await userRoleId(),
            emailVerifiedAt: new Date(),
        });
    }

    /** Exactly what an already-signed-in device does: sign in, then sign requests. */
    async function userRoleId(): Promise<number>
    {
        const role = await getRoleByName('user');

        if (!role)
        {
            throw new Error('initializeAuth did not seed the user role');
        }

        return role.id;
    }

    async function signIn(email = owner): Promise<Issuer>
    {
        const keyPair = generateKeyPair('ES256');

        const response = await post('/_auth/login', {
            email,
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

    function post(path: string, body: unknown, authorization?: string)
    {
        const headers: Record<string, string> = { ...JSON_HEADERS, 'x-forwarded-for': clientIp };

        if (authorization)
        {
            headers.Authorization = authorization;
        }

        return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    async function issue(issuer: Issuer)
    {
        const response = await post('/_auth/device/link/issue', {}, issuer.authorization);
        expect(response.status).toBe(200);

        return await response.json() as { linkId: string; userCode: string; expiresAtMillis: number };
    }

    /** The new device: a fresh key, redeemed against a code. Returns the response and the key. */
    async function redeemRaw(userCode: string, deviceName = 'New phone')
    {
        const keyPair = generateKeyPair('ES256');

        const response = await post('/_auth/device/link/redeem', {
            userCode,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            deviceName,
            platform: 'ios',
        });

        return { response, keyPair };
    }

    async function redeem(userCode: string, deviceName = 'New phone')
    {
        const { response, keyPair } = await redeemRaw(userCode, deviceName);
        expect(response.status).toBe(200);

        const body = await response.json() as {
            deviceCode: string;
            matchNumber: number;
            expiresAtMillis: number;
            intervalMillis: number;
        };

        return { ...body, keyId: keyPair.keyId, fingerprint: keyPair.fingerprint };
    }

    const status = (linkId: string, issuer: Issuer, waitMillis?: number) =>
        post('/_auth/device/link/status', { linkId, waitMillis }, issuer.authorization);
    const confirm = (linkId: string, choice: number, issuer: Issuer) =>
        post('/_auth/device/link/confirm', { linkId, choice }, issuer.authorization);
    const deny = (linkId: string, issuer: Issuer) =>
        post('/_auth/device/link/deny', { linkId }, issuer.authorization);
    const cancel = (linkId: string, issuer: Issuer) =>
        post('/_auth/device/link/cancel', { linkId }, issuer.authorization);
    const poll = (deviceCode: string, waitMillis?: number) =>
        post('/_auth/device/link/poll', { deviceCode, waitMillis });

    /** Assert an error response by its documented discriminator, not by prose. */
    async function expectError(response: Response, status: number, code: string)
    {
        expect(response.status).toBe(status);
        expect((await response.json()).error.code).toBe(code);
    }

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

    async function userIdOf(email: string): Promise<number>
    {
        const [user] = await getTestDb().select().from(users).where(eq(users.email, email));

        return user.id;
    }

    /** Drag a link's TTL into the past. Only the server clock ever decides this. */
    async function expire(linkId: string)
    {
        await getTestDb()
            .update(deviceLinks)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(deviceLinks.linkId, linkId));
    }

    /** A number among the choices that is not the match. */
    function wrongChoice(choices: number[], matchNumber: number): number
    {
        const wrong = choices.find(choice => choice !== matchNumber);
        expect(wrong).toBeDefined();

        return wrong ?? 0;
    }

    /** Issue and redeem: the link waiting on the issuer's pick. */
    async function redeemedLink()
    {
        const issuer = await signIn();
        const link = await issue(issuer);
        const device = await redeem(link.userCode);

        return { issuer, link, device };
    }

    async function approvedLink()
    {
        const redeemed = await redeemedLink();
        const confirmed = await confirm(redeemed.link.linkId, redeemed.device.matchNumber, redeemed.issuer);
        expect(confirmed.status).toBe(200);

        return redeemed;
    }

    async function deniedLink()
    {
        const redeemed = await redeemedLink();
        expect((await deny(redeemed.link.linkId, redeemed.issuer)).status).toBe(200);

        return redeemed;
    }

    async function consumedLink()
    {
        const approved = await approvedLink();
        expect((await poll(approved.device.deviceCode)).status).toBe(200);

        return approved;
    }

    describe('state table', () =>
    {
        it('R1 issue answers a handle, a XXXX-XXXX code and a five-minute expiry, bound to the issuing key', async () =>
        {
            const issuer = await signIn();
            const before = Date.now();

            const link = await issue(issuer);

            expect(typeof link.linkId).toBe('string');
            expect(link.userCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/);
            expect(link.expiresAtMillis).toBeGreaterThanOrEqual(before + DEFAULT_DEVICE_LINK_TTL_MS - 1000);
            expect(link.expiresAtMillis).toBeLessThanOrEqual(Date.now() + DEFAULT_DEVICE_LINK_TTL_MS);

            const record = await readLink(link.linkId);
            expect(record.status).toBe('issued');
            expect(record.issuerKeyId).toBe(issuer.keyId);
            expect(record.issuerUserId).toBe(await userIdOf(owner));
            expect(record.userCode).toBe(link.userCode.replace('-', ''));
        });

        it('R2 issuing again from the same key expires the previous link — one live link per key', async () =>
        {
            const issuer = await signIn();
            const first = await issue(issuer);

            const second = await issue(issuer);

            expect(second.linkId).not.toBe(first.linkId);
            expect((await readLink(first.linkId)).status).toBe('expired');
            expect((await readLink(second.linkId)).status).toBe('issued');

            await expectError((await redeemRaw(first.userCode)).response, 400, 'DeviceLinkExpiredError');
            await expectError(await status(first.linkId, issuer), 400, 'DeviceLinkExpiredError');
        });

        it('R2 a link issued by another device of the same account is left alone', async () =>
        {
            const laptop = await signIn();
            const desktop = await signIn();
            const fromLaptop = await issue(laptop);

            await issue(desktop);

            expect((await readLink(fromLaptop.linkId)).status).toBe('issued');
        });

        it('R3 redeem parks the key and answers a device code, a 10–99 match number, the expiry and the interval', async () =>
        {
            const issuer = await signIn();
            const link = await issue(issuer);

            const device = await redeem(link.userCode, 'Pocket phone');

            expect(typeof device.deviceCode).toBe('string');
            expect(Number.isInteger(device.matchNumber)).toBe(true);
            expect(device.matchNumber).toBeGreaterThanOrEqual(10);
            expect(device.matchNumber).toBeLessThanOrEqual(99);
            expect(device.expiresAtMillis).toBe(link.expiresAtMillis);
            expect(device.intervalMillis).toBe(DEFAULT_DEVICE_AUTH_INTERVAL_MS);

            const record = await readLink(link.linkId);
            expect(record.status).toBe('redeemed');
            expect(record.keyId).toBe(device.keyId);
            expect(record.deviceName).toBe('Pocket phone');
            expect(record.platform).toBe('ios');
            expect(record.matchNumber).toBe(device.matchNumber);

            // Parked, not registered: nothing can sign with it yet.
            expect(await keysOf(device.keyId)).toHaveLength(0);
        });

        describe('R4 redeem on a code already redeemed answers exactly as an unknown code', () =>
        {
            const cases = [
                ['redeemed', redeemedLink],
                ['approved', approvedLink],
                ['denied', deniedLink],
                ['consumed', consumedLink],
            ] as const;

            for (const [state, arrange] of cases)
            {
                it(`R4 ${state}: 404, and the link does not move`, async () =>
                {
                    const { link } = await arrange();
                    const before = await readLink(link.linkId);

                    const second = await redeemRaw(link.userCode, 'Someone else');
                    await expectError(second.response, 404, 'DeviceLinkNotFoundError');

                    const unknown = await redeemRaw(UNKNOWN_USER_CODE);
                    await expectError(unknown.response, 404, 'DeviceLinkNotFoundError');

                    const after = await readLink(link.linkId);
                    expect(after.status).toBe(before.status);
                    expect(after.keyId).toBe(before.keyId);
                    expect(await keysOf(second.keyPair.keyId)).toHaveLength(0);
                });
            }
        });

        it('R5 redeem of an unknown code is 404, of an expired one 400, and neither moves anything', async () =>
        {
            await expectError((await redeemRaw(UNKNOWN_USER_CODE)).response, 404, 'DeviceLinkNotFoundError');

            const issuer = await signIn();
            const link = await issue(issuer);
            await expire(link.linkId);

            await expectError((await redeemRaw(link.userCode)).response, 400, 'DeviceLinkExpiredError');

            const record = await readLink(link.linkId);
            expect(record.status).toBe('issued');
            expect(record.keyId).toBeNull();
        });

        it('R6 status of an issued link answers issued, and long-polls until it moves', async () =>
        {
            const issuer = await signIn();
            const link = await issue(issuer);

            const answer = await status(link.linkId, issuer);
            expect(answer.status).toBe(200);
            expect(await answer.json()).toEqual({ status: 'issued', expiresAtMillis: link.expiresAtMillis });

            const startedAt = Date.now();
            const waiting = status(link.linkId, issuer, 5000);
            await new Promise(resolve => setTimeout(resolve, 200));
            await redeem(link.userCode);

            const woken = await waiting;
            expect((await woken.json()).status).toBe('redeemed');
            expect(Date.now() - startedAt).toBeLessThan(2000);
        });

        it('R7 status of a redeemed link shows the device and three distinct choices, the same on every call', async () =>
        {
            const { issuer, link, device } = await redeemedLink();

            const first = await (await status(link.linkId, issuer)).json();
            const second = await (await status(link.linkId, issuer)).json();

            expect(first).toMatchObject({ status: 'redeemed', deviceName: 'New phone', platform: 'ios' });
            expect(device.fingerprint.startsWith(first.fingerprintPrefix)).toBe(true);
            expect(first.fingerprintPrefix.length).toBeLessThan(device.fingerprint.length);
            expect(first.choices).toHaveLength(3);
            expect(new Set(first.choices).size).toBe(3);
            expect(first.choices).toContain(device.matchNumber);

            for (const choice of first.choices)
            {
                expect(choice).toBeGreaterThanOrEqual(10);
                expect(choice).toBeLessThanOrEqual(99);
            }

            expect(second.choices).toEqual(first.choices);

            // The match itself is never sent on its own.
            expect(first).not.toHaveProperty('matchNumber');
        });

        it('R8 confirm with the number the device shows approves the link', async () =>
        {
            const { issuer, link, device } = await redeemedLink();

            const answer = await confirm(link.linkId, device.matchNumber, issuer);

            expect(answer.status).toBe(200);
            expect(await answer.json()).toMatchObject({ status: 'approved', deviceName: 'New phone', platform: 'ios' });

            const record = await readLink(link.linkId);
            expect(record.status).toBe('approved');
            expect(record.approvedAt).not.toBeNull();

            // Approval decides; the poll registers.
            expect(await keysOf(device.keyId)).toHaveLength(0);
        });

        it('R9 a wrong number is refused and ends the link denied — there is no second pick', async () =>
        {
            const { issuer, link, device } = await redeemedLink();
            const { choices } = await (await status(link.linkId, issuer)).json();

            await expectError(
                await confirm(link.linkId, wrongChoice(choices, device.matchNumber), issuer),
                400,
                'DeviceLinkWrongMatchError',
            );

            expect((await readLink(link.linkId)).status).toBe('denied');

            await expectError(
                await confirm(link.linkId, device.matchNumber, issuer),
                409,
                'DeviceLinkAlreadyHandledError',
            );
            await expectError(await poll(device.deviceCode), 403, 'DeviceLinkDeniedError');
            expect(await keysOf(device.keyId)).toHaveLength(0);
        });

        it('R10 deny refuses the redeemed device', async () =>
        {
            const { issuer, link } = await redeemedLink();

            const answer = await deny(link.linkId, issuer);

            expect(answer.status).toBe(200);
            expect((await answer.json()).status).toBe('denied');
            expect((await readLink(link.linkId)).status).toBe('denied');
        });

        describe('R11 another key or account is answered as if the link did not exist', () =>
        {
            const cases = [
                ['another device of the same account', () => signIn()],
                ['another account', async () =>
                {
                    await createUser(`intruder-${testIndex}@test.com`);

                    return signIn(`intruder-${testIndex}@test.com`);
                }],
            ] as const;

            for (const [who, stranger] of cases)
            {
                it(`R11 ${who}: status, confirm, deny and cancel all 404, and nothing moves`, async () =>
                {
                    const { link, device } = await redeemedLink();
                    const other = await stranger();

                    await expectError(await status(link.linkId, other), 404, 'DeviceLinkNotFoundError');
                    await expectError(await confirm(link.linkId, device.matchNumber, other), 404, 'DeviceLinkNotFoundError');
                    await expectError(await deny(link.linkId, other), 404, 'DeviceLinkNotFoundError');
                    await expectError(await cancel(link.linkId, other), 404, 'DeviceLinkNotFoundError');

                    // Identical to a handle that was never issued.
                    await expectError(await status(UNKNOWN_LINK_ID, other), 404, 'DeviceLinkNotFoundError');

                    expect((await readLink(link.linkId)).status).toBe('redeemed');
                });
            }

            it('R11 a stranger is not told a dead link is expired either', async () =>
            {
                const { link } = await redeemedLink();
                const other = await signIn();
                await expire(link.linkId);

                await expectError(await status(link.linkId, other), 404, 'DeviceLinkNotFoundError');
            });
        });

        it('R12 poll on an approved link is the login, and registers the key under the issuer\'s account once', async () =>
        {
            const { device } = await approvedLink();

            const answer = await poll(device.deviceCode);
            expect(answer.status).toBe(200);

            const body = await answer.json();
            expect(body).toMatchObject({
                status: 'approved',
                mfaRequired: false,
                userId: String(await userIdOf(owner)),
                email: owner,
                passwordChangeRequired: false,
            });
            expect(typeof body.publicId).toBe('string');

            const keys = await keysOf(device.keyId);
            expect(keys).toHaveLength(1);
            expect(keys[0].userId).toBe(await userIdOf(owner));
            expect(keys[0].isActive).toBe(true);
            expect(keys[0].deviceName).toBe('New phone');

            // Once: the next poll finds nothing.
            await expectError(await poll(device.deviceCode), 404, 'DeviceLinkNotFoundError');
            expect(await keysOf(device.keyId)).toHaveLength(1);
        });

        it('R12 the approved answer has exactly the keys a password login answers with', async () =>
        {
            const { device } = await approvedLink();
            const polled = await (await poll(device.deviceCode)).json();

            const keyPair = generateKeyPair('ES256');
            const login = await (await post('/_auth/login', {
                email: owner,
                password: PASSWORD,
                publicKey: keyPair.publicKey,
                keyId: keyPair.keyId,
                fingerprint: keyPair.fingerprint,
                algorithm: keyPair.algorithm,
            })).json();

            const { status: pollStatus, ...rest } = polled;

            expect(pollStatus).toBe('approved');
            expect(Object.keys(rest).sort()).toEqual(Object.keys(login).sort());
        });

        it('R13 poll on a redeemed link answers pending with the interval', async () =>
        {
            const { device } = await redeemedLink();

            const answer = await poll(device.deviceCode);

            expect(answer.status).toBe(200);
            expect(await answer.json()).toEqual({ status: 'pending', intervalMillis: DEFAULT_DEVICE_AUTH_INTERVAL_MS });
        });

        it('R14 poll on a denied link is refused 403, and registers nothing', async () =>
        {
            const { device } = await deniedLink();

            await expectError(await poll(device.deviceCode), 403, 'DeviceLinkDeniedError');
            expect(await keysOf(device.keyId)).toHaveLength(0);
        });

        describe('R15 past expiry every call is refused as expired, whatever the state', () =>
        {
            const cases = [
                ['redeemed', redeemedLink],
                ['approved', approvedLink],
                ['denied', deniedLink],
            ] as const;

            for (const [state, arrange] of cases)
            {
                it(`R15 ${state}: redeem, status, confirm, deny, cancel and poll are all 400, and no key is registered`, async () =>
                {
                    const { issuer, link, device } = await arrange();
                    await expire(link.linkId);

                    await expectError((await redeemRaw(link.userCode)).response, 400, 'DeviceLinkExpiredError');
                    await expectError(await status(link.linkId, issuer), 400, 'DeviceLinkExpiredError');
                    await expectError(await confirm(link.linkId, device.matchNumber, issuer), 400, 'DeviceLinkExpiredError');
                    await expectError(await deny(link.linkId, issuer), 400, 'DeviceLinkExpiredError');
                    await expectError(await cancel(link.linkId, issuer), 400, 'DeviceLinkExpiredError');
                    await expectError(await poll(device.deviceCode), 400, 'DeviceLinkExpiredError');

                    expect((await readLink(link.linkId)).status).toBe(state);
                    expect(await keysOf(device.keyId)).toHaveLength(0);
                });
            }

            it('R15 issued: status and cancel are 400', async () =>
            {
                const issuer = await signIn();
                const link = await issue(issuer);
                await expire(link.linkId);

                await expectError(await status(link.linkId, issuer), 400, 'DeviceLinkExpiredError');
                await expectError(await cancel(link.linkId, issuer), 400, 'DeviceLinkExpiredError');
            });

            it('R15 a consumed link stays not found to the new device once it also expires', async () =>
            {
                const { link, device } = await consumedLink();
                await expire(link.linkId);

                await expectError(await poll(device.deviceCode), 404, 'DeviceLinkNotFoundError');
                await expectError((await redeemRaw(link.userCode)).response, 404, 'DeviceLinkNotFoundError');
            });
        });

        describe('R16 the issuer signing out expires its link', () =>
        {
            it('R16 logout while issued: the code can no longer be redeemed', async () =>
            {
                const issuer = await signIn();
                const link = await issue(issuer);

                expect((await post('/_auth/logout', {}, issuer.authorization)).status).toBe(204);

                const redeemed = await redeemRaw(link.userCode);
                await expectError(redeemed.response, 400, 'DeviceLinkExpiredError');
                expect((await readLink(link.linkId)).keyId).toBeNull();
            });

            it('R16 the issuing key revoked from another device while redeemed: poll is expired, confirm impossible', async () =>
            {
                const { issuer, link, device } = await redeemedLink();
                const other = await signIn();

                const revoked = await post('/_auth/keys/revoke', { keyId: issuer.keyId }, other.authorization);
                expect(revoked.status).toBe(200);

                await expectError(await poll(device.deviceCode), 400, 'DeviceLinkExpiredError');

                // The issuer's own requests are refused before they reach the link:
                // its key is what was revoked.
                expect((await confirm(link.linkId, device.matchNumber, issuer)).status).toBe(401);

                expect((await readLink(link.linkId)).status).toBe('redeemed');
                expect(await keysOf(device.keyId)).toHaveLength(0);
            });

            it('R16 the issuing key revoked after confirm: the approval registers nothing', async () =>
            {
                const { issuer, device } = await approvedLink();
                const other = await signIn();

                await post('/_auth/keys/revoke', { keyId: issuer.keyId }, other.authorization);

                await expectError(await poll(device.deviceCode), 400, 'DeviceLinkExpiredError');
                expect(await keysOf(device.keyId)).toHaveLength(0);
            });

            it('R16 the issuing key running out expires the link like a revocation', async () =>
            {
                const { issuer, device } = await redeemedLink();

                await getTestDb()
                    .update(userPublicKeys)
                    .set({ expiresAt: new Date(Date.now() - 1000) })
                    .where(eq(userPublicKeys.keyId, issuer.keyId));

                await expectError(await poll(device.deviceCode), 400, 'DeviceLinkExpiredError');
            });
        });

        describe('R17 cancel expires a link nobody has been let in by', () =>
        {
            it('R17 issued: 200, and the code can no longer be redeemed', async () =>
            {
                const issuer = await signIn();
                const link = await issue(issuer);

                const answer = await cancel(link.linkId, issuer);

                expect(answer.status).toBe(200);
                expect((await answer.json()).status).toBe('expired');
                expect((await readLink(link.linkId)).status).toBe('expired');
                await expectError((await redeemRaw(link.userCode)).response, 400, 'DeviceLinkExpiredError');
            });

            it('R17 redeemed: 200, and the waiting device is told the link expired', async () =>
            {
                const { issuer, link, device } = await redeemedLink();

                expect((await cancel(link.linkId, issuer)).status).toBe(200);

                await expectError(await poll(device.deviceCode), 400, 'DeviceLinkExpiredError');
                await expectError(await confirm(link.linkId, device.matchNumber, issuer), 400, 'DeviceLinkExpiredError');
            });

            it('R17 approved: refused as already handled — a decision is not undone by closing the screen', async () =>
            {
                const { issuer, link } = await approvedLink();

                await expectError(await cancel(link.linkId, issuer), 409, 'DeviceLinkAlreadyHandledError');
                expect((await readLink(link.linkId)).status).toBe('approved');
            });
        });

        it('R18 two polls on one approved link: exactly one registers the key, the other is 404', async () =>
        {
            const { device } = await approvedLink();

            const [first, second] = await Promise.all([poll(device.deviceCode), poll(device.deviceCode)]);
            const statuses = [first.status, second.status].sort();

            expect(statuses).toEqual([200, 404]);

            const loser = first.status === 404 ? first : second;
            expect((await loser.json()).error.code).toBe('DeviceLinkNotFoundError');
            expect(await keysOf(device.keyId)).toHaveLength(1);
        });
    });

    describe('races and revocation', () =>
    {
        it('two devices redeeming one code: exactly one parks its key, the other is told the code is unknown', async () =>
        {
            const issuer = await signIn();
            const link = await issue(issuer);

            const [first, second] = await Promise.all([
                redeemRaw(link.userCode, 'First'),
                redeemRaw(link.userCode, 'Second'),
            ]);

            expect([first.response.status, second.response.status].sort()).toEqual([200, 404]);

            const winner = first.response.status === 200 ? first : second;
            const loser = winner === first ? second : first;

            expect((await loser.response.json()).error.code).toBe('DeviceLinkNotFoundError');
            expect((await readLink(link.linkId)).keyId).toBe(winner.keyPair.keyId);
        });

        it('R2 concurrent issues from one key leave exactly one live link', async () =>
        {
            const issuer = await signIn();

            const links = await Promise.all(Array.from({ length: 6 }, () => issue(issuer)));

            expect(new Set(links.map(link => link.linkId)).size).toBe(links.length);

            const rows = await getTestDb()
                .select()
                .from(deviceLinks)
                .where(eq(deviceLinks.issuerKeyId, issuer.keyId));

            expect(rows).toHaveLength(links.length);
            expect(rows.filter(row => row.status === 'issued')).toHaveLength(1);
            expect(rows.filter(row => row.status === 'expired')).toHaveLength(links.length - 1);
        });

        it('two concurrent confirms, right and wrong number: exactly one outcome', async () =>
        {
            const { issuer, link, device } = await redeemedLink();
            const { choices } = await (await status(link.linkId, issuer)).json();

            const [right, wrong] = await Promise.all([
                confirm(link.linkId, device.matchNumber, issuer),
                confirm(link.linkId, wrongChoice(choices, device.matchNumber), issuer),
            ]);

            const { status: ending } = await readLink(link.linkId);

            if (ending === 'approved')
            {
                expect(right.status).toBe(200);
                await expectError(wrong, 409, 'DeviceLinkAlreadyHandledError');
                expect((await poll(device.deviceCode)).status).toBe(200);
                expect(await keysOf(device.keyId)).toHaveLength(1);
            }
            else
            {
                expect(ending).toBe('denied');
                await expectError(wrong, 400, 'DeviceLinkWrongMatchError');
                await expectError(right, 409, 'DeviceLinkAlreadyHandledError');
                await expectError(await poll(device.deviceCode), 403, 'DeviceLinkDeniedError');
                expect(await keysOf(device.keyId)).toHaveLength(0);
            }
        });

        it('the issuer signing out between redeem and confirm makes confirm impossible, even from its own session', async () =>
        {
            const { issuer, link, device } = await redeemedLink();

            expect((await post('/_auth/logout', {}, issuer.authorization)).status).toBe(204);

            expect((await confirm(link.linkId, device.matchNumber, issuer)).status).toBe(401);
            await expectError(await poll(device.deviceCode), 400, 'DeviceLinkExpiredError');
            expect(await keysOf(device.keyId)).toHaveLength(0);
        });

        it('a confirm whose issuing key is revoked as it lands approves nothing', async () =>
        {
            // The key is revoked after authenticate admitted the request and the
            // service read the link, but before the transition statement runs —
            // the statement's own key condition is what refuses it.
            const { issuer, link, device } = await redeemedLink();
            const realApprove = deviceLinksRepository.approve.bind(deviceLinksRepository);

            const spy = vi.spyOn(deviceLinksRepository, 'approve')
                .mockImplementationOnce(async (id: number) =>
                {
                    await getTestDb()
                        .update(userPublicKeys)
                        .set({ isActive: false, revokedAt: new Date() })
                        .where(eq(userPublicKeys.keyId, issuer.keyId));

                    return realApprove(id);
                });

            try
            {
                await expectError(await confirm(link.linkId, device.matchNumber, issuer), 400, 'DeviceLinkExpiredError');
            }
            finally
            {
                spy.mockRestore();
            }

            expect((await readLink(link.linkId)).status).toBe('redeemed');
            await expectError(await poll(device.deviceCode), 400, 'DeviceLinkExpiredError');
            expect(await keysOf(device.keyId)).toHaveLength(0);
        });

        it('revoke-all that spares the issuer still expires its approved link', async () =>
        {
            const { issuer, link, device } = await approvedLink();

            expect((await post('/_auth/keys/revoke-all', {}, issuer.authorization)).status).toBe(200);

            expect((await readLink(link.linkId)).status).toBe('expired');
            await expectError(await poll(device.deviceCode), 400, 'DeviceLinkExpiredError');
            expect(await keysOf(device.keyId)).toHaveLength(0);
        });

        it('a key parked on a denied or expired link is never usable: it cannot sign and it cannot be collected', async () =>
        {
            const { device } = await deniedLink();

            await expectError(await poll(device.deviceCode), 403, 'DeviceLinkDeniedError');
            expect(await keysOf(device.keyId)).toHaveLength(0);

            // The parked keyId signs nothing: authenticate does not know it.
            const keyPair = generateKeyPair('ES256');
            const forged = generateClientToken({ keyId: device.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' });
            expect((await post('/_auth/keys/list', {}, `Bearer ${forged}`)).status).toBe(401);
        });
    });

    describe('what a redeem stores', () =>
    {
        it('stores a hash of the device code, never the device code', async () =>
        {
            const { link, device } = await redeemedLink();
            const record = await readLink(link.linkId);

            expect(record.deviceCodeHash).toBe(hashDeviceCode(device.deviceCode));
            expect(JSON.stringify(record)).not.toContain(device.deviceCode);
        });

        it('accepts the code as typed — dashes, spaces and lower case', async () =>
        {
            const issuer = await signIn();
            const link = await issue(issuer);

            const typed = ` ${link.userCode.toLowerCase().replace('-', ' ')} `;
            const { response } = await redeemRaw(typed);

            expect(response.status).toBe(200);
        });

        it('refuses key material that does not hold together, before the issuer ever sees it', async () =>
        {
            const issuer = await signIn();
            const link = await issue(issuer);
            const keyPair = generateKeyPair('ES256');
            const other = generateKeyPair('ES256');

            const response = await post('/_auth/device/link/redeem', {
                userCode: link.userCode,
                publicKey: keyPair.publicKey,
                keyId: keyPair.keyId,
                fingerprint: other.fingerprint,
                algorithm: 'ES256',
            });

            await expectError(response, 400, 'InvalidKeyFingerprintError');
            expect((await readLink(link.linkId)).status).toBe('issued');
        });

        it('refuses an oversize public key at validation, as device/start does', async () =>
        {
            const issuer = await signIn();
            const link = await issue(issuer);
            const keyPair = generateKeyPair('ES256');

            const response = await post('/_auth/device/link/redeem', {
                userCode: link.userCode,
                publicKey: 'A'.repeat(4096),
                keyId: keyPair.keyId,
                fingerprint: keyPair.fingerprint,
            });

            expect(response.status).toBe(400);
            expect((await readLink(link.linkId)).status).toBe('issued');
        });

        it('confirm and deny before any device redeemed are refused, and the link keeps waiting', async () =>
        {
            const issuer = await signIn();
            const link = await issue(issuer);

            await expectError(await confirm(link.linkId, 42, issuer), 409, 'DeviceLinkNotRedeemedError');
            await expectError(await deny(link.linkId, issuer), 409, 'DeviceLinkNotRedeemedError');
            expect((await readLink(link.linkId)).status).toBe('issued');
        });
    });

    describe('happy path', () =>
    {
        it('issue → redeem → status → confirm → poll signs the new device in, and status reports it collected', async () =>
        {
            const issuer = await signIn();
            const link = await issue(issuer);
            const device = await redeem(link.userCode);

            const shown = await (await status(link.linkId, issuer)).json();
            expect(shown.choices).toContain(device.matchNumber);

            expect((await confirm(link.linkId, device.matchNumber, issuer)).status).toBe(200);

            const login = await poll(device.deviceCode);
            expect((await login.json()).status).toBe('approved');

            expect((await (await status(link.linkId, issuer)).json()).status).toBe('consumed');

            // The new key signs requests for the issuer's account.
            const keys = await keysOf(device.keyId);
            expect(keys[0].userId).toBe(await userIdOf(owner));
        });
    });
});
