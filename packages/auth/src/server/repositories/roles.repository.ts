/**
 * Roles Repository
 *
 * 역할 관리를 위한 Repository
 * BaseRepository를 상속받아 자동 트랜잭션 컨텍스트 지원 및 Read/Write 분리
 */

import { NewRoleEntity, roles, type Role } from '../entities/roles';
import { users } from '../entities/users';
import { userInvitations } from '../entities/user-invitations';
import { claimableAt } from './invitations.repository';
import { CONFIG_OWNED, OPERATOR_OWNED } from '../entities/ownership';
import { BaseRepository } from '@spfn/core/db';
import { and, asc, count, eq, inArray, not, notInArray, sql, type SQL } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { isLockTimeout } from '../lib/lock-timeout';
import { RbacSyncBusyError } from '@spfn/auth/errors';

/** A role as the configuration declares it: every field `upsertDeclared` makes equal to it. */
export type DeclaredRole = Pick<NewRoleEntity, 'name' | 'displayName' | 'description' | 'priority' | 'isSystem' | 'isBuiltin'>;

/** What still names a role: each must be gone before the role can be deleted. */
export interface RoleReferences
{
    /** Accounts storing the role, whatever their status. */
    accounts: number;
    /** Invitations that can still be accepted (`claimableAt`): each promises the role to whoever accepts it. */
    pendingInvitations: number;
}

/**
 * The configuration sync's advisory lock: the two-key form, so it lives apart
 * from single-key advisory locks such as the per-address one the OAuth client
 * registration takes. `0x5350464e` is "SPFN"; `1` is this sync.
 */
const CONFIG_SYNC_LOCK = { space: 0x5350464e, key: 1 } as const;

/** A backend holding a lock the configuration sync waits for, as Postgres sees it. */
export interface LockHolder
{
    pid: number;
    applicationName: string;
    clientAddress: string | null;
    /** When its transaction — the one holding the lock — began. */
    since: Date | null;
}

/** A role the configuration owns and does not declare among `declaredNames`. */
function undeclaredBy(declaredNames: string[])
{
    return and(eq(roles.source, CONFIG_OWNED), declaredNames.length > 0 ? notInArray(roles.name, declaredNames) : undefined);
}

/**
 * Roles Repository 클래스
 */
