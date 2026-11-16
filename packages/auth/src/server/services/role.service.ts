/**
 * @spfn/auth - Role Service
 *
 * Role management functions for runtime role creation and modification
 */

import { ConflictError } from '@spfn/core/errors';
import { ConfigOwnedMappingError, ConfigOwnedRoleError, RoleInUseError } from '@spfn/auth/errors';

import {
    rolesRepository,
    permissionsRepository,
    rolePermissionsRepository,
} from '../repositories';
import type { Role } from '../entities/roles';
import { CONFIG_OWNED, OPERATOR_OWNED, type RolePermission } from '../entities/role-permissions';
import { getRoleEmailDomainPolicy } from '../lib/role-email-domains';
import {
    assertAuthorityChangeAllowed,
    assertCanChangeAuthority,
    assertRoleMayBeDeactivated,
    changedRole,
    holdAuthority,
    runJudgedTransaction,
    type AuthorityChange,
} from './permission.service';

/**
 * Every function here that changes a role takes the caller's user id first and
 * holds them to the permission model's rule (`assertCanChangeAuthority`),
 * judged inside the writing transaction, on the role locked with it: a caller
 * creates or re-ranks a role only below their own priority, changes only a
 * role they strictly outrank, and attaches only permissions they hold.
 *
 * **Who owns a role.** A role has one owner, its `source`. The
 * configuration's (`config`: `roles` with the built-ins) have their declared
 * fields — display name, description, priority, built-in/system flags — made
 * equal to the configuration on every boot; here those fields cannot be
 * changed and the role cannot be deleted — a 409 `ConfigOwnedRoleError`.
 * `isActive` is the operator's (`superadmin` excepted). Roles created here are
 * the operator's (`admin`) entirely, until the configuration comes to declare
 * one; a role the configuration stops declaring becomes the operator's.
 *
 * **Who owns a mapping.** A role→permission mapping has one owner, its
 * `source`. The configuration's (`config`: `rolePermissions` with the
 * built-ins) are made equal to the configuration on every boot; nothing here
 * removes or takes over one — removing it is a 409 `ConfigOwnedMappingError`,
 * and it is removed by dropping it from the configuration. Mappings added here
 * are the operator's (`admin`), and boot leaves them alone unless the
 * configuration comes to declare them, which makes them the configuration's.
 * A delete here carries the owner (`source = 'admin'`), so a mapping a boot
 * made the configuration's after it was read is refused, not deleted.
 *
 * **Deleting a role never deletes an account.** `users.role_id` and
 * `user_invitations.role_id` restrict it: a role still held, promised by a
 * pending invitation that can still be accepted, or named by the email-domain policy is a 409
 * `RoleInUseError`. Its mappings go with it.
 */

/** The fields of a role the configuration declares that the admin API could change. */
const DECLARED_ROLE_FIELDS = ['displayName', 'description', 'priority'] as const;

/** What `updateRole` may change. */
export interface RoleUpdate
{
    displayName?: string;
    description?: string;
    priority?: number;
    isActive?: boolean;
}

const DEFAULT_ROLE_PRIORITY = 10;

/**
 * The role `change` is made to, once the caller may make it: locked `FOR
 * UPDATE` for the rest of the transaction, with every role the judgement rests
 * on, in one call (`assertCanChangeAuthority`).
 *
 * @throws NotFoundError (404) when the role does not exist
 * @throws ForbiddenError (403) when the caller may not make the change
 */
async function changeableRole(callerId: number, change: AuthorityChange & { roleId: number }): Promise<Role>
{
    return (await assertCanChangeAuthority(Number(callerId), { ...change, roleId: Number(change.roleId) }))!;
}

/**
 * Create a new custom role
 *
 * Its `permissionIds` mappings are the operator's: `initializeAuth` never
 * removes them.
 *
 * @param callerId - The person creating it: their role must rank above `priority`, and they must hold every permission given
 * @param data - Role configuration
 * @returns Created role
 * @throws ForbiddenError (403) when the priority is not below the caller's, or a permission is not theirs
 * @throws AuthorityContendedError (409) when the caller's role changed under the judgement twice
 * @throws ConflictError (409) when the name is taken
 *
 * @example
 * ```typescript
 * const role = await createRole(auth.userId, {
 *   name: 'content-creator',
 *   displayName: 'Content Creator',
 *   description: 'Can create and publish content',
 *   priority: 20,
 *   permissionIds: [1, 2, 3],
 * });
 * ```
 */
