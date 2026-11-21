/**
 * Error Utility Functions
 *
 * Generic error type checking utilities
 */

import { DatabaseError } from './database-errors';
import { HttpError } from './http-errors';
import { SerializableError } from './serializable-error';

/**
 * Check if error is a DatabaseError
 */
export function isDatabaseError(error: unknown): error is DatabaseError
{
    return error instanceof DatabaseError;
}

/**
 * Check if error is an HttpError
 */
export function isHttpError(error: unknown): error is HttpError
{
    return error instanceof HttpError;
}

/**
 * Check if error has a statusCode property
 */
export function hasStatusCode(error: unknown): error is { statusCode: number }
{
    return (
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        typeof (error as any).statusCode === 'number'
    );
}

/**
 * Check if error is a SerializableError — a typed error core's error handler
 * answers with its own `toJSON()`.
 *
 * Duck-typed as well as `instanceof`: in dev (tsx) and under a test runner
 * `@spfn/core/errors` can load as two module copies, and `instanceof` across
 * them is false. The error handler and any package deciding "is this a typed
 * error" ask this one function, so they give one answer.
 */
export function isSerializableError(error: unknown): error is SerializableError
{
    return error instanceof SerializableError || (
        typeof error === 'object' &&
        error !== null &&
        typeof (error as any).toJSON === 'function' &&
        typeof (error as any).statusCode === 'number'
    );
}
