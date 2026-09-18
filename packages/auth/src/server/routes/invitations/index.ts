/**
 * @spfn/auth - Invitation Routes
 *
 * Thin route handlers for user invitation management
 */

import { EMAIL_PATTERN, UUID_PATTERN } from '@spfn/auth';
import { getAuth } from '../../helpers';
import { authenticate, requirePermissions, requireRole } from '../../middleware';
import { KEY_ALGORITHM } from '../../types';
import { deviceProvenance } from '../../lib/device-provenance';
import {
    getInvitationWithDetails,
    validateInvitation,
    acceptInvitation as _acceptInvitation,
    createInvitation as _createInvitation,
    listInvitations as _listInvitations,
    cancelInvitation as _cancelInvitation,
    resendInvitation as _resendInvitation,
    deleteInvitation as _deleteInvitation,
    assertCanAssignRole,
} from '../../services';
import { Type } from '@sinclair/typebox';
import { Transactional } from '@spfn/core/db';
import { rateLimitPolicy } from '@spfn/core/middleware';
import { defineRouter, route } from '@spfn/core/route';

/**
 * Invitation status enum values
 */
const INVITATION_STATUSES = ['pending', 'accepted', 'expired', 'cancelled'] as const;

// ==========================================
// Public Routes (No Authentication Required)
// ==========================================

/**
 * GET /_auth/invitations/:token
 * Get invitation details for acceptance page
 */
export const getInvitation = route.get('/_auth/invitations/:token')
    .input({
        params: Type.Object({
            token: Type.String({
                pattern: UUID_PATTERN,
                description: 'Invitation token (UUID v4)',
            }),
        }),
    })
    .use([rateLimitPolicy('auth-invitation-lookup', { limit: 30, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { params } = await c.data();
        const token = params.token;

        const validation = await validateInvitation(token);

        if (!validation.valid || !validation.invitation)
        {
            throw new Error(validation.error || 'Invalid invitation');
        }

        // Get full details with role and inviter info
        const invitation = await getInvitationWithDetails(token);

        if (!invitation)
        {
            throw new Error('Invitation not found');
        }

        return {
            email: invitation.email,
            role: invitation.role.name,
            roleDisplayName: invitation.role.displayName,
            invitedBy: invitation.inviter.email || 'Unknown',
            expiresAt: invitation.expiresAt.toISOString(),
            metadata: invitation.metadata || undefined,
        };
    });

/**
 * POST /_auth/invitations/accept
 * Accept invitation and create user account
 */
export const acceptInvitation = route.post('/_auth/invitations/accept')
    .input({
        body: Type.Object({
            token: Type.String({
                pattern: UUID_PATTERN,
                description: 'Invitation token',
            }),
            password: Type.String({
                minLength: 8,
                maxLength: 72,
                description: 'User password (8–72 characters). bcrypt silently ignores bytes past 72, so longer inputs are rejected rather than truncated.',
            }),
        }),
    })
    .interceptor({
        body: Type.Object({
            publicKey: Type.String({ description: 'Client public key' }),
            keyId: Type.String({ description: 'Key identifier' }),
            fingerprint: Type.String({ description: 'Key fingerprint' }),
            algorithm: Type.Union(KEY_ALGORITHM.map(algo => Type.Literal(algo)), { description: 'Signature algorithm' }),
        }),
    })
    .use([rateLimitPolicy('auth-invitation-accept', { limit: 10, windowMs: 60_000 }), Transactional()])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        return await _acceptInvitation({
            token: body.token,
            password: body.password,
            publicKey: body.publicKey,
            keyId: body.keyId,
            fingerprint: body.fingerprint,
            algorithm: body.algorithm,
            ...deviceProvenance(c.raw),
        });
    });

// ==========================================
// Protected Routes (Admin Only)
// ==========================================

/**
 * POST /_auth/invitations
 * Create new invitation (requires user:invite permission)
 */
