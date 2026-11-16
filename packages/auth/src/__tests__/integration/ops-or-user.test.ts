/**
 * @spfn/auth - opsOrUser Integration Tests
 *
 * One route, two credentials (issue fxylabs/spfn#86), driven end to end
 * against a real Hono app: the auth router mounted with `authenticate` as the
 * server-level `auth` middleware, plus test routes carrying `opsOrUser` in its
 * three configurations (permissions only, roles only, both).
 *
 * One `it` per row of the approved design's case table, named `row N`. Every
 * 200 asserts the context as well as the status, because the property that
 * makes the two branches safe to share a route is that neither leaks into the
 * other: the ops branch leaves `getAuth` null and the user branch leaves
 * `getOpsToken` null.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { NamedMiddleware } from '@spfn/core/route';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { REQUEST_TOKEN_CLOCK_SKEW_SECONDS } from '@/server/helpers/jwt';
import { getAuth } from '@/server/helpers/context';
import { authenticate } from '@/server/middleware/authenticate';
import { getOpsToken } from '@/server/middleware/ops-token-auth';
import { registerMachineVerifier } from '@/server/middleware/machine-principals';
import { opsOrUser, type OpsOrUserConfig } from '@/server/middleware/ops-or-user';
import { issueOpsTokenService, revokeOpsTokenService } from '@/server/services/ops-token.service';
import type { AuthContext } from '@/server/middleware/authenticate';

const { mainAuthRouter } = await import('@/server/routes');
const { route, defineRouter } = await import('@spfn/core/route');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';

/** The scope the test routes ask an ops token for. */
const SCOPE = 'waitlist:read';

/** Held by the built-in `admin` role, not by `user` (see BUILTIN_ROLE_PERMISSIONS). */
const ADMIN_PERMISSION = 'user:delete';

/** Held by `superadmin` alone, so `admin` is the "permission missing" caller. */
const SUPERADMIN_PERMISSION = 'rbac:permission:manage';

/**
 * What a handler saw. Exactly one of the two is set on every 200 — the ops
 * branch never populates `auth`, the user branch never populates `opsToken`.
 */
function principals(c: { raw: Context })
{
    const auth = getAuth(c.raw) as AuthContext | undefined;
    const ops = getOpsToken(c.raw);

    return {
        auth: auth ? { userId: auth.userId, role: auth.role } : null,
        ops: ops ? { name: ops.name, scopes: ops.scopes } : null,
    };
}

/**
 * How many times the server-level `auth` middleware ran. Row 15 reads it: a
 * route carrying `opsOrUser` auto-skips the global one, so the ops branch must
 * reach the handler without the global `authenticate` running at all.
 */
let globalAuthRuns = 0;

const testRouter = defineRouter({
    // permissions only — the configuration rows 1-13 and 15 are driven through
    byPermission: route.get('/t/by-permission')
        .use([opsOrUser({ opsScopes: [SCOPE], permissions: [ADMIN_PERMISSION] })])
        .handler(async (c) => principals(c)),

    // roles only
    byRole: route.get('/t/by-role')
        .use([opsOrUser({ opsScopes: [SCOPE], roles: ['admin'] })])
        .handler(async (c) => principals(c)),

    // roles AND permissions: the role matches for an admin, the permission does not
    byBothPermissionMissing: route.get('/t/by-both-permission-missing')
        .use([opsOrUser({ opsScopes: [SCOPE], roles: ['admin'], permissions: [SUPERADMIN_PERMISSION] })])
        .handler(async (c) => principals(c)),

    // roles AND permissions: an admin holds the permission but is not the role
    byBothRoleMissing: route.get('/t/by-both-role-missing')
        .use([opsOrUser({ opsScopes: [SCOPE], roles: ['superadmin'], permissions: [ADMIN_PERMISSION] })])
        .handler(async (c) => principals(c)),

    // no opsOrUser: the server-level `auth` middleware alone (row 13)
    plain: route.get('/t/plain')
        .handler(async (c) => principals(c)),
});

