/**
 * Tenancy execution rules — rows L1–L18 and O3 of the #158 part 2 design case table
 *
 * Every row runs as the app role, which owns no table and is neither superuser
 * nor BYPASSRLS — the first test proves it, since otherwise the policy would
 * not apply and every row would pass for nothing. The owner created the schema
 * from the SQL drizzle-kit generates. Skips when no test database is available.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { and, asc, eq } from 'drizzle-orm';
import { getDatabase } from '../../manager';
import { runInTransaction, Transactional } from '../../transaction';
import { TenantMismatchError } from '../errors';
import { createTenancyDb } from './tenancy-db';
import { authors, notes, TENANCY_SCHEMA } from './tenancy-fixtures';
import { MemoRepository, NoteRepository } from './tenancy-repositories';

/** The policy's error when `app.tenant_id` is missing or empty on the connection. */
const NO_TENANT = /app\.tenant_id|invalid input syntax for type bigint/;

const isBegin = (statement: string) => /^begin\b/i.test(statement);
const isSetConfig = (statement: string) => statement.includes('set_config');

/** The database's message for a query that failed; drizzle wraps it as the cause. */
async function failureOf(query: PromiseLike<unknown>): Promise<string>
{
    const error = await Promise.resolve(query).then(() => undefined, (reason: unknown) => reason as Error & { cause?: Error });

    return error?.cause?.message ?? error?.message ?? 'no failure';
}

