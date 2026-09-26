'use client';

/**
 * OAuthCallback Component
 *
 * OAuth 콜백 페이지용 클라이언트 컴포넌트
 * URL params에서 userId, keyId를 추출하여 oauthFinalize API 호출 후 returnUrl로 리다이렉트
 *
 * An account with a second factor signing in on a new device arrives with
 * `?mfaChallenge=` instead. The component hands it to `oauthFinalize`, which
 * answers 202 while the proxy seals the pending cookie and names the confirm
 * page, and then navigates there — `SPFN_AUTH_MFA_CONFIRM_PATH` on the server,
 * `/auth/mfa` by default, `mfaPath` to override — with `?challenge=` and
 * `?returnUrl=`. The decisions live in `oauth-callback-flow.ts`.
 *
 * @example
 * ```tsx
 * // app/auth/callback/page.tsx
 * export { OAuthCallback as default } from '@spfn/auth/nextjs/client';
 * ```
 */

import { useEffect, useRef, useState } from 'react';

import { runOAuthCallback } from './oauth-callback-flow';

export interface OAuthCallbackProps
{
    /**
     * API base path for RPC calls
     * @default '/api/rpc'
     */
    apiBasePath?: string;

    /**
     * An override for the second-factor confirm page, where a callback carrying
     * `mfaChallenge` goes next.
     *
     * Normally left unset: the proxy puts `SPFN_AUTH_MFA_CONFIRM_PATH` on the
     * `oauthFinalize` 202 and the component goes there, and with the page at
     * `/auth/mfa` nothing needs setting at all. A path within the app; a URL is
     * reduced to its path.
     * @default the server's `SPFN_AUTH_MFA_CONFIRM_PATH`, then '/auth/mfa'
     */
    mfaPath?: string;

    /**
     * Custom loading component
     */
    loadingComponent?: React.ReactNode;

    /**
     * Custom error component
     */
    errorComponent?: (error: string) => React.ReactNode;

    /**
     * Callback after successful OAuth. Not called on the way to the confirm page:
     * there is no session yet.
     */
    onSuccess?: (userId: string) => void;

    /**
     * Callback on error
     */
    onError?: (error: string) => void;
}

export function OAuthCallback({
    apiBasePath = '/api/rpc',
    mfaPath,
    loadingComponent,
    errorComponent,
    onSuccess,
    onError,
}: OAuthCallbackProps)
{
    const [error, setError] = useState<string | null>(null);

    // One finalize per page load. React strict mode runs this effect twice in
    // development, and a parent passing inline callbacks re-runs it on every
    // render; neither should post the callback query a second time.
    const started = useRef(false);

    useEffect(() =>
    {
        if (started.current)
        {
            return;
        }

        started.current = true;

        runOAuthCallback(window.location.search, { apiBasePath, mfaPath, fetch: window.fetch.bind(window) })
            .then((outcome) =>
            {
                if (outcome.kind === 'error')
                {
                    setError(outcome.message);
                    onError?.(outcome.message);

                    return;
                }

                if (outcome.userId)
                {
                    onSuccess?.(outcome.userId);
                }

                // Built by the flow from checked values only: toSafeReturnPath on
                // the session path, mfaConfirmUrl on the challenge path.
                window.location.href = outcome.to;
            });
    }, [apiBasePath, mfaPath, onSuccess, onError]);

    if (error)
    {
        if (errorComponent)
        {
            return <>{errorComponent(error)}</>;
        }

        return (
            <div style={{ padding: '20px', textAlign: 'center' }}>
                <h2>Authentication Error</h2>
                <p style={{ color: 'red' }}>{error}</p>
                <button onClick={() => window.location.href = '/'}>
                    Go Home
                </button>
            </div>
        );
    }

    if (loadingComponent)
    {
        return <>{loadingComponent}</>;
    }

    return (
        <div style={{ padding: '20px', textAlign: 'center' }}>
            <p>Completing authentication...</p>
        </div>
    );
}

export default OAuthCallback;
