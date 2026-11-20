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
    /** The driver's message, only for SQLSTATE classes whose messages name identifiers only, from a known server routine */
    message?: string;
    /** The SQL text with its `$n` placeholders, truncated */
    sql?: string;
    /** How many values were bound — never the values */
    paramCount?: number;
    /** Stack frames only: the header lines, which repeat the message, are dropped */
    stack?: string;
}

/**
 * Any other error, with its cause chain described the same way — or a thrown
 * value that is not an Error: a string as its text, an object by its
 * constructor's name (`NonError` for a plain one), its string `message` and
 * its `code`, and none of its other fields
 */
export interface ErrorDescription
{
    kind: 'error';
    name: string;
    message?: string;
    /** The error's `code`, when it is a string or a number */
    code?: string | number;
    /** The error's `statusCode`, when it is a number; never for a value that is not an Error */
    statusCode?: number;
    /** Stack frames only: the header lines, which repeat the message, are dropped */
    stack?: string;
    cause?: ErrorDescription | DatabaseErrorDescription;
}

export interface DescribeErrorOptions
{
    /** Keep the stack frames, down the cause chain. Default `true` */
    stack?: boolean;
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
 * The server routines whose messages, in the classes above, name identifiers
 * only. A kept class is not enough on its own: a procedural language raises
 * any SQLSTATE with the app's own text (PL/pgSQL `RAISE … USING ERRCODE =
 * 'unique_violation'` reports `exec_stmt_raise`, PL/Python `plpy.error(…,
 * sqlstate='23505')` its own routine), and so may an extension. So the
 * message is kept only from a routine on this list — each one read off the
 * error PostgreSQL 16.15 actually raised — or from an error that names no
 * routine at all, which is what a pooler such as PgBouncer synthesizes for its
 * own 08 and 53 errors.
 */
const MESSAGE_SAFE_ROUTINES: ReadonlySet<string> = new Set([
    '_bt_check_unique',                         // 23505: insert, update, deferred unique check
    'comparetup_index_btree',                   // 23505: CREATE UNIQUE INDEX over duplicates
    'check_exclusion_or_unique_constraint',     // 23P01: exclusion constraint
    'ExecConstraints',                          // 23502 not-null column, 23514 check
    'ri_ReportViolation',                       // 23503: foreign key, on insert and on delete
    'ExecEvalConstraintCheck',                  // 23514: domain check
    'ExecEvalConstraintNotNull',                // 23502: domain not-null
    'domain_check_input',                       // 23502/23514: domain input (COPY, a bound parameter)
    'ExecPartitionCheckEmitError',              // 23514: partition constraint, insert into a partition
    'DeadLockReport',                           // 40P01
    'ExecUpdate',                               // 40001: concurrent update
    'ExecDelete',                               // 40001: concurrent update, under a delete
    'ExecLockRows',                             // 40001: concurrent update, under FOR UPDATE / a foreign key check
    'PreCommit_CheckForSerializationFailure',   // 40001: serializable read/write dependencies, at commit
    'OnConflict_CheckForSerializationFailure',  // 40001: serializable read/write dependencies, at a read or write
    'ProcessInterrupts',                        // 57014 statement timeout / cancel, 57P01 terminated
]);

const SQL_LIMIT = 1000;

/** How many links of a cause chain are described; a longer chain ends in a `CauseChainTruncated` link */
export const CAUSE_DEPTH_LIMIT = 10;

/** Marks an object `describeError` built, so describing it again returns it */
const DESCRIBED = Symbol.for('spfn.core.errorDescription');

type Fields = Record<string, unknown>;

/**
 * One description in progress: the links described so far, outermost first,
 * and whether stack frames are kept
 */
interface Walk
{
    seen: Set<object>;
    stack: boolean;
}

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

    const code = read(error, 'code');

    if (typeof code !== 'string')
    {
        return false;
    }

    if (POSTGRES_JS_CONNECTION_CODES.has(code))
    {
        return true;
    }

    if (!SQLSTATE_PATTERN.test(code))
    {
        return false;
    }

    return typeof read(error, 'severity') === 'string' || typeof read(error, 'severity_local') === 'string';
}

/**
 * Whether a value is an Error: an instance of this realm's `Error`, or one
 * from another realm (a vm context, a worker), which carries the `Error` tag.
 * The logger, the context masking and `describeError` share this one test.
 *
 * Deliberately NOT "any object with a string `stack`": an error response body
 * copied into a log context, or a domain object with a `stack` field, is data,
 * and reading it as an error replaced it with a description that kept none of
 * its fields.
 */
export function isError(value: unknown): value is Error
{
    try
    {
        return value instanceof Error || Object.prototype.toString.call(value) === '[object Error]';
    }
    catch
    {
        // A revoked Proxy, or one whose prototype trap throws
        return false;
    }
}

/**
 * A property of a caught value, or `undefined` when reading it throws — a
 * getter, a Proxy trap. Describing an error must never throw into the log
 * call, or the catch block, that asked for it.
 */
function read(value: object, key: PropertyKey): unknown
{
    try
    {
        return (value as Record<PropertyKey, unknown>)[key];
    }
    catch
    {
        return undefined;
    }
}

/**
 * drizzle's query error, recognised by shape: the module may be loaded twice
 */
function isQueryError(error: unknown): error is Fields
{
    return typeof error === 'object' && error !== null
        && typeof read(error, 'query') === 'string' && isArray(read(error, 'params'));
}

/**
 * `Array.isArray`, false for a revoked Proxy instead of throwing
 */
export function isArray(value: unknown): value is unknown[]
{
    try
    {
        return Array.isArray(value);
    }
    catch
    {
        // A revoked Proxy
        return false;
    }
}

/**
/**
 * Describe a caught error without any value it carries
 *
 * Walks the cause chain. The first link that is a drizzle query error or a
 * driver error becomes a database description and ends the chain: the driver
 * error under a query error is folded into it. It never copies `params`,
 * `parameters`, `args`, `detail`, `hint`, `where`, `internal_query`, drizzle's
 * message, or a stack's header lines.
 *
 * It never throws: a property whose read throws is left out, a chain longer
 * than `CAUSE_DEPTH_LIMIT` ends in a `CauseChainTruncated` link and a chain
 * that refers back to an earlier link ends in a `CircularCause` link.
 *
 * A value that is not an Error is described by what it is, never by its
 * fields: a string by its text, an object by its constructor's name, its
 * string `message` and its `code`. A thrown `{ code, params }` logs no params.
 *
 * @example
 * ```typescript
 * import { describeError } from '@spfn/core/logger';
 *
 * await boss.fail(queue, id, describeError(error));
 * ```
 */
export function describeError(error: unknown, options: DescribeErrorOptions = {}): ErrorDescription | DatabaseErrorDescription
{
    return describeLink(error, { seen: new Set<object>(), stack: options.stack !== false });
}

function describeLink(error: unknown, walk: Walk): ErrorDescription | DatabaseErrorDescription
{
    if (isDescription(error))
    {
        return walk.stack ? error : withoutStack(error);
    }

    if (isQueryError(error))
    {
        return describeQueryError(error, walk);
    }

    if (isDriverError(error))
    {
        return describeDriverError(error as Fields, walk);
    }

    return isError(error) ? describeOther(error, walk) : describeNonError(error);
}

/**
 * A description with its stack frames dropped, down the cause chain
 */
function withoutStack(description: ErrorDescription | DatabaseErrorDescription): ErrorDescription | DatabaseErrorDescription
{
    const { stack: _stack, ...rest } = description;

    if (rest.kind === 'error' && rest.cause)
    {
        return mark({ ...rest, cause: withoutStack(rest.cause) });
    }

    return mark(rest);
}

/**
 * Whether a value is a description `describeError` built
 */
export function isDescription(error: unknown): error is ErrorDescription | DatabaseErrorDescription
{
    return typeof error === 'object' && error !== null && read(error, DESCRIBED) === true;
}

function describeQueryError(error: Fields, walk: Walk): DatabaseErrorDescription
{
    const cause = read(error, 'cause');
    const driver = isDriverError(cause) ? driverFields(cause as Fields) : { code: stringField(cause, 'code') };

    return mark({
        kind: 'database',
        name: nameOf(error, 'DrizzleQueryError'),
        ...driver,
        sql: sqlOf(read(error, 'query')),
        paramCount: countOf(read(error, 'params')),
        stack: walk.stack ? framesOf(error) : undefined,
    });
}

function describeDriverError(error: Fields, walk: Walk): DatabaseErrorDescription
{
    return mark({
        kind: 'database',
        name: nameOf(error, 'PostgresError'),
        ...driverFields(error),
        sql: sqlOf(read(error, 'query')),
        paramCount: countOf(read(error, 'parameters')),
        stack: walk.stack ? framesOf(error) : undefined,
    });
}

/**
 * The identifying fields of a driver error; postgres.js names them
 * `constraint_name` …, node-postgres `constraint` …
 */
function driverFields(error: Fields): Partial<DatabaseErrorDescription>
{
    return {
        code: stringField(error, 'code'),
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
    const code = stringField(error, 'code');

    if (code === undefined || !SQLSTATE_PATTERN.test(code) || !MESSAGE_SAFE_CLASSES.has(code.slice(0, 2)))
    {
        return undefined;
    }

    const routine = read(error, 'routine');
    const safe = routine === undefined || (typeof routine === 'string' && MESSAGE_SAFE_ROUTINES.has(routine));

    return safe ? stringField(error, 'message') : undefined;
}

function describeOther(error: Error, walk: Walk): ErrorDescription
{
    walk.seen.add(error);

    const statusCode = read(error, 'statusCode');

    return mark({
        kind: 'error',
        name: nameOf(error as unknown as Fields, 'Error'),
        message: stringField(error, 'message'),
        code: codeOf(error),
        statusCode: typeof statusCode === 'number' ? statusCode : undefined,
        stack: walk.stack ? framesOf(error as unknown as Fields) : undefined,
        cause: describeCause(error, walk),
    });
}

/**
 * A thrown value that is not an Error. Its fields are arbitrary — a thrown
 * `{ code, params }` — so none is copied but a string `message` and the `code`.
 */
function describeNonError(value: unknown): ErrorDescription
{
    if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
    {
        return mark({ kind: 'error', name: 'NonError', message: String(value) });
    }

    return mark({
        kind: 'error',
        name: constructorName(value),
        message: stringField(value, 'message'),
        code: codeOf(value),
    });
}

/**
 * The name of a non-Error object's class, or `NonError` for a plain object
 */
function constructorName(value: object): string
{
    const constructor = read(value, 'constructor');
    const name = typeof constructor === 'function' ? read(constructor, 'name') : undefined;

    return typeof name === 'string' && name !== '' && name !== 'Object' ? name : 'NonError';
}

function codeOf(error: object): string | number | undefined
{
    const code = read(error, 'code');

    return typeof code === 'string' || typeof code === 'number' ? code : undefined;
}

/**
 * The next link of the chain, unless it is one already described or the
 * chain has run past its limit: either ends the chain in a link that says so
 */
function describeCause(error: object, walk: Walk): ErrorDescription | DatabaseErrorDescription | undefined
{
    const cause = read(error, 'cause');

    if (cause === undefined)
    {
        return undefined;
    }

    if (typeof cause === 'object' && cause !== null && walk.seen.has(cause))
    {
        return mark({ kind: 'error', name: 'CircularCause', message: 'the cause refers back to an earlier link of the chain' });
    }

    if (walk.seen.size >= CAUSE_DEPTH_LIMIT)
    {
        return mark({ kind: 'error', name: 'CauseChainTruncated', message: `the cause chain is longer than ${CAUSE_DEPTH_LIMIT} links` });
    }

    return describeLink(cause, walk);
}

/**
 * The frame lines of a stack. The header — `Name: message`, which for a
 * drizzle error runs over two lines and ends in its params — is skipped past
 * the message text itself, so a value that happens to look like a frame
 * cannot survive either
 */
function framesOf(error: Fields): string | undefined
{
    const stack = read(error, 'stack');

    if (typeof stack !== 'string')
    {
        return undefined;
    }

    const message = stringField(error, 'message') ?? '';
    const end = message === '' ? -1 : stack.indexOf(message);
    const frames = (end === -1 ? stack : stack.slice(end + message.length))
        .split('\n')
        .filter(line => /^\s+at\s/.test(line));

    return frames.length > 0 ? frames.join('\n') : undefined;
}

function nameOf(error: Fields, fallback: string): string
{
    const name = read(error, 'name');

    return typeof name === 'string' && name !== '' ? name : fallback;
}

function stringField(error: unknown, key: string): string | undefined
{
    const value = typeof error === 'object' && error !== null ? read(error, key) : undefined;

    return typeof value === 'string' ? value : undefined;
}

/**
 * The SQL text, truncated
 */
function sqlOf(query: unknown): string | undefined
{
    if (typeof query !== 'string')
    {
        return undefined;
    }

    return query.length > SQL_LIMIT ? `${query.slice(0, SQL_LIMIT)}…` : query;
}

/**
 * How many values were bound
 */
function countOf(values: unknown): number | undefined
{
    const length = isArray(values) ? read(values, 'length') : undefined;

    return typeof length === 'number' ? length : undefined;
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
