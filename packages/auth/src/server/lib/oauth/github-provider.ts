/**
 * GitHub OAuthProvider (web authorization-code flow).
 */

import { ValidationError } from '@spfn/core/errors';

import { env } from '../../../config';
import { resolveAppUrl } from '../app-url';
import {
    registerOAuthProvider,
    type NormalizedIdentity,
    type OAuthProvider,
    type OAuthTokens,
} from './provider';

const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USERINFO_URL = 'https://api.github.com/user';
const GITHUB_EMAILS_URL = 'https://api.github.com/user/emails';

/** GitHub requires a User-Agent on every API request. */
const GITHUB_USER_AGENT = 'spfn-auth';

/** Classic OAuth app tokens never expire; GitHub Apps return an explicit expires_in instead. */
const GITHUB_DEFAULT_EXPIRES_IN = 60 * 60 * 24 * 365;

interface GithubTokenResponse
{
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
    error_description?: unknown;
}

interface GithubUserInfo
{
    id?: unknown;
    login?: unknown;
    name?: unknown;
    email?: unknown;
    avatar_url?: unknown;
}

interface GithubEmailEntry
{
    email?: unknown;
    primary?: unknown;
    verified?: unknown;
}

function getGithubConfig()
{
    const clientId = env.SPFN_AUTH_GITHUB_CLIENT_ID;
    const clientSecret = env.SPFN_AUTH_GITHUB_CLIENT_SECRET;

    if (!clientId || !clientSecret)
    {
        throw new ValidationError({
            message: 'GitHub OAuth is not configured. Set SPFN_AUTH_GITHUB_CLIENT_ID and SPFN_AUTH_GITHUB_CLIENT_SECRET.',
        });
    }

    return {
        clientId,
        clientSecret,
        redirectUri: env.SPFN_AUTH_GITHUB_REDIRECT_URI
            || `${resolveAppUrl()}/_auth/oauth/github/callback`,
    };
}

function getGithubScopes(): string[]
{
    const configured = env.SPFN_AUTH_GITHUB_SCOPES;

    return configured
        ? configured.split(',').map(scope => scope.trim()).filter(Boolean)
        : ['read:user', 'user:email'];
}

async function requestGithubTokens(params: URLSearchParams): Promise<OAuthTokens>
{
    const response = await fetch(GITHUB_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
        },
        body: params,
    });

    if (!response.ok)
    {
        throw new Error(`GitHub token request failed with status ${response.status}`);
    }

    // GitHub reports errors (e.g. bad_verification_code) with a 200 status and an error body.
    const body = await response.json() as GithubTokenResponse;
    if (typeof body.error === 'string')
    {
        throw new Error(`GitHub token request failed: ${body.error}`);
    }
    if (typeof body.access_token !== 'string')
    {
        throw new Error('GitHub token response is invalid');
    }

    const expiresIn = Number(body.expires_in);

    return {
        accessToken: body.access_token,
        refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
        expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : GITHUB_DEFAULT_EXPIRES_IN,
    };
}

/**
 * Resolve the primary verified email via /user/emails (needs the user:email scope).
 * Returns null when the scope is missing or no verified email exists.
 */
async function fetchPrimaryEmail(accessToken: string): Promise<{ email: string; verified: boolean } | null>
{
    const response = await fetch(GITHUB_EMAILS_URL, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': GITHUB_USER_AGENT,
        },
    });

    if (!response.ok)
    {
        return null;
    }

    const entries = await response.json() as GithubEmailEntry[];
    if (!Array.isArray(entries))
    {
        return null;
    }

    const primary = entries.find(entry => entry.primary === true && typeof entry.email === 'string')
        ?? entries.find(entry => entry.verified === true && typeof entry.email === 'string');

    return primary
        ? { email: primary.email as string, verified: primary.verified === true }
        : null;
}

export const githubProvider: OAuthProvider = {
    id: 'github',

    isEnabled(): boolean
    {
        return !!(env.SPFN_AUTH_GITHUB_CLIENT_ID && env.SPFN_AUTH_GITHUB_CLIENT_SECRET);
    },

    getAuthUrl(state: string, scopes?: string[]): string
    {
        const config = getGithubConfig();
        const params = new URLSearchParams({
            client_id: config.clientId,
            redirect_uri: config.redirectUri,
            state,
            scope: (scopes ?? getGithubScopes()).join(' '),
        });

        return `${GITHUB_AUTH_URL}?${params.toString()}`;
    },

    async exchangeCodeForTokens(code: string): Promise<OAuthTokens>
    {
        const config = getGithubConfig();

        return requestGithubTokens(new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            redirect_uri: config.redirectUri,
            code,
        }));
    },

    async getUserInfo(accessToken: string): Promise<NormalizedIdentity>
    {
        const response = await fetch(GITHUB_USERINFO_URL, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/vnd.github+json',
                'User-Agent': GITHUB_USER_AGENT,
            },
        });

        if (!response.ok)
        {
            throw new Error(`GitHub user-info request failed with status ${response.status}`);
        }

        const body = await response.json() as GithubUserInfo;
        if (typeof body.id !== 'number' && typeof body.id !== 'string')
        {
            throw new Error('GitHub user-info response is missing the provider user ID');
        }

        const primaryEmail = await fetchPrimaryEmail(accessToken);
        const publicEmail = typeof body.email === 'string' ? body.email : null;

        return {
            providerUserId: String(body.id),
            email: primaryEmail?.email ?? publicEmail,
            emailVerified: primaryEmail?.verified ?? false,
            name: typeof body.name === 'string'
                ? body.name
                : (typeof body.login === 'string' ? body.login : undefined),
            avatar: typeof body.avatar_url === 'string' ? body.avatar_url : undefined,
        };
    },

    async refreshTokens(refreshToken: string): Promise<OAuthTokens>
    {
        const config = getGithubConfig();

        return requestGithubTokens(new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: refreshToken,
        }));
    },
};

registerOAuthProvider(githubProvider);
