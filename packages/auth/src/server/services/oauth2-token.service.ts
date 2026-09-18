/**
 * OAuth 2.1 Token Service
 *
 * The token endpoint's two grant types, and RFC 7009 revocation.
 *
 * Every failure on this endpoint answers `invalid_grant` — an unknown code, a
 * spent one, an expired one, a mismatched verifier, a code minted for another
 * client, a refresh token that never existed, one that was rotated away. That is
 * not laziness with error messages: the endpoint is public and unauthenticated,
 * and an error that distinguished "this code does not exist" from "this code
 * exists but is not yours" would answer the question an attacker holding a
 * stolen value is actually asking. `invalid_target` and `invalid_scope` are the
 * two exceptions, and both are decided from values the caller already knows.
 *
 * Nothing is spent or revoked before the presenter has shown it is the client the
 * credential belongs to. On the code path that means `client_id`, `redirect_uri`
 * and the PKCE verifier are all checked against the row before the code is
 * consumed — a caller that cannot satisfy them leaves the code unspent for the
 * real client and the grant untouched, because it has proved nothing about
 * itself and must therefore cost nobody anything.
 *
 * Two replays are detected rather than merely refused, and both revoke the whole
 * grant:
 *
 * - A code presented twice. The first exchange already produced tokens; if the
 *   second presentation is the real client, somebody else holds those tokens.
 * - A rotated refresh token presented again. Same reasoning, and it is why a
 *   rotated row is marked rather than deleted — a deleted row is
 *   indistinguishable from one that never existed.
 *
 * Revoking the grant kills the replacement tokens too, which is the point: the
 * thief's pair and the client's pair both hang off the grant, and there is no
 * way to tell which is which.
 */

import { runInTransaction } from '@spfn/core/db';

import { oauth2ClientsRepository } from '../repositories/oauth2-clients.repository';
import {
    oauth2GrantsRepository,
    type OAuth2GrantWithClient,
} from '../repositories/oauth2-grants.repository';
import { oauth2AuthorizationCodesRepository } from '../repositories/oauth2-authorization-codes.repository';
import { oauth2TokensRepository } from '../repositories/oauth2-tokens.repository';
import type { OAuth2Grant } from '../entities/oauth2-grants';
import type { OAuth2Client } from '../entities/oauth2-clients';
import type { OAuth2AuthorizationCode } from '../entities/oauth2-authorization-codes';
import { getAuthorizationServerConfig, type AuthorizationServerConfig } from '../lib/oauth2/config';
import { sameResource } from '../lib/oauth2/resource';
import {
    generateAccessToken,
    generateRefreshToken,
    hashOAuth2Secret,
    isPkceVerifierShaped,
    pkceChallengeFor,
    sameOAuth2Hash,
    secondsUntil,
} from '../lib/oauth2/tokens';
import { authLogger } from '../logger';

/** A token request as RFC 6749 names its fields, before anything is trusted. */
export interface OAuth2TokenRequest
{
    grant_type?: string;
    code?: string;
    code_verifier?: string;
    client_id?: string;
    redirect_uri?: string;
    refresh_token?: string;
    resource?: string;
    scope?: string;
}

/** RFC 6749 §5.1, with `scope` always stated so a narrowed request is legible. */
export interface OAuth2TokenResponse
{
    access_token: string;
    token_type: 'Bearer';
    expires_in: number;
    refresh_token: string;
    scope: string;
}

/** RFC 6749 §5.2: the code, and a sentence for whoever is reading the logs. */
export interface OAuth2TokenRefusal
{
    ok: false;
    error: string;
    description: string;
}

export type OAuth2TokenResult = { ok: true; tokens: OAuth2TokenResponse } | OAuth2TokenRefusal;

/**
 * The one refusal every code and refresh problem collapses into.
 *
 * The description is fixed too. A description that varied with the cause would
 * put back exactly the distinction the single code removes.
 */
function invalidGrant(): OAuth2TokenRefusal
{
    return {
        ok: false,
        error: 'invalid_grant',
        description: 'The authorization code or refresh token is invalid, expired, already used, or was '
            + 'issued to another client.',
    };
}

function refuse(error: string, description: string): OAuth2TokenRefusal
{
    return { ok: false, error, description };
}

