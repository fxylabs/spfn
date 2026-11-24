/**
 * @spfn/auth - RBAC System Unit Tests
 *
 * Tests for RBAC initialization, roles, and permissions
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupTestDb, teardownTestDb, clearTables, getTestDb } from '../helpers/db';
import { initializeAuth } from '@/server/services/rbac.service';
import { configureAuth, getSessionTtl } from '@/server/lib/config';
import {
    createRole,
    updateRole,
    deleteRole,
    getAllRoles,
    getRoleByName,
    getRolePermissions,
    addPermissionToRole,
    setRolePermissions,
} from '@/server/services/role.service';
import {
    getUserPermissions,
    hasPermission,
    hasAnyPermission,
    hasAllPermissions,
    hasRole,
} from '@/server/services/permission.service';
import { getDatabase } from '@spfn/core/db';
import { users, permissions, userPermissions } from '@/server/entities';
import { hashPassword } from '@/server/helpers/password';
import { eq } from 'drizzle-orm';

describe('RBAC System', () =>
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
        const db = getTestDb();
        await clearTables(db);
    });

    /** The caller the role service holds to the permission model's rule: a superadmin. */
    async function createSuperadmin(): Promise<number>
    {
        const [user] = await getDatabase()!.insert(users).values({
            email: 'root@example.com',
            passwordHash: await hashPassword('password'),
            roleId: (await getRoleByName('superadmin'))!.id,
            emailVerifiedAt: new Date(),
        }).returning();

        return user!.id;
    }

    describe('initializeAuth()', () =>
    {
        it('should create built-in roles (user, admin, superadmin)', async () =>
        {
            await initializeAuth();

            const allRoles = await getAllRoles();

            expect(allRoles).toHaveLength(3);
            expect(allRoles.map(r => r.name).sort()).toEqual(['admin', 'superadmin', 'user']);

            // Check properties
            const superadmin = allRoles.find(r => r.name === 'superadmin');
            expect(superadmin).toBeDefined();
            expect(superadmin?.priority).toBe(100);
            expect(superadmin?.isBuiltin).toBe(true);
            expect(superadmin?.isSystem).toBe(true);

            const admin = allRoles.find(r => r.name === 'admin');
            expect(admin?.priority).toBe(80);

            const user = allRoles.find(r => r.name === 'user');
            expect(user?.priority).toBe(10);
        });

        it('should create built-in permissions', async () =>
        {
            await initializeAuth();

            const db = getDatabase()!;
            const allPerms = await db.select().from(permissions);

            // Should have auth:self:manage, user:*, rbac:*
            const permNames = allPerms.map(p => p.name).sort();

            expect(permNames).toContain('auth:self:manage');
            expect(permNames).toContain('user:read');
            expect(permNames).toContain('user:write');
            expect(permNames).toContain('user:delete');
            expect(permNames).toContain('rbac:role:manage');
            expect(permNames).toContain('rbac:permission:manage');
        });

        it('should assign permissions to built-in roles', async () =>
        {
            await initializeAuth();

            const superadminRole = await getRoleByName('superadmin');
            const adminRole = await getRoleByName('admin');
            const userRole = await getRoleByName('user');

            // Superadmin should have all permissions
            const superadminPerms = await getRolePermissions(superadminRole!.id);
            expect(superadminPerms).toContain('auth:self:manage');
            expect(superadminPerms).toContain('user:read');
            expect(superadminPerms).toContain('user:write');
            expect(superadminPerms).toContain('user:delete');
            expect(superadminPerms).toContain('rbac:role:manage');
            expect(superadminPerms).toContain('rbac:permission:manage');

            // Admin should have user management permissions
            const adminPerms = await getRolePermissions(adminRole!.id);
            expect(adminPerms).toContain('auth:self:manage');
            expect(adminPerms).toContain('user:read');
            expect(adminPerms).toContain('user:write');
            expect(adminPerms).toContain('user:delete');
            expect(adminPerms).not.toContain('rbac:permission:manage');

            // User should only have self-management
            const userPerms = await getRolePermissions(userRole!.id);
            expect(userPerms).toEqual(['auth:self:manage']);
        });

        it('should create custom roles', async () =>
        {
            await initializeAuth({
                roles: [
                    {
                        name: 'editor',
                        displayName: 'Content Editor',
                        priority: 30,
                    },
                ],
                permissions: [
                    {
                        name: 'post:create',
                        displayName: 'Create Posts',
                        category: 'custom',
                    },
                ],
                rolePermissions: {
                    editor: ['post:create', 'auth:self:manage'],
                },
            });

            const editor = await getRoleByName('editor');
            expect(editor).toBeDefined();
            expect(editor?.displayName).toBe('Content Editor');
            expect(editor?.priority).toBe(30);
            expect(editor?.isSystem).toBe(false);

            const editorPerms = await getRolePermissions(editor!.id);
            expect(editorPerms).toContain('post:create');
            expect(editorPerms).toContain('auth:self:manage');
        });

        it('should be idempotent (can run multiple times)', async () =>
        {
            await initializeAuth();
            await initializeAuth();
            await initializeAuth();

            const allRoles = await getAllRoles();
            expect(allRoles).toHaveLength(3);
        });

        // #477: each record is read once, and what is declared is what that read answered.
        it('reads a role\'s and a permission\'s name once, and declares what that read answered', async () =>
        {
            const roleNames = ['getter-role', 'getter-role-again'];
            const permissionNames = ['getter:permission', 'getter:permission-again'];
            let roleReads = 0;
            let permissionReads = 0;

            await initializeAuth({
                roles: [{
                    displayName: 'Getter Role',
                    get name()
                    {
                        return roleNames[roleReads++];
                    },
                }],
                permissions: [{
                    displayName: 'Getter Permission',
                    get name()
                    {
                        return permissionNames[permissionReads++];
                    },
                }],
            });

            expect(await getRoleByName('getter-role')).toBeDefined();
            expect(await getRoleByName('getter-role-again')).toBeNull();
            expect(roleReads).toBe(1);
            expect((await getDatabase()!.select().from(permissions).where(eq(permissions.name, 'getter:permission'))).length).toBe(1);
            expect(permissionReads).toBe(1);
        });

        it('reads a role\'s permission list once, and maps what that read answered (#477)', async () =>
        {
            const answers = [['getter:first'], ['getter:second']];
            let reads = 0;

            await initializeAuth({
                permissions: [
                    { name: 'getter:first', displayName: 'First' },
                    { name: 'getter:second', displayName: 'Second' },
                ],
                rolePermissions: {
                    get admin()
                    {
                        return answers[reads++];
                    },
                },
            });

            const adminPerms = await getRolePermissions((await getRoleByName('admin'))!.id);

            expect(adminPerms).toContain('getter:first');
            expect(adminPerms).not.toContain('getter:second');
            expect(reads).toBe(1);
        });

        it('reads sessionTtl once, and configures what that read answered (#477)', async () =>
        {
            const answers = ['2d', '3d'];
            let reads = 0;

            await initializeAuth({
                get sessionTtl()
                {
                    return answers[reads++];
                },
            });

            expect(getSessionTtl()).toBe(2 * 24 * 60 * 60);
            expect(reads).toBe(1);
            configureAuth({ sessionTtl: undefined });
        });

        it('should extend built-in roles with custom permissions', async () =>
        {
            await initializeAuth({
                permissions: [
                    { name: 'test:action', displayName: 'Test Action' },
                ],
                rolePermissions: {
                    admin: ['test:action'],  // Extend admin role
                },
            });

            const adminRole = await getRoleByName('admin');
            const adminPerms = await getRolePermissions(adminRole!.id);

            // Should have both built-in and custom permissions
            expect(adminPerms).toContain('user:read');
            expect(adminPerms).toContain('test:action');
        });
    });

    describe('Role Management', () =>
    {
        let caller: number;

        beforeEach(async () =>
        {
            await initializeAuth();
            caller = await createSuperadmin();
        });

        it('should create a custom role', async () =>
        {
            const role = await createRole(caller, {
                name: 'moderator',
                displayName: 'Moderator',
                description: 'Community moderator',
                priority: 40,
            });

            expect(role.name).toBe('moderator');
            expect(role.displayName).toBe('Moderator');
            expect(role.priority).toBe(40);
            expect(role.isSystem).toBe(false);
            expect(role.isBuiltin).toBe(false);
        });

        it('should not allow duplicate role names', async () =>
        {
            await createRole(caller, {
                name: 'moderator',
                displayName: 'Moderator',
            });

            await expect(createRole(caller, {
                name: 'moderator',
                displayName: 'Another Moderator',
            })).rejects.toThrow('already exists');
        });

        it('should update role', async () =>
        {
            const role = await createRole(caller, {
                name: 'moderator',
                displayName: 'Moderator',
                priority: 40,
            });

            const updated = await updateRole(caller, role.id, {
                displayName: 'Senior Moderator',
                priority: 50,
            });

            expect(updated.displayName).toBe('Senior Moderator');
            expect(updated.priority).toBe(50);
        });

        it('should not allow modifying built-in role priority', async () =>
        {
            const userRole = await getRoleByName('user');

            await expect(updateRole(caller, userRole!.id, {
                priority: 50,
            })).rejects.toMatchObject({ statusCode: 409, code: 'CONFIG_OWNED_ROLE' });
        });

        it('should delete custom role', async () =>
        {
            const role = await createRole(caller, {
                name: 'moderator',
                displayName: 'Moderator',
            });

            await deleteRole(caller, role.id);

            const deleted = await getRoleByName('moderator');
            expect(deleted).toBeNull();
        });

        it('should not allow deleting built-in roles', async () =>
        {
            const userRole = await getRoleByName('user');

            await expect(deleteRole(caller, userRole!.id)).rejects.toMatchObject({ statusCode: 409, code: 'CONFIG_OWNED_ROLE' });
        });

        it('should not allow deleting system roles, once the configuration no longer declares them', async () =>
        {
            await initializeAuth({
                roles: [
                    {
                        name: 'preset-role',
                        displayName: 'Preset Role',
                        isSystem: true,
                    },
                ],
            });
            await initializeAuth();

            const presetRole = await getRoleByName('preset-role');

            await expect(deleteRole(caller, presetRole!.id)).rejects.toThrow('system role');
        });
    });

    describe('Permission Management', () =>
    {
        let caller: number;

        beforeEach(async () =>
        {
            await initializeAuth({
                permissions: [
                    { name: 'post:create', displayName: 'Create Posts', category: 'custom' },
                    { name: 'post:publish', displayName: 'Publish Posts', category: 'custom' },
                    { name: 'post:delete', displayName: 'Delete Posts', category: 'custom' },
                ],
                // A caller attaches only permissions they hold
                rolePermissions: { superadmin: ['post:create', 'post:publish', 'post:delete'] },
            });
            caller = await createSuperadmin();
        });

        it('should add permission to role', async () =>
        {
            const db = getDatabase()!;

            const userRole = await getRoleByName('user');
            const [postCreatePerm] = await db.select().from(permissions).where(eq(permissions.name, 'post:create')).limit(1);

            await addPermissionToRole(caller, userRole!.id, postCreatePerm.id);

            const userPerms = await getRolePermissions(userRole!.id);
            expect(userPerms).toContain('post:create');
        });

        it('should set role permissions (replace the operator\'s, keep the configuration\'s)', async () =>
        {
            const db = getDatabase()!;

            const userRole = await getRoleByName('user');
            const perms = await db.select().from(permissions).where(eq(permissions.category, 'custom'));
            const [selfManage] = await db.select().from(permissions).where(eq(permissions.name, 'auth:self:manage'));

            await setRolePermissions(caller, userRole!.id, perms.map(p => p.id).concat(selfManage!.id));
            await setRolePermissions(caller, userRole!.id, [perms[0]!.id, selfManage!.id]);

            const userPerms = await getRolePermissions(userRole!.id);
            expect(userPerms.sort()).toEqual(['auth:self:manage', perms[0]!.name].sort());
        });
    });

    describe('User Permission Checking', () =>
    {
        let testUserId: number;
        let caller: number;

        beforeEach(async () =>
        {
            await initializeAuth({
                permissions: [
                    { name: 'post:create', displayName: 'Create Posts' },
                    { name: 'post:publish', displayName: 'Publish Posts' },
                ],
                rolePermissions: { superadmin: ['post:create'] },
            });
            caller = await createSuperadmin();

            const db = getDatabase()!;
            const userRole = await getRoleByName('user');

            // Create test user
            const [user] = await db.insert(users).values({
                email: 'test@example.com',
                passwordHash: await hashPassword('password'),
                roleId: userRole!.id,
                emailVerifiedAt: new Date(),
            }).returning();

            testUserId = user.id;
        });

        it('should get user permissions from role', async () =>
        {
            const perms = await getUserPermissions(testUserId);

            expect(perms).toContain('auth:self:manage');
        });

        it('should check if user has permission', async () =>
        {
            const hasPerm = await hasPermission(testUserId, 'auth:self:manage');
            expect(hasPerm).toBe(true);

            const noPerm = await hasPermission(testUserId, 'user:delete');
            expect(noPerm).toBe(false);
        });

        it('should check if user has any permission', async () =>
        {
            const hasAny = await hasAnyPermission(testUserId, ['user:delete', 'auth:self:manage']);
            expect(hasAny).toBe(true);

            const hasNone = await hasAnyPermission(testUserId, ['user:delete', 'user:write']);
            expect(hasNone).toBe(false);
        });

        it('should check if user has all permissions', async () =>
        {
            const db = getDatabase()!;
            const userRole = await getRoleByName('user');
            const [postCreatePerm] = await db.select().from(permissions).where(eq(permissions.name, 'post:create')).limit(1);

            await addPermissionToRole(caller, userRole!.id, postCreatePerm.id);

            const hasAll = await hasAllPermissions(testUserId, ['auth:self:manage', 'post:create']);
            expect(hasAll).toBe(true);

            const notAll = await hasAllPermissions(testUserId, ['auth:self:manage', 'user:delete']);
            expect(notAll).toBe(false);
        });

        it('should check user role', async () =>
        {
            const isUser = await hasRole(testUserId, 'user');
            expect(isUser).toBe(true);

            const isAdmin = await hasRole(testUserId, 'admin');
            expect(isAdmin).toBe(false);
        });

        it('should grant user-specific permission', async () =>
        {
            const db = getDatabase()!;
            const [userDeletePerm] = await db.select().from(permissions).where(eq(permissions.name, 'user:delete')).limit(1);

            // Grant permission to this user specifically
            await db.insert(userPermissions).values({
                userId: testUserId,
                permissionId: userDeletePerm.id,
                granted: true,
                reason: 'Temporary admin access',
            });

            const perms = await getUserPermissions(testUserId);
            expect(perms).toContain('user:delete');

            const hasPerm = await hasPermission(testUserId, 'user:delete');
            expect(hasPerm).toBe(true);
        });

        it('should revoke user-specific permission', async () =>
        {
            const db = getDatabase()!;
            const [authPerm] = await db.select().from(permissions).where(eq(permissions.name, 'auth:self:manage')).limit(1);

            // Revoke permission (even though role has it)
            await db.insert(userPermissions).values({
                userId: testUserId,
                permissionId: authPerm.id,
                granted: false,
                reason: 'Security violation',
            });

            const perms = await getUserPermissions(testUserId);
            expect(perms).not.toContain('auth:self:manage');

            const hasPerm = await hasPermission(testUserId, 'auth:self:manage');
            expect(hasPerm).toBe(false);
        });

        it('should respect permission expiration', async () =>
        {
            const db = getDatabase()!;
            const [userDeletePerm] = await db.select().from(permissions).where(eq(permissions.name, 'user:delete')).limit(1);

            // Grant expired permission
            await db.insert(userPermissions).values({
                userId: testUserId,
                permissionId: userDeletePerm.id,
                granted: true,
                expiresAt: new Date('2020-01-01'),  // Expired
            });

            const perms = await getUserPermissions(testUserId);
            expect(perms).not.toContain('user:delete');
        });

        it('should respect future expiration', async () =>
        {
            const db = getDatabase()!;
            const [userDeletePerm] = await db.select().from(permissions).where(eq(permissions.name, 'user:delete')).limit(1);

            // Grant permission that expires in future
            const futureDate = new Date();
            futureDate.setDate(futureDate.getDate() + 7);

            await db.insert(userPermissions).values({
                userId: testUserId,
                permissionId: userDeletePerm.id,
                granted: true,
                expiresAt: futureDate,
            });

            const perms = await getUserPermissions(testUserId);
            expect(perms).toContain('user:delete');
        });

        it('should return empty array for non-existent user', async () =>
        {
            // Non-existent user ID
            const perms = await getUserPermissions(999999);
            expect(perms).toEqual([]);
        });
    });
});
