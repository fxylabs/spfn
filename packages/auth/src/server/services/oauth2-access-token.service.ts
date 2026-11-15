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
 * Three outcomes, and a caller must keep them apart:
 *
 * - **null — the token is not valid.** The same null for every reason —
 *   unknown, revoked, expired, refresh-kind, grant revoked or past its lifetime,
 *   wrong resource, no scope left that the grant still holds, no authorization
 *   server configured (nothing it could have issued). The non-disclosure rule
 *   `verifyOpsTokenService` keeps, for the same reason: this is a public
 *   endpoint and the refusal must not tell a caller whether the value it
 *   presented was ever real. `@spfn/mcp` answers it 401 `invalid_token`, which
 *   sends the client to refresh or re-authorize.
 * - **A thrown 4xx `HttpError` — a valid token whose person may not act right
 *   now.** Today that is `SecondFactorEnrolmentRequiredError` (403,
 *   `SECOND_FACTOR_ENROLMENT_REQUIRED`). Thrown rather than nulled so the holder
 *   of a real token is told why, and so its client keeps the token instead of
 *   re-authorizing for one that would be refused the same way. Nothing is
 *   disclosed to anyone else: every token check above refused first.
 * - **Anything else thrown — a failure, not a refusal.** A database error is
 *   not a verdict on the token, and answering it 401 would tell every connected
 *   client to throw its token away during an outage. It propagates, and the
 *   application's error handler answers it 5xx.
 *
 * What the token authorizes is its grant's to say: the scopes returned are the
 * token's own intersected with the grant's current ones, so a user who narrows
 * a client's consent narrows its tokens already out.
 *
 * The resource check is not a formality. An access token minted for one API is
 * refused by another (RFC 8707), so a token a user approved for their MCP server
 * cannot be replayed against a neighbouring deployment that happens to share this
 * authorization server.
 */

import { isLiveGrant, oauth2GrantsRepository } from '../repositories/oauth2-grants.repository';
import { oauth2TokensRepository } from '../repositories/oauth2-tokens.repository';
import type { OAuth2Token } from '../entities/oauth2-tokens';
import { getAuthorizationServerConfig } from '../lib/oauth2/config';
import { effectiveScopes } from '../lib/oauth2/grant-authority';
import { sameResource } from '../lib/oauth2/resource';
import {
    hashOAuth2Secret,
    isAccessTokenShaped,
    sameOAuth2Hash,
    toEpochSeconds,
} from '../lib/oauth2/tokens';
import { authLogger } from '../logger';
import { assertSecondFactorAdmits } from './second-factor-policy.service';

/** What a verified access token authorizes. */
export interface VerifiedOAuth2AccessToken
{
    /** The public `client_id` of the CLI holding the token. */
    clientId: string;

    /**
     * Scope names the token authorizes now: those it was issued with — as granted,
     * or as the refresh that minted it narrowed them — that its grant still holds.
     * Never empty.
     */
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
 * @returns the principal, or null when the token is not valid, for any reason
 * @throws SecondFactorEnrolmentRequiredError (403) for a valid token whose person may only enrol a
 *         second factor; any other error is a failure to verify, never a refusal
 */
export async function verifyAccessToken(
    token: string,
    resource: string,
): Promise<VerifiedOAuth2AccessToken | null>
{
    const config = getAuthorizationServerConfig();

    // No server configured, no token issued by it: whatever was presented is
    // not one of ours, which is the null every other invalid token gets.
    if (!config || !isAccessTokenShaped(token))
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

    if (!pair || !isLiveGrant(pair.grant) || !sameResource(resource, pair.grant.resource))
    {
        return null;
    }

    const scopes = effectiveScopes(record.scopes, pair.grant);

    if (scopes.length === 0)
    {
        return null;
    }

    // The person the token acts for, under the second-factor policy (#309):
    // an account that may only enrol cannot act through a client either. A
    // throw rather than the null, so the holder of a real token is told why;
    // nothing is disclosed to anyone else, since everything above refused first.
    await assertSecondFactorAdmits(pair.grant.user, null);

    oauth2TokensRepository.updateLastUsedById(record.id)
        .catch((err: unknown) => authLogger.service.error('Failed to update OAuth2 token lastUsedAt', err));

    return {
        clientId: pair.client.clientId,
        scopes,
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
