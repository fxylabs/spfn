/**
 * Users Repository
 *
 * 사용자 데이터 관리를 위한 Repository
 * BaseRepository를 상속받아 자동 트랜잭션 컨텍스트 지원 및 Read/Write 분리
 */

import { eq, and, inArray, isNull, notExists, sql, type EmptyRelations } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { RepositoryDatabase } from '@spfn/core/db';
import { EntityNotFoundError, NotFoundError } from '@spfn/core/errors';

import { rolePermissions, roles, NewUser, users, permissions, type User } from '../entities';
import { userPublicKeys, type UserPublicKey } from '../entities/user-public-keys';
import { oauth2Grants, type OAuth2Grant } from '../entities/oauth2-grants';
import type { UserStatus } from '../types';
import { normalizeEmail, normalizeOptionalEmail } from '../helpers/email';
import { AccountBusyError } from '@spfn/auth/errors';
import { isLockTimeout } from '../lib/lock-timeout';
import { recordAccountLock } from './account-lock';
import { AccountStateRepository, type AccountWrites } from './account-state.repository';

/**
 * How long a request waits for an account's lock before it answers
 * `AccountBusyError`. Every holder writes a handful of rows and runs no network
 * call and no password hash under it, so a wait this long means something is
 * wrong with the holder, not that the queue is long.
 */
export const ACCOUNT_LOCK_TIMEOUT_MS = 5_000;

/**
 * Rows one statement of the boot email backfill folds (`normalizeEmailsExcept`):
 * the most account rows a `lockAccount` can find held by it at once.
 */
export const EMAIL_NORMALIZATION_BATCH = 500;

/** Either handle a repository method reads through: `this.db` or `this.readDb`. */
type Database = RepositoryDatabase<PostgresJsDatabase<EmptyRelations>>;

/**
 * What `updateById` may change: every column but `status`.
 *
 * An account's status is written by `setAccountStatus` alone, because a status
 * that forbids access has to end the account's sessions in the same
 * transaction — a column write here would change the status and clear nothing.
 */
export type UserUpdate = Omit<Partial<NewUser>, 'status'>;

/** A user row with the role that row stores, as the admission reads load it. */
export interface UserWithStoredRole
{
    user: User;
    role: { id: number; name: string; displayName: string; priority: number } | null;
}

/** The role columns every user-with-role read selects beside the user row. */
const ROLE_COLUMNS = {
    roleId: roles.id,
    roleName: roles.name,
    roleDisplayName: roles.displayName,
    rolePriority: roles.priority,
};

type RoleColumns = { roleId: number | null; roleName: string | null; roleDisplayName: string | null; rolePriority: number | null };

/** The stored role of a user-with-role row, or null for an account that holds none. */
function storedRole(row: RoleColumns): UserWithStoredRole['role']
{
    return row.roleName
        ? { id: row.roleId!, name: row.roleName, displayName: row.roleDisplayName!, priority: row.rolePriority! }
        : null;
}

/**
 * What a case-insensitive email lookup found.
 *
 * - `none`: no row holds the address in any case
 * - `account`: one account is the address — the row stored in canonical form
 *   when there is one, else the only row that folds onto it
 * - `ambiguous`: two or more rows fold onto the address and none is stored in
 *   canonical form, so no one of them can be chosen as its owner
 */
export type FoldedEmailMatch =
    | { kind: 'none' }
    | { kind: 'account'; user: User }
    | { kind: 'ambiguous' };

/**
 * `users.email` folded, compared with an address already normalised.
 *
 * Written exactly as the expression `users_email_folded_idx` is built on, so
 * the planner can use that index; `lower(email)` alone would not match it.
 * `lower(btrim(...))` is the SQL spelling of `normalizeEmail`.
 */
function foldedEmailEquals(normalizedEmail: string, email: AnyPgColumn = users.email)
{
    return sql`lower(btrim(${email})) = ${normalizedEmail}`;
}

/**
 * Users Repository 클래스
 *
 * BaseRepository를 상속받아 다음 기능을 제공:
 * - 자동 트랜잭션 컨텍스트 감지 및 사용
 * - Read/Write 연결 분리 (replica 활용)
 * - 타입 안전성
 */
