/**
 * Invitations Repository
 *
 * 사용자 초대 관리를 위한 Repository
 * BaseRepository를 상속받아 자동 트랜잭션 컨텍스트 지원 및 Read/Write 분리
 */

import { eq, and, gt, lt, desc, sql, getTableColumns } from 'drizzle-orm';
import { BaseRepository } from '@spfn/core/db';

import { users } from '../entities/users';
import { roles } from '../entities/roles';
import type { InvitationStatus } from '../types';
import { userInvitations, NewInvitation } from '../entities/user-invitations';
import { normalizeEmail } from '../helpers/email';

/**
 * Every invitation column but `tokenHash`.
 *
 * What every read and every `returning` here selects. The hash only ever
 * answers "does a presented token name this row", which is a `where`, never a
 * value a caller reads.
 */
const { tokenHash: _tokenHash, ...invitationColumns } = getTableColumns(userInvitations);

/**
 * Invitation columns joined with the role and the inviter, for list and details.
 */
const invitationWithDetailsColumns = {
    ...invitationColumns,
    role: {
        id: roles.id,
        name: roles.name,
        displayName: roles.displayName,
    },
    inviter: {
        id: users.id,
        email: users.email,
    },
};

/** The stored metadata as an object: SQL NULL as `{}`, a non-object wrapped as `{ legacyMetadata }`. */
const storedMetadataAsObject = sql`(case
    when ${userInvitations.metadata} is null then '{}'::jsonb
    when jsonb_typeof(${userInvitations.metadata}) = 'object' then ${userInvitations.metadata}
    else jsonb_build_object('legacyMetadata', ${userInvitations.metadata})
end)`;

/**
 * Invitations Repository 클래스
 */
