/**
 * Device-code login, driven end to end against the mounted auth router.
 *
 * A device with no key on file parks its public key, shows a short code, and
 * polls; the account owner reads that code on a device that is already signed in
 * and approves or denies it. There is no token to hand over — the poll that wins
 * registers the parked key, which is the whole of what "logged in" means here.
 *
 * The cases are the cross of the record's state and the operation applied to it.
 * A spent record answers exactly as one that never existed, so that row is flat;
 * so is the expired row, since a code that sat too long is refused whatever it
 * says.
 *
 * | state ↓ op → | info (userCode) | approve | deny | poll (deviceCode) |
 * | --- | --- | --- | --- | --- |
 * | pending | device details | → approved, userId bound | → denied | `{status:'pending'}` |
 * | approved | AlreadyHandled | AlreadyHandled | AlreadyHandled | key registered + → consumed + LoginResult |
 * | denied | AlreadyHandled | AlreadyHandled | AlreadyHandled | DeviceAuthDenied |
 * | consumed | NotFound | NotFound | NotFound | NotFound |
 * | expired (pending/approved/denied) | Expired | Expired | Expired | Expired |
 * | unknown code | NotFound | NotFound | NotFound | NotFound |
 *
 * The two flat rows overlap in one place — a consumed record that has also
 * expired — and `consumed` wins it. Answering "expired" there would tell the
 * holder of a spent code that it was once real, which is exactly what the
 * identical NotFound exists to prevent; it would just take ten minutes to leak.
 *
 * The expired row is the cross of every state a record can have died in with
 * every operation, not just expired-pending: which refusal a dead code gives
 * must not read out the state it died in.
 *
 * Beyond the table: the consume race, user-code normalization, key material that
 * does not hold together, and the row-level fact that the device code is stored
 * as a hash and not as itself.
 *
 * And three things that live outside the record but decide what it is worth —
 * a global revocation, which has to reach an approval nobody has collected yet;
 * the state of the account behind the approval, which the poll re-checks because
 * it is a login; and the size of what an unauthenticated caller can park in the
 * table, since nothing sweeps it.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { configureChannels } from '@/server/lib/channels-config';
import { users, userPublicKeys, deviceAuthorizations } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { hashDeviceCode } from '@/server/lib/device-code';
import { deviceAuthorizationsRepository, usersRepository } from '@/server/repositories';
import { runInTransaction } from '@spfn/core/db';
import type { UserStatus } from '@/server/types';
import { authenticate } from '@/server/middleware/authenticate';
import { getDatabase } from '@spfn/core/db';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';

/** A well-formed code that was never issued. */
const UNKNOWN_USER_CODE = 'ZZZZ-ZZZZ';
const UNKNOWN_DEVICE_CODE = 'this-device-code-was-never-issued';

