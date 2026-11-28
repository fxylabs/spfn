/**
 * A device link narrowed to ops tokens by its issuer (#524), from issue to
 * `POST /_auth/ops-tokens`, driven against the mounted router the way
 * device-link-step-up.test.ts drives an ordinary link.
 *
 * The rows A-M, A-R4 to A-R6, A-R8, A-B, A-T, A-S1 to A-S3 and B-M of design d175c;
 * A-P, the row the passkey-naming window (#539) makes necessary; and A-S4,
 * the service's own bound on a lifetime the route's schema already checks.
 * A-R7 (the issuer signs out after confirm) is not here: the verification row
 * it must not find names a key by foreign key, so it cannot exist without the
 * key row; a copy moved ahead of the spend fails A-M on that key, and on
 * A-R7's own path the link is judged dead before the copy can run. M is the
 * row where everything matches — an enrolled administrator whose window is
 * open at issue and at confirm, the link narrowed, the right number typed,
 * redeemed through `redeem`, collected directly; each R row changes one thing.
 *
 * | row | what differs from M | answer | goes unnoticed without it |
 * | --- | --- | --- | --- |
 * | M | — | issue and redeem echo the narrowing; `status` `typed`, no `choices`; the poll carries `keyReach` and `keyExpiresAtMillis`; the key held to `opsTokens`, unbound, at the lifetime; its verification the issuer's; issuance 200, the token admitted | a link that narrows nothing, or a narrowed key with no window |
 * | R4 | an ordinary link | `choices` with three; a 90-day full key, no verification row; issuance 403 STEP_UP_REQUIRED | a full key inheriting the issuer's window |
 * | R5 | the wrong number typed | 400 WrongMatch; denied `wrong_match`; the right number then 409; the poll 400 | a typed number allowing a second guess |
 * | R6 | redeemed through `redeem/web`, behind the proxy | 404; the link still `issued`; no pending cookie | a browser session holding a terminal's key |
 * | R8 | a bound account, collected through the RPC proxy | the key unbound, at the lifetime | a bound narrowed key: 24 hours that renewal extends |
 * | B | a bound account, with a `linkIssue` proof | list 200, revoke 200, issuance 403 PASSKEY_PROOF_REQUIRED `opsTokenIssue`; no token row | a narrowed key skipping binding's proof |
 * | T | stepped up at T0, confirmed at T0+9m50s, polled at once, issuance at T0+10m10s | 403 STEP_UP_REQUIRED; no token row | the copy restarting the window |
 * | S1 | `keyLifetimeMillis` without `reach` | 400; no link row | a full key holding a stated lifetime |
 * | S2 | a lifetime three times the window | the echo and the key's expiry capped at the window | a narrowed key outliving its window |
 * | S3 | past the key's lifetime (fake clock) | issuance 401 KeyExpiredError; no token row | the stated lifetime lost between the link and the key |
 * | S4 | `issueDeviceLinkService` called with a lifetime of 0 or 1.5 ms | ValidationError; no link row | a link issued for a key no registration will write, refused only at its collection |
 * | P | the issuer stepped up with a marked passkey | issuance 200; once that passkey is revoked, 403 | the copy dropping `passkey_id`, or a window outliving its passkey |
 * | B-M | an unenrolled administrator's narrowed key, collected end to end | list, revoke and issuance 200; logout 204; then 401 | a key collected by a link that its reach refuses |
 * | D | device-code login: `device/start`, `approve` and `poll` each given `reach` and `keyLifetimeMillis` | a full key: no `keyReach`, no reach, the full 90 days | device-code login narrowing a key nobody signed in stated |
 * | C1 | an application profile reporting the issuing key's id issues and confirms; its window opened 9 minutes ago, the key's own at enrolment | the copy the profile's record; issuance 2 minutes later 403 | the key's later window carried over one the confirming profile never opened |
 * | C2 | as C1, the key having no record and the profile a fresh one | the copy the profile's record; issuance 200 | a profile's proven step-up carried over as none |
 * | C3 | the key issues with its window 9 minutes old; the profile reporting its id steps up and confirms | the copy the profile's record; issuance 2 minutes later 200 | the issuing credential's record copied instead of the confirming one's |
 *
 * In C1 to C3 an application profile reports the issuing key's id, so it
 * answers that key's links as the key does, under a step-up record of its own.
 *
 * The window is moved by ageing the issuer's verification, or by a fake
 * `Date` once everything the row needs from the link has happened: the
 * link's own TTL keeps running on real time.
 *
 * Every row puts the environment, the clock, the stubs and the proxy back:
 * the package's tests share one fork.
 *
 * No secret, code or key value here is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { enableBinding, FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { mountProxy } from '../helpers/rpc-proxy';
import { deviceLinks, mfaVerifications, opsTokens, userPublicKeys, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { COOKIE_NAMES } from '@/server/lib/config';
import { KEY_TTL_DAYS } from '@/server/lib/key-policy';
import { authenticate } from '@/server/middleware/authenticate';
import { opsTokenAuth } from '@/server/middleware/ops-token-auth';
import { issueDeviceLinkService } from '@/server/services/device-link.service';
import { ValidationError } from '@spfn/core/errors';
import { registerAuthProfile } from '@/server/middleware/auth-profiles';
import { CLIENT_PROOF_HEADERS } from '@/server/client-proof/admission';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { createOpsRouter, opsRoute } = await import('@spfn/core/ops');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const EMAIL = 'admin@narrowed524.test';
const PASSWORD = 'Password123!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
/** `SPFN_AUTH_MFA_STEP_UP_MINUTES` unset: ten minutes. */
const WINDOW_MS = 10 * 60_000;
const FULL_KEY_LIFETIME_MS = KEY_TTL_DAYS * 24 * 60 * 60 * 1000;
const NARROWED = { reach: 'opsTokens' };

