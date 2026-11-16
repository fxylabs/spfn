/**
 * @spfn/auth - replacing a key requires proof of the old key (bundle 2)
 *
 * A sign-in used to count as "the same device swapping its key" when it named
 * one of the account's key ids — a name, not a secret. These rows hold the one
 * rule that replaces it: a replacement is proved by the old private key, or it
 * did not happen. Each enters through the production path — the HTTP route, or
 * the Next.js interceptor chain in front of it for the proxy rows (T2, T3) —
 * and each is named for the brief's test row it answers to.
 *
 * T6 and T7 force their interleavings by holding the rotation at a repository
 * call inside its transaction and running the competing request from the test,
 * outside that request's async context, so the two never share a transaction.
 *
 * No secret, code or key value printed by these tests is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { RequestInterceptorContext, ResponseInterceptorContext } from '@spfn/core/nextjs/server';
import {
    executeRequestInterceptors,
    executeResponseInterceptors,
    filterMatchingInterceptors,
} from '@spfn/core/nextjs/server';
import type { SetCookie } from '@spfn/core/nextjs';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mfaVerifications, userInvitations, userPublicKeys, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { hashCredential } from '@/server/lib/link-credentials';
import {
    KEY_REPLACEMENT_PROOF_ISSUER,
    KEY_REPLACEMENT_PROOF_PURPOSE,
    signKeyReplacementProof,
} from '@/server/lib/key-replacement-proof';
import { unsealSession } from '@/server/lib/session';
import { COOKIE_NAMES } from '@/server/lib/config';
import { CSRF_HEADER } from '@/server/lib/csrf';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { authDeviceRegisteredEvent } from '@/server/events';
import { authenticate } from '@/server/middleware/authenticate';
import { mfaVerificationsRepository, usersRepository } from '@/server/repositories';
import { registerPublicKeyService } from '@/server/services/key.service';
import { KeyIdAlreadyRegisteredError } from '@spfn/auth/errors';
import { authInterceptors } from '@/nextjs/interceptors';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const OWNER = 'owner@test.com';
const OTHER = 'other@test.com';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const INVITATION_TOKEN = '6f1d3c2a-8b4e-4f7a-9c1d-2e3f4a5b6c7d';

type KeyPair = ReturnType<typeof generateKeyPair>;

/** A device: its key pair, and the bearer header its requests are signed with. */
interface Device
{
    key: KeyPair;
    authorization: string;
}

/** A promise and the function that settles it, for holding a request mid-flight. */
function deferred(): { promise: Promise<void>; resolve: () => void }
{
    let resolve!: () => void;
    const promise = new Promise<void>(settle => (resolve = settle));

    return { promise, resolve };
}

