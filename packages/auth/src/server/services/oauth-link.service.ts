/**
 * @spfn/auth - OAuth link service (#154)
 *
 * A signed-in user attaches a provider identity to their own account, and can
 * detach it again. This is how an identity that carries no email — Battle.net —
 * reaches an existing account: a sign-in only ever matches an account by a
 * verified email, so without this such an identity can only make a new account.
 *
 * A linked identity is also a way to sign in to the account. Adding or removing
 * one therefore meets the rules a passkey change meets: the second factor stepped
 * up recently when the account has one, and a recent authentication on this
 * device or the current password. One identity per provider per account.
 */

import { onAfterCommit } from '@spfn/core/db';
import { ValidationError } from '@spfn/core/errors';
import {
    OAuthAccountNotFoundError,
    OAuthLinkNotFoundError,
    OAuthProviderAlreadyLinkedError,
} from '@spfn/auth/errors';

import { socialAccountsRepository, usersRepository } from '../repositories';
import { isSafeReturnPath } from '../../lib/return-path';
import { type OAuthLinkOutcome } from '../../lib/oauth-link-outcome';
import { resolveAppUrl } from '../lib/app-url';
import {
    createOAuthLinkState,
    type NormalizedIdentity,
    type OAuthLinkState,
    type OAuthTokens,
} from '../lib/oauth';
import { getOAuthLinkRecentAuthMs, isSignInProvider, linkNeedsRecentAuth } from '../lib/config';
import { type SocialProvider } from '../types';
import { type UserSocialAccount } from '../entities';
import { oauthLinkedEvent, oauthLinkRemovedEvent } from '../events';
import { assertStepUp } from './mfa.service';
import {
    assertNotLastRecoveryCredential,
    assertRecentAuthentication,
    type RecentAuthenticationParams,
} from './passkey.service';
import {
    assertActiveForOAuthSession,
    fromProvider,
    requireEnabledProvider,
    tokenExpiryDate,
} from './oauth.service';

export interface StartOAuthLinkParams
{
    provider: SocialProvider;
    userId: number;
    /** The device key the request is signed with — the recent-authentication window is its age. */
    keyId: string;
    currentPassword?: string;
    returnUrl: string;
    /** CSRF nonce the Next.js interceptor also set as this start's cookie. */
    nonce: string;
    /** Names that cookie. */
    startId: string;
}

/**
 * Begin a link: check the caller may add a way in, then seal a link state.
 *
 * @throws ValidationError for a provider that is not configured or a returnUrl off the app
 * @throws StepUpRequiredError
 * @throws RecentAuthenticationRequiredError unless the app turned the rule off for this provider (#155)
 * @throws OAuthProviderAlreadyLinkedError when the account already holds an identity of the provider
 */
export async function startOAuthLinkService(params: StartOAuthLinkParams): Promise<{ authUrl: string }>
{
    const oauthProvider = requireEnabledProvider(params.provider);

    if (!isSafeReturnPath(params.returnUrl))
    {
        throw new ValidationError({ message: 'returnUrl must be a relative path within the app' });
    }

    await assertStepUp(params);
    await assertLinkRecentAuthentication(params, 'link');

    if (await socialAccountsRepository.findByUserIdAndProvider(params.userId, params.provider))
    {
        throw new OAuthProviderAlreadyLinkedError({ details: { provider: params.provider } });
    }

    const state = await createOAuthLinkState({
        provider: params.provider,
        userId: String(params.userId),
        returnUrl: params.returnUrl,
        nonce: params.nonce,
        startId: params.startId,
    });

    return { authUrl: oauthProvider.getAuthUrl(state) };
}

export interface OAuthLinkCallbackParams
{
    provider: SocialProvider;
    code: string;
    /** The state as the provider returned it; some providers want it again at the code exchange. */
    state: string;
    link: OAuthLinkState;
}

/**
 * Finish a link whose state opened and whose CSRF cookie matched.
 *
 * The account is locked for the rest of the transaction before its status is
 * read, so two links finishing at once for one account are decided one after
 * the other, and a deletion request that commits meanwhile is seen. Runs under
 * the callback route's `Transactional()`.
 *
 * @throws OAuthProviderError when the provider fails; the account-status errors
 *   when the account can no longer sign in
 */
export async function oauthLinkCallbackService(params: OAuthLinkCallbackParams): Promise<OAuthLinkOutcome>
{
    const oauthProvider = requireEnabledProvider(params.provider);
    const tokens = await fromProvider(() => oauthProvider.exchangeCodeForTokens(params.code, { state: params.state }));
    const identity = tokens.identity ?? await fromProvider(() => oauthProvider.getUserInfo(tokens.accessToken));
    const userId = Number(params.link.userId);

    // Lock first, then read the status: a status change that commits between an
    // earlier read and the lock would otherwise attach the identity to an
    // account that is already pending deletion.
    await usersRepository.lockById(userId);
    await assertActiveForOAuthSession(userId, () => new OAuthAccountNotFoundError());

    return await attachIdentity(userId, params.provider, identity, tokens);
}

