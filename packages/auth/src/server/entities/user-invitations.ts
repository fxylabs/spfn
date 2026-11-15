/**
 * @spfn/auth - User Invitations Entity
 *
 * Invitation system for invite-only user registration
 *
 * Features:
 * - Email-based invitations whose link token is stored only as a hash
 * - Role assignment at invitation time
 * - Expiration and status tracking
 * - Audit trail (who invited whom, when accepted)
 * - Metadata support for custom data
 */

import { INVITATION_STATUSES } from '../types';
import { text, index } from 'drizzle-orm/pg-core';
import { id, timestamps, enumText, utcTimestamp, typedJsonb, foreignKey } from '@spfn/core/db';
import { roles } from './roles';
import { users } from './users';
import { authSchema } from './schema';

export const userInvitations = authSchema.table('user_invitations',
    {
        // Primary key
        id: id(),

        // Target email address for the invitation
        // Will become the user's email upon acceptance
        email: text('email').notNull(),

        // Hash of the invitation token (`hashCredential` in lib/link-credentials).
        // The token is a bearer credential — whoever holds it becomes the
        // invitee — so only its hash is stored, like every other link
        // credential. The token itself exists once: in the create (or resend)
        // response and in `auth.invitation.created`, for the invitee's mail.
        tokenHash: text('token_hash').notNull().unique(),

        // Role to be assigned when invitation is accepted
        // Foreign key to roles table
        roleId: foreignKey('role', () => roles.id),

        // User who created this invitation
        // Foreign key to users table
        // Used for: audit trail, permission checks
        invitedBy: foreignKey('invited_by', () => users.id, { onDelete: 'cascade' }),

        // Invitation status
        // - pending: Invitation sent, awaiting acceptance
        // - accepted: User accepted and account created
        // - expired: Invitation expired (automatic)
        // - cancelled: Invitation cancelled by admin
        status: enumText('status', INVITATION_STATUSES).default('pending').notNull(),

        // Expiration timestamp (default: 7 days from creation)
        // Invitation cannot be accepted after this time
        // Background job should update status to 'expired'
        expiresAt: utcTimestamp('expires_at').notNull(),

        // Timestamp when invitation was accepted
        // null = not yet accepted
        // Used for: audit trail, analytics
        acceptedAt: utcTimestamp('accepted_at'),

        // Timestamp when invitation was cancelled
        // null = not cancelled
        // Used for: audit trail
        cancelledAt: utcTimestamp('cancelled_at'),

        // Additional metadata (JSONB)
        // Use cases:
        // - Custom welcome message
        // - Onboarding instructions
        // - Team/department assignment
        // - Custom fields for app-specific data
        // Example: { message: "Welcome!", department: "Engineering" }
        metadata: typedJsonb<Record<string, any>>('metadata'),

        ...timestamps(),
    },
    (table) => [
        // Indexes for query optimization
        index('invitations_token_hash_idx').on(table.tokenHash),
        index('invitations_email_idx').on(table.email),
        index('invitations_status_idx').on(table.status),
        index('invitations_invited_by_idx').on(table.invitedBy),
        index('invitations_expires_at_idx').on(table.expiresAt), // For cleanup jobs
        index('invitations_role_id_idx').on(table.roleId),
    ],
);

// Type exports
export type Invitation = typeof userInvitations.$inferSelect;
export type NewInvitation = typeof userInvitations.$inferInsert;
