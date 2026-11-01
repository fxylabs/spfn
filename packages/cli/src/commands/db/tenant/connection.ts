/**
 * One connection for a tenant export or import, and errors safe to print
 *
 * Every statement of a run goes through one connection — one snapshot for an
 * export, one transaction for an import. A driver error can carry the host,
 * the user or the whole URL (a failed connect does); what reaches the terminal
 * is the server's message for a statement that failed, a local file error's
 * own message, else only an error code — with the URL and its password cut out
 * whatever the source.
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
        return describePostgresError(error);
    }

    const code = (error as { code?: unknown } | null)?.code;

    if (typeof code === 'string' && !isFileError(error))
    {
        return `could not reach the database (${code})`;
    }

    return error instanceof Error ? error.message : String(error);
}

/** invalid_password, invalid_authorization_specification */
const AUTHENTICATION_FAILURES = new Set(['28P01', '28000']);

/** The server's message for a failed statement; an authentication failure's names the user, so only its SQLSTATE. */
function describePostgresError(error: postgres.PostgresError): string
{
    if (AUTHENTICATION_FAILURES.has(error.code))
    {
        return `authentication failed (${error.code})`;
    }

    return error.constraint_name ? `${error.message} (constraint ${error.constraint_name})` : error.message;
}

/**
 * A Node system error from a local file — a full disk while exporting, a
 * folder that exists — whose message is its code, syscall and path. A network
 * error names its peer in `address` or `hostname`, and every postgres.js
 * driver error in `address`; those print their code only.
 */
function isFileError(error: unknown): boolean
{
    const fields = error as { syscall?: unknown; address?: unknown; hostname?: unknown };

    return typeof fields.syscall === 'string' && fields.address === undefined && fields.hostname === undefined;
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
