/**
 * @spfn/auth - Permission Middleware
 *
 * Middleware functions for permission-based access control
 *
 * The permissions checked are `resolveAuthority`'s, read on the primary: the
 * active permissions of the role in force (none for a deactivated role), plus
 * the person's own unexpired grants of active permissions, minus their own
 * unexpired revocations — the list `GET /_auth/session` reports.
 */

import type { Context, Next } from 'hono';
import { defineMiddleware } from '@spfn/core/route';
import { ForbiddenError } from '@spfn/core/errors';
import { InsufficientPermissionsError } from '@spfn/auth/errors';
import { getAuth, hasAllPermissions, hasAnyPermission, authLogger } from '@spfn/auth/server';

/**
 * Require user to have all specified permissions
 *
 * Must be used after authenticate middleware
 *
 * @param permissionNames - Permission names (e.g., 'user:delete', 'post:publish')
 * @returns Middleware function
 *
 * @example
 * ```typescript
 * // In route file
 * import { authenticate, requirePermissions } from '@spfn/auth/server/middleware';
 *
 * export const deleteUserRoute = route.delete('/users/:id')
 *   .use([authenticate, requirePermissions('user:delete')])
 *   .handler(async (c) => {
 *     // Only users with user:delete permission
 *   });
 *
 * // Multiple permissions (all required)
 * export const publishPostRoute = route.post('/posts/publish')
 *   .use([authenticate, requirePermissions('post:write', 'post:publish')])
 *   .handler(async (c) => {
 *     // Needs both permissions
 *   });
 *
 * // Skip permission check for specific route
 * export const publicRoute = route.get('/posts')
 *   .skip(['permission'])  // Type-safe skip
 *   .handler(async (c) => { ... });
 * ```
 */
export const requirePermissions = defineMiddleware('permission',
    (...permissionNames: string[]) => async (c: Context, next: Next) =>
    {
        const auth = getAuth(c);

        if (!auth)
        {
            authLogger.middleware.warn('Permission check failed: not authenticated', {
                permissions: permissionNames,
                path: c.req.path,
            });

            throw new ForbiddenError({ message: 'Authentication required' });
        }

        const { userId } = auth;

        const allowed = await hasAllPermissions(userId, permissionNames);

        if (!allowed)
        {
            authLogger.middleware.warn('Permission check failed', {
                userId,
                requiredPermissions: permissionNames,
                path: c.req.path,
            });

            throw new InsufficientPermissionsError({ requiredPermissions: permissionNames });
        }

        authLogger.middleware.debug('Permission check passed', {
            userId,
            permissions: permissionNames,
        });

        await next();
    },
);

/**
 * Require user to have at least one of the specified permissions
 *
 * Must be used after authenticate middleware
 *
 * @param permissionNames - Permission names
 * @returns Middleware function
 *
 * @example
 * ```typescript
 * // In route file
 * import { authenticate, requireAnyPermission } from '@spfn/auth/server/middleware';
 *
 * export const viewContentRoute = route.get('/content')
 *   .use([authenticate, requireAnyPermission('content:read', 'admin:access')])
 *   .handler(async (c) => {
 *     // User has either content:read OR admin:access
 *   });
 *
 * // Skip any permission check for specific route
 * export const publicRoute = route.get('/public')
 *   .skip(['anyPermission'])  // Type-safe skip
 *   .handler(async (c) => { ... });
 * ```
 */
export const requireAnyPermission = defineMiddleware('anyPermission',
    (...permissionNames: string[]) => async (c: Context, next: Next) =>
    {
        const auth = getAuth(c);

        if (!auth)
        {
            authLogger.middleware.warn('Any permission check failed: not authenticated', {
                permissions: permissionNames,
                path: c.req.path,
            });

            throw new ForbiddenError({ message: 'Authentication required' });
        }

        const { userId } = auth;
        const allowed = await hasAnyPermission(userId, permissionNames);
        if (!allowed)
        {
            authLogger.middleware.warn('Any permission check failed', {
                userId,
                requiredAnyOf: permissionNames,
                path: c.req.path,
            });

            throw new InsufficientPermissionsError({ requiredPermissions: permissionNames });
        }

        authLogger.middleware.debug('Any permission check passed', {
            userId,
            permissions: permissionNames,
        });

        await next();
    },
);
