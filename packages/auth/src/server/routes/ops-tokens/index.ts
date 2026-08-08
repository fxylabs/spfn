/**
 * @spfn/auth - Ops Token Routes
 *
 * Ops token lifecycle over HTTP, authenticated as an administrator. The rest
 * of the ops surface already works this way: `spfn ops list` and `spfn ops
 * call` reach the running application, and these routes let issuance do the
 * same instead of the CLI opening the application's database and writing the
 * row itself.
 *
 * An earlier design refused a token-creation endpoint, reasoning that whatever
 * authenticates the first issuance request is itself a credential. The
 * administrator seeded from environment variables (see `server/setup.ts`) is
 * that credential, and it signs in with a password — so this works in an
 * application whose end users only sign in through a social provider.
 *
 * The secret is returned by issuance and nowhere else: listing answers with
 * records that never carried it, since only its hash was ever stored.
 */

import { Type } from '@sinclair/typebox';
import { route } from '@spfn/core/route';
import { BadRequestError, NotFoundError } from '@spfn/core/errors';

import { authenticate, requireRole } from '../../middleware';
import {
    issueOpsTokenService,
    listOpsTokensService,
    revokeOpsTokenService,
} from '../../services/ops-token.service';
import type { OpsToken } from '../../entities/ops-tokens';

/** What a token looks like to an operator. Never carries the secret. */
function toSummary(record: OpsToken)
{
    return {
        id: Number(record.id),
        name: record.name,
        scopes: record.scopes,
        expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
        revokedAt: record.revokedAt ? record.revokedAt.toISOString() : null,
        lastUsedAt: record.lastUsedAt ? record.lastUsedAt.toISOString() : null,
        createdAt: record.createdAt ? record.createdAt.toISOString() : null,
    };
}

/**
 * POST /_auth/ops-tokens
 * Issue an ops token. The secret is in this answer and nowhere else.
 */
export const issueOpsToken = route.post('/_auth/ops-tokens')
    .input({
        body: Type.Object({
            name: Type.String({ minLength: 1, description: 'Operator-facing label' }),
            scopes: Type.Array(Type.String({ minLength: 1 }), {
                minItems: 1,
                description: "Scopes the token grants ('*' grants all)",
            }),
            expiresInDays: Type.Optional(Type.Union([Type.Number({ exclusiveMinimum: 0 }), Type.Null()], {
                description: 'Days until expiry; null issues a non-expiring token',
            })),
        }),
    })
    .use([authenticate, requireRole('admin', 'superadmin')])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        const expiresInDays = body.expiresInDays ?? null;
        if (expiresInDays !== null && !Number.isFinite(expiresInDays))
        {
            throw new BadRequestError({ message: 'expiresInDays takes a positive number of days, or null.' });
        }

        const expiresAt = expiresInDays === null
            ? null
            : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

        const { token, record } = await issueOpsTokenService(body.name, body.scopes, expiresAt);

        return { token, opsToken: toSummary(record) };
    });

/**
 * GET /_auth/ops-tokens
 * List issued tokens. Secrets were never stored and are never returned.
 */
export const listOpsTokens = route.get('/_auth/ops-tokens')
    .use([authenticate, requireRole('admin', 'superadmin')])
    .handler(async () =>
    {
        return { opsTokens: (await listOpsTokensService()).map(toSummary) };
    });

/**
 * DELETE /_auth/ops-tokens/:id
 * Revoke a token. Revocation is permanent and takes effect immediately.
 */
export const revokeOpsToken = route.delete('/_auth/ops-tokens/:id')
    .input({
        params: Type.Object({
            id: Type.Number({ description: 'Ops token id' }),
        }),
    })
    .use([authenticate, requireRole('admin', 'superadmin')])
    .handler(async (c) =>
    {
        const { params } = await c.data();
        const record = await revokeOpsTokenService(params.id);

        if (!record)
        {
            throw new NotFoundError({ message: `No ops token with id ${params.id} to revoke.` });
        }

        return { opsToken: toSummary(record) };
    });
