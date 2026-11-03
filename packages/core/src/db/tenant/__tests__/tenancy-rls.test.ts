/**
 * Tenancy execution rules — rows L1–L18 and O3 of the #158 part 2 design case
 * table, and M1–M16 (the `visibleTo` and tenant list policies, hand-written SQL)
 * and U1–U20 (`runInTransaction({ user })`, `_selectOfUser`) of the #162 one
 *
 * Every row runs as the app role, which owns no table and is neither superuser
 * nor BYPASSRLS — the first test proves it, since otherwise the policy would
 * not apply and every row would pass for nothing. The owner created the schema
 * from the SQL drizzle-kit generates. Skips when no test database is available.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { and, asc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDatabase } from '../../manager';
import { runInTransaction, Transactional } from '../../transaction';
import { TenantMismatchError } from '../errors';
import { createTenancyDb } from './tenancy-db';
import { authors, members, memos, notes, tenancy, TENANCY_SCHEMA, workspaces } from './tenancy-fixtures';
import { MemberRepository, MemoRepository, NoteRepository } from './tenancy-repositories';

/** The policy's error when `app.tenant_id` is missing or empty on the connection. */
const NO_TENANT = /app\.tenant_id|invalid input syntax for type bigint/;

const isBegin = (statement: string) => /^begin\b/i.test(statement);
const isSetConfig = (statement: string) => statement.includes('set_config');

/** A nested runInTransaction held open until `close()`, which settles it. */
interface HeldSavepoint
{
    /** Settles once the savepoint is open and `inside` has run in it */
    open: Promise<void>;
    /** Let the savepoint finish — released, or rolled back by a throw — and wait for it */
    close(): Promise<void>;
}

/**
 * Open a savepoint off the calling frame and hold it, so a test can run a call
 * from the outer frame while it is open — the `Promise.all` shape, made
 * deterministic.
 */
function holdSavepoint(outcome: 'release' | 'rollback', inside?: () => Promise<void>): HeldSavepoint
{
    let opened!: () => void;
    let finish!: () => void;
    const open = new Promise<void>((resolve) =>
    {
        opened = resolve;
    });
    const finishing = new Promise<void>((resolve) =>
    {
        finish = resolve;
    });
    const settled = runInTransaction(async () =>
    {
        await inside?.();
        opened();
        await finishing;

        if (outcome === 'rollback')
        {
            throw new Error('undo the savepoint');
        }
    }).catch(() => undefined);

    return {
        open,
        close: () =>
        {
            finish();

            return settled;
        },
    };
}

