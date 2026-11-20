/**
 * User Permissions Repository
 *
 * 사용자별 권한 오버라이드 관리를 위한 Repository
 * BaseRepository를 상속받아 자동 트랜잭션 컨텍스트 지원 및 Read/Write 분리
 */

import { NewUserPermission, userPermissions } from '../entities/user-permissions';
import { BaseRepository } from '@spfn/core/db';
import { eq, and, or, isNull, isNotNull, lt, gt } from 'drizzle-orm';

/**
 * User Permissions Repository 클래스
 */
export class UserPermissionsRepository extends BaseRepository
{
    /**
     * 사용자 ID로 모든 권한 오버라이드 조회
     */
    async findByUserId(userId: number)
    {
        return this.readDb
            .select()
            .from(userPermissions)
            .where(eq(userPermissions.userId, userId));
    }

    /**
     * 사용자 ID로 유효한 권한 오버라이드만 조회
     * (만료되지 않거나 만료 시간이 없는 것)
     */
    async findValidByUserId(userId: number)
    {
        const now = new Date();

        return this.readDb
            .select()
            .from(userPermissions)
            .where(
                and(
                    eq(userPermissions.userId, userId),
                    or(
                        isNull(userPermissions.expiresAt),
                        gt(userPermissions.expiresAt, now),
                    ),
                ),
            );
    }

    /**
     * 특정 사용자-권한 매핑 조회
     */
    async findByUserIdAndPermissionId(
        userId: number,
        permissionId: number,
    )
    {
        const result = await this.readDb
            .select()
            .from(userPermissions)
            .where(
                and(
                    eq(userPermissions.userId, userId),
                    eq(userPermissions.permissionId, permissionId),
                ),
            )
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * 사용자 권한 오버라이드 생성
     */
    async create(data: NewUserPermission)
    {
        return await this._create(userPermissions, data);
    }

    /**
     * A person's grant or revocation of one permission, replacing the one they
     * had (one per person and permission, `user_permissions_unique`).
     */
    async upsert(data: NewUserPermission)
    {
        const result = await this.db
            .insert(userPermissions)
            .values(data)
            .onConflictDoUpdate({
                target: [userPermissions.userId, userPermissions.permissionId],
                set: { granted: data.granted, expiresAt: data.expiresAt, reason: data.reason },
            })
            .returning();

        return result[0]!;
    }

    /**
     * 사용자 권한 오버라이드 업데이트
     */
    async updateById(id: number, data: Partial<NewUserPermission>)
    {
        const result = await this.db
            .update(userPermissions)
            .set(data)
            .where(eq(userPermissions.id, id))
            .returning();

        return result[0] ?? null;
    }

    /**
     * 특정 사용자-권한 매핑 삭제
     */
    async deleteByUserIdAndPermissionId(
        userId: number,
        permissionId: number,
    ) 
    {
        const result = await this.db
            .delete(userPermissions)
            .where(
                and(
                    eq(userPermissions.userId, userId),
                    eq(userPermissions.permissionId, permissionId),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * 사용자의 모든 권한 오버라이드 삭제
     */
    async deleteByUserId(userId: number)
    {
        const result = await this.db
            .delete(userPermissions)
            .where(eq(userPermissions.userId, userId))
            .returning();

        return result.length;
    }

    /**
     * 만료된 권한 오버라이드 삭제
     */
    async deleteExpired()
    {
        const now = new Date();

        const result = await this.db
            .delete(userPermissions)
            .where(
                and(
                    isNotNull(userPermissions.expiresAt),
                    lt(userPermissions.expiresAt, now),
                ),
            )
            .returning();

        return result.length;
    }
}

// Default instance export
export const userPermissionsRepository = new UserPermissionsRepository();
