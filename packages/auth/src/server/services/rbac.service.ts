/**
 * @spfn/auth - RBAC Initialization Service
 *
 * Initialize roles, permissions, and their mappings
 *
 * **What the configuration declares is the configuration's**, for roles,
 * permissions and mappings alike, and every boot makes it equal to the
 * configuration — whether or not the configuration changed, so whatever
 * changed it at runtime, by any means, is undone by the next boot:
 *
 * - a role's name, display name, description, priority and built-in/system
 *   flags (`RoleConfig`), and its ownership (`source = 'config'`); a role the
 *   configuration stops declaring is handed to the operator (`'admin'`);
 * - a permission's name, display name, description, category and
 *   built-in/system flags (`PermissionConfig`);
 * - the role→permission mappings it declares, removals included.
 *
 * `isActive` is never the configuration's: set on creation, then the
 * operator's. Roles and mappings an operator created are left alone unless the
 * configuration comes to declare them, which makes them the configuration's.
 *
 * **One sync at a time, in one transaction.** The role sync, the permission
 * sync, the release of undeclared roles and the mapping sync run in one
 * transaction (`syncConfiguration`), which first takes a lock across instances
 * (`rolesRepository.lockConfigSync`): a second boot's sync starts once the
 * first one's has committed, so after a rolling deploy that boots two
 * configurations side by side, what the configuration owns is exactly the
 * configuration of the boot that synced last — never a mix of the two. The
 * lock and the sync share that transaction's one connection: a write pool of
 * one connection (`DB_POOL_MAX=1`) boots like any other.
 *
 * **What the transaction holds, and for how long.** From its start to its
 * commit — the length of one sync, a few dozen statements — it holds the sync
 * lock, which only another boot's sync waits for; every role it writes or
 * maps, `FOR NO KEY UPDATE` or `FOR SHARE`, taken in one call in id order
 * (`holdSyncedRoles`), the rule every operator's role change follows
 * (`rolesRepository.lockInIdOrder`); the permissions it declares; and the
 * mappings it writes. So an operator's change or judgement of one of those
 * roles queues behind a boot's sync, and the two never deadlock: neither
 * takes a role lock out of id order. The operator's wait is bounded by its
 * own transaction's `statement_timeout` (`runInTransaction`'s `timeout`,
 * 30 s by default, `TRANSACTION_TIMEOUT`); the boot's waits — for another
 * boot's sync, and for an operator's role lock — each by the sync's
 * `lock_timeout` of `CONFIG_SYNC_WAIT_MS`; a wait that runs out refuses the
 * boot with `RbacSyncBusyError`, naming which lock and who holds it. A signup
 * naming a role (its foreign key's `FOR KEY SHARE`) does not wait for the sync.
 *
 * Every write is an upsert that skips a row already equal, so an unchanged
 * configuration writes nothing. That is what the configuration hash
 * (`auth_metadata.rbac_config_hash`) used to buy by skipping the catalogue;
 * it also skipped restoring it, so it is gone. The stored key is left in place
 * and no longer read.
 */

import { runInTransaction } from '@spfn/core/db';
import { RbacSyncBusyError } from '@spfn/auth/errors';
import {
    rolesRepository,
    permissionsRepository,
    rolePermissionsRepository,
} from '../repositories';
import {
    BUILTIN_ROLES,
    BUILTIN_PERMISSIONS,
    BUILTIN_ROLE_PERMISSIONS,
} from '../rbac';
import type { AuthInitOptions, RoleConfig, PermissionConfig } from '../rbac';
import { assertPasskeyConfig, configureAuth } from '../lib/config';
import { authLogger } from '../logger';
import { isLockTimeout } from '../lib/lock-timeout';
import { installUserSettings, sealUserSettings } from '../lib/user-settings/registry';
import { installProfileFields, sealProfileFields } from '../lib/profile-fields';
import { reconcileUserSettings } from './user-settings.service';
import { reconcileProfileFields } from './user-profile.service';
import type { Role } from '../entities/roles';
import { CONFIG_OWNED } from '../entities/ownership';
import type { PermissionEntity } from '../entities/permissions';
import type { DeclaredRole, LockHolder } from '../repositories/roles.repository';
import type { DeclaredPermission } from '../repositories/permissions.repository';
import type { MappingIds } from '../repositories/role-permissions.repository';

