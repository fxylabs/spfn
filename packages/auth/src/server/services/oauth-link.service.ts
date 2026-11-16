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

import { onAfterCommit, runInTransaction } from '@spfn/core/db';
import { ValidationError } from '@spfn/core/errors';
import {
    OAuthAccountNotFoundError,
    OAuthLinkNotFoundError,
    OAuthLinkCredentialUnsupportedError,
    OAuthProviderAlreadyLinkedError,
} from '@spfn/auth/errors';

import { socialAccountsRepository, usersRepository, type SocialAccountLink } from '../repositories';
import { isSafeReturnPath } from '../../lib/return-path';
import { type OAuthLinkOutcome } from '../../lib/oauth-link-outcome';
import { resolveAppUrl } from '../lib/app-url';
import {
    buildAuthorizationUrl,
    createOAuthLinkState,
    exchangeCodeVerifier,
    generateCodeVerifier,
    type NormalizedIdentity,
    type OAuthLinkState,
    type OAuthTokens,
} from '../lib/oauth';
import { getOAuthLinkRecentAuthMs, isSignInProvider, linkNeedsRecentAuth } from '../lib/config';
import { type SocialProvider } from '../types';
import { oauthLinkedEvent, oauthLinkRemovedEvent } from '../events';
import { assertStepUp } from './mfa.service';
import {
    assertNotLastRecoveryCredential,
    assertRecentAuthentication,
    type RecentAuthenticationParams,
} from './passkey.service';
import { stampOf } from '../lib/deferred-stamp';
import { admitDeferred, startingCredentialOf } from './deferred-admission.service';
import type { AdmissionRefusal, PrincipalCredential } from './admission.service';
import {
    identifyWithProvider,
    requireEnabledProvider,
    socialAccountConflict,
    tokenExpiryDate,
} from './oauth.service';

export interface StartOAuthLinkParams
{
    provider: SocialProvider;
    userId: number;
    /** The credential the request presented (`getAuth(c).credential`): the link is stamped with it, and its recent authentication asked. */
    credential: PrincipalCredential;
    currentPassword?: string;
    returnUrl: string;
    /** CSRF nonce the Next.js interceptor also set as this start's cookie. */
    nonce: string;
    /** Names that cookie. */
    startId: string;
}

/**
 * Begin a link: check the caller may add a way in, then seal a link state
 * stamped with this device key and the account's key generation
 * (`lib/deferred-stamp.ts`).
 *
 * Only a device key starts one. The callback has no session in front of it
 * and re-admits the starting credential from its row; an application
 * profile's credential is live only while its verifier admits it on a
 * request, which the callback has none of — so such a session is refused
 * here, before anything is sealed, rather than its link completed unchecked.
 *
 * The checks here are early refusals: the callback admits the stamp against
 * the account as it is when the provider sends the browser back, and that is
 * the decision.
 *
 * @throws OAuthLinkCredentialUnsupportedError for a session signed in through an application's auth profile
 * @throws ValidationError for a provider that is not configured or a returnUrl off the app
 * @throws StepUpRequiredError
 * @throws RecentAuthenticationRequiredError unless the app turned the rule off for this provider (#155)
 * @throws OAuthProviderAlreadyLinkedError when the account already holds an identity of the provider
 */
