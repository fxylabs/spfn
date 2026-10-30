/**
 * Battle.net OAuthProvider (web authorization-code flow, fxylabs/spfn#154).
 *
 * Battle.net releases the account id and the BattleTag and never an email, so
 * every Battle.net identity signs in to its own account: `createOrLinkUser` only
 * matches an existing account by a verified email, and this provider reports
 * none. The account id is the provider user id because a BattleTag can be
 * changed (a paid name change) and the id cannot.
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

/** The OAuth host per region — China runs its own. */
const BATTLENET_HOSTS = {
    global: 'https://oauth.battle.net',
    cn: 'https://oauth.battlenet.com.cn',
} as const;

type BattlenetRegion = keyof typeof BATTLENET_HOSTS;

/** Battle.net access tokens live a day; the token response normally says so itself. */
const BATTLENET_DEFAULT_EXPIRES_IN = 60 * 60 * 24;

interface BattlenetTokenResponse
{
    access_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
}

interface BattlenetUserInfo
{
    sub?: unknown;
    id?: unknown;
    battletag?: unknown;
}

function getBattlenetHost(): string
{
    const region = env.SPFN_AUTH_BATTLENET_REGION || 'global';

    if (!Object.hasOwn(BATTLENET_HOSTS, region))
    {
        throw new ValidationError({
            message: `SPFN_AUTH_BATTLENET_REGION must be "global" or "cn", got "${region}".`,
        });
    }

    return BATTLENET_HOSTS[region as BattlenetRegion];
}

function getBattlenetConfig()
{
    const clientId = env.SPFN_AUTH_BATTLENET_CLIENT_ID;
    const clientSecret = env.SPFN_AUTH_BATTLENET_CLIENT_SECRET;

    if (!clientId || !clientSecret)
    {
        throw new ValidationError({
            message: 'Battle.net OAuth is not configured. Set SPFN_AUTH_BATTLENET_CLIENT_ID and SPFN_AUTH_BATTLENET_CLIENT_SECRET.',
        });
    }

    return {
        clientId,
        clientSecret,
        host: getBattlenetHost(),
        redirectUri: env.SPFN_AUTH_BATTLENET_REDIRECT_URI
            || `${resolveAppUrl()}/_auth/oauth/battlenet/callback`,
    };
}

function getBattlenetScopes(): string[]
{
    const configured = env.SPFN_AUTH_BATTLENET_SCOPES;

    return configured
        ? configured.split(',').map(scope => scope.trim()).filter(Boolean)
        : ['openid'];
}

/** The client credentials as HTTP Basic, which the token endpoint expects. */
function basicAuthorization(clientId: string, clientSecret: string): string
{
    return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

/**
 * The provider user id: userinfo's numeric `id`, else `sub`.
 *
 * Both name the same account; `id` is a number and `sub` its string form. Never
 * the BattleTag.
 */
function accountIdOf(body: BattlenetUserInfo): string
{
    if (typeof body.id === 'number' || (typeof body.id === 'string' && body.id !== ''))
    {
        return String(body.id);
    }

    if (typeof body.sub === 'string' && body.sub !== '')
    {
        return body.sub;
    }

    throw new Error('Battle.net user-info response is missing the account id');
}

export const battlenetProvider: OAuthProvider = {
    id: 'battlenet',

    isEnabled(): boolean
    {
        return !!(env.SPFN_AUTH_BATTLENET_CLIENT_ID && env.SPFN_AUTH_BATTLENET_CLIENT_SECRET);
    },

    getAuthUrl(state: string, scopes?: string[]): string
    {
        const config = getBattlenetConfig();
        const params = new URLSearchParams({
            client_id: config.clientId,
            redirect_uri: config.redirectUri,
            response_type: 'code',
            scope: (scopes ?? getBattlenetScopes()).join(' '),
            state,
        });

        return `${config.host}/authorize?${params.toString()}`;
    },

    async exchangeCodeForTokens(code: string): Promise<OAuthTokens>
    {
        const config = getBattlenetConfig();
        const response = await fetch(`${config.host}/token`, {
            method: 'POST',
            headers: {
                'Authorization': basicAuthorization(config.clientId, config.clientSecret),
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: config.redirectUri,
            }),
        });

        if (!response.ok)
        {
            throw new Error(`Battle.net token request failed with status ${response.status}`);
        }

        const body = await response.json() as BattlenetTokenResponse;
        if (typeof body.access_token !== 'string')
        {
            throw new Error('Battle.net token response is invalid');
        }

        const expiresIn = Number(body.expires_in);

        return {
            accessToken: body.access_token,
            expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : BATTLENET_DEFAULT_EXPIRES_IN,
        };
    },

    async getUserInfo(accessToken: string): Promise<NormalizedIdentity>
    {
        const response = await fetch(`${getBattlenetHost()}/userinfo`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Accept': 'application/json',
            },
        });

        if (!response.ok)
        {
            throw new Error(`Battle.net user-info request failed with status ${response.status}`);
        }

        const body = await response.json() as BattlenetUserInfo;
        const battletag = typeof body.battletag === 'string' && body.battletag !== '' ? body.battletag : undefined;

        return {
            providerUserId: accountIdOf(body),
            email: null,
            emailVerified: false,
            name: battletag,
            handle: battletag,
        };
    },
};

registerOAuthProvider(battlenetProvider);
