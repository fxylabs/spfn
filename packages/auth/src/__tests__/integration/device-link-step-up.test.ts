/**
 * A device link asks its issuer's second factor, at issue and at confirm (#528).
 *
 * The rows A-R1, A-R2, A-R3 and A-E of design d175c, on an ordinary link,
 * driven against the mounted auth router the way device-link.test.ts drives it.
 * A-U (an unenrolled issuer is asked nothing) is not here: every row of
 * device-link.test.ts issues and confirms as an unenrolled account already.
 *
 * | row | what differs | answer | must not happen |
 * | --- | --- | --- | --- |
 * | R1 | the window is closed at issue | 403 STEP_UP_REQUIRED; 200 after a step-up | a link row; the earlier live link expired |
 * | R2 | window open at issue (8 min), closed at confirm (11 min) | 403, right and wrong pick alike; the same number 200 after a step-up | the link denied or approved by a refused call |
 * | R3 | the window is open only on another key of the account | issue 403 | a link row |
 * | E | an enrolment-only session, under `required` with deviceLink on | boots; issue 403 SECOND_FACTOR_ENROLMENT_REQUIRED | a link row |
 * | C | an application profile reporting the device key's id, its own window closed, the key's open | confirm 403 | the link approved by the key's window |
 * | L1 | the step-up removed while issue waits on the account lock | issue 403 | a link row |
 * | L2 | the step-up removed while confirm waits on the account lock | confirm 403 | the link approved |
 * | H | confirm on a link already approved, or denied, with the window closed | 409 DeviceLinkAlreadyHandledError | 403 |
 *
 * The window is moved by ageing the device's verification, not the clock: the
 * link's own five-minute TTL keeps running on real time.
 *
 * Every row puts the policy, the channels and the environment back: the
 * package's tests share one fork.
 *
 * No secret, code or key value here is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { deviceLinks, mfaVerifications, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { __resetChannelsForTests, configureChannels } from '@/server/lib/channels-config';
import {
    __resetSecondFactorPolicyForTests,
    assertSecondFactorPolicy,
    configureSecondFactor,
} from '@/server/lib/second-factor-policy';
import { authenticate } from '@/server/middleware/authenticate';
import { registerAuthProfile } from '@/server/middleware/auth-profiles';
import { CLIENT_PROOF_HEADERS } from '@/server/client-proof/admission';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const OWNER = 'link-step-up@test.com';
const PROFILE = 'i528LinkProfile';
const PROFILE_KEY_HEADER = 'x-i528-profile-key';
const ACTIVE_KEY = `active:${Buffer.alloc(32, 11).toString('base64')}`;

/** A signed-in device: what it signs requests with, and which key it is. */
interface Issuer
{
    authorization: string;
    keyId: string;
}

