/**
 * @spfn/auth - The web app's URL
 *
 * OAuth callbacks, emailed links and the consent screen all point at the web
 * app, and all of them resolve its URL here: `NEXT_PUBLIC_SPFN_APP_URL`
 * (declared by this package) first, then `SPFN_APP_URL` (declared by
 * `@spfn/core`). There is no default: a localhost fallback would put a dead
 * link into every production redirect and email instead of failing where the
 * value is missing.
 */

import { env } from '@spfn/auth/config';
import { env as coreEnv } from '@spfn/core/config';

/** The two variables the app URL is read from. Either may be absent. */
export type AppUrlSource = Partial<Record<'NEXT_PUBLIC_SPFN_APP_URL' | 'SPFN_APP_URL', string>>;

/**
 * The web app's URL, `NEXT_PUBLIC_SPFN_APP_URL` over `SPFN_APP_URL`.
 *
 * @param source - Where to read the two variables; defaults to the validated
 *                 `env` of this package and of `@spfn/core`.
 * @throws Error naming both variables when neither is set
 */
export function resolveAppUrl(source?: AppUrlSource): string
{
    const appUrl = source
        ? source.NEXT_PUBLIC_SPFN_APP_URL || source.SPFN_APP_URL
        : env.NEXT_PUBLIC_SPFN_APP_URL || coreEnv.SPFN_APP_URL;

    if (!appUrl)
    {
        throw new Error(
            'The web app URL is not configured. Set NEXT_PUBLIC_SPFN_APP_URL or SPFN_APP_URL '
            + 'to the origin the app is served from, e.g. https://app.example.com.',
        );
    }

    return appUrl;
}
