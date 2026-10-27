/**
 * @spfn/auth - a revoked key's SSE streams close, after the revocation commits
 *
 * Every revocation ends in `keysRepository`, which hands each revoked key id to
 * `closeSSEConnectionsByKey` through `onAfterCommit`. The core export is replaced
 * by a spy that, when it runs, reads the key's row over the test connection — a
 * connection of its own, to which an uncommitted revoke is invisible. So "after
 * commit" here means: every recorded close saw its key already `isActive = false`.
 *
 * | #    | path                                                         | expected close calls                                  |
 * |------|--------------------------------------------------------------|-------------------------------------------------------|
 * | R18  | `POST /_auth/keys/revoke` with another device's key          | that key, once, after commit                          |
 * | R19  | `POST /_auth/keys/revoke-all` (default, spare current)       | every other active key, not the current               |
 * | R20  | `revoke-all` with `includeCurrent: true`                     | every active key including the current                |
 * | R21  | logout                                                       | the current key                                       |
 * | R22a | password change                                              | every active key                                      |
 * | R22b | password reset                                               | every active key                                      |
 * | R22c | account deletion request                                     | every active key                                      |
 * | R23a | key rotation                                                 | the old key only; the new key is never closed         |
 * | R23b | session renewal                                              | the old key only; the new key is never closed         |
 * | R23c | re-login with `oldKeyId`                                     | the old key only; the new key is never closed         |
 * | R24  | transaction rolls back after the repository revoke           | no call                                               |
 * | R25  | repository revoke outside a transaction                      | call at once (after a tick)                           |
 * | R26  | revoke of an already-revoked key                             | no call (0 rows)                                      |
 * | R27  | revoke with another user's key id                            | 0 rows, no call                                       |
 * | R28  | the one-time token manager's `verifyKey` against the real rows | a live key's token holds; a revoked, an expired-but-active and an unknown key's are refused; an untagged token holds |
 *
 * R18–R23 go through the mounted router; R24–R27 call the repository directly,
 * because what they pin is the repository's own contract with a transaction.
 * R28 goes through `initOneTimeTokenManager` / `getOneTimeTokenManager`.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { userPublicKeys, users } from '@/server/entities';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { hashPassword } from '@/server/helpers/password';
import { authenticate } from '@/server/middleware/authenticate';

const sendEmail = vi.fn().mockResolvedValue({ success: true });
const closeSpy = vi.fn();

vi.mock('@spfn/notification/server', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/notification/server')>();

    return {
        ...actual,
        sendEmail: (...args: unknown[]) => sendEmail(...args),
        sendSMS: vi.fn().mockResolvedValue({ success: true }),
    };
});

vi.mock('@spfn/core/event/sse', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('@spfn/core/event/sse')>();

    return { ...actual, closeSSEConnectionsByKey: (keyId: string) => closeSpy(keyId) };
});

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { runInTransaction } = await import('@spfn/core/db');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { keysRepository } = await import('@/server/repositories/keys.repository');
const { initOneTimeTokenManager, getOneTimeTokenManager } = await import('@/server/lib/one-time-token');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'SecurePassword123!';
const NEW_PASSWORD = 'BrandNewPassword456!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';
const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CLIENT_TYPE_HEADER = 'x-test-client-type';

/** One close as the spy saw it: which key, and whether its row was still active. */
interface Close
{
    keyId: string;
    isActive: boolean;
}

interface Session
{
    keyId: string;
    privateKey: string;
    authorization: string;
}

const closes: Close[] = [];
const pendingCloses: Promise<void>[] = [];

/** Read over the test connection, which sees committed rows only. */
async function keyIsActive(keyId: string): Promise<boolean>
{
    const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId)).limit(1);

    return row.isActive;
}

function recordClose(keyId: string): Promise<void>
{
    const recorded = keyIsActive(keyId).then((isActive) =>
    {
        closes.push({ keyId, isActive });
    });

    pendingCloses.push(recorded);

    return recorded;
}

function forgetCloses(): void
{
    closes.length = 0;
    pendingCloses.length = 0;
    closeSpy.mockReset();
    closeSpy.mockImplementation(recordClose);
}

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Let the after-commit callbacks fire, then let every close finish reading its row. */
async function settle(): Promise<void>
{
    for (let tick = 0; tick < 10; tick += 1)
    {
        await nextTick();
    }

    await Promise.all(pendingCloses);
}

