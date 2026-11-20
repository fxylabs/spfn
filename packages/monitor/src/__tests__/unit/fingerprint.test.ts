/**
 * @spfn/monitor - Fingerprint Tests (#382)
 *
 * A group is one fault: the route path, each link of the cause chain by its
 * name, code, constraint and table, and the top three frames without their
 * line and column. The message is not part of it — a failed statement's
 * message carries its bound values.
 *
 * That one fault with other bound values is one group is row M2 of
 * `error-text.test.ts`: it takes `trackError`, where the message used to go in.
 *
 * | #  | goes unnoticed without the row                                                    |
 * | -- | --------------------------------------------------------------------------------- |
 * | F1 | distinct faults merged into one group (constraint, path or frames dropped)        |
 * | F2 | every deploy that shifts a line opening a new group for each known fault         |
 */

import { describe, it, expect } from 'vitest';
import { describeError } from '@spfn/core/logger';
import { DrizzleQueryError } from 'drizzle-orm';
import { generateFingerprint } from '../../server/services/error-tracking.service';

const FRAMES = '    at insertUser (/app/users.js:10:5)\n    at register (/app/auth.js:20:7)\n    at handle (/app/route.js:30:9)';

/** A postgres.js 23505 under drizzle's query error, its stack the given frames */
function uniqueViolation(email: string, constraint = 'users_email_key', frames = FRAMES): Error
{
    const driverError = Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
        name: 'PostgresError',
        severity: 'ERROR',
        code: '23505',
        detail: `Key (email)=(${email}) already exists.`,
        table_name: 'users',
        constraint_name: constraint,
        routine: '_bt_check_unique',
    });
    const error = new DrizzleQueryError('insert into "users" ("email") values ($1)', [email], driverError);
    error.stack = `${error.name}: ${error.message}\n${frames}`;

    return error;
}

function fingerprintOf(error: Error, path = '/api/users'): string
{
    return generateFingerprint(describeError(error), path);
}

describe('generateFingerprint', () =>
{
    it('F1: another constraint, path or call site is another group', () =>
    {
        const first = fingerprintOf(uniqueViolation('a@example.test'));

        expect(first).toMatch(/^[0-9a-f]{16}$/);
        const elsewhere = FRAMES.replace('insertUser', 'importUsers');

        expect(fingerprintOf(uniqueViolation('a@example.test', 'users_phone_key'))).not.toBe(first);
        expect(fingerprintOf(uniqueViolation('a@example.test'), '/api/admins')).not.toBe(first);
        expect(fingerprintOf(uniqueViolation('a@example.test', 'users_email_key', elsewhere))).not.toBe(first);
    });

    it('F2: the same call site on other lines is one group', () =>
    {
        const shifted = FRAMES.replace('users.js:10:5', 'users.js:14:9');

        expect(fingerprintOf(uniqueViolation('a@example.test', 'users_email_key', shifted)))
            .toBe(fingerprintOf(uniqueViolation('a@example.test')));
    });
});
