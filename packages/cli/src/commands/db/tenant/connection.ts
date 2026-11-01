/**
 * One connection for a tenant export or import, and errors safe to print
 *
 * Every statement of a run goes through one connection — one snapshot for an
 * export, one transaction for an import. A driver error can carry the host,
 * the user or the whole URL (a failed connect does); what reaches the terminal
 * is the server's message for a statement that failed, else only an error code,
 * with the URL and its password cut out whatever the source.
 */

import postgres from 'postgres';

export type TenantSql = postgres.Sql;
export type TenantTransaction = postgres.TransactionSql;

export function openConnection(url: string): TenantSql
{
    return postgres(url, { max: 1, onnotice: () => undefined, connect_timeout: 10 });
}

/** What to print for `error`: never the connection URL, its user and host, or its password. */
export function describeError(error: unknown, url: string | undefined): string
{
    return redact(rawDescription(error), url);
}

function rawDescription(error: unknown): string
{
    if (error instanceof postgres.PostgresError)
    {
        return error.constraint_name ? `${error.message} (constraint ${error.constraint_name})` : error.message;
    }

    const code = (error as { code?: unknown } | null)?.code;

    if (typeof code === 'string' && /^E[A-Z]+$/.test(code))
    {
        return `could not reach the database (${code})`;
    }

    return error instanceof Error ? error.message : String(error);
}

function redact(text: string, url: string | undefined): string
{
    const secrets = url ? secretsOf(url) : [];

    return secrets.reduce((result, secret) => result.split(secret).join('***'), text);
}

/** The URL and its password, in the forms a message could hold them in; longest first. */
function secretsOf(url: string): string[]
{
    const parsed = URL.canParse(url) ? new URL(url) : undefined;
    const password = parsed?.password ?? '';

    return [url, password, decodeURIComponent(password)]
        .filter((secret) => secret.length > 0)
        .sort((left, right) => right.length - left.length);
}