/**
 * Attach the identity, or say why not. Nothing is written for a refusal.
 *
 * `createIfAbsent` coming back empty means another account attached the same
 * identity between the read and the write; its row stands.
 */
async function attachIdentity(
    userId: number,
    provider: SocialProvider,
    identity: NormalizedIdentity,
    tokens: OAuthTokens,
): Promise<OAuthLinkOutcome>
{
    const owner = await socialAccountsRepository.findByProviderAndProviderId(provider, identity.providerUserId);

    if (owner)
    {
        return owner.userId === userId ? await refreshLink(owner, identity, tokens) : 'linked_elsewhere';
    }

    if (await socialAccountsRepository.findByUserIdAndProvider(userId, provider))
    {
        return 'provider_already_linked';
    }

    const created = await socialAccountsRepository.createIfAbsent({
        userId,
        provider,
        providerUserId: identity.providerUserId,
        providerEmail: identity.email,
        providerHandle: identity.handle ?? null,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        tokenExpiresAt: tokenExpiryDate(tokens.expiresIn),
    });

    if (!created)
    {
        return 'linked_elsewhere';
    }

    onAfterCommit(() => oauthLinkedEvent.emit({
        userId: String(userId),
        provider,
        providerUserId: identity.providerUserId,
        providerHandle: identity.handle,
    }));

    return 'linked';
}

/** Linking an identity the account already holds: keep the row, take the new tokens and handle. */
async function refreshLink(
    account: UserSocialAccount,
    identity: NormalizedIdentity,
    tokens: OAuthTokens,
): Promise<'linked'>
{
    await socialAccountsRepository.updateTokens(account.id, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? account.refreshToken,
        tokenExpiresAt: tokenExpiryDate(tokens.expiresIn),
        providerHandle: identity.handle ?? account.providerHandle,
    });

    return 'linked';
}

/**
 * Where a finished link sends the browser: the page it started on, with the outcome.
 *
 * Absolute on the web app origin, like the sign-in callback's redirect. The
 * returnUrl was checked when it was sealed and is checked again here.
 */
export function oauthLinkResultUrl(link: OAuthLinkState, outcome: OAuthLinkOutcome): string
{
    const url = new URL(isSafeReturnPath(link.returnUrl) ? link.returnUrl : '/', 'http://placeholder');

    url.searchParams.set('oauthLink', outcome);
    url.searchParams.set('provider', link.provider);

    return `${resolveAppUrl()}${url.pathname}${url.search}${url.hash}`;
}

export interface UnlinkOAuthParams
{
    provider: SocialProvider;
    userId: number;
    keyId: string;
    currentPassword?: string;
}

/**
 * Detach the account's identity of `provider`, with its stored tokens.
 *
 * Refused when it is the account's last way to sign in; a link-only provider's
 * identity (#157) is never a way in, so its removal is never refused. The account is locked
 * before anything is read, so two unlinks at once cannot both count the other's
 * identity as the one that remains. Runs under the route's `Transactional()`.
 *
 * Does not depend on the provider being configured: an operator who removed a
 * provider's settings has not taken away the owner's right to detach it.
 *
 * @throws StepUpRequiredError
 * @throws RecentAuthenticationRequiredError unless the app turned the rule off for this provider (#155)
 * @throws OAuthLinkNotFoundError, LastRecoveryCredentialError
 */
export async function unlinkOAuthService(params: UnlinkOAuthParams): Promise<{ provider: SocialProvider }>
{
    await assertStepUp(params);
    await assertLinkRecentAuthentication(params, 'unlink');
    await usersRepository.lockById(params.userId);

    const account = await socialAccountsRepository.findByUserIdAndProvider(params.userId, params.provider);

    if (!account)
    {
        throw new OAuthLinkNotFoundError({ details: { provider: params.provider } });
    }

    // A link-only identity (#157) is no way in, so removing it strands nobody.
    if (isSignInProvider(params.provider))
    {
        await assertNotLastRecoveryCredential(params.userId, 'social');
    }

    await socialAccountsRepository.deleteById(account.id);

    onAfterCommit(() => oauthLinkRemovedEvent.emit({
        userId: String(params.userId),
        provider: params.provider,
        providerUserId: account.providerUserId,
    }));

    return { provider: params.provider };
}

/**
 * The recent-authentication rule on a link or unlink, unless the app turned it
 * off for this provider and action (#155). Held to the link window, which never
 * reads the passkey configuration.
 */
async function assertLinkRecentAuthentication(
    params: RecentAuthenticationParams & { provider: SocialProvider },
    action: 'link' | 'unlink',
): Promise<void>
{
    if (linkNeedsRecentAuth(params.provider, action))
    {
        await assertRecentAuthentication(params, getOAuthLinkRecentAuthMs());
    }
}
