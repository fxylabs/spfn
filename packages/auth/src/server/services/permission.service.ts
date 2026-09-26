/**
 * @spfn/auth - Permission Service
 *
 * Permission checking and validation logic
 */

import {
    usersRepository,
    rolesRepository,
    permissionsRepository,
    rolePermissionsRepository,
    userPermissionsRepository,
} from '../repositories';
import { ForbiddenError } from '@spfn/core/errors';
import { findUserWithEffectiveRole } from './role-email-domain.service';

/**
 * Get all permissions for a user
 *
 * Combines role-based permissions with user-specific overrides
 * Handles expiration of temporary permissions
 *
 * The role is the effective one: an account outside `SPFN_AUTH_ROLE_EMAIL_DOMAINS`
 * for its stored role gets the `user` role's permissions. User-specific
 * overrides are grants on the account, not the role, and still apply.
 *
 * @param userId - User ID (string, number, or bigint)
 * @returns Array of permission names
 *
 * @example
 * ```typescript
 * const perms = await getUserPermissions('123');
 * // ['auth:self:manage', 'user:read', 'post:create']
 * ```
 */
export async function getUserPermissions(userId: string | number | bigint): Promise<string[]>
{
    const userIdNum = typeof userId === 'string' ? Number(userId) : Number(userId);

    // 1. Get user's effective role
    const role = (await findUserWithEffectiveRole(userIdNum))?.role;

    if (!role)
    {
        return [];
    }

    const permSet = new Set<string>();

    // 2. Get role-based permissions
    const rolePermMappings = await rolePermissionsRepository.findByRoleId(role.id);
    const permIds = rolePermMappings.map(rp => rp.permissionId);

    if (permIds.length > 0)
    {
        const rolePerms = await Promise.all(
            permIds.map(id => permissionsRepository.findById(id)),
        );

        for (const perm of rolePerms)
        {
            if (perm && perm.isActive)
            {
                permSet.add(perm.name);
            }
        }
    }

    // 3. Apply user-specific permission overrides
    const userPermMappings = await userPermissionsRepository.findValidByUserId(userIdNum);

    for (const userPermMapping of userPermMappings)
    {
        const perm = await permissionsRepository.findById(userPermMapping.permissionId);
        if (!perm) continue;

        if (userPermMapping.granted)
        {
            // Grant permission (add even if not in role)
            permSet.add(perm.name);
        }
        else
        {
            // Revoke permission (remove even if in role)
            permSet.delete(perm.name);
        }
    }

    return Array.from(permSet);
}

/**
 * Check if user has a specific permission
 *
 * @param userId - User ID
 * @param permissionName - Permission name (e.g., 'user:delete')
 * @returns true if user has permission
 *
 * @example
 * ```typescript
 * if (await hasPermission('123', 'user:delete')) {
 *   // User can delete users
 * }
 * ```
 */
export async function hasPermission(
    userId: string | number | bigint,
    permissionName: string,
): Promise<boolean>
{
    const perms = await getUserPermissions(userId);

    return perms.includes(permissionName);
}

/**
 * Check if user has any of the specified permissions
 *
 * @param userId - User ID
 * @param permissionNames - Array of permission names
 * @returns true if user has at least one permission
 *
 * @example
 * ```typescript
 * if (await hasAnyPermission('123', ['post:read', 'admin:access'])) {
 *   // User can access content
 * }
 * ```
 */
export async function hasAnyPermission(
    userId: string | number | bigint,
    permissionNames: string[],
): Promise<boolean>
{
    const perms = await getUserPermissions(userId);

    return permissionNames.some(p => perms.includes(p));
}

/**
 * Check if user has all of the specified permissions
 *
 * @param userId - User ID
 * @param permissionNames - Array of permission names
 * @returns true if user has all permissions
 *
 * @example
 * ```typescript
 * if (await hasAllPermissions('123', ['post:write', 'post:publish'])) {
 *   // User can write AND publish
 * }
 * ```
 */
