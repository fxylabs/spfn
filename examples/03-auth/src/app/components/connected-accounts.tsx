'use client';

import { authApi } from '@spfn/auth';
import { isOAuthLinkOutcome, type OAuthLinkOutcome } from '@spfn/auth/nextjs/client';
import { useEffect, useState } from 'react';

interface Connection
{
    provider: string;
    providerHandle: string | null;
}

const OUTCOME_MESSAGES: Record<OAuthLinkOutcome, string> = {
    linked: 'Battle.net is connected.',
    cancelled: 'You cancelled at Battle.net. Nothing changed.',
    linked_elsewhere: 'That Battle.net account belongs to another account here. Nothing changed.',
    provider_already_linked: 'This account already has a Battle.net account. Disconnect it first.',
    account_unavailable: 'This account cannot be changed right now.',
    provider_error: 'Battle.net could not be reached. Try again.',
    failed: 'Connecting Battle.net failed.',
};

/** What the link callback put on the URL, read once and then removed from the address bar. */
function takeLinkOutcome(): OAuthLinkOutcome | null
{
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get('oauthLink');

    if (!isOAuthLinkOutcome(outcome))
    {
        return null;
    }

    url.searchParams.delete('oauthLink');
    url.searchParams.delete('provider');
    window.history.replaceState(null, '', url);

    return outcome;
}

/**
 * Connect or disconnect Battle.net from the signed-in account (fxylabs/spfn#154).
 *
 * Both calls are gated like a passkey change: a session older than ten minutes is
 * refused RECENT_AUTH_REQUIRED, so sign out and in again (or send the password).
 */
export function ConnectedAccounts({ connections }: { connections: Connection[] })
{
    const battlenet = connections.find(connection => connection.provider === 'battlenet');
    const [pending, setPending] = useState(false);
    const [status, setStatus] = useState<string | null>(null);

    useEffect(() =>
    {
        const outcome = takeLinkOutcome();

        if (outcome)
        {
            setStatus(OUTCOME_MESSAGES[outcome]);
        }
    }, []);

    async function connect()
    {
        setPending(true);

        try
        {
            const { authUrl } = await authApi.oauthLinkStart.call({
                params: { provider: 'battlenet' },
                body: { returnUrl: '/dashboard' },
            });

            window.location.assign(authUrl);
        }
        catch (error)
        {
            setPending(false);
            setStatus(`Could not start: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async function disconnect()
    {
        setPending(true);

        try
        {
            await authApi.oauthUnlink.call({ params: { provider: 'battlenet' }, body: {} });
            window.location.reload();
        }
        catch (error)
        {
            setPending(false);
            setStatus(`Could not disconnect: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return (
        <section style={{ marginTop: '1.5rem', padding: '1.25rem', border: '1px solid #e5e5e5', borderRadius: 8 }}>
            <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Connected accounts</h2>
            <p style={{ margin: '0.75rem 0' }}>
                Battle.net:{' '}
                {battlenet ? <strong>{battlenet.providerHandle ?? '(no BattleTag)'}</strong> : 'not connected'}
            </p>
            <button
                type="button"
                disabled={pending}
                onClick={battlenet ? disconnect : connect}
                style={{ padding: '0.5rem 0.75rem', cursor: 'pointer' }}
            >
                {battlenet ? 'Disconnect Battle.net' : 'Connect Battle.net'}
            </button>
            {status && <p style={{ margin: '0.75rem 0 0', color: '#666', fontSize: '0.875rem' }}>{status}</p>}
        </section>
    );
}
