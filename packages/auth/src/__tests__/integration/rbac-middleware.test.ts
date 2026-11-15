/**
 * @spfn/auth - RBAC Middleware Integration Tests
 *
 * Tests for requirePermissions, requireAnyPermission, requireRole middleware
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { initializeAuth } from '@/server/services/rbac.service';
import { getRoleByName } from '@/server/services/role.service';
import { requirePermissions, requireAnyPermission } from '@/server/middleware/require-permission';
import { requireRole } from '@/server/middleware/require-role';
import { users } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { Hono } from 'hono';
import { getDatabase } from '@spfn/core/db';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';

// Check if database is available before running tests
const dbAvailable = await isDatabaseAvailable();

describe.skipIf(!dbAvailable)('RBAC Middleware', () =>
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
        const db = getTestDb();
        await clearTables(db);

        // Initialize RBAC
        await initializeAuth({
            permissions: [
                { name: 'post:create', displayName: 'Create Posts' },
                { name: 'post:publish', displayName: 'Publish Posts' },
                { name: 'post:delete', displayName: 'Delete Posts' },
            ],
        });

        // Create test users with different roles
        const userRole = await getRoleByName('user');
        const adminRole = await getRoleByName('admin');
        const superadminRole = await getRoleByName('superadmin');

        await db.insert(users).values({
            email: 'user@test.com',
            passwordHash: await hashPassword('password'),
            roleId: userRole!.id,
            emailVerifiedAt: new Date(),
        });

        await db.insert(users).values({
            email: 'admin@test.com',
            passwordHash: await hashPassword('password'),
            roleId: adminRole!.id,
            emailVerifiedAt: new Date(),
        });

        await db.insert(users).values({
            email: 'superadmin@test.com',
            passwordHash: await hashPassword('password'),
            roleId: superadminRole!.id,
            emailVerifiedAt: new Date(),
        });

        // Setup Hono app
        app = new Hono();

        // Add error handler
        app.onError((err, c) =>
        {
            if ('statusCode' in err && typeof err.statusCode === 'number')
            {
                return c.json({ error: err.message }, err.statusCode as any);
            }

            return c.json({ error: 'Internal Server Error' }, 500);
        });
    });

    describe('requirePermissions()', () =>
    {
        it('should allow access when user has required permission', async () =>
        {

            const db = getDatabase()!;
            const [superadmin] = await db.select().from(users).where(eq(users.email, 'superadmin@test.com')).limit(1);

            // Setup route
            app.get('/admin-only',
                async (c: Context, next) =>
                {
                    // Mock authenticate middleware
                    c.set('auth', { user: superadmin, userId: String(superadmin.id), keyId: 'test-key', role: null, locale: 'en', scheme: 'bearer' } as never);
                    await next();
                },
                requirePermissions('user:read'),
                (c) => c.json({ success: true }),
            );

            const res = await app.request('/admin-only');

            expect(res.status).toBe(200);
            const body = await res.json();
            expect(body.success).toBe(true);
        });

        it('should deny access when user lacks required permission', async () =>
        {
            // Get user ID from database
            const db = getDatabase()!;
            const [user] = await db.select().from(users).where(eq(users.email, 'user@test.com')).limit(1);

            app.get('/admin-only',
                async (c: Context, next) =>
                {
                    c.set('auth', { user: user, userId: String(user.id), keyId: 'test-key', role: null, locale: 'en', scheme: 'bearer' } as never);
                    await next();
                },
                requirePermissions('user:delete'), // user role doesn't have this
                (c) => c.json({ success: true }),
            );

            const res = await app.request('/admin-only');

            expect(res.status).toBe(403);
        });

        it('should require all permissions when multiple specified', async () =>
        {
            const db = getDatabase()!;
            const [admin] = await db.select().from(users).where(eq(users.email, 'admin@test.com')).limit(1);

            app.get('/protected',
                async (c: Context, next) =>
                {
                    c.set('auth', { user: admin, userId: String(admin.id), keyId: 'test-key', role: null, locale: 'en', scheme: 'bearer' } as never);
                    await next();
                },
                requirePermissions('user:read', 'user:write'), // admin has both
                (c) => c.json({ success: true }),
            );

            const res = await app.request('/protected');
            expect(res.status).toBe(200);
        });

        it('should deny if user missing one of multiple required permissions', async () =>
        {
            const db = getDatabase()!;
            const [admin] = await db.select().from(users).where(eq(users.email, 'admin@test.com')).limit(1);

            app.get('/protected',
                async (c: Context, next) =>
                {
                    c.set('auth', { user: admin, userId: String(admin.id), keyId: 'test-key', role: null, locale: 'en', scheme: 'bearer' } as never);
                    await next();
                },
                requirePermissions('user:read', 'rbac:permission:manage'), // admin doesn't have rbac:permission:manage
                (c) => c.json({ success: true }),
            );

            const res = await app.request('/protected');
            expect(res.status).toBe(403);
        });

        it('should return 403 when not authenticated', async () =>
        {
            app.get('/protected',
                requirePermissions('user:read'),
                (c) => c.json({ success: true }),
            );

            const res = await app.request('/protected');
            expect(res.status).toBe(403);
        });
    });

    describe('requireAnyPermission()', () =>
    {
        it('should allow access when user has at least one permission', async () =>
        {
            const db = getDatabase()!;
            const [user] = await db.select().from(users).where(eq(users.email, 'user@test.com')).limit(1);

            app.get('/content',
                async (c: Context, next) =>
                {
                    c.set('auth', { user: user, userId: String(user.id), keyId: 'test-key', role: null, locale: 'en', scheme: 'bearer' } as never);
                    await next();
                },
                requireAnyPermission('auth:self:manage', 'admin:access'), // user has auth:self:manage
                (c) => c.json({ success: true }),
            );

            const res = await app.request('/content');
            expect(res.status).toBe(200);
        });

        it('should deny access when user has none of the permissions', async () =>
        {
            const db = getDatabase()!;
            const [user] = await db.select().from(users).where(eq(users.email, 'user@test.com')).limit(1);

            app.get('/content',
                async (c: Context, next) =>
                {
                    c.set('auth', { user: user, userId: String(user.id), keyId: 'test-key', role: null, locale: 'en', scheme: 'bearer' } as never);
                    await next();
                },
                requireAnyPermission('user:delete', 'rbac:role:manage'), // user has neither
                (c) => c.json({ success: true }),
            );

            const res = await app.request('/content');
            expect(res.status).toBe(403);
        });
    });

    describe('requireRole()', () =>
    {
        it('should allow access when user has required role', async () =>
        {
            const db = getDatabase()!;
            const [admin] = await db.select().from(users).where(eq(users.email, 'admin@test.com')).limit(1);

            app.get('/admin-dashboard',
                async (c: Context, next) =>
                {
                    c.set('auth', { user: admin, userId: String(admin.id), keyId: 'test-key', role: 'admin', locale: 'en', scheme: 'bearer' } as never);
                    await next();
                },
                requireRole('admin', 'superadmin'),
                (c) => c.json({ success: true }),
            );

            const res = await app.request('/admin-dashboard');
            expect(res.status).toBe(200);
        });

        it('should deny access when user lacks required role', async () =>
        {
            const db = getDatabase()!;
            const [user] = await db.select().from(users).where(eq(users.email, 'user@test.com')).limit(1);

            app.get('/admin-dashboard',
                async (c: Context, next) =>
                {
                    c.set('auth', { user: user, userId: String(user.id), keyId: 'test-key', role: null, locale: 'en', scheme: 'bearer' } as never);
                    await next();
                },
                requireRole('admin', 'superadmin'),
                (c) => c.json({ success: true }),
            );

            const res = await app.request('/admin-dashboard');
            expect(res.status).toBe(403);
        });

        it('should allow any of the specified roles', async () =>
        {
            const db = getDatabase()!;
            const [superadmin] = await db.select().from(users).where(eq(users.email, 'superadmin@test.com')).limit(1);

            app.get('/admin-dashboard',
                async (c: Context, next) =>
                {
                    c.set('auth', { user: superadmin, userId: String(superadmin.id), keyId: 'test-key', role: 'superadmin', locale: 'en', scheme: 'bearer' } as never);
                    await next();
                },
                requireRole('admin', 'superadmin'),
                (c) => c.json({ success: true }),
            );

            const res = await app.request('/admin-dashboard');
            expect(res.status).toBe(200);
        });

        it('should deny access when not authenticated', async () =>
        {
            app.get('/admin-dashboard',
                requireRole('admin'),
                (c) => c.json({ success: true }),
            );

            const res = await app.request('/admin-dashboard');
            expect(res.status).toBe(403);
        });
    });

    describe('Combined middleware', () =>
    {
        it('should work with multiple middleware in sequence', async () =>
        {
            const db = getDatabase()!;
            const [superadmin] = await db.select().from(users).where(eq(users.email, 'superadmin@test.com')).limit(1);

            app.post('/users/delete',
                async (c: Context, next) =>
                {
                    c.set('auth', { user: superadmin, userId: String(superadmin.id), keyId: 'test-key', role: 'superadmin', locale: 'en', scheme: 'bearer' } as never);
                    await next();
                },
                requireRole('admin', 'superadmin'),
                requirePermissions('user:delete'),
                (c) => c.json({ success: true }),
            );

            const res = await app.request('/users/delete', { method: 'POST' });
            expect(res.status).toBe(200);
        });

        it('should deny if first middleware fails', async () =>
        {
            const db = getDatabase()!;
            const [user] = await db.select().from(users).where(eq(users.email, 'user@test.com')).limit(1);

            app.post('/users/delete',
                async (c: Context, next) =>
                {
                    c.set('auth', { user: user, userId: String(user.id), keyId: 'test-key', role: null, locale: 'en', scheme: 'bearer' } as never);
                    await next();
                },
                requireRole('admin', 'superadmin'), // user is not admin
                requirePermissions('user:delete'),
                (c) => c.json({ success: true }),
            );

            const res = await app.request('/users/delete', { method: 'POST' });
            expect(res.status).toBe(403);
        });

        it('should deny if second middleware fails', async () =>
        {
            const db = getDatabase()!;
            const [admin] = await db.select().from(users).where(eq(users.email, 'admin@test.com')).limit(1);

            app.post('/rbac/manage',
                async (c: Context, next) =>
                {
                    c.set('auth', { user: admin, userId: String(admin.id), keyId: 'test-key', role: null, locale: 'en', scheme: 'bearer' } as never);
                    await next();
                },
                requireRole('admin', 'superadmin'), // admin passes
                requirePermissions('rbac:permission:manage'), // but doesn't have this permission
                (c) => c.json({ success: true }),
            );

            const res = await app.request('/rbac/manage', { method: 'POST' });
            expect(res.status).toBe(403);
        });
    });
});