export async function createRole(callerId: number, data: {
    name: string;
    displayName: string;
    description?: string;
    priority?: number;
    permissionIds?: number[];
}): Promise<Role>
{
    const priority = data.priority ?? DEFAULT_ROLE_PRIORITY;
    const permissionIds = (data.permissionIds ?? []).map(Number);

    return runJudgedTransaction(async () =>
    {
        await assertCanChangeAuthority(Number(callerId), { priority, conferred: permissionIds });

        if (await rolesRepository.findByNameOnPrimary(data.name))
        {
            throw new ConflictError({ message: `Role with name '${data.name}' already exists` });
        }

        const role = await rolesRepository.create({
            name: data.name,
            displayName: data.displayName,
            description: data.description || null,
            priority,
            isSystem: false,  // Custom roles are never system roles
            isBuiltin: false,
            isActive: true,
            source: OPERATOR_OWNED,
        });

        await rolePermissionsRepository.createMany(permissionIds.map(permissionId => ({ roleId: role.id, permissionId, source: OPERATOR_OWNED })));

        console.log(`[Auth] ✅ Created custom role: ${data.name}`);

        return role;
    }, { context: 'auth:role-create' });
}

/**
 * Update an existing role
 *
 * Deactivating a role (`isActive: false`) takes it from everyone who holds it
 * on their next request — they keep their accounts, with no role — and
 * reactivating it gives it back. The `superadmin` role cannot be deactivated.
 * Of a role the configuration declares, only `isActive` can be changed here.
 *
 * Takes the role `FOR UPDATE` and no account lock.
 *
 * @param callerId - The person changing it: their role must rank above the role, and above a new `priority`
 * @param roleId - Role ID
 * @param data - Update data
 * @returns Updated role
 * @throws NotFoundError (404) when the role does not exist
 * @throws ForbiddenError (403) when the caller does not outrank the role or the new priority
 * @throws AuthorityContendedError (409) when the caller's role changed under the judgement twice
 * @throws ConfigOwnedRoleError (409) when changing a declared field of a role the configuration declares
 * @throws ConflictError (409) when deactivating `superadmin`
 *
 * @example
 * ```typescript
 * await updateRole(auth.userId, roleId, {
 *   displayName: 'Senior Content Creator',
 *   priority: 25,
 * });
 * ```
 */
export async function updateRole(
    callerId: number,
    roleId: number,
    data: RoleUpdate,
): Promise<Role>
{
    return runJudgedTransaction(async () =>
    {
        const role = await changeableRole(callerId, { roleId, priority: data.priority });

        assertDeclaredFieldsKept(role, data);

        if (data.isActive === false)
        {
            assertRoleMayBeDeactivated(role);
        }

        return (await rolesRepository.updateById(role.id, data))!;
    }, { context: 'auth:role-update' });
}

/** @throws ConfigOwnedRoleError (409) when `data` changes a field the configuration declares for a role it owns */
function assertDeclaredFieldsKept(role: Role, data: RoleUpdate): void
{
    const changed = DECLARED_ROLE_FIELDS.filter(field => data[field] !== undefined && data[field] !== role[field]);

    if (role.source === CONFIG_OWNED && changed.length > 0)
    {
        throw new ConfigOwnedRoleError({ details: { roleId: role.id, fields: changed } });
    }
}

/**
 * Delete a role
 *
 * Never an account: a role some account holds, a pending invitation promises
 * or this instance's email-domain policy names is refused, with how many of
 * each, and the operator reassigns them first. Its mappings, and its settled
 * invitations, go with it: accepted, cancelled, expired, and pending past
 * their expiry — the acceptance's own definition (`claimableAt`), so an
 * invitation the sweep has not marked expired yet blocks nothing.
 *
 * Takes the role `FOR UPDATE` and no account lock: an account or invitation
 * written to the role after the count waits on that lock, then fails its
 * foreign-key check (`ON DELETE restrict`).
 *
 * @param callerId - The person deleting it: their role must rank above it
 * @param roleId - Role ID
 * @throws NotFoundError (404) when the role does not exist
 * @throws ForbiddenError (403) when the caller does not outrank the role
 * @throws AuthorityContendedError (409) when the caller's role changed under the judgement twice
 * @throws ConfigOwnedRoleError (409) when the configuration declares the role (the built-ins included)
 * @throws ConflictError (409) when the role is a system role
 * @throws RoleInUseError (409) when accounts, pending invitations or the email-domain policy still name it
 *
 * @example
 * ```typescript
 * await deleteRole(auth.userId, roleId);  // Delete custom role
 * ```
 */
