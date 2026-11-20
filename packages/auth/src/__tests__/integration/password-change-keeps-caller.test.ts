/**
 * @spfn/auth - a password change keeps the session that made it (#372)
 *
 * `PUT /_auth/password` ends every other session, as `revoke-all` does, and
 * spares the key the request signs with by moving it into the account's new
 * key generation in the same statement — unless `includeCurrent: true`.
 *
 * | Row | Checks | Unnoticed without it |
 * | --- | --- | --- |
 * | K1 | the caller's key is active and of the new generation, the other key revoked, a pending 202 key deleted; the caller's next request is 200, the other's 401 | a spare that leaves the key active in the ended generation answers 204 and 401s one request later |
 * | K2 | a caller key of an older generation stays outdated: its next request is 401 | a spare that sets the account's generation brings back a key a revocation already ended |
 * | K3 | `includeCurrent: true` revokes the caller's key too | the "this device is compromised" path silently keeps the device signed in |
 * | K4 | an application profile's `revoke-all` and password change both revoke a device key whose id is the profile's key id (login names it freely); its next request is 401 | that device key survives "sign out everywhere" from the profile |
 * | K5 | a device session's `revoke-all` still spares itself and revokes the other key | spare-by-credential that spares nothing signs the caller out of "my other devices" |
 * | K6 | an application profile's logout leaves a device key with its key id signed in | a profile's sign-out ends a device session that is not its own |
 * | K7 | an application profile's `keys/rotate` is refused and retires no device key with its key id; the new key is not written | a profile takes over a device key's session — binding, generation and all — by naming its id |
 *
 * No secret, code or key value printed by these tests is a real one.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { userPublicKeys, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { decodeBase32, hotp, totpStep } from '@/server/lib/totp';
import { authenticate } from '@/server/middleware/authenticate';
import { registerAuthProfile } from '@/server/middleware/auth-profiles';
import { CLIENT_PROOF_HEADERS } from '@/server/client-proof/admission';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { changePasswordService } = await import('@/server/services/auth.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const EMAIL = 'owner@test.com';
const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'Password456!';
const APP_PROFILE = 'passwordKeepsCallerAppProfileV1';
/** The key id the profile's verifier reports — a string any sign-in can also name a device key by. */
const PROFILE_KEY_ID = 'pkc-app-profile-key';

type KeyPair = ReturnType<typeof generateKeyPair>;

