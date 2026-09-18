/**
 * OAuth 2.1 Authorize Service
 *
 * The API half of the consent screen. The screen itself is a page on the web
 * app, because that is where the session cookie is; it has no database, so it
 * asks here what to draw (`describeOAuth2AuthorizeRequest`) and tells here what
 * the user decided (`approveOAuth2Authorize` / `denyOAuth2Authorize`). Both
 * calls validate the request from scratch — the second must never trust what the
 * first was shown, since a form can be edited between them.
 *
 * Refusals come in two kinds and the split is the security property, not a
 * presentation choice:
 *
 * - **Not redirectable.** An unknown `client_id`, or a `redirect_uri` the client
 *   never registered. There is no vetted URI to send the error to, and sending
 *   it to the one the request supplied is precisely the open redirect the
 *   registration check exists to prevent. These are shown on the screen.
 * - **Redirectable.** Everything else — a missing PKCE challenge, a missing
 *   `resource`, an unknown scope, and the user saying no. The client and its
 *   URI are both vetted by then, so RFC 6749 §4.1.2.1 puts the error back on
 *   that URI as query parameters, which is the only form the waiting CLI can
 *   read.
 */

import {
    OAuth2AuthorizeRedirectError,
    OAuth2RedirectUriMismatchError,
    OAuth2UnknownClientError,
} from '@spfn/auth/errors';

import { oauth2ClientsRepository } from '../repositories/oauth2-clients.repository';
import { oauth2GrantsRepository } from '../repositories/oauth2-grants.repository';
import { oauth2AuthorizationCodesRepository } from '../repositories/oauth2-authorization-codes.repository';
import type { OAuth2Client } from '../entities/oauth2-clients';
import { getAuthorizationServerConfig, type AuthorizationServerConfig } from '../lib/oauth2/config';
import { matchesRegisteredRedirectUri, redirectHostOf } from '../lib/oauth2/redirect-uri';
import { normalizeResource } from '../lib/oauth2/resource';
import {
    generateAuthorizationCode,
    hashOAuth2Secret,
    isPkceS256ChallengeShaped,
} from '../lib/oauth2/tokens';

/** An authorize request as the web handler forwards it, before anything is trusted. */
export interface OAuth2AuthorizeParams
{
    clientId: string;
    redirectUri: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
    resource?: string;
    scope?: string;
    state?: string;
}

/** One scope, with the sentence the consent screen shows for it. */
export interface OAuth2ScopeDescription
{
    name: string;
    description: string;
}

/** Everything the consent screen needs, and nothing it does not. */
export interface OAuth2ConsentView
{
    clientName: string;

    /** Host the code would be sent to — the one fact about the client that is checkable. */
    redirectHost: string;

    scopes: OAuth2ScopeDescription[];
    resource: string;
}

/** What the web handler turns into the success redirect. */
export interface OAuth2AuthorizationCodeIssued
{
    code: string;

    /** The presented URI, which matched a registered one. Safe to redirect to. */
    redirectUri: string;

    /** Echoed back verbatim, or absent when the request carried none. */
    state?: string;
}

/** A request that passed every check, with the values it resolved to. */
interface ValidatedAuthorizeRequest
{
    client: OAuth2Client;
    redirectUri: string;
    resource: string;
    scopes: string[];
    codeChallenge: string;
    state?: string;
}

function requireConfig(): AuthorizationServerConfig
{
    const config = getAuthorizationServerConfig();

    if (!config)
    {
        throw new Error('OAuth2 authorize service called with no authorization server configured.');
    }

    return config;
}

/**
 * The two checks that must happen before any error can be redirected, in the
 * order they can be made: a client, then a URI that client registered.
 */
async function resolveRedirectTarget(
    params: OAuth2AuthorizeParams,
): Promise<{ client: OAuth2Client; redirectUri: string }>
{
    const client = await oauth2ClientsRepository.findByClientId(params.clientId);

    if (!client)
    {
        throw new OAuth2UnknownClientError();
    }

    if (!matchesRegisteredRedirectUri(params.redirectUri, client.redirectUris))
    {
        throw new OAuth2RedirectUriMismatchError();
    }

    return { client, redirectUri: params.redirectUri };
}

/** Space-delimited scope names, or the configured default set when absent. */
function resolveScopes(params: OAuth2AuthorizeParams, config: AuthorizationServerConfig): string[]
{
    const requested = params.scope?.trim();

    if (!requested)
    {
        return config.defaultScopes;
    }

    return requested.split(/\s+/);
}

const PKCE_REQUIRED_MESSAGE =
    'code_challenge with code_challenge_method=S256 is required, and the challenge must be the 43 '
    + 'base64url characters that transform produces. Neither plain PKCE nor a request without PKCE '
    + 'is accepted, because a code intercepted on the loopback listener would otherwise be '
    + 'exchangeable by whoever intercepted it.';

const RESOURCE_REQUIRED_MESSAGE =
    'resource is required and must be an absolute URI with no fragment (RFC 8707). A token issued '
    + 'without a stated target is a token good against everything.';

