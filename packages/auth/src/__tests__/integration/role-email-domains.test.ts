/**
 * @spfn/auth - Per-role email-domain policy, end to end (#106)
 *
 * One test per row of the case table in the pull request, numbered to match.
 * Driven against the mounted auth router with real sign-in and signed
 * requests, so a grant path or a role-resolution path that skips the policy
 * fails here rather than in review.
 *
 * `R` is `admin`, restricted to `example.com` unless a row says otherwise.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { roles, users, userInvitations } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { getAuth } from '@/server/helpers/context';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { authenticate } from '@/server/middleware/authenticate';
import { requireRole } from '@/server/middleware/require-role';
import { requirePermissions } from '@/server/middleware/require-permission';
import { authLogger } from '@/server/logger';
import { ensureAdminExists } from '@/server/setup';
import { updateUserService } from '@/server/services/user.service';
import { getUserPermissions, getUserRole, hasRole } from '@/server/services/permission.service';
import {
    assertRoleEmailDomainPolicy,
    demoteRoleEmailDomainViolations,
    findUserWithEffectiveRole,
    listRoleEmailDomainViolations,
} from '@/server/services/role-email-domain.service';
import { RoleEmailDomainNotAllowedError } from '@spfn/auth/errors';

const { mainAuthRouter } = await import('@/server/routes');
const { registerRoutes } = await import('@spfn/core/route');
const { ErrorHandler, resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'Password123!';
const POLICY_VAR = 'SPFN_AUTH_ROLE_EMAIL_DOMAINS';
const ADMIN_ONLY_PERMISSION = 'user:delete';
const USER_PERMISSION = 'auth:self:manage';

type RoleName = 'user' | 'admin' | 'superadmin';

interface SeedOptions
{
    verified?: boolean;
    phone?: string;
}

function setPolicy(value: string | undefined): void
{
    if (value === undefined)
    {
        delete process.env[POLICY_VAR];
    }
    else
    {
        process.env[POLICY_VAR] = value;
    }
}

async function roleId(name: RoleName): Promise<number>
{
    return (await getRoleByName(name))!.id;
}

async function seed(email: string | null, role: RoleName, { verified = true, phone }: SeedOptions = {})
{
    const [row] = await getTestDb().insert(users).values({
        email,
        phone: phone ?? null,
        passwordHash: await hashPassword(PASSWORD),
        roleId: await roleId(role),
        emailVerifiedAt: verified ? new Date() : null,
    }).returning();

    return row;
}

async function storedRoleOf(userId: number): Promise<number | null>
{
    const [row] = await getTestDb().select().from(users).where(eq(users.id, userId)).limit(1);

    return row.roleId;
}

describe.skipIf(!dbAvailable)('Per-role email-domain policy', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';

        app = new Hono();
        app.get('/probe/admin', authenticate.handler, requireRole('admin'), c => c.json({ role: getAuth(c).role }));
        app.get('/probe/user-permission', authenticate.handler, requirePermissions(USER_PERMISSION),
            c => c.json({ role: getAuth(c).role }));
        app.get('/probe/admin-permission', authenticate.handler, requirePermissions(ADMIN_ONLY_PERMISSION),
            c => c.json({ role: getAuth(c).role }));
        registerRoutes(app, mainAuthRouter, [{ name: authenticate.name, handler: authenticate.handler }]);
        app.onError(ErrorHandler());
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        setPolicy(undefined);
        resetMemoryRateLimitStore();
        await clearTables(getTestDb());
        await initializeAuth();
    });

    afterEach(() =>
    {
        setPolicy(undefined);
        delete process.env.SPFN_AUTH_ADMIN_ACCOUNTS;
        vi.restoreAllMocks();
    });

    async function signIn(email: string): Promise<string>
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
            }),
        });

        expect(response.status).toBe(200);

        return `Bearer ${generateClientToken({ keyId: keyPair.keyId }, keyPair.privateKey, 'ES256', { expiresIn: '5m' })}`;
    }

    function call(method: string, path: string, authorization?: string, body?: unknown)
    {
        return app.request(path, {
            method,
            headers: { ...JSON_HEADERS, ...(authorization ? { Authorization: authorization } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    }

    async function assignRole(authorization: string, userId: number, role: RoleName)
    {
        return call('PATCH', `/_auth/admin/users/${userId}/role`, authorization, { roleId: await roleId(role) });
    }

    async function errorCodeOf(response: Response): Promise<string | undefined>
    {
        const body = await response.json();

        return body.__type ?? body.error?.code;
    }

    /** A superadmin inside every policy these rows set, to act as the caller. */
    async function superadminCaller(): Promise<string>
    {
        await seed('root@example.com', 'superadmin');

        return signIn('root@example.com');
    }

    async function expectRefusedGrant(response: Response, userId: number, unchangedRole: RoleName)
    {
        expect(response.status).toBe(403);
        expect(await errorCodeOf(response)).toBe('RoleEmailDomainNotAllowedError');
        expect(await storedRoleOf(userId)).toBe(await roleId(unchangedRole));
    }

    describe('grant: PATCH /_auth/admin/users/:userId/role', () =>
    {
        it('#1 unset policy: assigning admin is granted', async () =>
        {
            const caller = await superadminCaller();
            const target = await seed('someone@elsewhere.test', 'user');

            expect((await assignRole(caller, target.id, 'admin')).status).toBe(200);
            expect(await storedRoleOf(target.id)).toBe(await roleId('admin'));
        });

        it('#2 unset policy: an unverified account can be assigned admin', async () =>
        {
            const caller = await superadminCaller();
            const target = await seed('someone@elsewhere.test', 'user', { verified: false });

            expect((await assignRole(caller, target.id, 'admin')).status).toBe(200);
        });

        it('#4 in-domain, verified: granted', async () =>
        {
            const caller = await superadminCaller();
            const target = await seed('staff@example.com', 'user');
            setPolicy('admin=example.com');

            expect((await assignRole(caller, target.id, 'admin')).status).toBe(200);
            expect(await storedRoleOf(target.id)).toBe(await roleId('admin'));
        });

        it('#5 out-of-domain, verified: 403 RoleEmailDomainNotAllowedError, row unchanged', async () =>
        {
            const caller = await superadminCaller();
            const target = await seed('member@gmail.test', 'user');
            setPolicy('admin=example.com');

            await expectRefusedGrant(await assignRole(caller, target.id, 'admin'), target.id, 'user');
        });

        it('#6 in-domain, unverified: 403, row unchanged', async () =>
        {
            const caller = await superadminCaller();
            const target = await seed('staff@example.com', 'user', { verified: false });
            setPolicy('admin=example.com');

            await expectRefusedGrant(await assignRole(caller, target.id, 'admin'), target.id, 'user');
        });

        it('#7 no email (phone only): 403', async () =>
        {
            const caller = await superadminCaller();
            const target = await seed(null, 'user', { phone: '+821012345678' });
            setPolicy('admin=example.com');

            await expectRefusedGrant(await assignRole(caller, target.id, 'admin'), target.id, 'user');
        });

        it('#8 Sub.Example.COM when only example.com is listed: 403 (no implicit subdomains)', async () =>
        {
            const caller = await superadminCaller();
            const target = await seed('staff@Sub.Example.COM', 'user');
            setPolicy('admin=example.com');

            await expectRefusedGrant(await assignRole(caller, target.id, 'admin'), target.id, 'user');
        });

        it('#9 domain listed in Unicode, punycode-equivalent email: granted', async () =>
        {
            const caller = await superadminCaller();
            const target = await seed('staff@xn--bcher-kva.example', 'user');
            setPolicy('admin=bücher.example;superadmin=example.com');

            expect((await assignRole(caller, target.id, 'admin')).status).toBe(200);
        });

        it('#10 unverified, out-of-domain, assigning an unrestricted role: granted', async () =>
        {
            const caller = await superadminCaller();
            const target = await seed('member@gmail.test', 'admin', { verified: false });
            setPolicy('admin=example.com');

            expect((await assignRole(caller, target.id, 'user')).status).toBe(200);
            expect(await storedRoleOf(target.id)).toBe(await roleId('user'));
        });

        it('#11 direct service call assigning R to an out-of-domain account: 403, no bypass', async () =>
        {
            const target = await seed('member@gmail.test', 'user');
            setPolicy('admin=example.com');

            await expect(updateUserService(target.id, { roleId: await roleId('admin') }))
                .rejects.toBeInstanceOf(RoleEmailDomainNotAllowedError);
            expect(await storedRoleOf(target.id)).toBe(await roleId('user'));
        });

        it('#11 a service call that moves the email out of the domain together with R: 403', async () =>
        {
            const target = await seed('staff@example.com', 'user');
            setPolicy('admin=example.com');

            await expect(updateUserService(target.id, { roleId: await roleId('admin'), email: 'staff@gmail.test' }))
                .rejects.toBeInstanceOf(RoleEmailDomainNotAllowedError);
        });
    });

    describe('grant: invitations', () =>
    {
        const TOKEN = '11111111-1111-4111-8111-111111111111';

        async function accept()
        {
            const keyPair = generateKeyPair('ES256');

            return call('POST', '/_auth/invitations/accept', undefined, {
                token: TOKEN,
                password: PASSWORD,
                publicKey: keyPair.publicKey,
                keyId: keyPair.keyId,
                fingerprint: keyPair.fingerprint,
                algorithm: keyPair.algorithm,
            });
        }

        async function pendingInvitation(email: string, role: RoleName, invitedBy: number)
        {
            await getTestDb().insert(userInvitations).values({
                email,
                token: TOKEN,
                roleId: await roleId(role),
                invitedBy,
                status: 'pending',
                expiresAt: new Date(Date.now() + 86_400_000),
            });
        }

        it('#12 inviting an out-of-domain email to R: 403 at create', async () =>
        {
            const caller = await superadminCaller();
            setPolicy('admin=example.com');

            const response = await call('POST', '/_auth/invitations', caller, {
                email: 'member@gmail.test',
                roleId: await roleId('admin'),
            });

            expect(response.status).toBe(403);
            expect(await errorCodeOf(response)).toBe('RoleEmailDomainNotAllowedError');
        });

        it('#12 inviting an in-domain email to R: created (verification waits for acceptance)', async () =>
        {
            const caller = await superadminCaller();
            setPolicy('admin=example.com');

            const response = await call('POST', '/_auth/invitations', caller, {
                email: 'staff@example.com',
                roleId: await roleId('admin'),
            });

            expect(response.status).toBe(200);
        });

        it('#13 invite created while unset, policy then set, invitee out: 403 at accept, no account created', async () =>
        {
            const inviter = await seed('root@example.com', 'superadmin');
            await pendingInvitation('member@gmail.test', 'admin', inviter.id);
            setPolicy('admin=example.com');

            const response = await accept();

            expect(response.status).toBe(403);
            expect(await errorCodeOf(response)).toBe('RoleEmailDomainNotAllowedError');
            expect(await getTestDb().select().from(users).where(eq(users.email, 'member@gmail.test'))).toHaveLength(0);
        });

        it('#14 in-domain invitee: accept is granted, account holds R and is verified', async () =>
        {
            const inviter = await seed('root@example.com', 'superadmin');
            await pendingInvitation('staff@example.com', 'admin', inviter.id);
            setPolicy('admin=example.com');

            expect((await accept()).status).toBe(200);

            const [created] = await getTestDb().select().from(users).where(eq(users.email, 'staff@example.com'));
            expect(created.roleId).toBe(await roleId('admin'));
            expect(created.emailVerifiedAt).not.toBeNull();
        });
    });

    describe('check time', () =>
    {
        it('#3 unset policy: stored admin passes requireRole(admin)', async () =>
        {
            await seed('someone@elsewhere.test', 'admin', { verified: false });
            const authorization = await signIn('someone@elsewhere.test');

            expect((await call('GET', '/probe/admin', authorization)).status).toBe(200);
        });

        it('#15 stored R, in-domain, verified: passes requireRole(admin)', async () =>
        {
            await seed('staff@example.com', 'admin');
            setPolicy('admin=example.com');
            const authorization = await signIn('staff@example.com');

            const response = await call('GET', '/probe/admin', authorization);

            expect(response.status).toBe(200);
            expect((await response.json()).role).toBe('admin');
        });

        describe('#16–#20 stored R, policy set after the grant, now out of it', () =>
        {
            let admin: typeof users.$inferSelect;
            let authorization: string;

            beforeEach(async () =>
            {
                admin = await seed('staff@gmail.test', 'admin');
                authorization = await signIn('staff@gmail.test');
                setPolicy('admin=example.com');
            });

            it('#16 requireRole(admin): 403 insufficient role; auth.role is user; row still R', async () =>
            {
                const refused = await call('GET', '/probe/admin', authorization);

                expect(refused.status).toBe(403);
                expect(await errorCodeOf(refused)).toBe('InsufficientRoleError');
                expect((await (await call('GET', '/probe/user-permission', authorization)).json()).role).toBe('user');
                expect(await storedRoleOf(admin.id)).toBe(await roleId('admin'));
            });

            it('#17 requirePermissions(<user permission>): passes', async () =>
            {
                expect((await call('GET', '/probe/user-permission', authorization)).status).toBe(200);
            });

            it('#18 requirePermissions(<admin-only permission>): 403', async () =>
            {
                expect((await call('GET', '/probe/admin-permission', authorization)).status).toBe(403);
            });

            it('#19 getUserRole / hasRole / getUserPermissions report the user role and its permissions', async () =>
            {
                expect(await getUserRole(admin.id)).toBe('user');
                expect(await hasRole(admin.id, 'admin')).toBe(false);
                expect(await hasRole(admin.id, 'user')).toBe(true);
                expect(await getUserPermissions(admin.id)).toEqual([USER_PERMISSION]);
            });

            it('#19 GET /_auth/session reports the user role and its permissions', async () =>
            {
                const session = await (await call('GET', '/_auth/session', authorization)).json();

                expect(session.role.name).toBe('user');
                expect(session.permissions.map((perm: { name: string }) => perm.name)).toEqual([USER_PERMISSION]);
            });

            it('#20 domain re-added: passes again, and the row was never written', async () =>
            {
                const [before] = await getTestDb().select().from(users).where(eq(users.id, admin.id));
                expect((await call('GET', '/probe/admin', authorization)).status).toBe(403);

                setPolicy('admin=example.com,gmail.test');

                expect((await call('GET', '/probe/admin', authorization)).status).toBe(200);
                const [after] = await getTestDb().select().from(users).where(eq(users.id, admin.id));
                expect(after.roleId).toBe(before.roleId);
                expect(after.updatedAt).toEqual(before.updatedAt);
            });

            it('logs one warn per downgrade with the reason, user id and stored role — never the email', async () =>
            {
                const warn = vi.spyOn(authLogger.service, 'warn');

                await findUserWithEffectiveRole(admin.id);

                expect(warn).toHaveBeenCalledTimes(1);
                expect(warn.mock.calls[0][1]).toEqual({
                    reason: 'role_email_domain_policy',
                    userId: admin.id,
                    storedRole: 'admin',
                });
                expect(JSON.stringify(warn.mock.calls)).not.toContain('gmail.test');
            });
        });

        it('#21 stored R changes email to out-of-domain: next request resolves as user', async () =>
        {
            const admin = await seed('staff@example.com', 'admin');
            setPolicy('admin=example.com');
            const authorization = await signIn('staff@example.com');
            expect((await call('GET', '/probe/admin', authorization)).status).toBe(200);

            await getTestDb().update(users).set({ email: 'staff@gmail.test' }).where(eq(users.id, admin.id));

            const response = await call('GET', '/probe/user-permission', authorization);
            expect((await response.json()).role).toBe('user');
        });

        it('fallback role missing: resolves to no role and no permissions rather than throwing', async () =>
        {
            const admin = await seed('staff@gmail.test', 'admin');
            setPolicy('admin=example.com');
            await getTestDb().update(roles).set({ name: 'user-renamed' }).where(eq(roles.name, 'user'));

            expect((await findUserWithEffectiveRole(admin.id))?.role).toBeNull();
            expect(await getUserPermissions(admin.id)).toEqual([]);
            expect(await getUserRole(admin.id)).toBeNull();
        });
    });

    describe('authority: caller effective, target stored', () =>
    {
        it('#22 admin caller, target a stored superadmin out of policy: refused as today', async () =>
        {
            setPolicy('admin=example.com;superadmin=example.com');
            await seed('staff@example.com', 'admin');
            const target = await seed('boss@gmail.test', 'superadmin');
            const caller = await signIn('staff@example.com');

            const response = await assignRole(caller, target.id, 'user');

            expect(response.status).toBe(403);
            expect((await response.json()).message).toBe('Cannot modify superadmin role');
            expect(await storedRoleOf(target.id)).toBe(await roleId('superadmin'));
        });

        it('#23 superadmin restricted, caller a stored superadmin out of it: resolved as user, refused by the guard', async () =>
        {
            await seed('boss@gmail.test', 'superadmin');
            const target = await seed('member@gmail.test', 'user');
            const caller = await signIn('boss@gmail.test');
            setPolicy('superadmin=example.com');

            const response = await assignRole(caller, target.id, 'user');

            expect(response.status).toBe(403);
            expect(await errorCodeOf(response)).toBe('InsufficientRoleError');
        });

        it('#33 stored admin out of policy: minting an ops token is refused', async () =>
        {
            await seed('staff@gmail.test', 'admin');
            const caller = await signIn('staff@gmail.test');
            setPolicy('admin=example.com');

            const response = await call('POST', '/_auth/ops-tokens', caller, { name: 'laptop', scopes: ['*'] });

            expect(response.status).toBe(403);
        });
    });

    describe('boot', () =>
    {
        it('#24 malformed value: refuses, naming the variable and the entry', async () =>
        {
            for (const value of ['admin', '=example.com', 'admin=', 'admin=example.com,', 'admin=exa mple.com'])
            {
                setPolicy(value);
                await expect(assertRoleEmailDomainPolicy(), value).rejects.toThrow(POLICY_VAR);
            }
        });

        it('#25 user=example.com: refuses', async () =>
        {
            setPolicy('user=example.com');

            await expect(assertRoleEmailDomainPolicy()).rejects.toThrow("entry 'user=example.com'");
        });

        it('#26 unknown role name: refuses', async () =>
        {
            setPolicy('admni=example.com');

            await expect(assertRoleEmailDomainPolicy()).rejects.toThrow("'admni=example.com'");
        });

        it('#27 superadmin restricted, no superadmin account: starts', async () =>
        {
            setPolicy('superadmin=example.com');

            await expect(assertRoleEmailDomainPolicy()).resolves.toBeUndefined();
        });

        it('#28 superadmin restricted, every superadmin out of it: refuses without naming an email', async () =>
        {
            await seed('boss@gmail.test', 'superadmin');
            await seed('root@example.com', 'superadmin', { verified: false });
            setPolicy('superadmin=example.com');

            const refusal = assertRoleEmailDomainPolicy();

            await expect(refusal).rejects.toThrow("entry 'superadmin=example.com'");
            await expect(refusal).rejects.not.toThrow(/@/);
        });

        it('#29 superadmin restricted, one compliant superadmin among others: starts', async () =>
        {
            await seed('boss@gmail.test', 'superadmin');
            await seed('root@example.com', 'superadmin');
            setPolicy('superadmin=example.com');

            await expect(assertRoleEmailDomainPolicy()).resolves.toBeUndefined();
        });

        it('#30 ADMIN_ACCOUNTS seeds an out-of-domain superadmin: refuses, creates nothing', async () =>
        {
            setPolicy('superadmin=example.com');
            process.env.SPFN_AUTH_ADMIN_ACCOUNTS = JSON.stringify([
                { email: 'root@example.com', password: PASSWORD, role: 'superadmin' },
                { email: 'boss@gmail.test', password: PASSWORD, role: 'superadmin' },
            ]);

            const refusal = ensureAdminExists();

            await expect(refusal).rejects.toThrow("#2 (role 'superadmin')");
            await expect(refusal).rejects.not.toThrow(/gmail/);
            expect(await getTestDb().select().from(users)).toHaveLength(0);
        });
    });

    describe('reporting and remediation', () =>
    {
        async function seedMixed()
        {
            setPolicy('admin=example.com');

            return {
                outOfDomain: await seed('staff@gmail.test', 'admin'),
                unverified: await seed('new@example.com', 'admin', { verified: false }),
                compliant: await seed('staff@example.com', 'admin'),
                unrestricted: await seed('member@gmail.test', 'user', { verified: false }),
            };
        }

        it('#31 listRoleEmailDomainViolations: exactly the two violators, with reasons, no email', async () =>
        {
            const { outOfDomain, unverified } = await seedMixed();

            const violations = await listRoleEmailDomainViolations();

            expect(violations).toHaveLength(2);
            expect(violations).toEqual(expect.arrayContaining([
                { userId: outOfDomain.id, roleName: 'admin', reason: 'domain' },
                { userId: unverified.id, roleName: 'admin', reason: 'unverified' },
            ]));
        });

        it('#32 demoteRoleEmailDomainViolations: the two become user, compliant untouched, returns the two', async () =>
        {
            const { outOfDomain, unverified, compliant } = await seedMixed();

            const demoted = await demoteRoleEmailDomainViolations();

            expect(demoted.map(violation => violation.userId).sort()).toEqual([outOfDomain.id, unverified.id].sort());
            expect(await storedRoleOf(outOfDomain.id)).toBe(await roleId('user'));
            expect(await storedRoleOf(unverified.id)).toBe(await roleId('user'));
            expect(await storedRoleOf(compliant.id)).toBe(await roleId('admin'));
            expect(await listRoleEmailDomainViolations()).toEqual([]);
        });

        it('unset policy: nothing to list or demote', async () =>
        {
            await seed('staff@gmail.test', 'admin', { verified: false });

            expect(await listRoleEmailDomainViolations()).toEqual([]);
            expect(await demoteRoleEmailDomainViolations()).toEqual([]);
        });
    });
});
