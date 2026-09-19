/**
 * RequireAuth Guard Component
 *
 * Requires user to be authenticated
 */

import { redirect } from 'next/navigation';
import { getSession } from '../session-helpers';
import { getAuthSessionData, RENEWAL_REQUIRED } from './auth-utils';
import { getSessionRenewPath } from '../../server/lib/config';
import type { ReactNode } from 'react';

export interface RequireAuthProps
{
    /**
     * Children to render if authenticated
     */
    children: ReactNode;

    /**
     * Path to redirect to if not authenticated
     * @default '/login'
     */
    redirectTo?: string;

    /**
     * Fallback UI to show instead of redirecting
     */
    fallback?: ReactNode;

    /**
     * Path to send a bound session whose key has run out (#97)
     *
     * Not the sign-in page: the person is still signed in and one WebAuthn
     * ceremony puts a live key back in the cookie. The page this names is the
     * app's own, and all it has to do is render a client component that calls
     * `renewSession(api)` and returns them to where they were.
     *
     * @default env SPFN_AUTH_SESSION_RENEW_PATH, or '/auth/renew'
     */
    renewalPath?: string;
}

/**
 * Require Authentication Guard
 *
 * Ensures user is logged in before rendering children
 *
 * @example
 * ```tsx
 * <RequireAuth redirectTo="/login">
 *   <DashboardContent />
 * </RequireAuth>
 * ```
 *
 * @example With fallback
 * ```tsx
 * <RequireAuth fallback={<LoginPrompt />}>
 *   <PrivateContent />
 * </RequireAuth>
 * ```
 *
 * @example A bound session whose key ran out
 * ```tsx
 * // Sent to /account/renew instead of the sign-in page. That page renders a
 * // client component calling renewSession(api).
 * <RequireAuth renewalPath="/account/renew">
 *   <DashboardContent />
 * </RequireAuth>
 * ```
 */
export async function RequireAuth({
    children,
    redirectTo = '/auth/login',
    renewalPath,
    fallback,
}: RequireAuthProps)
{
    const session = await getSession();

    if (!session)
    {
        if (fallback)
        {
            return <>{fallback}</>;
        }

        redirect(redirectTo);
    }

    // Validate server-side session (key expiry, user status, etc.)
    const serverSession = await getAuthSessionData();

    // A bound session waiting on a passkey ceremony is not a signed-out one. The
    // cookies are intact and the sign-in page would ask for a password the person
    // does not need to give; the renewal page runs the ceremony instead.
    if (serverSession === RENEWAL_REQUIRED)
    {
        redirect(renewalPath ?? getSessionRenewPath());
    }

    if (!serverSession)
    {
        // Note: clearSession() cannot be called in Server Components (Next.js 16+)
        // The RPC proxy interceptor handles session cleanup on 401 responses
        redirect(redirectTo);
    }

    return <>{children}</>;
}
