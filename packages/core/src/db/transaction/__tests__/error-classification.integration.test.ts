/**
 * Transactional() error classification
 *
 * `Transactional()` catches whatever the handler threw, feeds it to the
 * reconnect trigger, and then decides whether it is a PostgreSQL error worth
 * converting into an SPFN error class. Getting that decision wrong is not a
 * cosmetic bug: `fromPostgresError` answers an unrecognised code with
 * `QueryError 500`, so an application error misrouted into it reaches the
 * client as a bare 500 with its status and its serialized envelope gone.
 *
 * One test per row of the issue-#82 case table, plus the driver's own
 * connection errors (`CONNECTION_CLOSED` and friends), which the table does not
 * list but which still have to convert.
 *
 * Error classes are imported through `@spfn/core/errors` — the same specifier
 * the middleware itself uses — so `instanceof` compares against the same class
 * objects the middleware compared against. A relative `../../errors` import
 * resolves to a second copy of the module and every `instanceof` here would
 * silently answer false.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
    SerializableError,
    ForbiddenError,
    DatabaseError,
    TransactionError,
    DuplicateEntryError,
    ConnectionError,
} from '@spfn/core/errors';
import { Transactional } from '../middleware';
import { testUsers } from '../../__tests__/fixtures/test-schema';
import { createDbTestFixture } from '../../__tests__/helpers/db-fixture';
import { getTransaction } from '../context';
import {
    isConnectionLevelError,
    resetConnectionErrorCounter,
} from '../../manager/reconnect-trigger';

/**
 * An application error class of the kind the issue reported: a coded refusal.
 * It extends the framework family, so it owns a status code and a serialized
 * envelope, AND it carries a machine-readable `code` for the client — the exact
 * combination the old gate converted into a 500.
 */
class PolicyRefusedError extends ForbiddenError
{
    readonly code: string;

    constructor(data: { message: string; code: string })
    {
        super({ message: data.message });
        this.name = 'PolicyRefusedError';
        this.code = data.code;
    }
}

/**
 * What one run through `Transactional()` produced.
 */
interface CapturedThrow
{
    /** The last error seen — the one that escaped the middleware. */
    escaped: unknown;

    /** Every value Hono handed to `onError`, in frame order. */
    onErrorCalls: unknown[];
}

/**
 * Run `thrower` inside `Transactional()` and report what escaped the
 * middleware.
 *
 * Two capture points, because Hono's `compose` catches at every frame
 * (`hono/dist/compose.js`) and returns rather than re-throwing:
 *
 * - An `Error` is caught at the frame that threw it. The handler's throw is
 *   caught at the handler's own frame, where compose sets `context.error` —
 *   the signal `Transactional()` re-throws on — and calls `onError`. The error
 *   `Transactional()` finally re-throws is caught one frame out and calls
 *   `onError` a SECOND time. So `onErrorCalls` is the record of which frames
 *   threw: the first entry is written before `Transactional()`'s catch has even
 *   run, and only the second entry proves the error came back out of it. A test
 *   that looks at `escaped` alone would still pass if the middleware swallowed
 *   the error entirely, because the handler's own frame already wrote it.
 * - A non-`Error` throw is never passed to `onError`; compose re-throws it, so
 *   it surfaces in the outer middleware's catch instead and `onErrorCalls` stays
 *   empty. There the swallow shows up directly — `escaped` would stay `null`.
 */
async function captureThrough(thrower: () => Promise<unknown>): Promise<CapturedThrow>
{
    const app = new Hono();
    const onErrorCalls: unknown[] = [];
    let escaped: unknown = null;

    app.onError((err, c) =>
    {
        onErrorCalls.push(err);
        escaped = err;

        return c.text('captured', 500);
    });

    app.use('*', async (c, next) =>
    {
        try
        {
            await next();
        }
        catch (error)
        {
            escaped = error;
        }

        return c.text('captured', 500);
    });

    app.use('*', Transactional({ enableLogging: false }));
    app.post('/t', async () =>
    {
        await thrower();

        return new Response('unreachable');
    });

    await app.request('/t', { method: 'POST' });

    return { escaped, onErrorCalls };
}