function requireConfig(): AuthorizationServerConfig
{
    const config = getAuthorizationServerConfig();

    if (!config)
    {
        throw new Error('OAuth2 token service called with no authorization server configured.');
    }

    return config;
}

/**
 * Exchange a code or refresh a token.
 *
 * @param request - The form or JSON body, exactly as it arrived
 */
export async function oauth2TokenService(request: OAuth2TokenRequest): Promise<OAuth2TokenResult>
{
    if (request.grant_type === 'authorization_code')
    {
        return await exchangeAuthorizationCode(request);
    }

    if (request.grant_type === 'refresh_token')
    {
        return await refreshTokens(request);
    }

    return refuse('unsupported_grant_type',
        'grant_type must be authorization_code or refresh_token.');
}

// ============================================================================
// authorization_code
// ============================================================================

async function exchangeAuthorizationCode(request: OAuth2TokenRequest): Promise<OAuth2TokenResult>
{
    if (!request.code || !request.code_verifier || !request.client_id || !request.redirect_uri)
    {
        return refuse('invalid_request',
            'authorization_code requires code, code_verifier, client_id and redirect_uri.');
    }

    const codeHash = hashOAuth2Secret(request.code);
    const record = await oauth2AuthorizationCodesRepository.findByCodeHash(codeHash);

    if (!record || !sameOAuth2Hash(record.codeHash, codeHash))
    {
        return invalidGrant();
    }

    const pair = await oauth2GrantsRepository.findWithClientById(record.grant);

    if (!pair || pair.grant.revokedAt !== null || !boundToRequest(request, record, pair.client))
    {
        return invalidGrant();
    }

    return await spendBoundCode(request, record, pair);
}

/**
 * The three things the code was bound to at the authorize request, checked
 * before anything is spent or revoked.
 *
 * Nothing about this decision may depend on the code's state: a caller that
 * cannot satisfy these has not shown it is the client the code was issued to,
 * and until it has, its presentation must cost that client nothing — neither
 * the code, which the real client is still on its way to exchange, nor the
 * grant, which the replay path would otherwise revoke on anyone's say-so.
 */
function boundToRequest(
    request: OAuth2TokenRequest,
    record: OAuth2AuthorizationCode,
    client: OAuth2Client,
): boolean
{
    if (request.client_id !== client.clientId || request.redirect_uri !== record.redirectUri)
    {
        return false;
    }

    if (!isPkceVerifierShaped(request.code_verifier!))
    {
        return false;
    }

    // S256 only, so a client that sent its verifier as the challenge (`plain`)
    // hashes to something else here and is refused like any other mismatch.
    return sameOAuth2Hash(pkceChallengeFor(request.code_verifier!), record.codeChallenge);
}

/**
 * Spend a code whose bindings agree, and answer for the two ways it may not be
 * spendable.
 *
 * A row that was already used when this call read it is a replay by the client
 * the code belongs to — the first exchange produced tokens, so somebody else
 * holds them — and the grant dies for it. That includes a client's own retry
 * after a socket timeout: it arrives seconds later, reads a `usedAt` the winning
 * exchange already committed, and is revoked. It has to be. A retry that late is
 * a second presentation of a spent code and nothing in it distinguishes it from
 * a stolen one, which is the 8c row `사용됨 | 일치 | 일치 | 일치`.
 *
 * The benign branch is narrower: a request whose READ found the row unused and
 * whose `consume` then lost the race to the winner, or one whose sixty seconds
 * had passed. Neither is spent here and neither costs the grant.
 */
async function spendBoundCode(
    request: OAuth2TokenRequest,
    record: OAuth2AuthorizationCode,
    pair: OAuth2GrantWithClient,
): Promise<OAuth2TokenResult>
{
    if (record.usedAt !== null)
    {
        await revokeGrantAndTokens(record.grant, 'authorization code presented twice');

        return invalidGrant();
    }

    if (!await oauth2AuthorizationCodesRepository.consume(record.codeHash))
    {
        return invalidGrant();
    }

    if (resolveResource(request.resource, pair.grant) === null)
    {
        return refuse('invalid_target', 'resource does not match the resource this grant was issued for.');
    }

    return { ok: true, tokens: await issueTokenPair(pair.grant, pair.grant.scopes) };
}

// ============================================================================
// refresh_token
// ============================================================================

