/**
 * Permissions Repository
 *
 * 권한 관리를 위한 Repository
 * BaseRepository를 상속받아 자동 트랜잭션 컨텍스트 지원 및 Read/Write 분리
 */

import { NewPermissionEntity, PermissionEntity, permissions } from '../entities/permissions';
import type { PermissionCategory } from '../rbac';
import { BaseRepository } from '@spfn/core/db';
import { asc, eq, inArray, sql } from 'drizzle-orm';

/** A permission as the configuration declares it: every field `upsertDeclared` makes equal to it. */
export type DeclaredPermission = Pick<NewPermissionEntity, 'name' | 'displayName' | 'description' | 'category' | 'isSystem' | 'isBuiltin'>;

/**
 * Permissions Repository 클래스
 */
export class PermissionsRepository extends BaseRepository
{
    /**
     * ID로 권한 조회
     */
    async findById(id: number)
    {
        const result = await this.readDb
            .select()
            .from(permissions)
            .where(eq(permissions.id, id))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Name으로 권한 조회
     */
    async findByName(name: string)
    {
        const result = await this.readDb
            .select()
            .from(permissions)
            .where(eq(permissions.name, name))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * 여러 Name으로 권한 조회
     */
    async findByNames(names: string[]): Promise<PermissionEntity[]>
    {
        if (names.length === 0) return [];

        return this.readDb
            .select()
            .from(permissions)
            .where(inArray(permissions.name, names));
    }

    /**
     * 모든 권한 조회
     */
    async findAll(): Promise<PermissionEntity[]>
    {
        return this.readDb
            .select()
            .from(permissions)
            .orderBy(asc(permissions.name));
    }

    /**
     * 모든 권한 조회 — Write primary, for the boot sync that has just written them.
     */
    async findAllOnPrimary(): Promise<PermissionEntity[]>
    {
        return this.db
            .select()
            .from(permissions)
            .orderBy(asc(permissions.id));
    }

    /**
     * 활성 권한만 조회
     */
    async findActive(): Promise<PermissionEntity[]>
    {
        return this.readDb
            .select()
            .from(permissions)
            .where(eq(permissions.isActive, true))
            .orderBy(asc(permissions.name));
    }

    /**
     * 카테고리별 권한 조회
     */
    async findByCategory(category: PermissionCategory): Promise<PermissionEntity[]>
    {
        return this.readDb
            .select()
            .from(permissions)
            .where(eq(permissions.category, category))
            .orderBy(asc(permissions.name));
    }

    /**
     * 권한 생성
     */
    async create(data: NewPermissionEntity): Promise<PermissionEntity>
    {
        return await this._create(permissions, data);
    }

    /**
     * 여러 권한 일괄 생성
     */
    async createMany(data: NewPermissionEntity[]): Promise<PermissionEntity[]>
    {
        if (data.length === 0) return [];

        return await this._createMany(permissions, data);
    }

    /**
     * 권한 업데이트
     */
    async updateById(id: number, data: Partial<NewPermissionEntity>)
    {
        const result = await this.db
            .update(permissions)
            .set(data)
            .where(eq(permissions.id, id))
            .returning();

        return result[0] ?? null;
    }

    /**
     * Make every declared permission equal to its declaration — insert it, or
     * update the fields the configuration declares. `isActive` and `metadata`
     * are the app's: set on insert only. One statement, safe against a
     * concurrent boot (`ON CONFLICT (name)`); a row already equal is not
     * written. Permissions have no runtime creator, so there is no owner to
     * record: every row is the configuration's.
     */
    async upsertDeclared(declared: DeclaredPermission[]): Promise<void>
    {
        if (declared.length === 0) return;

        await this.db
            .insert(permissions)
            .values(declared.map(permission => ({ ...permission, isActive: true, metadata: null })))
            .onConflictDoUpdate({
                target: permissions.name,
                set: {
                    displayName: sql`excluded.display_name`,
                    description: sql`excluded.description`,
                    category: sql`excluded.category`,
                    isSystem: sql`excluded.is_system`,
                    isBuiltin: sql`excluded.is_builtin`,
                    updatedAt: new Date(),
                },
                setWhere: sql`(${permissions.displayName}, ${permissions.description}, ${permissions.category}, ${permissions.isSystem}, ${permissions.isBuiltin})
                    is distinct from (excluded.display_name, excluded.description, excluded.category, excluded.is_system, excluded.is_builtin)`,
            });
    }

    /**
     * 권한 삭제
     */
    async deleteById(id: number)
    {
        const result = await this.db
            .delete(permissions)
            .where(eq(permissions.id, id))
            .returning();

        return result[0] ?? null;
    }
}

// Default instance export
export const permissionsRepository = new PermissionsRepository();