export async function deleteRole(callerId: number, roleId: number): Promise<void>
{
    await runJudgedTransaction(async () =>
    {
        const role = await changeableRole(callerId, { roleId });

        if (role.source === CONFIG_OWNED)
        {
            throw new ConfigOwnedRoleError({ details: { roleId: role.id } });
        }

        if (role.isSystem)
        {
            throw new ConflictError({ message: `Cannot delete system role: ${role.name}. Deactivate it instead.` });
        }

        await assertRoleUnreferenced(role);
        await rolesRepository.deleteSettledInvitations(role.id);
        // role_permissions cascade: a mapping is part of its role
        await rolesRepository.deleteById(role.id);

        console.log(`[Auth] 🗑️  Deleted role: ${role.name}`);
    }, { context: 'auth:role-delete' });
}

/** @throws RoleInUseError (409) when an account, a pending invitation or the email-domain policy names the role */
async function assertRoleUnreferenced(role: Role): Promise<void>
{
    const references = await rolesRepository.referencesOf(role.id);
    const emailDomainPolicy = getRoleEmailDomainPolicy().has(role.name);

    if (references.accounts > 0 || references.pendingInvitations > 0 || emailDomainPolicy)
    {
        throw new RoleInUseError({ details: { roleId: role.id, ...references, emailDomainPolicy } });
    }
}

/**
 * Add permission to role
 *
 * A new mapping is the operator's: `initializeAuth` never removes it. A
 * mapping the role already has is left as it is, owner included — one the
 * configuration declares stays the configuration's, and leaves the role when
 * the configuration drops it.
 *
 * @param callerId - The person adding it: their role must rank above the role, and they must hold the permission
 * @param roleId - Role ID
 * @param permissionId - Permission ID
 * @returns The mapping, as it is now
 * @throws NotFoundError (404) when the role does not exist
 * @throws ForbiddenError (403) when the caller does not outrank the role or does not hold the permission
 * @throws AuthorityContendedError (409) when the caller's role changed under the judgement twice
 *
 * @example
 * ```typescript
 * await addPermissionToRole(auth.userId, roleId, permissionId);
 * ```
 */
export async function addPermissionToRole(callerId: number, roleId: number, permissionId: number): Promise<RolePermission>
{
    return runJudgedTransaction(async () =>
    {
        const role = await changeableRole(callerId, { roleId, conferred: [Number(permissionId)] });

        const existing = (await rolePermissionsRepository.findByRoleIdOnPrimary(role.id))
            .find(mapping => mapping.permissionId === Number(permissionId));

        return existing ?? rolePermissionsRepository.create({ roleId: role.id, permissionId: Number(permissionId), source: OPERATOR_OWNED });
    }, { context: 'auth:role-permissions' });
}

/**
 * Remove permission from role
 *
 * Only an operator's mapping: one the configuration declares is removed by
 * dropping it from the configuration. A mapping the role does not have is no
 * change.
 *
 * @param callerId - The person removing it: their role must rank above the role
 * @param roleId - Role ID
 * @param permissionId - Permission ID
 * @throws NotFoundError (404) when the role does not exist
 * @throws ForbiddenError (403) when the caller does not outrank the role
 * @throws AuthorityContendedError (409) when the caller's role changed under the judgement twice
 * @throws ConfigOwnedMappingError (409) when the configuration declares the mapping
 *
 * @example
 * ```typescript
 * await removePermissionFromRole(auth.userId, roleId, permissionId);
 * ```
 */
export async function removePermissionFromRole(callerId: number, roleId: number, permissionId: number): Promise<void>
{
    await runJudgedTransaction(async () =>
    {
        const role = await changeableRole(callerId, { roleId });

        await deleteOperatorMappings(role.id, [Number(permissionId)]);
    }, { context: 'auth:role-permissions' });
}

