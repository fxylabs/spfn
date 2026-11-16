/**
 * @spfn/auth - Role-Permissions Mapping Entity
 *
 * Many-to-many relationship between roles and permissions
 *
 * Usage:
 * - Defines which permissions each role has
 * - Cascade delete when role or permission is deleted
 */

import { index, text, unique } from 'drizzle-orm/pg-core';
import { id, timestamps, foreignKey } from '@spfn/core/db';
import { roles } from './roles';
import { permissions } from './permissions';
import { authSchema } from './schema';
import { AUTHORITY_SOURCES, CONFIG_OWNED, OPERATOR_OWNED, type AuthoritySource } from './ownership';

/** Where a role→permission mapping came from — see the `source` column and `./ownership`. */
export const ROLE_PERMISSION_SOURCES = AUTHORITY_SOURCES;

export type RolePermissionSource = AuthoritySource;

export { CONFIG_OWNED, OPERATOR_OWNED };

export const rolePermissions = authSchema.table('role_permissions',
    {
        // Primary key
        id: id(),

        // Role reference
        // Foreign key to roles table
        // Cascade delete: when role is deleted, all role-permission mappings are removed
        // Used for: defining which permissions each role has
        // Example: Admin role → [user:create, user:delete, user:update]
        roleId: foreignKey('role', () => roles.id, { onDelete: 'cascade' }),

        // Permission reference
        // Foreign key to permissions table
        // Cascade delete: when permission is deleted, all role-permission mappings are removed
        // Used for: granting permissions to roles
        // Example: user:delete permission → [Admin, Superadmin]
        permissionId: foreignKey('permission', () => permissions.id, { onDelete: 'cascade' }),

        // Who owns the mapping. 'config': `initializeAuth` keeps it equal to the
        // app's role configuration, removing it when the configuration drops it.
        // 'admin': an operator added it through the role service, and boot
        // leaves it alone. Rows from before the column existed are 'config'.
        source: text('source', { enum: ROLE_PERMISSION_SOURCES }).notNull().default('config'),

        ...timestamps(),
    },
    (table) => [
        // Indexes for query performance
        index('role_permissions_role_id_idx').on(table.roleId),
        index('role_permissions_permission_id_idx').on(table.permissionId),

        // Unique constraint: one role-permission pair only
        unique('role_permissions_unique').on(table.roleId, table.permissionId),
    ],
);

// Type exports
export type RolePermission = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;
