/**
 * @spfn/auth - OAuth 2.1 Clients Entity
 *
 * One row per public client that registered itself through RFC 7591 dynamic
 * client registration — a `claude mcp add` on somebody's laptop, a `codex`
 * install, a second copy of either on the same machine. There is no secret
 * column because there is no secret: these clients run on the user's own
 * device, cannot keep one, and authenticate with `token_endpoint_auth_method:
 * "none"` plus PKCE.
 *
 * `oauth2_` and not `oauth_`: the `oauth` prefix in this package belongs to the
 * social-login client we are on the other side of (Google, Kakao). Everything
 * named `oauth2` here is the authorization server we run.
 *
 * Registration is unauthenticated by definition, so a row here is nothing but a
 * claim until a user approves it. `auth.oauth2.client-purge` deletes the rows
 * that never were: a client older than a day with no grant against it.
 */

import { text } from 'drizzle-orm/pg-core';
import { id, timestamps, utcTimestamp } from '@spfn/core/db';
import { authSchema } from './schema';

export const oauth2Clients = authSchema.table('oauth2_clients',
    {
        id: id(),

        // The `client_id` the client sends on every later request. Random, opaque,
        // and the unique constraint doubles as the lookup index.
        clientId: text('client_id').notNull().unique(),

        // Self-declared label, shown on the consent screen and nowhere else.
        // A client that lies about it gains one wrong line on that screen.
        clientName: text('client_name').notNull(),

        // Registered redirect URIs, stored exactly as the client wrote them.
        // The registration answer echoes them back verbatim, so normalising here
        // would answer a client with a URI it did not register. Matching
        // normalises both sides instead — see lib/oauth2/redirect-uri.ts.
        redirectUris: text('redirect_uris').array().notNull(),

        // Client IP the registration arrived from, so the per-IP cap on clients
        // nobody has approved yet can be counted. Nullable: an IP is not always
        // knowable behind a proxy that forwards none, and a registration is not
        // worth refusing over that.
        createdIp: text('created_ip'),

        // Last token issuance or refresh under this client, updated
        // fire-and-forget. Operator-facing only; nothing is authorized by it.
        lastUsedAt: utcTimestamp('last_used_at'),

        ...timestamps(),
    },
);

// Type exports
export type OAuth2Client = typeof oauth2Clients.$inferSelect;
export type NewOAuth2Client = typeof oauth2Clients.$inferInsert;
