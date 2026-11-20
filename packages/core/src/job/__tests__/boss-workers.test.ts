/**
 * Core's fetch loop keeps what pg-boss's own worker did
 *
 * The instance `initBoss()` creates runs its workers on core's loop over
 * pg-boss's public `fetch` / `complete` / `fail` (boss-workers.ts). Each row
 * pins one piece of pg-boss 11.1.2's worker behaviour (manager.js `watch`,
 * worker.js) that no integration row notices when lost. A stand-in boss
 * records the calls; no database is needed.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type PgBoss from 'pg-boss';

import { recordWorkers, stopWorkers } from '../boss-workers';
import { describeError } from '../../logger/error-description';
import { expectNoValues, failedInsert } from '../../logger/__tests__/helpers/leak-probe';

interface StandInBoss extends EventEmitter
{
    fetch: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    fail: ReturnType<typeof vi.fn>;
    notifyWorker: (id: string) => void;
    work: PgBoss['work'];
    offWork: PgBoss['offWork'];
}

function standInBoss(): StandInBoss
{
    const boss = Object.assign(new EventEmitter(), {
        fetch: vi.fn(async () => []),
        complete: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
        notifyWorker: vi.fn(),
        work: vi.fn(),
        offWork: vi.fn(),
        stop: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
    });
    recordWorkers(boss as unknown as PgBoss);

    return boss as unknown as StandInBoss;
}

function jobOf(id: string, expireInSeconds = 900): PgBoss.Job
{
    return { id, name: 'q', data: {}, expireInSeconds } as PgBoss.Job;
}

describe('core\'s fetch loop keeps pg-boss\'s worker behaviour', () =>
{
    let boss: StandInBoss;

    beforeEach(() =>
    {
        vi.useFakeTimers();
        boss = standInBoss();
    });

    afterEach(async () =>
    {
        const stopping = stopWorkers(boss as unknown as PgBoss, 0);
        await vi.advanceTimersByTimeAsync(1);
        await stopping;
        vi.useRealTimers();
    });

    it('K1: batchSize, includeMetadata and priority reach every fetch, with pg-boss\'s defaults', async () =>
    {
        await boss.work('q', { batchSize: 50, includeMetadata: true, priority: false }, async () => undefined);
        await boss.work('r', async () => undefined);

        expect(boss.fetch).toHaveBeenCalledWith('q', { batchSize: 50, includeMetadata: true, priority: false });
        expect(boss.fetch).toHaveBeenCalledWith('r', { batchSize: 1, includeMetadata: false, priority: true });
    });

    it('K2: an idle worker fetches again after its pollingIntervalSeconds, 2 s by default', async () =>
    {
        await boss.work('q', { pollingIntervalSeconds: 5 }, async () => undefined);
        await boss.work('r', async () => undefined);

        await vi.advanceTimersByTimeAsync(2000);
        expect(fetchesOf('q')).toBe(1);
        expect(fetchesOf('r')).toBe(2);

        await vi.advanceTimersByTimeAsync(3000);
        expect(fetchesOf('q')).toBe(2);
    });

    it('K3: notifyWorker with the id work() returned ends the wait between polls', async () =>
    {
        const id = await boss.work('q', { pollingIntervalSeconds: 60 }, async () => undefined);
        await vi.advanceTimersByTimeAsync(0);

        boss.notifyWorker(id);
        await vi.advanceTimersByTimeAsync(0);

        expect(fetchesOf('q')).toBe(2);
    });

    it('K4: a single job completes with the handler\'s result, a batch without one, and a throw fails them with the error', async () =>
    {
        const failure = new Error('smtp down');
        const handler = vi.fn()
            .mockResolvedValueOnce({ sent: 3 })
            .mockResolvedValueOnce({ sent: 2 })
            .mockRejectedValueOnce(failure);
        boss.fetch
            .mockResolvedValueOnce([jobOf('1')])
            .mockResolvedValueOnce([jobOf('2'), jobOf('3')])
            .mockResolvedValueOnce([jobOf('4')]);

        await boss.work('q', { pollingIntervalSeconds: 1 }, handler);
        await vi.advanceTimersByTimeAsync(2000);

        expect(boss.complete.mock.calls).toEqual([['q', ['1'], { sent: 3 }], ['q', ['2', '3'], undefined]]);
        expect(boss.fail).toHaveBeenCalledWith('q', ['4'], describeError(failure));
    });

    it('K5: a completion that fails fails the job instead of leaving it active', async () =>
    {
        const refused = new Error('connection reset');
        boss.fetch.mockResolvedValueOnce([jobOf('1')]);
        boss.complete.mockRejectedValueOnce(refused);

        await boss.work('q', async () => undefined);
        await vi.advanceTimersByTimeAsync(0);

        expect(boss.fail).toHaveBeenCalledWith('q', ['1'], describeError(refused));
    });

    it('K6: a failed fetch is emitted as an error naming the queue and worker, and the worker polls on', async () =>
    {
        const errors: { message: string; queue: string; worker: string }[] = [];
        boss.on('error', (error) => errors.push(error));
        boss.fetch.mockRejectedValueOnce(new Error('Queue q does not exist'));

        const id = await boss.work('q', { pollingIntervalSeconds: 1 }, async () => undefined);
        await vi.advanceTimersByTimeAsync(1000);

        expect(errors).toEqual([expect.objectContaining({
            message: `Queue q does not exist (Queue: q, Worker: ${id})`,
            queue: 'q',
            worker: id,
        })]);
        expect(fetchesOf('q')).toBe(2);
    });

    it('K7: offWork by queue name or by worker id stops that worker\'s polling', async () =>
    {
        await boss.work('q', { pollingIntervalSeconds: 1 }, async () => undefined);
        const id = await boss.work('r', { pollingIntervalSeconds: 1 }, async () => undefined);

        await boss.offWork('q');
        await boss.offWork({ id });
        await vi.advanceTimersByTimeAsync(3000);

        expect(fetchesOf('q')).toBe(1);
        expect(fetchesOf('r')).toBe(1);
    });

    it('K8: work() rejects a pollingIntervalSeconds below pg-boss\'s 0.5 s minimum', async () =>
    {
        await expect(boss.work('q', { pollingIntervalSeconds: 0.1 }, async () => undefined))
            .rejects.toThrow('pollingIntervalSeconds must be at least every 500ms');
        expect(boss.fetch).not.toHaveBeenCalled();
    });

    it('K9: stopWorkers in the tick a poll begins waits for that poll\'s fetch, or the poll fetches nothing', async () =>
    {
        let unsettled = 0;
        boss.fetch.mockImplementation(() =>
        {
            unsettled++;

            return new Promise((resolve) => setTimeout(() =>
            {
                unsettled--;
                resolve([]);
            }, 500));
        });

        void boss.work('q', async () => undefined);
        const atStop = stopWorkers(boss as unknown as PgBoss, 1000).then(() => ({ unsettled, fetches: fetchesOf('q') }));
        await vi.advanceTimersByTimeAsync(1000);

        expect(await atStop).toEqual({ unsettled: 0, fetches: fetchesOf('q') });
    });

    it('R8: a handler\'s database error fails the job with its description, so the job row stores no bound value (#382)', async () =>
    {
        boss.fetch.mockResolvedValueOnce([jobOf('1')]);

        await boss.work('q', async () =>
        {
            throw failedInsert();
        });
        await vi.advanceTimersByTimeAsync(0);

        // pg-boss serialises what fail() is given into the row's `output`
        const [, , output] = boss.fail.mock.calls[0];
        expect(output).toMatchObject({ kind: 'database', code: '23505', constraint: 'users_email_key', paramCount: 2 });
        expectNoValues(JSON.stringify(output));
    });

    function fetchesOf(queue: string): number
    {
        return boss.fetch.mock.calls.filter(([name]) => name === queue).length;
    }
});
