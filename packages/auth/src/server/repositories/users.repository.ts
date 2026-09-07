/**
 * Users Repository
 *
 * 사용자 데이터 관리를 위한 Repository
 * BaseRepository를 상속받아 자동 트랜잭션 컨텍스트 지원 및 Read/Write 분리
 */

import { eq, and, sql } from 'drizzle-orm';
import { BaseRepository } from '@spfn/core/db';
import { EntityNotFoundError, NotFoundError } from '@spfn/core/errors';

import { rolePermissions, roles, NewUser, users, permissions } from '../entities';
import { normalizeEmail, normalizeOptionalEmail } from '../helpers/email';

/**
 * Users Repository 클래스
 *
 * BaseRepository를 상속받아 다음 기능을 제공:
 * - 자동 트랜잭션 컨텍스트 감지 및 사용
 * - Read/Write 연결 분리 (replica 활용)
 * - 타입 안전성
 */
export class UsersRepository extends BaseRepository
{
    /**
     * ID로 사용자 조회
     * Read replica 사용
     */
    async findById(id: number)
    {
        const result = await this.readDb
            .select()
            .from(users)
            .where(eq(users.id, id))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * ID로 사용자 조회 — Write primary에서 직접 읽는다.
     *
     * 복제 지연 창에서 status 전이(예: 삭제 요청으로 pending_deletion 전환)를 놓치면
     * 안 되는 게이트(OAuth 세션 발급 등)가 사용한다. 일반 조회는 `findById`(replica)를
     * 계속 사용할 것.
     */
    async findByIdOnPrimary(id: number)
    {
        const result = await this.db
            .select()
            .from(users)
            .where(eq(users.id, id))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Take a row lock on a user, so callers that read-then-decide serialise.
     *
     * `SELECT id ... FOR UPDATE` and nothing else: the value is never used, the
     * lock is. A caller that counts an account's remaining credentials and then
     * removes one has a read-modify-write between two statements, and two such
     * callers racing both read the pre-removal count. Locking the owner row
     * first makes the second one wait for the first to commit, so it counts
     * what is actually left.
     *
     * Only meaningful inside a transaction — the lock is released at commit.
     * Write primary.
     */
    async lockById(id: number): Promise<void>
    {
        await this.db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, id))
            .for('update');
    }

