/**
 * OAuth 2.1 Grant Service
 *
 * The user's side of the authorization server: what is connected, and the button
 * that disconnects it. A grant is the unit because it is the thing a person can
 * recognise — "Claude Code, on this API, with these permissions" — and because
 * revoking it takes every code and token underneath with it.
 *
 * `revokeAllOAuth2GrantsForUser` is the same act performed on the user's behalf
 * rather than by them, and it sits at the four places that revoke everything:
 * revoke-all, a password change, a completed password reset, a deletion request.
 * A global revocation that left a grant alive would leave a refresh token alive,
 * and a CLI holding one would be signed in again within the hour — which is
 * exactly the device the user was cutting off.
 */

import { OAuth2GrantNotFoundError } from '@spfn/auth/errors';

import { oauth2GrantsRepository } from '../repositories/oauth2-grants.repository';
import { authLogger } from '../logger';

/** One connected client, as the account settings screen lists it. */
export interface OAuth2GrantSummary
{
    id: number;
    clientId: string;
    clientName: string;
    resource: string;
    scopes: string[];
    createdAtMillis: number;
    lastUsedAtMillis?: number;
}

/** What a user has connected. Revoked grants are not listed — they are gone. */
export async function listOAuth2GrantsService(userId: number): Promise<OAuth2GrantSummary[]>
{
    const rows = await oauth2GrantsRepository.listActiveByUserId(userId);

    return rows.map(({ grant, client }) => ({
        id: Number(grant.id),
        clientId: client.clientId,
        clientName: client.clientName,
        resource: grant.resource,
        scopes: grant.scopes,
        createdAtMillis: grant.createdAt.getTime(),
        lastUsedAtMillis: client.lastUsedAt?.getTime(),
    }));
}

/**
 * Disconnect one client.
 *
 * The user id is part of the statement's condition, not a check before it: the
 * id comes from a URL, and a grant belonging to somebody else must answer as if
 * it did not exist rather than as if it were merely not theirs.
 */
export async function revokeOAuth2GrantService(id: number, userId: number): Promise<void>
{
    const revoked = await oauth2GrantsRepository.revokeByIdForUser(id, userId);

    if (!revoked)
    {
        throw new OAuth2GrantNotFoundError();
    }

    await oauth2GrantsRepository.revokeTokensOfGrants([revoked.id]);
}

/**
 * Revoke every grant a user has — the authorization-server half of a global
 * revocation, called beside `deviceAuthorizationsRepository.denyAllActiveByUserId`.
 *
 * Tokens are revoked as well as the grants. Verification already refuses a token
 * whose grant is dead, so this changes no decision; it means a `SELECT` against
 * `oauth2_tokens` after a revoke-all does not show live-looking rows, which is
 * the sort of thing that gets read as a hole.
 */
export async function revokeAllOAuth2GrantsForUser(userId: number): Promise<void>
{
    const grantIds = await oauth2GrantsRepository.revokeAllActiveByUserId(userId);

    if (grantIds.length === 0)
    {
        return;
    }

    const tokens = await oauth2GrantsRepository.revokeTokensOfGrants(grantIds);

    authLogger.service.info('OAuth2 grants revoked for a user', {
        userId,
        grants: grantIds.length,
        tokens,
    });
}