describe.skipIf(!dbAvailable)('a password change keeps the session that made it (#372)', () =>
{
    let app: Hono;
    let userId: number;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        // A TOTP secret is stored encrypted (K1 enrols one).
        process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS = `active:${Buffer.alloc(32, 9).toString('base64')}`;

        registerAuthProfile(APP_PROFILE, {
            verify: async () => ({ userId: String(userId), keyId: PROFILE_KEY_ID, scheme: APP_PROFILE }),
        });

        app = new Hono();
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await teardownTestDb();
        delete process.env.SPFN_AUTH_TOKEN_ENCRYPTION_KEYS;
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        resetMemoryRateLimitStore();

        const userRole = await getRoleByName('user');
        const [user] = await db.insert(users).values({
            email: EMAIL,
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        }).returning();
        userId = user.id;
    });

    /** As `key`'s device session, as the application profile, or with no credential. */
    function send(method: string, path: string, body: unknown, as?: KeyPair | 'profile')
    {
        return app.request(path, {
            method,
            headers: { ...JSON_HEADERS, ...credentialHeaders(as) },
            body: method === 'GET' ? undefined : JSON.stringify(body),
        });
    }

    function credentialHeaders(as?: KeyPair | 'profile'): Record<string, string>
    {
        if (as === 'profile')
        {
            return { [CLIENT_PROOF_HEADERS.profile]: APP_PROFILE };
        }

        return as
            ? { Authorization: `Bearer ${generateClientToken({ keyId: as.keyId }, as.privateKey, 'ES256', { expiresIn: '5m' })}` }
            : {};
    }

    /** A password sign-in with a fresh key, under `keyId` when given: 200, or 202 once the account is enrolled. */
    async function signIn(expected = 200, keyId?: string): Promise<KeyPair>
    {
        const key = { ...generateKeyPair('ES256'), ...(keyId ? { keyId } : {}) };
        const response = await send('POST', '/_auth/login', {
            email: EMAIL,
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });

        expect(response.status).toBe(expected);

        return key;
    }

    /** Enrol a TOTP second factor from `key`, which its confirmation also steps up. */
    async function enrolTotp(key: KeyPair): Promise<void>
    {
        const enroll = await send('POST', '/_auth/mfa/totp/enroll', {}, key);
        const secret = decodeBase32((await enroll.json()).secret);
        const confirm = await send('POST', '/_auth/mfa/totp/confirm', { code: hotp(secret, totpStep(Date.now())) }, key);

        expect(confirm.status).toBe(200);
    }

    async function keyRow(keyId: string)
    {
        const [row] = await getTestDb().select().from(userPublicKeys).where(eq(userPublicKeys.keyId, keyId)).limit(1);

        return row;
    }

    async function accountEpoch(): Promise<number>
    {
        const [row] = await getTestDb().select().from(users).where(eq(users.id, userId)).limit(1);

        return row.keyEpoch;
    }

    async function nextRequestStatus(key: KeyPair): Promise<number>
    {
        return (await send('GET', '/_auth/session', undefined, key)).status;
    }

    it('K1 the caller\'s key moves into the new generation; every other key is revoked, a pending key deleted, and the caller\'s next request is admitted', async () =>
    {
        const caller = await signIn();
        const other = await signIn();
        await enrolTotp(caller);
        const pending = await signIn(202);
        const epochBefore = await accountEpoch();
        expect(await keyRow(pending.keyId)).toMatchObject({ isActive: false });

        expect((await send('PUT', '/_auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, caller)).status).toBe(204);

        const callerRow = await keyRow(caller.keyId);
        expect({
            epoch: await accountEpoch(),
            caller: { isActive: callerRow.isActive, keyEpoch: callerRow.keyEpoch },
            other: (await keyRow(other.keyId)).isActive,
            pending: await keyRow(pending.keyId),
            callerNext: await nextRequestStatus(caller),
            otherNext: await nextRequestStatus(other),
        }).toEqual({
            epoch: epochBefore + 1,
            caller: { isActive: true, keyEpoch: epochBefore + 1 },
            other: false,
            pending: undefined,
            callerNext: 200,
            otherNext: 401,
        });
    });

    it('K2 a caller key of an older generation is not brought back by the spare', async () =>
    {
        // The state a key a global revocation could not see is left in — one a
        // rotation in flight inserts after its snapshot: active, generation ended.
        const caller = await signIn();
        await getTestDb().update(users).set({ keyEpoch: sql`${users.keyEpoch} + 1` }).where(eq(users.id, userId));

        await changePasswordService({
            userId,
            credential: { kind: 'deviceKey', keyId: caller.keyId },
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD,
        });

        expect({ keyEpoch: (await keyRow(caller.keyId)).keyEpoch, next: await nextRequestStatus(caller) })
            .toEqual({ keyEpoch: (await accountEpoch()) - 2, next: 401 });
    });

    it('K3 includeCurrent: true revokes the caller\'s key as well', async () =>
    {
        const caller = await signIn();
        const other = await signIn();

        expect((await send('PUT', '/_auth/password', {
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD,
            includeCurrent: true,
        }, caller)).status).toBe(204);

        expect({
            caller: (await keyRow(caller.keyId)).isActive,
            other: (await keyRow(other.keyId)).isActive,
            callerNext: await nextRequestStatus(caller),
        }).toEqual({ caller: false, other: false, callerNext: 401 });
    });

    const PROFILE_SIGN_OUTS: [string, () => Response | Promise<Response>][] = [
        ['revoke-all', () => send('POST', '/_auth/keys/revoke-all', {}, 'profile')],
        ['a password change', () => send('PUT', '/_auth/password', { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, 'profile')],
    ];

    it.each(PROFILE_SIGN_OUTS)('K4 %s from an application profile revokes a device key whose id is the profile\'s key id', async (_name, signOut) =>
    {
        const twin = await signIn(200, PROFILE_KEY_ID);
        const other = await signIn();
        expect(await nextRequestStatus(twin)).toBe(200);

        expect((await signOut()).status).toBeLessThan(300);

        expect({
            twin: (await keyRow(twin.keyId)).isActive,
            other: (await keyRow(other.keyId)).isActive,
            twinNext: await nextRequestStatus(twin),
            profileNext: (await send('GET', '/_auth/session', undefined, 'profile')).status,
        }).toEqual({ twin: false, other: false, twinNext: 401, profileNext: 200 });
    });

    it('K5 a device session\'s revoke-all spares itself and revokes the other key', async () =>
    {
        const caller = await signIn();
        const other = await signIn();

        const response = await send('POST', '/_auth/keys/revoke-all', {}, caller);

        expect({
            status: response.status,
            body: await response.json(),
            callerNext: await nextRequestStatus(caller),
            otherNext: await nextRequestStatus(other),
        }).toEqual({ status: 200, body: { revokedCount: 1, currentKeyRevoked: false }, callerNext: 200, otherNext: 401 });
    });

    it('K6 an application profile\'s logout leaves a device key with its key id signed in', async () =>
    {
        const twin = await signIn(200, PROFILE_KEY_ID);

        expect((await send('POST', '/_auth/logout', {}, 'profile')).status).toBe(204);

        expect({ twin: (await keyRow(twin.keyId)).isActive, twinNext: await nextRequestStatus(twin) })
            .toEqual({ twin: true, twinNext: 200 });
    });

    it('K7 an application profile\'s keys/rotate is refused and retires no device key with its key id', async () =>
    {
        const twin = await signIn(200, PROFILE_KEY_ID);
        const fresh = generateKeyPair('ES256');

        const response = await send('POST', '/_auth/keys/rotate', {
            publicKey: fresh.publicKey,
            keyId: fresh.keyId,
            fingerprint: fresh.fingerprint,
            algorithm: fresh.algorithm,
        }, 'profile');

        expect({
            status: response.status,
            twin: (await keyRow(twin.keyId)).isActive,
            twinNext: await nextRequestStatus(twin),
            fresh: await keyRow(fresh.keyId),
        }).toEqual({ status: 401, twin: true, twinNext: 200, fresh: undefined });
    });
});