async function refreshTokens(request: OAuth2TokenRequest): Promise<OAuth2TokenResult>
{
    if (!request.refresh_token || !request.client_id)
    {
        return refuse('invalid_request', 'refresh_token requires refresh_token and client_id.');
    }

    const tokenHash = hashOAuth2Secret(request.refresh_token);
    const presented = await oauth2TokensRepository.findByTokenHash(tokenHash);

    if (!presented || !sameOAuth2Hash(presented.tokenHash, tokenHash) || presented.kind !== 'refresh')
    {
        return invalidGrant();
    }

    if (presented.replacedAt !== null)
    {
        await revokeGrantAndTokens(presented.grant, 'rotated refresh token presented again');

        return invalidGrant();
    }

    if (presented.revokedAt !== null || presented.expiresAt.getTime() <= Date.now())
    {
        return invalidGrant();
    }

    return await rotateRefresh(request, tokenHash, presented.grant, presented.scopes);
}

/**
 * Validate, then rotate, then issue — in that order deliberately.
 *
 * Rotating first would mean a request asking for a scope it cannot have costs
 * the client its refresh token: it would be refused `invalid_scope` while the
 * token it presented was already spent, leaving it with nothing to retry with.
 * So everything that can refuse runs against the row we read, and the rotation
 * is the last thing before issuance — and it is still a conditional statement,
 * so a second request that raced in between wins or loses cleanly.
 */
async function rotateRefresh(
    request: OAuth2TokenRequest,
    tokenHash: string,
    grantId: number,
    presentedScopes: string[],
): Promise<OAuth2TokenResult>
{
    const pair = await oauth2GrantsRepository.findWithClientById(grantId);

    if (!pair || pair.grant.revokedAt !== null || request.client_id !== pair.client.clientId)
    {
        return invalidGrant();
    }

    if (resolveResource(request.resource, pair.grant) === null)
    {
        return refuse('invalid_target', 'resource does not match the resource this grant was issued for.');
    }

    const scopes = resolveRefreshScopes(request.scope, pair.grant, presentedScopes);

    if (!scopes)
    {
        return refuse('invalid_scope', 'A refresh may ask for a subset of the granted scopes, never more.');
    }

    if (!await oauth2TokensRepository.rotate(tokenHash))
    {
        return await refuseLostRotation(tokenHash, grantId);
    }

    return { ok: true, tokens: await issueTokenPair(pair.grant, scopes) };
}

/**
 * The rotation matched nothing after the checks passed, so the row changed
 * underneath us: another request rotated it, or a revocation landed. A re-read
 * says which, and a replay still costs the grant.
 */
async function refuseLostRotation(tokenHash: string, grantId: number): Promise<OAuth2TokenRefusal>
{
    const current = await oauth2TokensRepository.findByTokenHash(tokenHash);

    if (current && current.replacedAt !== null)
    {
        await revokeGrantAndTokens(grantId, 'refresh token rotated twice concurrently');
    }

    return invalidGrant();
}

/**
 * What the new tokens carry: the request's scopes when it named any, otherwise
 * what the presented refresh carried.
 *
 * Narrowing is allowed and is per-request in the sense that matters — the grant
 * is never touched, so the user's consent record still says what they approved
 * and a later refresh may ask for all of it again. Widening past the grant is
 * `invalid_scope`, whatever the presented token carried.
 *
 * @returns the scopes to issue, or null when the request asked for more than the
 *          grant allows
 */
function resolveRefreshScopes(
    requested: string | undefined,
    grant: OAuth2Grant,
    presentedScopes: string[],
): string[] | null
{
    const asked = requested?.trim();

    if (!asked)
    {
        return presentedScopes;
    }

    const scopes = asked.split(/\s+/);

    return scopes.every(scope => grant.scopes.includes(scope)) ? scopes : null;
}

// ============================================================================
// Shared
// ============================================================================

/**
 * The resource this request is for: the one it named, or the grant's when it
 * named none.
 *
 * @returns the grant's resource when the request agrees with it, null otherwise
 */
function resolveResource(requested: string | undefined, grant: OAuth2Grant): string | null
{
    if (!requested)
    {
        return grant.resource;
    }

    return sameResource(requested, grant.resource) ? grant.resource : null;
}

