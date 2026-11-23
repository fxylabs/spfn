/**
 * The framework's validation errors name the field and the rule, not the value (#467)
 *
 * Every TypeBox failure used to answer with the submitted value in
 * `fields[].value`, and the request logger copies a 4xx body into its line: a
 * password that failed its length rule, a malformed token in a header or a
 * cookie reached the response, the log, `onError` and the API client's
 * restored error.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { Type } from '@sinclair/typebox';
import { Logger, logger } from '@spfn/core/logger';
import { errorRegistry, ValidationError } from '@spfn/core/errors';
import type { ValidationFieldError } from '@spfn/core/errors';
import { route, defineRouter, registerRoutes, FileSchema } from '../index';
import { ErrorHandler } from '../../middleware/error-handler';
import { RequestLogger } from '../../middleware/request-logger';
import { errorFromResponse } from '../../nextjs/client/helpers';
import { captureLoggerClass } from '../../logger/__tests__/helpers/leak-probe';

const PASSWORD = 'Pw7chr!';

/** Field objects an app hands on as it got them — TypeBox's, say — value included */
const rawFields = (value: string) => [{ path: '/token', message: 'Unknown token', value }];

/** An app's error written the way `SerializableError`'s JSDoc shows: `Object.assign(this, data)` */
class AppFormError extends ValidationError
{
    constructor(data: { message: string; fields: ValidationFieldError[] })
    {
        super(data);
        Object.assign(this, data);
    }
}

const router = defineRouter({
    password: route.post('/password').input({ body: Type.Object({ password: Type.String({ minLength: 8 }) }) }).handler(async () => ({})),
    header: route.get('/header').input({ headers: Type.Object({ 'x-api-token': Type.String({ pattern: '^tok_[a-z]{8}$' }) }) }).handler(async () => ({})),
    cookie: route.get('/cookie').input({ cookies: Type.Object({ sid: Type.String({ minLength: 32 }) }) }).handler(async () => ({})),
    query: route.get('/query').input({ query: Type.Object({ page: Type.Integer() }) }).handler(async () => ({})),
    contact: route.post('/contact').input({ body: Type.Object({ contact: Type.Union([Type.String({ format: 'email' }), Type.Integer()]) }) }).handler(async () => ({})),
    subclass: route.post('/subclass').handler(async () =>
    {
        throw new AppFormError({ message: 'Invalid form', fields: rawFields('SUB-secret-31') });
    }),
    assigned: route.post('/assigned').handler(async () =>
    {
        const error = new ValidationError({ message: 'Invalid form' });
        error.fields = rawFields('ASG-secret-64');
        throw error;
    }),
    upload: route.post('/upload').input({ formData: Type.Object({ doc: FileSchema({ allowedTypes: ['image/png'] }) }) }).handler(async () => ({})),
});

function upload(): FormData
{
    const form = new FormData();
    form.append('doc', new File(['x'], 'a.txt', { type: 'text/x-mime-secret' }));

    return form;
}

const json = { 'Content-Type': 'application/json' };

const CASES = [
    { name: 'a too-short password', url: '/password', init: { method: 'POST', headers: json, body: JSON.stringify({ password: PASSWORD }) }, path: '/password', value: PASSWORD },
    { name: 'a malformed header', url: '/header', init: { headers: { 'x-api-token': 'HDR-secret-77' } }, path: '/x-api-token', value: 'HDR-secret-77' },
    { name: 'a malformed cookie', url: '/cookie', init: { headers: { cookie: 'sid=CK-secret-42' } }, path: '/sid', value: 'CK-secret-42' },
    { name: 'a bad query value', url: '/query?page=QRY-secret-9', init: {}, path: '/page', value: 'QRY-secret-9' },
    { name: 'a body that is not JSON', url: '/password', init: { method: 'POST', headers: json, body: '{"password": JSN-secret-5' }, path: '/', value: 'JSN-secret-5' },
    { name: 'a subclass that assigns its data', url: '/subclass', init: { method: 'POST' }, path: '/token', value: 'SUB-secret-31' },
    { name: 'fields assigned after construction', url: '/assigned', init: { method: 'POST' }, path: '/token', value: 'ASG-secret-64' },
    { name: 'a file of a refused type', url: '/upload', init: { method: 'POST', body: upload() }, path: '/doc', value: 'x-mime-secret' },
];

/** Assert the text holds no five-character run of the value */
function expectNoPartOf(text: string, value: string): void
{
    for (let start = 0; start + 5 <= value.length; start++)
    {
        expect(text).not.toContain(value.slice(start, start + 5));
    }
}

function appWith(onError: (err: Error) => void): Hono
{
    const app = new Hono();
    app.use(RequestLogger());
    app.onError(ErrorHandler({ onError }));
    registerRoutes(app, router);

    return app;
}

afterEach(() =>
{
    vi.restoreAllMocks();
});

