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
 * | R7b | a 23505 an app trigger RAISEd with its text | a kept class carrying the app's own text                    |
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
import { capturingLogger, expectNoValues, failedInsert, FAILED_INSERT } from './helpers/leak-probe';

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

    it('R7b: a message RAISEd by PL/pgSQL is left out, whatever ERRCODE it carries', () =>
    {
        const raised = Object.assign(new Error('leak-probe@example.test taken'), {
            severity: 'ERROR',
            code: '23505',
            routine: 'exec_stmt_raise',
        });

        const description = describeError(raised);

        expect(description).toMatchObject({ kind: 'database', code: '23505', routine: 'exec_stmt_raise' });
        expect(JSON.stringify(description)).not.toContain('leak-probe@example.test');
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
