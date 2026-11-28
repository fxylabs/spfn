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
import { eq } from 'drizzle-orm';

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

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const OWNER = 'link-step-up@test.com';
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

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;

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

        await getTestDb().insert(users).values({
            email: OWNER,
            passwordHash: await hashPassword(PASSWORD),
            roleId: (await getRoleByName('user'))!.id,
            emailVerifiedAt: new Date(),
        });
    });

    afterEach(() =>
    {
        __resetSecondFactorPolicyForTests();
        __resetChannelsForTests();
    });

    function post(path: string, body: unknown, authorization?: string)
    {
        return app.request(path, {
            method: 'POST',
            headers: authorization ? { ...JSON_HEADERS, Authorization: authorization } : JSON_HEADERS,
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
});
