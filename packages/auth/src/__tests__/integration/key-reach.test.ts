/**
 * A key held to a reach (#524), driven at the mounted router
 *
 * Every narrowed key here is registered through `registerPublicKeyService({
 * narrowing })` — the function a link's collection will call — and every
 * request enters at the router as an application mounts it: its own routes
 * first, then `mainAuthRouter`, behind the global `authenticate`.
 *
 * | Row | Request | Answer | Unnoticed without it |
 * | --- | --- | --- | --- |
 * | B-M | list, revoke, `logout` on the narrowed key | 200, 200, 204; then 401 | a reach that refuses its own routes: every row below passes while the terminal can do nothing |
 * | B-I | issuance on the narrowed key; the answered secret at an `opsTokenAuth` route | 200, a token row issued by the owner; 200, handler run | issuance outside the reach: the terminal lists and revokes but cannot mint the token it is let in for |
 * | B-K | the owner's full key lists its keys; the device notice | `reach`, the stated expiry, the notice's `reach` | the key list and the notice telling a terminal apart from a full device, and the stated lifetime written as 90 days |
 * | B-R1 | `device/link/issue` | 403 `KEY_OUT_OF_REACH`, no link row | a package route outside the reach admitting the key |
 * | B-R2 | `keys/rotate` | 403, no new key, expiry unmoved | a rotation handing the key a fresh, full one |
 * | B-R3 | an application route behind the global `authenticate` | 403, handler not run | an unmarked route admitting a narrowed key — the fail-closed property |
 * | B-R4 | an `optionalAuth` route; `opsOrUser`'s session branch | anonymous; 403 | a door other than the global `authenticate` admitting the key |
 * | B-R5 | once the account must change its password: issuance; the change; `logout` | 403 `PASSWORD_CHANGE_REQUIRED`; 403 `KEY_OUT_OF_REACH`; 204 | the reach and the requirements combined so that either admits — a narrowed key changing the account's password |
 * | B-R6 | password login on an enrolled account with a `replacementProof` the narrowed key signed | 202, the key unreplaced, its verification in place | the full account without the second factor, by replacing a narrowed key |
 * | B-B1 | registration through the proxy on a bound account; a proxied request | unbound, stated expiry, both times | a bound key's 24 hours, which renewal extends, in place of the stated lifetime |
 * | B-B2 | the owner turns binding on | the narrowed web key stays unbound | the same, by the binding switch |
 * | B-RR | password login presenting the expired narrowed key again | 409, expiry unmoved | a sign-in moving a narrowed key's expiry to 90 days |
 * | B-R7 | once the account must change its password: `device/link/issue` | 403 `PASSWORD_CHANGE_REQUIRED` | the reach asked before the requirements, answering a refusal the session cannot act on |
 * | B-N1 | a narrowed registration carrying a full key's `replacementProof` | the full key live with its verification; the narrowed key announced, with none | a narrowed key replacing a full one: revoking it and taking its step-up record unannounced |
 * | B-N2 | a narrowed registration claiming to replace the key that signed the request | the claim's refusal; the signing key live, no new key | the same, by a rotation |
 * | B-L | a narrowed registration whose `lifetimeMs` is 0, negative, NaN, Infinity, 2e14 or 91 days | `ValidationError`; no key row, no notice | a key dead at birth announced, a `RangeError` inside the transaction, or a key outliving a full one |
 * | B-L90 | a narrowed registration whose `lifetimeMs` is exactly 90 days | accepted, `expires_at` 90 days from the registration | the cap refusing its own edge, or counted in seconds |
 * | B-LF | an out-of-bounds `lifetimeMs` under a key id that exists, with a `signIn` guard | `ValidationError`, `admit` not asked | the lifetime checked after the lock and the app's `admit`, which the rollback hides |
 * | B-X | a narrowed registration with a live full key's own id and public key | 409; the key row and its verification unchanged | the full key renewed and the caller answered 200 for a narrowing never applied |
 * | B-D | `admitPrincipal` with the narrowed key and `route: null` | `keyOutOfReach` | a door with no route in front of it admitting the key |
 *
 * Every stub, spy, environment value and subscription set here is restored
 * after the row or the file.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { pinClockInsideTotpStep } from '../helpers/totp-clock';
import { enableBinding, FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { deviceLinks, mfaVerifications, opsTokens, userPublicKeys, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { signKeyReplacementProof } from '@/server/lib/key-replacement-proof';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { authenticate, optionalAuth } from '@/server/middleware/authenticate';
import { opsOrUser } from '@/server/middleware/ops-or-user';
import { opsTokenAuth } from '@/server/middleware/ops-token-auth';
import { authDeviceRegisteredEvent } from '@/server/events';
import { admitPrincipal } from '@/server/services/admission.service';
import { registerPublicKeyService } from '@/server/services/key.service';
import { KEY_TTL_DAYS } from '@/server/lib/key-policy';
import { configureSignIn, resetSignInGuardForTests } from '@/server/lib/sign-in-guard';
import { KeyIdAlreadyRegisteredError } from '@spfn/auth/errors';
import { ValidationError } from '@spfn/core/errors';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes, route, defineRouter } = await import('@spfn/core/route');
const { createOpsRouter, opsRoute } = await import('@spfn/core/ops');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const EMAIL = 'admin@reach524.test';
const PASSWORD = 'Password123!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const LIFETIME_MS = 5 * 60_000;
const FULL_KEY_LIFETIME_MS = KEY_TTL_DAYS * 24 * 60 * 60 * 1000;

/** Header the test middleware reads instead of running proxy-guard for real. */
const CLIENT_TYPE_HEADER = 'x-test-client-type';

