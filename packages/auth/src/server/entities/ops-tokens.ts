/**
 * @spfn/auth - Ops Tokens Entity
 *
 * Machine tokens for the CLI-first ops surface (`@spfn/core/ops`). A token is
 * an operator credential, not a user session: it carries a label and a scope
 * list, and the row stores only the SHA-256 hash of the secret — the secret
 * itself is shown once at issuance and never persisted.
 *
 * Issuance is an operator act, and it goes over HTTP like everything else on
 * this surface: `POST /_auth/ops-tokens`, behind `authenticate`, the
 * `ops:token:issue` permission and a step-up. `spfn ops token issue` signs in
 * as an administrator and calls it, so the CLI needs no database access of its
 * own. The row records that administrator, and the token is honoured only
 * while they could still issue it.
 */

import { text } from 'drizzle-orm/pg-core';
import { id, optionalForeignKey, timestamps, utcTimestamp } from '@spfn/core/db';
import { authSchema } from './schema';
import { users } from './users';

export const opsTokens = authSchema.table('ops_tokens',
    {
        id: id(),

        // Operator-facing label ("ci-deploy", "rayim-laptop")
        name: text('name').notNull(),

        // SHA-256 hex of the token secret. Lookup key — the secret never lands
        // here, and the unique constraint doubles as the lookup index.
        tokenHash: text('token_hash').notNull().unique(),

        // Granted scopes as permission strings ('waitlist:read', ...).
        // '*' grants every scope.
        scopes: text('scopes').array().notNull(),

        // The administrator who issued it. The token borrows their authority:
        // it is honoured only while they are active and still hold
        // `ops:token:issue`. Null only on a token issued before the column
        // existed, and such a token is refused.
        issuedBy: optionalForeignKey('issued_by', () => users.id, { onDelete: 'cascade' }),

        // null = the token does not expire
        expiresAt: utcTimestamp('expires_at'),

        // null = active; a timestamp revokes the token permanently
        revokedAt: utcTimestamp('revoked_at'),

        // Last successful verification, updated fire-and-forget
        lastUsedAt: utcTimestamp('last_used_at'),

        ...timestamps(),
    },
);

// Type exports
export type OpsToken = typeof opsTokens.$inferSelect;
export type NewOpsToken = typeof opsTokens.$inferInsert;
