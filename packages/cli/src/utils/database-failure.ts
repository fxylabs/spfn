/**
 * What the CLI prints for a failed database command — one place, so a new
 * command cannot print less
 *
 * Which fields of a database error may be printed is core's rule
 * (`describeError`, `databaseErrorMessage`): the SQLSTATE, the constraint,
 * table and column, the statement's text with its placeholders, and the
 * server's message only where core keeps it — never a row value, a bound
 * parameter, `detail` or `where`. What is the CLI's: the statement that failed
 * on a line of its own, since a class-22 or class-42 message is dropped and the
 * statement is then all that says what failed; where a COPY failed (its
 * relation and line number, never the row); the migration or file a statement
 * came from; a local file error's own message; a network error's code only
 * (its peer is a host); and the URL and its password cut out whatever the
 * source, with any other URL's credentials blanked (`redactUrls`).
 *
 * Every statement this goes through is one the CLI ran: `db push`'s project
 * statements and function package migrations, `db tenant export`/`import`'s.
 */

import { databaseErrorMessage } from '@spfn/core/db';
import { describeError as describeCaught, type DatabaseErrorDescription, type ErrorDescription } from '@spfn/core/logger';
import { redactUrls } from './redact-urls.js';

/** A failed statement and what it came from — a function package migration, a tenant file. */
export class StatementSourceError extends Error
{
    constructor(readonly source: string, options: { cause: unknown })
    {
        super(options.cause instanceof Error ? options.cause.message : String(options.cause), options);
        this.name = 'StatementSourceError';
    }
}

/** `promise`, a failure of which names `source` (`   In: <source>`). */
export function failingIn<T>(source: string, promise: Promise<T>): Promise<T>
{
    return promise.catch((error: unknown) => Promise.reject(new StatementSourceError(source, { cause: error })));
}

/**
 * What to print for `error`: never the connection URL, its user and host, or
 * its password. The first line reads `<message> (<code>, constraint …, table …,
 * column …)`, the message being core's: the server's own for a kept class
 * (`duplicate key value violates unique constraint "x"`), else the class's
 * fixed text (`Invalid input value (22P02)`, `Invalid query (42703)`,
 * `Database authentication failed (28P01)`). Under it, each when known:
 *
 * ```
 *    In: @spfn/cms migration 20260101000000_init
 *    Failed statement: COPY "spfn_tenant_import_0" ("id", "title") FROM STDIN
 *    At: COPY spfn_tenant_import_0, line 3
 * ```
 */
export function describeFailure(error: unknown, url: string | undefined): string
{
    const source = error instanceof StatementSourceError ? error : undefined;
    const failure = source ? source.cause : error;
    const description = describeCaught(failure, { stack: false });
    const lines = description.kind === 'database'
        ? [
            describeDatabaseError(description),
            source && `In: ${source.source}`,
            description.sql && `Failed statement: ${description.sql}`,
            copyPosition(failure),
        ]
        : [describeOtherError(failure, description), source && `In: ${source.source}`];

    return redact(lines.filter(Boolean).join('\n   '), url);
}

function describeOtherError(error: unknown, description: ErrorDescription): string
{
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
 * `At: COPY <relation>, line <n>` from the server's `where` of a failed COPY
 * (`COPY docs, line 3, column title: "<the row's value>"`): the relation and
 * the line, cut before the column and the value. Any other `where` is dropped.
 */
function copyPosition(error: unknown): string | undefined
{
    const match = /^COPY (.+?), line (\d+)\b/.exec(whereOf(error) ?? '');

    return match ? `At: COPY ${match[1]}, line ${match[2]}` : undefined;
}

/** The driver error's `where`: on the error itself (postgres.js), or on the cause drizzle wraps. */
function whereOf(error: unknown): string | undefined
{
    const fields = error as { where?: unknown; cause?: { where?: unknown } } | undefined;
    const where = fields?.where ?? fields?.cause?.where;

    return typeof where === 'string' ? where : undefined;
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