describe('row 14: definition-time validation (no database needed)', () =>
{
    it('row 14: fails closed on a configuration that would admit a credential unchecked', () =>
    {
        // opsScopes empty — the ops branch would admit any valid ops token.
        expect(() => opsOrUser({ opsScopes: [], permissions: [ADMIN_PERMISSION] })).toThrow(/opsScopes/);

        // opsScopes missing entirely (the shape an untyped caller passes).
        expect(() => opsOrUser({ roles: ['admin'] } as OpsOrUserConfig)).toThrow(/opsScopes/);

        // neither guard given — the user branch would admit any session.
        expect(() => opsOrUser({ opsScopes: [SCOPE] })).toThrow(/roles/);

        // both given but empty — same hole, spelled differently.
        expect(() => opsOrUser({ opsScopes: [SCOPE], roles: [], permissions: [] })).toThrow(/roles/);
    });
});

describe.skipIf(!dbAvailable)('opsOrUser — one route, two credentials', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';

        // Row 8's credential: a token in a *registered* machine namespace that
        // is not the ops namespace. Registration is permanent per process, so
        // it happens once and the prefix is one no other suite registers.
        registerMachineVerifier({
            id: 'testMachine',
            match: { tokenPrefix: 'tm_' },
            verify: async () => ({
                subjectType: 'service',
                subjectId: 'test-machine',
                scopes: [SCOPE],
                scheme: 'testMachine',
            }),
        });

        app = new Hono();

        // A real app registers `authenticate` as a server-level middleware.
        // Wrapping it in a counter is what makes row 15 an assertion rather
        // than an inference.
        const countingAuth = async (c: Context, next: () => Promise<void>) =>
        {
            globalAuthRuns += 1;

            return authenticate.handler(c, next);
        };

        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: countingAuth }]);
        registerRoutes(app, testRouter, [{ name: authenticate.name, handler: countingAuth }]);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        const db = getTestDb();
        await clearTables(db);
        await initializeAuth();
        globalAuthRuns = 0;

        const adminRole = await getRoleByName('admin');
        const userRole = await getRoleByName('user');

        await db.insert(users).values({
            email: 'admin@test.com',
            passwordHash: await hashPassword(PASSWORD),
            roleId: adminRole!.id,
            emailVerifiedAt: new Date(),
        });

        await db.insert(users).values({
            email: 'user@test.com',
            passwordHash: await hashPassword(PASSWORD),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        });
    });

    /** Half of what the CLI does at login: hand a freshly generated public key over. */
    async function registerKey(email: string)
    {
        const keyPair = generateKeyPair('ES256');

        const response = await app.request('/_auth/login', {
            method: 'POST',
            headers: JSON_HEADERS,
            body: JSON.stringify({
                email,
                password: PASSWORD,
                publicKey: keyPair.publicKey,
                keyId: keyPair.keyId,
                fingerprint: keyPair.fingerprint,
                algorithm: keyPair.algorithm,
                deviceName: 'spfn CLI',
            }),
        });

        expect(response.status).toBe(200);

        return keyPair;
    }

    /** The other half: a request signed with the private key kept on the client. */
    async function signIn(email: string): Promise<string>
    {
        const keyPair = await registerKey(email);

        return `Bearer ${generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' })}`;
    }

    async function opsToken(scopes: string[]): Promise<string>
    {
        const { token } = await issueOpsTokenService('test', scopes, null);

        return `Bearer ${token}`;
    }

    function get(path: string, headers: Record<string, string>)
    {
        return app.request(path, { headers });
    }

    // ---- the ops branch ----------------------------------------------------

    it('row 1: a valid ops token carrying the scope is admitted, with no user session', async () =>
    {
        for (const scopes of [[SCOPE], ['*']])
        {
            const response = await get('/t/by-permission', { Authorization: await opsToken(scopes) });

            expect(response.status).toBe(200);
            expect(await response.json()).toEqual({
                auth: null,
                ops: { name: 'test', scopes },
            });
        }
    });

    it('row 2: a valid ops token missing the scope is 403, naming the scope', async () =>
    {
        const response = await get('/t/by-permission', { Authorization: await opsToken(['other:read']) });

        expect(response.status).toBe(403);
        expect(JSON.stringify(await response.json())).toContain(SCOPE);
    });

    it('row 3: unknown, revoked and expired ops tokens all answer the same 401', async () =>
    {
        const unknown = `Bearer spfn_ops_${'0'.repeat(64)}`;

        const issued = await issueOpsTokenService('revoked', [SCOPE], null);
        await revokeOpsTokenService(Number(issued.record.id));

        const past = await issueOpsTokenService('expired', [SCOPE], new Date(Date.now() - 1000));

        for (const authorization of [unknown, `Bearer ${issued.token}`, `Bearer ${past.token}`])
        {
            const response = await get('/t/by-permission', { Authorization: authorization });

            expect(response.status).toBe(401);
            expect((await response.json()).error.message).toBe('Invalid ops token');
        }
    });

    it('row 4: the ops prefix with no secret takes the ops branch, not the user one', async () =>
    {
        const response = await get('/t/by-permission', { Authorization: 'Bearer spfn_ops_' });

        expect(response.status).toBe(401);
        // The ops branch's own refusal — the user branch would answer
        // 'Invalid token: missing keyId' here.
        expect((await response.json()).error.message).toBe('Invalid ops token');
    });

    // ---- the user branch ---------------------------------------------------

    it('row 5: a valid session holding the permission is admitted, with no ops token', async () =>
    {
        const response = await get('/t/by-permission', { Authorization: await signIn('admin@test.com') });

        expect(response.status).toBe(200);

        const body = await response.json();
        expect(body.ops).toBeNull();
        expect(body.auth).toMatchObject({ role: 'admin' });
    });

    it('row 6: a valid session missing the permission is 403', async () =>
    {
        const response = await get('/t/by-permission', { Authorization: await signIn('user@test.com') });

        expect(response.status).toBe(403);
        expect((await response.json()).error.code).toBe('InsufficientPermissionsError');
    });

    it('row 7: an expired or wrongly signed session token is 401', async () =>
    {
        const keyPair = await registerKey('admin@test.com');

        // Its own key, expired one second longer ago than the clock-skew allowance.
        const expired = generateClientToken(
            { keyId: keyPair.keyId },
            keyPair.privateKey,
            'ES256',
            { expiresIn: -(REQUEST_TOKEN_CLOCK_SKEW_SECONDS + 1) },
        );

        // Its keyId, signed with a private key the registered public half cannot verify.
        const forged = generateClientToken({ keyId: keyPair.keyId }, generateKeyPair('ES256').privateKey, 'ES256');

        for (const token of [expired, forged])
        {
            expect((await get('/t/by-permission', { Authorization: `Bearer ${token}` })).status).toBe(401);
        }
    });

    it('row 8: a token in a registered machine namespace that is not ops is 401 on the user branch', async () =>
    {
        // The user path refuses every registered machine credential (#79), and
        // this route admits machine principals only through `opsTokenAuth`.
        const response = await get('/t/by-permission', { Authorization: 'Bearer tm_whatever' });

        expect(response.status).toBe(401);
    });

    it('row 9: a malformed bearer, and no Authorization at all, are 401', async () =>
    {
        expect((await get('/t/by-permission', { Authorization: 'Bearer not-a-token' })).status).toBe(401);
        expect((await get('/t/by-permission', { Authorization: 'Basic abc' })).status).toBe(401);
        expect((await get('/t/by-permission', {})).status).toBe(401);
    });

    it('row 10: a session cookie with no Authorization is 401', async () =>
    {
        // The backend never reads cookies. A browser session reaches a route
        // as a Bearer token because `@spfn/auth/nextjs/api` forwards it as
        // one; presented as a cookie alone it is no credential here.
        const response = await get('/t/by-permission', { Cookie: 'spfn-session=whatever' });

        expect(response.status).toBe(401);
    });

    it('row 11: a profile header with a session token is the profile refusal, returned as a Response', async () =>
    {
        // `authenticate` answers this by *returning* a built Response (#106),
        // not by throwing, so this row is also the proof that the chain
        // propagates a returned Response instead of swallowing it.
        const response = await get('/t/by-permission', {
            Authorization: await signIn('admin@test.com'),
            'x-spfn-auth-profile': 'clientProofV1',
        });

        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe('PROFILE_REJECTED');
    });

    it('row 12: a profile header with an ops token is ignored by the ops branch', async () =>
    {
        // Current `opsTokenAuth` behaviour, asserted rather than changed: it
        // reads `Authorization` only, so the profile header has no effect on
        // this branch. The profile dispatch lives in `authenticate`.
        const response = await get('/t/by-permission', {
            Authorization: await opsToken([SCOPE]),
            'x-spfn-auth-profile': 'clientProofV1',
        });

        expect(response.status).toBe(200);
        expect((await response.json()).auth).toBeNull();
    });

    it('row 13: an ops token on a plain authenticate route is still 401', async () =>
    {
        const response = await get('/t/plain', { Authorization: await opsToken([SCOPE]) });

        expect(response.status).toBe(401);
    });

    // ---- composition -------------------------------------------------------

    it('row 15: the server-level auth middleware is auto-skipped, so the ops branch never runs it', async () =>
    {
        globalAuthRuns = 0;

        const response = await get('/t/by-permission', { Authorization: await opsToken([SCOPE]) });

        expect(response.status).toBe(200);
        expect(globalAuthRuns).toBe(0);
    });

    it('row 16: roles only — a session in the role is admitted', async () =>
    {
        const response = await get('/t/by-role', { Authorization: await signIn('admin@test.com') });

        expect(response.status).toBe(200);

        const body = await response.json();
        expect(body.ops).toBeNull();
        expect(body.auth).toMatchObject({ role: 'admin' });
    });

    it('row 17: roles only — a session in another role is 403 for the role', async () =>
    {
        const response = await get('/t/by-role', { Authorization: await signIn('user@test.com') });

        expect(response.status).toBe(403);
        expect((await response.json()).error.code).toBe('InsufficientRoleError');
    });

    it('row 18: roles and permissions — role matches, permission missing, is the permission refusal', async () =>
    {
        const response = await get('/t/by-both-permission-missing', { Authorization: await signIn('admin@test.com') });

        expect(response.status).toBe(403);
        expect((await response.json()).error.code).toBe('InsufficientPermissionsError');
    });

    it('row 19: roles and permissions — permission held, role wrong, is the role refusal', async () =>
    {
        // Roles run first, so the caller is refused for the thing that is
        // actually wrong rather than for the cheaper-to-check one.
        const response = await get('/t/by-both-role-missing', { Authorization: await signIn('admin@test.com') });

        expect(response.status).toBe(403);
        expect((await response.json()).error.code).toBe('InsufficientRoleError');
    });

    it('the ops branch and the user branch reach the same handler on one route', async () =>
    {
        // Compile-only: the return type is NamedMiddleware<'opsOrUser'>, which
        // is what makes `.use([...])` type-check and `.skip` typing see the
        // name. A `defineMiddleware` factory would return a bare handler here.
        const middleware: NamedMiddleware<'opsOrUser'> = opsOrUser({ opsScopes: [SCOPE], roles: ['admin'] });
        expect(middleware._name).toBe('opsOrUser');
        expect(middleware.skips).toEqual(['auth']);

        expect((await get('/t/by-role', { Authorization: await opsToken([SCOPE]) })).status).toBe(200);
        expect((await get('/t/by-role', { Authorization: await signIn('admin@test.com') })).status).toBe(200);
    });
});
