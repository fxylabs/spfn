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

import { optionKeys, readList, readOptions } from '../lib/stated-options';

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
export const roleGuard = defineMiddlewareFactory('roleGuard', (options: RoleGuardOptions) =>
{
    // Read once, here, not on each request: a misspelt `alow` is refused when
    // the route is defined, and a getter cannot answer one request differently
    // from the next. Each list is read into a copy, so a later change to the
    // application's array changes nothing either (#477).
    const read = readOptions<RoleGuardOptions>('roleGuard', options, optionKeys<RoleGuardOptions>({ allow: true, deny: true }));
    const allow = read.allow === undefined ? undefined : readList<string>('roleGuard.allow', read.allow, 'of role names');
    const deny = read.deny === undefined ? undefined : readList<string>('roleGuard.deny', read.deny, 'of role names');

    return async (c: Context, next: Next) =>
    {
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
                throw new InsufficientRoleError({ requiredRoles: [...allow ?? []] });
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
                throw new InsufficientRoleError({ requiredRoles: [...allow] });
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
    };
});
