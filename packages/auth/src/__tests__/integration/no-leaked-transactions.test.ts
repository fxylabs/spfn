/**
 * @spfn/auth - no row leaves a connection inside a transaction
 *
 * `clearTables` TRUNCATEs, and a TRUNCATE needs ACCESS EXCLUSIVE on the table:
 * one connection still inside a transaction on it makes the TRUNCATE wait, and
 * for as long as that transaction lives the row that asked for the TRUNCATE is
 * simply stopped. CI runs #284 and #289 are what that looks like from outside —
 * a suite that stopped producing output between two rows, the last lines being
 * the TRUNCATE notices of the row before, and nothing naming a cause. The
 * helper's connections now carry a `lock_timeout`, so the same leak says
 * `canceling statement due to lock timeout` instead of nothing; this file is the
 * other half, and refuses to let a leak reach the next row at all.
 *
 * It asks the server, not the application, and it asks after the two shapes best
 * able to leave something behind: an authenticated request, whose
 * `updateLastUsedById` write is deliberately never awaited, and a route whose
 * handler opens a transaction and then rolls it back. Neither may leave a
 * backend `idle in transaction` once the response has been read.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Hono } from 'hono';
import { sql } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { mountAuthApp } from '../helpers/oauth2';
import { users } from '@/server/entities';
import { generateClientToken, generateKeyPair } from '@/server/lib/crypto';
import { hashPassword } from '@/server/helpers/password';

const { resetMemoryRateLimitStore } = await import('@spfn/core/middleware');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { getRoleByName } = await import('@/server/services/role.service');

const dbAvailable = await isDatabaseAvailable();

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PASSWORD = 'SecurePassword123!';

/** One row of `pg_stat_activity`, as much of it as the failure message needs. */
interface OpenTransaction
{
    pid: number;
    state: string;
    query: string;
}

describe.skipIf(!dbAvailable)('no row leaves a connection inside a transaction', () =>
{
    let app: Hono;

    beforeAll(async () =>
    {
        await setupTestDb();
        process.env.SPFN_AUTH_SESSION_SECRET = 'test-secret-key-for-testing-only-min-32-chars';

        app = await mountAuthApp();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        resetMemoryRateLimitStore();
        await initializeAuth();

        const userRole = await getRoleByName('user');
        await getTestDb().insert(users).values({
            email: 'owner@test.com',
            passwordHash: await hashPassword(PASSWORD),
            emailVerifiedAt: new Date(),
            roleId: userRole!.id,
        });
    });

    function post(path: string, body: unknown, authorization?: string)
    {
        const headers: Record<string, string> = { ...JSON_HEADERS };

        if (authorization)
        {
            headers.Authorization = authorization;
        }

        return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    }

    /** The new key pair a signing client would have generated. */
    function keyBody()
    {
        const key = generateKeyPair('ES256');

        return {
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        };
    }

    async function signIn(email: string): Promise<string>
    {
        const key = generateKeyPair('ES256');
        const response = await post('/_auth/login', {
            email,
            password: PASSWORD,
            publicKey: key.publicKey,
            keyId: key.keyId,
            fingerprint: key.fingerprint,
            algorithm: key.algorithm,
        });

        expect(response.status).toBe(200);

        return `Bearer ${generateClientToken({ keyId: key.keyId }, key.privateKey, 'ES256', { expiresIn: '5m' })}`;
    }

    /**
     * Every backend on this database, other than the one asking, sitting inside a
     * transaction with no statement running.
     *
     * That is the one state a TRUNCATE cannot get past and a statement timeout
     * cannot end, which is why it is the state asserted on. A backend that is
     * mid-statement is not one of these: it will finish and release.
     */
    async function openTransactions(): Promise<OpenTransaction[]>
    {
        const rows = await getTestDb().execute(sql`
            SELECT pid, state, left(regexp_replace(query, '\s+', ' ', 'g'), 200) AS query
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND pid <> pg_backend_pid()
              AND state LIKE 'idle in transaction%'
        `);

        return rows as unknown as OpenTransaction[];
    }

    it('an authenticated request, whose last-used write is never awaited', async () =>
    {
        const authorization = await signIn('owner@test.com');

        expect((await post('/_auth/keys/list', {}, authorization)).status).toBe(200);

        expect(await openTransactions()).toEqual([]);
    });

    it('a transactional route that rolls back', async () =>
    {
        await getTestDb().update(users).set({ status: 'inactive' });

        const response = await post('/_auth/login', {
            email: 'owner@test.com',
            password: PASSWORD,
            ...keyBody(),
        });

        expect(response.status).toBe(403);
        expect((await response.json()).__type).toBe('AccountDisabledError');

        expect(await openTransactions()).toEqual([]);
    });
});
