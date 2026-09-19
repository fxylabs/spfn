/**
 * User Public Keys Repository
 *
 * 사용자 공개키 관리를 위한 Repository
 * BaseRepository를 상속받아 자동 트랜잭션 컨텍스트 지원 및 Read/Write 분리
 */

import { NewUserPublicKey, userPublicKeys } from '../entities/user-public-keys';
import { users } from '../entities/users';
import { mfaChallenges } from '../entities/mfa-challenges';
import type { ClientIdentity } from '../client-proof/wire-version';
import { BaseRepository } from '@spfn/core/db';
import { eq, and, or, isNull, lt, desc, sql } from 'drizzle-orm';
import { getConcurrentUseWindowMs } from '../lib/config';

/**
 * Throttle window for lastUsedAt writes. The column is for audit / inactive-key
 * detection, so minute granularity is plenty; this avoids a write (and hot-row
 * lock / MVCC bloat) on every authenticated request.
 */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * What a global revocation answers with.
 *
 * The key id and nothing else: every caller counts the rows or names them, and
 * the statement that produces them revokes keys and moves the account's key
 * generation at once, which a typed Drizzle update cannot express.
 */
export interface RevokedKey
{
    keyId: string;
}

/**
 * User Public Keys Repository 클래스
 *
 * BaseRepository를 상속받아 다음 기능을 제공:
 * - 자동 트랜잭션 컨텍스트 감지 및 사용
 * - Read/Write 연결 분리 (replica 활용)
 * - 타입 안전성
 */
