/**
 * PostgreSQL Error Conversion Utilities
 *
 * Converts PostgreSQL-specific error codes to custom error types
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */

import {
    DatabaseError,
    ConnectionError,
    DuplicateEntryError,
    DeadlockError,
    ConstraintViolationError,
    QueryError,
    TransactionError,
} from '@spfn/core/errors';
import { describeError, POSTGRES_JS_CONNECTION_CODES } from '../logger/error-description';

/**
 * A typed error's message when the driver's is not kept, by SQLSTATE class
 */
const CLASS_MESSAGES: Readonly<Record<string, string>> = {
    '08': 'Database connection failed',
    '22': 'Invalid input value',
    '23': 'Integrity constraint violated',
    '28': 'Database authentication failed',
    '40': 'Transaction failed',
    '42': 'Invalid query',
    '53': 'Insufficient database resources',
    '57': 'Database operation interrupted',
};

/**
 * The typed error's message: the driver's only where `describeError` keeps
 * it — a SQLSTATE class whose messages name identifiers only, raised by a
 * known server routine — and otherwise a fixed text for the class. A class-22
 * message quotes the rejected input, and the typed error's message reaches
 * every log line and, outside production, the response body.
 */
function messageOf(error: unknown, code: unknown): string
{
    const description = describeError(error);

    if (description.kind === 'database' && description.message !== undefined)
    {
        return description.message;
    }

    if (typeof code !== 'string')
    {
        return 'Database query failed';
    }

    if (POSTGRES_JS_CONNECTION_CODES.has(code))
    {
        return 'Database connection lost';
    }

    return CLASS_MESSAGES[code.slice(0, 2)] ?? 'Database query failed';
}

/**
 * The text a database error may be shown with: the driver's message where
 * `describeError` keeps it, otherwise core's fixed text for the SQLSTATE
 * class — the same text `fromPostgresError` gives its typed error. Never a
 * bound value nor a rejected input. The SQLSTATE is read from the description,
 * so a drizzle query error over a driver error has its class text too.
 *
 * @example
 * ```typescript
 * import { databaseErrorMessage } from '@spfn/core/db';
 *
 * databaseErrorMessage(error); // 'Invalid input value' for a 22P02
 * ```
 */
export function databaseErrorMessage(error: unknown): string
{
    const description = describeError(error, { stack: false });

    return messageOf(description, description.code);
}

/**
 * Extract field and value from PostgreSQL unique violation message
 *
 * Handles various formats:
 * - Simple: Key (email)=(test@example.com)
 * - Complex: Key (user_id, tenant_id)=(123, 456)
 * - With quotes: Key ("field")=('value')
 */
function parseUniqueViolation(message: string): { field: string; value: string } | null
{
    // Try multiple patterns for robustness
    const patterns = [
        // Standard format: Key (field)=(value)
        /Key \(([^)]+)\)=\(([^)]+)\)/i,
        // With quotes: Key ("field")=('value')
        /Key \(["']?([^)"']+)["']?\)=\(["']?([^)"']+)["']?\)/i,
        // Alternative format
        /Key `([^`]+)`=`([^`]+)`/i,
    ];

    for (const pattern of patterns)
    {
        const match = message.match(pattern);
        if (match)
        {
            // Clean up extracted values
            const field = match[1].trim().replace(/["'`]/g, '');
            const value = match[2].trim().replace(/["'`]/g, '');

            return { field, value };
        }
    }

    return null;
}

/**
 * Convert PostgreSQL error to custom DatabaseError
 *
 * Maps PostgreSQL error codes to appropriate error classes with correct status codes.
 * The typed error keeps the driver error as its `cause`, so a log line describes
 * the database error under it; its own message is the driver's only where the
 * description keeps that, and otherwise a fixed text for the SQLSTATE class
 * (`Invalid input value`, `Database query failed`, …).
 *
 * @param error - PostgreSQL error object (from pg driver or Drizzle)
 * @returns Custom DatabaseError instance
 *
 * @example
 * ```typescript
 * import { fromPostgresError } from '@spfn/core/db';
 *
 * try {
 *   await db.insert(users).values(data);
 * } catch (pgError) {
 *   throw fromPostgresError(pgError);
 * }
 * ```
 */
export function fromPostgresError(error: any): DatabaseError
{
    const code = error?.code;
    const message = messageOf(error, code);
    const cause = error;

    switch (code)
    {
        // Class 08 — Connection Exception
        case '08000': // connection_exception
        case '08001': // sqlclient_unable_to_establish_sqlconnection
        case '08003': // connection_does_not_exist
        case '08004': // sqlserver_rejected_establishment_of_sqlconnection
        case '08006': // connection_failure
        case '08007': // transaction_resolution_unknown
        case '08P01': // protocol_violation
            return new ConnectionError({ message, details: { code }, cause });

        // Class 23 — Integrity Constraint Violation
        case '23000': // integrity_constraint_violation
        case '23001': // restrict_violation
            return new ConstraintViolationError({ message, details: { code, constraint: 'integrity' }, cause });

        case '23502': // not_null_violation
            return new ConstraintViolationError({ message, details: { code, constraint: 'not_null' }, cause });

        case '23503': // foreign_key_violation
            return new ConstraintViolationError({ message, details: { code, constraint: 'foreign_key' }, cause });

        case '23505': // unique_violation
            const parsed = parseUniqueViolation(typeof error?.message === 'string' ? error.message : '');
            if (parsed)
            {
                return new DuplicateEntryError({ field: parsed.field, value: parsed.value, cause });
            }

            return new DuplicateEntryError({ field: 'field', value: 'value', cause });

        case '23514': // check_violation
            return new ConstraintViolationError({ message, details: { code, constraint: 'check' }, cause });

        // Class 40 — Transaction Rollback
        case '40000': // transaction_rollback
        case '40001': // serialization_failure
        case '40002': // transaction_integrity_constraint_violation
        case '40003': // statement_completion_unknown
            return new TransactionError({ message, statusCode: 500, details: { code }, cause });

        case '40P01': // deadlock_detected
            return new DeadlockError({ message, details: { code }, cause });

        // Class 42 — Syntax Error or Access Rule Violation
        case '42000': // syntax_error_or_access_rule_violation
        case '42601': // syntax_error
        case '42501': // insufficient_privilege
        case '42602': // invalid_name
        case '42622': // name_too_long
        case '42701': // duplicate_column
        case '42702': // ambiguous_column
        case '42703': // undefined_column
        case '42704': // undefined_object
        case '42P01': // undefined_table
        case '42P02': // undefined_parameter
            return new QueryError({ message, statusCode: 400, details: { code }, cause });

        // Class 53 — Insufficient Resources
        case '53000': // insufficient_resources
        case '53100': // disk_full
        case '53200': // out_of_memory
        case '53300': // too_many_connections
            return new ConnectionError({ message, details: { code }, cause });

        // Class 57 — Operator Intervention
        case '57000': // operator_intervention
        case '57014': // query_canceled
        case '57P01': // admin_shutdown
        case '57P02': // crash_shutdown
        case '57P03': // cannot_connect_now
            return new ConnectionError({ message, details: { code }, cause });

        // Default: Unknown error
        default:
            return new QueryError({ message, statusCode: 500, details: { code }, cause });
    }
}
