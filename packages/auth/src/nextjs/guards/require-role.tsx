/**
 * RequireRole Guard Component
 *
 * Requires user to have at least one of the specified roles
 */

import { redirect } from 'next/navigation';
import { getSession } from '../session-helpers';
import { hasAnyRole } from './auth-utils';
import type { ReactNode } from 'react';

export interface RequireRoleProps
{
    /**
     * Required role(s) - user must have at least one
     */
    roles: string | string[];

    /**
     * Children to render if user has required role
     */
    children: ReactNode;

    /**
     * Path to redirect to if user doesn't have role
     * @default '/unauthorized'
     */
    redirectTo?: string;

    /**
     * Fallback UI to show instead of redirecting
     */
    fallback?: ReactNode;
}

/**
 * Require Role Guard
 *
 * Ensures user has at least one of the specified roles
 *
 * @example Single role
 * ```tsx
 * <RequireRole roles="admin">
 *   <AdminPanel />
 * </RequireRole>
 * ```
 *
 * @example Multiple roles (OR condition)
 * ```tsx
 * <RequireRole roles={['admin', 'manager']}>
 *   <ManagementDashboard />
 * </RequireRole>
 * ```
 *
 * @example With fallback
 * ```tsx
 * <RequireRole roles="admin" fallback={<AccessDenied />}>
 *   <AdminContent />
 * </RequireRole>
 * ```
 */
export async function RequireRole({
    roles,
    children,
    redirectTo = '/unauthorized',
    fallback,
}: RequireRoleProps)
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
    const requiredRoles = Array.isArray(roles) ? roles : [roles];

    // Check if user has any of the required roles
    const hasRole = await hasAnyRole(requiredRoles);

    if (!hasRole)
    {
        if (fallback)
        {
            return <>{fallback}</>;
        }

        redirect(redirectTo);
    }

    return <>{children}</>;
}
