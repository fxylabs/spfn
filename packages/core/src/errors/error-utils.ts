/**
 * Error Utility Functions
 *
 * Generic error type checking utilities
 */

import { DatabaseError } from './database-errors';
import { HttpError } from './http-errors';
import { SERIALIZABLE_ERROR_BRAND, type SerializableError } from './serializable-error';

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
 * Reads the class's brand, not `instanceof`: in dev (tsx) and under a test
 * runner `@spfn/core/errors` can load as two module copies, and `instanceof`
 * across them is false. The brand's key is a global-registry symbol, so both
 * copies set and read the same one. Never the error's shape: a provider's or
 * library's error with a numeric `statusCode` and a `toJSON()` is not a typed
 * error, and its text must not reach a client. The error handler and any
 * package deciding "is this a typed error" ask this one function, so they give
 * one answer.
 */
export function isSerializableError(error: unknown): error is SerializableError
{
    return typeof error === 'object'
        && error !== null
        && (error as { [SERIALIZABLE_ERROR_BRAND]?: unknown })[SERIALIZABLE_ERROR_BRAND] === true;
}