const DEFAULT_ROLE_PRIORITY = 10;

/** How long a boot waits for another instance's configuration sync — or any other lock the sync needs — before refusing. */
const CONFIG_SYNC_WAIT_MS = 30_000;

/** The sync's `statement_timeout`: past `CONFIG_SYNC_WAIT_MS`, so a lock wait that runs out is the typed refusal, not a cancellation. */
const CONFIG_SYNC_STATEMENT_TIMEOUT_MS = 2 * CONFIG_SYNC_WAIT_MS;

/** What one boot's configuration declares, one entry per name. */
interface DeclaredConfiguration
{
    roles: DeclaredRole[];
    permissions: DeclaredPermission[];
    mappings: Record<string, string[]>;
}

/**
 * A role the configuration declares was created after the sync read the
 * roles, so the sync could not lock it in id order: the sync is made again
 * from the top, once, on a fresh read.
 */
class StaleRoleRead extends Error
{
    constructor(roleName: string)
    {
        super(`Role ${roleName} was created while the RBAC configuration sync ran, twice; start this instance again`);
    }
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
 * Creates built-in roles, permissions, and custom configurations, and on every
 * call makes what the configuration declares — roles, permissions, mappings —
 * equal to it (see the module comment for which fields that covers).
 * Installs the app's per-person settings and profile field declarations
 * (`options.userSettings`, `options.profileFields`) and reports stored keys
 * neither declares; once this completes, no declaration can be installed any more.
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
    installDeclarations(options);
    await reconcileUserSettings();
    await reconcileProfileFields();
    await applyRbacConfig(options);
    sealUserSettings();
    sealProfileFields();
}

function installDeclarations(options: AuthInitOptions): void
{
    if (options.userSettings)
    {
        installUserSettings(options.userSettings);
    }
    if (options.profileFields)
    {
        installProfileFields(options.profileFields);
    }
}

/**
 * The RBAC half of `initializeAuth`: roles, permissions and their mappings
 */
async function applyRbacConfig(options: AuthInitOptions): Promise<void>
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

    const allRoles: RoleConfig[] = [
        ...Object.values(BUILTIN_ROLES),
        ...(options.roles || []),
    ];

    const allPermissions: PermissionConfig[] = [
        ...Object.values(BUILTIN_PERMISSIONS),
        ...(options.permissions || []),
    ];

    await syncConfiguration({
        roles: lastByName(allRoles).map(declaredRole),
        permissions: lastByName(allPermissions).map(declaredPermission),
        mappings: collectMappings(options),
    });

    authLogger.service.info('✅ RBAC initialization complete');
    authLogger.service.info(`📊 Roles: ${allRoles.length}, Permissions: ${allPermissions.length}`);
    authLogger.service.info('🔒 Built-in roles: user, admin, superadmin');
}

/**
 * Everything the configuration declares, in one transaction under the sync
 * lock (see the module comment for what it holds), made again once from the
 * top should a declared role appear after its read (`StaleRoleRead`).
 *
 * @throws RbacSyncBusyError when a lock wait of the sync ran out — for
 *   another instance's sync, or for a role a running change holds — naming
 *   the lock and who holds it
 */
async function syncConfiguration(config: DeclaredConfiguration): Promise<void>
{
    const attempt = () => runInTransaction(async () =>
    {
        await rolesRepository.lockConfigSync(CONFIG_SYNC_WAIT_MS);
        const roles = await syncRoles(config);
        await permissionsRepository.upsertDeclared(config.permissions);
        await releaseUndeclared(roles, config.roles);
        await syncMappings(config.mappings, roles);
    }, { context: 'auth:rbac-sync', timeout: CONFIG_SYNC_STATEMENT_TIMEOUT_MS }).catch(refuseLockTimeout);

    await attempt().catch((error: unknown) => error instanceof StaleRoleRead ? attempt() : Promise.reject(error));
}

