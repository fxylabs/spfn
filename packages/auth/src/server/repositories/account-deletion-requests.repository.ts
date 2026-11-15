/**
 * Account Deletion Requests Repository
 *
 * 계정 탈퇴 요청/복구/파기 감사 이력 관리를 위한 Repository
 * BaseRepository를 상속받아 자동 트랜잭션 컨텍스트 지원 및 Read/Write 분리
 *
 * Row는 절대 삭제하지 않는다 — status 전이(pending -> cancelled|completed)로만 갱신.
 */

import { eq, and, lte } from 'drizzle-orm';
import { BaseRepository } from '@spfn/core/db';

import { accountDeletionRequests, NewAccountDeletionRequest } from '../entities/account-deletion-requests';
import type { PurgeStrategy } from '../types';

/**
 * Account Deletion Requests Repository 클래스
 */
export class AccountDeletionRequestsRepository extends BaseRepository
{
    /**
     * ID로 요청 조회
     * Read replica 사용
     */
    async findById(id: number)
    {
        const result = await this.readDb
            .select()
            .from(accountDeletionRequests)
            .where(eq(accountDeletionRequests.id, id))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * User ID로 pending 요청 조회 (유저당 최대 1건, partial unique index로 보장)
     * Read replica 사용
     */
    async findPendingByUserId(userId: number)
    {
        const result = await this.readDb
            .select()
            .from(accountDeletionRequests)
            .where(
                and(
                    eq(accountDeletionRequests.userId, userId),
                    eq(accountDeletionRequests.status, 'pending'),
                ),
            )
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * User ID로 pending 요청 조회 — Write primary에서 직접 읽는다.
     *
     * 로그인/OAuth/authenticate 게이트가 deletion='pending' 유저의 purgeScheduledAt을
     * 표시하는 데 쓴다. 이 경로들은 복제 지연이 있으면 방금 커밋된 상태 전이를 놓칠 수
     * 있어(예: 삭제 요청 직후 OAuth 로그인 시도), replica가 아닌 primary에서 읽는다.
     */
    async findPendingByUserIdOnPrimary(userId: number)
    {
        const result = await this.db
            .select()
            .from(accountDeletionRequests)
            .where(
                and(
                    eq(accountDeletionRequests.userId, userId),
                    eq(accountDeletionRequests.status, 'pending'),
                ),
            )
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * 파기 스윕 대상 조회 — status='pending' AND purgeScheduledAt <= now
     * Read replica 사용
     */
    async findDueForPurge(now: Date)
    {
        return this.readDb
            .select()
            .from(accountDeletionRequests)
            .where(
                and(
                    eq(accountDeletionRequests.status, 'pending'),
                    lte(accountDeletionRequests.purgeScheduledAt, now),
                ),
            );
    }

    /**
     * 요청 생성
     * Write primary 사용
     */
    async create(data: NewAccountDeletionRequest)
    {
        return await this._create(accountDeletionRequests, data);
    }

    /**
     * 요청 취소 (복구)
     *
     * `WHERE status = 'pending'` 조건부 UPDATE — 이미 completed(파기 완료)된 row를
     * 뒤늦게 도착한 cancel이 덮어쓰지 않도록 한다. 0 row 매치(= 이미 completed거나
     * cancelled) 시 null을 반환하니 호출자가 그 결과를 확인해야 한다.
     * Write primary 사용
     */
    async markCancelled(id: number)
    {
        const result = await this.db
            .update(accountDeletionRequests)
            .set({
                status: 'cancelled',
                cancelledAt: new Date(),
            })
            .where(
                and(
                    eq(accountDeletionRequests.id, id),
                    eq(accountDeletionRequests.status, 'pending'),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * 요청 완료 처리 (파기 실행 직전에 호출하는 "claim" — 파기 실행 후가 아니다)
     *
     * `WHERE status = 'pending'` 조건부 UPDATE. Postgres UPDATE는 매치되는 row에 락을
     * 걸고 최신 커밋 상태로 WHERE를 재평가하므로, 이 호출 하나로 (1) 동시에 취소된
     * row를 안전하게 걸러내고 (2) row-level 락으로 동시 파기 시도를 직렬화한다.
     * 0 row 매치(= 이미 취소되었거나 다른 파기가 먼저 처리함) 시 null을 반환 — 호출자는
     * destructive DML을 실행하기 **전에** 반드시 이 결과를 확인해야 한다.
     * Write primary 사용
     */
    async markCompleted(id: number, purgeStrategy: PurgeStrategy)
    {
        const result = await this.db
            .update(accountDeletionRequests)
            .set({
                status: 'completed',
                completedAt: new Date(),
                purgeStrategy,
            })
            .where(
                and(
                    eq(accountDeletionRequests.id, id),
                    eq(accountDeletionRequests.status, 'pending'),
                ),
            )
            .returning();

        return result[0] ?? null;
    }
}

// Default instance export
export const accountDeletionRequestsRepository = new AccountDeletionRequestsRepository();