async function expectClosedAfterCommit(keyIds: string[]): Promise<void>
{
    await settle();

    expect(closes.map((close) => close.keyId).sort()).toEqual([...keyIds].sort());
    expect(closes.filter((close) => close.isActive)).toEqual([]);
}

async function expectNoClose(): Promise<void>
{
    await settle();

    expect(closeSpy).not.toHaveBeenCalled();
}

describe.skipIf(!dbAvailable)('SSE streams close after a key revocation commits (case table R18-R28)', () =>
{
    let app: Hono;
    let testIndex = 0;
    let clientIp: string;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_APP_URL = 'https://app.example.com';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;

        app = mountApp();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        delete process.env.SPFN_AUTH_PASSKEY_RP_ID;
        delete process.env.SPFN_AUTH_PASSKEY_ORIGINS;
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();
        sendEmail.mockClear();
        forgetCloses();

        testIndex += 1;
        // Several routes are rate limited per address, and the store lives for the
        // life of the process, so each row gets an address of its own.
        clientIp = `192.0.2.${testIndex & 0xff}`;
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    /**
     * The auth router behind a stand-in for the web proxy's client-type marker,
     * which session binding and renewal need to see (as in session-renewal.test.ts).
     */
    function mountApp(): Hono
    {
        const mounted = new Hono();

        mounted.use('*', async (c, next) =>
        {
            const declared = c.req.header(CLIENT_TYPE_HEADER);

            if (declared)
            {
                c.set('clientType', declared);
            }

            await next();
        });
        registerRoutes(mounted, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        mounted.onError(ErrorHandler());

        return mounted;
    }

    function send(method: string, path: string, body: unknown, authorization?: string)
    {
        const headers: Record<string, string> = {
            ...JSON_HEADERS,
            'user-agent': CHROME,
            'x-forwarded-for': clientIp,
            [CLIENT_TYPE_HEADER]: 'web',
        };

        if (authorization)
        {
            headers.Authorization = authorization;
        }

        return app.request(path, { method, headers, body: JSON.stringify(body) });
    }

    const post = (path: string, body: unknown, authorization?: string) => send('POST', path, body, authorization);

    function bearer(keyId: string, privateKey: string): string
    {
        return `Bearer ${generateClientToken({ keyId }, privateKey, 'ES256', { expiresIn: '5m' })}`;
    }

    function keyFields(key: ReturnType<typeof generateKeyPair>)
    {
        return { publicKey: key.publicKey, keyId: key.keyId, fingerprint: key.fingerprint, algorithm: key.algorithm };
    }

    // ========================================================================
    // Accounts and keys
    // ========================================================================

    async function seedUser(email: string)
    {
        const userRole = await getRoleByName('user');
        const [row] = await getTestDb().insert(users).values({
            email,
            passwordHash: await hashPassword(PASSWORD),
            emailVerifiedAt: new Date(),
            roleId: userRole!.id,
        }).returning();

        return row;
    }

    /** Sign in with a password, optionally replacing `oldKeyId`, and answer with what the client holds. */
    async function signIn(email: string, oldKeyId?: string): Promise<Session>
    {
        const key = generateKeyPair('ES256');
        const response = await post('/_auth/login', { email, password: PASSWORD, ...keyFields(key), oldKeyId });

        expect(response.status).toBe(200);

        return { keyId: key.keyId, privateKey: key.privateKey, authorization: bearer(key.keyId, key.privateKey) };
    }

    /** An account with three signed-in devices; the first is the one making the request. */
    async function threeDevices(email: string)
    {
        const user = await seedUser(email);
        const current = await signIn(email);
        const others = [await signIn(email), await signIn(email)];

        return { user, current, others };
    }

    /** Turn session binding on for the device holding `session`, with a passkey to renew it by. */
    async function bindToPasskey(session: Session): Promise<FixtureAuthenticator>
    {
        const authenticator = await FixtureAuthenticator.create();
        const options = await post('/_auth/passkeys/register/options', {}, session.authorization);
        const verified = await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({ challenge: (await options.json()).challenge, origin: ORIGIN, rpId: RP_ID }),
        }, session.authorization);

        expect(verified.status).toBe(200);
        expect((await post('/_auth/session/binding', { mode: 'passkey' }, session.authorization)).status).toBe(200);

        return authenticator;
    }

    /** Renew `session` with `authenticator`, answering the new key's id. */
    async function renew(session: Session, authenticator: FixtureAuthenticator): Promise<string>
    {
        const started = await post('/_auth/session/renew/options', {}, session.authorization);
        expect(started.status).toBe(200);

        const fresh = generateKeyPair('ES256');
        const verified = await post('/_auth/session/renew/verify', {
            response: authenticator.assert({ challenge: (await started.json()).challenge, origin: ORIGIN, rpId: RP_ID, counter: 2 }),
            ...keyFields(fresh),
        }, session.authorization);

        expect(verified.status).toBe(200);

        return fresh.keyId;
    }

    /** Run a password reset to completion from the emailed link. */
    async function resetPassword(email: string): Promise<void>
    {
        expect((await post('/_auth/password/reset', { email })).status).toBe(200);

        const emailed = sendEmail.mock.calls.filter(([arg]) => arg?.template === 'password-reset').pop();
        const token = new URL(emailed![0].data.confirmUrl).searchParams.get('token');
        const confirmed = await post('/_auth/password/reset/confirm', { token });
        const { setupSecret } = await confirmed.json();

        expect((await post('/_auth/password/reset/complete', {
            setupSecret,
            password: NEW_PASSWORD,
            ...keyFields(generateKeyPair('ES256')),
        })).status).toBe(200);
    }

    async function markRevoked(keyId: string): Promise<void>
    {
        await getTestDb().update(userPublicKeys)
            .set({ isActive: false, revokedAt: new Date(), revokedReason: 'revoked before the row' })
            .where(eq(userPublicKeys.keyId, keyId));
    }

    // ========================================================================
    // Revocations through the router
    // ========================================================================

    it('R18 POST /_auth/keys/revoke with another device\'s key closes that key once, after commit', async () =>
    {
        const { current, others: [other] } = await threeDevices('r18@test.com');
        forgetCloses();

        expect((await post('/_auth/keys/revoke', { keyId: other.keyId }, current.authorization)).status).toBe(200);

        await expectClosedAfterCommit([other.keyId]);
    });

    it('R19 POST /_auth/keys/revoke-all sparing the current device closes every other active key, not the current', async () =>
    {
        const { current, others } = await threeDevices('r19@test.com');
        forgetCloses();

        expect((await post('/_auth/keys/revoke-all', {}, current.authorization)).status).toBe(200);

        await expectClosedAfterCommit(others.map((other) => other.keyId));
    });

    it('R20 POST /_auth/keys/revoke-all with includeCurrent closes every active key including the current', async () =>
    {
        const { current, others } = await threeDevices('r20@test.com');
        forgetCloses();

        expect((await post('/_auth/keys/revoke-all', { includeCurrent: true }, current.authorization)).status).toBe(200);

        await expectClosedAfterCommit([current.keyId, ...others.map((other) => other.keyId)]);
    });

    it('R21 POST /_auth/logout closes the current key', async () =>
    {
        const { current } = await threeDevices('r21@test.com');
        forgetCloses();

        expect((await post('/_auth/logout', {}, current.authorization)).status).toBe(204);

        await expectClosedAfterCommit([current.keyId]);
    });

    it('R22a PUT /_auth/password closes every active key', async () =>
    {
        const { current, others } = await threeDevices('r22a@test.com');
        forgetCloses();

        const changed = await send('PUT', '/_auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, current.authorization);

        expect(changed.status).toBe(204);
        await expectClosedAfterCommit([current.keyId, ...others.map((other) => other.keyId)]);
    });

    it('R22b a completed password reset closes every active key, and not the key the reset registers', async () =>
    {
        const { current, others } = await threeDevices('r22b@test.com');
        forgetCloses();

        await resetPassword('r22b@test.com');

        await expectClosedAfterCommit([current.keyId, ...others.map((other) => other.keyId)]);
    });

    it('R22c POST /_auth/deletion/request closes every active key', async () =>
    {
        const { current, others } = await threeDevices('r22c@test.com');
        forgetCloses();

        expect((await post('/_auth/deletion/request', { password: PASSWORD }, current.authorization)).status).toBe(200);

        await expectClosedAfterCommit([current.keyId, ...others.map((other) => other.keyId)]);
    });

    it('R23a POST /_auth/keys/rotate closes the old key only, never the new one', async () =>
    {
        const { current } = await threeDevices('r23a@test.com');
        const rotated = generateKeyPair('ES256');
        forgetCloses();

        expect((await post('/_auth/keys/rotate', keyFields(rotated), current.authorization)).status).toBe(200);

        await expectClosedAfterCommit([current.keyId]);
        expect(closeSpy).not.toHaveBeenCalledWith(rotated.keyId);
    });

    it('R23b a session renewal closes the old key only, never the new one', async () =>
    {
        await seedUser('r23b@test.com');
        const session = await signIn('r23b@test.com');
        const authenticator = await bindToPasskey(session);
        await settle();
        forgetCloses();

        const renewedKeyId = await renew(session, authenticator);

        await expectClosedAfterCommit([session.keyId]);
        expect(closeSpy).not.toHaveBeenCalledWith(renewedKeyId);
    });

    it('R23c a re-login with oldKeyId closes the old key only, never the new one', async () =>
    {
        const { current } = await threeDevices('r23c@test.com');
        forgetCloses();

        const relogged = await signIn('r23c@test.com', current.keyId);

        await expectClosedAfterCommit([current.keyId]);
        expect(closeSpy).not.toHaveBeenCalledWith(relogged.keyId);
    });

    // ========================================================================
    // The repository against a transaction
    // ========================================================================

    it('R24 a transaction that rolls back after the repository revoke closes nothing, and the key stays active', async () =>
    {
        const { user, current } = await threeDevices('r24@test.com');
        forgetCloses();

        const rolledBack = runInTransaction(async () =>
        {
            expect(await keysRepository.revokeByKeyIdAndUserId(current.keyId, user.id, 'R24')).not.toBeNull();
            throw new Error('R24 rolls back');
        });

        await expect(rolledBack).rejects.toThrow('R24 rolls back');
        await expectNoClose();
        expect(await keyIsActive(current.keyId)).toBe(true);
    });

    it('R25 a repository revoke outside a transaction closes the key at once, after a tick', async () =>
    {
        const { user, current } = await threeDevices('r25@test.com');
        forgetCloses();

        expect(await keysRepository.revokeByKeyIdAndUserId(current.keyId, user.id, 'R25')).not.toBeNull();
        await nextTick();

        expect(closeSpy).toHaveBeenCalledWith(current.keyId);
        await expectClosedAfterCommit([current.keyId]);
    });

    it('R26 revoking an already-revoked key matches 0 rows and closes nothing', async () =>
    {
        const { user, current } = await threeDevices('r26@test.com');
        await markRevoked(current.keyId);
        forgetCloses();

        expect(await keysRepository.revokeByKeyIdAndUserId(current.keyId, user.id, 'R26')).toBeNull();

        await expectNoClose();
    });

    it('R27 revoking another user\'s key id matches 0 rows and closes nothing', async () =>
    {
        const { user } = await threeDevices('r27@test.com');
        const { current: stranger } = await threeDevices('r27-stranger@test.com');
        forgetCloses();

        expect(await keysRepository.revokeByKeyIdAndUserId(stranger.keyId, user.id, 'R27')).toBeNull();

        await expectNoClose();
        expect(await keyIsActive(stranger.keyId)).toBe(true);
    });

    // ========================================================================
    // The one-time token manager's key check
    // ========================================================================

    it('R28 the one-time token manager holds a live key\'s token and refuses a revoked, an expired-but-active and an unknown key\'s', async () =>
    {
        const { user, current: live, others: [revoked, expired] } = await threeDevices('r28@test.com');
        await markRevoked(revoked.keyId);
        await getTestDb().update(userPublicKeys)
            .set({ expiresAt: new Date(Date.now() - 60_000) })
            .where(eq(userPublicKeys.keyId, expired.keyId));
        initOneTimeTokenManager();
        const manager = getOneTimeTokenManager();
        const subject = String(user.id);
        const verifyTagged = async (keyId: string) => manager.verify(await manager.issue(subject, { keyId }));

        expect(await verifyTagged(live.keyId)).toBe(subject);
        expect(await verifyTagged(revoked.keyId)).toBeNull();
        expect(await verifyTagged(expired.keyId)).toBeNull();
        expect(await keyIsActive(expired.keyId)).toBe(true);
        expect(await verifyTagged('no-such-key')).toBeNull();
        expect(await manager.verify(await manager.issue(subject))).toBe(subject);
        manager.destroy();
    });
});