/**
 * A lock wait of the sync that ran out, as the boot's refusal: the sync lock
 * (`lockConfigSync` answers it typed) or, for any other lock, a role row.
 * The waiter's transaction is rolled back by now, so the holders are looked up
 * as they are after it. Anything else as it is.
 */
async function refuseLockTimeout(error: unknown): Promise<never>
{
    if (error instanceof RbacSyncBusyError)
    {
        throw await configSyncBusy();
    }

    throw isLockTimeout(error) ? await roleLockBusy() : error;
}

async function configSyncBusy(): Promise<RbacSyncBusyError>
{
    const holder = await rolesRepository.findConfigSyncHolder();

    return new RbacSyncBusyError({
        message: `Boot refused: another instance's RBAC configuration sync held its lock for ${CONFIG_SYNC_WAIT_MS} ms (${holder ? describeHolder(holder) : 'an instance that has released it since'}). Start this instance again once that one is up.`,
        details: { lock: 'configSync', waitedMs: CONFIG_SYNC_WAIT_MS, holder },
    });
}

async function roleLockBusy(): Promise<RbacSyncBusyError>
{
    const holders = await rolesRepository.findRoleLockHolders();
    const who = holders.length > 0 ? `role rows held by ${holders.map(describeHolder).join('; ')}` : 'released since';

    return new RbacSyncBusyError({
        message: `Boot refused: the RBAC configuration sync waited ${CONFIG_SYNC_WAIT_MS} ms for a role row held by a running change (${who}). Start this instance again once that change is done.`,
        details: { lock: 'role', waitedMs: CONFIG_SYNC_WAIT_MS, holders },
    });
}

function describeHolder(holder: LockHolder): string
{
    return `backend pid ${holder.pid}, application '${holder.applicationName}', client ${holder.clientAddress ?? 'local socket'}, in a transaction since ${holder.since?.toISOString() ?? 'unknown'}`;
}

/**
 * Lock every existing role the sync writes or maps, in one call, in id order
 * (`rolesRepository.lockInIdOrder`): `noKeyUpdate` for a role it declares or
 * owns — its declared fields or its owner are written — and `share` for one
 * it only maps. After this call the sync takes no lock on an existing role:
 * each write below meets a role it holds.
 *
 * @returns the roles held, by name
 */
async function holdSyncedRoles(config: DeclaredConfiguration): Promise<Map<string, Role>>
{
    const declared = new Set(config.roles.map(role => role.name));
    const existing = await rolesRepository.findAllOnPrimary();
    const idsOf = (pick: (role: Role) => boolean) => existing.filter(pick).map(role => role.id);
    const held = await rolesRepository.lockInIdOrder({
        noKeyUpdate: idsOf(role => declared.has(role.name) || role.source === CONFIG_OWNED),
        share: idsOf(role => Object.hasOwn(config.mappings, role.name)),
    });

    return new Map(held.map(role => [role.name, role]));
}

/**
 * Each declared role made equal to its declaration: one held is updated in
 * place (`upsertDeclared`), one that did not exist is inserted
 * (`insertDeclared`). Statement order does not matter here: no statement
 * waits on another transaction's role.
 *
 * @returns every role the sync may map, by name: those held, and those inserted
 * @throws StaleRoleRead when a declared role was created since the read
 */
async function syncRoles(config: DeclaredConfiguration): Promise<Map<string, Role>>
{
    const roles = await holdSyncedRoles(config);

    for (const role of config.roles.filter(declared => roles.has(declared.name)))
    {
        await rolesRepository.upsertDeclared(role);
    }

    for (const role of config.roles.filter(declared => !roles.has(declared.name)))
    {
        roles.set(role.name, await insertedOrStale(role));
    }

    return roles;
}