export const createInvitation = route.post('/_auth/invitations')
    .input({
        body: Type.Object({
            email: Type.String({
                pattern: EMAIL_PATTERN,
                description: 'Email address',
            }),
            roleId: Type.Number({
                description: 'Role ID to assign',
            }),
            expiresInDays: Type.Optional(Type.Number({
                minimum: 1,
                maximum: 30,
                description: 'Days until invitation expires (default: 7)',
            })),
            expiresAt: Type.Optional(Type.String({
                format: 'date-time',
                description: 'Exact expiration timestamp (ISO 8601). Takes precedence over expiresInDays.',
            })),
            metadata: Type.Optional(Type.Any({
                description: 'Custom metadata (welcome message, department, etc.)',
            })),
        }),
    })
    .use([authenticate, requirePermissions('user:invite')])
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const { userId } = getAuth(c);

        // Caller must have authority over the role being assigned — without this,
        // a user:invite holder could invite with the superadmin roleId and self-accept
        await assertCanAssignRole(userId, body.roleId);

        const invitation = await _createInvitation({
            email: body.email,
            roleId: body.roleId,
            invitedBy: Number(userId),
            expiresInDays: body.expiresInDays,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
            metadata: body.metadata,
        });

        // Build invitation URL (use environment variable or default)
        const baseUrl = process.env.SPFN_API_URL || 'http://localhost:8790';
        const invitationUrl = `${baseUrl}/auth/invite/${invitation.token}`;

        return {
            id: invitation.id,
            email: invitation.email,
            token: invitation.token,
            roleId: invitation.roleId,
            expiresAt: invitation.expiresAt.toISOString(),
            invitationUrl,
        };
    });

/**
 * GET /_auth/invitations
 * List invitations with filtering (requires user:read permission)
 */
export const listInvitations = route.get('/_auth/invitations')
    .input({
        query: Type.Object({
            status: Type.Optional(Type.Union(
                INVITATION_STATUSES.map(s => Type.Literal(s)),
                { description: 'Filter by status' },
            )),
            page: Type.Optional(Type.Number({
                minimum: 1,
                description: 'Page number (default: 1)',
            })),
            limit: Type.Optional(Type.Number({
                minimum: 1,
                maximum: 100,
                description: 'Items per page (default: 20)',
            })),
        }),
    })
    .use([authenticate, requirePermissions('user:read')])
    .handler(async (c) =>
    {
        const { query } = await c.data();

        const result = await _listInvitations({
            status: query.status as any,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });

        // Format dates to ISO strings
        const formattedInvitations = result.invitations;

        return {
            ...result,
            invitations: formattedInvitations,
        };
    });

/**
 * POST /_auth/invitations/cancel
 * Cancel invitation (requires user:invite permission)
 */
export const cancelInvitation = route.post('/_auth/invitations/cancel')
    .input({
        body: Type.Object({
            id: Type.Number({
                description: 'Invitation ID',
            }),
            reason: Type.Optional(Type.String({
                description: 'Cancellation reason',
            })),
        }),
    })
    .use([authenticate, requirePermissions('user:invite')])
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const { userId } = getAuth(c);

        await _cancelInvitation(
            body.id,
            Number(userId),
            body.reason,
        );

        return {
            cancelledAt: new Date().toISOString(),
        };
    });

/**
 * POST /_auth/invitations/resend
 * Resend invitation email (requires user:invite permission)
 */
export const resendInvitation = route.post('/_auth/invitations/resend')
    .input({
        body: Type.Object({
            id: Type.Number({
                description: 'Invitation ID',
            }),
            expiresInDays: Type.Optional(Type.Number({
                minimum: 1,
                maximum: 30,
                description: 'New expiration period (default: 7)',
            })),
        }),
    })
    .use([authenticate, requirePermissions('user:invite')])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        const updated = await _resendInvitation(
            body.id,
            body.expiresInDays,
        );

        return {
            expiresAt: updated.expiresAt.toISOString(),
        };
    });

/**
 * POST /_auth/invitations/delete
 * Delete invitation permanently (requires superadmin role)
 */
export const deleteInvitation = route.post('/_auth/invitations/delete')
    .input({
        body: Type.Object({
            id: Type.Number({
                description: 'Invitation ID',
            }),
        }),
    })
    .use([authenticate, requireRole('superadmin')])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        await _deleteInvitation(body.id);

        return c.noContent();
    });

// Export router
export const invitationRouter = defineRouter({
    getInvitation: getInvitation,
    acceptInvitation: acceptInvitation,
    createInvitation: createInvitation,
    listInvitations: listInvitations,
    cancelInvitation: cancelInvitation,
    resendInvitation: resendInvitation,
    deleteInvitation: deleteInvitation,
});

// For backward compatibility with file-based routing (temporary)
export default invitationRouter;
