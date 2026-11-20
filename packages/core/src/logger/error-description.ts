/**
 * Error Description
 *
 * The one loggable form of a caught error. Every log line, persisted failure
 * and non-production response renders an error through `describeError`, never
 * through its own `message`, `stack` or enumerable fields.
 *
 * The reason is the database error. drizzle's query error carries every bound
 * value three times — in `params`, in its message (`Failed query: … params:
 * …`) and in the stack header that repeats the message — and the driver error
 * in its `cause` adds `detail` and `where`, which hold row values. A
 * description keeps what identifies the failure (SQLSTATE, constraint, table,
 * the SQL text with its `$n` placeholders, how many values were bound) and
 * none of the values.
 *
 * A leaf module: it imports nothing, so the db layer can use it without a cycle.
 */

/**
 * A database error: a drizzle query error or a driver error, with its values left out
 */
export interface DatabaseErrorDescription
{
    kind: 'database';
    /** `DrizzleQueryError`, `PostgresError`, … */
    name: string;
    /** SQLSTATE, or the driver's connection code */
    code?: string;
    severity?: string;
    constraint?: string;
    schema?: string;
    table?: string;
    column?: string;
    dataType?: string;
    routine?: string;
    /** The driver's message, only for SQLSTATE classes whose messages name identifiers only */
    message?: string;
    /** The SQL text with its `$n` placeholders, truncated */
    sql?: string;
    /** How many values were bound — never the values */
    paramCount?: number;
    /** Stack frames only: the header lines, which repeat the message, are dropped */
    stack?: string;
}

/**
 * Any other error, with its cause chain described the same way
 */
export interface ErrorDescription
{
    kind: 'error';
    name: string;
    message: string;
    /** Stack frames only: the header lines, which repeat the message, are dropped */
    stack?: string;
    cause?: ErrorDescription | DatabaseErrorDescription;
}

/**
 * postgres.js driver-level error codes that indicate a dead connection
 *
 * These are the codes the driver puts on the errors it generates itself
 * (`Errors.connection` / `Errors.generic`), as opposed to the SQLSTATE it
 * copies off a server ErrorResponse. The reconnect trigger reads the same list.
 *
 * @see https://github.com/porsager/postgres/blob/master/src/errors.js
 */
export const POSTGRES_JS_CONNECTION_CODES: ReadonlySet<string> = new Set([
    'CONNECTION_ENDED',
    'CONNECTION_CLOSED',
    'CONNECTION_DESTROYED',
    'CONNECT_TIMEOUT',
    'CONNECTION_CONNECT_TIMEOUT',
]);

/** A SQLSTATE is exactly five characters, digits and uppercase letters only: `23505`, `08P01` */
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;

/**
 * SQLSTATE classes whose server messages name identifiers only — a constraint,
 * a relation, a column — and never a value: connection exception (08),
 * integrity constraint violation (23, whose values are in `detail`),
 * transaction rollback (40), insufficient resources (53), operator
 * intervention (57). Every other class keeps its message out: class 22 quotes
 * the rejected input, 42601 the offending token, P0001 is the app's own text.
 */
const MESSAGE_SAFE_CLASSES: ReadonlySet<string> = new Set(['08', '23', '40', '53', '57']);

/**
 * The routine a PL/pgSQL `RAISE` reports: its message is the app's own text,
 * whatever ERRCODE it was raised with
 */
const RAISE_ROUTINE = 'exec_stmt_raise';

const SQL_LIMIT = 1000;

/** Marks an object `describeError` built, so describing it again returns it */
const DESCRIBED = Symbol.for('spfn.core.errorDescription');

type Fields = Record<string, unknown>;

