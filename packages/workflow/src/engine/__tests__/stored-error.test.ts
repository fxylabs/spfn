/**
 * @spfn/workflow - a failed step's error is stored and logged by its description (#382)
 *
 * A step whose job fails on a statement throws drizzle's query error, which
 * carries every bound value: its message and stack header end in
 * `params: …`, and the driver error under it holds `Key (email)=(…)` in
 * `detail`. The engine writes the error into `executions.error` and
 * `step_executions.error` and hands it to its logger. The columns are reached
 * through a local and two method calls, which core's scan cannot follow.
 *
 * The database is a recording stand-in: the package has no test database, and
 * the rows are about what the engine hands to `update(…).set(…)`.
 *
 * | #  | goes unnoticed without the row                                                         |
 * | -- | -------------------------------------------------------------------------------------- |
 * | W1 | the error columns and the failure events holding the statement's values (the message) |
 * | W2 | the default logger printing the error object whole, values included                    |
 */

import { describe, it, expect, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import { DrizzleQueryError } from 'drizzle-orm';
import { job } from '@spfn/core/job';
import { workflow } from '../../builder';
import { workflowExecutions } from '../../entities';
import { createWorkflowEngine } from '../workflow-engine';
import type { WorkflowEvent } from '../../builder';

const EMAIL = 'leak-probe@example.test';
const HASH = '$2b$FAKEHASH';
const LEAKS = [EMAIL, HASH, 'Key (', 'Failing row', 'params:'];
const SILENT = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };

/** The failed insert as drizzle and postgres.js raise it */
function failedInsert(): Error
{
    const driverError = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
        name: 'PostgresError',
        severity: 'ERROR',
        code: '23505',
        detail: `Key (email)=(${EMAIL}) already exists.`,
        table_name: 'users',
        constraint_name: 'users_email_key',
        routine: '_bt_check_unique',
    });

    return new DrizzleQueryError('insert into "users" ("email", "password_hash") values ($1, $2)', [EMAIL, HASH], driverError);
}

interface Write
{
    table: unknown;
    values: Record<string, unknown>;
}

/** A query that resolves to `rows` however it is chained */
function rowsOf(rows: unknown[]): object
{
    const chain: Record<string, unknown> = {
        where: () => chain,
        orderBy: () => chain,
        returning: () => chain,
        then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
    };

    return chain;
}

/**
 * One execution of a one-step workflow, its rows kept in memory: `select`
 * answers them, `update(…).set(…)` is recorded and applied. `failSelect`
 * makes every read reject with that error.
 */
function recordingDb(failSelect?: Error)
{
    const execution = { id: 'exec-1', workflowName: 'register', status: 'pending', input: {}, currentStep: 0, error: null };
    const step = { id: 'step-1', executionId: 'exec-1', stepName: 'create-user', stepIndex: 0, status: 'pending', error: null };
    const writes: Write[] = [];

    const db = {
        writes,
        transaction: async (work: (tx: unknown) => Promise<unknown>) => await work(db),
        insert: (table: unknown) => ({ values: () => rowsOf(table === workflowExecutions ? [execution] : []) }),
        select: () => ({
            from: (table: unknown) => (failSelect
                ? { where: () => Promise.reject(failSelect) }
                : rowsOf(table === workflowExecutions ? [execution] : [step])),
        }),
        update: (table: unknown) => ({
            set: (values: Record<string, unknown>) =>
            {
                writes.push({ table, values });
                Object.assign(table === workflowExecutions ? execution : step, values);

                return rowsOf([]);
            },
        }),
    };

    return db;
}

function registerWorkflow()
{
    const createUser = job('create-user')
        .input(Type.Object({}))
        .handler(async () =>
        {
            throw failedInsert();
        });

    return workflow('register').input(Type.Object({})).pipe(createUser, () => ({})).build();
}

function expectNoLeak(text: string): void
{
    for (const leak of LEAKS)
    {
        expect(text).not.toContain(leak);
    }
}

describe('a failed step\'s error (#382)', () =>
{
    it('W1: the error columns and the failure events hold the description as JSON, no bound value', async () =>
    {
        const db = recordingDb();
        const engine = createWorkflowEngine({ workflows: [registerWorkflow()], db, logger: SILENT });
        const events: WorkflowEvent[] = [];
        engine.subscribe('exec-1', event => events.push(event));

        await engine.start('register', {});
        await vi.waitFor(() => expect(events.map(event => event.type)).toContain('failed'));

        const stored = db.writes
            .filter(write => write.values.error !== undefined)
            .map(write => [write.table === workflowExecutions ? 'execution' : 'step', write.values.error]);
        const told = events.filter(event => event.error !== undefined).map(event => [event.type, event.error]);

        expect(stored.map(([column]) => column)).toEqual(['step', 'execution']);
        expect(told.map(([type]) => type)).toEqual(['step.failed', 'failed']);

        for (const [, error] of [...stored, ...told])
        {
            expectNoLeak(String(error));
            expect(JSON.parse(String(error))).toMatchObject({ kind: 'database', code: '23505', constraint: 'users_email_key' });
        }
    });

    it('W2: the default logger describes an execution error', async () =>
    {
        const lines: string[] = [];
        const keep = (...args: unknown[]) =>
        {
            lines.push(args.map(String).join(' '));
        };
        vi.spyOn(console, 'error').mockImplementation(keep);
        vi.spyOn(console, 'log').mockImplementation(keep);
        const engine = createWorkflowEngine({ workflows: [registerWorkflow()], db: recordingDb(failedInsert()) });

        await engine.start('register', {});
        await vi.waitFor(() => expect(lines.join('\n')).toContain('Execution error'));
        vi.restoreAllMocks();

        expect(lines.join('\n')).toContain('23505');
        expectNoLeak(lines.join('\n'));
    });
});