export class InvitationsRepository extends BaseRepository
{
    /**
     * ID로 초대 조회
     */
    async findById(id: number)
    {
        const result = await this.readDb
            .select(invitationColumns)
            .from(userInvitations)
            .where(eq(userInvitations.id, id))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Token hash로 초대 조회
     *
     * @param tokenHash - `hashCredential` of the presented token; no plaintext token is stored
     */
    async findByTokenHash(tokenHash: string)
    {
        const result = await this.readDb
            .select(invitationColumns)
            .from(userInvitations)
            .where(eq(userInvitations.tokenHash, tokenHash))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * 이메일로 초대 조회 (pending 상태만)
     */
    async findPendingByEmail(email: string)
    {
        const result = await this.readDb
            .select(invitationColumns)
            .from(userInvitations)
            .where(
                and(
                    eq(userInvitations.email, normalizeEmail(email)),
                    eq(userInvitations.status, 'pending'),
                ),
            )
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * 초대자 ID로 모든 초대 조회
     */
    async findByInvitedBy(invitedBy: number)
    {
        return this.readDb
            .select(invitationColumns)
            .from(userInvitations)
            .where(eq(userInvitations.invitedBy, invitedBy));
    }

    /**
     * 상태별 초대 조회
     */
    async findByStatus(status: InvitationStatus)
    {
        return this.readDb
            .select(invitationColumns)
            .from(userInvitations)
            .where(eq(userInvitations.status, status));
    }

    /**
     * 초대 생성
     */
    async create(data: NewInvitation)
    {
        // Stored canonical, so the duplicate-invitation check and the account
        // this invitation later becomes agree on what address it is for.
        const result = await this.db
            .insert(userInvitations)
            .values({ ...data, email: normalizeEmail(data.email) })
            .returning(invitationColumns);

        return result[0];
    }

    /**
     * 초대 상태 업데이트
     */
    async updateStatus(
        id: number,
        status: InvitationStatus,
        timestamp?: Date,
    ) 
    {
        const updates: any = {
            status,
        };

        if (timestamp)
        {
            if (status === 'accepted')
            {
                updates.acceptedAt = timestamp;
            }
            else if (status === 'cancelled')
            {
                updates.cancelledAt = timestamp;
            }
        }

        const result = await this.db
            .update(userInvitations)
            .set(updates)
            .where(eq(userInvitations.id, id))
            .returning(invitationColumns);

        return result[0] ?? null;
    }

    /**
     * 초대 삭제
     */
    async deleteById(id: number)
    {
        const result = await this.db
            .delete(userInvitations)
            .where(eq(userInvitations.id, id))
            .returning(invitationColumns);

        return result[0] ?? null;
    }

    /**
     * 만료된 초대 상태 업데이트
     */
    async updateExpiredInvitations(): Promise<number>
    {
        const now = new Date();

        const result = await this.db
            .update(userInvitations)
            .set({ status: 'expired' })
            .where(
                and(
                    eq(userInvitations.status, 'pending'),
                    lt(userInvitations.expiresAt, now),
                ),
            )
            .returning(invitationColumns);

        return result.length;
    }

    /**
     * Token hash로 초대 조회 (role, inviter 정보 포함)
     *
     * @param tokenHash - `hashCredential` of the presented token
     */
    async findByTokenHashWithDetails(tokenHash: string)
    {
        const result = await this.readDb
            .select(invitationWithDetailsColumns)
            .from(userInvitations)
            .innerJoin(roles, eq(userInvitations.roleId, roles.id))
            .innerJoin(users, eq(userInvitations.invitedBy, users.id))
            .where(eq(userInvitations.tokenHash, tokenHash))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * 초대 목록 조회 (filtering + pagination + JOIN)
     */
    async list(params: {
        status?: InvitationStatus;
        invitedBy?: number;
        page?: number;
        limit?: number;
    }) 
    {
        const { status, invitedBy, page = 1, limit = 20 } = params;
        const offset = (page - 1) * limit;

        // Build where conditions
        const conditions = [];
        if (status)
        {
            conditions.push(eq(userInvitations.status, status));
        }
        if (invitedBy)
        {
            conditions.push(eq(userInvitations.invitedBy, invitedBy));
        }

        const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

        // Get total count
        const countResult = await this.readDb
            .select({ count: sql<number>`count(*)` })
            .from(userInvitations)
            .where(whereClause);

        const total = Number(countResult[0]?.count || 0);

        // Get paginated results with joins
        const results = await this.readDb
            .select(invitationWithDetailsColumns)
            .from(userInvitations)
            .innerJoin(roles, eq(userInvitations.roleId, roles.id))
            .innerJoin(users, eq(userInvitations.invitedBy, users.id))
            .where(whereClause)
            .orderBy(desc(userInvitations.createdAt))
            .limit(limit)
            .offset(offset);

        return {
            invitations: results,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
        };
    }

    /**
     * 초대 업데이트 (일반 업데이트 - 모든 필드 가능)
     */
    async updateById(id: number, data: Partial<NewInvitation>)
    {
        // Folded like `create`, or correcting an invitation's address would
        // write a row `findPendingByEmail` can no longer see.
        const patch = 'email' in data && typeof data.email === 'string'
            ? { ...data, email: normalizeEmail(data.email) }
            : data;

        const result = await this.db
            .update(userInvitations)
            .set(patch)
            .where(eq(userInvitations.id, id))
            .returning(invitationColumns);

        return result[0] ?? null;
    }

    /**
     * An invitation with its token hash, for a write conditional on the hash
     *
     * The one read that selects the hash. It serves `resend`, which must replace
     * the very hash it read and no other; the hash never leaves the service.
     */
    async findByIdWithTokenHash(id: number)
    {
        const result = await this.db
            .select({ ...invitationColumns, tokenHash: userInvitations.tokenHash })
            .from(userInvitations)
            .where(eq(userInvitations.id, id))
            .limit(1);

        return result[0] ?? null;
    }

    /**
     * Mark the pending, unexpired invitation a presented token names accepted
     *
     * One conditional statement: it matches only while the hash is still the
     * one presented, the invitation still pending and not yet expired. A resend
     * or cancel committed first leaves nothing to match; one still open makes
     * this statement wait for its row lock and then re-check, so the losing side
     * always sees null.
     *
     * @param tokenHash - `hashCredential` of the presented token
     * @returns The accepted invitation, or null when the token no longer names a pending one
     */
    async claimPendingByTokenHash(tokenHash: string)
    {
        const now = new Date();

        const result = await this.db
            .update(userInvitations)
            .set({ status: 'accepted', acceptedAt: now })
            .where(
                and(
                    eq(userInvitations.tokenHash, tokenHash),
                    eq(userInvitations.status, 'pending'),
                    gt(userInvitations.expiresAt, now),
                ),
            )
            .returning(invitationColumns);

        return result[0] ?? null;
    }

    /**
     * 초대 재전송 (새 token hash, status, expiresAt 동시 업데이트)
     *
     * The hash is replaced, so the link mailed before stops working: a resend
     * issues a new credential rather than extending the life of the old one.
     * Conditional on the hash and status the caller read: if another request
     * changed either since, nothing matches and the answer is null.
     */
    async resend(
        id: number,
        expected: { tokenHash: string; status: InvitationStatus },
        tokenHash: string,
        newExpiresAt: Date,
    )
    {
        const result = await this.db
            .update(userInvitations)
            .set({
                tokenHash,
                status: 'pending',
                expiresAt: newExpiresAt,
            })
            .where(
                and(
                    eq(userInvitations.id, id),
                    eq(userInvitations.tokenHash, expected.tokenHash),
                    eq(userInvitations.status, expected.status),
                ),
            )
            .returning(invitationColumns);

        return result[0] ?? null;
    }

    /**
     * 초대 취소 (status, metadata 동시 업데이트)
     *
     * Conditional on the invitation still being pending, and the reason merged
     * into the stored metadata by the statement itself, so a concurrent change
     * is neither overwritten nor lost.
     *
     * Create accepts only an object now, but a row stored before that may hold
     * an array or a scalar, which `||` would append to; such a value is kept
     * under `legacyMetadata` so the result is always an object.
     *
     * @returns The cancelled invitation, or null when it was no longer pending
     */
    async cancel(id: number, cancelledBy: number, reason?: string)
    {
        const result = await this.db
            .update(userInvitations)
            .set({
                status: 'cancelled',
                cancelledAt: new Date(),
                metadata: sql`${storedMetadataAsObject} || jsonb_strip_nulls(
                    jsonb_build_object('cancelReason', ${reason ?? null}::text, 'cancelledBy', ${cancelledBy}::bigint))`,
            })
            .where(and(eq(userInvitations.id, id), eq(userInvitations.status, 'pending')))
            .returning(invitationColumns);

        return result[0] ?? null;
    }
}

// Default instance export
export const invitationsRepository = new InvitationsRepository();