/**
 * Set a role's operator-owned permissions
 *
 * The role ends up with exactly `permissionIds`: mappings it
 * already has are kept with their owner, operator mappings left out are
 * removed, and new ones are the operator's. The configuration's mappings are
 * not the operator's to drop: leaving one out is a 409 and changes nothing.
 *
 * @param callerId - The person setting them: their role must rank above the role, and they must hold every permission added
 * @param roleId - Role ID
 * @param permissionIds - Array of permission IDs
 * @throws NotFoundError (404) when the role does not exist
 * @throws ForbiddenError (403) when the caller does not outrank the role or does not hold a permission added
 * @throws AuthorityContendedError (409) when the caller's role changed under the judgement twice
 * @throws ConfigOwnedMappingError (409) when a mapping the configuration declares is left out
 *
 * @example
 * ```typescript
 * await setRolePermissions(auth.userId, roleId, [1, 2, 3]);
 * ```
 */
export async function setRolePermissions(callerId: number, roleId: number, permissionIds: number[]): Promise<void>
{
    const wanted = new Set(permissionIds.map(Number));

    await runJudgedTransaction(async () =>
    {
        // What it confers is known only once the mappings are read under the role's lock
        const held = await holdAuthority(Number(callerId), { changed: Number(roleId) });
        const role = changedRole(held, Number(roleId));
        const existing = await rolePermissionsRepository.findByRoleIdOnPrimary(role.id);
        const mapped = new Set(existing.map(mapping => mapping.permissionId));
        const added = [...wanted].filter(permissionId => !mapped.has(permissionId));
        const dropped = existing.filter(mapping => !wanted.has(mapping.permissionId));

        assertAuthorityChangeAllowed(held, { roleId: role.id, conferred: added });
        assertOperatorOwned(dropped);

        await deleteOperatorMappings(role.id, dropped.map(mapping => mapping.permissionId));
        await rolePermissionsRepository.createMany(added.map(permissionId => ({ roleId: role.id, permissionId, source: OPERATOR_OWNED })));
    }, { context: 'auth:role-permissions' });
}

/**
 * Delete the role's operator mappings of `permissionIds`. The delete carries
 * the owner, and what it left is read again under the role's lock: a mapping
 * the configuration owns now — whatever the caller read before — is refused
 * and the transaction rolls back. A permission the role does not map is no
 * change.
 *
 * @throws ConfigOwnedMappingError (409)
 */
async function deleteOperatorMappings(roleId: number, permissionIds: number[]): Promise<void>
{
    const deleted = new Set(await rolePermissionsRepository.deleteOperatorOwned(roleId, permissionIds));
    const left = (await rolePermissionsRepository.findByRoleIdOnPrimary(roleId))
        .filter(mapping => permissionIds.includes(mapping.permissionId) && !deleted.has(mapping.permissionId));

    assertOperatorOwned(left);
}

/** @throws ConfigOwnedMappingError (409) when any of `mappings` is the configuration's */
function assertOperatorOwned(mappings: RolePermission[]): void
{
    const configOwned = mappings.filter(mapping => mapping.source === CONFIG_OWNED).map(mapping => mapping.permissionId);

    if (configOwned.length > 0)
    {
        throw new ConfigOwnedMappingError({ details: { roleId: mappings[0]!.roleId, permissionIds: configOwned } });
    }
}

/**
 * Get all roles
 *
 * @param includeInactive - Include inactive roles
 * @returns Array of roles
 *
 * @example
 * ```typescript
 * const roles = await getAllRoles();
 * ```
 */
export async function getAllRoles(includeInactive = false): Promise<Role[]>
{
    if (includeInactive)
    {
        return await rolesRepository.findAll();
    }

    return await rolesRepository.findActive();
}

/**
 * Get role by name
 *
 * @param name - Role name
 * @returns Role or null
 *
 * @example
 * ```typescript
 * const role = await getRoleByName('admin');
 * ```
 */
export async function getRoleByName(name: string): Promise<Role | null>
{
    return await rolesRepository.findByName(name);
}

/**
 * Get role permissions
 *
 * @param roleId - Role ID
 * @returns Array of permission names
 *
 * @example
 * ```typescript
 * const perms = await getRolePermissions(1n);
 * // ['user:read', 'user:write']
 * ```
 */
export async function getRolePermissions(roleId: number): Promise<string[]>
{
    const roleIdNum = Number(roleId);

    // Get role-permission mappings
    const mappings = await rolePermissionsRepository.findByRoleId(roleIdNum);

    if (mappings.length === 0)
    {
        return [];
    }

    // Get permissions by IDs
    const permissionIds = mappings.map(m => m.permissionId);
    const perms = await Promise.all(
        permissionIds.map(id => permissionsRepository.findById(id)),
    );

    // Filter out nulls and return names
    return perms
        .filter((p) => p !== null)
        .map(p => p.name);
}