/**
 * Whether an error came from the database driver — either relayed from the
 * PostgreSQL server or raised by the driver itself. Those are the shapes
 * `fromPostgresError` is written to read, and the ones `describeError` reads
 * a database description from. `Transactional()` and the description share
 * this one test, so their readings cannot drift apart.
 *
 * It has to be certain rather than merely plausible, because the cost of a
 * false positive is total: `fromPostgresError` falls back to `QueryError 500`
 * for any code it does not recognise, so an application error routed into it
 * loses its status and its serialized envelope and reaches the client as a
 * bare 500. Two shapes qualify, and nothing else does.
 *
 * **One of the driver's own connection codes.** The errors postgres.js raises
 * itself instead of relaying — a socket that died mid-transaction, a connect
 * that timed out — are built by `Errors.connection` / `Errors.generic` (see
 * `postgres/src/errors.js`), which set `code` to a name of the driver's own
 * invention (`CONNECTION_CLOSED`, `CONNECT_TIMEOUT`, …) and no severity at all.
 * The name is the proof of origin, so it stands alone here;
 * `POSTGRES_JS_CONNECTION_CODES` is the very list the reconnect trigger
 * classifies on, which keeps the two readings of "the connection died" in step.
 *
 * **Or a SQLSTATE-shaped code together with a severity field.** For an error
 * relayed from the server, neither half suffices alone. A `code` says nothing
 * about who raised the error — Stripe sends `resource_missing`, jose sends
 * `ERR_JOSE_GENERIC`, the AWS SDK sends `ThrottlingException`, Node sends
 * `ECONNRESET`, and an application's own error class is free to carry one too.
 * The severity is what only a driver puts there: postgres.js copies the
 * server's ErrorResponse message field-for-field onto the error, mapping `S` to
 * `severity_local` and `V` to `severity` (see `errorFields` in
 * `postgres/src/connection.js`). Either field satisfies the gate: `V` exists
 * only from PostgreSQL 9.6, while `S` is in every ErrorResponse the protocol
 * has ever defined. node-postgres names the `S` field `severity`, so the same
 * gate holds if the driver is ever swapped.
 *
 * Deliberately NOT `routine` / `file` / `line`, the other fields postgres.js
 * sets: the protocol lists them as optional, and a connection pooler that
 * synthesizes its own ErrorResponse rather than relaying one — PgBouncer and
 * friends, which SPFN supports explicitly (see `isTransactionPooler` in
 * `manager/connection.ts`) — sends severity, code and message without them.
 * Those are the `08*` and `53300` errors that most need converting.
 *
 * The trade: an object that fakes both a SQLSTATE and a severity — or that
 * borrows one of the driver's connection-code names — is still converted. That
 * is the right way round. A hand-rolled `{ code: '23505' }` now passes through
 * as itself, which costs nothing real, and in exchange no application error is
 * ever mangled into a 500.
 */
export function isDriverError(error: unknown): boolean
{
    if (!error || typeof error !== 'object')
    {
        return false;
    }

    const candidate = error as Fields;

    if (typeof candidate.code !== 'string')
    {
        return false;
    }

    if (POSTGRES_JS_CONNECTION_CODES.has(candidate.code))
    {
        return true;
    }

    if (!SQLSTATE_PATTERN.test(candidate.code))
    {
        return false;
    }

    return typeof candidate.severity === 'string' || typeof candidate.severity_local === 'string';
}

/**
 * drizzle's query error, recognised by shape: the module may be loaded twice
 */
function isQueryError(error: unknown): error is Fields
{
    const candidate = error as Fields;

    return typeof error === 'object' && error !== null
        && typeof candidate.query === 'string' && Array.isArray(candidate.params);
}

/**
 * Describe a caught error without any value it carries
 *
 * Walks the cause chain. The first link that is a drizzle query error or a
 * driver error becomes a database description and ends the chain: the driver
 * error under a query error is folded into it. It never copies `params`,
 * `parameters`, `args`, `detail`, `hint`, `where`, `internal_query`, drizzle's
 * message, or a stack's header lines.
 *
 * @example
 * ```typescript
 * import { describeError } from '@spfn/core/logger';
 *
 * await boss.fail(queue, id, describeError(error));
 * ```
 */
export function describeError(error: unknown): ErrorDescription | DatabaseErrorDescription
{
    return describeLink(error, new WeakSet<object>());
}

function describeLink(error: unknown, seen: WeakSet<object>): ErrorDescription | DatabaseErrorDescription
{
    if (isDescription(error))
    {
        return error;
    }

    if (isQueryError(error))
    {
        return describeQueryError(error);
    }

    if (isDriverError(error))
    {
        return describeDriverError(error as Fields);
    }

    return describeOther(error, seen);
}

function isDescription(error: unknown): error is ErrorDescription | DatabaseErrorDescription
{
    return typeof error === 'object' && error !== null && (error as { [DESCRIBED]?: true })[DESCRIBED] === true;
}

