/**
 * Every class in `errorRegistry` survives the trip to the client (#459)
 *
 * A thrown error is serialized by `toJSON()`, travels as JSON, and is rebuilt by
 * the client's `errorFromResponse` through `ErrorRegistry.deserialize` — which
 * hands the constructor the fields where the body carries them, and nothing
 * else: not the response's HTTP status, which an interceptor or a proxy may
 * have rewritten. A constructor that reads a field from anywhere else rebuilds
 * the error without it, and nothing fails: the client just holds less.
 *
 * | Row | Checks | Unnoticed without it |
 * | --- | --- | --- |
 * | R1 | the fixtures name exactly the registered classes | a class registered later with no fixture, never round-tripped |
 * | R2 | each class, built with every constructor field set, is restored as the same class with the same public fields and status | a field the constructor reads from where the body does not carry it: `HttpError`'s, `DatabaseError`'s, `QueryError`'s and `TransactionError`'s `statusCode`, given per instance, came back `undefined` or 500 |
 * | R3 | the README's fixed-status class keeps its 402 when answered through a 502 | the response status pushed into the constructor: `Object.assign(this, data)` overwrites the class's own status |
 * | R4 | a class whose fixed status is a getter is restored | the same push: `Object.assign` throws on the getter and the client falls back to a generic error |
 * | R5 | a body from an older server, without `statusCode`, restores the per-instance classes as before | a constructor that came to require the field: an older server's error no longer restored, or with another status |
 * | R6 | an internal `QueryError` thrown 400, answered by the production handler, is restored with 400 | the redacted production body dropping the `statusCode` the instance carries |
 * | R7 | `DuplicateEntryError`'s value is in neither its body nor the error the client restores | the value sent as a public field: a sign-up form's 409 confirms the email it echoes exists |
 * | R8 | each class not given its status — every fixed-status class, and `DatabaseError`, `QueryError`, `TransactionError` built without one — sends exactly the body keys it sent on `main` | a body key every client sees that no one decided on: `statusCode` serialized by `HttpError` and `DatabaseError` for every class built on them |
 * | R9 | each class, imported as an app imports it (`@spfn/core/errors`, the built bundle), sends its own name as `__type` | a class renamed by the bundler — esbuild bundles a class that names itself in its own body as `_HttpError` — travelling under a name no registry or SDK knows; this file's other rows import the source, which keeps the name |
 * | R10 | an app's internal error whose `toJSON()` throws is answered by the production handler with the generic redacted body | the redacted body built through the error's own serializer: the failure goes unanswered and the client gets no body to restore |
 *
 * Each fixture is typed `Required<…>` of its constructor's argument, so a class
 * that gains a field does not compile here until the fixture sets it.
 *
 * `fixtures/main-body-keys.json` was taken from `main` at d0105b3b: each
 * registered class, built there with this file's fixtures less `statusCode`,
 * serialized, and its keys listed in order.
 */

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

import { logger } from '@spfn/core/logger';
import * as builtErrors from '@spfn/core/errors';

import { ErrorRegistry, errorRegistry } from '../index';
import { SerializableError } from '../serializable-error';
import { ErrorHandler } from '../../middleware/error-handler';
import * as httpErrors from '../http-errors';
import * as databaseErrors from '../database-errors';
import { DuplicateEntryError, QueryError } from '../database-errors';
import { errorFromResponse } from '../../nextjs/client/helpers';
import mainBodyKeys from './fixtures/main-body-keys.json';

const classes = { ...httpErrors, ...databaseErrors };

type Classes = typeof classes;

/** Every field of each class's constructor argument, none left to its default. */
type Fixtures = { [K in keyof Classes]: Required<NonNullable<ConstructorParameters<Classes[K]>[0]>> };

const CAUSE = new Error('driver said no');

