/**
 * RequirePermission Guard Component
 *
 * Requires user to have at least one of the specified permissions
 */

import { redirect } from 'next/navigation';
import { getSession } from '../session-helpers';
import { hasAnyPermission } from './auth-utils';
import type { ReactNode } from 'react';

export interface RequirePermissionProps
{
    /**
     * Required permission(s) - user must have at least one
     */
    permissions: string | string[];

    /**
     * Children to render if user has required permission
     */
    children: ReactNode;

    /**
     * Path to redirect to if user doesn't have permission
     * @default '/unauthorized'
     */
    redirectTo?: string;

    /**
     * Fallback UI to show instead of redirecting
     */
    fallback?: ReactNode;
}

/**
 * Require Permission Guard
 *
 * Ensures user has at least one of the specified permissions
 *
 * @example Single permission
 * ```tsx
 * <RequirePermission permissions="user:delete">
 *   <DeleteUserButton />
 * </RequirePermission>
 * ```
 *
 * @example Multiple permissions (OR condition)
 * ```tsx
 * <RequirePermission permissions={['user:delete', 'user:update']}>
 *   <UserManagement />
 * </RequirePermission>
 * ```
 *
 * @example With fallback
 * ```tsx
 * <RequirePermission permissions="project:create" fallback={<UpgradePrompt />}>
 *   <CreateProject />
 * </RequirePermission>
 * ```
 */
export async function RequirePermission({
    permissions,
    children,
    redirectTo = '/unauthorized',
    fallback,
}: RequirePermissionProps)
{
    const session = await getSession();

    // Not authenticated
    if (!session)
    {
        if (fallback)
        {
            return <>{fallback}</>;
        }

        redirect('/login');
    }

    // Normalize to array
    const requiredPermissions = Array.isArray(permissions) ? permissions : [permissions];

    // Check if user has any of the required permissions
    const hasPermission = await hasAnyPermission(requiredPermissions);

    if (!hasPermission)
    {
        if (fallback)
        {
            return <>{fallback}</>;
        }

        redirect(redirectTo);
    }

    return <>{children}</>;
}
