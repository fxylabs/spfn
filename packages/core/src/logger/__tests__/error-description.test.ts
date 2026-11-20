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
 */

import { describe, it, expect } from 'vitest';
import { Logger } from '../logger';
import { describeError } from '../error-description';
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
