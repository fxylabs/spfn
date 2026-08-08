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

/**
 * The longest expiry issuance accepts, about a century in days.
 *
 * A day count becomes a date by arithmetic, and a large enough count overflows
 * the range a date can hold: `Date.now() + 1e11 days` is not a far-off date but
 * an invalid one, and an invalid date reaches the database as a value the
 * driver refuses — a 500 where the caller asked for something the route should
 * simply have declined. The bound is declared in the schema so the refusal is a
 * validation message, and checked again below because the overflow is a
 * property of the product, not of either operand.
 *
 * The `spfn` CLI carries the same number so `--expires-days` can refuse before
 * a request is sent.
 */
const MAX_EXPIRY_DAYS = 36500;

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
            expiresInDays: Type.Optional(Type.Union([
                Type.Number({ exclusiveMinimum: 0, maximum: MAX_EXPIRY_DAYS }),
                Type.Null(),
            ], {
                description: `Days until expiry, up to ${MAX_EXPIRY_DAYS}; null issues a non-expiring token`,
            })),
        }),
    })
    .use([authenticate, requireRole('admin', 'superadmin')])
    .handler(async (c) =>
    {
        const { body } = await c.data();

        const expiresInDays = body.expiresInDays ?? null;
        const expiresAt = expiresInDays === null
            ? null
            : new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

        if (expiresAt && Number.isNaN(expiresAt.getTime()))
        {
            throw new BadRequestError({
                message: `expiresInDays takes 1 to ${MAX_EXPIRY_DAYS} days, or null for no expiry.`,
            });
        }

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