/**
 * Assert that `thrown` came back out of `Transactional()` as itself.
 *
 * Identity alone is not enough (see `captureThrough`): the second `onError`
 * call is the one that belongs to the middleware's own frame, so its presence
 * is what distinguishes "re-thrown unchanged" from "swallowed".
 */
function expectPassedThrough(captured: CapturedThrow, thrown: unknown): void
{
    expect(captured.onErrorCalls).toHaveLength(2);
    expect(captured.onErrorCalls[1]).toBe(thrown);
    expect(captured.escaped).toBe(thrown);
}

/**
 * Assert that `Transactional()` re-threw something OTHER than what the handler
 * threw — the conversion path. Same arity requirement, opposite identity.
 */
function expectConverted(captured: CapturedThrow, thrown: unknown): void
{
    expect(captured.onErrorCalls).toHaveLength(2);
    expect(captured.onErrorCalls[0]).toBe(thrown);
    expect(captured.escaped).not.toBe(thrown);
}

describe('Transactional() error classification', () =>
{
    const dbFixture = createDbTestFixture();

    beforeAll(async () =>
    {
        await dbFixture.setup();

        if (dbFixture.isAvailable)
        {
            await dbFixture.execute(`
                CREATE TABLE IF NOT EXISTS test_users (
                    id SERIAL PRIMARY KEY,
                    name TEXT NOT NULL,
                    email TEXT NOT NULL UNIQUE,
                    created_at TIMESTAMP DEFAULT NOW() NOT NULL
                )
            `);
        }
    });

    beforeEach((context) => dbFixture.skipIfUnavailable(context));

    afterAll(async () =>
    {
        await dbFixture.execute('DROP TABLE IF EXISTS test_users CASCADE');
        await dbFixture.teardown();
    });

    beforeEach(async () =>
    {
        resetConnectionErrorCounter();
        await dbFixture.cleanTable('test_users');
    });

    describe('application errors pass through', () =>
    {
        it('passes an SPFN HTTP error that carries no code', async () =>
        {
            const thrown = new ForbiddenError({ message: 'nope' });
            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            expectPassedThrough(captured, thrown);
            expect((captured.escaped as ForbiddenError).statusCode).toBe(403);
        });

        it('passes an application error extending the framework family WITH a string code', async () =>
        {
            const thrown = new PolicyRefusedError({
                message: 'tenant is suspended',
                code: 'TENANT_SUSPENDED',
            });

            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            // The identity, the status and the envelope all survive: this is
            // the production regression the issue-#82 comment reported.
            expectPassedThrough(captured, thrown);

            const escaped = captured.escaped;

            expect(escaped).toBeInstanceOf(SerializableError);
            expect((escaped as PolicyRefusedError).statusCode).toBe(403);
            expect((escaped as PolicyRefusedError).toJSON()).toMatchObject({
                __type: 'PolicyRefusedError',
                message: 'tenant is suspended',
                code: 'TENANT_SUSPENDED',
            });
        });

        it('passes a Stripe-shaped error with code "resource_missing"', async () =>
        {
            const thrown = Object.assign(new Error('No such charge: ch_1'), {
                code: 'resource_missing',
                type: 'invalid_request_error',
                statusCode: 404,
            });

            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            expectPassedThrough(captured, thrown);
            expect(captured.escaped).not.toBeInstanceOf(DatabaseError);
        });

        it('passes a JWT-shaped error with code "ERR_JOSE_..."', async () =>
        {
            const thrown = Object.assign(new Error('signature verification failed'), {
                code: 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
            });

            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            expectPassedThrough(captured, thrown);
            expect(captured.escaped).not.toBeInstanceOf(DatabaseError);
        });

        it('passes a plain object (not an Error) that carries a code', async () =>
        {
            const thrown = { code: 'resource_missing', message: 'no such customer' };
            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            // Not an `Error`, so compose re-throws instead of calling onError:
            // this one is captured in the outer middleware, and a swallow would
            // leave `escaped` null. No second frame to count.
            expect(captured.onErrorCalls).toHaveLength(0);
            expect(captured.escaped).toBe(thrown);
        });
    });

    describe('the framework family passes through early', () =>
    {
        it('passes a DatabaseError instance unchanged', async () =>
        {
            const thrown = new DatabaseError({ message: 'already classified' });
            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            expectPassedThrough(captured, thrown);
        });

        it('passes a TransactionError instance unchanged', async () =>
        {
            const thrown = new TransactionError({ message: 'already classified' });
            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            expectPassedThrough(captured, thrown);
        });

        it('passes a DatabaseError even when it carries a SQLSTATE-shaped code', async () =>
        {
            // The early family gate has to win over the conversion gate:
            // re-converting an already-classified error would flatten, say, a
            // 409 DuplicateEntryError into a fresh one built from a raw message.
            const thrown = Object.assign(
                new ConnectionError({ message: 'connection failure', details: { code: '08006' } }),
                { code: '08006', severity: 'FATAL' },
            );

            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            expectPassedThrough(captured, thrown);
        });
    });

    describe('genuine driver errors convert', () =>
    {
        it('converts a driver-shaped unique violation (23505) to DuplicateEntryError', async () =>
        {
            // Shaped exactly as postgres.js builds a PostgresError: the server's
            // ErrorResponse fields copied onto the error (see `errorFields` in
            // postgres/src/connection.js).
            const thrown = Object.assign(
                new Error('duplicate key value violates unique constraint "test_users_email_key"'),
                {
                    severity_local: 'ERROR',
                    severity: 'ERROR',
                    code: '23505',
                    detail: 'Key (email)=(dup@example.com) already exists.',
                    schema_name: 'public',
                    table_name: 'test_users',
                    constraint_name: 'test_users_email_key',
                    file: 'nbtinsert.c',
                    line: '666',
                    routine: '_bt_check_unique',
                },
            );

            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            expectConverted(captured, thrown);

            const escaped = captured.escaped;

            expect(escaped).toBeInstanceOf(DuplicateEntryError);
            expect((escaped as DuplicateEntryError).statusCode).toBe(409);

            // `field` is the fallback, not 'email': fromPostgresError parses the
            // Key clause out of `message`, and postgres.js puts it in `detail`.
            // Pinned as-is — the brief scopes this change to the gate, and
            // fromPostgresError is not to be touched.
            expect((escaped as DuplicateEntryError).field).toBe('field');
        });

        it('converts a driver error that carries only severity_local (PostgreSQL < 9.6)', async () =>
        {
            // `V` (severity) arrived in 9.6; `S` (severity_local) has always
            // been sent. The gate must accept either.
            const thrown = Object.assign(new Error('deadlock detected'), {
                severity_local: 'ERROR',
                code: '40P01',
            });

            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            expectConverted(captured, thrown);
            expect(captured.escaped).toBeInstanceOf(DatabaseError);
            expect((captured.escaped as DatabaseError).name).toBe('DeadlockError');
        });

        it('converts a pooler-shaped connection error (08006) AND reports it to the reconnect trigger', async () =>
        {
            // A pooler-synthesized ErrorResponse: severity, code and message,
            // none of the source-location fields. This is why the gate asks for
            // severity rather than `routine`.
            const thrown = Object.assign(new Error('server closed the connection unexpectedly'), {
                severity: 'FATAL',
                code: '08006',
            });

            // reportDatabaseError runs before any classification, and it reads
            // the raw error — so the narrowed gate cannot hide it.
            expect(isConnectionLevelError(thrown)).toBe(true);

            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            expectConverted(captured, thrown);
            expect(captured.escaped).toBeInstanceOf(ConnectionError);
            expect((captured.escaped as ConnectionError).statusCode).toBe(503);
        });

        it('converts a connection error the driver raised itself (CONNECTION_CLOSED)', async () =>
        {
            // postgres.js builds this one, not the server: `Errors.connection`
            // sets a code of the driver's own invention plus errno/address, and
            // no severity — so the SQLSTATE-plus-severity half of the gate can
            // never see it. It is still a genuine driver error (the socket died
            // mid-transaction), and it keeps its `QueryError` envelope, which is
            // what the generated non-JS clients classify on.
            const thrown = Object.assign(new Error('write CONNECTION_CLOSED localhost:5432'), {
                code: 'CONNECTION_CLOSED',
                errno: 'CONNECTION_CLOSED',
                address: 'localhost',
                port: '5432',
            });

            expect(isConnectionLevelError(thrown)).toBe(true);

            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            expectConverted(captured, thrown);

            const escaped = captured.escaped;

            expect(escaped).toBeInstanceOf(DatabaseError);
            expect((escaped as DatabaseError).statusCode).toBe(500);
            expect((escaped as DatabaseError).toJSON()).toMatchObject({
                __type: 'QueryError',
                details: { code: 'CONNECTION_CLOSED' },
            });
        });

        it('leaves the error a real unique violation produces exactly as it was before the gate narrowed', async () =>
        {
            // A real insert, not a hand-built error. Drizzle wraps the driver's
            // PostgresError in a DrizzleQueryError which carries no `code` of
            // its own, so this error did not match the OLD gate either and is
            // not converted now — behaviour is unchanged, and the reconnect
            // trigger still sees the wrapped PostgresError because it walks
            // `cause`. Pinned because it is the single most load-bearing
            // "converts as before" case in the table.
            const { escaped, onErrorCalls } = await captureThrough(async () =>
            {
                const tx = getTransaction();

                await tx!.insert(testUsers).values({ name: 'a', email: 'dup@example.com' });
                await tx!.insert(testUsers).values({ name: 'b', email: 'dup@example.com' });
            });

            expect(onErrorCalls).toHaveLength(2);
            expect(escaped).toBe(onErrorCalls[0]);
            expect(escaped).not.toBeInstanceOf(DatabaseError);
            expect((escaped as { cause?: { code?: string } }).cause?.code).toBe('23505');
        });
    });

    describe('the narrowed gate', () =>
    {
        it('passes a hostile object with code "23505" but no driver fields', async () =>
        {
            // The documented trade: a SQLSTATE-shaped code alone no longer
            // triggers conversion. A caller who hand-rolls a pg error loses the
            // conversion; in exchange no application error is ever mangled.
            const thrown = Object.assign(new Error('not really from postgres'), { code: '23505' });

            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            expectPassedThrough(captured, thrown);
            expect(captured.escaped).not.toBeInstanceOf(DatabaseError);
        });

        it('passes a severity-carrying error whose code is neither SQLSTATE nor a driver code', async () =>
        {
            // A severity alone proves nothing — the code still has to name a
            // driver, either by SQLSTATE shape or by being one of postgres.js's
            // own connection codes. `ThrottlingException` is neither.
            const thrown = Object.assign(new Error('rate exceeded'), {
                code: 'ThrottlingException',
                severity: 'FATAL',
            });

            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            expectPassedThrough(captured, thrown);
            expect(captured.escaped).not.toBeInstanceOf(DatabaseError);
        });

        it('passes an error with a non-string code', async () =>
        {
            const thrown = Object.assign(new Error('errno-style'), { code: 23505, severity: 'ERROR' });

            const captured = await captureThrough(async () =>
            {
                throw thrown;
            });

            expectPassedThrough(captured, thrown);
        });
    });
});
