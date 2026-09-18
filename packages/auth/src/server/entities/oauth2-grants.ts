/**
 * @spfn/auth - OAuth 2.1 Grants Entity
 *
 * What a user actually consented to: this client, for this resource, with these
 * scopes. Codes and tokens all hang off a grant, so it is the one row that has
 * to be revoked to cut a CLI off — `GET /_auth/oauth2/grants` lists them and
 * `DELETE /_auth/oauth2/grants/:id` is the button.
 *
 * One row per (client, user, resource). Re-consenting updates `scopes` rather
 * than adding a second row, so a user who widens a CLI's access sees one entry
 * for it and not a pile of them, and revoking that entry revokes everything the
 * client holds.
 *
 * A global revocation — revoke-all, a password change, a password reset, a
 * deletion request — revokes every grant the user has, for the reason device
 * codes are refused in the same breath: a live grant still has a refresh token
 * against it, and "sign me out everywhere" that leaves one alive has not.
 */

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

        // null = live; a timestamp cuts off every code and token beneath it
        revokedAt: utcTimestamp('revoked_at'),

        ...timestamps(),
    },
    (table) => [
        // One consent per (client, user, resource) — the re-consent path updates
        // this row rather than inserting beside it.
        uniqueIndex('oauth2_grant_client_user_resource_idx')
            .on(table.client, table.user, table.resource),

        // The global-revocation path and the user's own grant list both address
        // rows by user alone.
        index('oauth2_grant_user_idx').on(table.user),
    ],
);

// Type exports
export type OAuth2Grant = typeof oauth2Grants.$inferSelect;
export type NewOAuth2Grant = typeof oauth2Grants.$inferInsert;
