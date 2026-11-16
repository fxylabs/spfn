/**
 * @spfn/auth - Built-in Roles and Permissions
 *
 * Core roles and permissions required by the auth package
 * These cannot be deleted and are automatically created on initialization
 */

import type { RoleConfig, PermissionConfig } from './types';

/**
 * Built-in roles (required by package)
 * These roles are always created and cannot be deleted
 */
export const BUILTIN_ROLES: Record<string, RoleConfig> = {
    SUPERADMIN: {
        name: 'superadmin',
        displayName: 'Super Administrator',
        description: 'Full system access and RBAC management',
        priority: 100,
        isSystem: true,
        isBuiltin: true,
    },
    ADMIN: {
        name: 'admin',
        displayName: 'Administrator',
        description: 'User management and organization administration',
        priority: 80,
        isSystem: true,
        isBuiltin: true,
    },
    USER: {
        name: 'user',
        displayName: 'User',
        description: 'Default user role with basic permissions',
        priority: 10,
        isSystem: true,
        isBuiltin: true,
    },
} as const;

/**
 * Built-in permissions (required by package)
 * These permissions are always created and cannot be deleted
 */
export const BUILTIN_PERMISSIONS: Record<string, PermissionConfig> = {
    // Self-service auth management
    AUTH_SELF_MANAGE: {
        name: 'auth:self:manage',
        displayName: 'Manage Own Auth',
        description: 'Change own password, rotate keys, manage own sessions',
        category: 'auth',
        isSystem: true,
        isBuiltin: true,
    },

    // User management (admin functions)
    USER_READ: {
        name: 'user:read',
        displayName: 'Read Users',
        description: 'View user information and list users',
        category: 'user',
        isSystem: true,
        isBuiltin: true,
    },
    USER_WRITE: {
        name: 'user:write',
        displayName: 'Write Users',
        description: 'Create and update user accounts',
        category: 'user',
        isSystem: true,
        isBuiltin: true,
    },
    USER_DELETE: {
        name: 'user:delete',
        displayName: 'Delete Users',
        description: 'Delete user accounts',
        category: 'user',
        isSystem: true,
        isBuiltin: true,
    },
    USER_INVITE: {
        name: 'user:invite',
        displayName: 'Invite Users',
        description: 'Create and send user invitations',
        category: 'user',
        isSystem: true,
        isBuiltin: true,
    },

    // RBAC management (superadmin functions)
    RBAC_ROLE_MANAGE: {
        name: 'rbac:role:manage',
        displayName: 'Manage Roles',
        description: 'Create, update, and delete roles',
        category: 'rbac',
        isSystem: true,
        isBuiltin: true,
    },
    RBAC_PERMISSION_MANAGE: {
        name: 'rbac:permission:manage',
        displayName: 'Manage Permissions',
        description: 'Assign permissions to roles and users',
        category: 'rbac',
        isSystem: true,
        isBuiltin: true,
    },

    // Ops surface: issuing an ops token, and keeping it working — a token is
    // honoured only while its issuer still holds this
    OPS_TOKEN_ISSUE: {
        name: 'ops:token:issue',
        displayName: 'Issue Ops Tokens',
        description: 'Issue machine tokens for the ops surface; a token stops working when its issuer loses this',
        category: 'system',
        isSystem: true,
        isBuiltin: true,
    },
} as const;

/**
 * Built-in role-permission mappings
 * Defines default permissions for each built-in role
 */
export const BUILTIN_ROLE_PERMISSIONS: Record<string, string[]> = {
    superadmin: [
        'auth:self:manage',
        'user:read',
        'user:write',
        'user:delete',
        'user:invite',
        'rbac:role:manage',
        'rbac:permission:manage',
        'ops:token:issue',
    ],
    admin: [
        'auth:self:manage',
        'user:read',
        'user:write',
        'user:delete',
        'user:invite',
        'ops:token:issue',
    ],
    user: [
        'auth:self:manage',
    ],
} as const;

export type BuiltinRoleName = keyof typeof BUILTIN_ROLE_PERMISSIONS;
export type BuiltinPermissionName = typeof BUILTIN_PERMISSIONS[keyof typeof BUILTIN_PERMISSIONS]['name'];
