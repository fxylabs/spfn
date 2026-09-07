/**
 * @spfn/auth - RBAC Initialization Service
 *
 * Initialize roles, permissions, and their mappings
 * Uses hash-based change detection to skip unnecessary DB operations
 */

import { createHash } from 'crypto';
import {
    rolesRepository,
    permissionsRepository,
    rolePermissionsRepository,
    authMetadataRepository,
} from '../repositories';
import {
    BUILTIN_ROLES,
    BUILTIN_PERMISSIONS,
    BUILTIN_ROLE_PERMISSIONS,
} from '../rbac';
import type { AuthInitOptions, RoleConfig, PermissionConfig } from '../rbac';
import { assertPasskeyConfig, configureAuth } from '../lib/config';
import { authLogger } from '../logger';
import type { RoleEntity } from '../entities/roles';
import type { PermissionEntity } from '../entities/permissions';

const RBAC_HASH_KEY = 'rbac_config_hash';

/**
 * Compute SHA-256 hash of RBAC configuration
 */
function computeConfigHash(
    allRoles: RoleConfig[],
    allPermissions: PermissionConfig[],
    allMappings: Record<string, string[]>,
): string
{
    const payload = JSON.stringify({
        roles: allRoles
            .map(r => ({ name: r.name, displayName: r.displayName, description: r.description, priority: r.priority, isSystem: r.isSystem, isBuiltin: r.isBuiltin }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        permissions: allPermissions
            .map(p => ({ name: p.name, displayName: p.displayName, description: p.description, category: p.category, isSystem: p.isSystem, isBuiltin: p.isBuiltin }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        mappings: Object.keys(allMappings)
            .sort()
            .reduce((acc, key) =>
            {
                acc[key] = [...allMappings[key]].sort();

                return acc;
            }, {} as Record<string, string[]>),
    });

    return createHash('sha256').update(payload).digest('hex');
}

/**
 * Collect merged role-permission mappings from built-in + custom
 */
function collectMappings(options: AuthInitOptions): Record<string, string[]>
{
    const allMappings: Record<string, string[]> = { ...BUILTIN_ROLE_PERMISSIONS };

    if (options.rolePermissions)
    {
        for (const [roleName, permNames] of Object.entries(options.rolePermissions))
        {
            if (allMappings[roleName])
            {
                allMappings[roleName] = [
                    ...new Set([...allMappings[roleName], ...permNames]),
                ];
            }
            else
            {
                allMappings[roleName] = permNames;
            }
        }
    }

    return allMappings;
}

/**
 * Initialize auth package with RBAC system
 *
 * Creates built-in roles, permissions, and custom configurations.
 * Uses hash-based change detection - skips DB operations when config is unchanged.
 *
 * @param options - Initialization options
 *
 * @example
 * ```typescript
 * // Minimal - only built-in roles (user, admin, superadmin)
 * await initializeAuth();
 *
 * // Custom roles and permissions
 * await initializeAuth({
 *   roles: [
 *     { name: 'project-manager', displayName: 'Project Manager', priority: 50 },
 *     { name: 'developer', displayName: 'Developer', priority: 30 },
 *   ],
 *   permissions: [
 *     { name: 'project:create', displayName: 'Create Project', category: 'project' },
 *     { name: 'task:assign', displayName: 'Assign Task', category: 'task' },
 *   ],
 *   rolePermissions: {
 *     'project-manager': ['project:create', 'task:assign'],
 *     'developer': ['task:complete'],
 *   },
 * });
 * ```
 */
export async function initializeAuth(options: AuthInitOptions = {}): Promise<void>
{
    authLogger.service.info('🔐 Initializing RBAC system...');

    // Before anything is written: a passkey configuration no ceremony could
    // satisfy makes every passkey operation fail, and the drift is between
    // environments, so the deploy that introduces it is where it has to surface.
    assertPasskeyConfig();

    // Configure global auth settings
    if (options.sessionTtl !== undefined)
    {
        configureAuth({
            sessionTtl: options.sessionTtl,
        });
        authLogger.service.info(`⏱️  Session TTL: ${options.sessionTtl}`);
    }

    // 1. Collect all configs
    const allRoles: RoleConfig[] = [
        ...Object.values(BUILTIN_ROLES),
        ...(options.roles || []),
    ];

    const allPermissions: PermissionConfig[] = [
        ...Object.values(BUILTIN_PERMISSIONS),
        ...(options.permissions || []),
    ];

    const allMappings = collectMappings(options);

    // 2. Compute hash and compare with stored hash
    const configHash = computeConfigHash(allRoles, allPermissions, allMappings);
    const storedHash = await authMetadataRepository.get(RBAC_HASH_KEY);

    if (storedHash === configHash)
    {
        authLogger.service.info('✅ RBAC config unchanged, skipping initialization');

        return;
    }

    authLogger.service.info('🔄 RBAC config changed, applying updates...');

    // 3. Batch fetch existing data (3 queries instead of ~30)
    const existingRoles = await rolesRepository.findAll();
    const existingPermissions = await permissionsRepository.findAll();

    const rolesByName = new Map(existingRoles.map(r => [r.name, r]));
    const permsByName = new Map(existingPermissions.map(p => [p.name, p]));

    // 4. Sync roles
    await syncRoles(allRoles, rolesByName);

    // 5. Sync permissions
    await syncPermissions(allPermissions, permsByName);

    // 6. Refetch roles/permissions to get IDs for newly created ones
    const updatedRoles = await rolesRepository.findAll();
    const updatedPermissions = await permissionsRepository.findAll();

    const updatedRolesByName = new Map(updatedRoles.map(r => [r.name, r]));
    const updatedPermsByName = new Map(updatedPermissions.map(p => [p.name, p]));

    // 7. Sync role-permission mappings
    await syncMappings(allMappings, updatedRolesByName, updatedPermsByName);

    // 8. Store the new hash
    await authMetadataRepository.set(RBAC_HASH_KEY, configHash);

    authLogger.service.info('✅ RBAC initialization complete');
    authLogger.service.info(`📊 Roles: ${allRoles.length}, Permissions: ${allPermissions.length}`);
    authLogger.service.info('🔒 Built-in roles: user, admin, superadmin');
}

/**
 * Sync roles: create missing, update existing
 */
async function syncRoles(
    configs: RoleConfig[],
    existingByName: Map<string, RoleEntity>,
): Promise<void>
{
    for (const config of configs)
    {
        const existing = existingByName.get(config.name);

        if (!existing)
        {
            await rolesRepository.create({
                name: config.name,
                displayName: config.displayName,
                description: config.description || null,
                priority: config.priority ?? 10,
                isSystem: config.isSystem ?? false,
                isBuiltin: config.isBuiltin ?? false,
                isActive: true,
            });

            authLogger.service.info(`  ✅ Created role: ${config.name}`);
        }
        else
        {
            const updateData: any = {
                displayName: config.displayName,
                description: config.description || null,
            };

            if (!existing.isBuiltin)
            {
                updateData.priority = config.priority ?? existing.priority;
            }

            await rolesRepository.updateById(existing.id, updateData);
        }
    }
}

/**
 * Sync permissions: create missing, update existing
 */
async function syncPermissions(
    configs: PermissionConfig[],
    existingByName: Map<string, PermissionEntity>,
): Promise<void>
{
    for (const config of configs)
    {
        const existing = existingByName.get(config.name);

        if (!existing)
        {
            await permissionsRepository.create({
                name: config.name,
                displayName: config.displayName,
                description: config.description || null,
                category: config.category || null,
                isSystem: config.isSystem ?? false,
                isBuiltin: config.isBuiltin ?? false,
                isActive: true,
                metadata: null,
            });

            authLogger.service.info(`  ✅ Created permission: ${config.name}`);
        }
        else
        {
            await permissionsRepository.updateById(existing.id, {
                displayName: config.displayName,
                description: config.description || null,
                category: config.category || null,
            });
        }
    }
}

/**
 * Sync role-permission mappings
 */
async function syncMappings(
    allMappings: Record<string, string[]>,
    rolesByName: Map<string, RoleEntity>,
    permsByName: Map<string, PermissionEntity>,
): Promise<void>
{
    for (const [roleName, permNames] of Object.entries(allMappings))
    {
        const role = rolesByName.get(roleName);

        if (!role)
        {
            authLogger.service.warn(`  ⚠️  Role not found: ${roleName}, skipping permission assignment`);
            continue;
        }

        const existingMappings = await rolePermissionsRepository.findByRoleId(role.id);
        const existingPermIds = new Set(existingMappings.map(m => m.permissionId));

        const newMappings = permNames
            .map(name => permsByName.get(name))
            .filter((perm): perm is PermissionEntity => perm != null)
            .filter(perm => !existingPermIds.has(perm.id))
            .map(perm => ({
                roleId: role.id,
                permissionId: perm.id,
            }));

        if (newMappings.length > 0)
        {
            await rolePermissionsRepository.createMany(newMappings);
        }
    }
}
