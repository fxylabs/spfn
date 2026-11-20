/**
 * @spfn/auth - Role Guard Middleware
 *
 * Middleware for role-based access control with allow/deny options
 */

import type { Context, Next } from 'hono';
import { defineMiddlewareFactory } from '@spfn/core/route';
import { getAuth, authLogger } from '@spfn/auth/server';
import { ForbiddenError } from '@spfn/core/errors';
import { InsufficientRoleError } from '@spfn/auth/errors';

/**
 * Role guard options
 */
export interface RoleGuardOptions
{
    /**
     * Roles to allow (OR condition)
     * User must have at least one of these roles
     */
    allow?: string[];

    /**
     * Roles to deny
     * User with any of these roles will be rejected
     */
    deny?: string[];
}

/**
 * Role-based access control middleware
 *
 * Must be used after authenticate middleware
 *
 * @param options - Role guard options (allow/deny)
 * @returns Middleware function
 *
 * @example Allow specific roles
 * ```typescript
 * export const adminRoute = route.get('/admin')
 *   .use([authenticate, roleGuard({ allow: ['admin', 'superadmin'] })])
 *   .handler(async (c) => { ... });
 * ```
 *
 * @example Deny specific roles
 * ```typescript
 * export const publicRoute = route.get('/content')
 *   .use([authenticate, roleGuard({ deny: ['banned', 'suspended'] })])
 *   .handler(async (c) => { ... });
 * ```
 *
 * @example Combined allow and deny
 * ```typescript
 * export const managerRoute = route.get('/manage')
 *   .use([authenticate, roleGuard({ allow: ['admin', 'manager'], deny: ['suspended'] })])
 *   .handler(async (c) => { ... });
 * ```
 */
export const roleGuard = defineMiddlewareFactory('roleGuard',
    (options: RoleGuardOptions) => async (c: Context, next: Next) =>
    {
        const { allow, deny } = options;

        // Validate options
        if (!allow && !deny)
        {
            throw new Error('roleGuard requires at least one of: allow, deny');
        }

        const auth = getAuth(c);

        if (!auth)
        {
            authLogger.middleware.warn('Role guard failed: not authenticated', {
                path: c.req.path,
            });
            throw new ForbiddenError({ message: 'Authentication required' });
        }

        const { userId, role: userRole } = auth;

        // 1. Check deny list first
        if (deny && deny.length > 0)
        {
            if (userRole && deny.includes(userRole))
            {
                authLogger.middleware.warn('Role guard denied', {
                    userId,
                    userRole,
                    deniedRoles: deny,
                    path: c.req.path,
                });
                throw new InsufficientRoleError({ requiredRoles: allow || [] });
            }
        }

        // 2. Check allow list (if specified)
        if (allow && allow.length > 0)
        {
            if (!userRole || !allow.includes(userRole))
            {
                authLogger.middleware.warn('Role guard failed: role not allowed', {
                    userId,
                    userRole,
                    allowedRoles: allow,
                    path: c.req.path,
                });
                throw new InsufficientRoleError({ requiredRoles: allow });
            }
        }

        // 3. If only deny is specified and user passed, allow access
        authLogger.middleware.debug('Role guard passed', {
            userId,
            userRole,
            allow,
            deny,
        });

        await next();
    },
);
