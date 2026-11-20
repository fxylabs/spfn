/**
 * A logged database error carries no bound value (#382)
 *
 * drizzle's query error holds every bound value in `params`, in its message
 * and in its stack header; the driver error under it adds `detail`. The logger
 * renders any error it is handed through `describeError`, so each row hands it
 * the error one way a log site does and asserts the output holds none of them.
 *
 * | #   | the error reaches the logger                | goes unnoticed without the row                              |
 * | --- | ------------------------------------------- | ----------------------------------------------------------- |
 * | R4  | as the error argument                       | a fix that drops only the stack's first line: line 2 is `params:` |
 * | R5  | inside the context object                   | the key-masking walk printing `params` and the cause's `detail` |
 * | R7  | a 22P02 driver error                        | a class-22 message quoting the rejected input               |
 * | R7b | a kept class from an unknown routine (`RAISE`, PL/Python) | a kept class carrying the app's own text; a pooler's routine-less 08 losing its message |
 * | F1  | formatted into a printf-style message (`%s`, `%o`, `%j`, a stray `%c`) | the documented printf form handing the error to `util.format` undescribed |
 *
 * What is the caught value is decided by position, never by the value's shape (G2):
 *
 * | #   | the caught value reaches the logger         | goes unnoticed without the row                              |
 * | --- | ------------------------------------------- | ----------------------------------------------------------- |
 * | A1  | a thrown plain object with `params`, as `{ error }` and as the 2nd of 3 | the object walked as context, its params printed |
 * | A2  | `undefined`, a string or a plain object, with a context | the context dropped (a transaction id missing from the line) |
 * | A3  | an app error with `code`, `statusCode`, `details` | a failed job's `output` losing the error's `code`      |
 *
 * And describing never throws into the log call that asked for it (G4):
 *
 * | #   | the error                                   | goes unnoticed without the row                              |
 * | --- | ------------------------------------------- | ----------------------------------------------------------- |
 * | D1  | has getters that throw, or is a Proxy       | `logger.error` throwing, replacing the error being handled  |
 * | D2  | has a cause chain 20,000 links deep         | a stack overflow out of the log call                        |
 * | D3  | has a cause chain that loops                | a loop described as if it ended, or not at all              |
 * | D4  | is not one: a context object with a `stack` | a domain object read as an error, its fields dropped        |
 */

import { describe, it, expect } from 'vitest';
import { Logger } from '../logger';
import { CAUSE_DEPTH_LIMIT, describeError } from '../error-description';
import { BOUND_VALUES, capturingLogger, expectNoValues, failedInsert, FAILED_INSERT } from './helpers/leak-probe';

/** Let the logger's transports, which run on a microtask, finish */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

describe('a logged database error carries no bound value', () =>
{
    it('R4: logger.error(message, error) prints the code, constraint, table and SQL, and no value', async () =>
    {
        const { logger, output } = capturingLogger(Logger);

        logger.error('Insert failed', failedInsert());
        await settle();

        expectNoValues(output());
        expect(output()).toContain('[code=23505]');
        expect(output()).toContain('[constraint=users_email_key]');
        expect(output()).toContain('[table=users]');
        expect(output()).toContain('duplicate key value violates unique constraint "users_email_key"');
        expect(output()).toContain(FAILED_INSERT);
    });

    it('R5: an error inside the context is described, not walked', async () =>
    {
        const { logger, output } = capturingLogger(Logger);

        logger.error('Insert failed', { op: 'register', error: failedInsert() });
        await settle();

        expectNoValues(output());
        expect(output()).toContain('"code":"23505"');
        expect(output()).toContain('"paramCount":2');
    });

    it('F1: an error formatted into a printf-style message is its description, also inside an object', async () =>
    {
        const { logger, output } = capturingLogger(Logger);

        logger.error('Saving user failed: %s', failedInsert());
        logger.error('Saving user failed: %o', failedInsert());
        logger.error('Saving user failed: %O', failedInsert());
        logger.error('Saving user failed: %j', { e: failedInsert() });
        logger.error('Saving user failed: %o', { e: failedInsert() });
        logger.error(`Upload of /files/caf%c3%a9.txt failed`, failedInsert());
        await settle();

        expectNoValues(output());
        expect(output()).toContain('[code=23505]');
        expect(output()).toContain('\\"code\\":\\"23505\\"');
    });

    it('R7: a class-22 driver message, which quotes the rejected input, is left out', () =>
    {
        const invalidInput = Object.assign(new Error('invalid input syntax for type integer: "leak-probe-value"'), {
            severity: 'ERROR',
            code: '22P02',
            routine: 'pg_strtoint32_safe',
        });

        const description = describeError(invalidInput);

        expect(description).toMatchObject({ kind: 'database', code: '22P02' });
        expect(JSON.stringify(description)).not.toContain('leak-probe-value');
    });

    it('R7b: a kept class from an unknown routine keeps no message; one that names no routine keeps it', () =>
    {
        const raised = (routine: string): Error => Object.assign(new Error('leak-probe@example.test taken'), {
            severity: 'ERROR',
            code: '23505',
            constraint_name: 'users_email_key',
            table_name: 'users',
            routine,
        });
        const pooler = Object.assign(new Error('no more connections allowed (max_client_conn)'), { severity: 'FATAL', code: '08P01' });

        for (const routine of ['exec_stmt_raise', 'PLy_elog_impl'])
        {
            const description = describeError(raised(routine));

            expect(description).toMatchObject({ kind: 'database', code: '23505', constraint: 'users_email_key', table: 'users', routine });
            expect(description).not.toHaveProperty('message');
        }

        expect(describeError(pooler)).toMatchObject({ kind: 'database', code: '08P01', message: 'no more connections allowed (max_client_conn)' });
    });
});