describe.skipIf(!dbAvailable)('Device link asks the issuer\'s step-up (#528)', () =>
{
    let app: Hono;
    const savedKeys = process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
    let ownerId = 0;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;

        // An application profile that reports whichever key id the request names
        registerAuthProfile(PROFILE, {
            verify: async c => ({ userId: String(ownerId), keyId: c.req.header(PROFILE_KEY_HEADER)!, scheme: PROFILE }),
        });

        app = new Hono();
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await teardownTestDb();

        if (savedKeys === undefined)
        {
            delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
        }
        else
        {
            process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = savedKeys;
        }
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();

        const [owner] = await getTestDb().insert(users).values({
            email: OWNER,
            passwordHash: await hashPassword(PASSWORD),
            roleId: (await getRoleByName('user'))!.id,
            emailVerifiedAt: new Date(),
        }).returning({ id: users.id });
        ownerId = owner.id;
    });

    afterEach(() =>
    {
        __resetSecondFactorPolicyForTests();
        __resetChannelsForTests();
    });

    /** `signedBy` is a device's `Authorization` value, or the headers of an application profile. */
    function post(path: string, body: unknown, signedBy?: string | Record<string, string>)
    {
        const credential = typeof signedBy === 'string' ? { Authorization: signedBy } : signedBy;

        return app.request(path, {
            method: 'POST',
            headers: { ...JSON_HEADERS, ...credential },
            body: JSON.stringify(body),
        });
    }

    async function signIn(): Promise<Issuer>
    {
        const keyPair = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email: OWNER,
            password: PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        });

        expect(response.status).toBe(200);

        const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' });

        return { authorization: `Bearer ${token}`, keyId: keyPair.keyId };
    }

    function codeFor(secret: string, offsetSteps = 0): string
    {
        return hotp(decodeBase32(secret), totpStep(Date.now()) + offsetSteps);
    }

    /** Enrol a TOTP second factor; the confirming device's window opens with it. */
    async function enrol(issuer: Issuer): Promise<string>
    {
        const enroll = await post('/_auth/mfa/totp/enroll', {}, issuer.authorization);
        expect(enroll.status).toBe(200);

        const secret = (await enroll.json()).secret as string;
        expect((await post('/_auth/mfa/totp/confirm', { code: codeFor(secret) }, issuer.authorization)).status).toBe(200);

        return secret;
    }

    /** Step up on this device with the next step's code — the confirm spent this one. */
    async function stepUp(issuer: Issuer, secret: string): Promise<void>
    {
        expect((await post('/_auth/mfa/step-up', { code: codeFor(secret, 1) }, issuer.authorization)).status).toBe(204);
    }

    /** Move this device's verification back in time; the window is 10 minutes. */
    async function ageVerification(issuer: Issuer, minutes: number): Promise<void>
    {
        await getTestDb()
            .update(mfaVerifications)
            .set({ verifiedAt: new Date(Date.now() - minutes * 60_000) })
            .where(eq(mfaVerifications.keyId, issuer.keyId));
    }

    async function issue(issuer: Issuer)
    {
        const response = await post('/_auth/device/link/issue', {}, issuer.authorization);
        expect(response.status).toBe(200);

        return await response.json() as { linkId: string; userCode: string };
    }

    async function redeem(userCode: string): Promise<number>
    {
        const keyPair = generateKeyPair('ES256');
        const response = await post('/_auth/device/link/redeem', {
            userCode,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        });

        expect(response.status).toBe(200);

        return (await response.json()).matchNumber as number;
    }

    /** The stable code, which the body carries beside the error's class name. */
    async function expectError(response: Response, status: number, code: string)
    {
        expect(response.status).toBe(status);
        expect((await response.json()).code).toBe(code);
    }

    function linksOf(issuer: Issuer)
    {
        return getTestDb().select().from(deviceLinks).where(eq(deviceLinks.issuerKeyId, issuer.keyId));
    }

    async function readLink(linkId: string)
    {
        const [row] = await getTestDb().select().from(deviceLinks).where(eq(deviceLinks.linkId, linkId));

        return row;
    }

    it('R1: a closed window at issue is 403 STEP_UP_REQUIRED, writes nothing, and issues after a step-up', async () =>
    {
        const issuer = await signIn();
        const secret = await enrol(issuer);
        const earlier = await issue(issuer);

        await ageVerification(issuer, 11);

        await expectError(await post('/_auth/device/link/issue', {}, issuer.authorization), 403, 'STEP_UP_REQUIRED');

        const after = await linksOf(issuer);
        expect(after).toHaveLength(1);
        expect(after[0].linkId).toBe(earlier.linkId);
        expect(after[0].status).toBe('issued');

        await stepUp(issuer, secret);
        await issue(issuer);
    });

    it('R2: a window closed between issue and confirm refuses the pick without spending it', async () =>
    {
        const issuer = await signIn();
        const secret = await enrol(issuer);

        await ageVerification(issuer, 8);
        const { linkId, userCode } = await issue(issuer);
        const matchNumber = await redeem(userCode);
        await ageVerification(issuer, 11);

        const wrong = matchNumber === 99 ? 10 : matchNumber + 1;
        const confirm = (choice: number) => post('/_auth/device/link/confirm', { linkId, choice }, issuer.authorization);

        await expectError(await confirm(wrong), 403, 'STEP_UP_REQUIRED');
        await expectError(await confirm(matchNumber), 403, 'STEP_UP_REQUIRED');

        const refused = await readLink(linkId);
        expect(refused.status).toBe('redeemed');
        expect(refused.matchNumber).toBe(matchNumber);
        expect(refused.deniedReason).toBeNull();

        await stepUp(issuer, secret);

        const confirmed = await confirm(matchNumber);
        expect(confirmed.status).toBe(200);
        expect((await confirmed.json()).status).toBe('approved');
    });

    it('R3: a window open only on another key of the account does not let this key issue', async () =>
    {
        const issuer = await signIn();
        const other = await signIn();
        await enrol(other);

        await expectError(await post('/_auth/device/link/issue', {}, issuer.authorization), 403, 'STEP_UP_REQUIRED');

        expect(await linksOf(issuer)).toHaveLength(0);
    });

    it('E: under required with deviceLink on, the app boots and an enrolment-only session may not issue', async () =>
    {
        configureChannels({ deviceCode: false, deviceLink: true });
        configureSecondFactor({ required: true });
        assertSecondFactorPolicy();

        const issuer = await signIn();

        await expectError(
            await post('/_auth/device/link/issue', {}, issuer.authorization),
            403,
            'SECOND_FACTOR_ENROLMENT_REQUIRED',
        );

        expect(await linksOf(issuer)).toHaveLength(0);
    });

    /** The headers of an application profile that reports `keyId` as its key. */
    function profileReporting(keyId: string): Record<string, string>
    {
        return { [CLIENT_PROOF_HEADERS.profile]: PROFILE, [PROFILE_KEY_HEADER]: keyId };
    }

    /** Whether some backend is waiting on a lock the backend `pid` holds. */
    async function someoneWaitsOn(pid: number): Promise<boolean>
    {
        const [row] = await getTestDb().execute<{ waiting: boolean }>(sql`
            SELECT exists(SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))) AS waiting
        `);

        return row!.waiting;
    }

    /**
     * Send `request` while a second connection holds the account's `users` row
     * `FOR UPDATE` and has removed its step-up records; commit that removal once
     * the request is seen waiting on the row (or has answered without waiting),
     * and answer the request's response. The holder is released in a `finally`,
     * whatever the request does.
     */
    async function withStepUpRemovedUnderLock(request: () => Response | Promise<Response>): Promise<Response>
    {
        let release!: () => void;
        const released = new Promise<void>(resolve =>
        {
            release = resolve;
        });
        let holderPid!: (pid: number) => void;
        const holding = new Promise<number>(resolve =>
        {
            holderPid = resolve;
        });

        const holder = getTestDb().transaction(async tx =>
        {
            await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for('update');
            await tx.delete(mfaVerifications).where(eq(mfaVerifications.userId, ownerId));
            const [backend] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
            holderPid(Number(backend!.pid));
            await released;
        });

        const pid = await holding;
        let answered = false;
        const pending = Promise.resolve(request()).finally(() =>
        {
            answered = true;
        });

        try
        {
            while (!answered && !await someoneWaitsOn(pid))
            {
                await new Promise(resolve => setImmediate(resolve));
            }
        }
        finally
        {
            release();
            await holder;
        }

        return await pending;
    }

    it('C: confirm is judged by the request\'s credential — an application profile\'s own window, not the device key it reports', async () =>
    {
        const device = await signIn();
        const secret = await enrol(device);
        const profile = profileReporting(device.keyId);

        expect((await post('/_auth/mfa/step-up', { code: codeFor(secret, 1) }, profile)).status).toBe(204);
        const issued = await post('/_auth/device/link/issue', {}, profile);
        expect(issued.status).toBe(200);
        const { linkId, userCode } = await issued.json();
        const matchNumber = await redeem(userCode);

        // The profile's window closes; the device key's, opened by the enrolment, stays open
        await getTestDb().update(mfaVerifications)
            .set({ verifiedAt: new Date(Date.now() - 11 * 60_000) })
            .where(eq(mfaVerifications.profile, PROFILE));

        await expectError(await post('/_auth/device/link/confirm', { linkId, choice: matchNumber }, profile), 403, 'STEP_UP_REQUIRED');
        expect((await readLink(linkId)).status).toBe('redeemed');
    });

    it('L1: a step-up removed while issue waits on the account lock refuses the issue', async () =>
    {
        const issuer = await signIn();
        await enrol(issuer);

        const response = await withStepUpRemovedUnderLock(() => post('/_auth/device/link/issue', {}, issuer.authorization));

        await expectError(response, 403, 'STEP_UP_REQUIRED');
        expect(await linksOf(issuer)).toHaveLength(0);
    }, 30_000);

    it('L2: a step-up removed while confirm waits on the account lock refuses the confirm', async () =>
    {
        const issuer = await signIn();
        await enrol(issuer);
        const { linkId, userCode } = await issue(issuer);
        const matchNumber = await redeem(userCode);

        const response = await withStepUpRemovedUnderLock(
            () => post('/_auth/device/link/confirm', { linkId, choice: matchNumber }, issuer.authorization),
        );

        await expectError(response, 403, 'STEP_UP_REQUIRED');
        expect((await readLink(linkId)).status).toBe('redeemed');
    }, 30_000);

    it('H: confirm on a link already approved, or denied, answers 409 DeviceLinkAlreadyHandledError with the window closed', async () =>
    {
        const issuer = await signIn();
        const secret = await enrol(issuer);
        const confirm = (linkId: string, choice: number) => post('/_auth/device/link/confirm', { linkId, choice }, issuer.authorization);

        const approved = await issue(issuer);
        const approvedNumber = await redeem(approved.userCode);
        expect((await confirm(approved.linkId, approvedNumber)).status).toBe(200);
        await ageVerification(issuer, 11);

        const afterApproval = await confirm(approved.linkId, approvedNumber);
        expect(afterApproval.status).toBe(409);
        expect((await afterApproval.json()).error.code).toBe('DeviceLinkAlreadyHandledError');

        await stepUp(issuer, secret);
        const denied = await issue(issuer);
        const deniedNumber = await redeem(denied.userCode);
        expect((await post('/_auth/device/link/deny', { linkId: denied.linkId }, issuer.authorization)).status).toBe(200);
        await ageVerification(issuer, 11);

        const afterDenial = await confirm(denied.linkId, deniedNumber);
        expect(afterDenial.status).toBe(409);
        expect((await afterDenial.json()).error.code).toBe('DeviceLinkAlreadyHandledError');
    });
});
