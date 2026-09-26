/**
 * @spfn/auth - Admin Routes
 *
 * Superadmin-only routes for role management and user role assignment
 */

import { authenticate, requireRole } from '../../middleware';
import {
    getAllRoles,
    createRole as _createRole,
    updateRole as _updateRole,
    deleteRole as _deleteRole,
    updateUserService,
    getStoredUserRole,
    assertCanAssignRole,
} from '../../services';
import { getAuth } from '../../helpers';
import { ForbiddenError } from '@spfn/core/errors';
import { Type } from '@sinclair/typebox';
import { route } from '@spfn/core/route';

// ==========================================
// Role CRUD
// ==========================================

/**
 * GET /_auth/admin/roles
 * List all roles (optionally include inactive)
 */
export const listRoles = route.get('/_auth/admin/roles')
    .input({
        query: Type.Object({
            includeInactive: Type.Optional(Type.Boolean({
                description: 'Include inactive roles (default: false)',
            })),
        }),
    })
    .use([authenticate, requireRole('admin', 'superadmin')])
    .handler(async (c) =>
    {
        const { query } = await c.data();
        const roles = await getAllRoles(query.includeInactive ?? false);

        return { roles };
    });

/**
 * POST /_auth/admin/roles
 * Create a new role
 */
export const createAdminRole = route.post('/_auth/admin/roles')
    .input({
        body: Type.Object({
            name: Type.String({ description: 'Unique role name (slug)' }),
            displayName: Type.String({ description: 'Human-readable role name' }),
            description: Type.Optional(Type.String({ description: 'Role description' })),
            priority: Type.Optional(Type.Number({ description: 'Role priority (default: 10)' })),
            permissionIds: Type.Optional(Type.Array(
                Type.Number({ description: 'Permission ID' }),
                { description: 'Permission IDs to assign' },
            )),
        }),
    })
    .use([authenticate, requireRole('superadmin')])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        const role = await _createRole({
            name: body.name,
            displayName: body.displayName,
            description: body.description,
            priority: body.priority,
            permissionIds: body.permissionIds,
        });

        return { role };
    });

/**
 * PATCH /_auth/admin/roles/:id
 * Update an existing role
 */
export const updateAdminRole = route.patch('/_auth/admin/roles/:id')
    .input({
        params: Type.Object({
            id: Type.Number({ description: 'Role ID' }),
        }),
        body: Type.Object({
            displayName: Type.Optional(Type.String({ description: 'Human-readable role name' })),
            description: Type.Optional(Type.String({ description: 'Role description' })),
            priority: Type.Optional(Type.Number({ description: 'Role priority' })),
            isActive: Type.Optional(Type.Boolean({ description: 'Active status' })),
        }),
    })
    .use([authenticate, requireRole('superadmin')])
    .handler(async (c) =>
    {
        const { params, body } = await c.data();
        const role = await _updateRole(params.id, body);

        return { role };
    });

/**
 * DELETE /_auth/admin/roles/:id
 * Delete a role (non-builtin, non-system only)
 */
export const deleteAdminRole = route.delete('/_auth/admin/roles/:id')
    .input({
        params: Type.Object({
            id: Type.Number({ description: 'Role ID' }),
        }),
    })
    .use([authenticate, requireRole('superadmin')])
    .handler(async (c) =>
    {
        const { params } = await c.data();
        await _deleteRole(params.id);

        return c.noContent();
    });

// ==========================================
// User Role Assignment
// ==========================================

/**
 * PATCH /_auth/admin/users/:userId/role
 * Change a user's role
 */
export const updateUserRole = route.patch('/_auth/admin/users/:userId/role')
    .input({
        params: Type.Object({
            userId: Type.Number({ description: 'User ID' }),
        }),
        body: Type.Object({
            roleId: Type.Number({ description: 'New role ID to assign' }),
        }),
    })
    .use([authenticate, requireRole('admin', 'superadmin')])
    .handler(async (c) =>
    {
        const { params, body } = await c.data();
        const auth = getAuth(c);

        if (params.userId === Number(auth.userId))
        {
            throw new ForbiddenError({ message: 'Cannot change your own role' });
        }

        // The stored role, not the effective one: an out-of-policy superadmin is
        // still a superadmin's row, and only a superadmin may change it.
        const targetRole = await getStoredUserRole(params.userId);
        if (targetRole === 'superadmin')
        {
            throw new ForbiddenError({ message: 'Cannot modify superadmin role' });
        }

        // Caller must have authority over the role being assigned
        await assertCanAssignRole(auth.userId, body.roleId);

        await updateUserService(params.userId, { roleId: body.roleId });

        return { userId: params.userId, roleId: body.roleId };
    });
