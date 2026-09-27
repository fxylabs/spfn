/**
 * User Profiles Repository
 *
 * 사용자 프로필 관리를 위한 Repository
 * BaseRepository를 상속받아 자동 트랜잭션 컨텍스트 지원 및 Read/Write 분리
 */

import { NewUserProfile, userProfiles } from '../entities/user-profiles';
import { BaseRepository } from '@spfn/core/db';
import { eq } from 'drizzle-orm';
import { profileLocale } from '../lib/profile-locale';

/**
 * User Profiles Repository 클래스
 */
export class UserProfilesRepository extends BaseRepository
{
    /**
     * ID로 프로필 조회
     */
    async findById(id: number)
    {
        const result = await this.readDb
            .select()
            .from(userProfiles)
            .where(eq(userProfiles.id, id))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * User ID로 locale 선택값만 조회 (경량)
     *
     * NULL(또는 프로필 없음)은 "고른 적 없음"이다. 기본값으로 바꾸지 않는다.
     */
    async findLocaleByUserId(userId: number): Promise<string | null>
    {
        const result = await this.readDb
            .select({ locale: userProfiles.locale })
            .from(userProfiles)
            .where(eq(userProfiles.userId, userId))
            .limit(1);

        return result[0]?.locale ?? null;
    }

    /**
     * User ID로 프로필 조회
     */
    async findByUserId(userId: number)
    {
        const result = await this.readDb
            .select()
            .from(userProfiles)
            .where(eq(userProfiles.userId, userId))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * 프로필 생성
     */
    async create(data: NewUserProfile)
    {
        return await this._create(userProfiles, data);
    }

    /**
     * 프로필 업데이트 (by ID)
     */
    async updateById(id: number, data: Partial<NewUserProfile>)
    {
        const result = await this.db
            .update(userProfiles)
            .set(data)
            .where(eq(userProfiles.id, id))
            .returning();

        return result[0] ?? null;
    }

    /**
     * 프로필 업데이트 (by User ID)
     */
    async updateByUserId(userId: number, data: Partial<NewUserProfile>)
    {
        const result = await this.db
            .update(userProfiles)
            .set(data)
            .where(eq(userProfiles.userId, userId))
            .returning();

        return result[0] ?? null;
    }

    /**
     * 프로필 삭제 (by ID)
     */
    async deleteById(id: number)
    {
        const result = await this.db
            .delete(userProfiles)
            .where(eq(userProfiles.id, id))
            .returning();

        return result[0] ?? null;
    }

    /**
     * 프로필 삭제 (by User ID)
     */
    async deleteByUserId(userId: number)
    {
        const result = await this.db
            .delete(userProfiles)
            .where(eq(userProfiles.userId, userId))
            .returning();

        return result[0] ?? null;
    }

    /**
     * 프로필 Upsert (by User ID)
     *
     * 프로필이 없으면 생성, 있으면 업데이트
     * 새로 생성 시 displayName은 필수 (없으면 'User'로 설정)
     */
    async upsertByUserId(userId: number, data: Partial<Omit<NewUserProfile, 'userId'>>)
    {
        const existing = await this.findByUserId(userId);

        if (existing)
        {
            return await this.updateByUserId(userId, data);
        }

        return await this.create({
            userId,
            displayName: data.displayName || 'User',
            ...data,
        });
    }

    /**
     * User ID로 프로필 데이터 조회 (formatted)
     *
     * API 응답에 최적화된 형식으로 반환
     */
    async fetchProfileData(userId: number)
    {
        const profile = await this.readDb
            .select({
                profileId: userProfiles.id,
                displayName: userProfiles.displayName,
                firstName: userProfiles.firstName,
                lastName: userProfiles.lastName,
                avatarUrl: userProfiles.avatarUrl,
                bio: userProfiles.bio,
                locale: userProfiles.locale,
                timezone: userProfiles.timezone,
                website: userProfiles.website,
                location: userProfiles.location,
                company: userProfiles.company,
                jobTitle: userProfiles.jobTitle,
                metadata: userProfiles.metadata,
                createdAt: userProfiles.createdAt,
                updatedAt: userProfiles.updatedAt,
            })
            .from(userProfiles)
            .where(eq(userProfiles.userId, userId))
            .limit(1)
            .then(rows => rows[0] ?? null);

        if (!profile)
        {
            return null;
        }

        return {
            profileId: profile.profileId,
            displayName: profile.displayName,
            firstName: profile.firstName,
            lastName: profile.lastName,
            avatarUrl: profile.avatarUrl,
            bio: profile.bio,
            ...profileLocale(profile.locale),
            timezone: profile.timezone || 'UTC',
            website: profile.website,
            location: profile.location,
            company: profile.company,
            jobTitle: profile.jobTitle,
            metadata: profile.metadata,
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
        };
    }
}

// Default instance export
export const userProfilesRepository = new UserProfilesRepository();
