/**
 * @spfn/auth - Users Entity
 *
 * Main user table supporting multiple authentication methods
 *
 * Features:
 * - Email or phone-based registration
 * - Password authentication (bcrypt)
 * - OAuth support (nullable passwordHash)
 * - Role-based access control (RBAC)
 * - Account status management
 * - Email/phone verification
 */

import { USER_STATUSES } from '../types';
import { text, boolean, index, integer, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, enumText, utcTimestamp, foreignKey, softDelete } from '@spfn/core/db';
import { roles } from './roles';
import { authSchema } from './schema';

export const users = authSchema.table('users',
    {
        // Identity
        id: id(),

        // Public-facing UUID (for URLs, external APIs)
        // Never expose internal bigserial ID externally
        publicId: uuid('public_id').notNull().unique().defaultRandom(),

        // Email address (unique identifier)
        // Used for: login, password reset, notifications
        email: text('email').unique(),

        // Phone number in E.164 international format
        // Format: +[country code][number] (e.g., +821012345678)
        // Used for: SMS login, 2FA, notifications
        phone: text('phone').unique(),

        // Username (unique, optional)
        // Used for: display, mention, public profile URL
        username: text('username').unique(),

        // Authentication
        // Bcrypt password hash ($2b$10$[salt][hash], 60 chars)
        // Nullable to support OAuth-only accounts
        passwordHash: text('password_hash'),

        // Force password change on next login
        // Use cases: initial setup, security breach, policy violation
        passwordChangeRequired: boolean('password_change_required').notNull().default(false),

        // Authorization (Role-Based Access Control)
        // Foreign key to roles table
        // References built-in roles: user (default), admin, superadmin
        // Can also reference custom roles created at runtime
        roleId: foreignKey('role', () => roles.id),

        // Account status
        // - active: Normal operation (default)
        // - inactive: Deactivated (user request, dormant)
        // - suspended: Locked (security incident, ToS violation)
        // - pending_deletion: Deletion requested, within the grace period (recoverable)
        // - deleted: Grace period elapsed and the account was purged (anonymize mode)
        status: enumText('status', USER_STATUSES).default('active').notNull(),

        // Verification timestamps
        // null = unverified, timestamp = verified at this time
        // Email verification (via verification code or magic link)
        emailVerifiedAt: utcTimestamp('email_verified_at'),

        // Phone verification (via SMS OTP)
        phoneVerifiedAt: utcTimestamp('phone_verified_at'),

        // Generation counter for this account's device keys
        // Incremented in the same statement that revokes every active key, so no
        // caller can revoke globally and forget to move it
        // Used for: binding a signed sign-out-everywhere link to the generation
        // it was issued against — a link is dead once any other path has already
        // signed every device out
        keyEpoch: integer('key_epoch').notNull().default(0),

        // Metadata
        // Last successful login timestamp
        // Used for: security auditing, dormant account detection
        lastLoginAt: utcTimestamp('last_login_at'),

        ...timestamps(),

        // Soft delete (deletedAt / deletedBy) — set when the account deletion purge job
        // anonymizes the row (status -> 'deleted'). Hard-delete mode removes the row
        // instead, so these stay null for that strategy.
        ...softDelete(),
    },
    (table) => [
        // Indexes for query optimization
        index('users_public_id_idx').on(table.publicId),
        index('users_email_idx').on(table.email),
        index('users_phone_idx').on(table.phone),
        index('users_username_idx').on(table.username),
        index('users_status_idx').on(table.status),
        index('users_role_id_idx').on(table.roleId),
    ],
);

// Type exports
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
