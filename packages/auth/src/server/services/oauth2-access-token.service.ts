/**
 * OAuth 2.1 Access Token Verification
 *
 * `verifyAccessToken` is what `@spfn/mcp` calls on every request to `/mcp`. It
 * is the one function in this feature an application wires up by hand:
 *
 * ```typescript
 * createMcpRoute({ validateToken: verifyAccessToken })
 * ```
 *
 * Null for every refusal, and the same null for all of them — unknown, revoked,
 * expired, refresh-kind, grant revoked, wrong resource. The non-disclosure rule
 * `verifyOpsTokenService` keeps, for the same reason: this is a public endpoint
 * and the refusal must not tell a caller whether the value it presented was ever
 * real.
 *
 * The resource check is not a formality. An access token minted for one API is
 * refused by another (RFC 8707), so a token a user approved for their MCP server
 * cannot be replayed against a neighbouring deployment that happens to share this
 * authorization server.
 */

import { oauth2GrantsRepository } from '../repositories/oauth2-grants.repository';
import { oauth2TokensRepository } from '../repositories/oauth2-tokens.repository';
import type { OAuth2Token } from '../entities/oauth2-tokens';
import { sameResource } from '../lib/oauth2/resource';
import {
    hashOAuth2Secret,
    isAccessTokenShaped,
    sameOAuth2Hash,
    toEpochSeconds,
} from '../lib/oauth2/tokens';
import { authLogger } from '../logger';

/** What a verified access token authorizes. */
export interface VerifiedOAuth2AccessToken
{
    /** The public `client_id` of the CLI holding the token. */
    clientId: string;

    /** Scope names, as granted or as the refresh that minted it narrowed them to. */
    scopes: string[];

    /** Expiry as seconds since the epoch — the unit every OAuth field uses. */
    expiresAt: number;

    /** The account the CLI is acting for. */
    userId: string;
}

/**
 * Verify a bearer token presented to a protected resource.
 *
 * @param token - The raw bearer value
 * @param resource - The resource being accessed, e.g. `https://api.example.com/mcp`
 * @returns the principal, or null for any reason at all
 */
export async function verifyAccessToken(
    token: string,
    resource: string,
): Promise<VerifiedOAuth2AccessToken | null>
{
    if (!isAccessTokenShaped(token))
    {
        return null;
    }

    const tokenHash = hashOAuth2Secret(token);
    const record = await oauth2TokensRepository.findByTokenHash(tokenHash);

    if (!record || !sameOAuth2Hash(record.tokenHash, tokenHash) || !isUsable(record))
    {
        return null;
    }

    const pair = await oauth2GrantsRepository.findWithClientById(record.grant);

    if (!pair || pair.grant.revokedAt !== null || !sameResource(resource, pair.grant.resource))
    {
        return null;
    }

    oauth2TokensRepository.updateLastUsedById(record.id)
        .catch((err: unknown) => authLogger.service.error('Failed to update OAuth2 token lastUsedAt', err));

    return {
        clientId: pair.client.clientId,
        scopes: record.scopes,
        expiresAt: toEpochSeconds(record.expiresAt),
        userId: String(pair.grant.user),
    };
}

/**
 * The three things about the row itself.
 *
 * `kind` is checked here rather than in the lookup because a refresh token
 * presented as a bearer credential is a client bug worth failing on, not a row
 * to filter away — and both halves live in one table.
 */
function isUsable(record: OAuth2Token): boolean
{
    return record.kind === 'access'
        && record.revokedAt === null
        && record.expiresAt.getTime() > Date.now();
}
