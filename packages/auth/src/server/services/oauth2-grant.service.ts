/**
 * OAuth 2.1 Grant Service
 *
 * The user's side of the authorization server: what is connected, and the button
 * that disconnects it. A grant is the unit because it is the thing a person can
 * recognise — "Claude Code, on this API, with these permissions" — and because
 * revoking it takes every code and token underneath with it. The grant's
 * `revoked_at` is the one record of that: codes and tokens are judged against
 * their grant, and a revoked grant is never live again.
 *
 * `revokeAllOAuth2GrantsForUser` is the same act performed on the user's behalf
 * rather than by them, and it sits at the four places that revoke everything:
 * revoke-all, a password change, a completed password reset, a deletion request.
 * A global revocation that left a grant alive would leave a refresh token alive,
 * and a CLI holding one would be signed in again within the hour — which is
 * exactly the device the user was cutting off.
 */

import { runInTransaction } from '@spfn/core/db';
import { OAuth2GrantNotFoundError } from '@spfn/auth/errors';

import { oauth2GrantsRepository } from '../repositories/oauth2-grants.repository';
import { usersRepository } from '../repositories/users.repository';
import { getAuthorizationServerConfig } from '../lib/oauth2/config';
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

/**
 * What a user has connected: their live grants. A revoked grant is gone, and one
 * past its `expiresAt` is too — no token under it is honoured, so listing it would
 * show a connection that does not exist. With no authorization server
 * configured no grant authorizes anything, so none is listed.
 */
export async function listOAuth2GrantsService(userId: number): Promise<OAuth2GrantSummary[]>
{
    const config = getAuthorizationServerConfig();

    if (!config)
    {
        return [];
    }

    const rows = await oauth2GrantsRepository.listLiveByUserId(userId);

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
 * it did not exist rather than as if it were merely not theirs. A grant is
 * credential state, so the write runs under the account lock.
 */
export async function revokeOAuth2GrantService(id: number, userId: number): Promise<void>
{
    const revoked = await runInTransaction(async () =>
    {
        await usersRepository.lockAccount(userId);

        return await oauth2GrantsRepository.revokeByIdForUser(id, userId);
    }, { context: 'auth:oauth2-disconnect' });

    if (!revoked)
    {
        throw new OAuth2GrantNotFoundError();
    }
}

/**
 * Revoke every grant a user has — the authorization-server half of a global
 * revocation, called beside `deviceAuthorizationsRepository.denyAllActiveByUserId`,
 * inside the caller's transaction, which holds the account lock.
 */
export async function revokeAllOAuth2GrantsForUser(userId: number): Promise<void>
{
    const grantIds = await oauth2GrantsRepository.revokeAllActiveByUserId(userId);

    if (grantIds.length === 0)
    {
        return;
    }

    authLogger.service.info('OAuth2 grants revoked for a user', { userId, grants: grantIds.length });
}
