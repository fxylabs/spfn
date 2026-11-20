/**
 * @spfn/auth - One route, two credentials
 *
 * An operator action is scripted today (the CLI, holding an ops token) and
 * driven from an admin console tomorrow (a browser, holding a user session).
 * That is one route with two admissible credentials, and neither existing
 * middleware admits both: `authenticate` refuses an `spfn_ops_` bearer before
 * any scope guard runs (#79 — the user path never admits a machine
 * credential), and `opsTokenAuth` admits nothing else. `opsOrUser` composes
 * the two existing pairs behind one middleware so an application does not
 * hand-write the branch.
 *
 * The rules it keeps:
 *
 * - **The branch is chosen by credential shape, never by caller choice.** The
 *   raw `Authorization` bearer is tested with `isOpsToken`; a match takes the
 *   ops branch, everything else (user JWT, another machine namespace,
 *   malformed, absent) takes the user branch. A caller cannot select the
 *   weaker check by asking for it, because nothing in the request selects a
 *   branch except the credential it presents.
 * - **`roles` and `permissions` are AND, roles first.** Two lists only ever
 *   narrow. An OR would mean one added role voids the whole permission list,
 *   which is the opposite of what a reader of the two lists expects. Roles run
 *   first because the role is already on the auth context while permissions
 *   cost a lookup — and so a caller with the wrong role is refused for the
 *   wrong role.
 * - **No implicit admin bypass.** Permissions match by name only, and the ops
 *   branch has no role concept, so neither branch has a principal that passes
 *   by virtue of being an administrator.
 * - **A refusal is the selected branch's own refusal.** No error class and no
 *   wire message is introduced here; whichever guard refused answers exactly
 *   what it answers on a single-credential route.
 * - **Every call is its own check.** It is a `defineMiddlewareFactory`
 *   factory: each call returns a named middleware carrying
 *   `skips: ['auth']`, so the global `auth` middleware auto-skips exactly as
 *   it does for `optionalAuth` and `opsTokenAuth`. A call's result is never
 *   merged with another by name, so a router's `opsOrUser(read)` and a
 *   route's `opsOrUser(write)` both run — the route's stricter check is not
 *   dropped. `.skip(['opsOrUser'])` removes every call.
 *
 * The backend never reads cookies. A browser session reaches here as a Bearer
 * token because `@spfn/auth/nextjs/api` forwards it as one; a request carrying
 * only a `Cookie` header is an unauthenticated request on this route.
 *
 * @example
 * ```typescript
 * import { opsOrUser } from '@spfn/auth/server';
 *
 * export const exportSignups = route.get('/admin/signups/export')
 *     .use([opsOrUser({ opsScopes: ['waitlist:read'], permissions: ['admin.waitlist'] })])
 *     .handler(async (c) =>
 *     {
 *         // exactly one of these is set
 *         const ops = getOpsToken(c.raw);
 *         const user = getAuth(c.raw);
 *     });
 * ```
 */

import type { MiddlewareHandler } from 'hono';
import { defineMiddlewareFactory } from '@spfn/core/route';

import { isOpsToken } from '../services/ops-token.service';
import { authenticate } from './authenticate';
import { opsTokenAuth, requireOpsScope } from './ops-token-auth';
import { requireRole } from './require-role';
import { requirePermissions } from './require-permission';

/** What a route admits, on each of the two branches. */
export interface OpsOrUserConfig
{
    /** scopes an ops token must carry (all of them; '*' grants all, as requireOpsScope does) */
    opsScopes: string[];
    /** the session user's role must be one of these */
    roles?: string[];
    /** the session user must hold every one of these */
    permissions?: string[];
}

/**
 * A middleware admitting either an ops token or a user session on one route.
 *
 * Validation is definition-time and fails closed: a route that names no ops
 * scope, or no session guard at all, would admit one credential unchecked, so
 * it is a boot-time error rather than a request-time surprise — the same
 * posture `registerMachineVerifier` takes.
 *
 * @throws Error when `opsScopes` is empty, or when neither `roles` nor
 *   `permissions` names anything.
 */
export const opsOrUser = defineMiddlewareFactory('opsOrUser', (config: OpsOrUserConfig): MiddlewareHandler =>
{
    const roles = config.roles ?? [];
    const permissions = config.permissions ?? [];

    if (!config.opsScopes || config.opsScopes.length === 0)
    {
        throw new Error('opsOrUser: opsScopes must name at least one scope — an ops token would otherwise be admitted unchecked.');
    }

    if (roles.length === 0 && permissions.length === 0)
    {
        throw new Error('opsOrUser: give roles, permissions, or both — a user session would otherwise be admitted unchecked.');
    }

    // The guards are built once here, not per request.
    const ops = chain([opsTokenAuth.handler, requireOpsScope(...config.opsScopes).handler]);
    const user = chain([
        authenticate.handler,
        ...(roles.length > 0 ? [requireRole(...roles).handler] : []),
        ...(permissions.length > 0 ? [requirePermissions(...permissions).handler] : []),
    ]);

    return (c, next) =>
        isOpsToken(bearerOf(c.req.header('Authorization'))) ? ops(c, next) : user(c, next);
}, { skips: ['auth'] });

/**
 * The bearer as presented, or '' — never null, so the shape test in the
 * handler reads as one expression. A header that is not `Bearer ...` carries
 * no bearer, and an empty string is ops-shaped for no one.
 */
function bearerOf(header: string | undefined): string
{
    return header && header.startsWith('Bearer ') ? header.substring(7) : '';
}

/**
 * Run `handlers` in order, then the route's own `next`.
 *
 * A handler may answer by *returning* a Response rather than throwing —
 * `authenticate` does for a profile refusal, so that the answer carries the
 * contract's error envelope (#106). Whichever link produced one is this
 * middleware's answer: an outer link that merely awaited `next()` and returned
 * nothing must not swallow it.
 */
function chain(handlers: MiddlewareHandler[]): MiddlewareHandler
{
    return async (c, next) =>
    {
        let answer: Response | undefined;

        const runFrom = async (index: number): Promise<void> =>
        {
            const produced = index < handlers.length
                ? await handlers[index]!(c, () => runFrom(index + 1))
                : await next();

            if (produced instanceof Response)
            {
                answer = produced;
            }
        };

        await runFrom(0);

        return answer;
    };
}
