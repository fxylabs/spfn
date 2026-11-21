/**
 * `{ primary: true }` on the repository read helpers (spfn/spfn#169) — rows P1–P4 and B1
 *
 * A replica can lag behind the primary, so a read that must see a write made a
 * moment ago asks for the primary. Each row tells the connections apart by the
 * statements the app's write pool and read pool sent, as the tenancy harness
 * records them. Runs as the app role, under the row-level security policy;
 * skips with the reason when no test database is available.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { InferInsertModel } from 'drizzle-orm';
import type { ReadOptions } from '../../query-utils';
import { BaseRepository } from '../../repository';
import { runInTransaction } from '../../transaction';
import { TenantMismatchError } from '../errors';
import { TenantRepository } from '../tenant-repository';
import { createTenancyDb } from './tenancy-db';
import { members, memos, notes, tenancy } from './tenancy-fixtures';

const isBegin = (statement: string) => /^begin\b/i.test(statement);

/** Each read helper, counting the rows it finds whose label — a note's title, a membership's status — is `label`. */
class LabelReader extends TenantRepository
{
    async findOne(tenantId: number, label: string, options?: ReadOptions)
    {
        return await this._findOne(tenantId, notes, { title: label }, options) === null ? 0 : 1;
    }

    async findMany(tenantId: number, label: string, options?: ReadOptions)
    {
        return (await this._findMany(tenantId, notes, { ...options, where: { title: label } })).length;
    }

    async findManyKeyset(tenantId: number, label: string, options?: ReadOptions)
    {
        return (await this._findManyKeyset(tenantId, notes, { ...options, cursorColumn: notes.id, limit: 10, where: { title: label } })).length;
    }

    count(tenantId: number, label: string, options?: ReadOptions)
    {
        return this._count(tenantId, notes, { title: label }, options);
    }

    async select(tenantId: number, label: string, options?: ReadOptions)
    {
        return (await this._select(tenantId, { id: notes.id }, options).from(notes).where(eq(notes.title, label))).length;
    }

    async selectOfUser(userId: number, label: string, options?: ReadOptions)
    {
        return (await this._selectOfUser(userId, { id: members.id }, options).from(members).where(eq(members.status, label))).length;
    }

    createNote(tenantId: number, title: string)
    {
        return this._create(tenantId, notes, { authorId: 1, title } as InferInsertModel<typeof notes>);
    }

    createMembership(tenantId: number, userId: number, status: string)
    {
        return this._create(tenantId, members, { userId, role: 'member', status } as InferInsertModel<typeof members>);
    }
}

/** The plain helpers, on `memos` — a `tenantKey()`-only table, so no policy stands between them and a pool. */
class MemoReader extends BaseRepository
{
    async findOne(options?: ReadOptions)
    {
        return await this._findOne(memos, { id: 1 }, options) === null ? 0 : 1;
    }

    async findMany(options?: ReadOptions)
    {
        return (await this._findMany(memos, { ...options, where: { tenantId: 7 } })).length;
    }

    async findManyKeyset(options?: ReadOptions)
    {
        return (await this._findManyKeyset(memos, { ...options, cursorColumn: memos.id, limit: 10, where: { tenantId: 7 } })).length;
    }

    count(options?: ReadOptions)
    {
        return this._count(memos, { tenantId: 7 }, options);
    }
}

const reader = new LabelReader();
const memoReader = new MemoReader();

/**
 * The six read helpers: `_selectOfUser` reads by user 3, the others by tenant 7.
 * `own` is a label that reader has one row of; `write` stores one labelled
 * `fresh` for P4.
 */
const TENANT_READS = [
    { helper: '_findOne', read: reader.findOne.bind(reader) },
    { helper: '_findMany', read: reader.findMany.bind(reader) },
    { helper: '_findManyKeyset', read: reader.findManyKeyset.bind(reader) },
    { helper: '_count', read: reader.count.bind(reader) },
    { helper: '_select', read: reader.select.bind(reader) },
].map((entry) => ({ ...entry, id: 7, own: 'two', setting: 'app.tenant_id', write: () => reader.createNote(7, 'fresh') }));

const READS = [
    ...TENANT_READS,
    { helper: '_selectOfUser', read: reader.selectOfUser.bind(reader), id: 3, own: 'invited', setting: 'app.user_id', write: () => reader.createMembership(7, 3, 'fresh') },
];

const BASE_READS = [
    { helper: '_findOne', read: memoReader.findOne.bind(memoReader), rows: 1 },
    { helper: '_findMany', read: memoReader.findMany.bind(memoReader), rows: 2 },
    { helper: '_findManyKeyset', read: memoReader.findManyKeyset.bind(memoReader), rows: 2 },
    { helper: '_count', read: memoReader.count.bind(memoReader), rows: 2 },
];