export class RolesRepository extends BaseRepository
{
    /**
     * ID로 역할 조회
     */
    async findById(id: number)
    {
        const result = await this.readDb
            .select()
            .from(roles)
            .where(eq(roles.id, id))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * ID로 역할 조회 — Write primary. A role change is judged on the role's
     * priority and state as they are now, not as a replica last saw them.
     */
    async findByIdOnPrimary(id: number)
    {
        const result = await this.db
            .select()
            .from(roles)
            .where(eq(roles.id, id))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Lock the roles an operation rests on for the rest of its transaction —
     * the one way role rows are locked. Write primary.
     *
     * **Order rule: an operation takes all of its role locks in this one call,
     * in ascending id order, and none after it.** Two operations that lock
     * roles then meet first on the lowest id both need, and the one that waits
     * there holds no role the other is still to take: they queue, and never
     * hold each other's next lock — the deadlock Postgres would answer by
     * aborting one with a 500. Where the operation also locks an account, the
     * account comes first: account, then roles.
     *
     * Each role is taken with the strength the operation needs: `update` for a
     * role it changes (its rank, state or permissions, or the role itself),
     * `share` for a role a judgement rests on (`permission.service`), which a
     * change of that role then waits for. `noKeyUpdate` is the boot sync's
     * (`rbac.service`): a role whose declared fields or owner it writes, which
     * conflicts with both of the others — an operator's change or judgement of
     * the role queues behind it — but not with the `FOR KEY SHARE` of a foreign
     * key, so a signup naming the role does not wait for a boot. A role asked
     * for several ways is taken with the strongest. One statement per role, in
     * id order: a statement takes one strength for every row it locks.
     *
     * @returns the roles that exist, in id order
     */
    async lockInIdOrder(locks: { update?: number[]; noKeyUpdate?: number[]; share?: Array<number | null | undefined> })
    {
        const update = new Set((locks.update ?? []).map(Number));
        const noKeyUpdate = new Set((locks.noKeyUpdate ?? []).map(Number));
        const share = (locks.share ?? []).filter(id => id != null).map(Number);
        const ids = [...new Set([...update, ...noKeyUpdate, ...share])].sort((a, b) => a - b);
        const held: Role[] = [];

        for (const id of ids)
        {
            const role = await this.lockOne(id, update.has(id) ? 'update' : noKeyUpdate.has(id) ? 'no key update' : 'share');

            if (role)
            {
                held.push(role);
            }
        }

        return held;
    }

    /** One role, locked with `strength`: `lockInIdOrder`'s step, never taken on its own. */
    private async lockOne(id: number, strength: 'update' | 'no key update' | 'share'): Promise<Role | null>
    {
        const [role] = await this.db
            .select()
            .from(roles)
            .where(eq(roles.id, id))
            .for(strength);

        return role ?? null;
    }

    /**
     * Take the configuration sync's lock for the rest of the transaction — a
     * PostgreSQL advisory lock, so it holds no row: an operator's change of a
     * role never waits on it. Waits at most `waitMs` (a transaction-local
     * `lock_timeout`) for another instance's sync to finish.
     *
     * Take it first in the one transaction the sync runs in (`rbac.service`):
     * the lock and the sync share one connection, and the lock lasts exactly
     * as long as the sync. The `lock_timeout` stays in force for the rest of
     * that transaction, so every lock wait the sync makes after this one is
     * bounded by `waitMs` too.
     *
     * @throws RbacSyncBusyError when the wait runs out — the transaction is aborted
     */
    async lockConfigSync(waitMs: number): Promise<void>
    {
        await this.db.execute(sql`select set_config('lock_timeout', ${String(waitMs)}, true)`);
        await this.db
            .execute(sql`select pg_advisory_xact_lock(${CONFIG_SYNC_LOCK.space}, ${CONFIG_SYNC_LOCK.key})`)
            .catch((error: unknown) => Promise.reject(isLockTimeout(error)
                ? new RbacSyncBusyError({ message: `Another instance held the RBAC configuration sync for more than ${waitMs} ms` })
                : error));
    }

    /** Who holds the configuration sync's lock now, on the primary; null for nobody. */
    async findConfigSyncHolder(): Promise<LockHolder | null>
    {
        const [holder] = await this.findLockHolders(sql`l.locktype = 'advisory'
            and l.classid = ${CONFIG_SYNC_LOCK.space} and l.objid = ${CONFIG_SYNC_LOCK.key} and l.objsubid = 2`);

        return holder ?? null;
    }

    /**
     * Who holds role rows now, on the primary, oldest transaction first: every
     * other backend whose transaction holds the roles table in a mode that
     * locks or writes rows. Postgres keeps a row lock in the row, not in
     * `pg_locks`, so this names the transactions that may hold one — the
     * running changes the sync's role locks (`lockInIdOrder`) can wait for.
     */
    async findRoleLockHolders(): Promise<LockHolder[]>
    {
        const { schema, name } = getTableConfig(roles);

        return this.findLockHolders(sql`l.locktype = 'relation'
            and l.relation = to_regclass(${`"${schema}"."${name}"`})
            and l.mode not in ('AccessShareLock', 'ShareUpdateExclusiveLock')
            and l.pid <> pg_backend_pid()`);
    }

    /** The backends holding a granted lock of this database that `which` selects, oldest transaction first. */
    private async findLockHolders(which: SQL): Promise<LockHolder[]>
    {
        const holders = await this.db.execute<{ pid: number; application_name: string; client_address: string | null; since: string | null }>(sql`
            select distinct a.pid, a.application_name, host(a.client_addr) as client_address, a.xact_start as since
            from pg_locks l
            join pg_stat_activity a on a.pid = l.pid
            where l.granted
                and l.database = (select oid from pg_database where datname = current_database())
                and ${which}
            order by since`);

        return holders.map(holder => ({
            pid: Number(holder.pid),
            applicationName: holder.application_name,
            clientAddress: holder.client_address,
            since: holder.since === null ? null : new Date(holder.since),
        }));
    }

    /**
     * Name으로 역할 조회 — Write primary, for a role read as part of an
     * account's authority.
     */
    async findByNameOnPrimary(name: string)
    {
        const result = await this.db
            .select()
            .from(roles)
            .where(eq(roles.name, name))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Name으로 역할 조회
     */
    async findByName(name: string)
    {
        const result = await this.readDb
            .select()
            .from(roles)
            .where(eq(roles.name, name))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * 모든 역할 조회 (priority 순)
     */
    async findAll()
    {
        return this.readDb
            .select()
            .from(roles)
            .orderBy(asc(roles.priority));
    }

    /**
     * 모든 역할 조회 — Write primary, for the boot sync that has just written them.
     */
    async findAllOnPrimary()
    {
        return this.db
            .select()
            .from(roles)
            .orderBy(asc(roles.id));
    }

    /**
     * 활성 역할만 조회
     */
    async findActive()
    {
        return this.readDb
            .select()
            .from(roles)
            .where(eq(roles.isActive, true))
            .orderBy(asc(roles.priority));
    }

    /**
     * 역할 생성
     */
    async create(data: NewRoleEntity)
    {
        return await this._create(roles, data);
    }

    /**
     * 역할 업데이트
     */
    async updateById(id: number, data: Partial<NewRoleEntity>)
    {
        const result = await this.db
            .update(roles)
            .set(data)
            .where(eq(roles.id, id))
            .returning();

        return result[0] ?? null;
    }

    /**
     * Make a declared role that exists equal to its declaration and the
     * configuration's — update the fields the configuration declares and take
     * it over (`source = 'config'`); `isActive` is the operator's, set on
     * insert only. A row already equal is not written.
     *
     * Only for a role the caller holds (`lockInIdOrder`, `noKeyUpdate`): `ON
     * CONFLICT DO UPDATE` locks the row it meets even when it writes nothing,
     * and on a held row that lock is no new wait. One role per statement: a
     * statement over every role would lock them in whatever order it met them.
     * A role that does not exist yet is `insertDeclared`'s.
     */
    async upsertDeclared(role: DeclaredRole): Promise<void>
    {
        await this.db
            .insert(roles)
            .values({ ...role, isActive: true, source: CONFIG_OWNED })
            .onConflictDoUpdate({
                target: roles.name,
                set: {
                    displayName: sql`excluded.display_name`,
                    description: sql`excluded.description`,
                    priority: sql`excluded.priority`,
                    isSystem: sql`excluded.is_system`,
                    isBuiltin: sql`excluded.is_builtin`,
                    source: CONFIG_OWNED,
                },
                setWhere: sql`(${roles.displayName}, ${roles.description}, ${roles.priority}, ${roles.isSystem}, ${roles.isBuiltin}, ${roles.source})
                    is distinct from (excluded.display_name, excluded.description, excluded.priority, excluded.is_system, excluded.is_builtin, excluded.source)`,
            });
    }

    /**
     * Insert a declared role the caller saw no row for, as the configuration's
     * and active. A role of that name found after all — created since the
     * caller read the roles — is left alone: `ON CONFLICT DO NOTHING` takes no
     * lock on it, so the caller never holds a role it did not lock in id order.
     *
     * @returns the role inserted, or null when the name was taken
     */
    async insertDeclared(role: DeclaredRole): Promise<Role | null>
    {
        const [inserted] = await this.db
            .insert(roles)
            .values({ ...role, isActive: true, source: CONFIG_OWNED })
            .onConflictDoNothing({ target: roles.name })
            .returning();

        return inserted ?? null;
    }

    /**
     * Hand the roles the configuration no longer declares to the operator:
     * from now on the admin API may change or delete them. Only among `ids`,
     * which the caller has locked (`lockInIdOrder`): the update then takes no
     * role lock of its own.
     *
     * @returns the names released
     */
    async releaseUndeclared(ids: number[], declaredNames: string[]): Promise<string[]>
    {
        if (ids.length === 0)
        {
            return [];
        }

        const released = await this.db
            .update(roles)
            .set({ source: OPERATOR_OWNED })
            .where(and(inArray(roles.id, ids), undeclaredBy(declaredNames)))
            .returning({ name: roles.name });

        return released.map(role => role.name);
    }

    /**
     * What still names a role, on the primary — for `deleteRole`, under the
     * role's `FOR UPDATE` lock: an account or invitation written after this
     * read waits on that lock and then fails its foreign-key check.
     */
    async referencesOf(id: number): Promise<RoleReferences>
    {
        const [accounts] = await this.db.select({ total: count() }).from(users).where(eq(users.roleId, id));
        const [pendingInvitations] = await this.db
            .select({ total: count() })
            .from(userInvitations)
            .where(and(eq(userInvitations.roleId, id), claimableAt(new Date())));

        return { accounts: accounts!.total, pendingInvitations: pendingInvitations!.total };
    }

    /**
     * Delete a role's settled invitations — every one that can no longer be
     * accepted (`claimableAt`): accepted, cancelled, expired, and pending past
     * its expiry. None can give the role any more, and
     * `user_invitations.role_id` restricts the role's deletion while they exist.
     */
    async deleteSettledInvitations(id: number): Promise<void>
    {
        await this.db
            .delete(userInvitations)
            .where(and(eq(userInvitations.roleId, id), not(claimableAt(new Date()))));
    }

    /**
     * 역할 삭제
     */
    async deleteById(id: number)
    {
        const result = await this.db
            .delete(roles)
            .where(eq(roles.id, id))
            .returning();

        return result[0] ?? null;
    }
}

// Default instance export
export const rolesRepository = new RolesRepository();
