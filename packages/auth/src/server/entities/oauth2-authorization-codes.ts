/**
 * @spfn/auth - OAuth 2.1 Authorization Codes Entity
 *
 * The 60-second, single-use ticket the consent screen hands back through the
 * client's own loopback listener, exchanged at the token endpoint for tokens.
 *
 * Only the SHA-256 hash is stored, as with device codes, ops tokens and signup
 * links: a dump of this table must not let its reader finish somebody's
 * authorization. The unique constraint on the hash doubles as the lookup index.
 *
 * `usedAt` is written by the same statement that reads the row, so of two token
 * requests arriving together exactly one gets tokens. A code presented twice is
 * the signature of a stolen code, and the second presentation revokes the whole
 * grant rather than merely refusing — by then the thief may already hold what
 * the first exchange produced.
 */

import { text } from 'drizzle-orm/pg-core';
import { id, timestamps, utcTimestamp, foreignKey } from '@spfn/core/db';
import { oauth2Grants } from './oauth2-grants';
import { authSchema } from './schema';

export const oauth2AuthorizationCodes = authSchema.table('oauth2_authorization_codes',
    {
        id: id(),

        // SHA-256 hex of the code. The code itself (32 random bytes, base64url)
        // is in the redirect and nowhere else.
        codeHash: text('code_hash').notNull().unique(),

        grant: foreignKey('oauth2_grant', () => oauth2Grants.id, { onDelete: 'cascade' }),

        // The exact redirect_uri string the authorize request carried. The token
        // request must repeat it character for character (RFC 6749 §4.1.3).
        redirectUri: text('redirect_uri').notNull(),

        // The PKCE S256 challenge. `code_verifier` at the token endpoint is
        // hashed and compared against this; `plain` is not accepted anywhere,
        // so no method column is needed.
        codeChallenge: text('code_challenge').notNull(),

        // 60 seconds from issuance. Judged by the database in the statement that
        // spends the row, not only in a read before it.
        expiresAt: utcTimestamp('expires_at').notNull(),

        // null = unspent. Non-null means spent, and a second presentation of the
        // same code revokes the grant.
        usedAt: utcTimestamp('used_at'),

        ...timestamps(),
    },
);

// Type exports
export type OAuth2AuthorizationCode = typeof oauth2AuthorizationCodes.$inferSelect;
export type NewOAuth2AuthorizationCode = typeof oauth2AuthorizationCodes.$inferInsert;
