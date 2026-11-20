/**
 * One connection for a tenant export or import, and errors safe to print
 *
 * Every statement of a run goes through one connection — one snapshot for an
 * export, one transaction for an import. Which fields of a database error may
 * be printed is core's rule (`describeError`, `databaseErrorMessage`): the
 * SQLSTATE, the constraint, table and column, and the server's message only
 * where core keeps it — never a row value, a bound parameter or `detail`.
 * What is the CLI's: one line for the terminal, a local file error's own
 * message, a network error's code only (its peer is a host), and the URL and
 * its password cut out whatever the source, with any other URL's credentials
 * blanked (`redactUrls`). `db push` prints a failed package migration and a
 * failed project statement the same way.
 */

import { databaseErrorMessage } from '@spfn/core/db';
import { describeError as describeCaught, type DatabaseErrorDescription } from '@spfn/core/logger';
import postgres from 'postgres';
import { redactUrls } from '../../../utils/redact-urls.js';

export type TenantSql = postgres.Sql;
export type TenantTransaction = postgres.TransactionSql;

export function openConnection(url: string): TenantSql
{
    return postgres(url, { max: 1, onnotice: () => undefined, connect_timeout: 10 });
}

/**
 * What to print for `error`, on one line: never the connection URL, its user
 * and host, or its password.
 *
 * A database error reads `<message> (<code>, constraint …, table …, column …)`,
 * the message being core's: the server's own for a kept class (`duplicate key
 * value violates unique constraint "x"`), else the class's fixed text
 * (`Invalid input value (22P02, …)`, `Invalid query (42703)`,
 * `Database authentication failed (28P01)`, `Database query failed (XX000)`).
 */
export function describeError(error: unknown, url: string | undefined): string
{
    return redact(rawDescription(error), url);
}

/**
 * The SQL text of the statement a database error came from, as core describes
 * it (placeholders, never values; truncated), with the URL cut out; else
 * `undefined`. `db push` prints it under a failed project statement — the
 * operator's own schema, which the plan printed already.
 */
export function failedStatement(error: unknown, url: string | undefined): string | undefined
{
    const description = describeCaught(error, { stack: false });

    return description.kind === 'database' && description.sql ? redact(description.sql, url) : undefined;
}

function rawDescription(error: unknown): string
{
    const description = describeCaught(error, { stack: false });

    if (description.kind === 'database')
    {
        return describeDatabaseError(description);
    }

    if (typeof description.code === 'string' && !isFileError(error))
    {
        return `could not reach the database (${description.code})`;
    }

    return description.message ?? description.name;
}

function describeDatabaseError(description: DatabaseErrorDescription): string
{
    const table = description.table && (description.schema ? `${description.schema}.${description.table}` : description.table);
    const fields = [
        description.code,
        description.constraint && `constraint ${description.constraint}`,
        table && `table ${table}`,
        description.column && `column ${description.column}`,
    ].filter(Boolean);

    return fields.length > 0 ? `${databaseErrorMessage(description)} (${fields.join(', ')})` : databaseErrorMessage(description);
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

    return redactUrls(secrets.reduce((result, secret) => result.split(secret).join('***'), text));
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
