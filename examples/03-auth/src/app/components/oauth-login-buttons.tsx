'use client';

import { authApi } from '@spfn/auth';
import { useEffect, useState } from 'react';

type DemoProvider = 'apple' | 'google' | 'kakao' | 'naver';

const PROVIDERS: Array<{ id: DemoProvider; label: string; color: string; textColor: string; border?: string }> = [
    { id: 'apple', label: 'Continue with Apple', color: '#000000', textColor: '#FFFFFF' },
    { id: 'google', label: 'Continue with Google', color: '#FFFFFF', textColor: '#1F1F1F', border: '1px solid #d4d4d4' },
    { id: 'kakao', label: 'Continue with Kakao', color: '#FEE500', textColor: '#191919' },
    { id: 'naver', label: 'Continue with Naver', color: '#03C75A', textColor: '#FFFFFF' },
];

const DEMO_PROVIDER_IDS: readonly string[] = PROVIDERS.map(provider => provider.id);

export function OAuthLoginButtons()
{
    const [enabled, setEnabled] = useState<DemoProvider[]>([]);
    const [pending, setPending] = useState<DemoProvider | null>(null);
    const [status, setStatus] = useState('Checking provider configuration...');

    useEffect(() =>
    {
        authApi.oauthProviders.call({})
            .then(({ providers }) =>
            {
                const configured = providers.filter(
                    (provider): provider is DemoProvider => DEMO_PROVIDER_IDS.includes(provider),
                );
                setEnabled(configured);
                setStatus(configured.length > 0
                    ? 'Configured providers are ready.'
                    : 'Add provider credentials to .env.server, then restart the dev server.');
            })
            .catch(() =>
            {
                setStatus('Could not read provider status. Check that the SPFN API server is running.');
            });
    }, []);

    async function startLogin(provider: DemoProvider)
    {
        setPending(provider);
        setStatus(`Starting ${provider} login...`);

        try
        {
            const { authUrl } = await authApi.getProviderOAuthUrl.call({
                params: { provider },
                body: { returnUrl: '/' },
            });

            window.location.assign(authUrl);
        }
        catch
        {
            setPending(null);
            setStatus(`Could not start ${provider} login. Check credentials and callback URL settings.`);
        }
    }

    return (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
            {PROVIDERS.map(provider =>
            {
                const isEnabled = enabled.includes(provider.id);
                const isPending = pending === provider.id;

                return (
                    <button
                        key={provider.id}
                        type="button"
                        disabled={!isEnabled || pending !== null}
                        onClick={() => startLogin(provider.id)}
                        style={{
                            border: provider.border ?? '0',
                            borderRadius: 8,
                            padding: '0.85rem 1rem',
                            background: provider.color,
                            color: provider.textColor,
                            cursor: isEnabled && pending === null ? 'pointer' : 'not-allowed',
                            fontSize: '0.95rem',
                            fontWeight: 700,
                            opacity: isEnabled ? 1 : 0.4,
                        }}
                    >
                        {isPending ? 'Redirecting...' : provider.label}
                    </button>
                );
            })}
            <p style={{ margin: 0, color: '#666', fontSize: '0.85rem' }}>{status}</p>
        </div>
    );
}