export class KeysRepository extends BaseRepository
{
    /**
     * Key ID와 User ID로 공개키 조회
     * Read replica 사용
     */
    async findByKeyIdAndUserId(keyId: string, userId: number)
    {
        const result = await this.readDb
            .select()
            .from(userPublicKeys)
            .where(
                and(
                    eq(userPublicKeys.keyId, keyId),
                    eq(userPublicKeys.userId, userId),
                ),
            )
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * User ID로 모든 공개키 조회
     * Read replica 사용
     */
    async findAllByUserId(userId: number)
    {
        return this.readDb
            .select()
            .from(userPublicKeys)
            .where(eq(userPublicKeys.userId, userId));
    }

    /**
     * User ID로 활성 공개키만 조회
     * Read replica 사용
     */
    async findActiveByUserId(userId: number)
    {
        return this.readDb
            .select()
            .from(userPublicKeys)
            .where(
                and(
                    eq(userPublicKeys.userId, userId),
                    eq(userPublicKeys.isActive, true),
                ),
            );
    }

    /**
     * 키 목록 화면이 쓰는 공개키 조회 — 최근 등록순
     *
     * publicKey 원문은 고르지 않는다. 목록의 용도는 기기를 알아보고 지목하는 것이고,
     * 공개키는 그 어느 쪽에도 필요 없다. fingerprint는 호출자가 잘라서 내보낸다.
     *
     * `includeRevoked`는 이미 끊은 기기까지 보여준다 — "내가 언제 무엇을 끊었나"를
     * 확인하는 용도라, 폐기 시각과 사유를 함께 고른다.
     *
     * `lastSeenIp` is not selected, deliberately. The concurrent-use moment is
     * what the owner acts on; the trail of addresses behind it is stored PII the
     * account surface has no use for.
     *
     * A key still waiting on a second factor is excluded in **both** modes
     * (#95). It is not a device that can sign, so it does not belong in the
     * default list; and it is not a device the owner signed out either, so it
     * does not belong in the revoked one — where it would read exactly like a
     * revoked key with no revocation time, which is a different thing entirely.
     * Read replica 사용
     */
    async listForUser(userId: number, includeRevoked = false)
    {
        return this.readDb
            .select({
                keyId: userPublicKeys.keyId,
                deviceName: userPublicKeys.deviceName,
                platform: userPublicKeys.platform,
                algorithm: userPublicKeys.algorithm,
                fingerprint: userPublicKeys.fingerprint,
                isActive: userPublicKeys.isActive,
                createdAt: userPublicKeys.createdAt,
                lastUsedAt: userPublicKeys.lastUsedAt,
                expiresAt: userPublicKeys.expiresAt,
                revokedAt: userPublicKeys.revokedAt,
                registeredIp: userPublicKeys.registeredIp,
                registeredUserAgent: userPublicKeys.registeredUserAgent,
                binding: userPublicKeys.binding,
                concurrentUseAt: userPublicKeys.concurrentUseAt,
            })
            .from(userPublicKeys)
            .where(and(
                eq(userPublicKeys.userId, userId),
                isNull(userPublicKeys.pendingMfaChallengeId),
                includeRevoked ? undefined : eq(userPublicKeys.isActive, true),
            ))
            .orderBy(desc(userPublicKeys.createdAt));
    }

    /**
     * 공개키 생성
     * Write primary 사용
     */
    async create(data: NewUserPublicKey)
    {
        return await this._create(userPublicKeys, {
            ...data,
            createdAt: data.createdAt || new Date(),
        });
    }

    /**
     * 공개키 revoke (비활성화) — 아직 살아 있는 키만
     *
     * `isActive`가 조건에 있어야 반환값이 "이 호출이 무언가를 폐기했는가"를 뜻한다.
     * 없으면 이미 폐기된 키를 다시 지목해도 행이 하나 돌아와, 호출자는 폐기가
     * 일어났다고 읽는다. 로그인 경로가 그 값으로 "기기 교체인가 새 기기인가"를
     * 가르므로, 죽은 키를 들이밀어 새 기기 알림을 끄는 길이 된다.
     * 폐기 시각·사유도 덮어쓰지 않는다 — 처음 끊긴 순간이 답이다.
     * Write primary 사용
     */
    async revokeByKeyIdAndUserId(
        keyId: string,
        userId: number,
        reason: string,
    )
    {
        const result = await this.db
            .update(userPublicKeys)
            .set({
                isActive: false,
                revokedAt: new Date(),
                revokedReason: reason,
            })
            .where(
                and(
                    eq(userPublicKeys.keyId, keyId),
                    eq(userPublicKeys.userId, userId),
                    eq(userPublicKeys.isActive, true),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * 사용자의 모든 활성 공개키 revoke (비활성화) — 그리고 같은 문장에서 key_epoch +1
     *
     * 비번 변경 시 전체 세션 로그아웃에 사용. authenticate는 활성 키만 검증하므로,
     * revoke된 키로 서명한 기존 세션의 요청은 즉시 401이 된다.
     * Write primary 사용
     */
    async revokeAllActiveByUserId(userId: number, reason: string): Promise<RevokedKey[]>
    {
        return await this.revokeActive(userId, reason);
    }

    /**
     * 지정한 키 하나만 남기고 사용자의 활성 공개키를 전부 revoke — key_epoch도 +1
     *
     * "다른 기기 전부 로그아웃" — 요청을 보낸 기기는 살려 둔다. 남길 키를 별도 조회로
     * 확인하지 않고 조건에 담아, 그 사이에 다른 요청이 키를 바꾸는 경쟁을 만들지 않는다.
     *
     * 한 기기를 남기더라도 epoch는 오른다. 미소비 revoke-all 링크가 죽는 쪽이 보수적이고,
     * 사용자가 "나머지 전부 로그아웃"을 이미 눌렀다면 메일함의 링크는 목적을 다했다.
     * Write primary 사용
     */
    async revokeAllActiveByUserIdExcept(
        userId: number,
        keepKeyId: string,
        reason: string,
    ): Promise<RevokedKey[]>
    {
        return await this.revokeActive(userId, reason, keepKeyId);
    }

    /**
     * The one statement behind both global revocations.
     *
     * The epoch bump is a data-modifying CTE on the same statement rather than a
     * second call, so that no caller can revoke every key and forget to move the
     * counter — and three of the four callers are services that never see the
     * counter at all. It runs whether or not any key matched: an account with no
     * active keys still had its generation ended, and an outstanding
     * sign-out-everywhere link must die with it.
     *
     * The two second-factor CTEs are here for the same "no caller can forget"
     * reason (#95). A pending key is `is_active = false`, so the UPDATE below
     * does not touch it and neither would anything else: the owner who sees an
     * unexpected second-factor prompt and does exactly what the notice says —
     * change the password, sign out everywhere, open the revoke-all link, run a
     * reset — would otherwise leave the attacker's pending key and its live
     * challenge untouched. Deleting the key cascades onto its challenge; the
     * expiry beside it catches a challenge whose key is already gone. A pending
     * row and an active row are disjoint sets, so the two statements never
     * contend for the same row.
     *
     * Write primary 사용
     */
    private async revokeActive(userId: number, reason: string, keepKeyId?: string): Promise<RevokedKey[]>
    {
        const spare = keepKeyId ? sql` AND t.key_id <> ${keepKeyId}` : sql``;

        const rows = await this.db.execute(sql`
            WITH epoch_bump AS (
                UPDATE ${users}
                SET key_epoch = key_epoch + 1
                WHERE id = ${userId}
            ),
            challenges_expired AS (
                UPDATE ${mfaChallenges}
                SET expires_at = now()
                WHERE user_id = ${userId}
                  AND verified_at IS NULL
                  AND expires_at > now()
            ),
            pending_dropped AS (
                DELETE FROM ${userPublicKeys}
                WHERE user_id = ${userId}
                  AND pending_mfa_challenge_id IS NOT NULL
            )
            UPDATE ${userPublicKeys} t
            SET is_active = false,
                revoked_at = now(),
                revoked_reason = ${reason}
            WHERE t.user_id = ${userId}
              AND t.is_active = true${spare}
            RETURNING t.key_id AS "keyId"
        `);

        return rows as unknown as RevokedKey[];
    }

    /**
     * 공개키 삭제
     * Write primary 사용
     */
    async deleteByKeyIdAndUserId(keyId: string, userId: number)
    {
        const result = await this.db
            .delete(userPublicKeys)
            .where(
                and(
                    eq(userPublicKeys.keyId, keyId),
                    eq(userPublicKeys.userId, userId),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * 사용자의 모든 공개키 삭제 (계정 익명화 파기용)
     *
     * hard-delete는 FK cascade로 자동 처리되지만, anonymize 모드는 users row를
     * 남기므로 자식 row를 직접 지워야 한다.
     * Write primary 사용
     */
    async deleteAllByUserId(userId: number): Promise<number>
    {
        const result = await this.db
            .delete(userPublicKeys)
            .where(eq(userPublicKeys.userId, userId))
            .returning();

        return result.length;
    }

    /**
     * 마지막 사용 시간 업데이트
     * Write primary 사용
     */
    async updateLastUsed(keyId: string, userId: number)
    {
        const result = await this.db
            .update(userPublicKeys)
            .set({
                lastUsedAt: new Date(),
            })
            .where(
                and(
                    eq(userPublicKeys.keyId, keyId),
                    eq(userPublicKeys.userId, userId),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * 만료 시각 연장 — 같은 사용자가 로그인으로 신원을 다시 증명했을 때 쓴다.
     * Write primary 사용
     */
    async extendExpiry(keyId: string, userId: number, expiresAt: Date)
    {
        const result = await this.db
            .update(userPublicKeys)
            .set({ expiresAt })
            .where(
                and(
                    eq(userPublicKeys.keyId, keyId),
                    eq(userPublicKeys.userId, userId),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * Bind one live key to the account's passkey, and give it the short life
     * that goes with it.
     *
     * Scoped by user and by `isActive`, like every other targeted update here, so
     * the answer is "this call bound something" rather than "a row exists".
     * Write primary 사용
     */
    async bindByKeyIdAndUserId(keyId: string, userId: number, expiresAt: Date)
    {
        const result = await this.db
            .update(userPublicKeys)
            .set({ binding: 'passkey', expiresAt })
            .where(
                and(
                    eq(userPublicKeys.keyId, keyId),
                    eq(userPublicKeys.userId, userId),
                    eq(userPublicKeys.isActive, true),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * Return every one of a user's bound keys to an ordinary long-lived key.
     *
     * One statement, because turning the setting off has to leave no key behind:
     * a row still marked `'passkey'` would keep expiring in hours with nothing
     * left to renew it, and its owner has just said they do not want that.
     * Write primary 사용
     */
    async unbindActiveByUserId(userId: number, expiresAt: Date): Promise<number>
    {
        const result = await this.db
            .update(userPublicKeys)
            .set({ binding: 'none', expiresAt })
            .where(
                and(
                    eq(userPublicKeys.userId, userId),
                    eq(userPublicKeys.isActive, true),
                    eq(userPublicKeys.binding, 'passkey'),
                ),
            )
            .returning();

        return result.length;
    }

    /**
     * Key ID로 공개키 조회 — 활성 여부 무관 (clientProofV1 admission의 revocation 판정용)
     *
     * 폐기(isActive=false)·만료(expiresAt 경과)를 SESSION_REVOKED로, 미등록을
     * PROOF_INVALID로 구분해야 하므로 활성 필터 없이 조회한다. keyId는 UNIQUE.
     * Read replica 사용
     */
    async findByKeyId(keyId: string)
    {
        const result = await this.readDb
            .select()
            .from(userPublicKeys)
            .where(eq(userPublicKeys.keyId, keyId))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Key ID로 활성 공개키 조회 (authenticate용)
     * Read replica 사용
     */
    async findActiveByKeyId(keyId: string)
    {
        const result = await this.readDb
            .select()
            .from(userPublicKeys)
            .where(
                and(
                    eq(userPublicKeys.keyId, keyId),
                    eq(userPublicKeys.isActive, true),
                ),
            )
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Primary key로 마지막 사용 시간 업데이트 (authenticate용)
     * Write primary 사용.
     *
     * Throttled: only writes when lastUsedAt is stale (older than
     * LAST_USED_THROTTLE_MS), so a busy key isn't UPDATEd on every request. The
     * throttle lives in the WHERE clause — atomic, no read-then-write race. No
     * RETURNING (callers fire-and-forget and discard the row).
     *
     * `identity` is what the client said about itself on this request. It is
     * recorded on the same row, and the throttle does not apply to it: a version
     * that changed is written immediately, because an app update is the event this
     * column exists to catch and waiting a minute to notice it serves nobody. A
     * version that did not change writes nothing extra — the UPDATE the throttle
     * was already going to do carries it.
     *
     * `clientSeenAt` moves only when one of the three values differs from what is
     * stored, so it answers "since when has this device been on this release"
     * rather than "when was it last seen", which lastUsedAt already answers.
     *
     * `ip` is the client address this request resolved to, or null when none did.
     * It joins this statement rather than getting one of its own: the rule the
     * concurrent-use signal needs — write the address, and move
     * `concurrentUseAt` when it differs from the stored one inside the window —
     * is the rule already implemented here, and a second fire-and-forget write
     * beside it would double the per-request write on the authenticated path. It
     * is also why the comparison is a `CASE` over the stored value rather than a
     * read followed by a write: the row comes off the read replica, and a
     * replica-lagged address compared in application code both misses real
     * switches and invents ones that did not happen.
     */
    async updateLastUsedById(
        id: number,
        identity?: ClientIdentity | null,
        ip?: string | null,
    ): Promise<void>
    {
        const now = new Date();
        // Sent as an ISO string with an explicit cast rather than as a Date: a
        // value bound inside a raw `sql` fragment skips the column's own mapper,
        // and postgres-js refuses a Date it was handed without one.
        const nowParam = sql`${now.toISOString()}::timestamptz`;
        const staleBefore = new Date(Date.now() - LAST_USED_THROTTLE_MS);
        const lastUsedIsStale = or(
            isNull(userPublicKeys.lastUsedAt),
            lt(userPublicKeys.lastUsedAt, staleBefore),
        );
        // IS DISTINCT FROM rather than <>: every one of these columns is nullable
        // for a key registered before they existed, and <> against NULL is NULL,
        // which would make the first sighting look unchanged and never record it.
        //
        // The `IS NOT NULL` on the incoming address is what keeps an unresolvable
        // one out of the comparison entirely. `getClientIp` answers 'unknown' when
        // nothing resolves and the caller turns that into null, so without this
        // term every such request would read as an address change — a write per
        // request on the hot path, and a concurrent-use signal raised by the
        // absence of a signal.
        const ipChanged = sql`(
            ${ip ?? null}::text IS NOT NULL
            AND ${userPublicKeys.lastSeenIp} IS DISTINCT FROM ${ip ?? null}::text
        )`;
        // One write per window for a client whose address keeps moving. Without
        // this the `ipChanged` term below is true on every request from a phone
        // flipping between cellular and wifi, or from anything behind a CGNAT
        // egress pool — an UPDATE per request on the hot authenticated path, and a
        // concurrent-use stamp restamped every time, so the owner's device list
        // shows a permanently-lit "two places at once" for a device that never
        // left their hand.
        const notStampedThisWindow = sql`(
            ${userPublicKeys.concurrentUseAt} IS NULL
            OR ${userPublicKeys.concurrentUseAt} < ${this.concurrentUseSince(now)}
        )`;
        const identityChanged = identity
            ? sql`(
                ${userPublicKeys.clientKind} IS DISTINCT FROM ${identity.kind}
                OR ${userPublicKeys.clientVersion} IS DISTINCT FROM ${identity.version}
                OR ${userPublicKeys.clientContractVersion} IS DISTINCT FROM ${identity.contractVersion}
            )`
            : sql`false`;

        await this.db
            .update(userPublicKeys)
            .set({
                lastUsedAt: now,
                lastSeenIp: ip ?? null,
                lastSeenAt: now,
                // `last_seen_ip IS NOT NULL` is the second observation this needs:
                // a request whose address did not resolve stores NULL and stamps
                // `last_seen_at`, so without it the next ordinary request would
                // read as an address change and raise the signal from one device
                // that never moved.
                concurrentUseAt: sql`CASE WHEN ${ipChanged}
                    AND ${userPublicKeys.lastSeenIp} IS NOT NULL
                    AND ${userPublicKeys.lastSeenAt} > ${this.concurrentUseSince(now)}
                    THEN ${nowParam} ELSE ${userPublicKeys.concurrentUseAt} END`,
                ...(identity
                    ? {
                        clientKind: identity.kind,
                        clientVersion: identity.version,
                        clientContractVersion: identity.contractVersion,
                        clientSeenAt: sql`CASE WHEN ${identityChanged} THEN ${nowParam} ELSE ${userPublicKeys.clientSeenAt} END`,
                    }
                    : {}),
            })
            .where(and(
                eq(userPublicKeys.id, id),
                or(lastUsedIsStale, identityChanged, sql`(${ipChanged} AND ${notStampedThisWindow})`),
            ));
    }

    /**
     * The boundary a previous sighting has to be newer than to count as concurrent.
     *
     * Computed here rather than written as `now() - interval` so that the moment
     * the row is stamped with and the moment the window is measured from are the
     * same one — a statement that used the database clock for the boundary and
     * ours for the value would disagree with itself by the round trip.
     */
    private concurrentUseSince(now: Date)
    {
        const since = new Date(now.getTime() - getConcurrentUseWindowMs());

        return sql`${since.toISOString()}::timestamptz`;
    }
}

// Default instance export
export const keysRepository = new KeysRepository();
