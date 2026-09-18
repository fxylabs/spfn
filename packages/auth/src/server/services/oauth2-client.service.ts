/**
 * OAuth 2.1 Client Service
 *
 * RFC 7591 dynamic client registration, for public clients and nothing else.
 * `claude mcp add` and `codex mcp add` both begin here: the CLI discovers the
 * authorization server, registers itself unauthenticated, and gets back a
 * `client_id` it keeps on the user's disk.
 *
 * Unauthenticated registration means the table is a place anyone can write, so
 * two things bound it. The route rate-limits by IP, and this service caps how
 * many clients one IP may have standing that nobody has approved — a rate limit
 * alone would let an IP accumulate rows forever at a slow enough pace, because a
 * row costs nothing to make and lives until a job sweeps it. The cap looks back
 * an hour rather than over all time: it is a bound on how much junk one address
 * may have standing at once, not a lifetime quota on how many CLIs somebody may
 * ever connect.
 *
 * Every refusal here is RFC 7591 §3.2.2 shaped (`invalid_redirect_uri`,
 * `invalid_client_metadata`) rather than thrown, because the client reading it
 * is an OAuth client library that knows those two words and not this
 * application's error envelope. The route renders the shape; this decides it.
 */

import { randomBytes } from 'node:crypto';

import { oauth2ClientsRepository } from '../repositories/oauth2-clients.repository';
import type { NewOAuth2Client, OAuth2Client } from '../entities/oauth2-clients';
import { getAuthorizationServerConfig, type AuthorizationServerConfig } from '../lib/oauth2/config';
import { refuseRedirectUriRegistration } from '../lib/oauth2/redirect-uri';
import { toEpochSeconds } from '../lib/oauth2/tokens';
import { authLogger } from '../logger';

/**
 * How many unapproved clients one IP may have standing.
 *
 * Generous against real use — a developer registering the same CLI on four
 * projects in an afternoon, each abandoned at the consent screen, is nowhere
 * near it — and small enough that the table cannot be filled from one address
 * between two sweeps of the purge job.
 */
export const MAX_UNGRANTED_CLIENTS_PER_IP = 20;

/**
 * How far back the cap looks.
 *
 * It bounds the standing population, so it has to expire faster than the purge
 * job frees rows — that job sweeps once a day against a 24-hour threshold, which
 * on its own holds a slot for up to two days. An hour is long enough that a
 * burst is still a burst when the twentieth request arrives, and short enough
 * that an office behind one address is not locked out until tomorrow.
 */
export const UNGRANTED_CLIENT_WINDOW_MS = 60 * 60 * 1000;

/** How long a client nobody approved is kept before the purge job deletes it. */
export const STALE_CLIENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The only auth method a client registered here may declare. */
const SUPPORTED_AUTH_METHOD = 'none';

/** The only grant types this authorization server issues. */
export const SUPPORTED_GRANT_TYPES = ['authorization_code', 'refresh_token'];

/** The only response type. There is no implicit flow here. */
export const SUPPORTED_RESPONSE_TYPES = ['code'];

/** Registration metadata as RFC 7591 names it, before anything is trusted. */
export interface OAuth2RegisterRequest
{
    redirect_uris?: unknown;
    client_name?: unknown;
    token_endpoint_auth_method?: unknown;
    grant_types?: unknown;
    response_types?: unknown;
}

/** RFC 7591 §3.2.1 registration response. */
export interface OAuth2RegisteredClient
{
    client_id: string;
    client_id_issued_at: number;
    client_name: string;
    redirect_uris: string[];
    token_endpoint_auth_method: string;
    grant_types: string[];
    response_types: string[];
}

/** A refusal in the shape the client's own OAuth library will read. */
export interface OAuth2RegisterRefusal
{
    ok: false;
    status: 400 | 429;
    error: string;
    description: string;
}

export type OAuth2RegisterResult =
    | { ok: true; client: OAuth2RegisteredClient }
    | OAuth2RegisterRefusal;

function refuse(status: 400 | 429, error: string, description: string): OAuth2RegisterRefusal
{
    return { ok: false, status, error, description };
}

function requireConfig(): AuthorizationServerConfig
{
    const config = getAuthorizationServerConfig();

    if (!config)
    {
        throw new Error('OAuth2 client service called with no authorization server configured.');
    }

    return config;
}

/** Every string in the array, or null when the value is not an array of strings. */
function asStringArray(value: unknown): string[] | null
{
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string'))
    {
        return null;
    }

    return value as string[];
}

/**
 * The declared metadata that is not about redirect URIs: auth method, grant
 * types, response types. Each is optional, and each is refused when present and
 * not what this server does — a client that asked for `client_credentials` and
 * was answered 201 would fail at the token endpoint instead, with an error it
 * could not act on.
 */
function refuseDeclaredMetadata(request: OAuth2RegisterRequest): OAuth2RegisterRefusal | null
{
    const { token_endpoint_auth_method: authMethod } = request;

    if (authMethod !== undefined && authMethod !== SUPPORTED_AUTH_METHOD)
    {
        return refuse(400, 'invalid_client_metadata',
            `token_endpoint_auth_method must be "${SUPPORTED_AUTH_METHOD}". This authorization server `
            + 'registers public clients only — a client on a user\'s own machine cannot keep a secret.');
    }

    return refuseListedMetadata('grant_types', request.grant_types, SUPPORTED_GRANT_TYPES)
        ?? refuseListedMetadata('response_types', request.response_types, SUPPORTED_RESPONSE_TYPES);
}

