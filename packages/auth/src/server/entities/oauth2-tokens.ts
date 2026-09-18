/**
 * @spfn/auth - OAuth 2.1 Tokens Entity
 *
 * Access and refresh tokens alike, one row each, distinguished by `kind`. Both
 * are opaque — `spfn_at_<64 hex>` and `spfn_rt_<64 hex>` — because whatever
 * verifies them is in the same process as this table, which is the same reason
 * ops tokens, device codes and signup links are opaque. A JWT would buy
 * stateless verification and pay for it by making revocation take effect only
 * at expiry, and revocation here is a button the user presses.
 *
 * Only the SHA-256 hash is stored. The value exists in the clear exactly once,
 * in the token response.
 *
 * `replacedAt` is what makes refresh rotation detectable: a rotated refresh is
 * not deleted, it is marked, so presenting it again is distinguishable from
 * presenting one that never existed. That presentation means the token leaked —
 * either the client or the thief is replaying — and the answer is to revoke the
 * grant, which kills the replacement as well.
 */

import { index, text } from 'drizzle-orm/pg-core';
import { id, timestamps, enumText, utcTimestamp, foreignKey } from '@spfn/core/db';
import { oauth2Grants } from './oauth2-grants';
import { authSchema } from './schema';

/**
 * Which half of the pair a row is.
 *
 * One table rather than two: every rule that matters — revoked, expired, whose
 * grant, which scopes — is the same for both, and a single `kind` column keeps
 * "revoke everything under this grant" one statement.
 */
export const OAUTH2_TOKEN_KINDS = ['access', 'refresh'] as const;
export type OAuth2TokenKind = typeof OAUTH2_TOKEN_KINDS[number];

export const oauth2Tokens = authSchema.table('oauth2_tokens',
    {
        id: id(),

        // SHA-256 hex of the token value. Lookup key; the unique constraint
        // doubles as the index.
        tokenHash: text('token_hash').notNull().unique(),

        kind: enumText('kind', OAUTH2_TOKEN_KINDS).notNull(),

        grant: foreignKey('oauth2_grant', () => oauth2Grants.id, { onDelete: 'cascade' }),

        // What this particular token carries, which may be narrower than its
        // grant's scopes: a refresh request is allowed to ask for a subset.
        // Never wider — that is `invalid_scope`.
        scopes: text('scopes').array().notNull(),

        expiresAt: utcTimestamp('expires_at').notNull(),

        // null = live. Set by revoke, by a grant revocation, and by the two
        // replay detections (code reuse, refresh reuse).
        revokedAt: utcTimestamp('revoked_at'),

        // Refresh only: set when a rotation issued the successor. A row with
        // this set is spent, and presenting it revokes the grant.
        replacedAt: utcTimestamp('replaced_at'),

        // Last successful verification, updated fire-and-forget like ops tokens
        lastUsedAt: utcTimestamp('last_used_at'),

        ...timestamps(),
    },
    (table) => [
        // Revocation addresses every token under one grant.
        index('oauth2_token_grant_idx').on(table.grant),
    ],
);

// Type exports
export type OAuth2Token = typeof oauth2Tokens.$inferSelect;
export type NewOAuth2Token = typeof oauth2Tokens.$inferInsert;
