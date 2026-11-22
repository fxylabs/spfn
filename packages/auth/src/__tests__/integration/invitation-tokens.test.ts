/**
 * @spfn/auth - Invitation tokens are bearer credentials (w-etq2g, rows T1–T5, T7–T12)
 *
 * An invitation token makes whoever holds it the invitee, yet it was stored in
 * plaintext and answered by `GET /_auth/invitations` to anyone holding
 * `user:read` — so an admin could read a pending superadmin invitation's token
 * and accept it (audit au1-A1 / au4-A1). Only the token's hash is stored now,
 * the list declares its shape, resend mints a new token, and resend and cancel
 * take the authority create takes. Accept, resend and cancel are each one
 * conditional statement, so a transition another request already made is
 * refused rather than overwritten (T7–T10).
 *
 * Driven through the mounted auth router, the way a server mounts it. T6, the
 * guard over every route's response, is unit/route-response-secrets.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { authMigrations } from '../helpers/migrations';
import { JSON_HEADERS, TEST_PASSWORD, createTestUser, mountAuthApp, resetMemoryRateLimitStore, signIn } from '../helpers/oauth2';
import { userInvitations, users } from '@/server/entities';
import { generateKeyPair } from '@/server/lib/crypto';
import { hashCredential } from '@/server/lib/link-credentials';

const { runInTransaction } = await import('@spfn/core/db');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');
const { acceptInvitation, cancelInvitation, createInvitation, resendInvitation } = await import('@/server/services/invitation.service');
const { BadRequestError } = await import('@spfn/core/errors');

const dbAvailable = await isDatabaseAvailable();

const LEGACY_TOKEN = '55555555-5555-4555-8555-555555555555';
const BETWEEN_MIGRATIONS_TOKEN = '66666666-6666-4666-8666-666666666666';

/**
 * The statements of the two migrations that move the table from `token` to
 * `token_hash`, in order, read from the migrations themselves so the rows
 * below are upgraded exactly as a deployed database is.
 */
function tokenHashMigrations(): string[][]
{
    const migrations = authMigrations()
        .map((migration) => migration.statements)
        .filter((statements) => statements.some((statement) => statement.includes('"user_invitations"'))
            && statements.some((statement) => statement.includes('"token_hash"')));

    expect(migrations).toHaveLength(2);

    return migrations;
}

/** Every key, at any depth, of a JSON value. */
function keysOf(value: unknown): string[]
{
    if (Array.isArray(value))
    {
        return value.flatMap(keysOf);
    }

    if (value && typeof value === 'object')
    {
        return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
    }

    return [];
}

/** Every string, at any depth, of a JSON value. */
function stringsOf(value: unknown): string[]
{
    if (typeof value === 'string')
    {
        return [value];
    }

    if (value && typeof value === 'object')
    {
        return Object.values(value).flatMap(stringsOf);
    }

    return [];
}

