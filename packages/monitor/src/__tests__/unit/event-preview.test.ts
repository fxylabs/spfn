/**
 * @spfn/monitor - the error detail view's event preview (#382)
 *
 * | #  | goes unnoticed without the row                                                       |
 * | -- | ------------------------------------------------------------------------------------ |
 * | V1 | a database error's preview reading `{ kind name code severity` — no fault, no frame |
 * | V2 | a row stored before #382 (a raw stack) previewing as nothing                         |
 */

import { describe, it, expect } from 'vitest';
import { describeError } from '@spfn/core/logger';
import { DrizzleQueryError } from 'drizzle-orm';
import { eventPreview } from '../../nextjs/components/event-preview';

const FRAMES = '    at insertUser (/app/users.js:10:5)\n    at register (/app/auth.js:20:7)\n    at handle (/app/route.js:30:9)\n    at next (/app/hono.js:40:1)';

function storedUniqueViolation(): string
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

    return JSON.stringify(describeError(error), null, 2);
}

describe('eventPreview', () =>
{
    it('V1: a stored description previews as its fault and its top three frames', () =>
    {
        const preview = eventPreview(storedUniqueViolation()).split('\n');

        expect(preview[0]).toMatch(/^\S+ \[code=23505\] \[constraint=users_email_key\] \[table=users\]$/);
        expect(preview.slice(1).map(frame => frame.trim())).toEqual([
            'at insertUser (/app/users.js:10:5)',
            'at register (/app/auth.js:20:7)',
            'at handle (/app/route.js:30:9)',
        ]);
    });

    it('V2: a raw stack stored before #382 keeps its first five lines', () =>
    {
        const raw = `Error: boom\n${FRAMES}\n    at more (/app/more.js:1:1)`;

        expect(eventPreview(raw)).toBe(raw.split('\n').slice(0, 5).join('\n'));
    });
});
