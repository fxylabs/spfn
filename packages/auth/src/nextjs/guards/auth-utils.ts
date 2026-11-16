/**
 * Server-side auth utilities for guards
 *
 * Uses authApi to check permissions in real-time
 */

import { authApi } from '@spfn/auth';
import { env as authEnv } from '@spfn/auth/config';
import { SessionRenewalRequiredError } from '@spfn/auth/errors';
import { authLogger } from '../../server/logger';
import { isSessionEndingCode } from '../../server/lib/admission-refusal';

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
 * The session, the renewal sentinel, or `null` — and `null` only when the
 * backend refused the session's key or account (the key-refused family, the
 * same codes on which the proxy clears the cookies). A backend that answered
 * 5xx, could not be reached, or did not answer within `SPFN_AUTH_GUARD_TIMEOUT`
 * says nothing about the session: the error is thrown, so the app's error
 * boundary renders, the cookies stay, and nobody is sent to sign in by an outage.
 */
export async function getAuthSessionData(): Promise<AuthSessionState>
{
    const lookup = await sessionLookup().call().then(
        session => ({ session }),
        (error: unknown) => ({ error }),
    );

    if ('error' in lookup)
    {
        return failedLookupState(lookup.error);
    }

    authLogger.middleware.debug('Auth session retrieved', { name: lookup.session.role?.name });

    return lookup.session;
}

/**
 * The session route, bounded by `SPFN_AUTH_GUARD_TIMEOUT` when it is set.
 *
 * Read on every lookup, not at module load, like the rest of the auth env. Unset,
 * the call is exactly the unbounded one and the client-wide timeout applies.
 */
function sessionLookup(): typeof authApi.getAuthSession
{
    const timeoutMs = authEnv.SPFN_AUTH_GUARD_TIMEOUT;

    return timeoutMs === undefined ? authApi.getAuthSession : authApi.getAuthSession.timeout(timeoutMs);
}

/**
 * What a failed lookup means to a guard: renewal, signed out — or not a session
 * answer at all, which is thrown.
 */
function failedLookupState(error: unknown): typeof RENEWAL_REQUIRED | null
{
    if (isRenewalRequired(error))
    {
        authLogger.middleware.debug('Auth session needs renewing');

        return RENEWAL_REQUIRED;
    }

    if (isSignedOut(error))
    {
        authLogger.middleware.debug('Auth session refused', { code: (error as { name?: unknown }).name });

        return null;
    }

    authLogger.middleware.error('Auth session lookup failed — not a sign-out, surfacing the error', { error });

    throw error;
}

/**
 * Whether the backend (or the proxy in front of it) said the session is over.
 *
 * The key-refused family — a bound session presented from another browser
 * family among them — read off the restored error's class name, the
 * envelope's code. Matched by name rather than `instanceof`, for
 * `isRenewalRequired`'s reason.
 */
function isSignedOut(error: unknown): boolean
{
    const name = (error as { name?: unknown } | null)?.name;

    return typeof name === 'string' && isSessionEndingCode(name);
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

/** The session itself, or null for either of the two non-session states. */
function resolvedSession(state: AuthSessionState): AuthSessionData | null
{
    return state && state !== RENEWAL_REQUIRED ? state : null;
}

/**
 * Get user role — the role in force, as `requireRole` sees it; null for none
 */
export async function getUserRole(): Promise<string | null>
{
    const session = resolvedSession(await getAuthSessionData());

    return session?.role?.name ?? null;
}

/**
 * Get user permissions — exactly the ones `requirePermissions` admits
 */
export async function getUserPermissions(): Promise<string[]>
{
    const session = resolvedSession(await getAuthSessionData());

    return session?.permissions.map(permission => permission.name) ?? [];
}

/**
 * Check if user has any of the specified roles
 */
export async function hasAnyRole(requiredRoles: string[]): Promise<boolean>
{
    const role = await getUserRole();

    return role !== null && requiredRoles.includes(role);
}

/**
 * Check if user has any of the specified permissions
 */
export async function hasAnyPermission(requiredPermissions: string[]): Promise<boolean>
{
    const held = await getUserPermissions();

    return requiredPermissions.some(permission => held.includes(permission));
}
