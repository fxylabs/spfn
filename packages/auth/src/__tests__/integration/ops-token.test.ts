/**
 * @spfn/auth - Ops Token Integration Tests
 *
 * The design-time case table, asserted 1:1 over a real ops surface
 * (createOpsRouter + opsTokenAuth + requireOpsScope) against the test
 * database:
 *
 *   token \ scope     sufficient   insufficient
 *   valid             200          403
 *   expired           401          401
 *   revoked           401          401
 *   unknown           401          401
 *   missing           401          401
 *
 * Plus: '*' grants every scope; expired/revoked/unknown share one refusal
 * message; the manifest requires a token; issuance stores only the hash.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { Type } from '@sinclair/typebox';

import { createOpsRouter, opsRoute } from '@spfn/core/ops';
import { registerRoutes } from '@spfn/core/route';

import { opsTokenAuth, requireOpsScope } from '@/server/middleware/ops-token-auth';
import {
    issueOpsTokenService,
    listOpsTokensService,
    revokeOpsTokenService,
    verifyOpsTokenService,
} from '@/server/services/ops-token.service';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';

const dbAvailable = await isDatabaseAvailable();

function buildOpsApp(): Hono
{
    const opsRouter = createOpsRouter({
        listSignups: opsRoute.get('/signups')
            .use([requireOpsScope('waitlist:read')])
            .handler(async () => ({ items: ['a'] })),
        exportSignups: opsRoute.post('/signups/export')
            .use([requireOpsScope('waitlist:read', 'waitlist:export')])
            .input({ body: Type.Object({ format: Type.String() }) })
            .handler(async (c) => ({ format: (await c.data()).body.format })),
    }, { auth: opsTokenAuth });

    const app = new Hono();
    app.onError((err, c) =>
    {
        if ('statusCode' in err && typeof err.statusCode === 'number')
        {
            return c.json({ error: err.message }, err.statusCode as never);
        }

        return c.json({ error: err.message }, 500);
    });
    registerRoutes(app, opsRouter);

    return app;
}

async function refusalMessage(app: Hono, token: string | null): Promise<{ status: number; error: string }>
{
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
    const res = await app.request('/_ops/signups', { headers });
    const body = await res.json() as { error: string };

    return { status: res.status, error: body.error };
}

describe.skipIf(!dbAvailable)('Ops tokens', () =>
{
    let app: Hono;

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
        app = buildOpsApp();
    });

    describe('case table', () =>
    {
        it('valid token + sufficient scope → 200', async () =>
        {
            const { token } = await issueOpsTokenService('t', ['waitlist:read'], null);
            const res = await app.request('/_ops/signups', {
                headers: { Authorization: `Bearer ${token}` },
            });

            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ items: ['a'] });
        });

        it('valid token + insufficient scope → 403 naming the missing scope', async () =>
        {
            const { token } = await issueOpsTokenService('t', ['waitlist:read'], null);
            const res = await app.request('/_ops/signups/export', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ format: 'csv' }),
            });

            expect(res.status).toBe(403);
            const body = await res.json() as { error: string };
            expect(body.error).toContain('waitlist:export');
            expect(body.error).not.toContain('waitlist:read');
        });

        it('expired token → 401', async () =>
        {
            const { token } = await issueOpsTokenService('t', ['waitlist:read'], new Date(Date.now() - 1000));

            expect((await refusalMessage(app, token)).status).toBe(401);
        });

        it('revoked token → 401 regardless of scope', async () =>
        {
            const { token, record } = await issueOpsTokenService('t', ['*'], null);
            await revokeOpsTokenService(record.id);

            expect((await refusalMessage(app, token)).status).toBe(401);
        });

        it('unknown token → 401', async () =>
        {
            const forged = 'spfn_ops_' + '0'.repeat(64);

            expect((await refusalMessage(app, forged)).status).toBe(401);
        });

        it('missing token → 401', async () =>
        {
            expect((await refusalMessage(app, null)).status).toBe(401);
        });

        it('expired, revoked, and unknown share one refusal message', async () =>
        {
            const expired = await issueOpsTokenService('e', ['*'], new Date(Date.now() - 1000));
            const revoked = await issueOpsTokenService('r', ['*'], null);
            await revokeOpsTokenService(revoked.record.id);

            const messages = new Set([
                (await refusalMessage(app, expired.token)).error,
                (await refusalMessage(app, revoked.token)).error,
                (await refusalMessage(app, 'spfn_ops_' + '0'.repeat(64))).error,
            ]);

            expect(messages.size).toBe(1);
        });
    });

    describe('scopes', () =>
    {
        it("'*' grants every scope", async () =>
        {
            const { token } = await issueOpsTokenService('root', ['*'], null);
            const res = await app.request('/_ops/signups', {
                headers: { Authorization: `Bearer ${token}` },
            });

            expect(res.status).toBe(200);
        });

        it('refuses issuance with no scopes', async () =>
        {
            await expect(issueOpsTokenService('t', [], null)).rejects.toThrow(/at least one scope/);
        });
    });

    describe('manifest', () =>
    {
        it('answers command discovery to a valid token only', async () =>
        {
            const { token } = await issueOpsTokenService('t', ['waitlist:read'], null);

            const unauthenticated = await app.request('/_ops/_manifest');
            expect(unauthenticated.status).toBe(401);

            const res = await app.request('/_ops/_manifest', {
                headers: { Authorization: `Bearer ${token}` },
            });
            expect(res.status).toBe(200);
            const manifest = await res.json() as { manifestVersion: number; commands: { name: string }[] };
            expect(manifest.manifestVersion).toBe(1);
            expect(manifest.commands.map(c => c.name)).toEqual(['exportSignups', 'listSignups']);
        });
    });

    describe('issuance and lifecycle', () =>
    {
        it('stores only the hash and returns the secret once', async () =>
        {
            const { token, record } = await issueOpsTokenService('t', ['waitlist:read'], null);

            expect(token).toMatch(/^spfn_ops_[0-9a-f]{64}$/);
            expect(record.tokenHash).not.toBe(token);
            expect(record.tokenHash).toMatch(/^[0-9a-f]{64}$/);

            const listed = await listOpsTokensService();
            expect(listed).toHaveLength(1);
            expect(JSON.stringify(listed)).not.toContain(token);
        });

        it('revocation is permanent and never overwrites the first timestamp', async () =>
        {
            const { record } = await issueOpsTokenService('t', ['*'], null);

            const first = await revokeOpsTokenService(record.id);
            expect(first?.revokedAt).toBeInstanceOf(Date);

            const second = await revokeOpsTokenService(record.id);
            expect(second).toBeNull();

            const listed = await listOpsTokensService();
            expect(listed[0]!.revokedAt?.getTime()).toBe(first!.revokedAt!.getTime());
        });

        it('verification answers null without touching lastUsedAt for a refused token', async () =>
        {
            const forged = 'spfn_ops_' + 'f'.repeat(64);

            expect(await verifyOpsTokenService(forged)).toBeNull();
            expect(await verifyOpsTokenService('not-even-prefixed')).toBeNull();
        });
    });
});