    /**
     * 이메일로 사용자 조회
     * Read replica 사용
     */
    async findByEmail(email: string)
    {
        const result = await this.readDb
            .select()
            .from(users)
            .where(eq(users.email, normalizeEmail(email)))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * 이메일로 사용자 조회 — 저장된 형태와 무관하게 찾는다.
     *
     * `findByEmail` asks whether a row holds this exact address; this asks
     * whether any row *is* this address, whatever form it was written in. The
     * difference matters to a caller that answers "no" by creating an account:
     * a lookup that misses a row stored in another form would make a second
     * account for a person who already has one, and the unique constraint
     * cannot object because the two stored strings differ.
     *
     * Folding in the predicate means no index on `email` applies, so this is for
     * the few addresses a caller decides about — admin seeding — not for a
     * request path. Write primary: the answer decides whether to insert.
     */
    async findByEmailInAnyStoredForm(email: string)
    {
        const result = await this.db
            .select()
            .from(users)
            .where(sql`lower(btrim(${users.email})) = ${normalizeEmail(email)}`)
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * 전화번호로 사용자 조회
     * Read replica 사용
     */
    async findByPhone(phone: string)
    {
        const result = await this.readDb
            .select()
            .from(users)
            .where(eq(users.phone, phone))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * 사용자명으로 사용자 조회
     * Read replica 사용
     */
    async findByUsername(username: string)
    {
        const result = await this.readDb
            .select()
            .from(users)
            .where(eq(users.username, username))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Public ID(UUID)로 사용자 조회
     * Read replica 사용
     */
    async findByPublicId(publicId: string)
    {
        const result = await this.readDb
            .select()
            .from(users)
            .where(eq(users.publicId, publicId))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * 이메일 또는 전화번호로 사용자 조회
     * Read replica 사용
     */
    async findByEmailOrPhone(email?: string, phone?: string)
    {
        if (email)
        {
            return this.findByEmail(email);
        }
        else if (phone)
        {
            return this.findByPhone(phone);
        }

        return null;
    }

    /**
     * ID로 사용자 + Role 조회 (leftJoin)
     * Read replica 사용
     *
     * roleId가 null인 유저는 role: null 반환
     */
    async findByIdWithRole(id: number)
    {
        const result = await this.readDb
            .select({
                user: users,
                roleName: roles.name,
                roleDisplayName: roles.displayName,
                rolePriority: roles.priority,
            })
            .from(users)
            .leftJoin(roles, eq(users.roleId, roles.id))
            .where(eq(users.id, id))
            .limit(1);

        const row = result[0];
        if (!row)
        {
            return null;
        }

        return {
            user: row.user,
            role: row.roleName
                ? { name: row.roleName, displayName: row.roleDisplayName!, priority: row.rolePriority! }
                : null,
        };
    }

    /**
     * 사용자 생성
     * Write primary 사용
     */
    async create(data: NewUser)
    {
        return await this._create(users, { ...data, email: normalizeOptionalEmail(data.email) });
    }

    /**
     * User ids grouped by an address two or more rows share once folded.
     *
     * The whole comparison happens in the database and only the colliding groups
     * come back, so the size of the answer is the size of the problem rather
     * than the size of the table. `users.email` is unique, so a group of more
     * than one can only be rows that differ by capitalization or padding —
     * exactly the ones a rewrite cannot decide between.
     *
     * Every member id is returned, including a row already holding the
     * canonical form, because the operator has to compare the accounts against
     * each other to settle which is real.
     *
     * Write primary: the caller is about to rewrite rows and a replica could
     * still be showing the pre-fix state.
     */
    async findEmailConflictGroups(): Promise<number[][]>
    {
        const rows = await this.db
            .select({ ids: sql<number[]>`array_agg(${users.id} ORDER BY ${users.id})` })
            .from(users)
            .where(sql`${users.email} IS NOT NULL`)
            .groupBy(sql`lower(btrim(${users.email}))`)
            .having(sql`count(*) > 1`);

        return rows.map(row => row.ids.map(Number));
    }

    /**
     * Fold every stored address to canonical form, leaving the given ids alone.
     *
     * One statement rather than a row at a time: the rewrite is the same
     * expression the detection uses, so the database can do it in place. A
     * legacy install with a large users table therefore pays one update instead
     * of a round trip per row on the boot path, and no list of addresses is ever
     * carried through the application.
     *
     * The excluded ids travel as a single array parameter, so the count of
     * conflicts cannot run into the protocol's limit on bind parameters.
     *
     * One statement also means all or nothing. `users.email` is unique, so if an
     * instance still running the old code registers a canonical address in the
     * moment between the conflict query and this update, the update aborts and
     * nothing is folded on this boot. The next boot sees that pair as a conflict
     * and folds everything else, so the repair is deferred rather than lost.
     *
     * `lower(btrim(...))` is the SQL spelling of `normalizeEmail`. The two agree
     * on every address this package's validation accepts (ASCII, no interior
     * whitespace); an address outside that set — reachable only by an app
     * writing to the repository directly — may fold differently in a database
     * whose collation lower-cases non-ASCII letters.
     *
     * @param excludedIds - Rows to leave untouched, normally the conflict groups
     * @returns How many rows were rewritten
     */
    async normalizeEmailsExcept(excludedIds: number[]): Promise<number>
    {
        // `bigint[]`, matching the bigserial primary key. Cast to `int[]` this
        // fails outright once an install's id sequence passes 2^31 — which a
        // sequence reaches on rolled-back inserts too, not only on live rows.
        const keepConflicts = excludedIds.length > 0
            ? sql` AND NOT (${users.id} = ANY(string_to_array(${excludedIds.join(',')}, ',')::bigint[]))`
            : sql``;
        const pending = sql`${users.email} IS NOT NULL AND ${users.email} <> lower(btrim(${users.email}))${keepConflicts}`;

        // Counted rather than returned. `RETURNING` would hand back one row per
        // rewritten address, which is the transfer this method exists to avoid.
        const [counted] = await this.db
            .select({ rows: sql<number>`count(*)` })
            .from(users)
            .where(pending);

        await this.db
            .update(users)
            .set({ email: sql`lower(btrim(${users.email}))` })
            .where(pending);

        return Number(counted?.rows ?? 0);
    }

    /**
     * 사용자 정보 업데이트
     * Write primary 사용
     */
    async updateById(id: number, data: Partial<NewUser>)
    {
        // `'email' in data` rather than a truthiness check: setting it to null
        // (unlinking an address) is a real update and must not be dropped.
        const patch = 'email' in data
            ? { ...data, email: normalizeOptionalEmail(data.email) }
            : data;

        const result = await this.db
            .update(users)
            .set(patch)
            .where(eq(users.id, id))
            .returning();

        return result[0] ?? null;
    }

    /**
     * 계정 삭제 취소(복구) — `WHERE status = 'pending_deletion'` 조건부 UPDATE.
     *
     * cancelAccountDeletionService가 account_deletion_requests claim(조건부
     * markCancelled)에 성공한 **이후에만** 호출한다. 그 claim이 이미 purge와의
     * 경합을 해결하므로 이 조건은 방어적 이중 안전장치 — 0 row 매치(= 이미
     * status가 바뀐 상태) 시 null을 반환하며 예외를 던지지 않는다.
     * Write primary 사용
     */
    async reactivateFromPendingDeletion(id: number)
    {
        const result = await this.db
            .update(users)
            .set({ status: 'active' })
            .where(
                and(
                    eq(users.id, id),
                    eq(users.status, 'pending_deletion'),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * 비밀번호 업데이트
     * Write primary 사용
     */
    async updatePassword(
        id: number,
        passwordHash: string,
        clearPasswordChangeRequired: boolean = true,
    ) 
    {
        const updateData: Partial<NewUser> = {
            passwordHash,
        };

        if (clearPasswordChangeRequired)
        {
            updateData.passwordChangeRequired = false;
        }

        const result = await this.db
            .update(users)
            .set(updateData)
            .where(eq(users.id, id))
            .returning();

        return result[0] ?? null;
    }

    /**
     * 마지막 로그인 시간 업데이트
     * Write primary 사용
     */
    async updateLastLogin(id: number)
    {
        const result = await this.db
            .update(users)
            .set({
                lastLoginAt: new Date(),
            })
            .where(eq(users.id, id))
            .returning();

        return result[0] ?? null;
    }

    /**
     * 사용자 삭제
     * Write primary 사용
     */
    async deleteById(id: number)
    {
        const result = await this.db
            .delete(users)
            .where(eq(users.id, id))
            .returning();

        return result[0] ?? null;
    }

    /**
     * User의 Role과 Permissions 조회 (JOIN)
     * Read replica 사용
     *
     * @param userId - User ID
     * @returns Role 정보와 permissions 배열
     */
    async fetchUserRoleAndPermissions(userId: number)
    {
        // 1. Get user's role
        const userWithRole = await this.readDb
            .select({
                roleId: roles.id,
                roleName: roles.name,
                roleDisplayName: roles.displayName,
                rolePriority: roles.priority,
            })
            .from(users)
            .innerJoin(roles, eq(users.roleId, roles.id))
            .where(eq(users.id, userId))
            .limit(1)
            .then(rows => rows[0] ?? null);

        if (!userWithRole)
        {
            throw new NotFoundError({ message: '[@spfn/auth] User or role not found' });
        }

        // 2. Get role permissions
        const rolePerms = await this.readDb
            .select({
                id: permissions.id,
                name: permissions.name,
                displayName: permissions.displayName,
                category: permissions.category,
            })
            .from(rolePermissions)
            .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
            .where(
                and(
                    eq(rolePermissions.roleId, userWithRole.roleId),
                    eq(permissions.isActive, true),
                ),
            );

        return {
            role: {
                id: userWithRole.roleId,
                name: userWithRole.roleName,
                displayName: userWithRole.roleDisplayName,
                priority: userWithRole.rolePriority,
            },
            permissions: rolePerms.map(perm => ({
                id: perm.id,
                name: perm.name,
                displayName: perm.displayName,
                category: perm.category ?? undefined,
            })),
        };
    }

    /**
     * Minimal user data 조회 (auth session용)
     * Read replica 사용
     *
     * @param userId - User ID
     * @returns Minimal user data
     */
    async fetchMinimalUserData(userId: number)
    {
        const user = await this.readDb
            .select({
                id: users.id,
                publicId: users.publicId,
                email: users.email,
                username: users.username,
                emailVerifiedAt: users.emailVerifiedAt,
                phoneVerifiedAt: users.phoneVerifiedAt,
                passwordHash: users.passwordHash,
            })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
            .then(rows => rows[0] ?? null);

        if (!user)
        {
            throw new NotFoundError({ message: '[@spfn/auth] User not found' });
        }

        return {
            userId: user.id,
            publicId: user.publicId,
            email: user.email,
            username: user.username,
            isEmailVerified: !!user.emailVerifiedAt,
            isPhoneVerified: !!user.phoneVerifiedAt,
            hasPassword: !!user.passwordHash,
        };
    }

    /**
     * Full user data 조회 (user profile용)
     * Read replica 사용
     *
     * @param userId - User ID
     * @returns Full user data
     */
    async fetchFullUserData(userId: number)
    {
        const user = await this.readDb
            .select({
                id: users.id,
                publicId: users.publicId,
                email: users.email,
                username: users.username,
                emailVerifiedAt: users.emailVerifiedAt,
                phoneVerifiedAt: users.phoneVerifiedAt,
                lastLoginAt: users.lastLoginAt,
                createdAt: users.createdAt,
                updatedAt: users.updatedAt,
            })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)
            .then(rows => rows[0] ?? null);

        if (!user)
        {
            throw new EntityNotFoundError({ resource: 'users', id: userId });
        }

        return {
            userId: user.id,
            publicId: user.publicId,
            email: user.email,
            username: user.username,
            isEmailVerified: !!user.emailVerifiedAt,
            isPhoneVerified: !!user.phoneVerifiedAt,
            lastLoginAt: user.lastLoginAt,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
        };
    }
}

// Default instance export
export const usersRepository = new UsersRepository();
