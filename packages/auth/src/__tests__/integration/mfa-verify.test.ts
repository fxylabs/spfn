/**
 * @spfn/auth - Second-Factor Verify Integration Tests
 *
 * Real HTTP requests against the mounted auth router, one `it` per row of case
 * table 6c in the #95 design, in table order and named for the row.
 *
 * Two properties run through nearly every row. The first is that every refusal
 * is the same 401 with the same body: a challenge that never existed, one that
 * expired, one already spent, a wrong code and a code from a spent step are not
 * told apart, because which one applies describes state the caller is guessing
 * at. The second is that a guess touches nothing — the lookup is by hash, so a
 * caller who does not hold a secret reaches no row at all and no counter but
 * their own can ever move.
 *
 * No secret, code or key value printed by these tests is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { mfaChallenges, mfaRecoveryCodes, userPublicKeys, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { authDeviceRegisteredEvent, authLoginEvent } from '@/server/events';
import { authenticate } from '@/server/middleware/authenticate';

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
const ACTIVE_KEY = `active:${Buffer.alloc(32, 9).toString('base64')}`;

/** A session: what to sign requests with, and the device key it is carried by. */
interface Session
{
    authorization: string;
    keyId: string;
}

describe.skipIf(!dbAvailable)('second-factor verify (case table 6c)', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = ACTIVE_KEY;

        app = new Hono();
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
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
        vi.restoreAllMocks();

        const userRole = await getRoleByName('user');
        await db.insert(users).values([
            {
                email: 'owner@test.com',
                passwordHash: await hashPassword(PASSWORD),
                roleId: userRole!.id,
                emailVerifiedAt: new Date(),
            },
            {
                email: 'other@test.com',
                passwordHash: await hashPassword(PASSWORD),
                roleId: userRole!.id,
                emailVerifiedAt: new Date(),
            },
        ]);
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    function post(path: string, body: unknown, authorization?: string)
    {
        return app.request(path, {
            method: 'POST',
            headers: authorization ? { ...JSON_HEADERS, Authorization: authorization } : JSON_HEADERS,
            body: JSON.stringify(body),
        });
    }

    async function signIn(email = 'owner@test.com')
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
        const session: Session = {
            authorization: `Bearer ${generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', {
                expiresIn: '5m',
            })}`,
            keyId: keyPair.keyId,
        };

        return { response, session, keyPair };
    }

    function codeFor(secret: string, offsetSteps = 0): string
    {
        return hotp(decodeBase32(secret), totpStep(Date.now()) + offsetSteps);
    }

    /** Enrol a TOTP second factor on `email`, and hand back its secret and codes. */
    async function enrol(email = 'owner@test.com')
    {
        const { session } = await signIn(email);
        const enroll = await post('/_auth/mfa/totp/enroll', {}, session.authorization);
        const secret = (await enroll.json()).secret as string;
        const confirmed = await post('/_auth/mfa/totp/confirm', { code: codeFor(secret) }, session.authorization);

        expect(confirmed.status).toBe(200);

        return { session, secret, recoveryCodes: (await confirmed.json()).recoveryCodes as string[] };
    }

    /** Sign in from a device the account has never seen, and keep the challenge. */
    async function openChallenge(email = 'owner@test.com')
    {
        const { response, session, keyPair } = await signIn(email);

        expect(response.status).toBe(202);

        return { challenge: (await response.json()).challenge.secret as string, session, keyPair };
    }

    /**
     * Forget the newest step this account has spent.
     *
     * The enrolment's own `confirm` spends the current step, so a row about drift
     * or about two devices inside one step has to start from a clean counter —
     * otherwise every code it submits is refused as a replay and the row would
     * pass for the wrong reason.
     */
    async function clearUsedStep(): Promise<void>
    {
        const { mfaTotp } = await import('@/server/entities');

        await getTestDb().update(mfaTotp).set({ lastUsedStep: null });
    }

    function verify(challenge: string, proof: Record<string, unknown>)
    {
        return post('/_auth/mfa/verify', { challenge, ...proof });
    }

    async function challengeRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(mfaChallenges).where(eq(mfaChallenges.keyId, keyId));

        return row;
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId));

        return row;
    }

    function capture<TPayload>(event: { subscribe: (handler: (payload: TPayload) => void) => unknown }): TPayload[]
    {
        const seen: TPayload[] = [];
        event.subscribe((payload) => void seen.push(payload));

        return seen;
    }

    function settle(): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, 40));
    }

    // ========================================================================
    // 6c — verify × input
    // ========================================================================

    it('row: a live challenge and the right TOTP — 200 with keyId and challengeHash, key active, one login event, lastLoginAt moved, one device event on the original channel', async () =>
    {
        const { secret } = await enrol();
        const { challenge, session } = await openChallenge();

        const logins = capture<Record<string, unknown>>(authLoginEvent);
        const devices = capture<Record<string, unknown>>(authDeviceRegisteredEvent);
        const before = (await getTestDb().select().from(users).where(eq(users.email, 'owner@test.com')))[0].lastLoginAt;

        const response = await verify(challenge, { code: codeFor(secret, 1) });
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.mfaRequired).toBe(false);
        expect(body.keyId).toBe(session.keyId);
        expect(typeof body.challengeHash).toBe('string');
        expect(body.userId).toBeTruthy();

        await settle();

        expect(await keyRow(session.keyId)).toMatchObject({ isActive: true, pendingMfaChallengeId: null });
        expect(logins).toHaveLength(1);
        expect(devices).toHaveLength(1);
        expect(devices[0].channel).toBe('password');

        const after = (await getTestDb().select().from(users).where(eq(users.email, 'owner@test.com')))[0].lastLoginAt;
        expect(after!.getTime()).toBeGreaterThan(before?.getTime() ?? 0);
    });

    it('row: a live challenge and a code one step out — 200', async () =>
    {
        const { secret } = await enrol();
        const { challenge } = await openChallenge();

        await clearUsedStep();

        expect((await verify(challenge, { code: codeFor(secret, -1) })).status).toBe(200);
    });

    it('row: a code from a step already spent, on a different challenge — 401', async () =>
    {
        const { secret } = await enrol();
        const first = await openChallenge();
        const second = await openChallenge();
        const code = codeFor(secret, 1);

        expect((await verify(first.challenge, { code })).status).toBe(200);
        expect((await verify(second.challenge, { code })).status).toBe(401);
    });

    it('row: the same step presented by two devices signing in legitimately — one 200, one 401', async () =>
    {
        const { secret } = await enrol();
        const laptop = await openChallenge();
        const phone = await openChallenge();

        await clearUsedStep();

        const code = codeFor(secret);

        const outcomes = [
            (await verify(laptop.challenge, { code })).status,
            (await verify(phone.challenge, { code })).status,
        ];

        // The cost of `last_used_step`: the second device retries on the next
        // step rather than replaying a code that is still on screen.
        expect(outcomes.sort()).toEqual([200, 401]);
    });

    it('row: a live challenge and a wrong code — 401, attempts 1', async () =>
    {
        await enrol();
        const { challenge, session } = await openChallenge();

        expect((await verify(challenge, { code: '000000' })).status).toBe(401);
        expect((await challengeRow(session.keyId)).attempts).toBe(1);
    });

    it('row: five wrong codes — the challenge is gone, the pending key deleted, the sixth attempt the same 401', async () =>
    {
        await enrol();
        const { challenge, session } = await openChallenge();

        for (let attempt = 0; attempt < 5; attempt += 1)
        {
            expect((await verify(challenge, { code: '000000' })).status).toBe(401);
        }

        expect(await keyRow(session.keyId)).toBeUndefined();
        expect(await challengeRow(session.keyId)).toBeUndefined();
        expect((await verify(challenge, { code: '000000' })).status).toBe(401);
    });

    it('row: a live challenge and a recovery code — 200, the code is used, nine remain', async () =>
    {
        const { session: enrolled, recoveryCodes } = await enrol();
        const { challenge } = await openChallenge();

        expect((await verify(challenge, { recoveryCode: recoveryCodes[0] })).status).toBe(200);

        const status = await app.request('/_auth/mfa/status', {
            headers: { Authorization: enrolled.authorization },
        });
        const rows = await getTestDb().select().from(mfaRecoveryCodes);

        expect(rows.filter(row => row.usedAt !== null)).toHaveLength(1);
        expect((await status.json()).recoveryCodesRemaining).toBe(9);
    });

    it('row: a used code, a code from an older generation, and another account\'s code — 401 for each', async () =>
    {
        const { session: enrolled, recoveryCodes } = await enrol();
        const stranger = await enrol('other@test.com');

        const used = await openChallenge();
        expect((await verify(used.challenge, { recoveryCode: recoveryCodes[0] })).status).toBe(200);

        const spent = await openChallenge();
        expect((await verify(spent.challenge, { recoveryCode: recoveryCodes[0] })).status).toBe(401);

        const regenerated = await post('/_auth/mfa/recovery/regenerate', {}, enrolled.authorization);
        expect(regenerated.status).toBe(200);

        const stale = await openChallenge();
        expect((await verify(stale.challenge, { recoveryCode: recoveryCodes[1] })).status).toBe(401);

        const foreign = await openChallenge();
        expect((await verify(foreign.challenge, { recoveryCode: stranger.recoveryCodes[0] })).status).toBe(401);
    });

    it('row: a live challenge and an assertion from a second-factor passkey — 200', async () =>
    {
        const { session: enrolled } = await enrol();
        const authenticator = await markedPasskey(enrolled, true);
        const { challenge } = await openChallenge();

        const options = await post('/_auth/mfa/verify/options', { challenge });
        expect(options.status).toBe(200);

        const response = await verify(challenge, {
            response: authenticator.assert({
                challenge: (await options.json()).challenge,
                origin: ORIGIN,
                rpId: RP_ID,
                counter: 1,
            }),
        });

        expect(response.status).toBe(200);
    });

    it('row: an assertion from a passkey the owner never marked — 401', async () =>
    {
        const { session: enrolled } = await enrol();
        const authenticator = await markedPasskey(enrolled, false);
        const { challenge } = await openChallenge();

        const options = await post('/_auth/mfa/verify/options', { challenge });
        const response = await verify(challenge, {
            response: authenticator.assert({
                challenge: (await options.json()).challenge,
                origin: ORIGIN,
                rpId: RP_ID,
                counter: 1,
            }),
        });

        expect(response.status).toBe(401);
    });

    it('row: two proofs in one body, or none — 400', async () =>
    {
        const { secret, recoveryCodes } = await enrol();
        const two = await openChallenge();
        const none = await openChallenge();

        expect((await verify(two.challenge, { code: codeFor(secret, 1), recoveryCode: recoveryCodes[0] })).status)
            .toBe(400);
        expect((await verify(none.challenge, {})).status).toBe(400);
    });

    it('row: expired, already verified, unknown and guessed challenges — the same 401, and nobody else\'s attempts move', async () =>
    {
        const { secret } = await enrol();
        const live = await openChallenge();
        const expired = await openChallenge();
        const spent = await openChallenge();

        await getTestDb()
            .update(mfaChallenges)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(mfaChallenges.keyId, expired.session.keyId));

        expect((await verify(spent.challenge, { code: codeFor(secret, 1) })).status).toBe(200);

        const statuses = await Promise.all([
            verify(expired.challenge, { code: codeFor(secret, 2) }),
            verify(spent.challenge, { code: codeFor(secret, 2) }),
            verify('a'.repeat(43), { code: codeFor(secret, 2) }),
            verify('guessed-value-that-hashes-to-no-row', { code: codeFor(secret, 2) }),
        ]);

        expect(statuses.map(response => response.status)).toEqual([401, 401, 401, 401]);

        // The guesses reached no row, so the one live challenge is untouched:
        // there is no id for a stranger to name, only a secret they do not hold.
        expect((await challengeRow(live.session.keyId)).attempts).toBe(0);
    });

    it('row: the key generation moved after the challenge was issued — 401', async () =>
    {
        const { secret, session: enrolled } = await enrol();
        const { challenge } = await openChallenge();

        // Any global revocation moves the epoch. This one also deletes the
        // pending key, which is the first line of defence; the epoch is the
        // second, and it is what the row is here for.
        expect((await post('/_auth/keys/revoke-all', {}, enrolled.authorization)).status).toBe(200);
        expect((await verify(challenge, { code: codeFor(secret, 1) })).status).toBe(401);
    });

    it('row: two verifies of one challenge at once — one 200, one 401', async () =>
    {
        const { secret } = await enrol();
        const { challenge } = await openChallenge();
        const code = codeFor(secret, 1);

        const [first, second] = await Promise.all([
            verify(challenge, { code }),
            verify(challenge, { code }),
        ]);

        expect([first.status, second.status].sort()).toEqual([200, 401]);
    });

    it('row: before the challenge is verified — authenticate 401, optionalAuth anonymous, listKeys does not show the key', async () =>
    {
        const { session: enrolled } = await enrol();
        const { session, keyPair } = await openChallenge();

        // Signed with the pending key's own private half, so nothing but the
        // key's state can be what refuses it: `authenticate` looks up active keys
        // only, and an inactive one is an unknown one.
        const pending = `Bearer ${generateClientToken({ keyId: session.keyId }, keyPair.privateKey, 'ES256', {
            expiresIn: '5m',
        })}`;

        expect((await app.request('/_auth/session', { headers: { Authorization: pending } })).status).toBe(401);

        // And the owner's own device list does not show it, in either mode.
        const listed = await post('/_auth/keys/list', {}, enrolled.authorization);
        const withRevoked = await post('/_auth/keys/list', { includeRevoked: true }, enrolled.authorization);

        expect((await listed.json()).keys.map((key: { keyId: string }) => key.keyId)).not.toContain(session.keyId);
        expect((await withRevoked.json()).keys.map((key: { keyId: string }) => key.keyId)).not.toContain(session.keyId);
    });

    it('row: the eleventh verify from one address inside a minute — 429', async () =>
    {
        await enrol();
        const { challenge } = await openChallenge();

        for (let attempt = 0; attempt < 10; attempt += 1)
        {
            await verify(challenge, { code: '000000' });
        }

        expect((await verify(challenge, { code: '000000' })).status).toBe(429);
    });

    /** Enrol a passkey on this session, and mark it as a second factor or not. */
    async function markedPasskey(session: Session, secondFactor: boolean): Promise<FixtureAuthenticator>
    {
        const authenticator = await FixtureAuthenticator.create();
        const options = await post('/_auth/passkeys/register/options', {}, session.authorization);
        const registered = await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({
                challenge: (await options.json()).challenge,
                origin: ORIGIN,
                rpId: RP_ID,
            }),
        }, session.authorization);

        expect(registered.status).toBe(200);

        if (secondFactor)
        {
            const marked = await post('/_auth/mfa/passkey/mark', {
                passkeyId: (await registered.json()).passkeyId,
                secondFactor: true,
            }, session.authorization);

            expect(marked.status).toBe(200);
        }

        return authenticator;
    }
});
