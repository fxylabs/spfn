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

import { runInTransaction } from '@spfn/core/db';
import {
    OAuth2AuthorizeRedirectError,
    OAuth2RedirectUriMismatchError,
    OAuth2UnknownClientError,
} from '@spfn/auth/errors';

import { usersRepository } from '../repositories/users.repository';
import { oauth2ClientsRepository } from '../repositories/oauth2-clients.repository';
import { oauth2GrantsRepository } from '../repositories/oauth2-grants.repository';
import { oauth2AuthorizationCodesRepository } from '../repositories/oauth2-authorization-codes.repository';
import type { OAuth2Client } from '../entities/oauth2-clients';
import type { OAuth2Grant } from '../entities/oauth2-grants';
import { getAuthorizationServerConfig, type AuthorizationServerConfig } from '../lib/oauth2/config';
import { matchesRegisteredRedirectUri, redirectHostOf } from '../lib/oauth2/redirect-uri';
import { normalizeResource } from '../lib/oauth2/resource';
import {
    generateAuthorizationCode,
    hashOAuth2Secret,
    isPkceS256ChallengeShaped,
} from '../lib/oauth2/tokens';
import { admissionRefusalError, admitPrincipal, type PrincipalCredential } from './admission.service';
import { checkPasskeyProof } from './passkey.service';
import { assertPasskeyProven } from '../lib/passkey-proof';

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

    /** This server's issuer, which the redirect carries as `iss` (RFC 9207). */
    iss: string;
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
    throw new OAuth2AuthorizeRedirectError({
        error,
        redirectUri,
        state: params.state,
        iss: requireConfig().issuer,
        message,
    });
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

/** The session approving a consent: its account, and what it presented — its device key. */
export interface OAuth2Approver
{
    userId: number;
    credential: PrincipalCredential;
    /**
     * A passkey assertion made for this procedure (`oauth2Consent`), which an
     * account with session binding on must send (`assertPasskeyProven`).
     */
    passkeyResponse?: unknown;
}

/**
 * Record the consent and mint the code.
 *
 * The whole request is validated again rather than carried over from the GET:
 * the form between the two is in the user's browser, and a parameter changed
 * there must be caught here and not honoured because the screen once looked
 * right.
 *
 * The approver comes from the approving session. Never from a request body —
 * that would be the entire authorization.
 *
 * A grant is a standing way in, so it is credential state: the consent locks
 * the account (`lockAccount`) and asks again, under the lock, whether the
 * approving session may still be let in, before anything is written. A
 * password change or revoke-all that committed after `authenticate` admitted
 * this request has revoked the session's key and every grant; this consent is
 * then refused with what the session's next request would be told, and writes
 * no grant and no code.
 *
 * An account with session binding on consents only with a passkey assertion
 * made for it (`lib/passkey-proof.ts`): the grant's refresh token is tied to no
 * key and outlives the bound one. It is checked before the transaction (a
 * failed one spends its challenge) and spent under the lock.
 *
 * @throws PasskeyProofRequiredError when the account is bound and no proof holds
 */
export async function approveOAuth2AuthorizeService(
    params: OAuth2AuthorizeParams,
    approver: OAuth2Approver,
): Promise<OAuth2AuthorizationCodeIssued>
{
    const config = requireConfig();
    const validated = await validate(params);
    const code = generateAuthorizationCode();
    const proof = await checkPasskeyProof({
        userId: approver.userId,
        credential: approver.credential,
        procedure: 'oauth2Consent',
        response: approver.passkeyResponse,
    });

    await runInTransaction(async () =>
    {
        const account = await usersRepository.lockAccount(approver.userId);
        await assertApproverAdmitted(approver);
        await assertPasskeyProven(account, proof, 'oauth2Consent');

        const grant = await recordConsent(validated, approver.userId, config);

        await oauth2AuthorizationCodesRepository.create(approver.userId, {
            codeHash: hashOAuth2Secret(code),
            grant: grant.id,
            redirectUri: validated.redirectUri,
            codeChallenge: validated.codeChallenge,
            expiresAt: new Date(Date.now() + config.codeTtlMs),
        });
    }, { context: 'auth:oauth2-consent' });

    return { code, redirectUri: validated.redirectUri, state: validated.state, iss: config.issuer };
}

/**
 * `admitPrincipal` on what the approving session presented, asked under the
 * account lock.
 *
 * @throws the error `authenticate` answers the same refusal with
 */
async function assertApproverAdmitted(approver: OAuth2Approver): Promise<void>
{
    const admission = await admitPrincipal({
        userId: approver.userId,
        credential: approver.credential,
        route: null,
        presentedOn: null,
    });

    if ('refused' in admission)
    {
        throw admissionRefusalError(admission.refused);
    }
}

/**
 * The live grant this consent amends, or a new one.
 *
 * Amending, not inserting: a user approving a CLI again while it is connected
 * is changing the consent they already gave, and the scopes they approve now
 * are what every token of that grant authorizes from here on, until the
 * `expiresAt` it was created with — amending does not extend it. A grant past
 * its `expiresAt` is ended first, so this consent starts a new grant, with a new
 * `expiresAt` under the lifetime configured now, rather than amending one that
 * no longer authorizes anything. A revoked grant is never
 * amended — the unique index covers live rows only — so reconnecting after a
 * disconnect is a new grant too.
 */
async function recordConsent(
    validated: ValidatedAuthorizeRequest,
    userId: number,
    config: AuthorizationServerConfig,
): Promise<OAuth2Grant>
{
    const key = { client: validated.client.id, user: userId, resource: validated.resource };

    await oauth2GrantsRepository.revokeLapsed(key);

    return await oauth2GrantsRepository.upsert({
        ...key,
        scopes: validated.scopes,
        expiresAt: new Date(Date.now() + config.grantLifetimeMs),
    });
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
        iss: requireConfig().issuer,
        message: 'The account owner refused this authorization request.',
    });
}
