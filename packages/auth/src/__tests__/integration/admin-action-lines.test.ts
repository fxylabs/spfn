/**
 * @spfn/auth - an admin action is recorded once it has committed, by ids (#489)
 *
 * Invitation cancel, delete and expire and role create and delete each write
 * one `authLogger.service` info line. A1 drives every act three ways:
 *
 * - inside an application transaction that rolls back — no line;
 * - inside one that commits — no line before the commit, exactly one after;
 * - on its own — exactly one.
 *
 * The line's context is exactly the fields decided for it, and no act writes
 * to the console. The acts are called as services, the way an application's
 * admin code and cron jobs call them.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { eq } from 'drizzle-orm';

import { setupTestDb, teardownTestDb, clearTables, getTestDb, isDatabaseAvailable } from '../helpers/db';
import { createTestUser } from '../helpers/oauth2';
import { userInvitations } from '@/server/entities';

const { runInTransaction } = await import('@spfn/core/db');
const { initializeAuth } = await import('@/server/services/rbac.service');
const { createRole, deleteRole, getRoleByName } = await import('@/server/services/role.service');
const { cancelInvitation, createInvitation, deleteInvitation, expireOldInvitations } = await import('@/server/services/invitation.service');
const { authLogger } = await import('@/server/logger');

const dbAvailable = await isDatabaseAvailable();

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** What an act works on: a row's id, and the role's name for the role acts. */
type Target = { id: number; name: string };

/** One act: what it is given, what it does, and the context its line must carry. */
type Act = {
    message: string;
    prepare: (admin: number) => Promise<Target>;
    run: (admin: number, target: Target) => Promise<Record<string, unknown>>;
};

let counter = 0;

async function pendingInvitation(admin: number): Promise<Target>
{
    counter += 1;
    const { invitation } = await createInvitation({
        email: `invitee-${counter}@admin-lines.test`,
        roleId: (await getRoleByName('user'))!.id,
        invitedBy: admin,
    });

    return { id: invitation.id, name: '' };
}

async function roleName(): Promise<Target>
{
    counter += 1;

    return { id: 0, name: `admin-lines-${counter}` };
}

async function customRole(admin: number): Promise<Target>
{
    const { name } = await roleName();

    return { id: (await createRole(admin, { name, displayName: 'Admin lines' })).id, name };
}

const ACTS: Record<string, Act> = {
    'invitation cancel': {
        message: 'Invitation cancelled',
        prepare: pendingInvitation,
        run: async (admin, { id }) =>
        {
            await cancelInvitation(id, admin, 'reason text that is not logged');

            return { invitationId: id, cancelledBy: admin };
        },
    },
    'invitation delete': {
        message: 'Invitation deleted',
        prepare: pendingInvitation,
        run: async (_admin, { id }) =>
        {
            await deleteInvitation(id);

            return { invitationId: id };
        },
    },
    'invitations expire': {
        message: 'Invitations expired',
        prepare: async (admin) =>
        {
            const invitation = await pendingInvitation(admin);
            await getTestDb().update(userInvitations)
                .set({ expiresAt: new Date(Date.now() - 60_000) })
                .where(eq(userInvitations.id, invitation.id));

            return invitation;
        },
        run: async () => ({ count: await expireOldInvitations() }),
    },
    'role create': {
        message: 'Role created',
        prepare: roleName,
        run: async (admin, { name }) =>
            ({ roleId: (await createRole(admin, { name, displayName: 'Admin lines' })).id, name }),
    },
    'role delete': {
        message: 'Role deleted',
        prepare: customRole,
        run: async (admin, { id, name }) =>
        {
            await deleteRole(admin, id);

            return { roleId: id, name };
        },
    },
};

/** After-commit callbacks run detached: let every queued one finish. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe.skipIf(!dbAvailable)('Admin actions are recorded after the commit, by ids (#489)', () =>
{
    let admin: number;
    let info: MockInstance;
    let consoleSpies: MockInstance[];

    beforeAll(async () =>
    {
        await setupTestDb();
    });

    afterAll(async () =>
    {
        await teardownTestDb();
    });

    beforeEach(async () =>
    {
        await clearTables(getTestDb());
        await initializeAuth();
        admin = await createTestUser('admin@admin-lines.test', (await getRoleByName('superadmin'))!.id);
        info = vi.spyOn(authLogger.service, 'info').mockImplementation(() => undefined);
        consoleSpies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    });

    afterEach(() =>
    {
        info.mockRestore();
        consoleSpies.forEach((spy) => spy.mockRestore());
    });

    /** Prepare a target with the spies cleared, so only the act is seen. */
    async function target(act: Act): Promise<Target>
    {
        const prepared = await act.prepare(admin);
        await settled();
        info.mockClear();
        consoleSpies.forEach((spy) => spy.mockClear());

        return prepared;
    }

    const lines = (act: Act) => info.mock.calls.filter(([message]) => message === act.message);
    const consoleCalls = () => consoleSpies.flatMap((spy) => spy.mock.calls);

    it.each(Object.keys(ACTS))('A1: %s — one line, after the commit, of exactly its fields', async (name) =>
    {
        const act = ACTS[name]!;

        const rolledBack = await target(act);
        await expect(runInTransaction(async () =>
        {
            await act.run(admin, rolledBack);
            throw new Error('the application rolls back');
        })).rejects.toThrow('the application rolls back');
        await settled();
        expect(lines(act)).toEqual([]);

        const committed = await target(act);
        let linesBeforeCommit = -1;
        const fields = await runInTransaction(async () =>
        {
            const decided = await act.run(admin, committed);
            await settled();
            linesBeforeCommit = lines(act).length;

            return decided;
        });
        await settled();
        expect(linesBeforeCommit).toBe(0);
        expect(lines(act)).toEqual([[act.message, fields]]);
        expect(consoleCalls()).toEqual([]);

        const alone = await target(act);
        const aloneFields = await act.run(admin, alone);
        await settled();
        expect(lines(act)).toEqual([[act.message, aloneFields]]);
        expect(consoleCalls()).toEqual([]);
    });
});