/**
 * Refuse with an error the client's own redirect URI can carry.
 *
 * Every caller has already vetted `redirectUri` against the registration — that
 * is what makes the error redirectable rather than a screen.
 */
function refuseRedirectable(
    params: OAuth2AuthorizeParams,
    redirectUri: string,
    error: string,
    message: string,
): never
{
    throw new OAuth2AuthorizeRedirectError({ error, redirectUri, state: params.state, message });
}

/** S256 named, and a challenge that could have come out of S256. */
function hasUsableS256Challenge(params: OAuth2AuthorizeParams): boolean
{
    return params.codeChallengeMethod === 'S256'
        && !!params.codeChallenge
        && isPkceS256ChallengeShaped(params.codeChallenge);
}

/**
 * Validate everything downstream of the redirect target, refusing with the
 * redirectable error each failure earns.
 */
function assertRedirectableRules(
    params: OAuth2AuthorizeParams,
    redirectUri: string,
    config: AuthorizationServerConfig,
): { resource: string; scopes: string[]; codeChallenge: string }
{
    if (!hasUsableS256Challenge(params))
    {
        refuseRedirectable(params, redirectUri, 'invalid_request', PKCE_REQUIRED_MESSAGE);
    }

    const resource = params.resource ? normalizeResource(params.resource) : null;

    if (!resource)
    {
        refuseRedirectable(params, redirectUri, 'invalid_target', RESOURCE_REQUIRED_MESSAGE);
    }

    const scopes = resolveScopes(params, config);
    const unknown = scopes.filter(scope => !(scope in config.scopes));

    if (unknown.length > 0)
    {
        refuseRedirectable(params, redirectUri, 'invalid_scope', `Unknown scope: ${unknown.join(', ')}.`);
    }

    return { resource: resource!, scopes, codeChallenge: params.codeChallenge! };
}

async function validate(params: OAuth2AuthorizeParams): Promise<ValidatedAuthorizeRequest>
{
    const config = requireConfig();
    const { client, redirectUri } = await resolveRedirectTarget(params);
    const { resource, scopes, codeChallenge } = assertRedirectableRules(params, redirectUri, config);

    return { client, redirectUri, resource, scopes, codeChallenge, state: params.state };
}

/**
 * What to draw on the consent screen for this request.
 *
 * Read-only: nothing is recorded by looking, so a user who closes the tab has
 * consented to nothing and left nothing behind.
 */
export async function describeOAuth2AuthorizeRequestService(
    params: OAuth2AuthorizeParams,
): Promise<OAuth2ConsentView>
{
    const config = requireConfig();
    const validated = await validate(params);

    return {
        clientName: validated.client.clientName,
        redirectHost: redirectHostOf(validated.redirectUri),
        scopes: validated.scopes.map(name => ({ name, description: config.scopes[name]! })),
        resource: validated.resource,
    };
}

/**
 * Record the consent and mint the code.
 *
 * The whole request is validated again rather than carried over from the GET:
 * the form between the two is in the user's browser, and a parameter changed
 * there must be caught here and not honoured because the screen once looked
 * right.
 *
 * `userId` comes from the approving session. Never from a request body — that
 * would be the entire authorization.
 */
export async function approveOAuth2AuthorizeService(
    params: OAuth2AuthorizeParams,
    userId: number,
): Promise<OAuth2AuthorizationCodeIssued>
{
    const config = requireConfig();
    const validated = await validate(params);

    // Upsert, not insert: a user widening a CLI's scopes is amending the consent
    // they already gave. See the unique index on (client, user, resource).
    const grant = await oauth2GrantsRepository.upsert({
        client: validated.client.id,
        user: userId,
        resource: validated.resource,
        scopes: validated.scopes,
    });

    const code = generateAuthorizationCode();

    await oauth2AuthorizationCodesRepository.create({
        codeHash: hashOAuth2Secret(code),
        grant: grant.id,
        redirectUri: validated.redirectUri,
        codeChallenge: validated.codeChallenge,
        expiresAt: new Date(Date.now() + config.codeTtlMs),
    });

    return { code, redirectUri: validated.redirectUri, state: validated.state };
}

/**
 * The user said no.
 *
 * Validated first, and validated in full — the same `validate` the approval
 * runs. `access_denied` goes back to the client on its redirect URI like any
 * other redirectable error, so the URI has to be one the client registered
 * before anybody is sent to it; and a request that was malformed was malformed
 * whichever button was pressed, so answering `access_denied` to it would tell
 * the waiting client the user refused when in fact it never asked properly.
 * Nothing is recorded — a refusal is not a grant with a flag on it.
 */
export async function denyOAuth2AuthorizeService(params: OAuth2AuthorizeParams): Promise<never>
{
    const validated = await validate(params);

    throw new OAuth2AuthorizeRedirectError({
        error: 'access_denied',
        redirectUri: validated.redirectUri,
        state: validated.state,
        message: 'The account owner refused this authorization request.',
    });
}
