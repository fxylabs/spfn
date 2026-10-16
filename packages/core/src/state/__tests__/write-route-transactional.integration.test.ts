/**
 * Frames after commit (#137), through `.use([Transactional()])` against
 * PostgreSQL. `write` inserts a row through `getTransaction()`; a second,
 * independent client (the fixture's own pool) checks what is visible.
 *
 * | #  | situation                                                    | expected                                                    |
 * |----|--------------------------------------------------------------|-------------------------------------------------------------|
 * | T4 | PUT, `write` inserts a row                                   | one frame, received after the commit: at emit time a second connection already sees the row |
 * | T5 | same, `write` registers `onBeforeCommit(() => { throw … })`  | 500; no frame ever; the row is absent on a second connection |
 * | T6 | same as T4 but `read` throws after the write                 | 500; no frame; the row is rolled back                       |
 * | T8 | (documented limit) `changed.emit` inside a savepoint that rolls back, the root commits | one frame `{ value: 'agreed' }` is published; no row exists |
 *
 * `Transactional`, `getTransaction` and `onBeforeCommit` come from
 * `@spfn/core/db`, the entry `state-event.ts` reads the transaction context
 * from, and that entry's database is initialised here beside the fixture's.
 */

import { closeDatabase, getTransaction, initDatabase, onBeforeCommit, runInTransaction, Transactional } from '@spfn/core/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDbTestFixture } from '../../db/__tests__/helpers/db-fixture';
import type { EventDef } from '../../event/types';
import { defineState } from '../state-builder';
import { defineStateRouter } from '../state-router';
import { Consent, ConsentInput, request, serve } from './state-harness';

const TABLE = 'state_transactional_rows';

const input = { termsVersion: '2026-10', marketing: true };

const dbFixture = createDbTestFixture();

/** Rows visible to the fixture's own pool — a connection outside the route's transaction. */
async function visibleRows(): Promise<number>
{
    const rows = await dbFixture.db.execute(sql.raw(`SELECT id FROM ${TABLE}`));

    return rows.length;
}

async function insertRow(subject: string): Promise<void>
{
    await getTransaction()!.execute(sql`INSERT INTO state_transactional_rows (subject) VALUES (${subject})`);
}

interface Options
{
    beforeCommit?: () => void;
    readFails?: boolean;
}

/** A transactional consent state; every frame records how many rows a second connection saw when it arrived. */
async function transactionalApp(options: Options = {})
{
    const consent = defineState('consent')
        .value(Consent)
        .use([Transactional()])
        .canRead(() => true)
        .read(async () =>
        {
            if (options.readFails)
            {
                throw new Error('read failed after the write');
            }

            return { value: 'agreed' as const };
        })
        .write(ConsentInput, async ({ subject }) =>
        {
            await insertRow(subject);

            if (options.beforeCommit)
            {
                onBeforeCommit(options.beforeCommit);
            }
        });
    const states = defineStateRouter({ consent });
    const rowsAtFrame: number[] = [];
    (states.events as Record<string, EventDef<any>>)['state.consent.changed'].subscribe(async () =>
    {
        rowsAtFrame.push(await visibleRows());
    });

    return { app: await serve(states), rowsAtFrame };
}

/** Long enough for a detached after-commit callback to have run, had one been queued. */
function settle(): Promise<void>
{
    return new Promise(resolve => setTimeout(resolve, 100));
}

describe('frames after commit, through Transactional()', () =>
{
    beforeAll(async () =>
    {
        await dbFixture.setup();
        await initDatabase();
        await dbFixture.execute(`CREATE TABLE IF NOT EXISTS ${TABLE} (id SERIAL PRIMARY KEY, subject TEXT NOT NULL)`);
    });

    afterAll(async () =>
    {
        await dbFixture.execute(`DROP TABLE IF EXISTS ${TABLE}`);
        await closeDatabase();
        await dbFixture.teardown();
    });

    beforeEach(() => dbFixture.cleanTable(TABLE));

    it('T4 the frame is sent after the commit: a second connection already sees the row', async () =>
    {
        expect(dbFixture.isAvailable).toBe(true);
        const { app, rowsAtFrame } = await transactionalApp();

        const res = await request(app, 's').put('/state/consent', input);

        expect(res.status).toBe(200);
        await vi.waitFor(() => expect(rowsAtFrame).toHaveLength(1));
        expect(rowsAtFrame).toEqual([1]);
    });

    it('T5 a beforeCommit throw rolls back: 500, no frame, no row', async () =>
    {
        const { app, rowsAtFrame } = await transactionalApp({
            beforeCommit: () =>
            {
                throw new Error('invariant broken');
            },
        });

        const res = await request(app, 's').put('/state/consent', input);
        await settle();

        expect(res.status).toBe(500);
        expect(rowsAtFrame).toEqual([]);
        expect(await visibleRows()).toBe(0);
    });

    it('T6 a read that throws after the write: 500, no frame, the row rolled back', async () =>
    {
        const { app, rowsAtFrame } = await transactionalApp({ readFails: true });

        const res = await request(app, 's').put('/state/consent', input);
        await settle();

        expect(res.status).toBe(500);
        expect(rowsAtFrame).toEqual([]);
        expect(await visibleRows()).toBe(0);
    });

    // This row flips the day `db/` scopes after-commit queues to the savepoint;
    // the README's savepoint sentence under "Frames and transactions" goes with it.
    it('T8 (documented limit) a change signal inside a savepoint that rolls back is still published when the root commits', async () =>
    {
        const consent = defineState('consent').value(Consent).read(async () => ({ value: 'agreed' as const }));
        const states = defineStateRouter({ consent });
        const frames: unknown[] = [];
        (states.events as Record<string, EventDef<any>>)['state.consent.changed'].subscribe((payload: unknown) =>
        {
            frames.push(payload);
        });

        await runInTransaction(async () =>
        {
            await runInTransaction(async () =>
            {
                await insertRow('s');
                await states.states.consent.changed.emit({ subject: 's' });
                throw new Error('savepoint rolls back');
            }).catch(() => undefined);
        });
        await settle();

        expect(await visibleRows()).toBe(0);
        expect(frames).toEqual([{ at: expect.any(String), subject: 's', value: 'agreed' }]);
    });
});
