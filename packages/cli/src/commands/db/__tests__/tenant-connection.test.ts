/**
 * What `spfn db tenant export` / `import` print for an authentication failure
 * — row X10b of the #158 part 3 design case table, without a server
 *
 * A wrong password connects under `trust` auth, as in CI, so the integration
 * rows cannot provoke 28P01; these build the error postgres.js raises for it,
 * whose server message names the user.
 */

import { DrizzleQueryError } from 'drizzle-orm';
import pg from 'pg';
import postgres from 'postgres';
import { describe, it, expect } from 'vitest';
import { describeError } from '../tenant/connection';

const URL_WITH_SECRET = 'postgresql://x10c-user:x10c-secret@db.example.test:5432/app';

/** A PostgresError as postgres.js builds it from the server's ErrorResponse fields. */
function serverError(code: string, message: string): postgres.PostgresError
{
    const PostgresError = postgres.PostgresError as unknown as new (fields: object) => postgres.PostgresError;

    return new PostgresError({ severity: 'FATAL', code, message, routine: 'auth_failed' });
}

describe('describeError for an authentication failure', () =>
{
    it.each([
        ['28P01', 'password authentication failed for user "x10c-user"'],
        ['28000', 'role "x10c-user" does not exist'],
    ])('X10b SQLSTATE %s prints only the code, not the user the server named', (code, message) =>
    {
        const text = describeError(serverError(code, message), URL_WITH_SECRET);

        expect(text).toBe(`authentication failed (${code})`);
        expect(text).not.toContain('x10c-user');
    });
});

describe('describeError for a failed db push project statement (pg through drizzle)', () =>
{
    it('X11 a pg.DatabaseError naming a constraint: the server\'s message and the constraint, not drizzle\'s query and params', () =>
    {
        const cause = Object.assign(
            new pg.DatabaseError('duplicate key value violates unique constraint "accounts_email_key"', 0, 'error'),
            { code: '23505', constraint: 'accounts_email_key' },
        );
        const error = new DrizzleQueryError('ALTER TABLE "accounts" ADD CONSTRAINT "accounts_email_key" UNIQUE("email")', ['x11-param'], cause);

        const text = describeError(error, URL_WITH_SECRET);

        expect(text).toBe('duplicate key value violates unique constraint "accounts_email_key" (constraint accounts_email_key)');
        expect(text).not.toMatch(/ALTER TABLE|x11-param/);
    });
});
