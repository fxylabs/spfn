/**
 * User Public Keys Repository
 *
 * 사용자 공개키 관리를 위한 Repository
 * BaseRepository를 상속받아 자동 트랜잭션 컨텍스트 지원 및 Read/Write 분리
 */

import { NewUserPublicKey, userPublicKeys } from '../entities/user-public-keys';
import type { ClientIdentity } from '../client-proof/wire-version';
import { BaseRepository } from '@spfn/core/db';
import { eq, and, or, isNull, lt, ne, desc, sql } from 'drizzle-orm';

/**
 * Throttle window for lastUsedAt writes. The column is for audit / inactive-key
 * detection, so minute granularity is plenty; this avoids a write (and hot-row
 * lock / MVCC bloat) on every authenticated request.
 */
const LAST_USED_THROTTLE_MS = 60_000;

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
            })
            .from(userPublicKeys)
            .where(
                includeRevoked
                    ? eq(userPublicKeys.userId, userId)
                    : and(
                        eq(userPublicKeys.userId, userId),
                        eq(userPublicKeys.isActive, true),
                    ),
            )
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
     * 공개키 revoke (비활성화)
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
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * 사용자의 모든 활성 공개키 revoke (비활성화)
     *
     * 비번 변경 시 전체 세션 로그아웃에 사용. authenticate는 활성 키만 검증하므로,
     * revoke된 키로 서명한 기존 세션의 요청은 즉시 401이 된다.
     * Write primary 사용
     */
    async revokeAllActiveByUserId(userId: number, reason: string)
    {
        return await this.db
            .update(userPublicKeys)
            .set({
                isActive: false,
                revokedAt: new Date(),
                revokedReason: reason,
            })
            .where(
                and(
                    eq(userPublicKeys.userId, userId),
                    eq(userPublicKeys.isActive, true),
                ),
            )
            .returning();
    }

    /**
     * 지정한 키 하나만 남기고 사용자의 활성 공개키를 전부 revoke
     *
     * "다른 기기 전부 로그아웃" — 요청을 보낸 기기는 살려 둔다. 남길 키를 별도 조회로
     * 확인하지 않고 조건에 담아, 그 사이에 다른 요청이 키를 바꾸는 경쟁을 만들지 않는다.
     * Write primary 사용
     */
    async revokeAllActiveByUserIdExcept(userId: number, keepKeyId: string, reason: string)
    {
        return await this.db
            .update(userPublicKeys)
            .set({
                isActive: false,
                revokedAt: new Date(),
                revokedReason: reason,
            })
            .where(
                and(
                    eq(userPublicKeys.userId, userId),
                    eq(userPublicKeys.isActive, true),
                    ne(userPublicKeys.keyId, keepKeyId),
                ),
            )
            .returning();
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
     */
    async updateLastUsedById(id: number, identity?: ClientIdentity | null): Promise<void>
    {
        const staleBefore = new Date(Date.now() - LAST_USED_THROTTLE_MS);
        const lastUsedIsStale = or(
            isNull(userPublicKeys.lastUsedAt),
            lt(userPublicKeys.lastUsedAt, staleBefore),
        );

        if (!identity)
        {
            await this.db
                .update(userPublicKeys)
                .set({ lastUsedAt: new Date() })
                .where(and(eq(userPublicKeys.id, id), lastUsedIsStale));

            return;
        }

        // IS DISTINCT FROM rather than <>: every one of these columns is nullable
        // for a key registered before they existed, and <> against NULL is NULL,
        // which would make the first sighting look unchanged and never record it.
        const identityChanged = sql`(
            ${userPublicKeys.clientKind} IS DISTINCT FROM ${identity.kind}
            OR ${userPublicKeys.clientVersion} IS DISTINCT FROM ${identity.version}
            OR ${userPublicKeys.clientContractVersion} IS DISTINCT FROM ${identity.contractVersion}
        )`;
        const now = new Date();
        // Sent as an ISO string with an explicit cast rather than as a Date: a
        // value bound inside a raw `sql` fragment skips the column's own mapper,
        // and postgres-js refuses a Date it was handed without one.
        const nowParam = sql`${now.toISOString()}::timestamptz`;

        await this.db
            .update(userPublicKeys)
            .set({
                lastUsedAt: now,
                clientKind: identity.kind,
                clientVersion: identity.version,
                clientContractVersion: identity.contractVersion,
                clientSeenAt: sql`CASE WHEN ${identityChanged} THEN ${nowParam} ELSE ${userPublicKeys.clientSeenAt} END`,
            })
            .where(and(
                eq(userPublicKeys.id, id),
                or(lastUsedIsStale, identityChanged),
            ));
    }
}

// Default instance export
export const keysRepository = new KeysRepository();
