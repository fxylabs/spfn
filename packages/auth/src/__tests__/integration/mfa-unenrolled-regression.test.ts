/**
 * @spfn/auth - Unenrolled Account Regression
 *
 * The one promise the second factor makes to everyone who never asked for it:
 * an account with nothing enrolled behaves exactly as it did before #95, on
 * every route the step-up gate was wired into.
 *
 * "Exactly" is pinned rather than described. Each row asserts today's status
 * **and** the set of keys in today's body, so a field appearing or disappearing
 * on one of these responses fails here rather than in somebody's app. The
 * values inside are not pinned — they are ids, timestamps and counts that vary
 * per run; the shape is the contract.
 *
 * Nothing here enrols a second factor. A suite that did would stop being the
 * regression it exists to be.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { FixtureAuthenticator } from '../helpers/webauthn-fixture';
import { userPublicKeys, users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { authenticate } from '@/server/middleware/authenticate';
import { authLoginEvent } from '@/server/events';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const NEW_PASSWORD = 'Password456!';
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:3000';

interface Session
{
    authorization: string;
    keyId: string;
}

describe.skipIf(!dbAvailable)('an account with no second factor', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';
        process.env.SPFN_AUTH_PASSKEY_RP_ID = RP_ID;
        process.env.SPFN_AUTH_PASSKEY_ORIGINS = ORIGIN;

        app = new Hono();
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

        const userRole = await getRoleByName('user');
        await db.insert(users).values({
            email: 'owner@test.com',
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        });
    });

    function post(path: string, body: unknown, authorization?: string)
    {
        return app.request(path, {
            method: 'POST',
            headers: authorization ? { ...JSON_HEADERS, Authorization: authorization } : JSON_HEADERS,
            body: JSON.stringify(body),
        });
    }

    function put(path: string, body: unknown, authorization: string)
    {
        return app.request(path, {
            method: 'PUT',
            headers: { ...JSON_HEADERS, Authorization: authorization },
            body: JSON.stringify(body),
        });
    }

    async function signIn(): Promise<{ session: Session; response: Response }>
    {
        const keyPair = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email: 'owner@test.com',
            password: PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        });

        return {
            session: {
                authorization: `Bearer ${generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' })}`,
                keyId: keyPair.keyId,
            },
            response,
        };
    }

    /** Push a device key's registration moment past every window there is. */
    async function ageSession(session: Session, minutes: number): Promise<void>
    {
        await getTestDb()
            .update(userPublicKeys)
            .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
            .where(eq(userPublicKeys.keyId, session.keyId));
    }

    it('pins POST /_auth/login: 200 and the body keys it has always answered', async () =>
    {
        const { response } = await signIn();

        expect(response.status).toBe(200);
        expect(Object.keys(await response.json()).sort())
            .toEqual(['email', 'passwordChangeRequired', 'publicId', 'userId']);
    });

    it('announces the login with mfaEnrolled false, and nothing else about the second factor', async () =>
    {
        const seen: Record<string, unknown>[] = [];
        const unsubscribe = authLoginEvent.subscribe(async (payload) => void seen.push(payload));

        try
        {
            await signIn();
            await new Promise(resolve => setTimeout(resolve, 30));

            expect(seen).toHaveLength(1);
            expect(Object.keys(seen[0]).sort()).toEqual(['email', 'mfaEnrolled', 'phone', 'provider', 'userId']);
            expect(seen[0].mfaEnrolled).toBe(false);
        }
        finally
        {
            unsubscribe();
        }
    });

    it('pins PUT /_auth/password on a key well past every window: 204, no body, and the password really changed', async () =>
    {
        const { session } = await signIn();
        await ageSession(session, 60);

        const response = await put('/_auth/password', {
            currentPassword: PASSWORD,
            newPassword: NEW_PASSWORD,
        }, session.authorization);

        expect(response.status).toBe(204);
        expect(await response.text()).toBe('');

        // And it is the new password that signs in afterwards.
        const keyPair = generateKeyPair('ES256');
        const retry = await post('/_auth/login', {
            email: 'owner@test.com',
            password: NEW_PASSWORD,
            publicKey: keyPair.publicKey,
            keyId: keyPair.keyId,
            fingerprint: keyPair.fingerprint,
            algorithm: keyPair.algorithm,
        });

        expect(retry.status).toBe(200);
    });

    it('pins POST /_auth/keys/revoke-all on a key well past every window: 200 and its two body keys', async () =>
    {
        const { session } = await signIn();
        const other = await signIn();
        await ageSession(session, 60);

        const response = await post('/_auth/keys/revoke-all', {}, session.authorization);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(Object.keys(body).sort()).toEqual(['currentKeyRevoked', 'revokedCount']);
        expect(body).toEqual({ revokedCount: 1, currentKeyRevoked: false });

        // The spared key is the caller's, and the other one is gone.
        expect((await post('/_auth/keys/list', {}, other.session.authorization)).status).toBe(401);
        expect((await post('/_auth/keys/list', {}, session.authorization)).status).toBe(200);
    });

    it('pins POST /_auth/passkeys/revoke past the window: still 403 RECENT_AUTH_REQUIRED, with its body keys', async () =>
    {
        const { session } = await signIn();
        const authenticator = await FixtureAuthenticator.create();
        const options = await post('/_auth/passkeys/register/options', {}, session.authorization);
        const registered = await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({
                challenge: (await options.json()).challenge,
                origin: ORIGIN,
                rpId: RP_ID,
            }),
        }, session.authorization);
        const { passkeyId } = await registered.json();

        await ageSession(session, 60);

        const response = await post('/_auth/passkeys/revoke', { passkeyId }, session.authorization);
        const body = await response.json();

        expect(response.status).toBe(403);
        expect(body.code).toBe('RECENT_AUTH_REQUIRED');
        expect(Object.keys(body.error).sort()).toEqual(['code', 'message', 'requestId']);
    });

    it('pins POST /_auth/passkeys/revoke inside the window: 200 and the one key it answers', async () =>
    {
        const { session } = await signIn();
        const authenticator = await FixtureAuthenticator.create();
        const options = await post('/_auth/passkeys/register/options', {}, session.authorization);
        const registered = await post('/_auth/passkeys/register/verify', {
            response: authenticator.attest({
                challenge: (await options.json()).challenge,
                origin: ORIGIN,
                rpId: RP_ID,
            }),
        }, session.authorization);
        const { passkeyId } = await registered.json();

        const response = await post('/_auth/passkeys/revoke', { passkeyId }, session.authorization);

        expect(response.status).toBe(200);
        expect(Object.keys(await response.json())).toEqual(['passkeyId']);
    });

    it('reports itself unenrolled through GET /_auth/mfa/status without having been asked for anything', async () =>
    {
        const { session } = await signIn();
        const response = await app.request('/_auth/mfa/status', {
            method: 'GET',
            headers: { ...JSON_HEADERS, Authorization: session.authorization },
        });

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ enrolled: false, methods: [], recoveryCodesRemaining: 0 });
    });
});
