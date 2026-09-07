/**
 * @spfn/auth - Signup Link Tokens Entity
 *
 * Backs the verified-email signup flow: a one-time confirmation link is emailed,
 * opening it mints a short-lived setup session, and setting a password on that
 * session creates the account.
 *
 * A separate table from `verification_codes` on purpose. That table stores its
 * six-digit code in plaintext, which is acceptable for a short-lived numeric code
 * bounded by an attempt counter, but a link token is a bearer credential sitting
 * in someone's mailbox and must only ever be stored as a hash. Sharing one table
 * would make "plaintext or hash" a per-row property that nothing enforces.
 */

import { text, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, timestamps, utcTimestamp } from '@spfn/core/db';
import { authSchema } from './schema';

export const signupLinkTokens = authSchema.table('signup_link_tokens',
    {
        id: id(),

        // Normalized email address the link was issued for
        email: text('email').notNull(),

        // SHA-256 of the emailed token, base64url
        // The token itself (32 random bytes) is never stored
        //
        // Null until the link is issued. The request writes the row and the
        // `auth.link-mail` job mints the token, so a row exists for a moment
        // with no credential on it; a null never matches a lookup by hash, so a
        // pending row cannot be confirmed. See server/jobs/link-mail.ts.
        tokenHash: text('token_hash'),

        // Relative path to return the user to after signup completes
        // Validated as a relative path on the way in; never an absolute URL
        returnPath: text('return_path'),

        // Link expiry — SPFN_AUTH_SIGNUP_LINK_TTL_MINUTES from creation
        expiresAt: utcTimestamp('expires_at').notNull(),

        // Set when the link is exchanged for a setup session
        // Non-null means the link is spent; it is one-time regardless of expiry
        consumedAt: utcTimestamp('consumed_at'),

        // Set when a newer link for the same email replaced this one
        // A superseded row is refused even if it has not expired or been consumed
        supersededAt: utcTimestamp('superseded_at'),

        // SHA-256 of the setup session secret, written at consume time
        // The secret lives only in the caller's HttpOnly cookie
        setupSecretHash: text('setup_secret_hash'),

        // Setup session expiry — SPFN_AUTH_SIGNUP_SETUP_TTL_MINUTES from consume
        setupExpiresAt: utcTimestamp('setup_expires_at'),

        // Terminal: the password was set and the account created
        completedAt: utcTimestamp('completed_at'),

        ...timestamps(),
    },
    (table) => [
        // Lookup path for confirming a link
        uniqueIndex('signup_link_token_hash_idx').on(table.tokenHash),

        // Lookup path for setting a password
        // Unique so a setup secret can never address two rows
        uniqueIndex('signup_link_setup_secret_hash_idx').on(table.setupSecretHash),

        // Supersede-on-resend scans the live rows for one address
        index('signup_link_email_idx').on(table.email, table.expiresAt),
    ],
);

// Type exports
export type SignupLinkToken = typeof signupLinkTokens.$inferSelect;
export type NewSignupLinkToken = typeof signupLinkTokens.$inferInsert;
