/**
 * Database Error Classes
 *
 * Type-safe error handling with custom error class hierarchy
 * Mapped to HTTP status codes for API responses
 * All errors extend SerializableError for consistent JSON serialization
 */

import { SerializableError } from './serializable-error';

/**
 * Base Database Error
 *
 * Base class for all database-related errors
 */
export class DatabaseError<TDetails extends Record<string, unknown> = Record<string, unknown>>
    extends SerializableError
{
    public readonly statusCode: number;
    public readonly details?: TDetails;

    constructor(data: {
        message: string;
        statusCode?: number;
        details?: TDetails;
        /** The error this one was converted from — the driver error, for `fromPostgresError` */
        cause?: unknown;
    })
    {
        super(data.message, data.cause === undefined ? undefined : { cause: data.cause });
        this.name = 'DatabaseError';
        this.statusCode = data.statusCode ?? 500;
        this.details = data.details;
        Error.captureStackTrace(this, this.constructor);
    }

    /**
     * Whether this error's message/details are derived from the raw database
     * driver (SQL text, table/column/constraint names, parameter values) and
     * therefore must NOT be exposed to clients in production. Defined as a
     * prototype getter so it is never serialized into the response by toJSON().
     * Subclasses with a safe, constructed message override this to `false`.
     */
    get internal(): boolean
    {
        return true;
    }
}

/**
 * Connection Error (503 Service Unavailable)
 *
 * Database connection failure, connection pool exhaustion, etc.
 */
export class ConnectionError extends DatabaseError
{
    constructor(data: { message: string; details?: Record<string, unknown>; cause?: unknown })
    {
        super({ message: data.message, statusCode: 503, details: data.details, cause: data.cause });
        this.name = 'ConnectionError';
    }
}

/**
 * Query Error (500 Internal Server Error)
 *
 * SQL query execution failure, syntax errors, etc.
 */
export class QueryError extends DatabaseError
{
    constructor(data: {
        message: string;
        statusCode?: number;
        details?: Record<string, unknown>;
        cause?: unknown;
    })
    {
        super({
            message: data.message,
            statusCode: data.statusCode ?? 500,
            details: data.details,
            cause: data.cause,
        });
        this.name = 'QueryError';
    }
}

/**
 * Entity Not Found Error (404 Not Found)
 *
 * Database entity does not exist
 */
export class EntityNotFoundError extends QueryError
{
    public readonly resource: string;
    public readonly id: string | number;

    constructor(data: { resource: string; id: string | number })
    {
        super({
            message: `${data.resource} with id ${data.id} not found`,
            statusCode: 404,
            details: { resource: data.resource, id: data.id },
        });
        this.name = 'EntityNotFoundError';
        this.resource = data.resource;
        this.id = data.id;
    }

    // Message/details are constructed from the resource + id, not driver text
    override get internal(): boolean
    {
        return false;
    }
}

/**
 * Constraint Violation Error (400 Bad Request)
 *
 * Database constraint violation (NOT NULL, CHECK, FOREIGN KEY, etc.)
 * This is different from HTTP ValidationError which validates request input
 */
export class ConstraintViolationError extends QueryError
{
    constructor(data: { message: string; details?: Record<string, unknown>; cause?: unknown })
    {
        super({ message: data.message, statusCode: 400, details: data.details, cause: data.cause });
        this.name = 'ConstraintViolationError';
    }
}

/**
 * Transaction Error (500 Internal Server Error)
 *
 * Transaction start/commit/rollback failure
 */
export class TransactionError extends DatabaseError
{
    constructor(data: {
        message: string;
        statusCode?: number;
        details?: Record<string, unknown>;
        cause?: unknown;
    })
    {
        super({
            message: data.message,
            statusCode: data.statusCode ?? 500,
            details: data.details,
            cause: data.cause,
        });
        this.name = 'TransactionError';
    }
}

/**
 * Deadlock Error (409 Conflict)
 *
 * Database deadlock detected
 */
export class DeadlockError extends TransactionError
{
    constructor(data: { message: string; details?: Record<string, unknown>; cause?: unknown })
    {
        super({ message: data.message, statusCode: 409, details: data.details, cause: data.cause });
        this.name = 'DeadlockError';
    }
}

/**
 * Duplicate Entry Error (409 Conflict)
 *
 * Unique constraint violation (e.g., duplicate email)
 */
export class DuplicateEntryError extends QueryError
{
    public readonly field: string;
    public readonly value: string | number;

    constructor(data: { field: string; value: string | number; cause?: unknown })
    {
        // The client-facing message/details name the field but NOT the value: echoing
        // the value back (e.g. an email) confirms it exists, an enumeration aid. The
        // raw value stays on the instance for server-side handling/logging.
        super({
            message: `${data.field} already exists`,
            statusCode: 409,
            details: { field: data.field },
            cause: data.cause,
        });
        this.name = 'DuplicateEntryError';
        this.field = data.field;
        this.value = data.value;
    }

    // Field-only message/details — safe to surface to the client (not internal)
    override get internal(): boolean
    {
        return false;
    }
}
