/**
 * HTTP Error Classes
 *
 * Standard HTTP error classes for API responses
 * All errors are serializable for type-safe client-side error handling
 */

import { SerializableError } from './serializable-error';

/**
 * Base HTTP Error
 *
 * Base class for all HTTP-related errors
 */
export class HttpError extends SerializableError
{
    public readonly statusCode: number;
    public details?: Record<string, unknown>;

    constructor(data: {
        message: string;
        statusCode: number;
        details?: Record<string, unknown>;
    })
    {
        super(data.message);

        this.name = 'HttpError';
        this.statusCode = data.statusCode;

        if (data.details)
        {
            this.details = data.details;
        }

        // `new` called on this class itself: its caller gave the status
        if (Object.getPrototypeOf(new.target) === SerializableError)
        {
            this.carryStatusCode();
        }

        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Bad Request Error (400)
 *
 * Generic bad request - malformed syntax, invalid parameters, etc.
 */
export class BadRequestError extends HttpError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Bad request',
            statusCode: 400,
            details: data.details,
        });

        this.name = 'BadRequestError';
    }
}

/**
 * Validation Error (400)
 *
 * Input validation failure (request params, query, body)
 * Used by define-route system for automatic validation
 */
export class ValidationError extends HttpError
{
    fields?: Array<{ path: string; message: string; value?: any }>;

    constructor(data: {
        message: string;
        fields?: Array<{ path: string; message: string; value?: any }>;
        details?: Record<string, any>;
    })
    {
        super({
            message: data.message,
            statusCode: 400,
            details: data.details,
        });

        this.name = 'ValidationError';

        if (data.fields)
        {
            this.fields = data.fields;
        }
    }
}

/**
 * Unauthorized Error (401)
 *
 * Authentication required or authentication failed
 */
export class UnauthorizedError extends HttpError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Authentication required',
            statusCode: 401,
            details: data.details,
        });

        this.name = 'UnauthorizedError';
    }
}

/**
 * Forbidden Error (403)
 *
 * Authenticated but lacks permission to access resource
 */
export class ForbiddenError extends HttpError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Access forbidden',
            statusCode: 403,
            details: data.details,
        });

        this.name = 'ForbiddenError';
    }
}

/**
 * Not Found Error (404)
 *
 * Requested resource does not exist
 */
export class NotFoundError extends HttpError
{
    resource?: string;

    constructor(data: { message?: string; resource?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Resource not found',
            statusCode: 404,
            details: data.details,
        });

        this.name = 'NotFoundError';

        if (data.resource)
        {
            this.resource = data.resource;
        }
    }
}

/**
 * Conflict Error (409)
 *
 * Generic conflict - resource state conflict, concurrent modification, etc.
 */
export class ConflictError extends HttpError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Resource conflict',
            statusCode: 409,
            details: data.details,
        });

        this.name = 'ConflictError';
    }
}

/**
 * Gone Error (410)
 *
 * Resource permanently deleted and no longer available
 */
export class GoneError extends HttpError
{
    resource?: string;

    constructor(data: { message?: string; resource?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Resource permanently deleted',
            statusCode: 410,
            details: data.details,
        });

        this.name = 'GoneError';

        if (data.resource)
        {
            this.resource = data.resource;
        }
    }
}

/**
 * Too Many Requests Error (429)
 *
 * Rate limit exceeded
 */
export class TooManyRequestsError extends HttpError
{
    retryAfter?: number;

    constructor(data: {
        message?: string;
        retryAfter?: number;
        details?: Record<string, any>;
    } = {})
    {
        super({
            message: data.message || 'Too many requests',
            statusCode: 429,
            details: data.details,
        });

        this.name = 'TooManyRequestsError';

        if (data.retryAfter)
        {
            this.retryAfter = data.retryAfter;
        }
    }
}

/**
 * Internal Server Error (500)
 *
 * Generic server error when no specific error type applies
 */
export class InternalServerError extends HttpError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Internal server error',
            statusCode: 500,
            details: data.details,
        });

        this.name = 'InternalServerError';
    }
}

/**
 * Unsupported Media Type Error (415)
 *
 * Media type not supported - invalid file type, content type, etc.
 */
export class UnsupportedMediaTypeError extends HttpError
{
    mediaType?: string;
    supportedTypes?: string[];

    constructor(data: {
        message?: string;
        mediaType?: string;
        supportedTypes?: string[];
        details?: Record<string, any>;
    } = {})
    {
        super({
            message: data.message || 'Unsupported media type',
            statusCode: 415,
            details: data.details,
        });

        this.name = 'UnsupportedMediaTypeError';

        if (data.mediaType)
        {
            this.mediaType = data.mediaType;
        }

        if (data.supportedTypes)
        {
            this.supportedTypes = data.supportedTypes;
        }
    }
}

/**
 * Unprocessable Entity Error (422)
 *
 * Request is well-formed but contains semantic errors
 */
export class UnprocessableEntityError extends HttpError
{
    constructor(data: { message?: string; details?: Record<string, any> } = {})
    {
        super({
            message: data.message || 'Unprocessable entity',
            statusCode: 422,
            details: data.details,
        });

        this.name = 'UnprocessableEntityError';
    }
}

/**
 * Service Unavailable Error (503)
 *
 * Service temporarily unavailable (maintenance, overload, etc.)
 */
export class ServiceUnavailableError extends HttpError
{
    retryAfter?: number;

    constructor(data: {
        message?: string;
        retryAfter?: number;
        details?: Record<string, any>;
    } = {})
    {
        super({
            message: data.message || 'Service unavailable',
            statusCode: 503,
            details: data.details,
        });

        this.name = 'ServiceUnavailableError';

        if (data.retryAfter)
        {
            this.retryAfter = data.retryAfter;
        }
    }
}