const fixtures: Fixtures = {
    HttpError: { message: 'teapot', statusCode: 418, details: { k: 'v' } },
    BadRequestError: { message: 'bad', details: { k: 'v' } },
    ValidationError: { message: 'invalid', fields: [{ path: '/a', message: 'required', value: 1 }], details: { k: 'v' } },
    UnauthorizedError: { message: 'who', details: { k: 'v' } },
    ForbiddenError: { message: 'no', details: { k: 'v' } },
    NotFoundError: { message: 'gone', resource: 'User', details: { k: 'v' } },
    ConflictError: { message: 'clash', details: { k: 'v' } },
    GoneError: { message: 'gone for good', resource: 'User', details: { k: 'v' } },
    TooManyRequestsError: { message: 'slow down', retryAfter: 30, details: { k: 'v' } },
    UnsupportedMediaTypeError: { message: 'what', mediaType: 'text/x', supportedTypes: ['application/json'], details: { k: 'v' } },
    UnprocessableEntityError: { message: 'cannot', details: { k: 'v' } },
    InternalServerError: { message: 'oops', details: { k: 'v' } },
    ServiceUnavailableError: { message: 'later', retryAfter: 5, details: { k: 'v' } },
    DatabaseError: { message: 'db', statusCode: 502, details: { k: 'v' }, cause: CAUSE },
    ConnectionError: { message: 'down', details: { k: 'v' }, cause: CAUSE },
    QueryError: { message: 'query', statusCode: 400, details: { k: 'v' }, cause: CAUSE },
    EntityNotFoundError: { resource: 'User', id: 7 },
    ConstraintViolationError: { message: 'constraint', details: { k: 'v' }, cause: CAUSE },
    TransactionError: { message: 'tx', statusCode: 400, details: { k: 'v' }, cause: CAUSE },
    DeadlockError: { message: 'deadlock', details: { k: 'v' }, cause: CAUSE },
    DuplicateEntryError: { field: 'email', value: 'a@example.com', cause: CAUSE },
};

/** What the client throws for `body`, answered with `status` and restored through `registry`. */
function restoredFrom(body: unknown, status: number, registry: ErrorRegistry = errorRegistry): SerializableError
{
    return errorFromResponse(
        new Response(null, { status }),
        body,
        'http://app.test/api/rpc/route',
        registry,
        false,
        logger,
    ) as SerializableError;
}

/** What the client throws for `thrown`, answered with its own status. */
function restored(thrown: SerializableError): SerializableError
{
    return restoredFrom(JSON.parse(JSON.stringify(thrown)), thrown.statusCode);
}

/** The README's "Custom errors" example, verbatim: a fixed status as a field. */
class PaymentFailedError extends SerializableError
{
    readonly statusCode = 402;
    transactionId!: string;
    reason!: 'insufficient_funds' | 'card_declined';

    constructor(data: { message: string; transactionId: string; reason: 'insufficient_funds' | 'card_declined' })
    {
        super(data.message);
        this.name = 'PaymentFailedError';
        Object.assign(this, data);
    }
}

/** A fixed status as a prototype getter — as valid an implementation of the abstract member. */
class GetterStatusError extends SerializableError
{
    get statusCode(): number
    {
        return 409;
    }

    constructor(data: { message?: string } = {})
    {
        super(data.message ?? 'clash');
        this.name = 'GetterStatusError';
        Object.assign(this, data);
    }
}

/** An app's internal error whose serializer throws. */
class UnserializableInternalError extends SerializableError
{
    readonly statusCode = 500;

    get internal(): boolean
    {
        return true;
    }

    override toJSON(): never
    {
        throw new Error('serializer broke');
    }
}

/** The answer of the production error handler to a route that throws `thrown`. */
async function productionAnswer(thrown: Error): Promise<Response>
{
    const app = new Hono();
    app.onError(ErrorHandler({ includeStack: false, enableLogging: false }));
    app.get('/q', () =>
    {
        throw thrown;
    });

    return await app.request('/q');
}

/** The public fields a client reads: the body's, and the status. */
function publicFields(error: SerializableError): Record<string, unknown>
{
    return { ...error.toJSON(), statusCode: error.statusCode };
}

