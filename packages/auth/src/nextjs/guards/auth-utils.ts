/**
 * Server-side auth utilities for guards
 *
 * Uses authApi to check permissions in real-time
 */

import { authApi } from '@spfn/auth';
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
 */
export async function getAuthSessionData(): Promise<AuthSessionState>
{
    try
    {
        const session = await authApi.getAuthSession.call();
        authLogger.middleware.debug('Auth session retrieved', { name: session.role?.name });

        return session;
    }
    catch (error)
    {
        if (error instanceof SessionRenewalRequiredError)
        {
            authLogger.middleware.debug('Auth session needs renewing');

            return RENEWAL_REQUIRED;
        }

        authLogger.middleware.error('Failed to get auth session', { error });

        return null;
    }
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
