/**
 * Many users' authority in one read (#479).
 *
 * `resolveAuthorities` answers `resolveAuthority` for a list of ids without a
 * statement per id. The rule is one function both call (`authorityFrom`), so
 * these rows guard what only the batch does: its read, how it keys the answer,
 * and how it reads the email-domain policy's fallback role.
 *
 * | Row | Checks                                                                                      | Unnoticed without it                         |
 * |-----|---------------------------------------------------------------------------------------------|----------------------------------------------|
 * | B1  | for role permissions, a grant, an expired grant, a revocation, an expired revocation, a     | the batch and the single read drifting apart |
 * |     | deactivated role, an inactive account, a missing id, a duplicate id (once as a string) and  |                                              |
 * |     | an account the policy resolves as `user`: the batch answer equals `resolveAuthority`        |                                              |
 * | B2  | the statements the batch sends for 1 account and for 50, policy-refused ones among them:    | a per-user loop, which passes every B1 row;  |
 * |     | the same two; for accounts the policy refuses none of: one; for an empty list: none         | a fallback read or a list read never needed  |
 * | B3  | `'abc'`, `NaN`, `1.5`, `1e20`, `2 ** 53` and `2n ** 53n + 1n`, alone and in a list with a   | an id beyond `MAX_SAFE_INTEGER` read and     |
 * |     | valid id: `resolveAuthority`, `resolveAuthorities`, `getStoredUserRole` and                 | keyed as another number; a bad id failing    |
 * |     | `getAuthSessionService` refuse each by name, before any statement                           | the list as a query error that names no id;  |
 * |     |                                                                                             | the session refusing the number it converted |
 * |     |                                                                                             | the id to, after a read of it                |
 * | B4  | a list with three active accounts the policy refuses, and a suspended one: one warning,      | one warning per refused account a call; a    |
 * |     | counting and naming the three; `resolveAuthority` on the suspended one alone: no warning     | suspended account counted, by the batch or   |
 * |     | and no statement after its read                                                             | the single read; the accounts refused left   |
 * |     |                                                                                             | out of the line                              |
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { permissions, roles, userPermissions, users } from '@/server/entities';
import type { UserStatus } from '@/server/types';
import type { Authority } from '@/server/services/permission.service';
import { authLogger } from '@/server/logger';

const { getDatabase } = await import('@spfn/core/db');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getStoredUserRole, resolveAuthorities, resolveAuthority } = await import('@/server/services/permission.service');
const { getAuthSessionService } = await import('@/server/services/auth-session.service');

const dbAvailable = await isDatabaseAvailable();

const POLICY_VAR = 'SPFN_AUTH_ROLE_EMAIL_DOMAINS';
const HOUR_MS = 3_600_000;

const CONFIG = {
    roles: [
        { name: 'editor', displayName: 'Editor', priority: 50 },
        { name: 'retired', displayName: 'Retired', priority: 20 },
    ],
    permissions: ['post:edit', 'report:read', 'report:export', 'audit:read'].map(name => ({ name, displayName: name })),
    rolePermissions: { editor: ['post:edit', 'report:read'], retired: ['audit:read'] },
};

async function idOf(table: typeof roles | typeof permissions, name: string): Promise<number>
{
    const [row] = await getTestDb().select({ id: table.id }).from(table).where(eq(table.name, name));

    return row.id;
}

async function seedUser(email: string, role: string, status: UserStatus = 'active'): Promise<number>
{
    const [row] = await getTestDb().insert(users)
        .values({ email, roleId: await idOf(roles, role), status, emailVerifiedAt: new Date() })
        .returning({ id: users.id });

    return row.id;
}

async function override(userId: number, permission: string, granted: boolean, expiresInMs: number | null): Promise<void>
{
    await getTestDb().insert(userPermissions).values({
        userId,
        permissionId: await idOf(permissions, permission),
        granted,
        expiresAt: expiresInMs === null ? null : new Date(Date.now() + expiresInMs),
    });
}

/** The data statements `read` sends to the primary, counted where postgres.js sends them. */
async function statementsOf(read: () => Promise<unknown>): Promise<number>
{
    const client = (getDatabase() as unknown as { $client: { options: { debug: unknown } } }).$client;
    const seen: string[] = [];
    const original = client.options.debug;
    client.options.debug = (_connection: number, query: string) => void seen.push(query);

    await read().finally(() =>
    {
        client.options.debug = original;
    });

    return seen.length;
}

/** The error `read` fails with, and the statements it sent before failing. */
async function refusalOf(read: () => Promise<unknown>): Promise<{ error: string; statements: number }>
{
    let error = 'none';
    const statements = await statementsOf(() => read().catch((caught: Error) =>
    {
        error = `${caught.name}: ${caught.message}`;
    }));

    return { error, statements };
}

