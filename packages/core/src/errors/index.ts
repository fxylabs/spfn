/**
 * Error Module Exports
 *
 * Entry point for error handling module with serialization support
 */

// Core Error Registry
// Pre-configured registry with all built-in HTTP and Database errors
import { ErrorRegistry } from './error-registry';
import {
    HttpError,
    BadRequestError,
    ValidationError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    ConflictError,
    GoneError,
    TooManyRequestsError,
    UnsupportedMediaTypeError,
    UnprocessableEntityError,
    InternalServerError,
    ServiceUnavailableError,
} from './http-errors';
import {
    DatabaseError,
    ConnectionError,
    QueryError,
    EntityNotFoundError,
    ConstraintViolationError,
    TransactionError,
    DeadlockError,
    DuplicateEntryError,
} from './database-errors';

// Base Classes
export { SerializableError } from './serializable-error';
export type { SerializedError } from './serializable-error';
export { ErrorRegistry } from './error-registry';
export type { SerializableErrorConstructor, ErrorRegistryInput } from './error-registry';

// Database Error Classes
export {
    DatabaseError,
    ConnectionError,
    QueryError,
    EntityNotFoundError,
    ConstraintViolationError,
    TransactionError,
    DeadlockError,
    DuplicateEntryError,
} from './database-errors';

// HTTP Error Classes
export {
    HttpError,
    BadRequestError,
    ValidationError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    ConflictError,
    GoneError,
    TooManyRequestsError,
    UnsupportedMediaTypeError,
    UnprocessableEntityError,
    InternalServerError,
    ServiceUnavailableError,
} from './http-errors';

// Error Utilities
export {
    isDatabaseError,
    isHttpError,
    hasStatusCode,
    isSerializableError,
} from './error-utils';

export const errorRegistry = new ErrorRegistry();

// HTTP Errors
errorRegistry.append([
    HttpError,
    BadRequestError,
    ValidationError,
    UnauthorizedError,
    ForbiddenError,
    NotFoundError,
    ConflictError,
    GoneError,
    TooManyRequestsError,
    UnsupportedMediaTypeError,
    UnprocessableEntityError,
    InternalServerError,
    ServiceUnavailableError,
]);

// Database Errors
errorRegistry.append([
    DatabaseError,
    ConnectionError,
    QueryError,
    EntityNotFoundError,
    ConstraintViolationError,
    TransactionError,
    DeadlockError,
    DuplicateEntryError,
]);

export * as HttpErrors from './http-errors';
export * as DatabaseErrors from './database-errors';
