/**
 * @spfn/auth - Revoke-All Link Tokens Entity
 *
 * Backs the signed sign-out-everywhere link: a one-time token an app mails to
 * an account's proven address, which revokes every device key of that account
 * without a session. It is the action an owner can take from a mailbox when the
 * device they would otherwise have to sign in on is the one they no longer
 * trust.
 *
 * `key_epoch` is what makes the link dead rather than merely spent. It records
 * the account's key generation at issue time, and the consume statement joins it
 * against `users.key_epoch` — so a password reset, a password change, a deletion
 * request or an earlier revoke-all, every one of which moves the counter, leaves
 * the outstanding link answering the same 404 an unknown token gets.
 *
 * The token is a bearer credential, so only its SHA-256 hash is stored, the same
 * way the signup and reset links store theirs.
 */

import { text, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, foreignKey, timestamps, utcTimestamp } from '@spfn/core/db';
import { users } from './users';
import { authSchema } from './schema';

export const keyRevokeAllTokens = authSchema.table('key_revoke_all_tokens',
    {
        id: id(),

        // The account whose devices the link signs out
        // Cascades: a hard-deleted account takes its outstanding links with it
        userId: foreignKey('user', () => users.id),

        // SHA-256 of the emailed token, base64url
        // The token itself (32 random bytes) is never stored
        //
        // Not null, unlike the two mailed-link tables: this credential is minted
        // by the call that writes the row and handed straight back to the app,
        // because the package sends no mail for this flow
        tokenHash: text('token_hash').notNull(),

        // users.key_epoch as it stood when the link was issued
        // A link whose generation no longer matches is refused, however much of
        // its TTL is left
        keyEpoch: integer('key_epoch').notNull(),

        // Link expiry — SPFN_AUTH_REVOKE_ALL_LINK_TTL_MINUTES from creation
        expiresAt: utcTimestamp('expires_at').notNull(),

        // Set by the consume statement that spent the link
        // Non-null means spent; it is one-time regardless of expiry, and this is
        // what refuses a replay before the purge sweep gets to the row
        consumedAt: utcTimestamp('consumed_at'),

        // Set when a newer link for the same account replaced this one
        // A superseded row is refused even if it has not expired or been consumed
        supersededAt: utcTimestamp('superseded_at'),

        ...timestamps(),
    },
    (table) => [
        // Lookup path for both confirm and consume
        uniqueIndex('key_revoke_all_token_hash_idx').on(table.tokenHash),

        // Supersede-on-issue scans the account's rows
        index('key_revoke_all_user_id_idx').on(table.userId),

        // Sweeping expired rows
        index('key_revoke_all_expires_at_idx').on(table.expiresAt),
    ],
);

// Type exports
export type KeyRevokeAllToken = typeof keyRevokeAllTokens.$inferSelect;
export type NewKeyRevokeAllToken = typeof keyRevokeAllTokens.$inferInsert;