describe.skipIf(!dbAvailable)('replacing a key requires proof of the old key (bundle 2)', () =>
{
    let app: Hono;
    const unsubscribes: Array<() => void> = [];

    beforeAll(async () =>
    {
        await setupTestDb();
        vi.stubEnv('SPFN_AUTH_SESSION_SECRET', 'test-secret-key-for-testing-only-min-32-chars');
        vi.stubEnv('SPFN_AUTH_CSRF', 'enforce');
        vi.stubEnv('SPFN_AUTH_PASSKEY_RP_ID', RP_ID);
        vi.stubEnv('SPFN_AUTH_PASSKEY_ORIGINS', ORIGIN);
        vi.stubEnv('SPFN_AUTH_TOKEN_ENCRYPTION_KEYS', `active:${Buffer.alloc(32, 9).toString('base64')}`);

        app = new Hono();
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        vi.unstubAllEnvs();
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        resetMemoryRateLimitStore();

        const userRole = await getRoleByName('user');
        const passwordHash = await hashPassword(PASSWORD);
        await db.insert(users).values([
            { email: OWNER, passwordHash, roleId: userRole!.id, emailVerifiedAt: new Date() },
            { email: OTHER, passwordHash, roleId: userRole!.id, emailVerifiedAt: new Date() },
        ]);
    });

    afterEach(() =>
    {
        unsubscribes.splice(0).forEach(unsubscribe => unsubscribe());
        vi.restoreAllMocks();
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

    function bearer(key: { keyId: string; privateKey: string }): string
    {
        return `Bearer ${generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' })}`;
    }

    function keyFields(key: KeyPair)
    {
        return { publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm };
    }

    /** A password sign-in straight at the route, with whatever extra the body carries. */
    async function login(email: string, extra: Record<string, unknown> = {}, key: KeyPair = generateKeyPair('ES256'))
    {
        const response = await post('/_auth/login', { email, password: PASSWORD, ...keyFields(key), ...extra });

        return { response, device: { key, authorization: bearer(key) } };
    }

    async function signedIn(email: string): Promise<Device>
    {
        const { response, device } = await login(email);

        expect(response.status).toBe(200);

        return device;
    }

    function codeFor(secret: string, offsetSteps = 0): string
    {
        return hotp(decodeBase32(secret), totpStep(Date.now()) + offsetSteps);
    }

    /** Enrol a TOTP second factor; the confirming device gets a step-up record. */
    async function enrolled(authorization: string): Promise<string>
    {
        const secret = (await (await post('/_auth/mfa/totp/enroll', {}, authorization)).json()).secret as string;

        expect((await post('/_auth/mfa/totp/confirm', { code: codeFor(secret) }, authorization)).status).toBe(200);

        return secret;
    }

    function deviceNotices(): Array<{ keyId: string }>
    {
        const seen: Array<{ keyId: string }> = [];
        unsubscribes.push(authDeviceRegisteredEvent.subscribe(payload => void seen.push(payload as { keyId: string })));

        return seen;
    }

    /** Events are emitted after commit, which is a tick later than the response. */
    function settle(): Promise<void>
    {
        return new Promise(resolve => setTimeout(resolve, 40));
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId));

        return row;
    }

    async function revokedKeyCount(): Promise<number>
    {
        return (await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.isActive, false)))
            .filter(row => row.revokedAt !== null).length;
    }

    async function stepUpRecordKeyIds(): Promise<string[]>
    {
        return (await getTestDb().select().from(mfaVerifications)).map(row => row.keyId!);
    }

    async function authenticates(authorization: string): Promise<boolean>
    {
        return (await post('/_auth/keys/list', {}, authorization)).status === 200;
    }

    /** Resolves once some backend statement is waiting on a row lock. */
    async function someStatementWaitsOnALock(): Promise<void>
    {
        for (let attempt = 0; attempt < 200; attempt++)
        {
            const rows = await getTestDb().execute(sql`
                SELECT count(*)::int AS waiting FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
            `) as unknown as Array<{ waiting: number }>;

            if (rows[0].waiting > 0)
            {
                return;
            }

            await new Promise(resolve => setTimeout(resolve, 25));
        }

        throw new Error('no statement ever waited on a lock');
    }

    // ========================================================================
    // Driving the Next.js proxy in front of it
    // ========================================================================

    /**
     * One request through every interceptor rule that matches it, then the real
     * router, then its answer back through the same rules — what `createRpcProxy`
     * does. Answers what reached the backend, the backend's answer, and the jar
     * the browser holds afterwards.
     */
    async function throughProxy(path: string, body: Record<string, unknown>, jar: Map<string, string>)
    {
        const matching = filterMatchingInterceptors(authInterceptors, path, 'POST');
        const requestCtx = {
            path,
            method: 'POST',
            headers: { 'content-type': 'application/json' } as Record<string, string>,
            body,
            query: {},
            cookies: jar,
            request: { headers: new Headers({ 'user-agent': CHROME, [CSRF_HEADER]: jar.get(COOKIE_NAMES.CSRF) ?? '' }) },
            metadata: {} as Record<string, unknown>,
        } as unknown as RequestInterceptorContext;

        await executeRequestInterceptors(requestCtx, matching.map(rule => rule.request).filter(phase => !!phase));

        expect(requestCtx.abort).toBeUndefined();

        const forwarded = { ...(requestCtx.body as Record<string, unknown>) };
        const response = await post(path, forwarded);
        const responseCtx = {
            path,
            method: 'POST',
            request: { headers: { 'user-agent': CHROME }, body: forwarded },
            response: { ok: response.ok, status: response.status, statusText: '', headers: new Headers(), body: await response.clone().json() },
            cookies: jar,
            setCookies: [] as SetCookie[],
            metadata: requestCtx.metadata,
        } as unknown as ResponseInterceptorContext;

        await executeResponseInterceptors(responseCtx, matching.map(rule => rule.response).filter(phase => !!phase));

        const nextJar = new Map(jar);
        responseCtx.setCookies.forEach(cookie => nextJar.set(cookie.name, cookie.value));

        return { forwarded, response, jar: nextJar };
    }

    /** The device the sealed session in a jar holds. */
    async function deviceInJar(jar: Map<string, string>): Promise<{ keyId: string; authorization: string }>
    {
        const session = await unsealSession(jar.get(COOKIE_NAMES.SESSION)!);

        return { keyId: session.keyId, authorization: bearer(session) };
    }

    // ========================================================================
    // Sign-in: a key id is not a proof
    // ========================================================================

    it('T1: enrolled, password + the owner\'s key id and no proof — 202, the owner\'s key stays, one device notice, no step-up record carried', async () =>
    {
        const owner = await signedIn(OWNER);
        const secret = await enrolled(owner.authorization);
        const notices = deviceNotices();

        const attacker = await login(OWNER, { oldKeyId: owner.key.keyId });

        expect(attacker.response.status).toBe(202);
        expect((await keyRow(owner.key.keyId)).isActive).toBe(true);

        const challenge = (await attacker.response.json()).challenge.secret;
        expect((await post('/_auth/mfa/verify', { challenge, code: codeFor(secret, 1) })).status).toBe(200);
        await settle();

        expect(notices.map(notice => notice.keyId)).toEqual([attacker.device.key.keyId]);
        expect((await keyRow(owner.key.keyId)).isActive).toBe(true);
        // The owner's record stays on the owner's key; the new key has only the
        // one its own verify wrote.
        expect((await stepUpRecordKeyIds()).sort()).toEqual([owner.key.keyId, attacker.device.key.keyId].sort());
    });

    it('T2: through the proxy, a plain key-id cookie, a body oldKeyId and a forged replacementProof never reach the server', async () =>
    {
        const owner = await signedIn(OWNER);
        await enrolled(owner.authorization);
        const forger = generateKeyPair('ES256');
        const forged = signKeyReplacementProof({ oldKeyId: owner.key.keyId, newKeyId: 'whatever' }, forger.privateKey, 'ES256');
        const jar = new Map([[COOKIE_NAMES.SESSION_KEY_ID, owner.key.keyId]]);

        const { forwarded, response } = await throughProxy('/_auth/login', {
            email: OWNER,
            password: PASSWORD,
            oldKeyId: owner.key.keyId,
            replacementProof: forged,
        }, jar);

        expect(forwarded).not.toHaveProperty('oldKeyId');
        expect(forwarded).not.toHaveProperty('replacementProof');
        expect(response.status).toBe(202);
        expect((await keyRow(owner.key.keyId)).isActive).toBe(true);
    });

    it('T3: a re-login holding the sealed session — 200, no challenge, no device notice, the step-up record carried, the old key revoked', async () =>
    {
        const first = await throughProxy('/_auth/login', { email: OWNER, password: PASSWORD }, new Map());
        expect(first.response.status).toBe(200);
        const old = await deviceInJar(first.jar);
        await enrolled(old.authorization);
        const notices = deviceNotices();

        const again = await throughProxy('/_auth/login', { email: OWNER, password: PASSWORD }, first.jar);
        await settle();

        expect(again.response.status).toBe(200);
        expect((await again.response.json()).mfaRequired).toBe(false);
        expect(notices).toHaveLength(0);
        const renewed = await deviceInJar(again.jar);
        expect(await stepUpRecordKeyIds()).toEqual([renewed.keyId]);
        expect((await keyRow(old.keyId)).isActive).toBe(false);
        expect(await authenticates(renewed.authorization)).toBe(true);
    });

    /** What a T4 proof can be made from: the two accounts' devices, and the key being registered. */
    interface ProofMaterial
    {
        owner: Device;
        other: Device;
        newKeyId: string;
    }

    it.each([
        ['signed by another account\'s key', async ({ other, newKeyId }: ProofMaterial) =>
            signKeyReplacementProof({ oldKeyId: other.key.keyId, newKeyId }, other.key.privateKey, 'ES256')],
        ['signed by the owner\'s revoked key', async ({ owner, newKeyId }: ProofMaterial) =>
        {
            const spare = await signedIn(OWNER);
            expect((await post('/_auth/keys/revoke', { keyId: spare.key.keyId }, owner.authorization)).status).toBe(200);

            return signKeyReplacementProof({ oldKeyId: spare.key.keyId, newKeyId }, spare.key.privateKey, 'ES256');
        }],
        ['that has expired', async ({ owner, newKeyId }: ProofMaterial) =>
            generateClientToken(
                { purpose: KEY_REPLACEMENT_PROOF_PURPOSE, oldKeyId: owner.key.keyId, newKeyId, iat: Math.floor(Date.now() / 1000) - 120 },
                owner.key.privateKey,
                'ES256',
                { issuer: KEY_REPLACEMENT_PROOF_ISSUER, expiresIn: 60 },
            )],
        // F2: a key `authenticate` refuses with KeyExpiredError vouches for nothing.
        ['signed by the owner\'s expired key', async ({ newKeyId }: ProofMaterial) =>
        {
            const spare = await signedIn(OWNER);
            await getTestDb().update(userPublicKeys)
                .set({ expiresAt: new Date(Date.now() - 60_000) })
                .where(eq(userPublicKeys.keyId, spare.key.keyId));

            return signKeyReplacementProof({ oldKeyId: spare.key.keyId, newKeyId }, spare.key.privateKey, 'ES256');
        }],
        ['naming a different new key id', async ({ owner }: ProofMaterial) =>
            signKeyReplacementProof({ oldKeyId: owner.key.keyId, newKeyId: generateKeyPair('ES256').keyId }, owner.key.privateKey, 'ES256')],
        ['that is a request token', async ({ owner, newKeyId }: ProofMaterial) =>
            generateClientToken(
                { keyId: owner.key.keyId, timestamp: Date.now(), purpose: KEY_REPLACEMENT_PROOF_PURPOSE, oldKeyId: owner.key.keyId, newKeyId },
                owner.key.privateKey,
                'ES256',
                { expiresIn: '15m' },
            )],
    ])('T4: a proof %s is a new device — 202, nothing revoked', async (_case, makeProof) =>
    {
        const owner = await signedIn(OWNER);
        const other = await signedIn(OTHER);
        const key = generateKeyPair('ES256');
        const replacementProof = await makeProof({ owner, other, newKeyId: key.keyId });
        await enrolled(owner.authorization);
        const revokedBefore = await revokedKeyCount();

        const { response } = await login(OWNER, { replacementProof }, key);

        expect(response.status).toBe(202);
        expect((await keyRow(owner.key.keyId)).isActive).toBe(true);
        expect((await keyRow(other.key.keyId)).isActive).toBe(true);
        expect(await revokedKeyCount()).toBe(revokedBefore);
    });

    it('T9: a proof dated a year ahead, valid by its own exp, is a new device — 202, the old key stays, one device notice', async () =>
    {
        const owner = await signedIn(OWNER);
        const secret = await enrolled(owner.authorization);
        const notices = deviceNotices();
        const key = generateKeyPair('ES256');
        const replacementProof = generateClientToken(
            {
                purpose: KEY_REPLACEMENT_PROOF_PURPOSE,
                oldKeyId: owner.key.keyId,
                newKeyId: key.keyId,
                iat: Math.floor(Date.now() / 1000) + 365 * 86_400,
            },
            owner.key.privateKey,
            'ES256',
            { issuer: KEY_REPLACEMENT_PROOF_ISSUER, expiresIn: 60 },
        );

        const { response } = await login(OWNER, { replacementProof }, key);

        expect(response.status).toBe(202);
        expect((await keyRow(owner.key.keyId)).isActive).toBe(true);
        const challenge = (await response.json()).challenge.secret;
        expect((await post('/_auth/mfa/verify', { challenge, code: codeFor(secret, 1) })).status).toBe(200);
        await settle();
        expect(notices.map(notice => notice.keyId)).toEqual([key.keyId]);
        expect((await keyRow(owner.key.keyId)).isActive).toBe(true);
    });

    // ========================================================================
    // keys/rotate
    // ========================================================================

    it('T5: a stale session refused by the recent-authentication gate is still refused after keys/rotate', async () =>
    {
        const stale = await signedIn(OWNER);
        const elevenMinutesAgo = new Date(Date.now() - 11 * 60_000);
        await getTestDb().update(userPublicKeys)
            .set({ createdAt: elevenMinutesAgo, authenticatedAt: elevenMinutesAgo })
            .where(eq(userPublicKeys.keyId, stale.key.keyId));

        const before = await post('/_auth/passkeys/register/options', {}, stale.authorization);
        expect(before.status).toBe(403);
        expect((await before.json()).code).toBe('RECENT_AUTH_REQUIRED');

        const rotatedKey = generateKeyPair('ES256');
        expect((await post('/_auth/keys/rotate', keyFields(rotatedKey), stale.authorization)).status).toBe(200);

        const after = await post('/_auth/passkeys/register/options', {}, bearer(rotatedKey));
        expect(after.status).toBe(403);
        expect((await after.json()).code).toBe('RECENT_AUTH_REQUIRED');
    });

    /**
     * The next account lock waits, before it is taken, until `release`. A
     * revocation lands in that window — after the rotation was admitted and
     * before its transaction holds the account (`usersRepository.lockAccount`).
     */
    function pauseBeforeTheAccountLock(reached: ReturnType<typeof deferred>, release: ReturnType<typeof deferred>): void
    {
        const lockAccount = usersRepository.lockAccount.bind(usersRepository);
        vi.spyOn(usersRepository, 'lockAccount').mockImplementationOnce(async (...args) =>
        {
            reached.resolve();
            await release.promise;

            return lockAccount(...args);
        });
    }

    it('T6: a rotation and a revoke-all racing, in both orders — no key authenticates afterwards', async () =>
    {
        // Order 1: the revoke-all commits after the rotation was admitted and
        // before it takes the account lock, which comes before it revokes the
        // old key.
        const rotating = await signedIn(OWNER);
        const revoking = await signedIn(OWNER);
        const reached = deferred();
        const release = deferred();
        pauseBeforeTheAccountLock(reached, release);
        const rotatedKey = generateKeyPair('ES256');

        const rotation = post('/_auth/keys/rotate', keyFields(rotatedKey), rotating.authorization);
        await reached.promise;
        expect((await post('/_auth/keys/revoke-all', { includeCurrent: true }, revoking.authorization)).status).toBe(200);
        release.resolve();
        await rotation;

        for (const authorization of [rotating.authorization, bearer(rotatedKey), revoking.authorization])
        {
            expect(await authenticates(authorization)).toBe(false);
        }

        // Order 2: the rotation has revoked the old key and written the new one,
        // and the revoke-all runs before it commits.
        resetMemoryRateLimitStore();
        const rotating2 = await signedIn(OWNER);
        const revoking2 = await signedIn(OWNER);
        const written = deferred();
        const commit = deferred();
        const move = mfaVerificationsRepository.moveToKeyId.bind(mfaVerificationsRepository);
        vi.spyOn(mfaVerificationsRepository, 'moveToKeyId').mockImplementationOnce(async (...args) =>
        {
            written.resolve();
            await commit.promise;

            return move(...args);
        });
        const rotatedKey2 = generateKeyPair('ES256');

        const rotation2 = post('/_auth/keys/rotate', keyFields(rotatedKey2), rotating2.authorization);
        await written.promise;
        const revokeAll = post('/_auth/keys/revoke-all', { includeCurrent: true }, revoking2.authorization);
        await someStatementWaitsOnALock();
        commit.resolve();
        expect((await rotation2).status).toBe(200);
        expect((await revokeAll).status).toBe(200);

        for (const authorization of [rotating2.authorization, bearer(rotatedKey2), revoking2.authorization])
        {
            expect(await authenticates(authorization)).toBe(false);
        }
    });

    it('T7: keys/rotate whose old key was revoked after admission is refused, and writes no key', async () =>
    {
        const rotating = await signedIn(OWNER);
        const other = await signedIn(OWNER);
        const reached = deferred();
        const release = deferred();
        pauseBeforeTheAccountLock(reached, release);
        const rotatedKey = generateKeyPair('ES256');

        const rotation = post('/_auth/keys/rotate', keyFields(rotatedKey), rotating.authorization);
        await reached.promise;
        expect((await post('/_auth/keys/revoke', { keyId: rotating.key.keyId }, other.authorization)).status).toBe(200);
        release.resolve();

        expect((await rotation).status).toBe(401);
        expect(await keyRow(rotatedKey.keyId)).toBeUndefined();
        expect(await authenticates(other.authorization)).toBe(true);
    });

    it('T10: keys/rotate onto the caller\'s own pending key — 409, the pending key and the old key unchanged', async () =>
    {
        const owner = await signedIn(OWNER);
        await enrolled(owner.authorization);
        const pendingKey = generateKeyPair('ES256');
        expect((await login(OWNER, {}, pendingKey)).response.status).toBe(202);
        const pendingBefore = await keyRow(pendingKey.keyId);

        const rotate = await post('/_auth/keys/rotate', keyFields(pendingKey), owner.authorization);

        expect(rotate.status).toBe(409);
        expect((await rotate.json()).error.code).toBe('KeyIdAlreadyRegisteredError');
        expect(await keyRow(pendingKey.keyId)).toEqual(pendingBefore);
        expect((await keyRow(owner.key.keyId)).isActive).toBe(true);
    });

    it('T11: keys/rotate onto another active key the caller holds, same public key — 409, both keys unchanged', async () =>
    {
        const owner = await signedIn(OWNER);
        const second = await signedIn(OWNER);
        // What a registration could change; `lastUsedAt` moves with the request itself.
        const state = async (keyId: string) =>
        {
            const { isActive, revokedAt, expiresAt, authenticatedAt, keyEpoch } = await keyRow(keyId);

            return { isActive, revokedAt, expiresAt, authenticatedAt, keyEpoch };
        };
        const ownerBefore = await state(owner.key.keyId);
        const secondBefore = await state(second.key.keyId);

        const rotate = await post('/_auth/keys/rotate', keyFields(second.key), owner.authorization);

        expect(rotate.status).toBe(409);
        expect((await rotate.json()).error.code).toBe('KeyIdAlreadyRegisteredError');
        expect(await state(owner.key.keyId)).toEqual(ownerBefore);
        expect(await state(second.key.keyId)).toEqual(secondBefore);
        expect(await authenticates(owner.authorization)).toBe(true);
    });

    it('T12: a door that cannot step up presenting the caller\'s own pending key is a 409, never a resumed challenge', async () =>
    {
        const owner = await signedIn(OWNER);
        await enrolled(owner.authorization);
        const pendingKey = generateKeyPair('ES256');
        expect((await login(OWNER, {}, pendingKey)).response.status).toBe(202);
        const [account] = await getTestDb().select().from(users).where(eq(users.email, OWNER));

        // device-code reads its result through `registeredBinding`, which a
        // resumed challenge would turn into a plain 500.
        await expect(registerPublicKeyService({
            userId: account.id,
            ...keyFields(pendingKey),
            channel: 'device-code',
        })).rejects.toBeInstanceOf(KeyIdAlreadyRegisteredError);
        expect((await keyRow(pendingKey.keyId)).pendingMfaChallengeId).not.toBeNull();
    });

    it('T13: a sign-in with the same key after the account\'s generation ended is refused — never 200 then 401', async () =>
    {
        const owner = await signedIn(OWNER);
        // What a rotation racing a revoke-all leaves: an active row, one
        // generation behind its account.
        await getTestDb().update(users)
            .set({ keyEpoch: sql`${users.keyEpoch} + 1` })
            .where(eq(users.email, OWNER));

        const again = await login(OWNER, {}, owner.key);

        expect(again.response.status).toBe(409);
        expect((await again.response.json()).error.code).toBe('KeyIdAlreadyRegisteredError');
        expect(await authenticates(owner.authorization)).toBe(false);
    });

    // ========================================================================
    // An existing key id
    // ========================================================================

    it('T8: an existing key id — 409 on rotate and invitation acceptance with no SQL in the body; on login 200 for the same public key, 409 for another', async () =>
    {
        const owner = await signedIn(OWNER);
        const second = await signedIn(OWNER);
        const notSql = (text: string) => expect(text.toLowerCase()).not.toMatch(/insert|user_public_keys|duplicate key/);

        const rotate = await post('/_auth/keys/rotate', {
            ...keyFields(generateKeyPair('ES256')),
            keyId: second.key.keyId,
        }, owner.authorization);
        expect(rotate.status).toBe(409);
        notSql(await rotate.text());
        expect((await keyRow(owner.key.keyId)).isActive).toBe(true);

        const [inviter] = await getTestDb().select().from(users).where(eq(users.email, OTHER));
        await getTestDb().insert(userInvitations).values({
            email: 'invitee@test.com',
            tokenHash: hashCredential(INVITATION_TOKEN),
            roleId: inviter.roleId,
            invitedBy: inviter.id,
            status: 'pending',
            expiresAt: new Date(Date.now() + 86_400_000),
        });
        const accept = await post('/_auth/invitations/accept', {
            token: INVITATION_TOKEN,
            password: PASSWORD,
            ...keyFields(generateKeyPair('ES256')),
            keyId: owner.key.keyId,
        });
        expect(accept.status).toBe(409);
        notSql(await accept.text());
        expect(await getTestDb().select().from(users).where(eq(users.email, 'invitee@test.com'))).toHaveLength(0);
        expect((await getTestDb().select().from(userInvitations))[0].status).toBe('pending');

        expect((await login(OWNER, {}, owner.key)).response.status).toBe(200);

        const impostor = await login(OWNER, {}, { ...generateKeyPair('ES256'), keyId: owner.key.keyId });
        expect(impostor.response.status).toBe(409);
        notSql(await impostor.response.text());
    });
});
