/**
 * @spfn/auth - Invitation Routes
 *
 * Thin route handlers for user invitation management
 */

import { EMAIL_PATTERN } from '@spfn/auth';
import { getAuth } from '../../helpers';
import { authenticate, requirePermissions, requireRole } from '../../middleware';
import { INVITATION_MAX_EXPIRY_DAYS, KEY_ALGORITHM } from '../../types';
import { deviceProvenance } from '../../lib/device-provenance';
import { PasswordSchema } from '../schema';
import {
    describeInvitation,
    acceptInvitation as _acceptInvitation,
    createInvitation as _createInvitation,
    listInvitations as _listInvitations,
    cancelInvitation as _cancelInvitation,
    resendInvitation as _resendInvitation,
    deleteInvitation as _deleteInvitation,
    assertCanAssignRole,
} from '../../services';
import { Type } from '@sinclair/typebox';
import { env as coreEnv } from '@spfn/core/config';
import { Transactional } from '@spfn/core/db';
import { rateLimitPolicy } from '@spfn/core/middleware';
import { defineRouter, route } from '@spfn/core/route';

/**
 * Invitation status enum values
 */
const INVITATION_STATUSES = ['pending', 'accepted', 'expired', 'cancelled'] as const;

/**
 * The invitation token as the link carries it
 *
 * A minted token is 43 base64url characters; an invitation created before
 * tokens were hashed carries a 36-character UUID, and its link keeps working.
 * Either way the value is hashed and looked up, never compared as stored.
 */
const InvitationTokenSchema = Type.String({
    minLength: 16,
    maxLength: 256,
    description: 'Invitation token, from the invitation link',
});

/**
 * Link the invitee opens
 *
 * SPFN_API_URL is required by @spfn/core, so there is no fallback to guess.
 */
function invitationUrl(token: string): string
{
    return `${coreEnv.SPFN_API_URL}/auth/invite/${token}`;
}

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
            token: InvitationTokenSchema,
        }),
    })
    .use([rateLimitPolicy('auth-invitation-lookup', { limit: 30, windowMs: 60_000 })])
    .skip(['auth'])
    .handler(async (c) =>
    {
        const { params } = await c.data();

        return await describeInvitation(params.token);
    });

/**
 * POST /_auth/invitations/accept
 * Accept invitation and create user account
 */
export const acceptInvitation = route.post('/_auth/invitations/accept')
    .input({
        body: Type.Object({
            token: InvitationTokenSchema,
            password: PasswordSchema,
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
                maximum: INVITATION_MAX_EXPIRY_DAYS,
                description: 'Days until invitation expires (default: 7)',
            })),
            expiresAt: Type.Optional(Type.String({
                format: 'date-time',
                description: `Exact expiration timestamp (ISO 8601), at most ${INVITATION_MAX_EXPIRY_DAYS} days away. Takes precedence over expiresInDays.`,
            })),
            metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown(), {
                description: 'Custom metadata object (welcome message, department, etc.); an array or a scalar is refused',
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

        const { invitation, token } = await _createInvitation({
            email: body.email,
            roleId: body.roleId,
            invitedBy: Number(userId),
            expiresInDays: body.expiresInDays,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
            metadata: body.metadata,
        });

        // The one answer that carries the token: only its hash is stored, so
        // no later call can return it. Resend issues a new one.
        return {
            id: invitation.id,
            email: invitation.email,
            token,
            roleId: invitation.roleId,
            expiresAt: invitation.expiresAt.toISOString(),
            invitationUrl: invitationUrl(token),
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

        return await _listInvitations({
            status: query.status,
            page: query.page ? Number(query.page) : undefined,
            limit: query.limit ? Number(query.limit) : undefined,
        });
    });

/**
 * POST /_auth/invitations/cancel
 * Cancel invitation (requires user:invite permission and authority over the invitation's role)
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
 * Reissue an invitation with a new link (requires user:invite permission and
 * authority over the invitation's role)
 *
 * The old link stops working. The new token is answered here, once, and goes
 * to the mailer through `auth.invitation.created`.
 */
export const resendInvitation = route.post('/_auth/invitations/resend')
    .input({
        body: Type.Object({
            id: Type.Number({
                description: 'Invitation ID',
            }),
            expiresInDays: Type.Optional(Type.Number({
                minimum: 1,
                maximum: INVITATION_MAX_EXPIRY_DAYS,
                description: 'New expiration period (default: 7)',
            })),
        }),
    })
    .use([authenticate, requirePermissions('user:invite')])
    .handler(async (c) =>
    {
        const { body } = await c.data();
        const { userId } = getAuth(c);

        const { invitation, token } = await _resendInvitation({
            id: body.id,
            resentBy: Number(userId),
            expiresInDays: body.expiresInDays,
        });

        return {
            expiresAt: invitation.expiresAt.toISOString(),
            token,
            invitationUrl: invitationUrl(token),
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