/** Run a hand-written statement in a transaction bound as `bindings` says. */
function runBound(statement: string, bindings: { tenant?: number; user?: number }): Promise<Record<string, unknown>[]>
{
    return runInTransaction(async (tx) => await tx.execute(sql.raw(statement)) as unknown as Record<string, unknown>[], bindings);
}

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
    const memberRepository = new MemberRepository();
    const ids = (rows: readonly object[]) => rows.map((row) => Number((row as { id: unknown }).id));
    const noteCount = async () => Number((await db.owner`select count(*)::int as n from ${db.owner(TENANCY_SCHEMA)}.notes`)[0].n);
    const ownerRows = async (statement: string) => db.owner.unsafe(statement.replaceAll('$schema', TENANCY_SCHEMA));
    const memberRoles = async () => (await ownerRows('select id, role from $schema.members order by id')).map((row) => `${row.id}:${row.role}`);
    const workspaceNames = async () => (await ownerRows('select id, name from $schema.workspaces order by id')).map((row) => `${row.id}:${row.name}`);
    const SEEDED_ROLES = ['1:member', '2:member', '3:member', '4:member'];
    const SEEDED_NAMES = ['7:seven', '9:nine', '11:eleven'];
    const userSettings = () => db.settingLog.filter((record) => record.setting === 'app.user_id');

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

    it('L11c a tenant set from the root while a savepoint is open is set again after that savepoint rolls back', async () =>
    {
        if (!db.isAvailable) return;

        const result = await runInTransaction(async () =>
        {
            const savepoint = holdSavepoint('rollback');

            await savepoint.open;
            const during = await noteRepository.list(7);
            await savepoint.close();

            return { during, after: await noteRepository.list(7), session: await noteRepository.session() };
        });

        expect(ids(result.during)).toEqual([1, 2]);
        expect(ids(result.after)).toEqual([1, 2]);
        expect(result.session.tenant).toBe('7');
        expect(db.writeLog.filter(isSetConfig)).toHaveLength(2);
    });

    it('L11d a tenant set from the root while a savepoint is open stands when that savepoint releases', async () =>
    {
        if (!db.isAvailable) return;

        const rows = await runInTransaction(async () =>
        {
            const savepoint = holdSavepoint('release');

            await savepoint.open;
            await noteRepository.list(7);
            await savepoint.close();

            return noteRepository.list(7);
        });

        expect(ids(rows)).toEqual([1, 2]);
        expect(db.writeLog.filter(isSetConfig)).toHaveLength(1);

        // The released savepoint is closed: a tenant set after it belongs to the
        // root, and a later sibling's rollback leaves it alone
        const sent = db.writeLog.length;
        const later = await runInTransaction(async () =>
        {
            await holdSavepoint('release').close();
            await noteRepository.list(7);
            await holdSavepoint('rollback').close();

            return noteRepository.list(7);
        });

        expect(ids(later)).toEqual([1, 2]);
        expect(db.writeLog.slice(sent).filter(isSetConfig)).toHaveLength(1);
    });

    it('L11e a tenant set from the root under two open savepoints follows whichever of them rolls back', async () =>
    {
        if (!db.isAvailable) return;

        const underTwo = (innerOutcome: 'release' | 'rollback', outerOutcome: 'release' | 'rollback') =>
            runInTransaction(async () =>
            {
                let inner!: HeldSavepoint;
                const outer = holdSavepoint(outerOutcome, async () =>
                {
                    inner = holdSavepoint(innerOutcome);
                    await inner.open;
                });

                await outer.open;
                await noteRepository.list(7);
                await inner.close();
                await outer.close();

                return { rows: await noteRepository.list(7), session: await noteRepository.session() };
            });

        const innerRolledBack = await underTwo('rollback', 'release');

        expect(ids(innerRolledBack.rows)).toEqual([1, 2]);
        expect(innerRolledBack.session.tenant).toBe('7');
        expect(db.writeLog.filter(isSetConfig)).toHaveLength(2);

        const sent = db.writeLog.length;
        const outerRolledBack = await underTwo('release', 'rollback');

        expect(ids(outerRolledBack.rows)).toEqual([1, 2]);
        expect(outerRolledBack.session.tenant).toBe('7');
        expect(db.writeLog.slice(sent).filter(isSetConfig)).toHaveLength(2);
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

    // ------------------------------------------------------------------------
    // M — the visibleTo and tenant list policies, on hand-written SQL
    // ------------------------------------------------------------------------

    it('M1 bound to tenant 7, members shows workspace 7\'s two rows', async () =>
    {
        if (!db.isAvailable) return;

        expect(ids(await runBound(`select id from ${TENANCY_SCHEMA}.members order by id`, { tenant: 7 }))).toEqual([1, 3]);
    });

    it('M2 bound to user 3, members shows user 3\'s three rows in workspaces 7, 9 and 11', async () =>
    {
        if (!db.isAvailable) return;

        const rows = await runBound(`select id, tenant_id from ${TENANCY_SCHEMA}.members order by id`, { user: 3 });

        expect(rows.map((row) => `${row.id}:${row.tenant_id}`)).toEqual(['1:7', '2:9', '4:11']);
    });

    it('M3 bound to neither, a read of members fails on app.tenant_id', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(runBound(`select id from ${TENANCY_SCHEMA}.members`, {}))).toMatch(NO_TENANT);
    });

    it('M4 bound to tenant 7 and user 3, members shows the union of the two', async () =>
    {
        if (!db.isAvailable) return;

        expect(ids(await runBound(`select id from ${TENANCY_SCHEMA}.members order by id`, { tenant: 7, user: 3 }))).toEqual([1, 2, 3, 4]);
    });

    it('M5 bound to user 3 only, an update of user 3\'s memberships fails and changes nothing', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(runBound(`update ${TENANCY_SCHEMA}.members set role = 'owner' where user_id = 3`, { user: 3 }))).toMatch(NO_TENANT);
        expect(await memberRoles()).toEqual(SEEDED_ROLES);
    });

    it('M6 bound to user 3 only, a delete of user 3\'s memberships fails and deletes nothing', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(runBound(`delete from ${TENANCY_SCHEMA}.members where user_id = 3`, { user: 3 }))).toMatch(NO_TENANT);
        expect(await memberRoles()).toEqual(SEEDED_ROLES);
    });

    it('M7 bound to user 3 only, an insert of a membership fails', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(runBound(
            `insert into ${TENANCY_SCHEMA}.members (tenant_id, user_id, role, status) values (9, 3, 'owner', 'active')`,
            { user: 3 },
        ))).toMatch(NO_TENANT);
        expect(await memberRoles()).toEqual(SEEDED_ROLES);
    });

    it('M8 bound to tenant 7 and user 3, an update of user 3\'s memberships changes workspace 7\'s row only', async () =>
    {
        if (!db.isAvailable) return;

        const updated = await runBound(`update ${TENANCY_SCHEMA}.members set role = 'owner' where user_id = 3 returning id`, { tenant: 7, user: 3 });

        expect(ids(updated)).toEqual([1]);
        expect(await memberRoles()).toEqual(['1:owner', '2:member', '3:member', '4:member']);
    });

    it('M9 bound to user 3, workspaces shows 7 and 9 — 11 is an invited membership', async () =>
    {
        if (!db.isAvailable) return;

        expect(ids(await runBound(`select id from ${TENANCY_SCHEMA}.workspaces order by id`, { user: 3 }))).toEqual([7, 9]);
    });

    it('M10 bound to tenant 7, workspaces shows 7 only', async () =>
    {
        if (!db.isAvailable) return;

        expect(ids(await runBound(`select id from ${TENANCY_SCHEMA}.workspaces order by id`, { tenant: 7 }))).toEqual([7]);
    });

    it('M11 bound to neither, a read of workspaces fails', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(runBound(`select id from ${TENANCY_SCHEMA}.workspaces`, {}))).toMatch(NO_TENANT);
    });

    it('M12 bound to neither, an insert into workspaces is stored', async () =>
    {
        if (!db.isAvailable) return;

        await runBound(`insert into ${TENANCY_SCHEMA}.workspaces (name) values ('new')`, {});

        expect(await workspaceNames()).toEqual([...SEEDED_NAMES, '101:new']);
    });

    it('M13 bound to user 3 only, renaming workspace 7 fails and the name stays', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(runBound(`update ${TENANCY_SCHEMA}.workspaces set name = 'x' where id = 7`, { user: 3 }))).toMatch(NO_TENANT);
        expect(await workspaceNames()).toEqual(SEEDED_NAMES);
    });

    it('M14 bound to tenant 7, renaming workspace 7 works and 9 keeps its name', async () =>
    {
        if (!db.isAvailable) return;

        await runBound(`update ${TENANCY_SCHEMA}.workspaces set name = 'x' where id = 7`, { tenant: 7 });

        expect(await workspaceNames()).toEqual(['7:x', '9:nine', '11:eleven']);
    });

    it('M15 bound to user 3, a table without visibleTo still fails as before', async () =>
    {
        if (!db.isAvailable) return;

        expect(await failureOf(runBound(`select id from ${TENANCY_SCHEMA}.notes`, { user: 3 }))).toMatch(NO_TENANT);
    });

    it('M16 after a user 3 transaction ends, its connection has no user and a members read fails again', async () =>
    {
        if (!db.isAvailable) return;

        const inside = await runInTransaction(() => noteRepository.session(), { user: 3 });
        const after = await sessionOn(inside.pid);

        expect(inside.user).toBe('3');
        expect(after.user ?? '').toBe('');
        expect(await failureOf(memberRepository.directMembers())).toMatch(NO_TENANT);
    });

    // ------------------------------------------------------------------------
    // U — runInTransaction({ user }) and TenantRepository._selectOfUser
    // ------------------------------------------------------------------------

    it('U1 _selectOfUser outside a transaction: BEGIN, READ ONLY, app.user_id, the query, COMMIT on the read pool', async () =>
    {
        if (!db.isAvailable) return;

        const rows = await memberRepository.membershipsOf(3);

        expect(rows).toEqual([{ id: 1, tenantId: 7 }, { id: 2, tenantId: 9 }, { id: 4, tenantId: 11 }]);
        expect(db.readLog.filter(isBegin)).toHaveLength(1);
        expect(db.readLog[0]).toMatch(/^begin/i);
        expect(db.readLog).toContain('set transaction read only');
        expect(db.readLog.filter(isSetConfig)).toHaveLength(1);
        expect(db.readLog.at(-2)).toMatch(/"members"\."user_id" = \$1/);
        expect(db.readLog.at(-1)).toMatch(/^commit/i);
        expect(db.settingLog).toEqual([{ pool: 'read', setting: 'app.user_id', value: '3' }]);
        expect(db.writeLog).toEqual([]);
    });

    it('U2 inside runInTransaction({ user: 3 }) it runs in that transaction and sets nothing more', async () =>
    {
        if (!db.isAvailable) return;

        const rows = await runInTransaction(() => memberRepository.membershipsOf(3), { user: 3 });

        expect(ids(rows)).toEqual([1, 2, 4]);
        expect(db.writeLog.filter(isBegin)).toHaveLength(1);
        expect(db.settingLog).toEqual([{ pool: 'write', setting: 'app.user_id', value: '3' }]);
        expect(db.readLog).toEqual([]);
    });

    it('U3 _selectOfUser(5) inside runInTransaction({ user: 3 }) throws TenantMismatchError with key user and sends nothing', async () =>
    {
        if (!db.isAvailable) return;

        await runInTransaction(async () =>
        {
            const sent = db.writeLog.length;
            const error = await Promise.resolve(memberRepository.membershipsOf(5)).catch((reason: unknown) => reason);

            expect(error).toBeInstanceOf(TenantMismatchError);
            expect(error).toMatchObject({ key: 'user', expected: 3, received: 5, source: 'transaction' });
            expect((error as Error).message).toBe('User 5 does not match the user 3 this transaction is bound to');
            expect(new TenantMismatchError(3, 5, 'transaction').key).toBe('tenant');
            expect(db.writeLog).toHaveLength(sent);
        }, { user: 3 });
    });

    it('U4 the first _selectOfUser in a transaction binds it to user 3; a direct query after it sees user 3\'s rows', async () =>
    {
        if (!db.isAvailable) return;

        const result = await runInTransaction(async () =>
        {
            await memberRepository.membershipsOf(3);

            return { direct: ids(await memberRepository.directMembers()), session: await noteRepository.session() };
        });

        expect(result.direct).toEqual([1, 2, 4]);
        expect(result.session.user).toBe('3');
        expect(result.session.tenant ?? '').toBe('');
    });

    it('U5 _selectOfUser(3) inside runInTransaction({ tenant: 7 }) binds both; a direct query sees the union', async () =>
    {
        if (!db.isAvailable) return;

        const result = await runInTransaction(async () =>
        {
            const scoped = ids(await memberRepository.membershipsOf(3));

            return { scoped, direct: ids(await memberRepository.directMembers()), session: await noteRepository.session() };
        }, { tenant: 7 });

        expect(result.scoped).toEqual([1, 2, 4]);
        expect(result.direct).toEqual([1, 2, 3, 4]);
        expect(result.session).toMatchObject({ tenant: '7', user: '3' });
    });

    it('U6 runInTransaction refuses a user that is not a positive safe integer before opening', async () =>
    {
        if (!db.isAvailable) return;

        for (const user of [0, -1, 1.5, Number.NaN, '3' as unknown as number])
        {
            await expect(runInTransaction(async () => undefined, { user })).rejects.toThrow('Invalid user value');
        }

        expect(db.writeLog).toEqual([]);
    });

    it('U7 a nested runInTransaction({ user: 5 }) inside user 3 throws before the SAVEPOINT; the outer user stays 3', async () =>
    {
        if (!db.isAvailable) return;

        const outer = await runInTransaction(async () =>
        {
            const sent = db.writeLog.length;

            await expect(runInTransaction(async () => undefined, { user: 5 })).rejects.toMatchObject({ name: 'TenantMismatchError', key: 'user' });
            expect(db.writeLog).toHaveLength(sent);

            return { session: await noteRepository.session(), rows: ids(await memberRepository.membershipsOf(3)) };
        }, { user: 3 });

        expect(outer.session.user).toBe('3');
        expect(outer.rows).toEqual([1, 2, 4]);
        expect(userSettings()).toHaveLength(1);
    });

    it('U8 requiresNew with user 5 inside user 3 runs on its own connection; the outer user stays 3', async () =>
    {
        if (!db.isAvailable) return;

        const result = await runInTransaction(async () =>
        {
            const outerSession = await noteRepository.session();
            const inner = await runInTransaction(
                async () => ({ rows: ids(await memberRepository.membershipsOf(5)), session: await noteRepository.session() }),
                { requiresNew: true, user: 5 },
            );

            return { outerSession, inner, after: await noteRepository.session() };
        }, { user: 3 });

        expect(result.inner.rows).toEqual([3]);
        expect(result.inner.session.user).toBe('5');
        expect(result.inner.session.pid).not.toBe(result.outerSession.pid);
        expect(result.after.user).toBe('3');
    });

    it('U9 a user first set inside a savepoint that rolls back is set again by the next call', async () =>
    {
        if (!db.isAvailable) return;

        const result = await runInTransaction(async () =>
        {
            await runInTransaction(async () =>
            {
                await memberRepository.membershipsOf(3);
                throw new Error('undo the savepoint');
            }).catch(() => undefined);

            const afterRollback = await noteRepository.session();

            return { afterRollback, rows: ids(await memberRepository.membershipsOf(5)), session: await noteRepository.session() };
        });

        expect(result.afterRollback.user ?? '').toBe('');
        expect(result.rows).toEqual([3]);
        expect(result.session.user).toBe('5');
        expect(userSettings().map((record) => record.value)).toEqual(['3', '5']);
    });

    it('U10 _selectOfUser(3).from(notes) throws at from: notes declares no visibleTo', () =>
    {
        expect(() => memberRepository.ofUser(3).from(notes))
            .toThrow('Table "notes" declares no visibleTo user column; _selectOfUser reads from a tenancy.table declared with visibleTo');
    });

    it('U11 joining a tenancy table without visibleTo throws at the join and points to _select(tenantId)', () =>
    {
        const query = memberRepository.ofUser(3).from(members);

        expect(() => query.innerJoin(notes, eq(members.tenantId, notes.tenantId)))
            .toThrow('Table "notes" has a tenant column but no visibleTo user column, so a _selectOfUser query cannot join it without reading across tenants; read it by tenant with _select(tenantId)');
    });

    it('U12 joining a tenantKey()-only table throws at the join', () =>
    {
        const query = memberRepository.ofUser(3).from(members);

        expect(() => query.leftJoin(memos, eq(members.tenantId, memos.tenantId)))
            .toThrow('Table "memos" has a tenant column but no visibleTo user column');
    });

    it('U13 an ordinary table joins without a condition; the tenant list policy leaves out the invited workspace', async () =>
    {
        if (!db.isAvailable) return;

        const query = memberRepository.workspacesOf(3);

        expect(query.toSQL().sql).toContain(`inner join "${TENANCY_SCHEMA}"."workspaces" on "${TENANCY_SCHEMA}"."members"."tenant_id" = "${TENANCY_SCHEMA}"."workspaces"."id"`);
        expect(await query).toEqual([{ id: 7, name: 'seven' }, { id: 9, name: 'nine' }]);
    });

    it('U14 a left-joined visibleTo alias gets user = 3 in its ON clause', async () =>
    {
        if (!db.isAvailable) return;

        const peers = alias(members, 'peers');
        const query = memberRepository.ofUser(3).from(members)
            .leftJoin(peers, eq(members.tenantId, peers.tenantId))
            .orderBy(asc(members.id));

        expect(query.toSQL().sql).toContain(`left join "${TENANCY_SCHEMA}"."members" "peers" on (("${TENANCY_SCHEMA}"."members"."tenant_id" = "peers"."tenant_id") and ("peers"."user_id" = $1))`);
        expect((await query).map((row) => `${row.members.id}:${row.peers?.id}`)).toEqual(['1:1', '2:2', '4:4']);
    });

    it('U15 .prepare(), rightJoin and union are refused as on _select', () =>
    {
        const query = () => memberRepository.ofUser(3).from(members);

        expect(() => query().prepare('q')).toThrow(/prepare\(\) is not supported on a TenantRepository _selectOfUser that reads a tenancy table/);
        expect(() => query().rightJoin(workspaces, eq(members.tenantId, workspaces.id))).toThrow('rightJoin() is not supported on a TenantRepository _selectOfUser');
        expect(() => query().union(memberRepository.ofUser(3).from(members))).toThrow('union() is not supported on a TenantRepository _selectOfUser');
    });

    it('U16 toSQL() is the user condition on the from table and runs nothing', () =>
    {
        const { sql: text, params } = memberRepository.activeOf(3).toSQL();

        expect(text).toContain(`where (((("${TENANCY_SCHEMA}"."members"."status" = $1) and ("${TENANCY_SCHEMA}"."members"."role" = $2))) `
            + `and ("${TENANCY_SCHEMA}"."members"."user_id" = $3))`);
        expect(params).toEqual(['active', 'member', 3]);

        if (db.isAvailable)
        {
            expect([...db.readLog, ...db.writeLog]).toEqual([]);
        }
    });

    it('U17 _select(7).from(members) is scoped by tenant as before, with no user condition', async () =>
    {
        if (!db.isAvailable) return;

        const query = memberRepository.ofTenant(7);

        expect(query.toSQL().sql).toContain(`where "${TENANCY_SCHEMA}"."members"."tenant_id" = $1`);
        expect(query.toSQL().sql).not.toContain('user_id');
        expect(ids(await query)).toEqual([1, 3]);
        expect(db.settingLog).toEqual([{ pool: 'read', setting: 'app.tenant_id', value: '7' }]);
    });

    it('U18 inside a request guarded for tenant 7, _selectOfUser(3) is allowed', async () =>
    {
        if (!db.isAvailable) return;

        const app = new Hono();

        app.get('/w/:workspaceId/me', tenancy.guard({ param: 'workspaceId' }), async (c) => c.json(ids(await memberRepository.membershipsOf(3))));

        const response = await app.request('/w/7/me');

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual([1, 2, 4]);
    });

    it('U19 concurrent reads for users 3 and 5 on a one-connection read pool each see their own rows', async () =>
    {
        if (!db.isAvailable) return;

        const results = await Promise.all(Array.from({ length: 10 }, (_, index) =>
        {
            const userId = index % 2 === 0 ? 3 : 5;

            return memberRepository.membershipsOf(userId).then((rows) => ({ userId, rows: ids(rows) }));
        }));

        for (const { userId, rows } of results)
        {
            expect(rows).toEqual(userId === 3 ? [1, 2, 4] : [3]);
        }
    });

    it('U20 _selectOfUser and then _findOne(7, members) in one transaction bind both', async () =>
    {
        if (!db.isAvailable) return;

        const result = await runInTransaction(async () =>
        {
            const memberships = ids(await memberRepository.membershipsOf(3));
            const isMember = await memberRepository.isMember(7, 5);

            return { memberships, isMember, session: await noteRepository.session() };
        });

        expect(result).toMatchObject({ memberships: [1, 2, 4], isMember: true, session: { tenant: '7', user: '3' } });
        expect(db.settingLog.map((record) => `${record.setting}=${record.value}`)).toEqual(['app.user_id=3', 'app.tenant_id=7']);
    });

    /** `session()` outside a transaction, retried until the pool hands out backend `pid`. */
    async function sessionOn(pid: number): Promise<{ tenant: string | null; user: string | null; pid: number }>
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
