'use client';

/**
 * OAuthCallback Component
 *
 * OAuth 콜백 페이지용 클라이언트 컴포넌트
 * URL params에서 userId, keyId를 추출하여 oauthFinalize API 호출 후 returnUrl로 리다이렉트
 *
 * @example
 * ```tsx
 * // app/auth/callback/page.tsx
 * export { OAuthCallback as default } from '@spfn/auth/nextjs/client';
 * ```
 */

import { useEffect, useState } from 'react';

import { isSafeReturnPath } from '../../lib/return-path';

/**
 * The destination to navigate to, or `/` when the value would leave the app.
 *
 * Both the query parameter and the value echoed by `oauthFinalize` pass through
 * here. A callback URL is something a user can be handed, so neither is trusted
 * to be a path inside the app — without this an absolute URL in `?returnUrl=`
 * would make a genuine login end on someone else's origin.
 */
function toSafePath(value: string | null | undefined): string
{
    return value && isSafeReturnPath(value) ? value : '/';
}

export interface OAuthCallbackProps
{
    /**
     * API base path for RPC calls
     * @default '/api/rpc'
     */
    apiBasePath?: string;

    /**
     * Custom loading component
     */
    loadingComponent?: React.ReactNode;

    /**
     * Custom error component
     */
    errorComponent?: (error: string) => React.ReactNode;

    /**
     * Callback after successful OAuth
     */
    onSuccess?: (userId: string) => void;

    /**
     * Callback on error
     */
    onError?: (error: string) => void;
}

export function OAuthCallback({
    apiBasePath = '/api/rpc',
    loadingComponent,
    errorComponent,
    onSuccess,
    onError,
}: OAuthCallbackProps)
{
    const [error, setError] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() =>
    {
        async function finalizeOAuth()
        {
            try
            {
                const params = new URLSearchParams(window.location.search);
                const userId = params.get('userId');
                const keyId = params.get('keyId');
                const returnUrl = toSafePath(params.get('returnUrl'));
                const errorParam = params.get('error');

                // Handle error from backend
                if (errorParam)
                {
                    throw new Error(errorParam);
                }

                if (!userId || !keyId)
                {
                    throw new Error('Missing required parameters');
                }

                // Call oauthFinalize API
                const response = await fetch(`${apiBasePath}/oauthFinalize`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    credentials: 'include',
                    body: JSON.stringify({
                        body: {
                            userId,
                            keyId,
                            returnUrl,
                        },
                    }),
                });

                if (!response.ok)
                {
                    const data = await response.json().catch(() => ({}));
                    throw new Error(data.message || 'Failed to finalize OAuth');
                }

                const data = await response.json();

                onSuccess?.(userId);

                // Redirect to returnUrl
                window.location.href = toSafePath(data.returnUrl || returnUrl);
            }
            catch (err)
            {
                const message = err instanceof Error ? err.message : 'OAuth failed';
                setError(message);
                setIsLoading(false);
                onError?.(message);
            }
        }

        finalizeOAuth();
    }, [apiBasePath, onSuccess, onError]);

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

    if (isLoading)
    {
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

    return null;
}

export default OAuthCallback;
