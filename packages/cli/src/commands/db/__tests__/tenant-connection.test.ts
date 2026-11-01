/**
 * What `spfn db tenant export` / `import` print for an authentication failure
 * — row X10b of the #158 part 3 design case table, without a server
 *
 * A wrong password connects under `trust` auth, as in CI, so the integration
 * rows cannot provoke 28P01; these build the error postgres.js raises for it,
 * whose server message names the user.
 */

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
