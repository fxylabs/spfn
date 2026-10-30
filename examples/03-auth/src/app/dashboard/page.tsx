import Link from 'next/link';
import { api } from '@/lib/api-client';
import { LogoutButton } from '@/app/components/logout-button';
import { ConnectedAccounts } from '@/app/components/connected-accounts';

export const dynamic = 'force-dynamic';

/**
 * The signed-in home. `RequireAuth` in the layout already guaranteed a session,
 * so `api.getMe` (a protected route) is safe to call directly.
 */
export default async function DashboardPage()
{
    const me = await api.getMe.call({});

    return (
        <main style={{ maxWidth: 720, margin: '0 auto', padding: '5rem 1.5rem', fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>Dashboard</h1>

            <section style={{ marginTop: '1.5rem', padding: '1.25rem', border: '1px solid #e5e5e5', borderRadius: 8 }}>
                <p style={{ margin: 0 }}>
                    Signed in as <strong>{me.email ?? me.username ?? me.id}</strong>
                    {' '}(role: <code>{me.role}</code>)
                </p>
                <LogoutButton />
            </section>

            <ConnectedAccounts connections={me.connections} />

            <p style={{ marginTop: '1.5rem', color: '#666' }}>
                <Link href="/admin">Admin area</Link> — only the <code>admin</code>/<code>superadmin</code> roles
                get in; everyone else is sent back here by <code>RequireRole</code>.
            </p>
            <p style={{ color: '#666' }}>
                <Link href="/">← Public home</Link>
            </p>
        </main>
    );
}
