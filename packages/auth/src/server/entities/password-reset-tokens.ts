/**
 * @spfn/auth - Password Reset Tokens Entity
 *
 * Backs the password reset flow: a one-time link is emailed to an address the
 * account has already proved, opening it mints a short-lived setup session, and
 * setting a password on that session replaces the old one and signs the browser
 * in.
 *
 * A separate table from `signup_link_tokens` even though the two carry the same
 * columns. They are the same shape, not the same thing: one names an address
 * that has no account and the other names a user that does, and the setup
 * secrets they mint must not be interchangeable. Sharing one table would make
 * "which flow is this row" a per-row property that the lookup would have to
 * remember to filter on — and a lookup that forgets would accept a signup secret
 * as a reset secret.
 *
 * The link token and the setup secret are bearer credentials, so only their
 * SHA-256 hashes are stored.
 */

import { text, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, foreignKey, timestamps, utcTimestamp } from '@spfn/core/db';
import { users } from './users';
import { authSchema } from './schema';

export const passwordResetTokens = authSchema.table('password_reset_tokens',
    {
        id: id(),

        // The account the reset is for.
        //
        // A user FK and not just the address, unlike the signup table: there is
        // an account here, and the reset must land on the row that existed when
        // the link was issued rather than on whatever owns the address now.
        userId: foreignKey('user', () => users.id),

        // Normalized email address the link was sent to
        email: text('email').notNull(),

        // SHA-256 of the emailed token, base64url
        // The token itself (32 random bytes) is never stored
        //
        // Null until the link is issued. The request writes the row and the
        // `auth.link-mail` job mints the token, so a row exists for a moment
        // with no credential on it; a null never matches a lookup by hash, so a
        // pending row cannot be confirmed. See server/jobs/link-mail.ts.
        tokenHash: text('token_hash'),

        // Relative path to return the user to after the reset completes
        // Validated as a relative path on the way in; never an absolute URL
        returnPath: text('return_path'),

        // Link expiry — SPFN_AUTH_PASSWORD_RESET_LINK_TTL_MINUTES from creation
        expiresAt: utcTimestamp('expires_at').notNull(),

        // Set when the link is exchanged for a setup session
        // Non-null means the link is spent; it is one-time regardless of expiry
        consumedAt: utcTimestamp('consumed_at'),

        // Set when a newer reset request for the same account replaced this one
        // A superseded row is refused even if it has not expired or been consumed
        supersededAt: utcTimestamp('superseded_at'),

        // SHA-256 of the setup session secret, written at consume time
        // The secret lives only in the caller's HttpOnly cookie
        setupSecretHash: text('setup_secret_hash'),

        // Setup session expiry — SPFN_AUTH_PASSWORD_RESET_SETUP_TTL_MINUTES from consume
        setupExpiresAt: utcTimestamp('setup_expires_at'),

        // Terminal: the new password was set
        completedAt: utcTimestamp('completed_at'),

        ...timestamps(),
    },
    (table) => [
        // Lookup path for confirming a link
        uniqueIndex('password_reset_token_hash_idx').on(table.tokenHash),

        // Lookup path for setting the new password
        // Unique so a setup secret can never address two rows
        uniqueIndex('password_reset_setup_secret_hash_idx').on(table.setupSecretHash),

        // Supersede-on-request scans the account's rows
        index('password_reset_user_id_idx').on(table.userId),

        // Sweeping expired rows
        index('password_reset_expires_at_idx').on(table.expiresAt),
    ],
);

// Type exports
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;
