/**
 * The transport rule every surface request obeys: https, or http against the
 * machine itself.
 *
 * Every request a surface client makes carries a credential — an ops token, a
 * signed token, an administrator's password on `spfn ops token issue`. A stale
 * app URL left over from a local run, or a typo, is enough to put it on the
 * wire unencrypted, and nothing about the answer would say so. The client
 * refuses such a URL when it is created; `spfn ops` asks the same question
 * first so it can render the refusal its own way.
 */

/** Why an app URL may not carry a credential, or null when it may. */
export type TransportRefusal = 'cleartext-http' | 'not-http';

/**
 * Where `http` is not a mistake: a machine talking to itself, which has no
 * certificate to present and no network for anyone to listen on.
 *
 * The scaffold's own API runs on `http://localhost:8790`, so local development
 * has to keep working — but that is the whole of the exception.
 */
export function isLoopback(hostname: string): boolean
{
    return hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '[::1]'
        || hostname.endsWith('.localhost');
}

export function transportRefusalOf(url: URL): TransportRefusal | null
{
    if (url.protocol === 'https:' || (url.protocol === 'http:' && isLoopback(url.hostname)))
    {
        return null;
    }

    return url.protocol === 'http:' ? 'cleartext-http' : 'not-http';
}

function parseAppUrl(appUrl: string): URL | null
{
    try
    {
        return new URL(appUrl);
    }
    catch
    {
        return null;
    }
}

/** Throw unless `appUrl` is an absolute https URL, or http against loopback. */
export function assertTransportSafe(appUrl: string): void
{
    const url = parseAppUrl(appUrl);

    if (url === null)
    {
        throw new Error(`Invalid app URL: ${appUrl}`);
    }

    const refusal = transportRefusalOf(url);
    if (refusal === 'cleartext-http')
    {
        throw new Error(`Refusing to talk to ${appUrl} over http: a credential would cross it in the clear. `
            + 'Use https. http is allowed only against localhost.');
    }
    if (refusal === 'not-http')
    {
        throw new Error(`App URL must be https, got "${url.protocol}//". http is allowed only against localhost.`);
    }
}