export async function hasAllPermissions(
    userId: string | number | bigint,
    permissionNames: string[],
): Promise<boolean>
{
    const perms = await getUserPermissions(userId);

    return permissionNames.every(p => perms.includes(p));
}

/**
 * Get user's role name
 *
 * The effective role: `user` for an account outside `SPFN_AUTH_ROLE_EMAIL_DOMAINS`
 * for its stored role. For the stored role itself, see `getStoredUserRole`.
 *
 * @param userId - User ID
 * @returns Role name or null if user has no role
 *
 * @example
 * ```typescript
 * const role = await getUserRole('123');
 * // 'admin' or null
 * ```
 */
export async function getUserRole(userId: string | number | bigint): Promise<string | null>
{
    const userIdNum = typeof userId === 'string' ? Number(userId) : Number(userId);

    return (await findUserWithEffectiveRole(userIdNum))?.role?.name ?? null;
}

/**
 * Get the role stored on a user's row, whatever the email-domain policy says
 *
 * For protecting a **target** account, never for authorizing a caller. An
 * account outside the policy still stores its role; judging it by the effective
 * `user` role would let an ordinary admin overwrite an out-of-policy superadmin,
 * and a revert of the configuration could no longer restore it.
 *
 * @param userId - User ID
 * @returns Stored role name or null if user has no role
 */
export async function getStoredUserRole(userId: string | number | bigint): Promise<string | null>
{
    return (await usersRepository.findByIdWithRole(Number(userId)))?.role?.name ?? null;
}

/**
 * Check if user has a specific role
 *
 * @param userId - User ID
 * @param roleName - Role name (e.g., 'admin', 'superadmin')
 * @returns true if user has role
 *
 * @example
 * ```typescript
 * if (await hasRole('123', 'admin')) {
 *   // User is admin
 * }
 * ```
 */
export async function hasRole(userId: string | number | bigint, roleName: string): Promise<boolean>
{
    const role = await getUserRole(userId);

    return role === roleName;
}

/**
 * Check if user has any of the specified roles
 *
 * @param userId - User ID
 * @param roleNames - Array of role names
 * @returns true if user has at least one role
 */
export async function hasAnyRole(userId: string | number | bigint, roleNames: string[]): Promise<boolean>
{
    for (const roleName of roleNames)
    {
        if (await hasRole(userId, roleName))
        {
            return true;
        }
    }

    return false;
}

/**
 * Assert that the caller is allowed to assign the given role.
 *
 * The caller's authority is their effective role and permissions: a caller
 * outside the email-domain policy for their stored role acts as `user`.
 *
 * Centralizes the privilege rule shared by direct role assignment and invitation:
 * a non-superadmin caller may never grant the superadmin role, and may grant the
 * admin role only when they hold the `admin:promote` permission. Assigning any
 * lower role is unrestricted (the route's own permission guard still applies).
 *
 * @param callerUserId - User performing the assignment
 * @param targetRoleId - Role being assigned
 * @throws ForbiddenError when the caller lacks the authority for the target role
 *
 * @example
 * ```typescript
 * await assertCanAssignRole(auth.userId, body.roleId);
 * ```
 */
export async function assertCanAssignRole(
    callerUserId: string | number | bigint,
    targetRoleId: number,
): Promise<void>
{
    const callerRole = await getUserRole(callerUserId);

    if (callerRole === 'superadmin')
    {
        return;
    }

    const targetRole = await rolesRepository.findById(targetRoleId);

    if (targetRole?.name === 'superadmin')
    {
        throw new ForbiddenError({ message: 'Only superadmin can assign superadmin role' });
    }

    if (targetRole?.name === 'admin')
    {
        const canPromote = await hasPermission(callerUserId, 'admin:promote');

        if (!canPromote)
        {
            throw new ForbiddenError({ message: 'admin:promote permission required to assign admin role' });
        }
    }
}