/** A key the test holds: what it signs requests with. */
interface Session
{
    authorization: string;
    keyId: string;
    privateKey: string;
}

/** What the application's own handlers ran for. */
const handled: string[] = [];

function appRouter()
{
    return defineRouter({
        whoami: route.get('/app/whoami')
            .handler(async () =>
            {
                handled.push('whoami');

                return { ok: true };
            }),
        console: route.get('/app/console')
            .use([opsOrUser({ opsScopes: ['console:read'], roles: ['admin'] })])
            .handler(async () =>
            {
                handled.push('console');

                return { ok: true };
            }),
    });
}

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

describe.skipIf(!dbAvailable)('a key held to a reach (#524)', () =>
{
    let app: Hono;
    let userId: number;
    let testIndex = 0;
    let clientIp: string;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = `active:${Buffer.alloc(32, 7).toString('base64')}`;

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
        app.get('/app/optional', optionalAuth.handler, async (c) =>
        {
            handled.push('optional');

            return c.json({ signedIn: Boolean(c.get('auth')) });
        });

        const serverMiddlewares = [{ name: authenticate.name, handler: authenticate.handler }];

        registerRoutes(app, appRouter(), serverMiddlewares);
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

        testIndex += 1;
        clientIp = `10.52.${testIndex >> 8}.${testIndex & 0xff}`;

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
        vi.restoreAllMocks();
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    function send(method: string, path: string, session?: Session, body?: unknown, proxied = false)
    {
        const headers: Record<string, string> = { ...JSON_HEADERS, 'x-forwarded-for': clientIp, 'user-agent': CHROME };

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

    function sessionFor(keyPair: ReturnType<typeof generateKeyPair>): Session
    {
        const token = generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' });

        return { authorization: `Bearer ${token}`, keyId: keyPair.keyId, privateKey: keyPair.privateKey };
    }

    /** The account's whole-account key, signed in by password. */
    async function signIn(proxied = false, keyPair = generateKeyPair('ES256')): Promise<Session>
    {
        const response = await send('POST', '/_auth/login', undefined, {
            email: EMAIL,
            password: PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        }, proxied);

        expect(response.status).toBe(200);

        return sessionFor(keyPair);
    }

    /** A key held to `opsTokens`, registered the way a link's collection registers it. */
    async function narrowedKey(options: { lifetimeMs?: number; webProxy?: boolean } = {}): Promise<{ session: Session; keyPair: ReturnType<typeof generateKeyPair> }>
    {
        const keyPair = generateKeyPair('ES256');

        await registerPublicKeyService({
            userId,
            keyId: keyPair.keyId,
            publicKey: keyPair.publicKey,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            deviceName: 'spfn CLI',
            channel: 'device-link',
            webProxy: options.webProxy,
            userAgent: CHROME,
            narrowing: { reach: 'opsTokens', lifetimeMs: options.lifetimeMs ?? LIFETIME_MS },
        });

        return { session: sessionFor(keyPair), keyPair };
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId)).limit(1);

        return row!;
    }

    async function errorOf(response: Response): Promise<{ status: number; code?: string; wireCode?: string; details?: unknown }>
    {
        const text = await response.text();
        const body = (text ? JSON.parse(text) : {}) as { error?: { code?: string }; __type?: string; code?: string; details?: unknown };

        return { status: response.status, code: body.error?.code ?? body.__type, wireCode: body.code, details: body.details };
    }

    async function issueOpsToken(session: Session)
    {
        return await send('POST', '/_auth/ops-tokens', session, { name: 'terminal', scopes: ['*'] });
    }

    /** Enrol TOTP on a whole-account session; answers the secret. */
    async function enrolTotp(session: Session): Promise<string>
    {
        pinClockInsideTotpStep();

        const enroll = await send('POST', '/_auth/mfa/totp/enroll', session, {});
        expect(enroll.status).toBe(200);

        const secret = (await enroll.json()).secret as string;
        const confirm = await send('POST', '/_auth/mfa/totp/confirm', session, {
            code: hotp(decodeBase32(secret), totpStep(Date.now())),
        });
        expect(confirm.status).toBe(200);

        vi.useRealTimers();

        return secret;
    }

    /** What `record-key-use` does after a request is fire-and-forget; give it time to land. */
    function settle(): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, 150));
    }

    // ========================================================================
    // In reach
    // ========================================================================

    it('B-M: list, revoke and logout on the narrowed key answer 200, 200, 204; any later call 401', async () =>
    {
        const owner = await signIn();
        const issued = await issueOpsToken(owner);
        expect(issued.status).toBe(200);
        const tokenId = (await issued.json()).opsToken.id as number;

        const { session } = await narrowedKey();

        expect((await send('GET', '/_auth/ops-tokens', session)).status).toBe(200);
        expect((await send('DELETE', `/_auth/ops-tokens/${tokenId}`, session)).status).toBe(200);
        expect((await send('POST', '/_auth/logout', session, {})).status).toBe(204);
        expect((await send('GET', '/_auth/ops-tokens', session)).status).toBe(401);
    });

    it('B-I: the narrowed key issues an ops token — 200, a token row the owner issued, and its secret admitted at an opsTokenAuth route', async () =>
    {
        const { session } = await narrowedKey();

        const issued = await issueOpsToken(session);
        expect(issued.status).toBe(200);
        const { token, opsToken } = await issued.json() as { token: string; opsToken: { id: number } };

        const [row] = await getTestDb().select().from(opsTokens).where(eq(opsTokens.id, opsToken.id));
        expect(row).toMatchObject({ name: 'terminal', issuedBy: userId, revokedAt: null });

        const admitted = await app.request('/_ops/whoami', { headers: { Authorization: `Bearer ${token}` } });
        expect(admitted.status).toBe(200);
        expect(handled).toEqual(['ops']);
    });

    it('B-K: the owner\'s key list shows the narrowed key\'s reach and stated expiry, and its device notice carries the reach', async () =>
    {
        const owner = await signIn();
        const notices: Array<{ keyId: string; reach?: string }> = [];
        const unsubscribe = authDeviceRegisteredEvent.subscribe(payload => void notices.push(payload));

        try
        {
            const before = Date.now();
            const { session } = await narrowedKey();
            const after = Date.now();

            const listed = await send('POST', '/_auth/keys/list', owner, {});
            expect(listed.status).toBe(200);

            const entry = ((await listed.json()).keys as Array<{ keyId: string; reach?: string; expiresAtMillis?: number }>)
                .find(key => key.keyId === session.keyId)!;

            expect(entry.reach).toBe('opsTokens');
            expect(entry.expiresAtMillis).toBeGreaterThanOrEqual(before + LIFETIME_MS);
            expect(entry.expiresAtMillis).toBeLessThanOrEqual(after + LIFETIME_MS);
            expect(notices.find(notice => notice.keyId === session.keyId)?.reach).toBe('opsTokens');
        }
        finally
        {
            unsubscribe();
        }
    });

    // ========================================================================
    // Out of reach
    // ========================================================================

    it('B-R1: device/link/issue answers 403 KEY_OUT_OF_REACH and writes no link', async () =>
    {
        const { session } = await narrowedKey();

        const refused = await errorOf(await send('POST', '/_auth/device/link/issue', session, {}));

        expect(refused).toMatchObject({ status: 403, code: 'KeyOutOfReachError', wireCode: 'KEY_OUT_OF_REACH', details: { reach: 'opsTokens' } });
        expect(await getTestDb().select().from(deviceLinks)).toHaveLength(0);
    });

    it('B-R2: keys/rotate answers 403; no new key row, and the expiry has not moved', async () =>
    {
        const { session } = await narrowedKey();
        const expiresAt = (await keyRow(session.keyId)).expiresAt;
        const next = generateKeyPair('ES256');

        const refused = await errorOf(await send('POST', '/_auth/keys/rotate', session, {
            publicKey: next.publicKey,
            keyId: next.keyId,
            fingerprint: next.fingerprint,
            algorithm: next.algorithm,
        }));

        expect(refused).toMatchObject({ status: 403, code: 'KeyOutOfReachError' });
        expect(await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, next.keyId))).toHaveLength(0);
        expect((await keyRow(session.keyId))).toMatchObject({ isActive: true, expiresAt });
    });

    it('B-R3: an application route behind the global authenticate answers 403 and its handler never runs', async () =>
    {
        const { session } = await narrowedKey();

        const refused = await errorOf(await send('GET', '/app/whoami', session));

        expect(refused).toMatchObject({ status: 403, code: 'KeyOutOfReachError' });
        expect(handled).toEqual([]);
    });

    it('B-R4: optionalAuth reads the narrowed key as anonymous, and opsOrUser\'s session branch refuses it', async () =>
    {
        const { session } = await narrowedKey();

        const optional = await send('GET', '/app/optional', session);
        expect(optional.status).toBe(200);
        expect(await optional.json()).toEqual({ signedIn: false });

        const consoleRefusal = await errorOf(await send('GET', '/app/console', session));
        expect(consoleRefusal).toMatchObject({ status: 403, code: 'KeyOutOfReachError' });
        expect(handled).toEqual(['optional']);
    });

    it('B-R5: once the account must change its password, issuance answers 403 PASSWORD_CHANGE_REQUIRED and the change itself 403 KEY_OUT_OF_REACH; logout still 204', async () =>
    {
        const { session } = await narrowedKey();
        await getTestDb().update(users).set({ passwordChangeRequired: true }).where(eq(users.id, userId));
        const passwordHash = (await getTestDb().select().from(users).where(eq(users.id, userId)))[0]!.passwordHash;

        const refused = await errorOf(await issueOpsToken(session));
        expect(refused).toMatchObject({ status: 403, code: 'PasswordChangeRequiredError' });
        expect(await getTestDb().select().from(opsTokens)).toHaveLength(0);

        // Admitted under the requirement, outside the reach.
        const change = await errorOf(await send('PUT', '/_auth/password', session, { currentPassword: PASSWORD, newPassword: 'Changed456!' }));
        expect(change).toMatchObject({ status: 403, code: 'KeyOutOfReachError' });
        expect((await getTestDb().select().from(users).where(eq(users.id, userId)))[0]!.passwordHash).toBe(passwordHash);

        expect((await send('POST', '/_auth/logout', session, {})).status).toBe(204);
    });

    it('B-R6: a password login with a replacementProof the narrowed key signed is a new device — 202, nothing replaced or moved', async () =>
    {
        await enrolTotp(await signIn());
        const { session } = await narrowedKey();
        // The step-up record a link's collection will copy onto the key (a later pull request).
        await getTestDb().insert(mfaVerifications).values({ userId, keyId: session.keyId, method: 'totp' });

        const next = generateKeyPair('ES256');
        const response = await send('POST', '/_auth/login', undefined, {
            email: EMAIL,
            password: PASSWORD,
            publicKey: next.publicKey,
            keyId: next.keyId,
            fingerprint: next.fingerprint,
            algorithm: next.algorithm,
            replacementProof: signKeyReplacementProof({ oldKeyId: session.keyId, newKeyId: next.keyId }, session.privateKey, 'ES256'),
        });

        expect(response.status).toBe(202);
        expect(await keyRow(session.keyId)).toMatchObject({ isActive: true, revokedAt: null, replacedByKeyId: null });

        const verifications = await getTestDb().select().from(mfaVerifications).where(eq(mfaVerifications.userId, userId));
        expect(verifications.filter(row => row.keyId === session.keyId)).toHaveLength(1);
        expect(verifications.filter(row => row.keyId === next.keyId)).toHaveLength(0);
    });

    it('B-R7: once the account must change its password, device/link/issue answers the requirement, not the reach', async () =>
    {
        const { session } = await narrowedKey();
        await getTestDb().update(users).set({ passwordChangeRequired: true }).where(eq(users.id, userId));

        const refused = await errorOf(await send('POST', '/_auth/device/link/issue', session, {}));

        expect(refused).toMatchObject({ status: 403, code: 'PasswordChangeRequiredError' });
        expect(await getTestDb().select().from(deviceLinks)).toHaveLength(0);
    });

    // ========================================================================
    // Never replacing, never outliving a full key
    // ========================================================================

    /** A narrowed registration of `keyPair`, as `narrowedKey` makes one, with the rest of its params. */
    function registerNarrowed(keyPair: ReturnType<typeof generateKeyPair>, params: Partial<Parameters<typeof registerPublicKeyService>[0]>)
    {
        return registerPublicKeyService({
            userId,
            keyId: keyPair.keyId,
            publicKey: keyPair.publicKey,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            deviceName: 'spfn CLI',
            channel: 'device-link',
            userAgent: CHROME,
            narrowing: { reach: 'opsTokens', lifetimeMs: LIFETIME_MS },
            ...params,
        });
    }

    /** The keyIds `auth.device.registered` announces while `run` runs. */
    async function noticesDuring(run: () => Promise<unknown>): Promise<string[]>
    {
        const notices: string[] = [];
        const unsubscribe = authDeviceRegisteredEvent.subscribe(payload => void notices.push(payload.keyId));

        try
        {
            await run();
        }
        finally
        {
            unsubscribe();
        }

        return notices;
    }

    // The account is not enrolled. On an enrolled one this registration is not
    // challenged either: `device-link` is not a step-up channel (the issuing
    // device's approval is the second proof), and the new device it arrives as
    // is written live and announced, as every link's collection is.
    it('B-N1: a narrowed registration with a full key\'s replacementProof is a new device — announced, the full key and its verification untouched', async () =>
    {
        const owner = await signIn();
        await getTestDb().insert(mfaVerifications).values({ userId, keyId: owner.keyId, method: 'totp' });
        const next = generateKeyPair('ES256');

        const notices = await noticesDuring(() => registerNarrowed(next, {
            replaces: { proof: signKeyReplacementProof({ oldKeyId: owner.keyId, newKeyId: next.keyId }, owner.privateKey, 'ES256') },
        }));

        expect(await keyRow(owner.keyId)).toMatchObject({ isActive: true, revokedAt: null, replacedByKeyId: null });
        expect(notices).toContain(next.keyId);

        const verifications = await getTestDb().select().from(mfaVerifications).where(eq(mfaVerifications.userId, userId));
        expect(verifications.filter(row => row.keyId === owner.keyId)).toHaveLength(1);
        expect(verifications.filter(row => row.keyId === next.keyId)).toHaveLength(0);
    });

    it('B-N2: a narrowed registration claiming to replace the key that signed its request answers the claim\'s refusal and writes nothing', async () =>
    {
        const owner = await signIn();
        const next = generateKeyPair('ES256');
        const refusal = new Error('the signing key cannot be replaced');

        await expect(registerNarrowed(next, {
            channel: 'rotation',
            replaces: { signedBy: owner.keyId, reason: 'Rotated', refusal },
        })).rejects.toBe(refusal);

        expect(await keyRow(owner.keyId)).toMatchObject({ isActive: true, replacedByKeyId: null });
        expect(await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, next.keyId))).toHaveLength(0);
    });

    it.each([
        ['0', 0],
        ['negative', -LIFETIME_MS],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['2e14 (the year 8364)', 2e14],
        ['91 days', FULL_KEY_LIFETIME_MS + 24 * 60 * 60 * 1000],
    ])('B-L: a lifetimeMs of %s is a ValidationError, with no key row and no notice', async (_label, lifetimeMs) =>
    {
        const next = generateKeyPair('ES256');
        let failure: unknown;

        const notices = await noticesDuring(() => registerNarrowed(next, { narrowing: { reach: 'opsTokens', lifetimeMs } })
            .catch(error => void (failure = error)));

        expect(failure).toBeInstanceOf(ValidationError);
        expect(notices).toEqual([]);
        expect(await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, next.keyId))).toHaveLength(0);
    });

    it('B-L90: a lifetimeMs of exactly a full key\'s 90 days is accepted, and expires_at is that far from the registration', async () =>
    {
        const next = generateKeyPair('ES256');
        const before = Date.now();

        await registerNarrowed(next, { narrowing: { reach: 'opsTokens', lifetimeMs: FULL_KEY_LIFETIME_MS } });

        const after = Date.now();
        const expiresAt = (await keyRow(next.keyId)).expiresAt!.getTime();

        expect(expiresAt).toBeGreaterThanOrEqual(before + FULL_KEY_LIFETIME_MS);
        expect(expiresAt).toBeLessThanOrEqual(after + FULL_KEY_LIFETIME_MS);
    });

    it('B-LF: a lifetimeMs out of bounds under a key id that exists is a ValidationError, not a 409, and signIn.admit is never asked', async () =>
    {
        const owner = await signIn();
        const admit = vi.fn(async () => undefined);
        configureSignIn({ admit });
        let failure: unknown;

        try
        {
            await registerNarrowed(generateKeyPair('ES256'), {
                keyId: owner.keyId,
                narrowing: { reach: 'opsTokens', lifetimeMs: 0 },
            }).catch(error => void (failure = error));
        }
        finally
        {
            resetSignInGuardForTests();
        }

        expect(failure).toBeInstanceOf(ValidationError);
        expect(admit).not.toHaveBeenCalled();
    });

    it('B-X: a narrowed registration naming a live full key\'s own id and public key answers 409, the key row and its verification as they were', async () =>
    {
        const keyPair = generateKeyPair('ES256');
        const owner = await signIn(false, keyPair);
        await getTestDb().insert(mfaVerifications).values({ userId, keyId: owner.keyId, method: 'totp' });
        const before = await keyRow(owner.keyId);

        await expect(registerNarrowed(keyPair, {})).rejects.toBeInstanceOf(KeyIdAlreadyRegisteredError);

        expect(await keyRow(owner.keyId)).toEqual(before);
        expect(await getTestDb().select().from(mfaVerifications).where(eq(mfaVerifications.keyId, owner.keyId))).toHaveLength(1);
    });

    // ========================================================================
    // Never bound, never extended
    // ========================================================================

    it('B-B1: registered through the proxy on a bound account, and used through it, the narrowed key stays unbound at its stated expiry', async () =>
    {
        await getTestDb().update(users).set({ sessionBinding: 'passkey' }).where(eq(users.id, userId));

        const { session } = await narrowedKey({ webProxy: true });
        const registered = await keyRow(session.keyId);

        expect(registered.binding).toBe('none');
        expect(registered.expiresAt!.getTime() - registered.createdAt.getTime()).toBeLessThanOrEqual(LIFETIME_MS + 1_000);

        expect((await send('GET', '/_auth/ops-tokens', session, undefined, true)).status).toBe(200);
        await settle();

        expect(await keyRow(session.keyId)).toMatchObject({ binding: 'none', expiresAt: registered.expiresAt });
    });

    it('B-B2: turning binding on leaves a narrowed web key unbound at its stated expiry', async () =>
    {
        const owner = await signIn(true);
        const authenticator = await FixtureAuthenticator.create();
        const options = await send('POST', '/_auth/passkeys/register/options', owner, {}, true);
        const { challenge } = await options.json();
        const registered = await send('POST', '/_auth/passkeys/register/verify', owner, {
            response: authenticator.attest({ challenge, origin: ORIGIN, rpId: RP_ID }),
        }, true);
        expect(registered.status).toBe(200);

        const { session } = await narrowedKey({ webProxy: true });
        const before = await keyRow(session.keyId);

        const enabled = await enableBinding((path, body) => send('POST', path, owner, body, true), authenticator, { origin: ORIGIN, rpId: RP_ID, userVerified: true });
        expect(enabled.status).toBe(200);

        expect((await keyRow(owner.keyId)).binding).toBe('passkey');
        expect(await keyRow(session.keyId)).toMatchObject({ binding: 'none', expiresAt: before.expiresAt });
    });

    it('B-RR: a password login presenting the expired narrowed key again answers 409 and leaves its expiry where it was', async () =>
    {
        const { keyPair } = await narrowedKey({ lifetimeMs: 1 });
        const expiresAt = (await keyRow(keyPair.keyId)).expiresAt;

        const response = await send('POST', '/_auth/login', undefined, {
            email: EMAIL,
            password: PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        });

        expect(await errorOf(response)).toMatchObject({ status: 409, code: 'KeyIdAlreadyRegisteredError' });
        expect((await keyRow(keyPair.keyId)).expiresAt).toEqual(expiresAt);
    });

    // ========================================================================
    // Below the router
    // ========================================================================

    // The one row that enters below the router: every door that passes
    // `route: null` (a one-time token, a grant's, the device flows' approver)
    // sits behind a route that already refused the narrowed key, so nothing
    // driven through the router can tell this step admitting it apart.
    it('B-D: admitPrincipal with the narrowed key\'s credential and route: null answers keyOutOfReach', async () =>
    {
        const { session } = await narrowedKey();

        const admission = await admitPrincipal({
            userId,
            credential: { kind: 'deviceKey', keyId: session.keyId },
            route: null,
            presentedOn: null,
        });

        expect(admission).toEqual({ refused: { reason: 'keyOutOfReach', reach: 'opsTokens' } });
    });
});
