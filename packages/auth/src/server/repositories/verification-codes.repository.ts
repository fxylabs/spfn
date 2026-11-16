/**
 * Verification Codes Repository
 *
 * 인증 코드 관리를 위한 Repository
 * BaseRepository를 상속받아 자동 트랜잭션 컨텍스트 지원 및 Read/Write 분리
 */

import { NewVerificationCode, verificationCodes } from '../entities/verification-codes';
import type { VerificationPurpose } from '../routes/schema';
import { BaseRepository } from '@spfn/core/db';
import { eq, and, lt, gt, isNull, sql } from 'drizzle-orm';

/**
 * Verification Codes Repository 클래스
 *
 * BaseRepository를 상속받아 다음 기능을 제공:
 * - 자동 트랜잭션 컨텍스트 감지 및 사용
 * - Read/Write 연결 분리 (replica 활용)
 * - 타입 안전성
 */
export class VerificationCodesRepository extends BaseRepository
{
    /**
     * Target과 Purpose로 유효한 인증 코드 조회
     * (만료되지 않고, 사용되지 않은 코드)
     * Primary: a submitted code is compared with what this returns, and a
     * replica behind the last use would answer a code already spent.
     */
    async findValidByTargetAndPurpose(
        target: string,
        purpose: VerificationPurpose,
    ) 
    {
        const now = new Date();

        const result = await this.db
            .select()
            .from(verificationCodes)
            .where(
                and(
                    eq(verificationCodes.target, target),
                    eq(verificationCodes.purpose, purpose),
                    isNull(verificationCodes.usedAt),
                    gt(verificationCodes.expiresAt, now),
                ),
            )
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * ID로 인증 코드 조회
     * Read replica 사용
     */
    async findById(id: number)
    {
        const result = await this.readDb
            .select()
            .from(verificationCodes)
            .where(eq(verificationCodes.id, id))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * The code a send was asked for, while it can still be used.
     *
     * Read by the delivery that runs after the request: a code superseded by a
     * newer send, used or expired since then is not sent. Write primary, because
     * the row was written moments ago and a replica may not have it yet.
     */
    async findDeliverable(id: number)
    {
        const result = await this.db
            .select()
            .from(verificationCodes)
            .where(
                and(
                    eq(verificationCodes.id, id),
                    isNull(verificationCodes.usedAt),
                    gt(verificationCodes.expiresAt, new Date()),
                ),
            )
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * 인증 코드 생성
     * Write primary 사용
     */
    async create(data: NewVerificationCode)
    {
        return await this._create(verificationCodes, data);
    }

    /**
     * Use a code — only while it is unused, unexpired and under the attempt
     * limit — and keep the row until `retainedUntil`, the expiry of the
     * verification token minted from it: the row is what `spendToken` spends,
     * so it lives as long as the token (`VERIFICATION_TOKEN_EXPIRY_MINUTES`).
     * One conditional UPDATE: of any number of requests carrying the right
     * code at once, exactly one uses it (au4-A8). Write primary.
     *
     * @returns true when this call used it
     */
    async markAsUsed(id: number, attemptLimit: number, retainedUntil: Date): Promise<boolean>
    {
        const result = await this.db
            .update(verificationCodes)
            .set({
                usedAt: new Date(),
                expiresAt: retainedUntil,
            })
            .where(and(
                eq(verificationCodes.id, id),
                isNull(verificationCodes.usedAt),
                gt(verificationCodes.expiresAt, new Date()),
                lt(verificationCodes.attempts, attemptLimit),
            ))
            .returning({ id: verificationCodes.id });

        return result.length > 0;
    }

    /**
     * Count a wrong guess — only while the code is unused and under the
     * attempt limit. One conditional UPDATE, so concurrent wrong guesses each
     * count and none counts past the limit. Write primary.
     *
     * @returns true when this guess was counted; false when the code had no attempts left
     */
    async spendAttempt(id: number, attemptLimit: number): Promise<boolean>
    {
        const result = await this.db
            .update(verificationCodes)
            .set({ attempts: sql`${verificationCodes.attempts} + 1` })
            .where(and(
                eq(verificationCodes.id, id),
                isNull(verificationCodes.usedAt),
                lt(verificationCodes.attempts, attemptLimit),
            ))
            .returning({ id: verificationCodes.id });

        return result.length > 0;
    }

    /**
     * 만료된 코드 삭제 — by `expiresAt`: an unverified code's own expiry, and for
     * a verified one the expiry of the token minted from it (`markAsUsed`), so a
     * sweep never removes a row a live token still has to spend.
     * Write primary 사용
     */
    async deleteExpired()
    {
        const now = new Date();

        const result = await this.db
            .delete(verificationCodes)
            .where(lt(verificationCodes.expiresAt, now))
            .returning();

        return result.length;
    }

    /**
     * Target(email/phone)의 모든 인증 코드 삭제 (계정 파기용)
     *
     * verificationCodes는 userId FK가 없고 target 텍스트로만 연결되므로, 파기 시
     * 원래 email/phone을 이 메서드로 직접 정리해야 한다.
     * Write primary 사용
     */
    async deleteByTarget(target: string): Promise<number>
    {
        const result = await this.db
            .delete(verificationCodes)
            .where(eq(verificationCodes.target, target))
            .returning();

        return result.length;
    }

    /**
     * Spend the verification token minted from a code: delete the code's row,
     * in one conditional statement that names the target and purpose the token
     * carries. The token is a signed copy of those three values and lives past
     * its code, so the row is what makes it single-use — a second presentation,
     * or one racing this, matches no row.
     *
     * Write primary.
     *
     * @returns whether this call spent it
     */
    async spendToken(codeId: number, target: string, purpose: VerificationPurpose): Promise<boolean>
    {
        const result = await this.db
            .delete(verificationCodes)
            .where(
                and(
                    eq(verificationCodes.id, codeId),
                    eq(verificationCodes.target, target),
                    eq(verificationCodes.purpose, purpose),
                ),
            )
            .returning({ id: verificationCodes.id });

        return result.length > 0;
    }

    /**
     * Target의 모든 이전 코드 무효화 (새 코드 발급 시)
     * Write primary 사용
     */
    async invalidatePreviousCodes(
        target: string,
        purpose: VerificationPurpose,
    ) 
    {
        const result = await this.db
            .update(verificationCodes)
            .set({
                usedAt: new Date(),
            })
            .where(
                and(
                    eq(verificationCodes.target, target),
                    eq(verificationCodes.purpose, purpose),
                    isNull(verificationCodes.usedAt),
                ),
            )
            .returning();

        return result.length;
    }
}

// Default instance export
export const verificationCodesRepository = new VerificationCodesRepository();
