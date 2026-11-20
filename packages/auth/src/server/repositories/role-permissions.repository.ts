/**
 * Role Permissions Repository
 *
 * 역할-권한 매핑 관리를 위한 Repository
 * BaseRepository를 상속받아 자동 트랜잭션 컨텍스트 지원 및 Read/Write 분리
 */

import { CONFIG_OWNED, NewRolePermission, OPERATOR_OWNED, RolePermission, rolePermissions, type RolePermissionSource } from '../entities/role-permissions';
import { permissions } from '../entities/permissions';
import { BaseRepository } from '@spfn/core/db';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { PermissionSummary } from './users.repository';

/** A mapping to write: who owns it is always said, never defaulted. */
export type NewSourcedRolePermission = NewRolePermission & { source: RolePermissionSource };

/** A role→permission pair, as the configuration declares it. */
export interface MappingIds
{
    roleId: number;
    permissionId: number;
}

/**
 * Role Permissions Repository 클래스
 */
export class RolePermissionsRepository extends BaseRepository
{
    /**
     * 역할 ID로 모든 권한 조회
     */
    async findByRoleId(roleId: number)
    {
        return this.readDb
            .select()
            .from(rolePermissions)
            .where(eq(rolePermissions.roleId, roleId));
    }

    /**
     * A role's mappings with their owners, on the primary — what a runtime
     * change of the role's permissions is judged against.
     */
    async findByRoleIdOnPrimary(roleId: number): Promise<RolePermission[]>
    {
        return this.db
            .select()
            .from(rolePermissions)
            .where(eq(rolePermissions.roleId, roleId));
    }

    /**
     * The active permissions mapped to a role, on the primary — for the role
     * an account is resolved as when it is not the one it stores (the
     * email-domain policy's fallback).
     */
    async findActivePermissionsOnPrimary(roleId: number): Promise<PermissionSummary[]>
    {
        const rows = await this.db
            .select({
                id: permissions.id,
                name: permissions.name,
                displayName: permissions.displayName,
                category: permissions.category,
            })
            .from(rolePermissions)
            .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
            .where(and(eq(rolePermissions.roleId, roleId), eq(permissions.isActive, true)));

        return rows.map(row => ({ ...row, category: row.category ?? undefined }));
    }

    /**
     * 권한 ID로 모든 역할 조회
     */
    async findByPermissionId(permissionId: number)
    {
        return this.readDb
            .select()
            .from(rolePermissions)
            .where(eq(rolePermissions.permissionId, permissionId));
    }

    /**
     * 역할-권한 매핑 생성
     */
    async create(data: NewSourcedRolePermission): Promise<RolePermission>
    {
        return await this._create(rolePermissions, data);
    }

    /**
     * 여러 역할-권한 매핑 일괄 생성
     */
    async createMany(data: NewSourcedRolePermission[])
    {
        if (data.length === 0) return [];

        return await this._createMany(rolePermissions, data);
    }

    /**
     * 특정 역할-권한 매핑 삭제
     */
    async deleteByRoleIdAndPermissionId(
        roleId: number,
        permissionId: number,
    ): Promise<RolePermission | null>
    {
        const result = await this.db
            .delete(rolePermissions)
            .where(
                and(
                    eq(rolePermissions.roleId, roleId),
                    eq(rolePermissions.permissionId, permissionId),
                ),
            )
            .returning();

        return result[0] ?? null;
    }

    /**
     * Make the declared mappings the configuration's, in one statement: insert
     * the missing ones and take over an operator's the configuration declares
     * (`ON CONFLICT … DO UPDATE SET source = 'config'`). A concurrent boot, or
     * an operator adding the same mapping, meets the conflict clause instead
     * of a unique violation. Rows are written in (role, permission) order.
     */
    async upsertConfigOwned(declared: MappingIds[]): Promise<void>
    {
        if (declared.length === 0) return;

        const ordered = [...declared].sort((a, b) => a.roleId - b.roleId || a.permissionId - b.permissionId);

        await this.db
            .insert(rolePermissions)
            .values(ordered.map(mapping => ({ ...mapping, source: CONFIG_OWNED })))
            .onConflictDoUpdate({
                target: [rolePermissions.roleId, rolePermissions.permissionId],
                set: { source: CONFIG_OWNED },
                setWhere: ne(rolePermissions.source, CONFIG_OWNED),
            });
    }

    /**
     * Delete the configuration's mappings it no longer declares, in one
     * statement — an operator's are never matched.
     *
     * @returns the mappings deleted
     */
    async deleteConfigOwnedExcept(declared: MappingIds[]): Promise<RolePermission[]>
    {
        const pairs = declared.map(mapping => sql`(${mapping.roleId}::bigint, ${mapping.permissionId}::bigint)`);
        const undeclared = pairs.length > 0
            ? sql`(${rolePermissions.roleId}, ${rolePermissions.permissionId}) not in (${sql.join(pairs, sql`, `)})`
            : undefined;

        return this.db
            .delete(rolePermissions)
            .where(and(eq(rolePermissions.source, CONFIG_OWNED), undeclared))
            .returning();
    }

    /**
     * Delete a role's operator-owned mappings of `permissionIds`, in one
     * statement that carries the owner (`source = 'admin'`): a mapping a boot
     * made the configuration's since the caller read it is not deleted.
     *
     * @returns the permission ids whose mapping was deleted
     */
    async deleteOperatorOwned(roleId: number, permissionIds: number[]): Promise<number[]>
    {
        if (permissionIds.length === 0) return [];

        const deleted = await this.db
            .delete(rolePermissions)
            .where(and(
                eq(rolePermissions.roleId, roleId),
                inArray(rolePermissions.permissionId, permissionIds),
                eq(rolePermissions.source, OPERATOR_OWNED),
            ))
            .returning({ permissionId: rolePermissions.permissionId });

        return deleted.map(mapping => mapping.permissionId);
    }

    /**
     * 역할의 모든 권한 매핑 삭제
     */
    async deleteByRoleId(roleId: number)
    {
        const result = await this.db
            .delete(rolePermissions)
            .where(eq(rolePermissions.roleId, roleId))
            .returning();

        return result.length;
    }
}

// Default instance export
export const rolePermissionsRepository = new RolePermissionsRepository();
