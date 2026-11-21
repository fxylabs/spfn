/**
 * Error Utilities Tests
 */

import { describe, it, expect } from 'vitest';
import {
    isDatabaseError,
    isHttpError,
    hasStatusCode,
    isSerializableError,
} from '../error-utils';
import {
    DatabaseError,
} from '../database-errors';
import {
    HttpError,
    UnauthorizedError,
} from '../http-errors';
import { SerializableError, SERIALIZABLE_ERROR_BRAND } from '../serializable-error';
import { NotFoundError as DistNotFoundError } from '@spfn/core/errors';

describe('isDatabaseError', () =>
{
    it('should return true for DatabaseError instances', () =>
    {
        const error = new DatabaseError({ message: 'Test error' });

        expect(isDatabaseError(error)).toBe(true);
    });

    it('should return false for non-DatabaseError errors', () =>
    {
        const error = new Error('Regular error');
        const httpError = new HttpError({ message: 'HTTP error', statusCode: 500 });

        expect(isDatabaseError(error)).toBe(false);
        expect(isDatabaseError(httpError)).toBe(false);
    });

    it('should return false for null and undefined', () =>
    {
        expect(isDatabaseError(null)).toBe(false);
        expect(isDatabaseError(undefined)).toBe(false);
    });

    it('should return false for non-error objects', () =>
    {
        expect(isDatabaseError({})).toBe(false);
        expect(isDatabaseError('string')).toBe(false);
        expect(isDatabaseError(123)).toBe(false);
    });
});

describe('isHttpError', () =>
{
    it('should return true for HttpError instances', () =>
    {
        const error = new HttpError({ message: 'Test error', statusCode: 500 });

        expect(isHttpError(error)).toBe(true);
    });

    it('should return true for HttpError subclasses', () =>
    {
        const unauthorizedError = new UnauthorizedError({ message: 'Not authenticated' });

        expect(isHttpError(unauthorizedError)).toBe(true);
    });

    it('should return false for non-HttpError errors', () =>
    {
        const error = new Error('Regular error');
        const dbError = new DatabaseError({ message: 'DB error' });

        expect(isHttpError(error)).toBe(false);
        expect(isHttpError(dbError)).toBe(false);
    });

    it('should return false for null and undefined', () =>
    {
        expect(isHttpError(null)).toBe(false);
        expect(isHttpError(undefined)).toBe(false);
    });

    it('should return false for non-error objects', () =>
    {
        expect(isHttpError({})).toBe(false);
        expect(isHttpError('string')).toBe(false);
        expect(isHttpError(123)).toBe(false);
    });
});

describe('hasStatusCode', () =>
{
    it('should return true for objects with numeric statusCode', () =>
    {
        const error = new DatabaseError({ message: 'Test error' });

        expect(hasStatusCode(error)).toBe(true);
    });

    it('should return true for plain objects with statusCode', () =>
    {
        const obj = { statusCode: 404 };

        expect(hasStatusCode(obj)).toBe(true);
    });

    it('should return false for objects without statusCode', () =>
    {
        const error = new Error('Regular error');

        expect(hasStatusCode(error)).toBe(false);
    });

    it('should return false for objects with non-numeric statusCode', () =>
    {
        const obj = { statusCode: '404' };

        expect(hasStatusCode(obj)).toBe(false);
    });

    it('should return false for null and undefined', () =>
    {
        expect(hasStatusCode(null)).toBe(false);
        expect(hasStatusCode(undefined)).toBe(false);
    });

    it('should return false for primitives', () =>
    {
        expect(hasStatusCode('string')).toBe(false);
        expect(hasStatusCode(123)).toBe(false);
        expect(hasStatusCode(true)).toBe(false);
    });
});

describe('isSerializableError', () =>
{
    it('S1: is true for an instance, and for an error of a second copy of the module (#382)', () =>
    {
        // `@spfn/core/errors` resolves to the built package: a second copy of
        // the class this file imports from source, as dev under tsx loads one
        const copy = new DistNotFoundError({ message: 'no such order' });

        expect(copy).not.toBeInstanceOf(SerializableError);
        expect(isSerializableError(new UnauthorizedError({ message: 'no' }))).toBe(true);
        expect(isSerializableError(copy)).toBe(true);
    });

    it('S2: is false for a provider error shaped like one — a numeric statusCode and a toJSON (#382)', () =>
    {
        const providerError = Object.assign(new Error('invalid_grant: token for internal-tenant 42 expired'), {
            statusCode: 400,
            toJSON: () => ({ __type: 'ProviderError', message: 'invalid_grant: token for internal-tenant 42 expired' }),
        });

        expect(isSerializableError(providerError)).toBe(false);
        expect(isSerializableError({ statusCode: 409, toJSON: () => ({ __type: 'ConflictError', message: 'x' }) })).toBe(false);
    });

    it('is false for a plain error, a status-only object and non-objects', () =>
    {
        expect(isSerializableError(new Error('plain'))).toBe(false);
        expect(isSerializableError({ statusCode: 500 })).toBe(false);
        expect(isSerializableError(null)).toBe(false);
        expect(isSerializableError('ConflictError')).toBe(false);
    });

    it('the brand is not an own key, so toJSON() never copies it', () =>
    {
        const error = new UnauthorizedError({ message: 'no' });

        expect(Reflect.ownKeys(error)).not.toContain(SERIALIZABLE_ERROR_BRAND);
        expect(Object.getOwnPropertySymbols(error.toJSON())).toEqual([]);
    });
});