function describeQueryError(error: Fields): DatabaseErrorDescription
{
    const cause = error.cause as Fields | undefined;
    const driver = isDriverError(cause) ? driverFields(cause!) : { code: stringField(cause, 'code') };

    return mark({
        kind: 'database',
        name: nameOf(error, 'DrizzleQueryError'),
        ...driver,
        sql: truncate(error.query as string),
        paramCount: (error.params as unknown[]).length,
        stack: framesOf(error),
    });
}

function describeDriverError(error: Fields): DatabaseErrorDescription
{
    const query = error.query;
    const parameters = error.parameters;

    return mark({
        kind: 'database',
        name: nameOf(error, 'PostgresError'),
        ...driverFields(error),
        sql: typeof query === 'string' ? truncate(query) : undefined,
        paramCount: Array.isArray(parameters) ? parameters.length : undefined,
        stack: framesOf(error),
    });
}

/**
 * The identifying fields of a driver error; postgres.js names them
 * `constraint_name` …, node-postgres `constraint` …
 */
function driverFields(error: Fields): Partial<DatabaseErrorDescription>
{
    return {
        code: error.code as string,
        severity: stringField(error, 'severity'),
        constraint: stringField(error, 'constraint_name') ?? stringField(error, 'constraint'),
        schema: stringField(error, 'schema_name') ?? stringField(error, 'schema'),
        table: stringField(error, 'table_name') ?? stringField(error, 'table'),
        column: stringField(error, 'column_name') ?? stringField(error, 'column'),
        dataType: stringField(error, 'data_type_name') ?? stringField(error, 'dataType'),
        routine: stringField(error, 'routine'),
        message: keptMessage(error),
    };
}

function keptMessage(error: Fields): string | undefined
{
    const code = error.code as string;

    if (!SQLSTATE_PATTERN.test(code) || !MESSAGE_SAFE_CLASSES.has(code.slice(0, 2)))
    {
        return undefined;
    }

    return error.routine === RAISE_ROUTINE ? undefined : stringField(error, 'message');
}

function describeOther(error: unknown, seen: WeakSet<object>): ErrorDescription
{
    if (typeof error !== 'object' || error === null)
    {
        return mark({ kind: 'error', name: 'Error', message: String(error) });
    }

    seen.add(error);

    const cause = (error as Fields).cause;
    const message = (error as Fields).message;

    return mark({
        kind: 'error',
        name: nameOf(error as Fields, 'Error'),
        message: typeof message === 'string' ? message : Object.prototype.toString.call(error),
        stack: framesOf(error as Fields),
        cause: cause === undefined || (typeof cause === 'object' && cause !== null && seen.has(cause))
            ? undefined
            : describeLink(cause, seen),
    });
}

/**
 * The frame lines of a stack. The header — `Name: message`, which for a
 * drizzle error runs over two lines and ends in its params — is skipped past
 * the message text itself, so a value that happens to look like a frame
 * cannot survive either
 */
function framesOf(error: Fields): string | undefined
{
    const stack = error.stack;

    if (typeof stack !== 'string')
    {
        return undefined;
    }

    const message = typeof error.message === 'string' ? error.message : '';
    const end = message === '' ? -1 : stack.indexOf(message);
    const frames = (end === -1 ? stack : stack.slice(end + message.length))
        .split('\n')
        .filter(line => /^\s+at\s/.test(line));

    return frames.length > 0 ? frames.join('\n') : undefined;
}

function nameOf(error: Fields, fallback: string): string
{
    return typeof error.name === 'string' && error.name !== '' ? error.name : fallback;
}

function stringField(error: Fields | undefined, key: string): string | undefined
{
    const value = error?.[key];

    return typeof value === 'string' ? value : undefined;
}

function truncate(sql: string): string
{
    return sql.length > SQL_LIMIT ? `${sql.slice(0, SQL_LIMIT)}…` : sql;
}

/**
 * Drop the fields left undefined and mark the object as a description
 */
function mark<T extends ErrorDescription | DatabaseErrorDescription>(description: T): T
{
    for (const key of Object.keys(description) as (keyof T)[])
    {
        if (description[key] === undefined)
        {
            delete description[key];
        }
    }

    return Object.defineProperty(description, DESCRIBED, { value: true });
}