describe.skipIf(!dbAvailable)('Device-code login', () =>
{
    let app: Hono;

    // Every route here is rate limited, by client IP and — where there is one —
    // by the calling account. Both are real in this app, so a test that reused
    // either would be counted against its neighbours and start seeing 429s that
    // say nothing about the code. One account and one source address per test is
    // also what production looks like: these are separate people on separate
    // devices, not one client in a loop.
    let testIndex = 0;
    let owner: string;
    let clientIp: string;

    beforeAll(async () =>
    {
        await setupTestDb();
        // selfDeletion is off unless the app states it (#475).
        configureChannels({ selfDeletion: true });
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
        owner = `owner-${testIndex}@test.com`;
        clientIp = `10.0.${testIndex >> 8}.${testIndex & 0xff}`;

        const userRole = await getRoleByName('user');

        await db.insert(users).values({
            email: owner,
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        });
    });

    /** Exactly what an already-signed-in device does: sign in, then sign requests. */
    async function signIn(email = owner): Promise<string>
    {
        const keyPair = generateKeyPair('ES256');

        const response = await app.request('/_auth/login', {
            method: 'POST',
            headers: { ...JSON_HEADERS, 'x-forwarded-for': clientIp },
            body: JSON.stringify({
                email,
                password: PASSWORD,
                publicKey: keyPair.publicKey,
                keyId: keyPair.keyId,
                fingerprint: keyPair.fingerprint,
                algorithm: keyPair.algorithm,
            }),
        });

        expect(response.status).toBe(200);

        const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', {
            expiresIn: '5m',
        });

        return `Bearer ${token}`;
    }

    function request(method: string, path: string, body: unknown, authorization?: string)
    {
        const headers: Record<string, string> = { ...JSON_HEADERS, 'x-forwarded-for': clientIp };

        if (authorization)
        {
            headers.Authorization = authorization;
        }

        return app.request(path, { method, headers, body: JSON.stringify(body) });
    }

    function post(path: string, body: unknown, authorization?: string)
    {
        return request('POST', path, body, authorization);
    }

    /** The waiting device asking to be let in. Returns its codes and its keyId. */
    async function startDevice(deviceName = 'Living room TV')
    {
        const keyPair = generateKeyPair('ES256');

        const response = await post('/_auth/device/start', {
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            deviceName,
            platform: 'desktop',
        });

        expect(response.status).toBe(200);

        return { ...await response.json(), keyId: keyPair.keyId, fingerprint: keyPair.fingerprint };
    }

    const info = (userCode: string, authorization: string) =>
        post('/_auth/device/info', { userCode }, authorization);
    const approve = (userCode: string, authorization: string) =>
        post('/_auth/device/approve', { userCode }, authorization);
    const deny = (userCode: string, authorization: string) =>
        post('/_auth/device/deny', { userCode }, authorization);
    const poll = (deviceCode: string) =>
        post('/_auth/device/poll', { deviceCode });

    /** Assert an error response by its documented discriminator, not by prose. */
    async function expectError(response: Response, status: number, code: string)
    {
        expect(response.status).toBe(status);
        expect((await response.json()).error.code).toBe(code);
    }

    function readRecord(userCode: string)
    {
        return getDatabase('write')!
            .select()
            .from(deviceAuthorizations)
            .where(eq(deviceAuthorizations.userCode, userCode.replace('-', '')));
    }

    /** What a refused start must leave behind: nothing under its keyId. */
    function readRecordByKeyId(keyId: string)
    {
        return getDatabase('write')!
            .select()
            .from(deviceAuthorizations)
            .where(eq(deviceAuthorizations.keyId, keyId));
    }

    /** Drag a record's TTL into the past. Only the server clock ever decides this. */
    async function expire(userCode: string)
    {
        await getDatabase('write')!
            .update(deviceAuthorizations)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(deviceAuthorizations.userCode, userCode.replace('-', '')));
    }

    describe('pending', () =>
    {
        it('info returns the details of the device that is asking', async () =>
        {
            const authorization = await signIn();
            const started = await startDevice('Kitchen tablet');

            const answer = await info(started.userCode, authorization);
            expect(answer.status).toBe(200);

            const body = await answer.json();
            expect(body).toMatchObject({ deviceName: 'Kitchen tablet', platform: 'desktop' });
            expect(started.fingerprint.startsWith(body.fingerprintPrefix)).toBe(true);
            expect(body.expiresAtMillis).toBeGreaterThan(body.requestedAtMillis);
        });

        it('approve moves the record to approved and binds the approving user', async () =>
        {
            const authorization = await signIn();
            const started = await startDevice('Kitchen tablet');

            const answer = await approve(started.userCode, authorization);
            expect(answer.status).toBe(200);

            // The answer names what was let in, so a client that skipped `info`
            // can still show the user what they just approved.
            expect(await answer.json()).toMatchObject({ deviceName: 'Kitchen tablet', platform: 'desktop' });

            const [record] = await readRecord(started.userCode);
            expect(record.status).toBe('approved');
            expect(record.approvedAt).not.toBeNull();

            const [approver] = await getDatabase('write')!.select().from(users).where(eq(users.email, owner));
            expect(record.userId).toBe(approver.id);
        });

        it('deny moves the record to denied and binds nobody', async () =>
        {
            const authorization = await signIn();
            const started = await startDevice();

            expect((await deny(started.userCode, authorization)).status).toBe(204);

            const [record] = await readRecord(started.userCode);
            expect(record.status).toBe('denied');
            expect(record.userId).toBeNull();
        });

        it('poll answers pending, which is not an error', async () =>
        {
            const started = await startDevice();

            const answer = await poll(started.deviceCode);
            expect(answer.status).toBe(200);
            expect(await answer.json()).toEqual({
                status: 'pending',
                intervalMillis: started.intervalMillis,
            });
        });
    });

    describe('approved', () =>
    {
        async function approvedDevice()
        {
            const authorization = await signIn();
            const started = await startDevice();
            expect((await approve(started.userCode, authorization)).status).toBe(200);

            return { authorization, started };
        }

        it('info is refused as already handled', async () =>
        {
            const { authorization, started } = await approvedDevice();

            await expectError(await info(started.userCode, authorization), 409, 'DeviceAuthAlreadyHandledError');
        });

        it('approve is refused as already handled', async () =>
        {
            const { authorization, started } = await approvedDevice();

            await expectError(await approve(started.userCode, authorization), 409, 'DeviceAuthAlreadyHandledError');
        });

        it('deny is refused as already handled — a decision is made once', async () =>
        {
            const { authorization, started } = await approvedDevice();

            await expectError(await deny(started.userCode, authorization), 409, 'DeviceAuthAlreadyHandledError');

            const [record] = await readRecord(started.userCode);
            expect(record.status).toBe('approved');
        });

        it('poll registers the parked key, spends the record, and answers as login does', async () =>
        {
            const { started } = await approvedDevice();

            const answer = await poll(started.deviceCode);
            expect(answer.status).toBe(200);

            const body = await answer.json();
            expect(body).toMatchObject({
                status: 'approved',
                email: owner,
                passwordChangeRequired: false,
            });
            expect(body.publicId).toBeTruthy();

            const [key] = await getDatabase('write')!
                .select()
                .from(userPublicKeys)
                .where(eq(userPublicKeys.keyId, started.keyId));
            expect(key.userId).toBe(Number(body.userId));
            expect(key.isActive).toBe(true);
            expect(key.deviceName).toBe('Living room TV');

            const [record] = await readRecord(started.userCode);
            expect(record.status).toBe('consumed');
            expect(record.consumedAt).not.toBeNull();
        });
    });

    describe('denied', () =>
    {
        async function deniedDevice()
        {
            const authorization = await signIn();
            const started = await startDevice();
            expect((await deny(started.userCode, authorization)).status).toBe(204);

            return { authorization, started };
        }

        it('info is refused as already handled', async () =>
        {
            const { authorization, started } = await deniedDevice();

            await expectError(await info(started.userCode, authorization), 409, 'DeviceAuthAlreadyHandledError');
        });

        it('approve is refused as already handled — a refusal is not undone', async () =>
        {
            const { authorization, started } = await deniedDevice();

            await expectError(await approve(started.userCode, authorization), 409, 'DeviceAuthAlreadyHandledError');

            const [record] = await readRecord(started.userCode);
            expect(record.status).toBe('denied');
            expect(record.userId).toBeNull();
        });

        it('deny is refused as already handled', async () =>
        {
            const { authorization, started } = await deniedDevice();

            await expectError(await deny(started.userCode, authorization), 409, 'DeviceAuthAlreadyHandledError');
        });

        it('poll is told it was denied, so it stops waiting instead of timing out', async () =>
        {
            const { started } = await deniedDevice();

            await expectError(await poll(started.deviceCode), 403, 'DeviceAuthDeniedError');
        });
    });

    describe('consumed', () =>
    {
        async function consumedDevice()
        {
            const authorization = await signIn();
            const started = await startDevice();
            expect((await approve(started.userCode, authorization)).status).toBe(200);
            expect((await poll(started.deviceCode)).status).toBe(200);

            return { authorization, started };
        }

        it('info answers not found — a spent code says nothing about having been real', async () =>
        {
            const { authorization, started } = await consumedDevice();

            await expectError(await info(started.userCode, authorization), 404, 'DeviceAuthNotFoundError');
        });

        it('approve answers not found', async () =>
        {
            const { authorization, started } = await consumedDevice();

            await expectError(await approve(started.userCode, authorization), 404, 'DeviceAuthNotFoundError');
        });

        it('deny answers not found', async () =>
        {
            const { authorization, started } = await consumedDevice();

            await expectError(await deny(started.userCode, authorization), 404, 'DeviceAuthNotFoundError');
        });

        it('poll answers not found — the code is one-shot', async () =>
        {
            const { started } = await consumedDevice();

            await expectError(await poll(started.deviceCode), 404, 'DeviceAuthNotFoundError');
        });

        it('stays not found once it also expires, rather than becoming expired', async () =>
        {
            // Every consumed record eventually passes its TTL. If expiry were
            // judged first, a spent code would start answering 400 while a code
            // that never existed answers 404 — the enumeration oracle, delayed.
            const { authorization, started } = await consumedDevice();
            await expire(started.userCode);

            await expectError(await poll(started.deviceCode), 404, 'DeviceAuthNotFoundError');
            await expectError(await info(started.userCode, authorization), 404, 'DeviceAuthNotFoundError');
        });
    });

    describe('expired', () =>
    {
        // Expiry outranks state, so the expired row of the table is one answer
        // for every state a record can have been in when its TTL ran out — and it
        // has to be, or which refusal a dead code gives would read out the state
        // it died in. Testing only expired-pending would have left that unsaid
        // for the two states that matter most: `approved`, which is the one that
        // registers a key, and `denied`, which is where a swept record lands.
        const PRE_STATES = ['pending', 'approved', 'denied'] as const;

        async function expiredDevice(preState: typeof PRE_STATES[number])
        {
            const authorization = await signIn();
            const started = await startDevice();

            if (preState === 'approved')
            {
                expect((await approve(started.userCode, authorization)).status).toBe(200);
            }

            if (preState === 'denied')
            {
                expect((await deny(started.userCode, authorization)).status).toBe(204);
            }

            await expire(started.userCode);

            return { authorization, started };
        }

        for (const preState of PRE_STATES)
        {
            describe(`from ${preState}`, () =>
            {
                it('info is refused as expired', async () =>
                {
                    const { authorization, started } = await expiredDevice(preState);

                    await expectError(await info(started.userCode, authorization), 400, 'DeviceAuthExpiredError');
                });

                it('approve is refused as expired, and moves nothing', async () =>
                {
                    const { authorization, started } = await expiredDevice(preState);

                    await expectError(await approve(started.userCode, authorization), 400, 'DeviceAuthExpiredError');

                    const [record] = await readRecord(started.userCode);
                    expect(record.status).toBe(preState);
                });

                it('deny is refused as expired, and moves nothing', async () =>
                {
                    const { authorization, started } = await expiredDevice(preState);

                    await expectError(await deny(started.userCode, authorization), 400, 'DeviceAuthExpiredError');

                    const [record] = await readRecord(started.userCode);
                    expect(record.status).toBe(preState);
                });

                it('poll is refused as expired, and registers no key', async () =>
                {
                    const { started } = await expiredDevice(preState);

                    await expectError(await poll(started.deviceCode), 400, 'DeviceAuthExpiredError');

                    const [key] = await getDatabase('write')!
                        .select()
                        .from(userPublicKeys)
                        .where(eq(userPublicKeys.keyId, started.keyId));
                    expect(key).toBeUndefined();
                });
            });
        }

        it('refuses a record that expires between the read and the transition', async () =>
        {
            // The service reads a record before it acts on it, and the TTL can run
            // out in that gap — the window a check made only in the read cannot
            // close. Rolling this process's clock back opens the window on
            // purpose: the read judges the record live, and the database, which
            // the transition asks, does not.
            const authorization = await signIn();
            const started = await startDevice();
            expect((await approve(started.userCode, authorization)).status).toBe(200);
            await expire(started.userCode);

            const realNow = Date.now();
            vi.useFakeTimers({ toFake: ['Date'] });
            vi.setSystemTime(realNow - 60_000);

            try
            {
                await expectError(await poll(started.deviceCode), 400, 'DeviceAuthExpiredError');
            }
            finally
            {
                vi.useRealTimers();
            }

            const [key] = await getDatabase('write')!
                .select()
                .from(userPublicKeys)
                .where(eq(userPublicKeys.keyId, started.keyId));
            expect(key).toBeUndefined();

            const [record] = await readRecord(started.userCode);
            expect(record.status).toBe('approved');
        });

        it('carries the TTL into the transition statements themselves', async () =>
        {
            // The same fact one level down, without the clock trick: an expired
            // record matches none of the three conditional updates, whatever it
            // was read as a moment earlier.
            const authorization = await signIn();
            const pending = await startDevice();
            const approved = await startDevice('Second screen');
            expect((await approve(approved.userCode, authorization)).status).toBe(200);

            await expire(pending.userCode);
            await expire(approved.userCode);

            const [pendingRecord] = await readRecord(pending.userCode);
            const [approvedRecord] = await readRecord(approved.userCode);
            const ownerId = approvedRecord.userId!;

            // Under the approver's account lock, as the services write them.
            await runInTransaction(async () =>
            {
                await usersRepository.lockAccount(ownerId);

                expect(await deviceAuthorizationsRepository.approve(pendingRecord.id, ownerId, 'approving-key')).toBeNull();
                expect(await deviceAuthorizationsRepository.deny(pendingRecord.id)).toBeNull();
                expect(await deviceAuthorizationsRepository.consumeApproved(ownerId, hashDeviceCode(approved.deviceCode)))
                    .toBeNull();
            });
        });
    });

    describe('unknown code', () =>
    {
        it('info answers not found', async () =>
        {
            const authorization = await signIn();

            await expectError(await info(UNKNOWN_USER_CODE, authorization), 404, 'DeviceAuthNotFoundError');
        });

        it('approve answers not found', async () =>
        {
            const authorization = await signIn();

            await expectError(await approve(UNKNOWN_USER_CODE, authorization), 404, 'DeviceAuthNotFoundError');
        });

        it('deny answers not found', async () =>
        {
            const authorization = await signIn();

            await expectError(await deny(UNKNOWN_USER_CODE, authorization), 404, 'DeviceAuthNotFoundError');
        });

        it('poll answers not found', async () =>
        {
            await expectError(await poll(UNKNOWN_DEVICE_CODE), 404, 'DeviceAuthNotFoundError');
        });

        it('answers a consumed code and a code that never existed identically', async () =>
        {
            const authorization = await signIn();
            const started = await startDevice();
            expect((await approve(started.userCode, authorization)).status).toBe(200);
            expect((await poll(started.deviceCode)).status).toBe(200);

            const spent = await info(started.userCode, authorization);
            const never = await info(UNKNOWN_USER_CODE, authorization);

            expect(spent.status).toBe(never.status);
            expect((await spent.json()).message).toBe((await never.json()).message);
        });
    });

    describe('races and normalization', () =>
    {
        it('two polls on one approved record: exactly one registers the key', async () =>
        {
            const authorization = await signIn();
            const started = await startDevice();
            expect((await approve(started.userCode, authorization)).status).toBe(200);

            const [first, second] = await Promise.all([
                poll(started.deviceCode),
                poll(started.deviceCode),
            ]);

            const statuses = [first.status, second.status].sort();
            expect(statuses).toEqual([200, 404]);

            // The loser is told the code is unknown, which by then it is.
            const loser = first.status === 404 ? first : second;
            expect((await loser.json()).error.code).toBe('DeviceAuthNotFoundError');

            // And the key was registered exactly once, not twice.
            const keys = await getDatabase('write')!
                .select()
                .from(userPublicKeys)
                .where(eq(userPublicKeys.keyId, started.keyId));
            expect(keys).toHaveLength(1);
        });

        it('accepts the user code as typed — dashes, spaces and lower case', async () =>
        {
            const authorization = await signIn();
            const started = await startDevice();

            const typed = ` ${(started.userCode as string).toLowerCase()} `;
            expect((await info(typed, authorization)).status).toBe(200);
            expect((await approve(typed, authorization)).status).toBe(200);

            const [record] = await readRecord(started.userCode);
            expect(record.status).toBe('approved');
        });

        it('stores the user code without its dash, in upper case', async () =>
        {
            const started = await startDevice();

            expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

            const [record] = await readRecord(started.userCode);
            expect(record.userCode).toBe((started.userCode as string).replace('-', ''));
        });

        it('refuses key material that does not hold together, before anyone approves it', async () =>
        {
            // The fingerprint prefix is what the approver recognises the device
            // by, so it has to be the real fingerprint of the real public key.
            // Catching it at the poll instead would mean refusing after a person
            // already said yes.
            const keyPair = generateKeyPair('ES256');

            const response = await post('/_auth/device/start', {
                publicKey: keyPair.publicKey,
                keyId: keyPair.keyId,
                fingerprint: 'f'.repeat(64),
                algorithm: keyPair.algorithm,
            });

            await expectError(response, 400, 'InvalidKeyFingerprintError');
        });

        it('refuses a key whose type is not the algorithm it declares', async () =>
        {
            // algorithmDefaultRule fixes the algorithm when the key is parked and
            // nothing re-derives it from the key afterwards, so a P-256 key stored
            // as RS256 would only fail at proof verification — after the device
            // believes it is enrolled and a person has already approved it.
            const keyPair = generateKeyPair('ES256');

            const response = await post('/_auth/device/start', {
                publicKey: keyPair.publicKey,
                keyId: keyPair.keyId,
                fingerprint: keyPair.fingerprint,
                algorithm: 'RS256',
                platform: 'ios',
            });

            await expectError(response, 400, 'KeyAlgorithmMismatchError');
            expect(await readRecordByKeyId(keyPair.keyId)).toEqual([]);
        });

        it('refuses an RSA key that names no algorithm, because the default is ES256', async () =>
        {
            // Omitting the field is not "whatever the key is" — it is ES256, which
            // is what the row would have stored. The check runs against the
            // defaulted algorithm for exactly this case.
            const keyPair = generateKeyPair('RS256');

            const response = await post('/_auth/device/start', {
                publicKey: keyPair.publicKey,
                keyId: keyPair.keyId,
                fingerprint: keyPair.fingerprint,
                platform: 'ios',
            });

            await expectError(response, 400, 'KeyAlgorithmMismatchError');
            expect(await readRecordByKeyId(keyPair.keyId)).toEqual([]);
        });

        it('parks an RSA key that declares RS256', async () =>
        {
            // The check refuses a mismatch, not RSA. RS256 is a supported algorithm
            // and a key that is what it says it is goes through.
            const keyPair = generateKeyPair('RS256');

            const response = await post('/_auth/device/start', {
                publicKey: keyPair.publicKey,
                keyId: keyPair.keyId,
                fingerprint: keyPair.fingerprint,
                algorithm: 'RS256',
                platform: 'ios',
            });

            expect(response.status).toBe(200);

            const [record] = await readRecordByKeyId(keyPair.keyId);
            expect(record.algorithm).toBe('RS256');
        });

        it('reports a colliding user code instead of aborting the transaction', async () =>
        {
            // The start route is transactional, so a raised unique violation
            // would poison it and the retry could not run. The insert has to
            // come back empty-handed instead — this is what makes the bounded
            // redraw in startDeviceAuthService possible at all.
            const started = await startDevice();
            const [existing] = await readRecord(started.userCode);

            const collided = await deviceAuthorizationsRepository.create({
                ...existing,
                id: undefined,
                deviceCodeHash: 'a'.repeat(64),
            });

            expect(collided).toBeNull();

            // ...and the connection is still usable, which a poisoned
            // transaction would not be.
            expect((await readRecord(started.userCode))).toHaveLength(1);
        });

        it('stores a hash of the device code, never the device code', async () =>
        {
            const started = await startDevice();

            const [record] = await readRecord(started.userCode);
            expect(record.deviceCodeHash).toBe(hashDeviceCode(started.deviceCode));
            expect(record.deviceCodeHash).not.toBe(started.deviceCode);
            expect(JSON.stringify(record)).not.toContain(started.deviceCode);
        });
    });

    describe('global revocation', () =>
    {
        // Revoking `user_public_keys` alone is not a global revocation while an
        // approved-but-uncollected authorization survives it: the next poll on
        // that record registers a brand-new active key, so the sign-out is undone
        // seconds after it ran, by the very device the user was trying to cut off.
        // All three paths that revoke every key at once close it the same way.
        async function approvedDevice()
        {
            const authorization = await signIn();
            const started = await startDevice();
            expect((await approve(started.userCode, authorization)).status).toBe(200);

            return { authorization, started };
        }

        function keysOf(keyId: string)
        {
            return getDatabase('write')!
                .select()
                .from(userPublicKeys)
                .where(eq(userPublicKeys.keyId, keyId));
        }

        it('revoke-all refuses the approved code, and the next poll registers nothing', async () =>
        {
            const { authorization, started } = await approvedDevice();

            const revoked = await post('/_auth/keys/revoke-all', { includeCurrent: true }, authorization);
            expect(revoked.status).toBe(200);

            await expectError(await poll(started.deviceCode), 403, 'DeviceAuthDeniedError');
            expect(await keysOf(started.keyId)).toHaveLength(0);

            const [record] = await readRecord(started.userCode);
            expect(record.status).toBe('denied');
        });

        it('"sign out my other devices" sweeps too — a waiting device is one of them', async () =>
        {
            // includeCurrent defaults to false, sparing the calling device. The
            // waiting device is never that one: it has no key at all yet, which
            // is the whole reason it is waiting.
            const { authorization, started } = await approvedDevice();

            expect((await post('/_auth/keys/revoke-all', {}, authorization)).status).toBe(200);

            await expectError(await poll(started.deviceCode), 403, 'DeviceAuthDeniedError');
            expect(await keysOf(started.keyId)).toHaveLength(0);
        });

        it('answers a swept record exactly as a denied one on info, approve and deny', async () =>
        {
            // A swept record lands in the `denied` row of the case table, so it
            // owes the same answers — nothing about having been approved, and
            // nothing that separates it from a record its owner refused by hand.
            const { authorization, started } = await approvedDevice();

            expect((await post('/_auth/keys/revoke-all', {}, authorization)).status).toBe(200);

            await expectError(await info(started.userCode, authorization), 409, 'DeviceAuthAlreadyHandledError');
            await expectError(await approve(started.userCode, authorization), 409, 'DeviceAuthAlreadyHandledError');
            await expectError(await deny(started.userCode, authorization), 409, 'DeviceAuthAlreadyHandledError');
        });

        it('a password change refuses the approved code', async () =>
        {
            const { authorization, started } = await approvedDevice();

            const changed = await request('PUT', '/_auth/password', {
                currentPassword: PASSWORD,
                newPassword: 'NewPassword123!',
            }, authorization);
            expect(changed.status).toBe(204);

            await expectError(await poll(started.deviceCode), 403, 'DeviceAuthDeniedError');
            expect(await keysOf(started.keyId)).toHaveLength(0);
        });

        it('a deletion request refuses the approved code', async () =>
        {
            const { authorization, started } = await approvedDevice();

            const requested = await post('/_auth/deletion/request', { password: PASSWORD }, authorization);
            expect(requested.status).toBe(200);

            await expectError(await poll(started.deviceCode), 403, 'DeviceAuthDeniedError');
            expect(await keysOf(started.keyId)).toHaveLength(0);
        });

        it('revoking the approving key refuses the waiting device', async () =>
        {
            // The approval was the approving device's word, and it holds only while
            // that device's key does — the rule a device link's issuer is held to.
            // Signing that laptop out withdraws what it approved a minute ago.
            const { authorization, started } = await approvedDevice();

            const [record] = await readRecord(started.userCode);
            const [ownKey] = await getDatabase('write')!
                .select()
                .from(userPublicKeys)
                .where(eq(userPublicKeys.userId, record.userId!));

            expect((await post('/_auth/keys/revoke', { keyId: ownKey.keyId }, authorization)).status).toBe(200);

            await expectError(await poll(started.deviceCode), 400, 'DeviceAuthExpiredError');
            expect(await keysOf(started.keyId)).toHaveLength(0);
        });

        it('logging out the approving device refuses the waiting device', async () =>
        {
            const { authorization, started } = await approvedDevice();

            expect((await post('/_auth/logout', {}, authorization)).status).toBe(204);

            await expectError(await poll(started.deviceCode), 400, 'DeviceAuthExpiredError');
            expect(await keysOf(started.keyId)).toHaveLength(0);
        });

        it('rotating the approving key refuses the waiting device', async () =>
        {
            // Rotation revokes the key that approved; the replacement approved
            // nothing.
            const { authorization, started } = await approvedDevice();
            const replacement = generateKeyPair('ES256');

            const rotated = await post('/_auth/keys/rotate', {
                publicKey: replacement.publicKey,
                keyId: replacement.keyId,
                fingerprint: replacement.fingerprint,
                algorithm: replacement.algorithm,
            }, authorization);
            expect(rotated.status).toBe(200);

            await expectError(await poll(started.deviceCode), 400, 'DeviceAuthExpiredError');
            expect(await keysOf(started.keyId)).toHaveLength(0);
        });
    });

    describe('the account behind an approval', () =>
    {
        /**
         * Approval and collection are separate moments, and the account can change
         * between them. The poll is a login, so it owes the same gate `login` owes
         * — and the sweep above cannot be the only answer: it runs inside the
         * transaction that requests a deletion, and a poll already in flight can
         * have read the record before that transaction committed.
         */
        async function approvedDevice()
        {
            const authorization = await signIn();
            const started = await startDevice();
            expect((await approve(started.userCode, authorization)).status).toBe(200);

            return { authorization, started };
        }

        /**
         * Move the account underneath an approval that has already been given.
         *
         * Written straight to the row rather than through the deletion route,
         * which sweeps the record itself: that sweep runs inside the transaction
         * that requests the deletion, so a poll that read the record before it
         * committed reaches the gate with the record still approved. This is that
         * poll, and the gate is the only thing standing in front of it.
         */
        function setStatus(status: UserStatus)
        {
            return getDatabase('write')!
                .update(users)
                .set({ status })
                .where(eq(users.email, owner));
        }

        it('poll refuses to collect for an account that is pending deletion', async () =>
        {
            const { started } = await approvedDevice();
            await getDatabase('write')!.update(users).set({ deletion: 'pending' }).where(eq(users.email, owner));

            await expectError(await poll(started.deviceCode), 403, 'AccountPendingDeletionError');

            const [key] = await getDatabase('write')!
                .select()
                .from(userPublicKeys)
                .where(eq(userPublicKeys.keyId, started.keyId));
            expect(key).toBeUndefined();
        });

        it('poll refuses to collect for an account that is no longer active', async () =>
        {
            const { started } = await approvedDevice();
            await setStatus('suspended');

            await expectError(await poll(started.deviceCode), 403, 'AccountDisabledError');

            const [key] = await getDatabase('write')!
                .select()
                .from(userPublicKeys)
                .where(eq(userPublicKeys.keyId, started.keyId));
            expect(key).toBeUndefined();
        });

        it('cancelling a deletion revives the account, not the approval it refused', async () =>
        {
            // The gate has to refuse the stale approval and nothing else. A key
            // registered by that approval would have been created after the
            // deletion's revoke-all, so cancelling would restore an account
            // holding a signing credential the deletion never saw — while an
            // account the user got back must still be an account they can sign
            // into from a new device.
            const { authorization, started } = await approvedDevice();

            expect((await post('/_auth/deletion/request', { password: PASSWORD }, authorization)).status).toBe(200);
            // Public by necessity: requesting the deletion revoked every key the
            // account had, so there is nothing left to sign this with.
            expect((await post('/_auth/deletion/cancel', { email: owner, password: PASSWORD })).status).toBe(204);

            await expectError(await poll(started.deviceCode), 403, 'DeviceAuthDeniedError');
            expect(await getDatabase('write')!
                .select()
                .from(userPublicKeys)
                .where(eq(userPublicKeys.keyId, started.keyId))).toHaveLength(0);

            // ...and the way back in is open: a fresh device, start to finish.
            const revived = await signIn();
            const again = await startDevice('Replacement TV');
            expect((await approve(again.userCode, revived)).status).toBe(200);

            const answer = await poll(again.deviceCode);
            expect(answer.status).toBe(200);
            expect(await answer.json()).toMatchObject({ status: 'approved', email: owner });
        });
    });

    describe('payload bounds', () =>
    {
        it('refuses an oversize public key at validation, storing nothing', async () =>
        {
            // Fingerprinted correctly, so it is the bound that refuses it and not
            // the key check: without one, a well-formed megabyte would persist
            // into a table nothing sweeps.
            const blob = Buffer.alloc(4096, 7);

            const response = await post('/_auth/device/start', {
                publicKey: blob.toString('base64'),
                keyId: 'oversize',
                fingerprint: createHash('sha256').update(blob).digest('hex'),
                algorithm: 'ES256',
            });

            expect(response.status).toBe(400);

            const stored = await getDatabase('write')!.select().from(deviceAuthorizations);
            expect(stored).toHaveLength(0);
        });

        it('admits an RSA key, which is the largest material anyone really sends', async () =>
        {
            // The bound has to clear real key material with room to spare. RS256
            // is the widest thing this package generates, and it is a fraction of
            // the limit.
            const keyPair = generateKeyPair('RS256');

            const response = await post('/_auth/device/start', {
                publicKey: keyPair.publicKey,
                keyId: keyPair.keyId,
                fingerprint: keyPair.fingerprint,
                algorithm: keyPair.algorithm,
            });

            expect(response.status).toBe(200);
            expect(keyPair.publicKey.length).toBeLessThan(2048);
        });
    });

    describe('happy path', () =>
    {
        it('start → info → approve → poll signs the new device in', async () =>
        {
            // The waiting device: no key on file, nothing to authenticate with.
            const started = await startDevice('Studio desktop');
            expect(started.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
            expect(started.expiresAtMillis).toBeGreaterThan(Date.now());

            // It waits, and is told to keep waiting.
            expect((await (await poll(started.deviceCode)).json()).status).toBe('pending');

            // The owner, on a device that is already signed in, checks what is asking.
            const authorization = await signIn();
            const shown = await (await info(started.userCode, authorization)).json();
            expect(shown.deviceName).toBe('Studio desktop');

            // ...and says yes.
            expect((await approve(started.userCode, authorization)).status).toBe(200);

            // The next poll is the login.
            const signedIn = await (await poll(started.deviceCode)).json();
            expect(signedIn).toMatchObject({ status: 'approved', email: owner });

            // And the new device can now sign for itself, which is the only
            // thing "logged in" means here — there was never a token.
            const [key] = await getDatabase('write')!
                .select()
                .from(userPublicKeys)
                .where(eq(userPublicKeys.keyId, started.keyId));
            expect(key.isActive).toBe(true);
        });
    });
});