describe('{ primary: true } on the repository read helpers (app role, integration)', () =>
{
    const db = createTenancyDb();

    beforeAll(async () =>
    {
        await db.setup();
    });

    beforeEach(async () =>
    {
        if (!db.isAvailable) return;

        await db.seed();
    });

    afterAll(async () =>
    {
        await db.teardown();
    });

    it.for(READS)('P1 $helper with { primary: true } outside a transaction runs BEGIN READ ONLY, set_config and the query on the write pool, nothing on the read pool', async ({ read, id, own, setting }, context) =>
    {
        db.skipIfUnavailable(context);

        expect(await read(id, own, { primary: true })).toBe(1);
        expect(db.writeLog.filter(isBegin)).toHaveLength(1);
        expect(db.writeLog).toContain('set transaction read only');
        expect(db.settingLog).toEqual([{ pool: 'write', setting, value: String(id) }]);
        expect(db.writeLog.at(-1)).toMatch(/^commit/i);
        expect(db.readLog).toEqual([]);
    });

    it.for(READS)('P2 $helper without the option sends to the read pool the same statements { primary: true } sends to the write pool, nothing to the write pool', async ({ read, id, own, setting }, context) =>
    {
        db.skipIfUnavailable(context);

        expect(await read(id, own, { primary: true })).toBe(1);
        expect(db.readLog).toEqual([]);

        const onPrimary = db.writeLog.splice(0);

        db.settingLog.length = 0;

        expect(await read(id, own)).toBe(1);
        expect(db.readLog).toEqual(onPrimary);
        expect(db.readLog).toContain('set transaction read only');
        expect(db.settingLog).toEqual([{ pool: 'read', setting, value: String(id) }]);
        expect(db.writeLog).toEqual([]);
    });

    it.for(TENANT_READS)('P3 $helper with { primary: true } under a guard for tenant 7 reads tenant 7 only and refuses tenant 9 before any SQL', async ({ read }, context) =>
    {
        db.skipIfUnavailable(context);

        const app = new Hono();

        app.get('/w/:workspaceId/reads', tenancy.guard({ param: 'workspaceId' }).handler, async (c) =>
        {
            db.writeLog.length = 0;
            db.readLog.length = 0;

            const own = await read(7, 'two', { primary: true });
            const foreignLabel = await read(7, 'three', { primary: true });
            const readsOnPool = { write: db.writeLog.filter(isBegin).length, read: db.readLog.length };
            const sent = db.writeLog.length + db.readLog.length;
            const refusal = await read(9, 'three', { primary: true }).then(
                () => 'admitted',
                (error: unknown) => (error instanceof TenantMismatchError ? 'TenantMismatchError' : String(error)),
            );

            return c.json({ own, foreignLabel, readsOnPool, refusal, sentByRefusal: db.writeLog.length + db.readLog.length - sent });
        });

        const response = await app.request('/w/7/reads');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            own: 1,
            foreignLabel: 0,
            readsOnPool: { write: 2, read: 0 },
            refusal: 'TenantMismatchError',
            sentByRefusal: 0,
        });
    });

    it.for(READS)('P4 $helper with { primary: true } inside a transaction runs in it and sees its uncommitted write; after the commit it reads that write on the write pool', async ({ read, id, write }, context) =>
    {
        db.skipIfUnavailable(context);

        const seen = await runInTransaction(async () =>
        {
            await write();

            return read(id, 'fresh', { primary: true });
        }, { tenant: 7 });

        expect(seen).toBe(1);
        expect(db.writeLog.filter(isBegin)).toHaveLength(1);
        expect(db.writeLog).not.toContain('set transaction read only');
        expect(db.readLog).toEqual([]);

        db.writeLog.length = 0;

        expect(await read(id, 'fresh', { primary: true })).toBe(1);
        expect(db.writeLog.filter(isBegin)).toHaveLength(1);
        expect(db.writeLog).toContain('set transaction read only');
        expect(db.readLog).toEqual([]);
    });

    it.for(BASE_READS)('B1 BaseRepository $helper sends its query to the write pool with { primary: true }, to the read pool without', async ({ read, rows }, context) =>
    {
        db.skipIfUnavailable(context);

        expect(await read({ primary: true })).toBe(rows);
        expect(db.writeLog).toHaveLength(1);
        expect(db.writeLog[0]).toContain('"memos"');
        expect(db.readLog).toEqual([]);

        db.writeLog.length = 0;

        expect(await read()).toBe(rows);
        expect(db.readLog).toHaveLength(1);
        expect(db.writeLog).toEqual([]);
    });
});