describe.skipIf(!dbAvailable)('Many users\' authority in one read (#479)', () =>
{
    beforeAll(async () =>
    {
        await setupTestDb();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth(CONFIG);
        process.env[POLICY_VAR] = 'admin=example.com';
    });

    afterEach(() =>
    {
        delete process.env[POLICY_VAR];
        vi.restoreAllMocks();
    });

    it('B1 — the batch answer equals resolveAuthority for every case of the rule', async () =>
    {
        const cases: Record<string, number> = {
            rolePermissions: await seedUser('role@test.com', 'editor'),
            grant: await seedUser('grant@test.com', 'user'),
            expiredGrant: await seedUser('expired-grant@test.com', 'user'),
            revocation: await seedUser('revocation@test.com', 'editor'),
            expiredRevocation: await seedUser('expired-revocation@test.com', 'editor'),
            deactivatedRole: await seedUser('retired@test.com', 'retired'),
            inactiveAccount: await seedUser('suspended@test.com', 'editor', 'suspended'),
            policyRefused: await seedUser('admin@elsewhere.test', 'admin'),
        };
        await override(cases.grant, 'report:export', true, HOUR_MS);
        await override(cases.expiredGrant, 'report:export', true, -HOUR_MS);
        await override(cases.revocation, 'post:edit', false, null);
        await override(cases.expiredRevocation, 'post:edit', false, -HOUR_MS);
        await getTestDb().update(roles).set({ isActive: false }).where(eq(roles.name, 'retired'));
        const missing = Math.max(...Object.values(cases)) + 1000;

        const batch = await resolveAuthorities([...Object.values(cases), missing, cases.rolePermissions, String(cases.grant)]);

        // What the single read answers, so the fixture is known to reach each case.
        const single: Record<string, Authority> = Object.fromEntries(await Promise.all(Object.entries(cases).map(async ([name, id]) => [name, await resolveAuthority(id)])));
        const held = Object.entries(single).map(([name, authority]) => [name, [authority.role?.name ?? null, authority.permissions.map(permission => permission.name).sort()]]);
        expect(Object.fromEntries(held)).toEqual({
            rolePermissions: ['editor', ['post:edit', 'report:read']],
            grant: ['user', ['auth:self:manage', 'report:export']],
            expiredGrant: ['user', ['auth:self:manage']],
            revocation: ['editor', ['report:read']],
            expiredRevocation: ['editor', ['post:edit', 'report:read']],
            deactivatedRole: [null, []],
            inactiveAccount: [null, []],
            policyRefused: ['user', ['auth:self:manage']],
        });
        expect(single.grant.expiringPermissions.size).toBe(1);

        expect([...batch.keys()].sort((a, b) => a - b)).toEqual([...Object.values(cases), missing].sort((a, b) => a - b));
        for (const [name, id] of Object.entries(cases))
        {
            expect({ name, authority: batch.get(id) }).toEqual({ name, authority: single[name] });
        }
        expect(batch.get(missing)).toEqual(await resolveAuthority(missing));
    });

    it('B2 — the batch sends the same statements for 1 account and for 50, one when no one is refused, none for no id', async () =>
    {
        const refused = await seedUser('admin-0@elsewhere.test', 'admin');
        const adminRole = await idOf(roles, 'admin');
        const others = await getTestDb().insert(users)
            .values(Array.from({ length: 49 }, (_, index) => ({
                email: `member-${index}@${index % 2 === 0 ? 'elsewhere.test' : 'example.com'}`,
                roleId: adminRole,
                emailVerifiedAt: new Date(),
            })))
            .returning({ id: users.id });

        const allowed = others.filter((_, index) => index % 2 === 1).map(row => row.id);

        const one = await statementsOf(() => resolveAuthorities([refused]));
        const fifty = await statementsOf(() => resolveAuthorities([refused, ...others.map(row => row.id)]));
        const noneRefused = await statementsOf(() => resolveAuthorities(allowed));
        const empty = await statementsOf(() => resolveAuthorities([]));

        // One read of the accounts, one of the fallback role the policy puts the refused ones in;
        // no fallback read when the policy refuses no one, and no read of an empty list.
        expect({ one, fifty, noneRefused, empty }).toEqual({ one: 2, fifty: 2, noneRefused: 1, empty: 0 });
    });

    it('B3 — an id that is not a user id is refused by name, before any statement, on every read', async () =>
    {
        const valid = await seedUser('role@test.com', 'editor');
        const bad: Array<string | number | bigint> = ['abc', Number.NaN, 1.5, 1e20, 2 ** 53, 2n ** 53n + 1n];

        // One at a time: `statementsOf` counts on the one client the reads share.
        const refusals = [];
        for (const id of bad)
        {
            refusals.push({
                id: String(id),
                single: await refusalOf(() => resolveAuthority(id)),
                batch: await refusalOf(() => resolveAuthorities([valid, id])),
                stored: await refusalOf(() => getStoredUserRole(id)),
                session: await refusalOf(() => getAuthSessionService(id)),
            });
        }

        expect(refusals).toEqual(bad.map(id =>
        {
            const refusal = { error: `BadRequestError: Not a user id: '${String(id)}'`, statements: 0 };

            return { id: String(id), single: refusal, batch: refusal, stored: refusal, session: refusal };
        }));
    });

    it('B4 — one policy warning a call, counting and naming the accounts refused; none for a suspended one', async () =>
    {
        const refused = [
            await seedUser('admin-a@elsewhere.test', 'admin'),
            await seedUser('admin-b@elsewhere.test', 'admin'),
            await seedUser('admin-c@elsewhere.test', 'admin'),
        ];
        const allowed = await seedUser('admin-d@example.com', 'admin');
        const suspended = await seedUser('admin-e@elsewhere.test', 'admin', 'suspended');
        const warn = vi.spyOn(authLogger.service, 'warn');

        await resolveAuthorities([...refused, allowed, suspended]);

        // The accounts in the order the read found them, which the warning does not promise.
        const contexts = warn.mock.calls
            .map(([, context]) => context as { userIds: number[] })
            .map(context => ({ ...context, userIds: [...context.userIds].sort((a, b) => a - b) }));
        expect(contexts).toEqual([
            { reason: 'role_email_domain_policy', count: 3, storedRoles: ['admin'], userIds: refused },
        ]);

        // The single read filters as the batch does: a suspended account holds nothing, so the
        // policy has nothing to refuse it — no warning, and no read of the fallback role.
        warn.mockClear();
        expect(await statementsOf(() => resolveAuthority(suspended))).toBe(1);
        expect(warn).not.toHaveBeenCalled();
    });
});
