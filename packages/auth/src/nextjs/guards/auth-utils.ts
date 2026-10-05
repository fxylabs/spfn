/**
 * Server-side auth utilities for guards
 *
 * Uses authApi to check permissions in real-time
 */

import { ApiError } from '@spfn/core/nextjs';
import { authApi } from '@spfn/auth';
import { env as authEnv } from '@spfn/auth/config';
import { SessionRenewalRequiredError } from '@spfn/auth/errors';
import { authLogger } from '../../server/logger';

/**
 * A bound session whose key has run out, seen from a server component.
 *
 * The third state `getAuthSessionData` answers with, and the reason it is a
 * sentinel rather than `null`: a server component's `api.` call goes through the
 * same proxy a browser's does, so it meets the same renewal-required refusal —
 * and `null` there would read as "not signed in" and send the person to the
 * sign-in page, which is precisely the thing renewal exists to avoid. A server
 * component cannot run a WebAuthn ceremony, so the guard hands the work to a page
 * that can.
 */
export const RENEWAL_REQUIRED = 'renewal-required';

export type AuthSessionData = Awaited<ReturnType<typeof authApi.getAuthSession.call>>;

/** What a guard gets back: the session, the renewal sentinel, or nothing. */
export type AuthSessionState = AuthSessionData | typeof RENEWAL_REQUIRED | null;

/**
 * Get current auth session with roles and permissions via API
 *
 * Any failure answers `null`, which a guard reads as signed out — a lookup that
 * outlives `SPFN_AUTH_GUARD_TIMEOUT` included, so a slow backend sends a signed-in
 * person to the sign-in page rather than holding the render.
 */
export async function getAuthSessionData(): Promise<AuthSessionState>
{
    try
    {
        const session = await sessionLookup().call();
        authLogger.middleware.debug('Auth session retrieved', { name: session.role?.name });

        return session;
    }
    catch (error)
    {
        return failedLookupState(error);
    }
}

/**
 * The session route, bounded by `SPFN_AUTH_GUARD_TIMEOUT` when it is set.
 *
 * Read on every lookup, not at module load, like the rest of the auth env. Unset,
 * the call is exactly the unbounded one and the client-wide timeout applies. A
 * malformed value throws from the read, inside `getAuthSessionData`'s catch.
 */
function sessionLookup(): typeof authApi.getAuthSession
{
    const timeoutMs = authEnv.SPFN_AUTH_GUARD_TIMEOUT;

    return timeoutMs === undefined ? authApi.getAuthSession : authApi.getAuthSession.timeout(timeoutMs);
}

/** What a failed lookup means to a guard: renewal, or no session. */
function failedLookupState(error: unknown): typeof RENEWAL_REQUIRED | null
{
    if (isRenewalRequired(error))
    {
        authLogger.middleware.debug('Auth session needs renewing');

        return RENEWAL_REQUIRED;
    }

    if (isTimeout(error))
    {
        authLogger.middleware.warn('Auth session lookup timed out', { timeoutMs: authEnv.SPFN_AUTH_GUARD_TIMEOUT });

        return null;
    }

    authLogger.middleware.error('Failed to get auth session', { error });

    return null;
}

/**
 * Whether a refusal is the renewal-required one.
 *
 * Matched by name as well as by class. `@spfn/auth/errors` can resolve to two
 * module instances at once — the package entry and the source tree — under a
 * test runner and in dev, and `instanceof` across them is false; core's own
 * `isSerializableError` duck-types for exactly that reason. Getting this wrong
 * fails in the direction that redirects someone to a sign-in page they do not
 * need, which is the failure this whole branch exists to remove.
 */
function isRenewalRequired(error: unknown): boolean
{
    return error instanceof SessionRenewalRequiredError
        || (error as { name?: unknown } | null)?.name === 'SessionRenewalRequiredError';
}

/**
 * Whether a failure is the client's timeout.
 *
 * Matched by name and `errorType` as well as by class, for the same reason as
 * `isRenewalRequired`: `@spfn/core/nextjs` can resolve to two module instances.
 */
function isTimeout(error: unknown): boolean
{
    const candidate = error as { name?: unknown; errorType?: unknown } | null;

    return (error instanceof ApiError || candidate?.name === 'ApiError')
        && candidate?.errorType === 'timeout';
}

/** The session itself, or null for either of the two non-session states. */
function resolvedSession(state: AuthSessionState): AuthSessionData | null
{
    return state && state !== RENEWAL_REQUIRED ? state : null;
}

/**
 * Get user role
 */
export async function getUserRole(): Promise<string | null>
{
    const session = resolvedSession(await getAuthSessionData());

    return session?.role?.name || null;
}

/**
 * Get user permissions
 */
export async function getUserPermissions(): Promise<string[]>
{
    const session = resolvedSession(await getAuthSessionData());

    if (!session)
    {
        return [];
    }

    return session.permissions?.map((p: any) => p.name) || [];
}

/**
 * Check if user has any of the specified roles
 */
export async function hasAnyRole(requiredRoles: string[]): Promise<boolean>
{
    const session = resolvedSession(await getAuthSessionData());
    if (!session)
    {
        return false;
    }

    return requiredRoles.includes(session.role?.name);
}

/**
 * Check if user has any of the specified permissions
 */
export async function hasAnyPermission(requiredPermissions: string[]): Promise<boolean>
{
    const session = resolvedSession(await getAuthSessionData());

    if (!session)
    {
        return false;
    }

    const userPermissionNames = session.permissions?.map((p: any) => p.name) || [];

    return requiredPermissions.some(permission => userPermissionNames.includes(permission));
}