describe('the caught value is described whatever its shape', () =>
{
    /** What a dependency might throw: not an Error, values in an arbitrary field */
    const thrownObject = (): Record<string, unknown> => ({ code: 'BROKEN', message: 'broken', params: [...BOUND_VALUES], detail: 'Key (email)=(leak-probe@example.test)' });

    it('A1: a thrown plain object logged as { error } or as the second of three arguments keeps no field but name, message and code', async () =>
    {
        const { logger, lines, output } = capturingLogger(Logger);

        logger.error('operation failed', { error: thrownObject(), op: 'register' });
        logger.error('operation failed', thrownObject(), { op: 'register' });
        logger.error('operation failed', { err: thrownObject(), cause: 'a string', reason: thrownObject() });
        await settle();

        expectNoValues(output());
        expect(lines[0].context).toEqual({ error: { kind: 'error', name: 'NonError', message: 'broken', code: 'BROKEN' }, op: 'register' });
        expect(lines[1].error).toEqual({ kind: 'error', name: 'NonError', message: 'broken', code: 'BROKEN' });
        expect(lines[1].context).toEqual({ op: 'register' });
        expect(lines[2].context!.cause).toEqual({ kind: 'error', name: 'NonError', message: 'a string' });
    });

    it('A2: with three arguments the context is kept whatever the caught value is', async () =>
    {
        const { logger, lines } = capturingLogger(Logger);

        for (const caught of [undefined, 'it broke', { reason: 'plain' }, null])
        {
            logger.error('afterCommit callback failed', caught, { txId: 'tx-1' });
        }

        await settle();

        expect(lines.map(line => line.context)).toEqual(Array(4).fill({ txId: 'tx-1' }));
        expect(lines.map(line => line.error)).toEqual([
            { kind: 'error', name: 'NonError', message: 'undefined' },
            { kind: 'error', name: 'NonError', message: 'it broke' },
            { kind: 'error', name: 'NonError' },
            { kind: 'error', name: 'NonError', message: 'null' },
        ]);
    });

    it('A3: an error\'s code and numeric statusCode are kept; its other fields are not', () =>
    {
        class AppError extends Error
        {
            code = 'E_APP';
            statusCode = 409;
            details = { email: BOUND_VALUES[0] };
        }

        expect(describeError(new AppError('taken'))).toMatchObject({ kind: 'error', name: 'Error', message: 'taken', code: 'E_APP', statusCode: 409 });
        expect(JSON.stringify(describeError(new AppError('taken')))).not.toContain(BOUND_VALUES[0]);
    });
});

describe('describing an error never throws', () =>
{
    /** An Error each of whose fields throws when read, and a Proxy every trap of which throws */
    const hostileErrors = (): unknown[] =>
    {
        const getters = new Error('hostile');

        for (const key of ['message', 'name', 'stack', 'cause', 'code', 'statusCode'])
        {
            Object.defineProperty(getters, key, { get: () => { throw new Error(`reading ${key}`); } });
        }

        const proxy = new Proxy({}, {
            get: () => { throw new Error('get trap'); },
            getPrototypeOf: () => { throw new Error('prototype trap'); },
            ownKeys: () => { throw new Error('ownKeys trap'); },
        });
        const revoked = Proxy.revocable([], {});
        revoked.revoke();

        return [getters, proxy, revoked.proxy];
    };

    it('D1: a hostile error is described, and logging it — as the error or in the context — does not throw', async () =>
    {
        const { logger, output } = capturingLogger(Logger);

        for (const hostile of hostileErrors())
        {
            expect(() => describeError(hostile)).not.toThrow();
            expect(() => logger.error('Job failed', hostile, { jobId: 'job-1' })).not.toThrow();
            expect(() => logger.error('Job failed', { error: hostile, nested: { hostile } })).not.toThrow();
        }

        await settle();
        expect(output()).toContain('Job failed');
        expect(output()).toContain('jobId');
    });

    it('D2: a cause chain past the limit ends in a CauseChainTruncated link', () =>
    {
        let error = new Error('link 0');

        for (let index = 1; index < 20_000; index++)
        {
            error = new Error(`link ${index}`, { cause: error });
        }

        let link: any = describeError(error);

        for (let depth = 1; depth < CAUSE_DEPTH_LIMIT; depth++)
        {
            link = link.cause;
        }

        expect(link.cause).toMatchObject({ kind: 'error', name: 'CauseChainTruncated' });
        expect(link.cause.cause).toBeUndefined();
    });

    it('D3: a cause chain that loops ends in a CircularCause link', () =>
    {
        const outer = new Error('outer');
        const inner = new Error('inner', { cause: outer });
        Object.defineProperty(outer, 'cause', { value: inner });

        expect(describeError(outer)).toMatchObject({
            name: 'Error',
            message: 'outer',
            cause: { message: 'inner', cause: { kind: 'error', name: 'CircularCause' } },
        });
    });

    it('D4: an object with a string stack is data, not an error: its fields are kept', async () =>
    {
        const { logger, lines } = capturingLogger(Logger);

        logger.info('Stack built', { item: { stack: 'a,b,c', owner: 'team-a' } });
        await settle();

        expect(lines[0].context).toEqual({ item: { stack: 'a,b,c', owner: 'team-a' } });
    });
});