describe.skipIf(!dbAvailable)('Invitation tokens are bearer credentials (w-etq2g)', () =>
{
    let app: Hono;
    let ipCounter = 0;

    beforeAll(async () =>
    {
        await setupTestDb();
        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        resetMemoryRateLimitStore();
        vi.stubEnv('SPFN_API_URL', 'http://api.invitations.test');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    // ========================================================================
    // Driving the router
    // ========================================================================

    function nextIp(): string
    {
        ipCounter += 1;

        return `198.51.100.${ipCounter % 250 + 1}`;
    }

    function call(method: string, urlPath: string, body?: unknown, authorization?: string): Promise<Response>
    {
        const headers: Record<string, string> = { ...JSON_HEADERS, 'x-forwarded-for': nextIp() };

        if (authorization)
        {
            headers.Authorization = authorization;
        }

        return Promise.resolve(app.request(urlPath, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        }));
    }

    async function roleId(name: 'superadmin' | 'admin' | 'user'): Promise<number>
    {
        return (await getRoleByName(name))!.id;
    }

    /** A signed-in account holding the role. */
    async function caller(role: 'superadmin' | 'admin'): Promise<string>
    {
        const email = `${role}-${ipCounter}@invitations.test`;

        await createTestUser(email, await roleId(role));

        return await signIn(app, email, nextIp());
    }

    async function invite(
        authorization: string,
        email: string,
        role: 'admin' | 'user',
    ): Promise<{ id: number; token: string }>
    {
        const response = await call('POST', '/_auth/invitations', { email, roleId: await roleId(role) }, authorization);

        expect(response.status, await response.clone().text()).toBe(200);

        return await response.json();
    }

    function accept(token: string): Promise<Response>
    {
        const key = generateKeyPair('ES256');

        return call('POST', '/_auth/invitations/accept', {
            token,
            password: TEST_PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });
    }

    async function accountRole(email: string): Promise<number | undefined>
    {
        const [row] = await getTestDb().select({ roleId: users.roleId }).from(users).where(eq(users.email, email));

        return row?.roleId;
    }

    async function invitationRow(id: number)
    {
        const [row] = await getTestDb().select().from(userInvitations).where(eq(userInvitations.id, id));

        return row;
    }

    // ========================================================================
    // T1 / T2 — the list
    // ========================================================================

    it('T1: a user:read account lists invitations and gets no token and no hash', async () =>
    {
        const { token } = await invite(await caller('superadmin'), 'listed@invitations.test', 'user');
        const admin = await caller('admin');

        const response = await call('GET', '/_auth/invitations', undefined, admin);
        const text = await response.text();

        expect(response.status, text).toBe(200);
        expect(JSON.parse(text).invitations).toHaveLength(1);
        expect(keysOf(JSON.parse(text))).not.toContain('token');
        expect(keysOf(JSON.parse(text))).not.toContain('tokenHash');
        expect(text).not.toContain(token);
        expect(text).not.toContain(hashCredential(token));
    });

    it('T2: an admin cannot accept a pending admin invitation with anything the list answered', async () =>
    {
        // An admin invitation is the most a caller can make (only a superadmin outranks admin)
        await invite(await caller('superadmin'), 'newroot@invitations.test', 'admin');
        const admin = await caller('admin');

        const listed = await call('GET', '/_auth/invitations', undefined, admin);
        expect(listed.status).toBe(200);
        const candidates = stringsOf(await listed.json()).filter((value) => value.length >= 16);

        expect(candidates.length).toBeGreaterThan(0);

        for (const candidate of candidates)
        {
            expect((await accept(candidate)).status).toBe(404);
        }
        expect(await accountRole('newroot@invitations.test')).toBeUndefined();
    });

    // ========================================================================
    // T3 — a link mailed before the migration
    // ========================================================================

    it('T3: invitations stored before and between the two migrations are accepted with their old links', async () =>
    {
        const inviter = await createTestUser('inviter@invitations.test', await roleId('superadmin'));
        const db = getTestDb();
        const [introduceHash, dropToken] = tokenHashMigrations();

        async function storeLegacy(email: string, token: string): Promise<void>
        {
            await db.execute(sql`INSERT INTO "spfn_auth"."user_invitations"
                ("email", "token", "role_id", "invited_by_id", "status", "expires_at")
                VALUES (${email}, ${token}, ${await roleId('user')}, ${inviter}, 'pending', now() + interval '1 day')`);
        }

        // The table as it was before both: a plaintext `token`, no hash.
        await db.execute(sql`ALTER TABLE "spfn_auth"."user_invitations" DROP COLUMN "token_hash"`);
        await db.execute(sql`ALTER TABLE "spfn_auth"."user_invitations" ADD COLUMN "token" text NOT NULL`);
        await db.execute(sql`ALTER TABLE "spfn_auth"."user_invitations"
            ADD CONSTRAINT "user_invitations_token_unique" UNIQUE("token")`);
        await db.execute(sql`CREATE INDEX "invitations_token_idx" ON "spfn_auth"."user_invitations" ("token")`);

        await storeLegacy('legacy@invitations.test', LEGACY_TOKEN);
        for (const statement of introduceHash!)
        {
            await db.execute(sql.raw(statement));
        }
        // Written by a server still on the previous release, which knows no hash.
        await storeLegacy('between@invitations.test', BETWEEN_MIGRATIONS_TOKEN);
        for (const statement of dropToken!)
        {
            await db.execute(sql.raw(statement));
        }

        for (const [email, token] of [['legacy@invitations.test', LEGACY_TOKEN], ['between@invitations.test', BETWEEN_MIGRATIONS_TOKEN]])
        {
            const response = await accept(token!);

            expect(response.status, await response.clone().text()).toBe(200);
            expect(await accountRole(email!)).toBe(await roleId('user'));
        }
    });

    // ========================================================================
    // T4 — resend
    // ========================================================================

    it('T4: after a resend of an expired invitation the old token is refused and the new one accepted', async () =>
    {
        const superadmin = await caller('superadmin');
        const { id, token: oldToken } = await invite(superadmin, 'resent@invitations.test', 'user');
        await getTestDb().update(userInvitations)
            .set({ status: 'expired', expiresAt: new Date(Date.now() - 1000) })
            .where(eq(userInvitations.id, id));

        const resent = await call('POST', '/_auth/invitations/resend', { id }, superadmin);
        expect(resent.status, await resent.clone().text()).toBe(200);
        const { token: newToken } = await resent.json();

        expect(newToken).not.toBe(oldToken);
        expect((await accept(oldToken)).status).toBe(404);
        expect(await accountRole('resent@invitations.test')).toBeUndefined();
        expect((await accept(newToken)).status).toBe(200);
        expect(await accountRole('resent@invitations.test')).toBe(await roleId('user'));
    });

    // ========================================================================
    // T5 — resend and cancel take the authority create takes
    // ========================================================================

    it('T5: an admin resending or cancelling an admin invitation (a role they do not outrank) gets 403 and changes nothing', async () =>
    {
        const { id } = await invite(await caller('superadmin'), 'root2@invitations.test', 'admin');
        const admin = await caller('admin');
        const before = await invitationRow(id);

        expect((await call('POST', '/_auth/invitations/resend', { id }, admin)).status).toBe(403);
        expect((await call('POST', '/_auth/invitations/cancel', { id }, admin)).status).toBe(403);
        expect(await invitationRow(id)).toEqual(before);
    });

    it('T5: an admin resends and cancels an invitation to a role they can assign', async () =>
    {
        const { id } = await invite(await caller('superadmin'), 'member@invitations.test', 'user');
        const admin = await caller('admin');

        expect((await call('POST', '/_auth/invitations/resend', { id }, admin)).status).toBe(200);
        expect((await call('POST', '/_auth/invitations/cancel', { id }, admin)).status).toBe(200);
        expect((await invitationRow(id))!.status).toBe('cancelled');
    });

    // ========================================================================
    // T7–T9 — a transition another request already made is refused
    // ========================================================================

    /**
     * Run `work` in a transaction left open until `commit` is called, so a
     * request started meanwhile meets its row locks.
     */
    async function heldOpen<T>(work: () => Promise<T>): Promise<{ result: T; commit: () => Promise<void> }>
    {
        const worked = gate();
        const release = gate();
        let result!: T;
        const transaction = runInTransaction(async () =>
        {
            result = await work();
            worked.open();
            await release.passed;
        });

        await Promise.race([worked.passed, transaction]);

        return {
            result,
            commit: async () =>
            {
                release.open();
                await transaction;
            },
        };
    }

    /** A point work waits at until `open` is called. */
    function gate(): { passed: Promise<void>; open: () => void }
    {
        let open!: () => void;
        const passed = new Promise<void>((resolve) =>
        {
            open = resolve;
        });

        return { passed, open };
    }

    /** Resolves once `count` statements of this database wait for a row lock. */
    async function lockWaiters(count: number): Promise<void>
    {
        await expect.poll(async () =>
        {
            const rows = await getTestDb().execute(sql`SELECT count(*)::int AS waiting FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'`);

            return (rows as unknown as Array<{ waiting: number }>)[0]!.waiting;
        }, { timeout: 10_000, interval: 20 }).toBeGreaterThanOrEqual(count);
    }

    it('T7: an acceptance in flight with the old token when a resend commits is refused and creates no account', async () =>
    {
        const inviter = await createTestUser('inviter7@invitations.test', await roleId('superadmin'));
        const { id, token: oldToken } = await invite(await signIn(app, 'inviter7@invitations.test', nextIp()), 'raced7@invitations.test', 'user');
        const resend = await heldOpen(() => resendInvitation({ id, resentBy: inviter }));

        const accepting = accept(oldToken);
        await lockWaiters(1);
        await resend.commit();

        expect((await accepting).status).toBe(404);
        expect(await accountRole('raced7@invitations.test')).toBeUndefined();
        expect((await accept(resend.result.token)).status).toBe(200);
    });

    it('T8: an acceptance in flight when a cancel commits is refused and creates no account', async () =>
    {
        const inviter = await createTestUser('inviter8@invitations.test', await roleId('superadmin'));
        const { id, token } = await invite(await signIn(app, 'inviter8@invitations.test', nextIp()), 'raced8@invitations.test', 'user');
        const cancel = await heldOpen(() => cancelInvitation(id, inviter));

        const accepting = accept(token);
        await lockWaiters(1);
        await cancel.commit();

        expect((await accepting).status).toBe(410);
        expect(await accountRole('raced8@invitations.test')).toBeUndefined();
        expect((await invitationRow(id))!.status).toBe('cancelled');
    });

    it('T9: of two concurrent resends exactly one answers 200, and its token is the one that works', async () =>
    {
        const superadmin = await caller('superadmin');
        const { id } = await invite(superadmin, 'twice@invitations.test', 'user');

        // A row lock, on a connection of its own, that both resends queue
        // behind after reading the same state.
        const locked = gate();
        const release = gate();
        const holder = getTestDb().transaction(async (tx) =>
        {
            await tx.execute(sql`SELECT 1 FROM "spfn_auth"."user_invitations" WHERE "id" = ${id} FOR UPDATE`);
            locked.open();
            await release.passed;
        });
        await locked.passed;

        const resending = [1, 2].map(() => call('POST', '/_auth/invitations/resend', { id }, superadmin));
        await lockWaiters(2);
        release.open();
        await holder;
        const responses = await Promise.all(resending);

        expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
        const { token } = await responses.find((response) => response.status === 200)!.json();
        expect((await accept(token)).status).toBe(200);
        expect(await accountRole('twice@invitations.test')).toBe(await roleId('user'));
    });

    it('T10: a cancel in flight when an acceptance commits answers 409 and the invitation stays accepted', async () =>
    {
        const superadmin = await caller('superadmin');
        const { id, token } = await invite(superadmin, 'accepted10@invitations.test', 'user');
        const key = generateKeyPair('ES256');
        const acceptance = await heldOpen(() => acceptInvitation({ token, password: TEST_PASSWORD, ...key }));

        const cancelling = call('POST', '/_auth/invitations/cancel', { id }, superadmin);
        await lockWaiters(1);
        await acceptance.commit();

        expect((await cancelling).status).toBe(409);
        expect((await invitationRow(id))!.status).toBe('accepted');
        expect(await accountRole('accepted10@invitations.test')).toBe(await roleId('user'));
    });

    it('T11: resendInvitation refuses an expiresInDays beyond the bound create has, and changes nothing', async () =>
    {
        const inviter = await createTestUser('inviter11@invitations.test', await roleId('superadmin'));
        const { id } = await invite(await signIn(app, 'inviter11@invitations.test', nextIp()), 'far@invitations.test', 'user');
        const before = await invitationRow(id);

        await expect(resendInvitation({ id, resentBy: inviter, expiresInDays: 31 })).rejects.toBeInstanceOf(BadRequestError);
        expect(await invitationRow(id)).toEqual(before);
    });

    it('T12: an acceptance refused after its claim, outside any caller transaction, leaves the invitation pending', async () =>
    {
        const { id, token } = await invite(await caller('superadmin'), 'taken@invitations.test', 'user');
        // The address got an account another way after the invitation was sent.
        await createTestUser('taken@invitations.test', await roleId('user'));
        const key = generateKeyPair('ES256');

        await expect(acceptInvitation({ token, password: TEST_PASSWORD, ...key })).rejects.toThrow();
        expect((await invitationRow(id))!.status).toBe('pending');
    });
    it('T13: create refuses non-object metadata, and cancel leaves a legacy non-object metadata an object', async () =>
    {
        const inviter = await createTestUser('inviter13@invitations.test', await roleId('superadmin'));
        const authorization = await signIn(app, 'inviter13@invitations.test', nextIp());
        const body = { email: 'array13@invitations.test', roleId: await roleId('user'), metadata: ['welcome'] };

        expect((await call('POST', '/_auth/invitations', body, authorization)).status).toBe(400);
        await expect(createInvitation({ ...body, invitedBy: inviter, metadata: ['welcome'] as unknown as Record<string, unknown> }))
            .rejects.toBeInstanceOf(BadRequestError);
        expect(await getTestDb().select().from(userInvitations)).toEqual([]);

        // A row stored before create refused it, as an older release let it.
        const { id } = await invite(authorization, 'legacy13@invitations.test', 'user');
        await getTestDb().update(userInvitations).set({ metadata: sql`'["welcome"]'::jsonb` }).where(eq(userInvitations.id, id));

        expect((await call('POST', '/_auth/invitations/cancel', { id, reason: 'left' }, authorization)).status).toBe(200);
        expect((await invitationRow(id))!.metadata)
            .toEqual({ legacyMetadata: ['welcome'], cancelReason: 'left', cancelledBy: inviter });
    });
});