/** One optional list field, refused unless every entry is something we support. */
function refuseListedMetadata(
    field: string,
    value: unknown,
    supported: string[],
): OAuth2RegisterRefusal | null
{
    if (value === undefined)
    {
        return null;
    }

    const declared = asStringArray(value);

    if (!declared || declared.length === 0 || declared.some(entry => !supported.includes(entry)))
    {
        return refuse(400, 'invalid_client_metadata',
            `${field} must be a non-empty subset of ${supported.join(', ')}.`);
    }

    return null;
}

/** The redirect URIs, refused one at a time so the message names the offender. */
function refuseRedirectUris(
    uris: unknown,
    allowedRedirectOrigins: string[],
): OAuth2RegisterRefusal | null
{
    const declared = asStringArray(uris);

    if (!declared || declared.length === 0)
    {
        return refuse(400, 'invalid_client_metadata',
            'redirect_uris must list at least one absolute URI. There is nowhere to send an '
            + 'authorization code without one.');
    }

    for (const uri of declared)
    {
        const detail = refuseRedirectUriRegistration(uri, allowedRedirectOrigins);

        if (detail)
        {
            return refuse(400, 'invalid_redirect_uri', detail);
        }
    }

    return null;
}

/**
 * Register a public client.
 *
 * @param request - Metadata exactly as it arrived; nothing here is trusted
 * @param clientIp - Client IP for the standing cap, or null when unknowable
 */
export async function registerOAuth2ClientService(
    request: OAuth2RegisterRequest,
    clientIp: string | null,
): Promise<OAuth2RegisterResult>
{
    const config = requireConfig();
    const refusal = refuseRedirectUris(request.redirect_uris, config.allowedRedirectOrigins)
        ?? refuseDeclaredMetadata(request);

    if (refusal)
    {
        return refusal;
    }

    const record = await createUnderStandingCap(newClientRow(request, clientIp), clientIp);

    if (!record)
    {
        return refuse(429, 'invalid_client_metadata', OVER_STANDING_CAP_MESSAGE);
    }

    // Never the client_id, never a redirect URI: this line exists so an operator
    // can see registration happening, and neither value helps with that.
    authLogger.service.info('OAuth2 client registered', { clientName: record.clientName });

    return { ok: true, client: describeClient(record) };
}

const OVER_STANDING_CAP_MESSAGE =
    `This address has registered ${MAX_UNGRANTED_CLIENTS_PER_IP} clients in the last hour that nobody `
    + 'has approved. Complete or abandon one of those, or try again later.';

/** The row to write, from metadata that has already been refused or accepted. */
function newClientRow(request: OAuth2RegisterRequest, clientIp: string | null): NewOAuth2Client
{
    const redirectUris = asStringArray(request.redirect_uris)!;

    return {
        clientId: `spfn_client_${randomBytes(16).toString('hex')}`,
        clientName: clientNameOf(request.client_name, redirectUris[0]!),
        redirectUris,
        createdIp: clientIp,
    };
}

/**
 * Write the row, under the cap when there is an address to hold against.
 *
 * `getClientIp` answers nothing on a deployment that presents none, and a cap
 * on "no address" would be a single global quota that the first twenty
 * registrations anywhere would exhaust. The route's rate limit is what bounds
 * that case.
 *
 * @returns the registered client, or null when the address is at its cap
 */
async function createUnderStandingCap(
    data: NewOAuth2Client,
    clientIp: string | null,
): Promise<OAuth2Client | null>
{
    if (!clientIp)
    {
        return await oauth2ClientsRepository.create(data);
    }

    return await oauth2ClientsRepository.createWithinStandingCap(data, {
        ip: clientIp,
        max: MAX_UNGRANTED_CLIENTS_PER_IP,
        windowMs: UNGRANTED_CLIENT_WINDOW_MS,
    });
}

/**
 * The label the consent screen shows.
 *
 * A client that sends none gets the host it is asking codes to be sent to, which
 * is the one fact about it the person approving can check. Blank is not allowed
 * to reach the screen: an empty line above "wants access to your account" tells
 * the reader nothing about who is asking.
 */
function clientNameOf(declared: unknown, firstRedirectUri: string): string
{
    if (typeof declared === 'string' && declared.trim())
    {
        return declared.trim();
    }

    return new URL(firstRedirectUri).host;
}

/** RFC 7591 §3.2.1, with the redirect URIs echoed back exactly as registered. */
function describeClient(record: OAuth2Client): OAuth2RegisteredClient
{
    return {
        client_id: record.clientId,
        client_id_issued_at: toEpochSeconds(record.createdAt),
        client_name: record.clientName,
        redirect_uris: record.redirectUris,
        token_endpoint_auth_method: SUPPORTED_AUTH_METHOD,
        grant_types: SUPPORTED_GRANT_TYPES,
        response_types: SUPPORTED_RESPONSE_TYPES,
    };
}

/**
 * Delete clients nobody approved within a day — the `auth.oauth2.client-purge`
 * sweep.
 *
 * @returns how many rows the sweep removed
 */
export async function purgeStaleOAuth2ClientsService(): Promise<{ deleted: number }>
{
    const deleted = await oauth2ClientsRepository.deleteStaleUngranted(
        new Date(Date.now() - STALE_CLIENT_MAX_AGE_MS),
    );

    return { deleted };
}