/** @throws StaleRoleRead when the role was created since the sync read the roles */
async function insertedOrStale(role: DeclaredRole): Promise<Role>
{
    const inserted = await rolesRepository.insertDeclared(role);

    if (!inserted)
    {
        throw new StaleRoleRead(role.name);
    }

    return inserted;
}

/** Hand the roles the configuration owns and no longer declares — all held — to the operator. */
async function releaseUndeclared(roles: Map<string, Role>, declaredRoles: DeclaredRole[]): Promise<void>
{
    const declaredNames = declaredRoles.map(role => role.name);
    const undeclared = [...roles.values()]
        .filter(role => role.source === CONFIG_OWNED && !declaredNames.includes(role.name))
        .map(role => role.id);

    for (const name of await rolesRepository.releaseUndeclared(undeclared, declaredNames))
    {
        authLogger.service.info(`  ↪️  Role ${name} is no longer in the configuration: it is the operator's now`);
    }
}

/** One entry per name, the last declaration winning — one upsert may not touch a row twice. */
function lastByName<T extends { name: string }>(entries: T[]): T[]
{
    return [...new Map(entries.map(entry => [entry.name, entry])).values()];
}

function declaredRole(config: RoleConfig): DeclaredRole
{
    return {
        name: config.name,
        displayName: config.displayName,
        description: config.description || null,
        priority: config.priority ?? DEFAULT_ROLE_PRIORITY,
        isSystem: config.isSystem ?? false,
        isBuiltin: config.isBuiltin ?? false,
    };
}

function declaredPermission(config: PermissionConfig): DeclaredPermission
{
    return {
        name: config.name,
        displayName: config.displayName,
        description: config.description || null,
        category: config.category || null,
        isSystem: config.isSystem ?? false,
        isBuiltin: config.isBuiltin ?? false,
    };
}

/**
 * Make the configuration's role→permission mappings exactly the configured
 * ones, each step one statement that says its result: upsert what it declares
 * (`ON CONFLICT … SET source = 'config'`, taking over an operator's mapping it
 * declares), then delete what it owns and no longer declares
 * (`WHERE source = 'config'`). An operator's mapping it does not declare is
 * never matched.
 *
 * In the sync's transaction, on roles all held (`holdSyncedRoles`) or
 * inserted by it: an operator's change of a role's mappings holds that role
 * `FOR UPDATE`, so the two queue on the role instead of each waiting on a row
 * the other wrote — the boot's foreign-key check on the role, the operator's
 * insert on the boot's uncommitted mapping — which Postgres would answer by
 * aborting one. A role created since the sync read the roles is not mapped by
 * this boot, as if it had been created just after it.
 */
async function syncMappings(allMappings: Record<string, string[]>, rolesByName: Map<string, Role>): Promise<void>
{
    const permsByName = new Map((await permissionsRepository.findAllOnPrimary()).map(permission => [permission.name, permission]));
    const declared = declaredMappings(allMappings, rolesByName, permsByName);

    await rolePermissionsRepository.upsertConfigOwned(declared);

    for (const mapping of await rolePermissionsRepository.deleteConfigOwnedExcept(declared))
    {
        authLogger.service.info(`  ➖ Removed permission ${mapping.permissionId} from role ${mapping.roleId}: no longer in the configuration`);
    }
}

/** The configured mappings as ids, skipping (with a warning) a role that does not exist. */
function declaredMappings(
    allMappings: Record<string, string[]>,
    rolesByName: Map<string, Role>,
    permsByName: Map<string, PermissionEntity>,
): MappingIds[]
{
    return Object.entries(allMappings).flatMap(([roleName, permNames]) =>
    {
        const role = rolesByName.get(roleName);

        if (!role)
        {
            authLogger.service.warn(`  ⚠️  Role not found: ${roleName}, skipping permission assignment`);

            return [];
        }

        return permNames
            .map(name => permsByName.get(name))
            .filter((perm): perm is PermissionEntity => perm != null)
            .map(perm => ({ roleId: role.id, permissionId: perm.id }));
    });
}