describe('tenancy execution rules (app role, integration)', () =>
{
    const db = createTenancyDb();
    const noteRepository = new NoteRepository();
    const memoRepository = new MemoRepository();
    const ids = (rows: { id: number }[]) => rows.map((row) => row.id);
    const noteCount = async () => Number((await db.owner`select count(*)::int as n from ${db.owner(TENANCY_SCHEMA)}.notes`)[0].n);

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

    it('app connection: owns no test table, is neither superuser nor BYPASSRLS', async () =>
    {
        if (!db.isAvailable) return;

        const [role] = await getDatabase().execute<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(
            `select current_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
        ) as unknown as { current_user: string; rolsuper: boolean; rolbypassrls: boolean }[];
        const owned = await db.owner`select tablename from pg_tables where schemaname = ${TENANCY_SCHEMA} and tableowner = ${role.current_user}`;

        expect(role.current_user).toBe(db.appRole);
        expect(role.rolsuper).toBe(false);
        expect(role.rolbypassrls).toBe(false);
        expect(owned).toHaveLength(0);
    });

    it('O3 the owner migrated the schema and the app role, which owns none of it, runs the L rows', async () =>
    {
        if (!db.isAvailable) return;

        const owners = await db.owner`select distinct tableowner from pg_tables where schemaname = ${TENANCY_SCHEMA}`;
        const [{ current_user: ownerRole }] = await db.owner`select current_user`;

        expect(owners.map((row) => row.tableowner)).toEqual([ownerRole]);
        expect(ownerRole).not.toBe(db.appRole);
        expect(ids(await noteRepository.list(7))).toEqual([1, 2]);
    });

    it('L1 a read outside a transaction runs in a short READ ONLY transaction on the read pool and sees tenant 7 only', async () =>
    {
        if (!db.isAvailable) return;

        const rows = await noteRepository.list(7);

        expect(ids(rows)).toEqual([1, 2]);
        expect(db.readLog.filter(isBegin)).toHaveLength(1);
        expect(db.readLog).toContain('set transaction read only');
        expect(db.readLog.filter(isSetConfig)).toHaveLength(1);
        expect(db.readLog.at(-1)).toMatch(/^commit/i);
        expect(db.writeLog).toEqual([]);
    });

    it('L2 a write outside a transaction runs in a short transaction on the write pool', async () =>
    {
        if (!db.isAvailable) return;

        const created = await noteRepository.create(7, { authorId: 1, title: 'new' });

        expect(created.tenantId).toBe(7);
        expect(db.writeLog.filter(isBegin)).toHaveLength(1);
        expect(db.writeLog.filter(isSetConfig)).toHaveLength(1);
        expect(db.writeLog).not.toContain('set transaction read only');
        expect(db.readLog).toEqual([]);
        expect(await noteCount()).toBe(4);
    });

    it('L3 inside runInTransaction({ tenant: 7 }) a read runs in that transaction, adding none', async () =>
    {
        if (!db.isAvailable) return;

        const rows = await runInTransaction(() => noteRepository.list(7), { tenant: 7 });

        expect(ids(rows)).toEqual([1, 2]);
        expect(db.writeLog.filter(isBegin)).toHaveLength(1);
        expect(db.writeLog.filter(isSetConfig)).toHaveLength(1);
        expect(db.readLog).toEqual([]);
    });

    it('L3b runInTransaction refuses a tenant that is not a positive safe integer before opening', async () =>
    {
        if (!db.isAvailable) return;

        for (const tenant of [0, -1, 1.5, Number.NaN])
        {
            await expect(runInTransaction(async () => undefined, { tenant })).rejects.toThrow('Invalid tenant value');
        }

        expect(db.writeLog).toEqual([]);
    });

    it('L4 a call for tenant 9 inside a tenant 7 transaction throws TenantMismatchError and sends nothing', async () =>
    {
        if (!db.isAvailable) return;

        await runInTransaction(async () =>
        {
            const sent = db.writeLog.length;

            await expect(noteRepository.list(9)).rejects.toThrow(TenantMismatchError);
            expect(db.writeLog).toHaveLength(sent);
        }, { tenant: 7 });
    });

    it('L5 the first call inside Transactional() binds the transaction; a direct query after it sees tenant 7 only', async () =>
    {
        if (!db.isAvailable) return;

        const app = new Hono();

        app.get('/notes', Transactional(), async (c) =>
        {
            const scoped = await noteRepository.list(7);
            const direct = await noteRepository.directNotes();

            return c.json({ scoped: ids(scoped), direct: ids(direct) });
        });

        const response = await app.request('/notes');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ scoped: [1, 2], direct: [1, 2] });
    });

    it('L6 a direct query outside any transaction fails instead of returning rows', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(noteRepository.directNotes())).toMatch(NO_TENANT);
    });

    it('L7 a direct query naming tenant 9 inside a tenant 7 transaction returns no rows', async () =>
    {
        if (!db.isAvailable) return;

        const rows = await runInTransaction(() => noteRepository.directNotesOf(9), { tenant: 7 });

        expect(rows).toEqual([]);
    });

    it('L8 a direct insert of a tenant 9 row inside a tenant 7 transaction is refused by the policy', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(runInTransaction(
            () => noteRepository.directInsert({ tenantId: 9, authorId: 2, title: 'smuggled' }),
            { tenant: 7 },
        ))).toMatch(/new row violates row-level security policy for table "notes"/);
        expect(await noteCount()).toBe(3);
    });

    it('L9 a direct query in a transaction opened without a tenant fails', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(runInTransaction(() => noteRepository.directNotes()))).toMatch(NO_TENANT);
    });

    it('L10 after a tenant 7 transaction ends, its connection has no tenant', async () =>
    {
        if (!db.isAvailable) return;

        const inside = await runInTransaction(() => noteRepository.session(), { tenant: 7 });
        const after = await sessionOn(inside.pid);

        expect(inside.tenant).toBe('7');
        expect(after.tenant ?? '').toBe('');
        expect(await failureOf(noteRepository.directNotes())).toMatch(NO_TENANT);
    });

    it('L11 a nested runInTransaction({ tenant: 7 }) inside tenant 7 runs as a savepoint', async () =>
    {
        if (!db.isAvailable) return;

        const rows = await runInTransaction(
            () => runInTransaction(() => noteRepository.list(7), { tenant: 7 }),
            { tenant: 7 },
        );

        expect(ids(rows)).toEqual([1, 2]);
        expect(db.writeLog.some((statement) => /^savepoint/i.test(statement))).toBe(true);
        expect(db.writeLog.filter(isSetConfig)).toHaveLength(1);
    });

    it('L12 a nested runInTransaction({ tenant: 9 }) inside tenant 7 throws; the outer tenant stays 7', async () =>
    {
        if (!db.isAvailable) return;

        const outer = await runInTransaction(async () =>
        {
            const sent = db.writeLog.length;

            await expect(runInTransaction(() => noteRepository.list(9), { tenant: 9 })).rejects.toThrow(TenantMismatchError);
            expect(db.writeLog).toHaveLength(sent);

            return { session: await noteRepository.session(), rows: await noteRepository.list(7) };
        }, { tenant: 7 });

        expect(outer.session.tenant).toBe('7');
        expect(ids(outer.rows)).toEqual([1, 2]);
    });

    it('L11b a tenant first set inside a savepoint that rolls back is set again by the next call', async () =>
    {
        if (!db.isAvailable) return;

        const result = await runInTransaction(async () =>
        {
            await runInTransaction(async () =>
            {
                await noteRepository.list(7);
                throw new Error('undo the savepoint');
            }).catch(() => undefined);

            const afterRollback = await noteRepository.session();

            return { afterRollback, rows: await noteRepository.list(9), session: await noteRepository.session() };
        });

        expect(result.afterRollback.tenant ?? '').toBe('');
        expect(ids(result.rows)).toEqual([3]);
        expect(result.session.tenant).toBe('9');
    });

    it('L13 requiresNew with tenant 9 inside tenant 7 runs on its own connection; the outer tenant stays 7', async () =>
    {
        if (!db.isAvailable) return;

        const result = await runInTransaction(async () =>
        {
            const outerSession = await noteRepository.session();
            const inner = await runInTransaction(
                async () => ({ rows: await noteRepository.list(9), session: await noteRepository.session() }),
                { requiresNew: true, tenant: 9 },
            );

            return { outerSession, inner, after: await noteRepository.session(), rows: await noteRepository.list(7) };
        }, { tenant: 7 });

        expect(ids(result.inner.rows)).toEqual([3]);
        expect(result.inner.session.tenant).toBe('9');
        expect(result.inner.session.pid).not.toBe(result.outerSession.pid);
        expect(result.after.tenant).toBe('7');
        expect(ids(result.rows)).toEqual([1, 2]);
    });

    it('L14 an awaited _select builder runs like L1, while toSQL() is the part 1 SQL and runs nothing', async () =>
    {
        if (!db.isAvailable) return;

        const query = noteRepository.titlesWithAuthor(7);
        const expected = getDatabase('read').select({ id: notes.id, title: notes.title, author: authors.name })
            .from(notes)
            .innerJoin(authors, and(eq(notes.authorId, authors.id), eq(authors.tenantId, 7)))
            .where(eq(notes.tenantId, 7))
            .orderBy(asc(notes.id));

        expect(query.toSQL()).toEqual(expected.toSQL());
        expect(db.readLog).toEqual([]);

        expect(await query).toEqual([
            { id: 1, title: 'one', author: 'Ann' },
            { id: 2, title: 'two', author: 'Ann' },
        ]);
        expect(db.readLog.filter(isBegin)).toHaveLength(1);
        expect(db.readLog).toContain('set transaction read only');
        expect(db.writeLog).toEqual([]);
    });

    it('L14 .execute() takes the same path, and .prepare() on a tenancy table is refused', async () =>
    {
        if (!db.isAvailable) return;

        expect(ids(await noteRepository.titlesWithAuthor(7).execute())).toEqual([1, 2]);
        expect(db.readLog.filter(isSetConfig)).toHaveLength(1);
        expect(() => noteRepository.titlesWithAuthor(7).prepare('q')).toThrow(/prepare\(\) is not supported .* tenancy table/);
        await expect(noteRepository.titlesWithAuthor(7).then((rows) => rows.length)).resolves.toBe(2);
        await expect(noteRepository.titlesWithAuthor(7).finally(() => undefined)).resolves.toHaveLength(2);
    });

    it('L15 a failing query in a short write transaction rolls back and leaves no row', async () =>
    {
        if (!db.isAvailable) return;

        await expect(noteRepository.create(7, { authorId: 999, title: 'orphan' })).rejects.toThrow();
        expect(db.writeLog.at(-1)).toMatch(/^rollback/i);
        expect(await noteCount()).toBe(3);
    });

    it('L16 a tenantKey()-only table is read with one query, no BEGIN and no set_config', async () =>
    {
        if (!db.isAvailable) return;

        expect(ids(await memoRepository.list(7))).toEqual([1, 2]);
        expect(db.readLog).toHaveLength(1);
        expect(db.readLog.filter(isBegin)).toEqual([]);
        expect(db.readLog.filter(isSetConfig)).toEqual([]);
    });

    it('L17 a tenantKey()-only table inside a tenant 7 transaction refuses tenant 9', async () =>
    {
        if (!db.isAvailable) return;

        await runInTransaction(async () =>
        {
            await expect(memoRepository.list(9)).rejects.toThrow(TenantMismatchError);
        }, { tenant: 7 });
    });

    it('L18 concurrent reads for tenants 7 and 9 on a one-connection read pool each see their own rows', async () =>
    {
        if (!db.isAvailable) return;

        const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
        {
            const tenantId = index % 2 === 0 ? 7 : 9;

            return noteRepository.list(tenantId).then((rows) => ({ tenantId, rows }));
        }));

        for (const { tenantId, rows } of results)
        {
            expect(ids(rows)).toEqual(tenantId === 7 ? [1, 2] : [3]);
        }
    });

    /** `session()` outside a transaction, retried until the pool hands out backend `pid`. */
    async function sessionOn(pid: number): Promise<{ tenant: string | null; pid: number }>
    {
        for (let attempt = 0; attempt < 10; attempt++)
        {
            const current = await noteRepository.session();

            if (current.pid === pid)
            {
                return current;
            }
        }

        throw new Error(`the write pool never handed out backend ${pid}`);
    }
});
