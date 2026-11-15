/**
 * @spfn/auth - OAuth 2.1 Grants Entity
 *
 * What a user actually consented to: this client, for this resource, with these
 * scopes. Codes and tokens all hang off a grant, so it is the one row that has
 * to be revoked to cut a CLI off — `GET /_auth/oauth2/grants` lists them and
 * `DELETE /_auth/oauth2/grants/:id` is the button.
 *
 * The grant is the one authority over what a client may do now. A token row
 * keeps the scopes it was issued with only as a ceiling: what it authorizes is
 * that ceiling intersected with the grant's current `scopes`, so narrowing the
 * grant narrows every token already out.
 *
 * At most one LIVE row per (client, user, resource). Re-consenting while it is
 * live updates its `scopes` rather than adding a second row, so a user who
 * widens or narrows a CLI's access sees one entry for it. Revocation is
 * terminal: a revoked row is never live again, and reconnecting after a
 * disconnect inserts a new row — so nothing minted under the old one, code or
 * token, can come back with it. A grant also ends on its own at `expires_at`,
 * written once when the row is created; the next consent creates a new one.
 *
 * A global revocation — revoke-all, a password change, a password reset, a
 * deletion request — revokes every grant the user has, for the reason device
 * codes are refused in the same breath: a live grant still has a refresh token
 * against it, and "sign me out everywhere" that leaves one alive has not.
 */

import { sql } from 'drizzle-orm';
import { uniqueIndex, index, text } from 'drizzle-orm/pg-core';
import { id, timestamps, utcTimestamp, foreignKey } from '@spfn/core/db';
import { users } from './users';
import { oauth2Clients } from './oauth2-clients';
import { authSchema } from './schema';

export const oauth2Grants = authSchema.table('oauth2_grants',
    {
        id: id(),

        // `oauth2_client_id` and not `client_id`: the opaque string a client
        // sends is called `client_id` everywhere in the protocol, and a bigint
        // foreign key under that name in this schema would read as that value.
        client: foreignKey('oauth2_client', () => oauth2Clients.id, { onDelete: 'cascade' }),

        // Whose consent this is. Read from the approving session at authorize
        // time, never from a request body — that is the whole authorization.
        user: foreignKey('user', () => users.id, { onDelete: 'cascade' }),

        // The RFC 8707 target this consent is for, normalised (see lib/oauth2).
        // An access token is only good against the resource its grant names.
        resource: text('resource').notNull(),

        // Scope names the user approved. A refresh may ask for a subset of these
        // and never for more.
        scopes: text('scopes').array().notNull(),

        // null = live; a timestamp cuts off every code and token beneath it, for
        // good. Nothing sets it back to null.
        revokedAt: utcTimestamp('revoked_at'),

        // When this consent ends: creation + `authorizationServer.grantLifetimeMs`,
        // written by the application when the row is inserted and never moved.
        // A stored fact, so the SQL and a loaded row compare the same value, and
        // a later change to the lifetime applies only to grants created after it.
        expiresAt: utcTimestamp('expires_at').notNull(),

        ...timestamps(),
    },
    (table) => [
        // One live consent per (client, user, resource) — the re-consent path
        // updates the live row rather than inserting beside it. Revoked rows are
        // outside the index, so reconnecting inserts a fresh grant.
        uniqueIndex('oauth2_grant_live_client_user_resource_idx')
            .on(table.client, table.user, table.resource)
            .where(sql`${table.revokedAt} is null`),

        // The global-revocation path and the user's own grant list both address
        // rows by user alone.
        index('oauth2_grant_user_idx').on(table.user),
    ],
);

// Type exports
export type OAuth2Grant = typeof oauth2Grants.$inferSelect;
export type NewOAuth2Grant = typeof oauth2Grants.$inferInsert;
