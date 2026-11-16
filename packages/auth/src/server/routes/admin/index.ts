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
    changeUserRole,
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
 *
 * Ranked below the caller's own role, with only permissions the caller holds
 * (`assertCanChangeAuthority`, 403 otherwise); 409 for a name taken.
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

        const role = await _createRole(Number(getAuth(c).userId), {
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
 *
 * Only a role ranked strictly below the caller's, and only to a priority below
 * it (`assertCanChangeAuthority`, 403 otherwise); 404 unknown role, 409
 * `ConfigOwnedRoleError` for changing the display name, description or
 * priority of a role the configuration declares (its `isActive` is the
 * operator's), 409 for deactivating `superadmin`.
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
        const role = await _updateRole(Number(getAuth(c).userId), params.id, body);

        return { role };
    });

/**
 * DELETE /_auth/admin/roles/:id
 * Delete a role (non-builtin, non-system only)
 *
 * Only a role ranked strictly below the caller's (`assertCanChangeAuthority`,
 * 403 otherwise — the highest role, `superadmin`, included); 404 unknown role,
 * 409 `ConfigOwnedRoleError` for a role the configuration declares (the
 * built-ins included), 409 for a system role, and 409 `RoleInUseError` while
 * an account holds it, a pending invitation promises it or the email-domain
 * policy names it — deleting a role never deletes an account.
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
        await _deleteRole(Number(getAuth(c).userId), params.id);

        return c.noContent();
    });

// ==========================================
// User Role Assignment
// ==========================================

/**
 * PATCH /_auth/admin/users/:userId/role
 * Change a user's role
 *
 * The caller must outrank, by role priority, both the role the user holds and
 * the role given (`assertCanChangeRole`): an admin changes users below admin,
 * only a superadmin creates or demotes an admin, and nobody changes a
 * superadmin. 404 for an unknown user or role, 409 for an inactive role. The
 * caller's authority is read inside the change's transaction, after the
 * target's account lock — not when this request's guard ran.
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

        await changeUserRole(Number(auth.userId), params.userId, body.roleId);

        return { userId: params.userId, roleId: body.roleId };
    });