describe('a validation error carries no submitted value', () =>
{
    it.each(CASES)('$name: the 400 body, the log and onError name $path and hold no part of the value', async ({ url, init, path, value }) =>
    {
        const { output } = captureLoggerClass(Logger);
        const hooked: string[] = [];

        const res = await appWith(err => void hooked.push(JSON.stringify(err))).request(url, init as RequestInit);
        const text = await res.text();
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(res.status).toBe(400);
        expect(JSON.parse(text).fields.map((field: { path: string }) => field.path)).toContain(path);
        expectNoPartOf(text, value);
        expect(output()).toContain(`"path":"${path}"`);
        expectNoPartOf(output(), value);
        expect(hooked).toHaveLength(1);
        expectNoPartOf(hooked[0], value);
    });

    it('a field error carries path and message only, whatever else TypeBox puts on it', async () =>
    {
        // A union failure: TypeBox's error carries value, schema, type and the nested errors of each branch
        const res = await appWith(vi.fn()).request('/contact', { method: 'POST', headers: json, body: JSON.stringify({ contact: 'not-an-email' }) });
        const body = await res.json() as { fields: object[] };

        expect(body.fields.length).toBeGreaterThan(0);
        for (const field of body.fields)
        {
            expect(Object.keys(field).sort()).toEqual(['message', 'path']);
        }
    });

    it('the fields an error holds cannot be changed in place, past the setter', () =>
    {
        const error = new ValidationError({ message: 'Invalid form', fields: [{ path: '/token', message: 'Unknown token' }] });

        expect(() => (error.fields as ValidationFieldError[]).push(rawFields('PSH-secret-18')[0])).toThrow(TypeError);
        expect(() => Object.assign(error.fields![0], { value: 'SET-secret-52' })).toThrow(TypeError);
        expectNoPartOf(JSON.stringify(error), 'PSH-secret-18');
        expectNoPartOf(JSON.stringify(error), 'SET-secret-52');
    });

    it('an own fields property defined past the setter throws, and error.fields stays the setter\'s', () =>
    {
        const error = new ValidationError({ message: 'Invalid form' });

        expect(() => Object.defineProperty(error, 'fields', { value: rawFields('DEF-secret-73'), enumerable: true })).toThrow(TypeError);
        expectNoPartOf(JSON.stringify(error.fields ?? null), 'DEF-secret-73');
    });

    it('a subclass declaring fields as a class field fails to construct, rather than holding raw fields', () =>
    {
        // What a plain-JS subclass writes; TypeScript refuses it (TS2610)
        class ShadowingError extends ValidationError
        {
            // @ts-expect-error a property overriding the accessor
            fields = rawFields('CLS-secret-35');
        }

        expect(() => new ShadowingError({ message: 'Invalid form' })).toThrow(TypeError);
    });

    it('fields is an own enumerable key, so a spread or an own-property serialiser carries the reduced list', () =>
    {
        const error = new ValidationError({ message: 'Invalid form', fields: rawFields('SPR-secret-26') });

        expect(Object.keys(error)).toContain('fields');
        expect({ ...error }).toHaveProperty('fields', [{ path: '/token', message: 'Unknown token' }]);
    });

    it('the API client restores a ValidationError without a value, even from a body that carries one', () =>
    {
        // What a server released before #467 answers
        const body = {
            __type: 'ValidationError',
            message: 'Invalid request body',
            fields: [{ path: '/password', message: 'Expected string length greater or equal to 8', value: PASSWORD }],
            error: { code: 'ValidationError', message: 'Invalid request body', requestId: 'req_1' },
        };

        const restored = errorFromResponse(new Response(null, { status: 400 }), body, 'http://api.test/password', errorRegistry, false, logger);

        expect(restored).toBeInstanceOf(ValidationError);
        expect((restored as ValidationError).fields).toEqual([{ path: '/password', message: 'Expected string length greater or equal to 8' }]);
        expectNoPartOf(JSON.stringify(restored), PASSWORD);
    });

    it.each([
        ['malformed entries', [null, 'x', { path: 1, message: 'm' }, { path: '/p' }, { path: '/password', message: 'Too short', value: PASSWORD }], [{ path: '/password', message: 'Too short' }]],
        ['fields that are not an array', { path: '/password', message: 'Too short', value: PASSWORD }, undefined],
    ])('the API client restores a ValidationError from a body with %s, leaving them out', (_name, fields, expected) =>
    {
        const body = { __type: 'ValidationError', message: 'Invalid request body', fields };

        const restored = errorFromResponse(new Response(null, { status: 400 }), body, 'http://api.test/password', errorRegistry, false, logger);

        expect(restored).toBeInstanceOf(ValidationError);
        expect((restored as ValidationError).fields).toEqual(expected);
        expectNoPartOf(JSON.stringify(restored), PASSWORD);
    });
});