export async function startOAuthLinkService(params: StartOAuthLinkParams): Promise<{ authUrl: string }>
{
    const oauthProvider = requireEnabledProvider(params.provider);
    const startedBy = startingCredentialOf(params.credential);

    if (startedBy.kind !== 'deviceKey')
    {
        throw new OAuthLinkCredentialUnsupportedError();
    }

    if (!isSafeReturnPath(params.returnUrl))
    {
        throw new ValidationError({ message: 'returnUrl must be a relative path within the app' });
    }

    await assertStepUp(params);
    await assertLinkRecentAuthentication(params, 'link');

    // Spares the person a round-trip to the provider when the answer is already
    // known. It is not the authority: a link can land between this read and the
    // callback, and the `(user_id, provider)` constraint is what refuses it there.
    if (await socialAccountsRepository.findByUserIdAndProvider(params.userId, params.provider))
    {
        throw new OAuthProviderAlreadyLinkedError({ details: { provider: params.provider } });
    }

    const account = await usersRepository.findByIdOnPrimary(params.userId);

    if (!account)
    {
        throw new OAuthAccountNotFoundError();
    }

    const codeVerifier = generateCodeVerifier();
    const state = await createOAuthLinkState({
        provider: params.provider,
        userId: String(params.userId),
        returnUrl: params.returnUrl,
        nonce: params.nonce,
        startId: params.startId,
        codeVerifier,
        startedByKeyId: startedBy.keyId,
        keyEpoch: account.keyEpoch,
    });

    return { authUrl: buildAuthorizationUrl(oauthProvider, state, codeVerifier) };
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
 * The provider is asked first, outside any transaction. The writes then run in
 * a transaction this service opens: the account is locked, and the link's
 * stamp admitted under the lock (`linkRefusal`), so two links finishing at
 * once for one account are decided one after the other, and a sign-out or a
 * deletion request that commits meanwhile is seen. A refusal writes nothing
 * and answers its outcome.
 *
 * @throws OAuthProviderError when the provider fails
 */
export async function oauthLinkCallbackService(params: OAuthLinkCallbackParams): Promise<OAuthLinkOutcome>
{
    const oauthProvider = requireEnabledProvider(params.provider);
    const { tokens, identity } = await identifyWithProvider(oauthProvider, params.code, {
        state: params.state,
        codeVerifier: exchangeCodeVerifier(oauthProvider, params.link.codeVerifier),
    });
    const userId = Number(params.link.userId);

    return await runInTransaction(async () =>
    {
        // Lock first, then admit: a sign-out or a status change that commits
        // between an earlier read and the lock would otherwise attach the
        // identity for a session or an account that is no longer there.
        await usersRepository.lockAccount(userId);

        return await linkRefusal(params.link) ?? await attachIdentity(userId, params.provider, identity, tokens);
    }, { context: 'auth:oauth-link-callback' });
}

/** The admission refusals that are about the account rather than the session: `account_unavailable`. */
const ACCOUNT_REFUSALS: ReadonlySet<AdmissionRefusal['reason']> = new Set(['accountMissing', 'accountDisabled', 'pendingDeletion']);

/**
 * Whether the link may complete now, asked under the account lock: the
 * stamp's key — or the key its verified replacements lead to — still live, of
 * the account's key generation, and the person admitted (`admitDeferred`). No
 * session completes a link, so no key is compared (au5-A1). An account that
 * cannot be let in is `account_unavailable`, as it always was; a link whose
 * starting session is gone, whose key generation ended, or that was sealed
 * before stamps existed, `failed` — start it again.
 */
async function linkRefusal(link: OAuthLinkState): Promise<OAuthLinkOutcome | null>
{
    const admission = await admitDeferred(
        stampOf({ userId: Number(link.userId), startedByKeyId: link.startedByKeyId, startedByProfile: null, keyEpoch: link.keyEpoch }),
        { credential: null, route: 'oauthProviderCallback' },
    );

    if (!('refused' in admission))
    {
        return null;
    }

    return admission.refused.reason === 'admission' && ACCOUNT_REFUSALS.has(admission.refused.refusal.reason)
        ? 'account_unavailable'
        : 'failed';
}

/**
 * Attach the identity, or say why not. Nothing is written for a refusal.
 *
 * The insert writes nothing when either rule of the table stands in the way —
 * another account holds the identity, or this account holds another identity of
 * the provider — and `socialAccountConflict` reads which one.
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
        return await socialAccountConflict(provider, identity.providerUserId);
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
    account: SocialAccountLink,
    identity: NormalizedIdentity,
    tokens: OAuthTokens,
): Promise<'linked'>
{
    await socialAccountsRepository.updateTokens(account.id, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
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
    /** The credential the request presented (`getAuth(c).credential`): its step-up window and recent authentication are asked. */
    credential: PrincipalCredential;
    currentPassword?: string;
}

/**
 * Detach the account's identity of `provider`, with its stored tokens.
 *
 * Refused when it is the account's last way to sign in; a link-only provider's
 * identity (#157) is never a way in, so its removal is never refused. The account is locked
 * before anything is read, so two unlinks at once cannot both count the other's
 * identity as the one that remains. Runs under the route's `Transactional()`.
 * Reads the link without its stored tokens, so a token that no longer decrypts
 * does not stand in the way of removing it.
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
    await usersRepository.lockAccount(params.userId);

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

    await socialAccountsRepository.deleteById(account);

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