export class UsersRepository extends AccountStateRepository
{
    static override readonly accountWrites: AccountWrites<UsersRepository> = {
        lockAccount: { exempt: 'the lock statement itself, and the transaction-local lock_timeout set around it' },
        create: { exempt: 'a new account: no other transaction can name its row before this one commits' },
        normalizeEmailsExcept: { exempt: 'the boot backfill of email casing (normalizeStoredEmails), which under a rolling deploy runs while other instances serve: it writes no status, key generation or password, and folds in batches of EMAIL_NORMALIZATION_BATCH rows, one short statement each, so a lockAccount waits behind one batch at most rather than a table-wide rewrite' },
        fillEmailIfUnheld: { account: id => id },
        updateById: { account: id => id },
        updatePassword: { account: id => id },
        updateLastLogin: { account: id => id },
        deleteById: { account: id => id },
    };

    /**
     * Lock the account: the mutex for its credential state. Write primary.
     *
     * **The invariant.** A transaction that writes any of an account's
     * credential state — a key row (insert, activate, revoke, re-authenticate,
     * rotate, bind), a challenge that activates a key, the status, the key
     * generation, the password with the revocation it brings — calls this as
     * its first statement touching that account: before any read it will act
     * on and before any child row. Every such writer then queues on this one
     * row, so the order in which each touches the child rows afterwards cannot
     * deadlock against another. Gating state (status, generation, an existing
     * link) is read after the lock — this read, or another on the primary —
     * never before it. No network call and no password hash runs while it is
     * held. `authenticate` takes no lock.
     *
     * `FOR NO KEY UPDATE`: two lockers of one account serialise, and a child
     * row's foreign key (`FOR KEY SHARE`) is not blocked. A `FOR SHARE` would
     * deadlock two sign-ins of one account, each later updating the row it
     * shares (`lastLoginAt`).
     *
     * **The wait is bounded.** The lock statement runs under a transaction-local
     * `lock_timeout` of `ACCOUNT_LOCK_TIMEOUT_MS`, restored to what it was once
     * the lock is held; a wait that runs out answers `AccountBusyError` — a
     * typed, retryable refusal — rather than meeting `statement_timeout` as a
     * connection error.
     *
     * **One account per transaction.** The lock is recorded on the transaction,
     * and a second account's lock in it throws `SecondAccountLockError` before
     * its statement runs — in every run, not only under test. Under test every
     * write of an `AccountStateRepository` also refuses to run without the
     * lock (`assertAccountLocked`).
     *
     * @returns the account as of the lock, or null when no such account exists
     */
    async lockAccount(id: number): Promise<User | null>
    {
        recordAccountLock(id);

        const [setting] = await this.db.execute<{ previous: string }>(
            sql`select current_setting('lock_timeout') as previous, set_config('lock_timeout', ${String(ACCOUNT_LOCK_TIMEOUT_MS)}, true)`,
        );
        const result = await this.db
            .select()
            .from(users)
            .where(eq(users.id, id))
            .for('no key update')
            .catch((error: unknown) => Promise.reject(isLockTimeout(error) ? new AccountBusyError() : error));

        await this.db.execute(sql`select set_config('lock_timeout', ${setting!.previous}, true)`);

        return result[0] ?? null;
    }

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
     * The predicate is served by `users_email_folded_idx`. Admin seeding keeps
     * this method rather than `findByFoldedEmail` because it reads the write
     * primary — the answer decides whether to insert — and takes any one row:
     * a seeded admin whose address is held by several case variants is skipped
     * either way.
     */
    async findByEmailInAnyStoredForm(email: string)
    {
        const result = await this.db
            .select()
            .from(users)
            .where(foldedEmailEquals(normalizeEmail(email)))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Which account an address belongs to, whatever case it is stored in.
     *
     * For the checks that answer "no account" by creating one or letting a
     * signup proceed: `findByEmail` misses a row the boot backfill left in
     * another case, and the caller would make a second account for a person
     * who already has one. Callers that act *as* an account (login, password
     * reset) keep the exact lookup.
     *
     * A row stored in canonical form wins over its case variants, as the exact
     * lookup always chose it; without one, a single variant is the account and
     * two or more are `ambiguous`. One query: canonical row first, then by id,
     * and two rows are enough to tell the cases apart.
     *
     * Read replica, like `findByEmail` — inside a transaction, the transaction.
     */
    async findByFoldedEmail(email: string): Promise<FoldedEmailMatch>
    {
        const normalizedEmail = normalizeEmail(email);
        const [first, second] = await this.readDb
            .select()
            .from(users)
            .where(foldedEmailEquals(normalizedEmail))
            .orderBy(sql`(${users.email} = ${normalizedEmail}) DESC`, users.id)
            .limit(2);

        if (!first)
        {
            return { kind: 'none' };
        }

        return !second || first.email === normalizedEmail
            ? { kind: 'account', user: first }
            : { kind: 'ambiguous' };
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
     * roleId가 null인 유저는 role: null 반환.
     * 요청의 admission을 판정하는 호출자는 `findByIdWithRoleOnPrimary`를 쓸 것.
     */
    async findByIdWithRole(id: number)
    {
        return this.selectByIdWithRole(this.readDb, id);
    }

    /**
     * ID로 사용자 + Role 조회 (leftJoin) — Write primary에서 직접 읽는다.
     *
     * 복제 지연 창에서 status 전이(예: 정지)를 놓치면 안 되는 admission 게이트
     * (clientProofV1, authenticate, optionalAuth)가 사용한다. 일반 조회는
     * `findByIdWithRole`(replica)를 계속 사용할 것.
     */
    async findByIdWithRoleOnPrimary(id: number)
    {
        return this.selectByIdWithRole(this.db, id);
    }

    private async selectByIdWithRole(db: Database, id: number): Promise<UserWithStoredRole | null>
    {
        const result = await db
            .select({ user: users, ...ROLE_COLUMNS })
            .from(users)
            .leftJoin(roles, eq(users.roleId, roles.id))
            .where(eq(users.id, id))
            .limit(1);

        const row = result[0];

        return row ? { user: row.user, role: storedRole(row) } : null;
    }

    /**
     * A user, the role it stores, and one of its device keys — on the primary,
     * in one statement.
     *
     * The admission read for a key credential: the account's status, its role
     * and the key's liveness are decided on one snapshot, and `authenticate`
     * pays for the key no query beyond the user read it always made. The key
     * is joined by owner as well as id, so a key of another account reads as
     * absent. `key` is null when the account holds no such key.
     */
    async findByIdWithRoleAndKeyOnPrimary(id: number, keyId: string): Promise<(UserWithStoredRole & { key: UserPublicKey | null }) | null>
    {
        const result = await this.db
            .select({ user: users, ...ROLE_COLUMNS, key: userPublicKeys })
            .from(users)
            .leftJoin(roles, eq(users.roleId, roles.id))
            .leftJoin(userPublicKeys, and(eq(userPublicKeys.userId, users.id), eq(userPublicKeys.keyId, keyId)))
            .where(eq(users.id, id))
            .limit(1);

        const row = result[0];

        return row ? { user: row.user, role: storedRole(row), key: row.key } : null;
    }

    /**
     * A user, the role it stores, and one of its OAuth 2.1 grants — on the
     * primary, in one statement. The grant is joined by owner as well as id;
     * `grant` is null when the account holds no such grant.
     */
    async findByIdWithRoleAndGrantOnPrimary(id: number, grantId: number): Promise<(UserWithStoredRole & { grant: OAuth2Grant | null }) | null>
    {
        const result = await this.db
            .select({ user: users, ...ROLE_COLUMNS, grant: oauth2Grants })
            .from(users)
            .leftJoin(roles, eq(users.roleId, roles.id))
            .leftJoin(oauth2Grants, and(eq(oauth2Grants.user, users.id), eq(oauth2Grants.id, grantId)))
            .where(eq(users.id, id))
            .limit(1);

        const row = result[0];

        return row ? { user: row.user, role: storedRole(row), grant: row.grant } : null;
    }

    /**
     * 주어진 역할을 저장한 사용자 목록 (email-domain policy 점검용)
     * Read replica 사용
     *
     * The two columns the policy reads and the stored role name — nothing else,
     * so a report built on it has no address to leak beyond the rule itself.
     *
     * @param roleNames - Stored role names to match
     * @param status - Only accounts in this status; every status when omitted
     */
    async findRoleHolders(roleNames: string[], status?: UserStatus)
    {
        return this.readDb
            .select({
                id: users.id,
                email: users.email,
                emailVerifiedAt: users.emailVerifiedAt,
                roleName: roles.name,
            })
            .from(users)
            .innerJoin(roles, eq(users.roleId, roles.id))
            .where(and(
                inArray(roles.name, roleNames),
                status ? eq(users.status, status) : undefined,
            ));
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
     * In the database rather than a row at a time through the application: the
     * rewrite is the same expression the detection uses, and no list of
     * addresses is ever carried through the application.
     *
     * In batches of `batchSize` rows, each its own statement. Under a rolling
     * deploy this runs while other instances serve, and an UPDATE holds the
     * row lock of every row it rewrites until it ends: one statement over a
     * legacy table would hold every pending account's row at once, and each
     * `lockAccount` behind it would wait out `ACCOUNT_LOCK_TIMEOUT_MS` and
     * answer `AccountBusyError`. A batch is short, so a lock waits behind one
     * batch at most.
     *
     * The excluded ids travel as a single array parameter, so the count of
     * conflicts cannot run into the protocol's limit on bind parameters.
     *
     * `users.email` is unique, so if an instance still running the old code
     * registers a canonical address in the moment between the conflict query
     * and a batch, that batch aborts and the error ends the run; the batches
     * before it stay folded. The next boot sees that pair as a conflict and
     * folds everything else, so the repair is deferred rather than lost.
     *
     * `lower(btrim(...))` is the SQL spelling of `normalizeEmail`. The two agree
     * on every address this package's validation accepts (ASCII, no interior
     * whitespace); an address outside that set — reachable only by an app
     * writing to the repository directly — may fold differently in a database
     * whose collation lower-cases non-ASCII letters.
     *
     * @param excludedIds - Rows to leave untouched, normally the conflict groups
     * @param batchSize - Rows one statement folds
     * @returns How many rows were rewritten
     */
    async normalizeEmailsExcept(excludedIds: number[], batchSize: number = EMAIL_NORMALIZATION_BATCH): Promise<number>
    {
        // `bigint[]`, matching the bigserial primary key. Cast to `int[]` this
        // fails outright once an install's id sequence passes 2^31 — which a
        // sequence reaches on rolled-back inserts too, not only on live rows.
        const keepConflicts = excludedIds.length > 0
            ? sql` AND NOT (${users.id} = ANY(string_to_array(${excludedIds.join(',')}, ',')::bigint[]))`
            : sql``;
        const pending = sql`${users.email} IS NOT NULL AND ${users.email} <> lower(btrim(${users.email}))${keepConflicts}`;
        let total = 0;

        for (;;)
        {
            const batch = this.db.select({ id: users.id }).from(users).where(pending).orderBy(users.id).limit(batchSize);
            const folded = await this.db
                .update(users)
                .set({ email: sql`lower(btrim(${users.email}))` })
                .where(inArray(users.id, batch))
                .returning({ id: users.id });

            total += folded.length;

            if (folded.length < batchSize)
            {
                return total;
            }
        }
    }

    /**
     * Give an account without an email a verified one — only if no account
     * holds that address in any stored form.
     *
     * One statement, so the rule is the statement: the row is written when the
     * account has no email and no committed row folds onto the address, and
     * otherwise nothing is. `false` means there was nothing to fill, not a
     * failure. A holder still uncommitted is invisible to the check: the UPDATE
     * waits for it and, once it commits, raises the unique violation on
     * `users_email_unique`. The sign-in that called it runs again
     * (`retryContendedSignIn`), and this statement then sees the holder and
     * fills nothing.
     * Write primary.
     */
    async fillEmailIfUnheld(id: number, email: string): Promise<boolean>
    {
        const normalizedEmail = normalizeEmail(email);
        const holder = alias(users, 'holder');
        const filled = await this.db
            .update(users)
            .set({ email: normalizedEmail, emailVerifiedAt: new Date() })
            .where(and(
                eq(users.id, id),
                isNull(users.email),
                notExists(this.db.select({ id: holder.id }).from(holder).where(foldedEmailEquals(normalizedEmail, holder.email))),
            ))
            .returning({ id: users.id });

        return filled.length > 0;
    }

    /**
     * 사용자 정보 업데이트
     * Write primary 사용
     */
    async updateById(id: number, data: UserUpdate)
    {
        // The type already leaves `status` out; this is for the caller the type
        // does not reach (JavaScript, a cast). Writing it here would change the
        // status and clear nothing, which is the defect `setAccountStatus` ends.
        if ((data as Partial<NewUser>).status !== undefined)
        {
            throw new Error('users.status is written by setAccountStatus, not updateById');
        }

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
     * 역할의 활성 permissions 조회 (JOIN)
     * Read replica 사용
     *
     * Takes the role rather than the user: the caller resolves which role
     * applies — the stored one, or the `user` role when the email-domain policy
     * refuses the stored one — and this reads that role's permissions.
     *
     * @param roleId - Role ID
     * @returns Active permissions of the role
     */
    async fetchActiveRolePermissions(roleId: number)
    {
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
                    eq(rolePermissions.roleId, roleId),
                    eq(permissions.isActive, true),
                ),
            );

        return rolePerms.map(perm => ({
            id: perm.id,
            name: perm.name,
            displayName: perm.displayName,
            category: perm.category ?? undefined,
        }));
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
