/**
 * @spfn/monitor - the error detail view's event preview (#382)
 *
 * | #   | goes unnoticed without the row                                                       |
 * | --- | ------------------------------------------------------------------------------------ |
 * | V1  | a database error's preview reading `{ kind name code severity` — no fault, no frame |
 * | V1b | a wrapped database error's preview naming the wrapper only — not the cause's code, constraint, table |
 * | V1c | a plain error's preview dropping the message its description kept — events indistinguishable |
 * | V1d | a thrown non-Error value's preview dropping what its description holds (name, code) |
 * | V2  | a row stored before #382 (a raw stack) previewing its header or `params:` line — SQL and bound values |
 * | V2b | a raw stack's message line starting `at ` previewed as a frame                       |
 * | V2c | a raw stack's bound value with a line starting `at ` previewed as a frame             |
 * | V2d | a V8 frame form (`async`, `native`, `<anonymous>`, `index N`, bare location) dropped from the preview |
 *
 * Not rowed: `error-detail-view.tsx` calling `eventPreview`. Rendering it needs
 * react-dom, a DOM environment and a mocked `monitorApi`, none of which
 * monitor's test setup has.
 */

import { describe, it, expect } from 'vitest';
import { describeError } from '@spfn/core/logger';
import { DrizzleQueryError } from 'drizzle-orm';
import { eventPreview } from '../../nextjs/components/event-preview';
import { summarizeError } from '../../error-summary';

const FRAMES = '    at insertUser (/app/users.js:10:5)\n    at register (/app/auth.js:20:7)\n    at handle (/app/route.js:30:9)\n    at next (/app/hono.js:40:1)';

function uniqueViolationError(): DrizzleQueryError
{
    const driverError = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
        name: 'PostgresError',
        severity: 'ERROR',
        code: '23505',
        detail: 'Key (email)=(a@example.test) already exists.',
        table_name: 'users',
        constraint_name: 'users_email_key',
        routine: '_bt_check_unique',
    });
    const error = new DrizzleQueryError('insert into "users" ("email") values ($1)', ['a@example.test'], driverError);
    error.stack = `${error.name}: ${error.message}\n${FRAMES}`;

    return error;
}

function storedUniqueViolation(): string
{
    return JSON.stringify(describeError(uniqueViolationError()), null, 2);
}

function wrappedUniqueViolation(): string
{
    const error = new Error('Could not create the user', { cause: uniqueViolationError() });
    error.stack = `${error.name}: ${error.message}\n${FRAMES}`;

    return JSON.stringify(describeError(error), null, 2);
}

describe('eventPreview', () =>
{
    it('V1: a stored description previews as its fault and its top three frames', () =>
    {
        const stored = storedUniqueViolation();
        const preview = eventPreview(stored).split('\n');

        expect(preview[0]).toBe(summarizeError(JSON.parse(stored)));
        expect(preview[0]).toMatch(/^\S+ \[code=23505\] \[constraint=users_email_key\] \[table=users\]/);
        expect(preview.slice(1).map(frame => frame.trim())).toEqual([
            'at insertUser (/app/users.js:10:5)',
            'at register (/app/auth.js:20:7)',
            'at handle (/app/route.js:30:9)',
        ]);
        expect(preview.join('\n')).not.toContain('a@example.test');
    });

    it('V1b: a wrapped database error previews with its cause\'s code, constraint and table', () =>
    {
        const preview = eventPreview(wrappedUniqueViolation()).split('\n');

        expect(preview[0]).toMatch(/^Error: Could not create the user ← \S+ \[code=23505\] \[constraint=users_email_key\] \[table=users\]/);
        expect(preview.join('\n')).not.toContain('a@example.test');
    });

    it('V1c: a plain error previews with the message its description kept', () =>
    {
        const error = new Error('Stripe card declined');
        error.stack = `Error: Stripe card declined\n${FRAMES}`;

        expect(eventPreview(JSON.stringify(describeError(error))).split('\n')[0]).toBe('Error: Stripe card declined');
    });

    it('V1d: a thrown non-Error value previews as what its description holds', () =>
    {
        const stored = JSON.stringify(describeError({ code: 'E_QUOTA', message: 'Quota exceeded', params: ['secret-value'] }));

        expect(eventPreview(stored)).toBe('NonError [code=E_QUOTA]: Quota exceeded');
    });

    it('V2: a raw stack stored before #382 previews as its error name and its frames only', () =>
    {
        const raw = `Error: Failed query: insert into "users" ("email") values ($1)\nparams: a@example.test\n${FRAMES}`;

        expect(eventPreview(raw)).toBe([
            'Error',
            '    at insertUser (/app/users.js:10:5)',
            '    at register (/app/auth.js:20:7)',
            '    at handle (/app/route.js:30:9)',
        ].join('\n'));
    });

    it('V2b: a raw stack\'s message line starting `at ` is not a frame', () =>
    {
        const raw = `Error: lookup failed\nat tenant-secret-value\n    at tenant-secret-value\n${FRAMES}`;

        expect(eventPreview(raw)).not.toContain('tenant-secret-value');
        expect(eventPreview(raw).split('\n')[1]).toBe('    at insertUser (/app/users.js:10:5)');
    });

    it('V2c: a raw DrizzleQueryError stack whose bound value holds a line starting `at ` previews without it', () =>
    {
        const error = new DrizzleQueryError(
            'insert into "addresses" ("line") values ($1)',
            ['Flat 2\nat Baker Street 221b, ring twice'],
            new Error('value too long for type character varying(20)'),
        );
        error.stack = `${error.name}: ${error.message}\n${FRAMES}`;

        expect(error.stack).toContain('\nat Baker Street 221b, ring twice');
        expect(eventPreview(error.stack)).not.toContain('Baker Street');
        expect(eventPreview(error.stack).split('\n').slice(1)).toEqual(FRAMES.split('\n').slice(0, 3));
    });

    it('V2d: every V8 frame form is a frame', () =>
    {
        const frames = [
            '    at async Promise.all (index 0)',
            '    at new Promise (<anonymous>)',
            '    at Array.map (native)',
            '    at file:///app/server.mjs:12:3',
            '    at <anonymous>',
            '    at async UserService.create [as create] (C:\\app\\users.js:4:9)',
        ];

        expect(eventPreview(`Error: boom\n${frames.join('\n')}`).split('\n').slice(1)).toEqual(frames.slice(0, 3));
        expect(eventPreview(`Error: boom\n${frames.slice(3).join('\n')}`).split('\n').slice(1)).toEqual(frames.slice(3));
    });
});
