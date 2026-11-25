/**
 * Where a failed OAuth sign-in lands: `SPFN_AUTH_OAUTH_ERROR_URL`, `/auth/error` by default.
 *
 * Rendered by `reason`, never by the `error` on this page's URL: anyone can link here with any
 * `?error=`, and a page that prints it shows whatever that link said. Nothing read off the URL is
 * printed — `reason` and `refusalCode` only pick a sentence from a table.
 */

import Link from 'next/link';
import { OAUTH_ERROR_MESSAGES, isOAuthErrorReason } from '@spfn/auth';

/**
 * This app's copy for the codes its `signIn.admit` refuses with (`{ refuse: { code } }`). A code
 * not in the table — a forged link can carry any code of the right shape — reads as the reason's
 * sentence.
 */
const REFUSAL_MESSAGES = new Map<string, string>([
    ['ACCOUNT_LOCKED', 'This account is locked. Contact support to unlock it.'],
]);

interface OAuthErrorPageProps
{
    searchParams: Promise<{ reason?: string | string[]; refusalCode?: string | string[] }>;
}

export default async function OAuthErrorPage({ searchParams }: OAuthErrorPageProps)
{
    const { reason, refusalCode } = await searchParams;

    return (
        <main style={{ maxWidth: 640, margin: '0 auto', padding: '5rem 1.5rem' }}>
            <h1>OAuth login failed</h1>
            <p style={{ color: '#b91c1c' }}>{errorMessage(reason, refusalCode)}</p>
            <Link href="/">Return to the auth example</Link>
        </main>
    );
}

/** The sentence for the redirect's reason, or this app's copy for its refusal code on `sign_in_refused`. */
function errorMessage(reason: unknown, refusalCode: unknown): string
{
    if (!isOAuthErrorReason(reason))
    {
        return OAUTH_ERROR_MESSAGES.failed;
    }

    const refusal = reason === 'sign_in_refused' && typeof refusalCode === 'string'
        ? REFUSAL_MESSAGES.get(refusalCode)
        : undefined;

    return refusal ?? OAUTH_ERROR_MESSAGES[reason];
}