/** Header the test middleware reads instead of running proxy-guard for real. */
const CLIENT_TYPE_HEADER = 'x-test-client-type';
/** An application profile, and the header its verifier reads the reported key id from. */
const PROFILE = 'narrowed524Profile';
const PROFILE_KEY_HEADER = 'x-narrowed524-profile-key';

/** A key the test holds: what it signs requests with. */
interface Session
{
    authorization: string;
    keyId: string;
}

/** A link from issue to collection, and what each step answered. */
interface Collected
{
    session: Session;
    issued: Record<string, unknown>;
    redeemed: Record<string, unknown>;
    polled: Record<string, unknown>;
    collectedAt: number;
}

/** What the application's ops routes ran for. */
const handled: string[] = [];

/** The application's ops surface: what an issued token is for. */
function opsRouter()
{
    return createOpsRouter({
        whoami: opsRoute.get('/whoami')
            .handler(async () =>
            {
                handled.push('ops');

                return { ok: true };
            }),
    }, { auth: opsTokenAuth });
}

/** The backend as the proxy reaches it: every request is the trusted proxy's (`clientType: 'web'`). */
function proxiedBackend(): Hono
{
    const backend = new Hono();

    backend.use('*', async (c, next) =>
    {
        c.set('clientType' as never, 'web' as never);
        await next();
    });
    registerRoutes(backend, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
    backend.onError(ErrorHandler());

    return backend;
}

describe.skipIf(!dbAvailable)('a device link narrowed to ops tokens (#524)', () =>
{
    let app: Hono;
    let userId: number;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = `active:${Buffer.alloc(32, 9).toString('base64')}`;

        // An application profile that reports whichever key id the request names
        registerAuthProfile(PROFILE, {
            verify: async c => ({ userId: String(userId), keyId: c.req.header(PROFILE_KEY_HEADER)!, scheme: PROFILE }),
        });

        app = new Hono();
        app.use('*', async (c, next) =>
        {
            const declared = c.req.header(CLIENT_TYPE_HEADER);

            if (declared)
            {
                c.set('clientType', declared);
            }

            await next();
        });

        const serverMiddlewares = [{ name: authenticate.name, handler: authenticate.handler }];

        registerRoutes(app, opsRouter(), serverMiddlewares);
        registerRoutes(app, mainAuthRouter, serverMiddlewares);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        resetMemoryRateLimitStore();
        handled.length = 0;

        const [row] = await db.insert(users).values({
            email: EMAIL,
            passwordHash: await hashPassword(PASSWORD),
            roleId: (await getRoleByName('admin'))!.id,
            emailVerifiedAt: new Date(),
        }).returning({ id: users.id });

        userId = Number(row!.id);
    });

    afterEach(() =>
    {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    function send(method: string, path: string, session?: Session, body?: unknown, proxied = false)
    {
        const headers: Record<string, string> = { ...JSON_HEADERS, 'user-agent': CHROME };

        if (session)
        {
            headers.Authorization = session.authorization;
        }

        if (proxied)
        {
            headers[CLIENT_TYPE_HEADER] = 'web';
        }

        return app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    }

    function post(path: string, body: unknown, session?: Session, proxied = false)
    {
        return send('POST', path, session, body, proxied);
    }

    function sessionFor(keyPair: ReturnType<typeof generateKeyPair>): Session
    {
        const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' });

        return { authorization: `Bearer ${token}`, keyId: keyPair.keyId };
    }

    /** The administrator's whole-account key, signed in by password — through the proxy when `proxied`. */
    async function signIn(proxied = false): Promise<Session>
    {
        const keyPair = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email: EMAIL,
            password: PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        }, undefined, proxied);

        expect(response.status).toBe(200);

        return sessionFor(keyPair);
    }

    function codeFor(secret: string, offsetSteps = 0): string
    {
        return hotp(decodeBase32(secret), totpStep(Date.now()) + offsetSteps);
    }

    /** Enrol a TOTP second factor on this device; its window opens with the confirmation. */
    async function enrol(issuer: Session): Promise<string>
    {
        const enroll = await post('/_auth/mfa/totp/enroll', {}, issuer);
        expect(enroll.status).toBe(200);

        const secret = (await enroll.json()).secret as string;
        expect((await post('/_auth/mfa/totp/confirm', { code: codeFor(secret) }, issuer)).status).toBe(200);

        return secret;
    }

    /** Move this device's verification back in time; the window is ten minutes. */
    async function ageVerification(issuer: Session, millis: number): Promise<void>
    {
        await getTestDb()
            .update(mfaVerifications)
            .set({ verifiedAt: new Date(Date.now() - millis) })
            .where(eq(mfaVerifications.keyId, issuer.keyId));
    }

    /**
     * Issue a link. A narrowed one must come back narrowed: a server that
     * ignored `reach` issues an ordinary link, and every narrowed row's other
     * answers would then be an ordinary link's.
     */
    async function issue(issuer: Session, body: Record<string, unknown> = NARROWED): Promise<Record<string, any>>
    {
        const response = await post('/_auth/device/link/issue', body, issuer);
        expect(response.status, await response.clone().text()).toBe(200);

        const issued = await response.json();

        if (body.reach)
        {
            expect(issued).toMatchObject({ reach: body.reach });
        }

        return issued;
    }

    /** A terminal redeeming the code with its own key, directly. */
    async function redeem(userCode: string)
    {
        const keyPair = generateKeyPair('ES256');
        const response = await post('/_auth/device/link/redeem', {
            userCode,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            deviceName: 'spfn CLI',
            platform: 'desktop',
        });
        expect(response.status, await response.clone().text()).toBe(200);

        return { keyPair, redeemed: await response.json() as Record<string, any> };
    }

    function confirm(issuer: Session, linkId: string, choice: number)
    {
        return post('/_auth/device/link/confirm', { linkId, choice }, issuer);
    }

    function poll(deviceCode: string)
    {
        return post('/_auth/device/link/poll', { deviceCode });
    }

    /** Issue, redeem, confirm with the right number and collect directly: the terminal's key. */
    async function collect(issuer: Session, body: Record<string, unknown> = NARROWED, issueProof: Record<string, unknown> = {}): Promise<Collected>
    {
        const issued = await issue(issuer, { ...body, ...issueProof });
        const { keyPair, redeemed } = await redeem(issued.userCode);
        expect((await confirm(issuer, issued.linkId, redeemed.matchNumber)).status).toBe(200);

        const collectedAt = Date.now();
        const polled = await poll(redeemed.deviceCode);
        expect(polled.status, await polled.clone().text()).toBe(200);

        return { session: sessionFor(keyPair), issued, redeemed, polled: await polled.json(), collectedAt };
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId)).limit(1);

        return row;
    }

    async function verificationOf(keyId: string)
    {
        const [row] = await getTestDb().select().from(mfaVerifications).where(eq(mfaVerifications.keyId, keyId));

        return row;
    }

    async function readLink(linkId: string)
    {
        const [row] = await getTestDb().select().from(deviceLinks).where(eq(deviceLinks.linkId, linkId));

        return row!;
    }

    async function tokenRows(): Promise<number>
    {
        return (await getTestDb().select().from(opsTokens)).length;
    }

    function issueOpsToken(session: Session)
    {
        return post('/_auth/ops-tokens', { name: 'terminal', scopes: ['*'] }, session);
    }

    /** The stable code and the class name, which the body carries side by side. */
    async function expectError(response: Response, status: number, code: string)
    {
        const body = await response.json();

        expect(response.status, JSON.stringify(body)).toBe(status);
        expect(body.code ?? body.error?.code).toBe(code);

        return body;
    }

    /** `expiresAt` is `lifetime` from the collection, within the request's own duration. */
    function expectExpiresAfter(expiresAt: Date | number, collectedAt: number, lifetime: number)
    {
        const at = typeof expiresAt === 'number' ? expiresAt : expiresAt.getTime();

        expect(at).toBeGreaterThanOrEqual(collectedAt + lifetime);
        expect(at).toBeLessThanOrEqual(Date.now() + lifetime);
    }

    /** Every `Date` from now on reads `millis` later; timers stay real. */
    function clockForward(millis: number): void
    {
        const now = Date.now();

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(now + millis);
    }

    // ========================================================================
    // A bound account (R8, B)
    // ========================================================================

    /** A web session of the account, a passkey on it, and session binding on. */
    async function boundIssuer(): Promise<{ issuer: Session; authenticator: FixtureAuthenticator }>
    {
        const issuer = await signIn(true);
        const authenticator = await FixtureAuthenticator.create();
        const options = await post('/_auth/passkeys/register/options', {}, issuer, true);
        const registered = await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({ challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID }),
        }, issuer, true);
        expect(registered.status).toBe(200);

        const bound = await enableBinding((path, body) => post(path, body, issuer, true), authenticator, { origin: ORIGIN, rpId: RP_ID });
        expect(bound.status).toBe(200);

        return { issuer, authenticator };
    }

    /** A `linkIssue` passkey assertion, made by the issuer's session. */
    async function linkIssueProof(issuer: Session, authenticator: FixtureAuthenticator, counter: number): Promise<unknown>
    {
        const options = await post('/_auth/session/passkey-proof/options', { procedure: 'linkIssue' }, issuer, true);
        expect(options.status).toBe(200);

        return authenticator.assert({ challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID, counter });
    }

    // ========================================================================
    // An application profile reporting a device key's id (C1 to C3)
    // ========================================================================

    /** A request signed as the application profile, reporting `device`'s key id. */
    function asProfile(path: string, body: unknown, device: Session)
    {
        return app.request(path, {
            method: 'POST',
            headers: { ...JSON_HEADERS, [CLIENT_PROOF_HEADERS.profile]: PROFILE, [PROFILE_KEY_HEADER]: device.keyId },
            body: JSON.stringify(body),
        });
    }

    async function profileVerification()
    {
        const [row] = await getTestDb().select().from(mfaVerifications).where(eq(mfaVerifications.profile, PROFILE));

        return row!;
    }

    /** The profile's verification moved back in time, as `ageVerification` moves a key's. */
    async function ageProfileVerification(millis: number): Promise<void>
    {
        await getTestDb()
            .update(mfaVerifications)
            .set({ verifiedAt: new Date(Date.now() - millis) })
            .where(eq(mfaVerifications.profile, PROFILE));
    }

    /** A narrowed link issued by the profile, which must come back narrowed as `issue`'s does. */
    async function issueAsProfile(device: Session): Promise<Record<string, any>>
    {
        const response = await asProfile('/_auth/device/link/issue', NARROWED, device);
        expect(response.status, await response.clone().text()).toBe(200);

        const issued = await response.json();
        expect(issued).toMatchObject(NARROWED);

        return issued;
    }

    /** Redeem, confirm as the profile with the right number, and collect: the terminal's key pair. */
    async function collectConfirmedByProfile(device: Session, issued: Record<string, any>)
    {
        const { keyPair, redeemed } = await redeem(issued.userCode);
        const confirmed = await asProfile('/_auth/device/link/confirm', { linkId: issued.linkId, choice: redeemed.matchNumber }, device);
        expect(confirmed.status, await confirmed.clone().text()).toBe(200);
        expect((await poll(redeemed.deviceCode)).status).toBe(200);

        return keyPair;
    }

    // ========================================================================
    // The rows
    // ========================================================================

    it('A-M: a narrowed link echoes its narrowing, is typed, and lets in a key held to ops tokens that carries the issuer\'s window and issues a working token', async () =>
    {
        const issuer = await signIn();
        await enrol(issuer);

        const issued = await issue(issuer);
        expect(issued).toMatchObject({ reach: 'opsTokens', keyLifetimeMillis: WINDOW_MS });

        const { keyPair, redeemed } = await redeem(issued.userCode);
        expect(redeemed).toMatchObject({ reach: 'opsTokens', keyLifetimeMillis: WINDOW_MS });

        const status = await (await post('/_auth/device/link/status', { linkId: issued.linkId }, issuer)).json();
        expect(status).toMatchObject({ status: 'redeemed', match: 'typed', reach: 'opsTokens', keyLifetimeMillis: WINDOW_MS });
        expect(status).not.toHaveProperty('choices');

        expect((await confirm(issuer, issued.linkId, redeemed.matchNumber)).status).toBe(200);

        const collectedAt = Date.now();
        const polled = await (await poll(redeemed.deviceCode)).json();
        expect(polled).toMatchObject({ status: 'approved', keyReach: 'opsTokens' });
        expect(polled).not.toHaveProperty('sessionBinding');
        expectExpiresAfter(polled.keyExpiresAtMillis, collectedAt, WINDOW_MS);

        const key = (await keyRow(keyPair.keyId))!;
        expect(key).toMatchObject({ reach: 'opsTokens', binding: 'none' });
        expect(key.expiresAt!.getTime()).toBe(polled.keyExpiresAtMillis);

        const issuerVerification = (await verificationOf(issuer.keyId))!;
        expect(await verificationOf(keyPair.keyId)).toMatchObject({
            userId,
            method: issuerVerification.method,
            passkeyId: null,
            verifiedAt: issuerVerification.verifiedAt,
            profile: null,
        });

        const minted = await issueOpsToken(sessionFor(keyPair));
        expect(minted.status).toBe(200);
        const { token } = await minted.json() as { token: string };

        expect((await app.request('/_ops/whoami', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
        expect(handled).toEqual(['ops']);
    });

    it('A-R4: an ordinary link draws three choices and lets in a 90-day full key with no window — its issuance is 403 STEP_UP_REQUIRED', async () =>
    {
        const issuer = await signIn();
        await enrol(issuer);

        const issued = await issue(issuer, {});
        expect(issued).not.toHaveProperty('reach');
        const { keyPair, redeemed } = await redeem(issued.userCode);
        expect(redeemed).not.toHaveProperty('reach');

        const status = await (await post('/_auth/device/link/status', { linkId: issued.linkId }, issuer)).json();
        expect(status).toMatchObject({ status: 'redeemed', match: 'choices' });
        expect(status.choices).toHaveLength(3);
        expect(status.choices).toContain(redeemed.matchNumber);

        expect((await confirm(issuer, issued.linkId, redeemed.matchNumber)).status).toBe(200);
        const collectedAt = Date.now();
        const polled = await (await poll(redeemed.deviceCode)).json();
        expect(polled).not.toHaveProperty('keyReach');

        const key = (await keyRow(keyPair.keyId))!;
        expect(key.reach).toBeNull();
        expectExpiresAfter(key.expiresAt!, collectedAt, FULL_KEY_LIFETIME_MS);
        expect(await verificationOf(keyPair.keyId)).toBeUndefined();

        await expectError(await issueOpsToken(sessionFor(keyPair)), 403, 'STEP_UP_REQUIRED');
        expect(await tokenRows()).toBe(0);
    });

    it('A-R5: a wrong typed number denies the narrowed link with wrong_match — the right one is then 409, the poll 400, and no key is written', async () =>
    {
        const issuer = await signIn();
        await enrol(issuer);
        const issued = await issue(issuer);
        const { keyPair, redeemed } = await redeem(issued.userCode);
        const wrong = redeemed.matchNumber === 99 ? 10 : redeemed.matchNumber + 1;

        const status = await (await post('/_auth/device/link/status', { linkId: issued.linkId }, issuer)).json();
        expect(status.match).toBe('typed');

        await expectError(await confirm(issuer, issued.linkId, wrong), 400, 'DeviceLinkWrongMatchError');
        expect(await readLink(issued.linkId)).toMatchObject({ status: 'denied', deniedReason: 'wrong_match' });

        await expectError(await confirm(issuer, issued.linkId, redeemed.matchNumber), 409, 'DeviceLinkAlreadyHandledError');
        await expectError(await poll(redeemed.deviceCode), 400, 'DeviceLinkWrongMatchError');
        expect(await keyRow(keyPair.keyId)).toBeUndefined();
    });

    it('A-R6: a narrowed link\'s code through redeem/web, behind the proxy, is 404 — the link stays issued and no pending cookie is set', async () =>
    {
        const issuer = await signIn();
        const issued = await issue(issuer);
        const proxy = mountProxy(proxiedBackend());

        const response = await proxy.call('redeemDeviceLinkWeb', { body: { userCode: issued.userCode } }, {
            headers: { 'user-agent': CHROME },
        });

        await expectError(response, 404, 'DeviceLinkNotFoundError');
        expect(response.headers.getSetCookie().filter(line => line.startsWith(`${COOKIE_NAMES.DEVICE_PENDING}=`))).toEqual([]);
        expect(await readLink(issued.linkId)).toMatchObject({ status: 'issued', keyId: null });
    });

    it('A-R8: on a bound account, a narrowed key collected through the RPC proxy is unbound and lives its stated lifetime', async () =>
    {
        const { issuer, authenticator } = await boundIssuer();
        const issued = await issue(issuer, { ...NARROWED, passkeyResponse: await linkIssueProof(issuer, authenticator, 1) });
        const { keyPair, redeemed } = await redeem(issued.userCode);
        expect((await confirm(issuer, issued.linkId, redeemed.matchNumber)).status).toBe(200);
        const proxy = mountProxy(proxiedBackend());

        const collectedAt = Date.now();
        // The proxy holds no pending cookie for a code the terminal redeemed itself, so it seals
        // nothing and answers 401; the backend registered the key all the same.
        await proxy.call('pollDeviceLink', { body: { deviceCode: redeemed.deviceCode } }, { headers: { 'user-agent': CHROME } });

        const key = (await keyRow(keyPair.keyId))!;
        expect(key).toMatchObject({ reach: 'opsTokens', binding: 'none', viaWebProxy: true });
        expectExpiresAfter(key.expiresAt!, collectedAt, WINDOW_MS);
    });

    it('A-B: on a bound account, a narrowed key lets in by a linkIssue proof lists and revokes, and issuance is 403 PASSKEY_PROOF_REQUIRED for opsTokenIssue', async () =>
    {
        const { issuer, authenticator } = await boundIssuer();
        const { session } = await collect(issuer, NARROWED, { passkeyResponse: await linkIssueProof(issuer, authenticator, 1) });
        const [existing] = await getTestDb().insert(opsTokens).values({
            name: 'existing', tokenHash: 'a'.repeat(64), scopes: ['*'], issuedBy: userId,
        }).returning({ id: opsTokens.id });

        expect((await send('GET', '/_auth/ops-tokens', session)).status).toBe(200);
        expect((await send('DELETE', `/_auth/ops-tokens/${existing!.id}`, session)).status).toBe(200);

        const refused = await expectError(await issueOpsToken(session), 403, 'PASSKEY_PROOF_REQUIRED');
        expect(refused.details).toMatchObject({ procedure: 'opsTokenIssue' });
        expect(await tokenRows()).toBe(1);
    });

    it('A-T: stepped up at T0 and confirmed at T0+9m50s, the narrowed key\'s issuance at T0+10m10s is 403 STEP_UP_REQUIRED — the copy does not restart the window', async () =>
    {
        const issuer = await signIn();
        await enrol(issuer);
        const issued = await issue(issuer);
        const { keyPair, redeemed } = await redeem(issued.userCode);

        await ageVerification(issuer, WINDOW_MS - 10_000);
        expect((await confirm(issuer, issued.linkId, redeemed.matchNumber)).status).toBe(200);
        expect((await poll(redeemed.deviceCode)).status).toBe(200);

        clockForward(20_000);

        await expectError(await issueOpsToken(sessionFor(keyPair)), 403, 'STEP_UP_REQUIRED');
        expect(await tokenRows()).toBe(0);
    });

    it('D: device-code login given reach and keyLifetimeMillis at start, approve and poll registers a full 90-day key with no reach', async () =>
    {
        const approver = await signIn();
        const keyPair = generateKeyPair('ES256');
        const asked = { reach: 'opsTokens', keyLifetimeMillis: 60_000 };

        const started = await post('/_auth/device/start', {
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            deviceName: 'spfn CLI',
            platform: 'desktop',
            ...asked,
        });
        expect(started.status, await started.clone().text()).toBe(200);
        const { deviceCode, userCode } = await started.json();
        expect((await post('/_auth/device/approve', { userCode, ...asked }, approver)).status).toBe(200);

        const collectedAt = Date.now();
        const polled = await post('/_auth/device/poll', { deviceCode, ...asked });
        expect(polled.status, await polled.clone().text()).toBe(200);
        expect(await polled.json()).not.toHaveProperty('keyReach');

        const key = (await keyRow(keyPair.keyId))!;
        expect(key.reach).toBeNull();
        expectExpiresAfter(key.expiresAt!, collectedAt, FULL_KEY_LIFETIME_MS);
    });

    it('A-C1: a profile issues and confirms with a window 9 minutes old — the narrowed key carries the profile\'s, not the fresher one of the key it reports, and 2 minutes later its issuance is 403', async () =>
    {
        const device = await signIn();
        const secret = await enrol(device);
        expect((await asProfile('/_auth/mfa/step-up', { code: codeFor(secret, 1) }, device)).status).toBe(204);
        await ageProfileVerification(WINDOW_MS - 60_000);

        const issued = await issueAsProfile(device);
        const keyPair = await collectConfirmedByProfile(device, issued);

        expect((await verificationOf(keyPair.keyId))!.verifiedAt).toEqual((await profileVerification()).verifiedAt);

        clockForward(2 * 60_000);

        await expectError(await issueOpsToken(sessionFor(keyPair)), 403, 'STEP_UP_REQUIRED');
        expect(await tokenRows()).toBe(0);
    });

    it('A-C2: a profile that stepped up issues and confirms, the key it reports never having stepped up — the narrowed key carries the profile\'s window and issues', async () =>
    {
        const device = await signIn();
        const secret = await enrol(device);
        await getTestDb().delete(mfaVerifications).where(eq(mfaVerifications.keyId, device.keyId));
        expect((await asProfile('/_auth/mfa/step-up', { code: codeFor(secret, 1) }, device)).status).toBe(204);

        const issued = await issueAsProfile(device);
        const keyPair = await collectConfirmedByProfile(device, issued);

        expect((await verificationOf(keyPair.keyId))!.verifiedAt).toEqual((await profileVerification()).verifiedAt);
        expect((await issueOpsToken(sessionFor(keyPair))).status).toBe(200);
    });

    it('A-C3: the key issues with a window 9 minutes old and the profile reporting its id steps up and confirms — the copy is the profile\'s, and 2 minutes later issuance is 200', async () =>
    {
        const device = await signIn();
        const secret = await enrol(device);
        await ageVerification(device, WINDOW_MS - 60_000);
        const issued = await issue(device);

        expect((await asProfile('/_auth/mfa/step-up', { code: codeFor(secret, 1) }, device)).status).toBe(204);
        const keyPair = await collectConfirmedByProfile(device, issued);

        expect((await verificationOf(keyPair.keyId))!.verifiedAt).toEqual((await profileVerification()).verifiedAt);

        clockForward(2 * 60_000);

        expect((await issueOpsToken(sessionFor(keyPair))).status).toBe(200);
    });

    it('A-S1: keyLifetimeMillis without reach is 400 and writes no link', async () =>
    {
        const issuer = await signIn();

        await expectError(await post('/_auth/device/link/issue', { keyLifetimeMillis: 60_000 }, issuer), 400, 'ValidationError');
        expect(await getTestDb().select().from(deviceLinks)).toEqual([]);
    });

    it('A-S2: a lifetime three times the window is capped at the window, in the echo and in the key\'s expiry', async () =>
    {
        const issuer = await signIn();

        const collected = await collect(issuer, { ...NARROWED, keyLifetimeMillis: 3 * WINDOW_MS });

        expect(collected.issued.keyLifetimeMillis).toBe(WINDOW_MS);
        expect(collected.redeemed.keyLifetimeMillis).toBe(WINDOW_MS);
        expectExpiresAfter((await keyRow(collected.session.keyId))!.expiresAt!, collected.collectedAt, WINDOW_MS);
    });

    it('A-S3: past its stated lifetime the narrowed key\'s issuance is 401 KeyExpiredError and no token is written', async () =>
    {
        const issuer = await signIn();
        const { session } = await collect(issuer, { ...NARROWED, keyLifetimeMillis: 60_000 });

        clockForward(2 * 60_000);

        await expectError(await issueOpsToken(session), 401, 'KeyExpiredError');
        expect(await tokenRows()).toBe(0);
    });

    it('A-S4: issueDeviceLinkService refuses a lifetime that is not a whole number of milliseconds above 0, and writes no link', async () =>
    {
        const issuer = await signIn();
        const call = (keyLifetimeMillis: number) => issueDeviceLinkService(
            { userId, keyId: issuer.keyId },
            { credential: { kind: 'deviceKey', keyId: issuer.keyId } },
            { reach: 'opsTokens', keyLifetimeMillis },
        );

        await expect(call(0)).rejects.toBeInstanceOf(ValidationError);
        await expect(call(1.5)).rejects.toBeInstanceOf(ValidationError);
        expect(await getTestDb().select().from(deviceLinks)).toEqual([]);
    });

    it('A-P: stepped up with a marked passkey, the narrowed key issues while that passkey lives; once it is revoked, another still marked, issuance is 403', async () =>
    {
        const issuer = await signIn();
        const register = async () =>
        {
            const authenticator = await FixtureAuthenticator.create();
            const options = await post('/_auth/passkeys/register/options', {}, issuer);
            const registered = await post('/_auth/passkeys/register/verify', {
                response: authenticator.attest({ challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID }),
            }, issuer);
            expect(registered.status, await registered.clone().text()).toBe(200);

            return { authenticator, passkeyId: (await registered.json()).passkeyId as string };
        };
        const stepUpWith = async (authenticator: FixtureAuthenticator, counter: number) =>
        {
            const options = await post('/_auth/mfa/step-up/options', {}, issuer);
            const response = await post('/_auth/mfa/step-up', {
                response: authenticator.assert({ challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID, counter }),
            }, issuer);
            expect(response.status, await response.clone().text()).toBe(204);
        };

        const first = await register();
        expect((await post('/_auth/mfa/passkey/mark', { passkeyId: first.passkeyId, secondFactor: true }, issuer)).status).toBe(200);
        await stepUpWith(first.authenticator, 1);
        const second = await register();
        expect((await post('/_auth/mfa/passkey/mark', { passkeyId: second.passkeyId, secondFactor: true }, issuer)).status).toBe(200);
        await stepUpWith(first.authenticator, 2);

        const { session } = await collect(issuer);
        expect(await verificationOf(session.keyId)).toMatchObject({ method: 'passkey', passkeyId: Number(first.passkeyId) });
        expect((await issueOpsToken(session)).status).toBe(200);

        expect((await post('/_auth/passkeys/revoke', { passkeyId: first.passkeyId }, issuer)).status).toBe(200);

        await expectError(await issueOpsToken(session), 403, 'STEP_UP_REQUIRED');
        expect(await tokenRows()).toBe(1);
    });

    it('B-M: a key collected by a real narrowed link lists, revokes and issues; logout is 204 and any later call 401', async () =>
    {
        const owner = await signIn();
        const issued = await issueOpsToken(owner);
        expect(issued.status).toBe(200);
        const tokenId = (await issued.json()).opsToken.id as number;

        const { session } = await collect(owner);

        expect((await send('GET', '/_auth/ops-tokens', session)).status).toBe(200);
        expect((await send('DELETE', `/_auth/ops-tokens/${tokenId}`, session)).status).toBe(200);
        expect((await issueOpsToken(session)).status).toBe(200);
        expect((await post('/_auth/logout', {}, session)).status).toBe(204);
        expect((await send('GET', '/_auth/ops-tokens', session)).status).toBe(401);
    });
});
