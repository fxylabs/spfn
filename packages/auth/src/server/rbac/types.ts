/**
 * @spfn/auth - RBAC Type Definitions
 *
 * Type definitions for role and permission configuration
 */

import type { InstallableUserSettings } from '../lib/user-settings/registry';
import type { ProfileFieldsDeclaration } from '../lib/profile-fields';

/**
 * Permission category enum values
 * Single source of truth for permission categories
 */
export const PERMISSION_CATEGORIES = [
    'auth',      // Authentication & authorization
    'user',      // User management
    'rbac',      // Role & permission management
    'system',    // System administration
    'custom',     // App-specific categories
] as const;

/**
 * Permission category type derived from the const array
 */
export type PermissionCategory = typeof PERMISSION_CATEGORIES[number];

export interface RoleConfig
{
    // Role identifier (e.g., 'admin', 'editor', 'content-creator')
    name: string;

    // Display name for UI
    displayName: string;

    // Role description
    description?: string;

    // Priority level (higher = more privileged)
    // Default: 10 for custom roles
    priority?: number;

    // System role flag (defined in code vs runtime created)
    // Default: false for custom roles
    isSystem?: boolean;

    // Built-in role flag (core package roles that cannot be deleted)
    // Internal use only - set by package
    isBuiltin?: boolean;
}

export interface PermissionConfig
{
    // Permission identifier (e.g., 'user:delete', 'post:publish')
    name: string;

    // Display name for UI
    displayName: string;

    // Permission description
    description?: string;

    // Category for grouping (e.g., 'user', 'auth', 'rbac', 'custom', 'system')
    category?: PermissionCategory;

    // System permission flag
    // Default: false for custom permissions
    isSystem?: boolean;

    // Built-in permission flag (core package permissions)
    // Internal use only - set by package
    isBuiltin?: boolean;
}

export interface AuthInitOptions
{
    /**
     * Additional roles to create
     * Built-in roles (user, admin, superadmin) are automatically included
     */
    roles?: RoleConfig[];

    /**
     * Additional permissions to create
     * Built-in permissions are automatically included
     */
    permissions?: PermissionConfig[];

    /**
     * Role-Permission mappings
     * Built-in mappings are automatically included
     * You can extend built-in roles or define mappings for custom roles
     *
     * @example
     * ```typescript
     * {
     *   // Extend built-in admin role
     *   admin: ['project:create', 'project:delete'],
     *
     *   // Define custom role permissions
     *   'project-manager': ['project:create', 'task:assign'],
     * }
     * ```
     */
    rolePermissions?: Record<string, string[]>;

    /**
     * Default role name for new users
     * Must be a valid role name that exists after initialization
     * @default 'user'
     */
    defaultRole?: string;

    /**
     * Default session TTL (Time To Live)
     *
     * Supports:
     * - Number: seconds (e.g., 2592000)
     * - String: duration format ('30d', '12h', '45m', '3600s')
     *
     * Can be overridden at runtime with `remember` parameter.
     *
     * @default '7d' (7 days)
     *
     * @example
     * ```typescript
     * {
     *   sessionTtl: '30d',  // 30 days
     * }
     * ```
     */
    sessionTtl?: string | number;

    /**
     * Per-person settings the app declares, from `defineUserSettings`
     *
     * Installed once, when auth initializes; a second install, or one after
     * boot completed, throws. Without it only the built-in keys exist
     * (`locale`, `timezone`).
     *
     * @example
     * ```typescript
     * createAuthLifecycle({ userSettings: USER_SETTINGS });
     * ```
     */
    userSettings?: InstallableUserSettings;

    /**
     * The keys `user_profiles.metadata` may hold, from `defineProfileFields`
     *
     * With it, a profile PATCH's `metadata` is merged key by key and checked
     * against the declaration, and readers see only declared keys. Without it,
     * `metadata` stays free-form and is replaced wholesale. Installed once,
     * like `userSettings`.
     */
    profileFields?: ProfileFieldsDeclaration;
}
