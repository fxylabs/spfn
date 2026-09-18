/**
 * @spfn/auth - renewing a bound session key (design #97 v2, case table 6d)
 *
 * One `it` per row, against the mounted router with a real software
 * authenticator, so the happy paths run the library's actual CBOR, COSE and
 * ECDSA verification rather than a stub that would agree with whatever we wrote.
 *
 * Neither route is public, and that is the point of the table. The key a renewal
 * acts on is the `keyId` of the bearer JWT the request is signed with, so every
 * request below carries an `Authorization` header built from a private key — the
 * expiring session's own, a stranger's, or one nobody registered — and no request
 * names a key id in its body at all.
 *
 * The one thing every refusal row asserts is that it is the *same* refusal. A
 * signature that did not verify, an unbound key, a revoked key, a key nobody
 * registered and a key past its grace have to be indistinguishable, or the route
 * answers "does this key id exist" to whoever asked — and the cookie-copying
 * adversary holds exactly one key id and would want it confirmed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { passkeys, userPublicKeys, users, webauthnChallenges } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { authenticate } from '@/server/middleware/authenticate';
import { authDeviceRegisteredEvent, authLoginEvent } from '@/server/events';
import { BOUND_KEY_RENEW_GRACE_HOURS, BOUND_KEY_TTL_HOURS } from '@/server/lib/key-policy';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CLIENT_TYPE_HEADER = 'x-test-client-type';

const HOUR_MS = 60 * 60 * 1000;

interface Session
{
    authorization: string;
    keyId: string;
    privateKey: string;
}

interface Bound extends Session
{
    authenticator: FixtureAuthenticator;
    email: string;
}

describe.skipIf(!dbAvailable)('renewing a bound session key (case table 6d)', () =>
{
    let app: Hono;
    let counter = 1;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;

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
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        resetMemoryRateLimitStore();
        vi.restoreAllMocks();
        counter = 1;

        const userRole = await getRoleByName('user');

        for (const email of ['owner@test.com', 'other@test.com'])
        {
            await db.insert(users).values({
                email,
                passwordHash: await hashPassword(PASSWORD),
                roleId: userRole!.id,
                emailVerifiedAt: new Date(),
            });
        }
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    /** A request through the trusted proxy, with or without a credential. */
    function post(path: string, body: unknown, authorization?: string, ip = '203.0.113.7')
    {
        return app.request(path, {
            method: 'POST',
            headers: {
                ...JSON_HEADERS,
                'user-agent': CHROME,
                'x-forwarded-for': ip,
                [CLIENT_TYPE_HEADER]: 'web',
                ...(authorization ? { Authorization: authorization } : {}),
            },
            body: JSON.stringify(body),
        });
    }

    /**
     * The `Authorization` the proxy builds: a JWT naming `keyId`, signed with
     * `privateKey`.
     *
     * The two are separate arguments because the rows need them apart — naming
     * someone else's key id is exactly what a caller can do, and signing it is
     * exactly what they cannot.
     */
    function bearer(keyId: string, privateKey: string): string
    {
        return `Bearer ${generateClientToken({ keyId }, privateKey, 'ES256', { expiresIn: '5m' })}`;
    }

    async function signIn(email: string): Promise<Session>
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

        return {
            authorization: bearer(keyPair.keyId, keyPair.privateKey),
            keyId: keyPair.keyId,
            privateKey: keyPair.privateKey,
        };
    }

    /** A signed-in account with a passkey and session binding on. */
    async function bound(email = 'owner@test.com'): Promise<Bound>
    {
        const session = await signIn(email);
        const authenticator = await FixtureAuthenticator.create();
        const options = await post('/_auth/passkeys/register/options', {}, session.authorization);
        const verify = await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({ challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID }),
        }, session.authorization);

        expect(verify.status).toBe(200);
        expect((await post('/_auth/session/binding', { mode: 'passkey' }, session.authorization)).status).toBe(200);

        return { ...session, authenticator, email };
    }

    const renewOptions = (authorization?: string, ip?: string) =>
        post('/_auth/session/renew/options', {}, authorization, ip);

    /** The new key pair the Next.js interceptor would have generated. */
    function freshPair()
    {
        const keyPair = generateKeyPair('ES256');

        return {
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
            privateKey: keyPair.privateKey,
        };
    }

    /** A full renewal: options, assertion, verify — both signed by the expiring key. */
    async function renew(
        subject: Bound,
        options: { authenticator?: FixtureAuthenticator; newKeyId?: string } = {},
    )
    {
        const authorization = bearer(subject.keyId, subject.privateKey);
        const started = await renewOptions(authorization);

        if (started.status !== 200)
        {
            return { started, options: null, verified: null, pair: null };
        }

        const issued = await started.json();
        const pair = freshPair();
        const verified = await post('/_auth/session/renew/verify', {
            response: (options.authenticator ?? subject.authenticator).assert({
                challenge: issued.challenge,
                origin: ORIGIN,
                rpId: RP_ID,
                counter: ++counter,
            }),
            publicKey: pair.publicKey,
            keyId: options.newKeyId ?? pair.keyId,
            fingerprint: pair.fingerprint,
            algorithm: pair.algorithm,
        }, authorization);

        return { started, options: issued, verified, pair };
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId)).limit(1);

        return row;
    }

    async function userRow(email: string)
    {
        const [row] = await getTestDb().select().from(users).where(eq(users.email, email)).limit(1);

        return row;
    }

    /** Move a key's expiry, which is how every "expired" row is reached. */
    async function expireKey(keyId: string, agoMs: number): Promise<void>
    {
        await getTestDb()
            .update(userPublicKeys)
            .set({ expiresAt: new Date(Date.now() - agoMs) })
            .where(eq(userPublicKeys.keyId, keyId));
    }

    /** What both routes answer to everything they refuse. */
    async function expectOneRefusal(response: Response): Promise<void>
    {
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
            __type: 'SessionRenewalRefusedError',
            message: 'This session cannot be renewed. Sign in again.',
        });
    }

    // ========================================================================
    // Rows
    // ========================================================================

    it('bound, expired, inside the grace: options 200 with allowCredentials [], verify 200 with the binding fields, a fresh 24h key, the old one revoked, provenance inherited', async () =>
    {
        const subject = await bound();
        const before = await keyRow(subject.keyId);
        await expireKey(subject.keyId, 1_000);

        const { started, options, verified, pair } = await renew(subject);

        expect(started.status).toBe(200);
        expect(options.allowCredentials).toEqual([]);

        expect(verified!.status).toBe(200);
        const body = await verified!.json();
        expect(body.sessionBinding).toBe('passkey');
        // The one field a renewal answers that a sign-in does not: the app has no
        // other way to learn the new key's id, since the pair is minted in the
        // proxy and the private half never leaves the cookie.
        expect(body.keyId).toBe(pair!.keyId);

        const fresh = await keyRow(pair!.keyId);
        expect(fresh.binding).toBe('passkey');
        expect(body.keyExpiresAtMillis).toBe(fresh.expiresAt!.getTime());
        expect(Math.abs(fresh.expiresAt!.getTime() - (Date.now() + BOUND_KEY_TTL_HOURS * HOUR_MS))).toBeLessThan(60_000);
        expect(fresh.registeredIp).toBe(before.registeredIp);
        expect(fresh.registeredUserAgent).toBe(before.registeredUserAgent);
        expect(fresh.registeredUaFamily).toBe(before.registeredUaFamily);

        expect((await keyRow(subject.keyId)).isActive).toBe(false);
    });

    it('bound, not yet expired (an early renewal): options 200 and verify 200', async () =>
    {
        const subject = await bound();

        const { started, verified } = await renew(subject);

        expect(started.status).toBe(200);
        expect(verified!.status).toBe(200);
    });

    it('past the grace: options 401 and verify 401', async () =>
    {
        const subject = await bound();
        await expireKey(subject.keyId, (BOUND_KEY_RENEW_GRACE_HOURS + 1) * HOUR_MS);
        const authorization = bearer(subject.keyId, subject.privateKey);

        await expectOneRefusal(await renewOptions(authorization));
        await expectOneRefusal(await post('/_auth/session/renew/verify', {
            response: {},
            ...freshPair(),
        }, authorization));
    });

    it('no credential, a forged signature, an unbound key, a revoked key, a key nobody registered and one past its grace: the same 401 body for all six', async () =>
    {
        const stranger = await bound('other@test.com');
        const unbound = await signIn('owner@test.com');
        const revoked = await bound();
        const expired = await bound();
        const nobody = generateKeyPair('ES256');

        await getTestDb().update(userPublicKeys)
            .set({ isActive: false })
            .where(eq(userPublicKeys.keyId, revoked.keyId));
        await expireKey(expired.keyId, (BOUND_KEY_RENEW_GRACE_HOURS + 1) * HOUR_MS);

        const credentials = [
            undefined,
            // The stranger's key id — which a caller may well hold — signed with
            // a key that is not it. This is the whole of what a third party can do.
            bearer(stranger.keyId, unbound.privateKey),
            bearer(unbound.keyId, unbound.privateKey),
            bearer(revoked.keyId, revoked.privateKey),
            bearer(nobody.keyId, nobody.privateKey),
            bearer(expired.keyId, expired.privateKey),
        ];

        const bodies: unknown[] = [];

        for (const authorization of credentials)
        {
            const response = await renewOptions(authorization);
            expect(response.status).toBe(401);
            // Minus two fields that are not the wire answer. The request id is
            // per-response by construction and is what a person reads out to
            // support; the stack is attached only when `includeStack` is on, which
            // `ErrorHandler` defaults to NODE_ENV !== 'production' — so it is in
            // this test's responses and in no deployment's.
            const body = await response.json() as { error: { requestId?: string }; stack?: string };
            delete body.error.requestId;
            delete body.stack;
            bodies.push(body);
        }

        expect(new Set(bodies.map(body => JSON.stringify(body))).size).toBe(1);
        expect(bodies[0]).toMatchObject({ __type: 'SessionRenewalRefusedError' });
    });

    it('the account is not active: 401', async () =>
    {
        const subject = await bound();
        await expireKey(subject.keyId, 1_000);
        await getTestDb().update(users).set({ status: 'suspended' }).where(eq(users.email, subject.email));

        await expectOneRefusal(await renewOptions(bearer(subject.keyId, subject.privateKey)));
    });

    it('no assertion at all, and an assertion the passkey did not sign: 401, and nothing moves', async () =>
    {
        const subject = await bound();
        await expireKey(subject.keyId, 1_000);
        const authorization = bearer(subject.keyId, subject.privateKey);
        const started = await renewOptions(authorization);
        const { challenge } = await started.json();
        const impostor = await FixtureAuthenticator.create();

        await expectOneRefusal(await post('/_auth/session/renew/verify', {
            response: {},
            ...freshPair(),
        }, authorization));

        await expectOneRefusal(await post('/_auth/session/renew/verify', {
            response: impostor.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: 2 }),
            ...freshPair(),
        }, authorization));

        expect((await keyRow(subject.keyId)).isActive).toBe(true);
    });

    it('another account\'s passkey: 401', async () =>
    {
        const subject = await bound();
        const stranger = await bound('other@test.com');
        await expireKey(subject.keyId, 1_000);

        const { verified } = await renew(subject, { authenticator: stranger.authenticator });

        await expectOneRefusal(verified!);
        expect((await keyRow(subject.keyId)).isActive).toBe(true);
    });

    it('a challenge presented twice, and one older than its TTL: 401 both times', async () =>
    {
        const subject = await bound();
        await expireKey(subject.keyId, 1_000);

        const { verified } = await renew(subject);
        expect(verified!.status).toBe(200);

        // The same ceremony replayed: the challenge row was spent by the verify
        // above, and the old key is revoked, so its credential no longer admits.
        await expectOneRefusal(await renewOptions(bearer(subject.keyId, subject.privateKey)));

        const stale = await bound('other@test.com');
        await expireKey(stale.keyId, 1_000);
        const staleAuth = bearer(stale.keyId, stale.privateKey);
        const started = await renewOptions(staleAuth);
        const { challenge } = await started.json();
        await getTestDb().update(webauthnChallenges)
            .set({ expiresAt: new Date(Date.now() - 1_000) })
            .where(eq(webauthnChallenges.kind, 'renewal'));

        await expectOneRefusal(await post('/_auth/session/renew/verify', {
            response: stale.authenticator.assert({ challenge, origin: ORIGIN, rpId: RP_ID, counter: 9 }),
            ...freshPair(),
        }, staleAuth));
    });

    it('two verifies at once: one 200 and one 401', async () =>
    {
        const subject = await bound();
        await expireKey(subject.keyId, 1_000);

        const authorization = bearer(subject.keyId, subject.privateKey);
        const ceremonies = await Promise.all([1, 2].map(async (index) =>
        {
            const started = await renewOptions(authorization);

            return {
                challenge: (await started.json()).challenge as string,
                pair: freshPair(),
                counter: 20 + index,
            };
        }));

        const answers = await Promise.all(ceremonies.map(ceremony => post('/_auth/session/renew/verify', {
            response: subject.authenticator.assert({
                challenge: ceremony.challenge,
                origin: ORIGIN,
                rpId: RP_ID,
                counter: ceremony.counter,
            }),
            publicKey: ceremony.pair.publicKey,
            keyId: ceremony.pair.keyId,
            fingerprint: ceremony.pair.fingerprint,
            algorithm: ceremony.pair.algorithm,
        }, authorization)));

        expect(answers.filter(answer => answer.status === 200)).toHaveLength(1);
        expect(answers.filter(answer => answer.status === 401)).toHaveLength(1);
    });

    it('the new keyId is one already registered: 409, and the old key survives', async () =>
    {
        const subject = await bound();
        const taken = await signIn('other@test.com');
        await expireKey(subject.keyId, 1_000);

        const { verified } = await renew(subject, { newKeyId: taken.keyId });

        expect(verified!.status).toBe(409);
        expect((await verified!.json()).__type).toBe('KeyIdAlreadyRegisteredError');
        expect((await keyRow(subject.keyId)).isActive).toBe(true);
    });

    it('the passkey was revoked before the renewal: options still 200 (the list is empty for everyone), verify 401', async () =>
    {
        const subject = await bound();
        await expireKey(subject.keyId, 1_000);
        await getTestDb().update(passkeys)
            .set({ revokedAt: new Date() })
            .where(eq(passkeys.userId, (await userRow(subject.email)).id));

        const started = await renewOptions(bearer(subject.keyId, subject.privateKey));
        expect(started.status).toBe(200);
        expect((await started.json()).allowCredentials).toEqual([]);

        const { verified } = await renew(subject);
        await expectOneRefusal(verified!);
    });

    it('a renewal that succeeded: no device-registered event, no login event, and lastLoginAt does not move', async () =>
    {
        const subject = await bound();
        await expireKey(subject.keyId, 1_000);
        const before = (await userRow(subject.email)).lastLoginAt;

        const deviceEvents = vi.fn();
        const loginEvents = vi.fn();
        authDeviceRegisteredEvent.subscribe(deviceEvents);
        authLoginEvent.subscribe(loginEvents);

        const { verified } = await renew(subject);

        expect(verified!.status).toBe(200);
        expect(deviceEvents).not.toHaveBeenCalled();
        expect(loginEvents).not.toHaveBeenCalled();
        expect((await userRow(subject.email)).lastLoginAt?.getTime()).toBe(before?.getTime());
    });

    it('a cookie copied before the key expired: options 200, because the copy signs — and verify 401, because it cannot assert', async () =>
    {
        // The whole threat model in one row. A copied session cookie carries the
        // private key, so the thief's request is signed exactly as the owner's is
        // and the options step cannot tell them apart. The ceremony is where they
        // part: the passkey is on the owner's machine.
        const owner = await bound();
        await expireKey(owner.keyId, 1_000);
        const stolen = bearer(owner.keyId, owner.privateKey);

        const started = await renewOptions(stolen);
        expect(started.status).toBe(200);

        const impostor = await FixtureAuthenticator.create();
        await expectOneRefusal(await post('/_auth/session/renew/verify', {
            response: impostor.assert({
                challenge: (await started.json()).challenge,
                origin: ORIGIN,
                rpId: RP_ID,
                counter: 30,
            }),
            ...freshPair(),
        }, stolen));

        expect((await keyRow(owner.keyId)).isActive).toBe(true);
    });

    it('verify with no algorithm: the service default is used and the renewal completes', async () =>
    {
        // `algorithm` is optional on the service and in the design's verify body,
        // and a direct caller that omits it must reach the default rather than a
        // schema refusal.
        const subject = await bound();
        await expireKey(subject.keyId, 1_000);
        const authorization = bearer(subject.keyId, subject.privateKey);
        const started = await renewOptions(authorization);
        const pair = freshPair();

        const verified = await post('/_auth/session/renew/verify', {
            response: subject.authenticator.assert({
                challenge: (await started.json()).challenge,
                origin: ORIGIN,
                rpId: RP_ID,
                counter: 40,
            }),
            publicKey: pair.publicKey,
            keyId: pair.keyId,
            fingerprint: pair.fingerprint,
        }, authorization);

        expect(verified.status).toBe(200);
        expect((await verified.json()).keyId).toBe(pair.keyId);
        expect((await keyRow(pair.keyId)).algorithm).toBe('ES256');
    });

    it('the eleventh options call in a minute from one address: 429', async () =>
    {
        const subject = await bound();
        const answers: number[] = [];

        for (let attempt = 0; attempt < 11; attempt += 1)
        {
            answers.push((await renewOptions(bearer(subject.keyId, subject.privateKey), '198.51.100.40')).status);
        }

        expect(answers.slice(0, 10).every(status => status === 200)).toBe(true);
        expect(answers[10]).toBe(429);
    });

    it('a renewal spends its challenge row, so the ceremony cannot be replayed', async () =>
    {
        const subject = await bound();
        await expireKey(subject.keyId, 1_000);

        const { verified } = await renew(subject);
        expect(verified!.status).toBe(200);

        const [row] = await getTestDb()
            .select()
            .from(webauthnChallenges)
            .where(and(eq(webauthnChallenges.kind, 'renewal')))
            .limit(1);

        expect(row.consumedAt).not.toBeNull();
    });
});