/**
 * Mint an access/refresh pair against a grant.
 *
 * Both rows in one transaction: an access token whose refresh never landed is a
 * client that works for eight hours and then cannot renew, which is a failure
 * nobody would connect to this moment.
 */
async function issueTokenPair(grant: OAuth2Grant, scopes: string[]): Promise<OAuth2TokenResponse>
{
    const config = requireConfig();
    const accessToken = generateAccessToken();
    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + config.accessTokenTtlMs);

    await runInTransaction(async () =>
    {
        await storeToken(accessToken, 'access', grant.id, scopes, expiresAt);
        await storeToken(refreshToken, 'refresh', grant.id, scopes,
            new Date(Date.now() + config.refreshTokenTtlMs));
    });

    oauth2ClientsRepository.updateLastUsedById(grant.client)
        .catch((err: unknown) => authLogger.service.error('Failed to update OAuth2 client lastUsedAt', err));

    return {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: secondsUntil(expiresAt),
        refresh_token: refreshToken,
        scope: scopes.join(' '),
    };
}

/** One token row. The value goes in hashed and is never stored otherwise. */
async function storeToken(
    token: string,
    kind: 'access' | 'refresh',
    grantId: number,
    scopes: string[],
    expiresAt: Date,
): Promise<void>
{
    await oauth2TokensRepository.create({
        tokenHash: hashOAuth2Secret(token),
        kind,
        grant: grantId,
        scopes,
        expiresAt,
    });
}

/**
 * Kill a grant and everything under it — the answer to both replays.
 *
 * The reason is logged and the value that triggered it is not. A token or code
 * in a log line is a credential in a log line.
 */
async function revokeGrantAndTokens(grantId: number, reason: string): Promise<void>
{
    await oauth2GrantsRepository.revokeById(grantId);
    await oauth2GrantsRepository.revokeTokensOfGrants([grantId]);

    authLogger.service.warn('OAuth2 grant revoked after a replay', { grantId, reason });
}

// ============================================================================
// RFC 7009 revocation
// ============================================================================

/**
 * Revoke a presented token.
 *
 * Answers nothing, ever. RFC 7009 §2.2 requires 200 for a token that was never
 * issued as well as for one that was, so a caller cannot use this endpoint to
 * ask whether a value it found somewhere is real.
 *
 * A refresh token takes the grant with it: a client presenting its refresh token
 * here is saying it is finished, and leaving that grant's access tokens alive
 * for eight more hours would be honouring half the request. An access token is
 * revoked alone — a client may be discarding one it no longer needs while still
 * holding the connection.
 *
 * A `client_id` that is not the token's is the same 200 and revokes nothing
 * (RFC 7009 §2.1). The endpoint has no client authentication to lean on, so this
 * does not stop anybody who holds the token from revoking it — what it stops is
 * one client tearing down another's connection by presenting a value it came
 * across, which is the only thing a public client's id can be asked to mean.
 * Which is also why it is required and not optional: RFC 7009 §2.1 has the
 * client authenticate per RFC 6749 §2.3, and §2.3.1 says a public client with no
 * credentials identifies itself with `client_id`. The route refuses a request
 * that carries none before this is called.
 *
 * @param token - The value to revoke, access or refresh
 * @param clientId - Checked against the token's client
 */
export async function revokeOAuth2TokenService(token: string, clientId: string): Promise<void>
{
    if (!token)
    {
        return;
    }

    const tokenHash = hashOAuth2Secret(token);
    const record = await oauth2TokensRepository.findByTokenHash(tokenHash);

    if (!record || !sameOAuth2Hash(record.tokenHash, tokenHash))
    {
        return;
    }

    if (!await issuedToClient(record.grant, clientId))
    {
        return;
    }

    if (record.kind === 'access')
    {
        await oauth2TokensRepository.revokeByTokenHash(tokenHash);

        return;
    }

    await oauth2GrantsRepository.revokeById(record.grant);
    await oauth2GrantsRepository.revokeTokensOfGrants([record.grant]);
}

/** Whether this grant's client is the one the caller claims to be. */
async function issuedToClient(grantId: number, clientId: string): Promise<boolean>
{
    const pair = await oauth2GrantsRepository.findWithClientById(grantId);

    return pair?.client.clientId === clientId;
}
