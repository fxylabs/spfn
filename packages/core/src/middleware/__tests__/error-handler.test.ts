/**
 * Error Handler Middleware 테스트
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Hono, type Context } from 'hono';
import { Logger } from '@spfn/core/logger';
import { ErrorHandler, type OnErrorContext } from '../error-handler';
import { RequestLogger } from '../request-logger';
import { captureLoggerClass, expectNoValues, failedInsert } from '../../logger/__tests__/helpers/leak-probe';
import {
    NotFoundError,
    BadRequestError,
    InternalServerError,
    ValidationError,
} from '@spfn/core/errors';
import { ServiceUnavailableError } from '../../errors/http-errors';
// Imported from source so the `internal` getter under test is exercised
// regardless of the built dist freshness.
import { QueryError, EntityNotFoundError } from '../../errors/database-errors';

describe('ErrorHandler Middleware', () =>
{
    describe('SerializableError Handling', () =>
    {
        it('should handle NotFoundError (404)', async () =>
        {
            const app = new Hono();

            app.onError(ErrorHandler({ enableLogging: false }));

            app.get('/users/:id', () =>
            {
                throw new NotFoundError({ message: 'User not found', resource: 'User' });
            });

            const res = await app.request('/users/123');
            const json: any = await res.json();

            expect(res.status).toBe(404);
            expect(json.__type).toBe('NotFoundError');
            expect(json.message).toBe('User not found');
            expect(json.resource).toBe('User');
        });

        it('should handle BadRequestError (400)', async () =>
        {
            const app = new Hono();

            app.onError(ErrorHandler({ enableLogging: false }));

            app.post('/users', () =>
            {
                throw new BadRequestError({ message: 'Invalid input' });
            });

            const res = await app.request('/users', { method: 'POST' });
            const json: any = await res.json();

            expect(res.status).toBe(400);
            expect(json.__type).toBe('BadRequestError');
            expect(json.message).toBe('Invalid input');
        });

        it('should handle InternalServerError (500)', async () =>
        {
            const app = new Hono();

            app.onError(ErrorHandler({ enableLogging: false }));

            app.get('/crash', () =>
            {
                throw new InternalServerError({ message: 'Database connection failed' });
            });

            const res = await app.request('/crash');
            const json: any = await res.json();

            expect(res.status).toBe(500);
            expect(json.__type).toBe('InternalServerError');
            expect(json.message).toBe('Database connection failed');
        });

        it('should handle ValidationError with fields', async () =>
        {
            const app = new Hono();

            app.onError(ErrorHandler({ enableLogging: false }));

            app.post('/validate', () =>
            {
                throw new ValidationError({
                    message: 'Validation failed',
                    fields: [
                        { path: '/email', message: 'Invalid email format' },
                        { path: '/age', message: 'Must be positive number', value: -5 },
                    ],
                });
            });

            const res = await app.request('/validate', { method: 'POST' });
            const json: any = await res.json();

            expect(res.status).toBe(400);
            expect(json.__type).toBe('ValidationError');
            expect(json.message).toBe('Validation failed');
            expect(json.fields).toHaveLength(2);
            expect(json.fields[0].path).toBe('/email');
        });
    });

    describe('Retry-After', () =>
    {
        it('answers the retryAfter an error carries as the Retry-After header', async () =>
        {
            const app = new Hono();

            app.onError(ErrorHandler({ enableLogging: false }));
            app.get('/busy', () =>
            {
                throw new ServiceUnavailableError({ retryAfter: 2 });
            });
            app.get('/missing', () =>
            {
                throw new NotFoundError({ message: 'gone' });
            });

            const busy = await app.request('/busy');
            const missing = await app.request('/missing');

            expect(busy.status).toBe(503);
            expect(busy.headers.get('retry-after')).toBe('2');
            expect(missing.headers.get('retry-after')).toBeNull();
        });
    });

    describe('Standard Error Handling', () =>
    {
        it('should handle generic Error as 500', async () =>
        {
            const app = new Hono();

            app.onError(ErrorHandler({ enableLogging: false }));

            app.get('/error', () =>
            {
                throw new Error('Something went wrong');
            });

            const res = await app.request('/error');
            const json: any = await res.json();

            expect(res.status).toBe(500);
            expect(json.__type).toBe('Error');
            expect(json.message).toBe('Something went wrong');
        });

        it('should handle Error with custom statusCode', async () =>
        {
            const app = new Hono();

            app.onError(ErrorHandler({ enableLogging: false }));

            app.get('/custom', () =>
            {
                const error = new Error('Custom error') as Error & { statusCode: number };
                error.statusCode = 418;
                throw error;
            });

            const res = await app.request('/custom');
            const json: any = await res.json();

            expect(res.status).toBe(418);
            expect(json.__type).toBe('Error');
            expect(json.message).toBe('Custom error');
        });

        it('should provide default message for empty error', async () =>
        {
            const app = new Hono();

            app.onError(ErrorHandler({ enableLogging: false }));

            app.get('/empty', () =>
            {
                throw new Error('');
            });

            const res = await app.request('/empty');
            const json: any = await res.json();

            expect(res.status).toBe(500);
            expect(json.message).toBe('Internal Server Error');
        });
    });

    describe('Stack Trace Option', () =>
    {
        it('should include stack trace when includeStack is true', async () =>
        {
            const app = new Hono();

            app.onError(ErrorHandler({ includeStack: true, enableLogging: false }));

            app.get('/error', () =>
            {
                throw new NotFoundError({ message: 'Not found' });
            });

            const res = await app.request('/error');
            const json: any = await res.json();

            expect(res.status).toBe(404);
            expect(json.stack).toBeDefined();
            expect(json.stack).toContain('NotFoundError');
        });

        it('should exclude stack trace when includeStack is false', async () =>
        {
            const app = new Hono();

            app.onError(ErrorHandler({ includeStack: false, enableLogging: false }));

            app.get('/error', () =>
            {
                throw new NotFoundError({ message: 'Not found' });
            });

            const res = await app.request('/error');
            const json: any = await res.json();

            expect(res.status).toBe(404);
            expect(json.stack).toBeUndefined();
        });

        it('should include stack trace for standard errors when enabled', async () =>
        {
            const app = new Hono();

            app.onError(ErrorHandler({ includeStack: true, enableLogging: false }));

            app.get('/error', () =>
            {
                throw new Error('Standard error');
            });

            const res = await app.request('/error');
            const json: any = await res.json();

            expect(res.status).toBe(500);
            expect(json.stack).toBeDefined();
        });
    });

    describe('Duck Typing for SerializableError', () =>
    {
        it('should handle duck-typed SerializableError-like objects', async () =>
        {
            const app = new Hono();

            app.onError(ErrorHandler({ enableLogging: false }));

            app.get('/duck', () =>
            {
                // Create an error-like object with toJSON and statusCode
                const error = new Error('Duck typed error') as any;
                error.statusCode = 403;
                error.toJSON = () => ({
                    __type: 'CustomError',
                    message: 'Duck typed error',
                    customField: 'custom value',
                });
                throw error;
            });

            const res = await app.request('/duck');
            const json: any = await res.json();

            expect(res.status).toBe(403);
            expect(json.__type).toBe('CustomError');
            expect(json.customField).toBe('custom value');
        });
    });

    describe('Logging Behavior', () =>
    {
        it('should not throw when logging is enabled', async () =>
        {
            const app = new Hono();

            // Enable logging (default behavior)
            app.onError(ErrorHandler({ enableLogging: true }));

            app.get('/error', () =>
            {
                throw new NotFoundError({ message: 'Test error' });
            });

            const res = await app.request('/error');

            expect(res.status).toBe(404);
        });

        it('should work with logging disabled', async () =>
        {
            const app = new Hono();

            app.onError(ErrorHandler({ enableLogging: false }));

            app.get('/error', () =>
            {
                throw new InternalServerError({ message: 'Server error' });
            });

            const res = await app.request('/error');

            expect(res.status).toBe(500);
        });
    });

    describe('Default Options', () =>
    {
        it('should use default options when none provided', async () =>
        {
            const app = new Hono();

            // No options provided - uses defaults
            app.onError(ErrorHandler());

            app.get('/error', () =>
            {
                throw new BadRequestError({ message: 'Test' });
            });

            const res = await app.request('/error');

            expect(res.status).toBe(400);
        });
    });

    describe('Production information disclosure', () =>
    {
        // Simulate a raw driver error as built by fromPostgresError
        const RAW_SQL = 'column "secret_col" does not exist';

        it('hides DB-driver message for internal errors in production (includeStack=false)', async () =>
        {
            const app = new Hono();
            app.onError(ErrorHandler({ includeStack: false, enableLogging: false }));
            app.get('/q', () =>
            {
                throw new QueryError({ message: RAW_SQL, statusCode: 500, details: { code: '42703' } });
            });

            const res = await app.request('/q');
            const json: any = await res.json();

            expect(res.status).toBe(500);
            expect(json.__type).toBe('QueryError');
            expect(json.message).toBe('Internal server error');
            expect(JSON.stringify(json)).not.toContain('secret_col');
            expect(json.details).toBeUndefined();
        });

        it('hides schema-revealing 4xx driver errors too', async () =>
        {
            const app = new Hono();
            app.onError(ErrorHandler({ includeStack: false, enableLogging: false }));
            app.get('/q', () =>
            {
                throw new QueryError({ message: RAW_SQL, statusCode: 400, details: { code: '42703' } });
            });

            const res = await app.request('/q');
            const json: any = await res.json();

            expect(res.status).toBe(400);
            expect(json.message).toBe('Internal server error');
            expect(JSON.stringify(json)).not.toContain('secret_col');
        });

        it('keeps the full driver message in development (includeStack=true)', async () =>
        {
            const app = new Hono();
            app.onError(ErrorHandler({ includeStack: true, enableLogging: false }));
            app.get('/q', () =>
            {
                throw new QueryError({ message: RAW_SQL, statusCode: 500 });
            });

            const json: any = await (await app.request('/q')).json();
            expect(json.message).toBe(RAW_SQL);
        });

        it('still exposes errors with a safe constructed message (EntityNotFoundError) in production', async () =>
        {
            const app = new Hono();
            app.onError(ErrorHandler({ includeStack: false, enableLogging: false }));
            app.get('/e', () =>
            {
                throw new EntityNotFoundError({ resource: 'User', id: 42 });
            });

            const res = await app.request('/e');
            const json: any = await res.json();

            expect(res.status).toBe(404);
            expect(json.message).toBe('User with id 42 not found');
        });

        it('genericizes uncaught standard errors and drops cause in production', async () =>
        {
            const app = new Hono();
            app.onError(ErrorHandler({ includeStack: false, enableLogging: false }));
            app.get('/raw', () =>
            {
                throw new Error('Failed query: select * from users\nparams: secret');
            });

            const res = await app.request('/raw');
            const json: any = await res.json();

            expect(res.status).toBe(500);
            expect(json.message).toBe('Internal Server Error');
            expect(json.cause).toBeUndefined();
            expect(JSON.stringify(json)).not.toContain('secret');
        });
    });

    describe('A database error is answered and logged without its bound values (#382)', () =>
    {
        afterEach(() =>
        {
            vi.restoreAllMocks();
        });

        /** The error handler and the request logger, which logs every ≥400 body, around a failed insert */
        const failingApp = (includeStack: boolean) =>
        {
            const app = new Hono();
            app.use(RequestLogger());
            app.onError(ErrorHandler({ includeStack }));
            app.post('/register', () =>
            {
                throw failedInsert();
            });

            return app;
        };

        it('R9: outside production the body is the description; in production it is unchanged; no log or body carries a value', async () =>
        {
            const { lines, output } = captureLoggerClass(Logger);

            const staging: any = await (await failingApp(true).request('/register', { method: 'POST' })).json();
            const production: any = await (await failingApp(false).request('/register', { method: 'POST' })).json();
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(staging).toMatchObject({
                __type: 'Error',
                message: 'Database error',
                database: { kind: 'database', code: '23505', constraint: 'users_email_key', paramCount: 2 },
            });
            expect(staging.cause).toBeUndefined();
            expect(staging.stack).toBeUndefined();
            expect(production).toEqual({
                __type: 'Error',
                message: 'Internal Server Error',
                error: { code: 'Error', message: 'Internal Server Error', requestId: expect.any(String) },
            });
            expectNoValues(JSON.stringify(staging));
            expect(output()).toContain('[code=23505]');
            expect(output()).toContain('"code":"23505"');
            expectNoValues(output());

            const productionLine = lines.filter(line => line.message === 'Error occurred')[1];
            expect(productionLine.error).toBeUndefined();
            expect(productionLine.context!.error).toMatchObject({ kind: 'database', name: 'DrizzleQueryError', constraint: 'users_email_key' });
            expect(productionLine.context!.error).not.toHaveProperty('stack');
        });

        it('R9b: in production the log line carries an ordinary error\'s description, without its stack, under context.error', async () =>
        {
            const { lines } = captureLoggerClass(Logger);
            const app = new Hono();
            app.onError(ErrorHandler({ includeStack: false }));
            app.get('/x', () =>
            {
                throw Object.assign(new Error('boom'), { code: 'E_BOOM' });
            });

            await app.request('/x');
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(lines.find(line => line.message === 'Error occurred')!.context!.error).toEqual({ kind: 'error', name: 'Error', message: 'boom', code: 'E_BOOM' });
        });

        it('F3: the request logger keeps an error body it copies, stack, details and error envelope — it is data, not an error', async () =>
        {
            const { lines } = captureLoggerClass(Logger);
            const app = new Hono();
            app.use(RequestLogger());
            app.onError(ErrorHandler({ includeStack: true }));
            app.get('/x', () =>
            {
                throw new ValidationError({ message: 'bad', fields: [{ path: 'email', message: 'required' }], details: { form: 'signup' } });
            });

            await app.request('/x');
            await new Promise(resolve => setTimeout(resolve, 0));

            const copy = lines.find(line => line.message === 'Request completed')!.context!.response;
            expect(copy).toMatchObject({
                __type: 'ValidationError',
                fields: [{ path: 'email', message: 'required' }],
                details: { form: 'signup' },
                stack: expect.any(String),
            });
            // The envelope is the body's own data: under alreadySentToClient its
            // `error` key is not described as a caught value
            expect((copy as Record<string, unknown>).error).toEqual({
                code: 'ValidationError',
                message: 'bad',
                requestId: expect.stringMatching(/^req_/),
            });
        });
    });

    describe('Error envelope', () =>
    {
        const envelopeApp = (throwing: () => never) =>
        {
            const app = new Hono();
            app.onError(ErrorHandler({ enableLogging: false }));
            app.get('/x', throwing);

            return app;
        };

        it('carries code, message and requestId next to __type', async () =>
        {
            const app = envelopeApp(() =>
            {
                throw new NotFoundError({ message: 'User not found', resource: 'User' });
            });

            const json: any = await (await app.request('/x')).json();

            expect(json.__type).toBe('NotFoundError');
            expect(json.resource).toBe('User');
            expect(json.error.code).toBe('NotFoundError');
            expect(json.error.message).toBe('User not found');
            expect(json.error.requestId).toMatch(/^[0-9a-f]{32}$/);
        });

        it('reuses the request id RequestLogger set, so logs and body agree', async () =>
        {
            const app = new Hono();
            app.onError(ErrorHandler({ enableLogging: false }));
            // RequestLogger sets this on a bare Context; the app-typed one here needs the cast.
            app.use('*', async (c, next) =>
            {
                (c as Context).set('requestId', 'fixed-request-id');
                await next();
            });
            app.get('/x', () =>
            {
                throw new NotFoundError({ message: 'gone' });
            });

            const json: any = await (await app.request('/x')).json();

            expect(json.error.requestId).toBe('fixed-request-id');
        });

        it('codes a standard error as Error without leaking its message', async () =>
        {
            const app = new Hono();
            app.onError(ErrorHandler({ enableLogging: false, includeStack: false }));
            app.get('/x', () =>
            {
                throw new Error('connection string secret');
            });

            const json: any = await (await app.request('/x')).json();

            expect(json.error.code).toBe('Error');
            expect(json.error.message).toBe('Internal Server Error');
            expect(JSON.stringify(json)).not.toContain('secret');
        });

        it('masks the envelope message on an internal error exactly like the body', async () =>
        {
            const app = new Hono();
            app.onError(ErrorHandler({ enableLogging: false, includeStack: false }));
            app.get('/x', () =>
            {
                throw new QueryError({ message: 'select * from users where token = $1' });
            });

            const json: any = await (await app.request('/x')).json();

            expect(json.message).toBe('Internal server error');
            expect(json.error.message).toBe('Internal server error');
            expect(JSON.stringify(json)).not.toContain('select *');
        });

        it('is omitted when the option is off, leaving the body as it was', async () =>
        {
            const app = new Hono();
            app.onError(ErrorHandler({ enableLogging: false, errorEnvelope: false }));
            app.get('/x', () =>
            {
                throw new NotFoundError({ message: 'User not found' });
            });

            const json: any = await (await app.request('/x')).json();

            expect(json.__type).toBe('NotFoundError');
            expect(json.error).toBeUndefined();
        });
    });

    describe('Request context masking (S-L8)', () =>
    {
        it('masks sensitive query params in the onError context', async () =>
        {
            let captured: OnErrorContext | undefined;

            const app = new Hono();
            app.onError(ErrorHandler({
                enableLogging: false,
                onError: (_err, ctx) => 
                {
                    captured = ctx; 
                },
            }));
            app.get('/x', () =>
            {
                throw new Error('boom');
            });

            await app.request('/x?token=supersecret&code=abc123&page=2');
            // onError fires asynchronously (fire-and-forget) — flush the microtask queue.
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(captured?.request.query.token).toBe('***');
            expect(captured?.request.query.code).toBe('***');
            expect(captured?.request.query.page).toBe('2');
        });
    });
});
