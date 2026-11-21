/**
 * What `describeFailure` prints for a failed `spfn db push` / `db tenant
 * export` / `import`, without a server — row X10b of the #158 part 3 design
 * case table, and the #378 rows
 *
 * A wrong password connects under `trust` auth, as in CI, so the integration
 * rows cannot provoke 28P01; these build the error postgres.js raises for it,
 * whose server message names the user.
 */

import { DrizzleQueryError } from 'drizzle-orm';
import pg from 'pg';
import postgres from 'postgres';
import { describe, it, expect } from 'vitest';
import { describeFailure, failingIn } from '../database-failure';

const URL_WITH_SECRET = 'postgresql://x10c-user:x10c-secret@db.example.test:5432/app';

/** A PostgresError as postgres.js builds it from the server's ErrorResponse fields. */
function serverError(code: string, message: string, fields: object = { severity: 'FATAL', routine: 'auth_failed' }): postgres.PostgresError
{
    const PostgresError = postgres.PostgresError as unknown as new (fields: object) => postgres.PostgresError;

    return new PostgresError({ code, message, ...fields });
}

/** A failed COPY FROM as postgres.js raises it: the statement in `query`, the row's value in `where`. */
function copyError(where: string): postgres.PostgresError
{
    return Object.assign(
        serverError('22P02', 'invalid input syntax for type bigint: "y1-SECRETVALUE"', { severity: 'ERROR', routine: 'pg_strtoint64_safe', where }),
        { query: 'COPY "spfn_tenant_import_2" ("id", "tenant_id", "body") FROM STDIN' },
    );
}

describe('describeFailure for an authentication failure', () =>
{
    it.each([
        ['28P01', 'password authentication failed for user "x10c-user"'],
        ['28000', 'role "x10c-user" does not exist'],
    ])('X10b SQLSTATE %s prints only the code, not the user the server named', (code, message) =>
    {
        const text = describeFailure(serverError(code, message), URL_WITH_SECRET);

        expect(text).toBe(`Database authentication failed (${code})`);
        expect(text).not.toContain('x10c-user');
    });
});

describe('describeFailure for a failed db push project statement (pg through drizzle)', () =>
{
    it('X11 a pg.DatabaseError naming a constraint: the server\'s message and the constraint, then the statement — never drizzle\'s params', () =>
    {
        const cause = Object.assign(
            new pg.DatabaseError('duplicate key value violates unique constraint "accounts_email_key"', 0, 'error'),
            { severity: 'ERROR', code: '23505', constraint: 'accounts_email_key', schema: 'public', table: 'accounts', routine: '_bt_check_unique' },
        );
        const error = new DrizzleQueryError('ALTER TABLE "accounts" ADD CONSTRAINT "accounts_email_key" UNIQUE("email")', ['x11-param'], cause);

        const text = describeFailure(error, URL_WITH_SECRET);

        expect(text).toBe('duplicate key value violates unique constraint "accounts_email_key" (23505, constraint accounts_email_key, table public.accounts)\n'
            + '   Failed statement: ALTER TABLE "accounts" ADD CONSTRAINT "accounts_email_key" UNIQUE("email")');
        expect(text).not.toMatch(/x11-param/);
    });
});

describe('describeFailure for a URL the error names that is not the connection\'s', () =>
{
    it('X12 another URL\'s credentials are blanked (redactUrls), as is the connection URL', () =>
    {
        const error = new Error(`could not load the schema: postgres://x12-user:x12-secret@other.example.test/app via ${URL_WITH_SECRET}`);

        const text = describeFailure(error, URL_WITH_SECRET);

        expect(text).toBe('could not load the schema: postgres://<redacted>@other.example.test/app via ***');
        expect(text).not.toMatch(/x12-secret|x10c-secret/);
    });
});

describe('describeFailure for a failed COPY (#378)', () =>
{
    it.each([
        ['COPY spfn_tenant_import_2, line 3, column id: "y1-SECRETVALUE"'],
        ['COPY spfn_tenant_import_2, line 3: "y1-SECRETVALUE\t7\tb"'],
        ['COPY spfn_tenant_import_2, line 3, column body: null input'],
    ])('Y1 where %j: the statement, then the relation and the line — not the column or the value', (where) =>
    {
        const text = describeFailure(copyError(where), URL_WITH_SECRET);

        expect(text).toBe('Invalid input value (22P02)\n'
            + '   Failed statement: COPY "spfn_tenant_import_2" ("id", "tenant_id", "body") FROM STDIN\n'
            + '   At: COPY spfn_tenant_import_2, line 3');
    });

    it('Y2 a where that is not a COPY position is dropped', () =>
    {
        const text = describeFailure(copyError('PL/pgSQL function y2() line 1 at RAISE: y1-SECRETVALUE'), URL_WITH_SECRET);

        expect(text).not.toMatch(/At:|SECRETVALUE|PL\/pgSQL/);
    });
});

describe('describeFailure for a statement from a known source (#378)', () =>
{
    it('Y3 a failingIn rejection names its source above the statement; the error keeps its message', async () =>
    {
        const error = await failingIn('@spfn/y3 migration 20260101000000_y3', Promise.reject(copyError('COPY t, line 1: "x"')))
            .catch((caught: unknown) => caught);

        expect(describeFailure(error, URL_WITH_SECRET)).toBe('Invalid input value (22P02)\n'
            + '   In: @spfn/y3 migration 20260101000000_y3\n'
            + '   Failed statement: COPY "spfn_tenant_import_2" ("id", "tenant_id", "body") FROM STDIN\n'
            + '   At: COPY t, line 1');
        expect((error as Error).message).toBe('invalid input syntax for type bigint: "y1-SECRETVALUE"');
    });

    it('Y4 a failingIn rejection that is not a database error: its message, then its source', async () =>
    {
        const failure = Object.assign(new Error('ENOENT: no such file or directory, open \'/tmp/y4.copy\''), { code: 'ENOENT', syscall: 'open' });
        const error = await failingIn('tenant file y4.copy', Promise.reject(failure)).catch((caught: unknown) => caught);

        expect(describeFailure(error, URL_WITH_SECRET)).toBe('ENOENT: no such file or directory, open \'/tmp/y4.copy\'\n   In: tenant file y4.copy');
    });
});