describe('errorRegistry round trip (#459)', () =>
{
    it('R1: the fixtures name exactly the registered classes', () =>
    {
        expect(Object.keys(fixtures).sort()).toEqual(errorRegistry.getRegisteredTypes().sort());
    });

    it.each(Object.keys(fixtures) as Array<keyof Classes>)('R2: %s is restored with its public fields', (name) =>
    {
        const ErrorClass = classes[name] as new (data: unknown) => SerializableError;
        const thrown = new ErrorClass(fixtures[name]);
        const error = restored(thrown);

        expect(error.constructor).toBe(ErrorClass);
        expect(publicFields(error)).toStrictEqual(publicFields(thrown));
    });

    it('R3: the README\'s fixed-status class keeps its 402 when answered through a 502', () =>
    {
        const thrown = new PaymentFailedError({ message: 'declined', transactionId: 't-1', reason: 'card_declined' });
        const error = restoredFrom(JSON.parse(JSON.stringify(thrown)), 502, new ErrorRegistry([PaymentFailedError]));

        expect(error).toBeInstanceOf(PaymentFailedError);
        expect(error.statusCode).toBe(402);
    });

    it('R4: a class whose fixed status is a getter is restored', () =>
    {
        const error = restoredFrom(JSON.parse(JSON.stringify(new GetterStatusError())), 409, new ErrorRegistry([GetterStatusError]));

        expect(error).toBeInstanceOf(GetterStatusError);
        expect(error.statusCode).toBe(409);
    });

    it.each([
        ['HttpError', undefined],
        ['DatabaseError', 500],
        ['QueryError', 500],
        ['TransactionError', 500],
    ] as const)('R5: %s from an older server, without statusCode in its body, is restored with %s', (name, statusCode) =>
    {
        const error = restoredFrom({ __type: name, message: 'older', details: { k: 'v' } }, 418);

        expect(error.constructor).toBe(classes[name]);
        expect(error.statusCode).toBe(statusCode);
    });

    it('R6: an internal QueryError thrown 400, answered by the production handler, is restored with 400', async () =>
    {
        const response = await productionAnswer(new QueryError({ message: 'SELECT secret_col FROM t', statusCode: 400 }));
        const error = restoredFrom(await response.json(), response.status);

        expect(error).toBeInstanceOf(QueryError);
        expect(error.statusCode).toBe(400);
        expect(error.message).toBe('Internal server error');
    });

    it('R7: DuplicateEntryError\'s value is in neither its body nor the error the client restores', () =>
    {
        const thrown = new DuplicateEntryError({ field: 'email', value: 'taken@example.com' });
        const body = JSON.stringify(thrown);

        expect(thrown.value).toBe('taken@example.com');
        expect(body).not.toContain('taken@example.com');
        expect((restored(thrown) as DuplicateEntryError).value).toBeUndefined();
    });

    // HttpError is given its status by every caller: R2 round-trips it
    it.each(Object.keys(fixtures).filter(name => name !== 'HttpError') as Array<Exclude<keyof Classes, 'HttpError'>>)('R8: %s, not given its status, sends the body keys it sent on main', (name) =>
    {
        const ErrorClass = classes[name] as new (data: unknown) => SerializableError;
        const { statusCode: _given, ...argument } = fixtures[name] as { statusCode?: number };

        // DuplicateEntryError's `value` leaves the body on purpose (R7)
        expect(Object.keys(JSON.parse(JSON.stringify(new ErrorClass(argument)))))
            .toEqual(mainBodyKeys[name].filter(key => !(name === 'DuplicateEntryError' && key === 'value')));
    });

    it.each(Object.keys(fixtures) as Array<keyof Classes>)('R9: %s, as an app imports it, sends its own name as __type', (name) =>
    {
        const ErrorClass = builtErrors[name] as new (data: unknown) => SerializableError;

        expect(new ErrorClass(fixtures[name]).toJSON().__type).toBe(name);
    });

    it('R10: an internal error whose toJSON() throws is answered by the production handler with the generic body', async () =>
    {
        const response = await productionAnswer(new UnserializableInternalError('SELECT secret_col FROM t'));

        expect(response.status).toBe(500);
        expect(await response.json()).toMatchObject({ __type: 'UnserializableInternalError', message: 'Internal server error' });
    });
});
