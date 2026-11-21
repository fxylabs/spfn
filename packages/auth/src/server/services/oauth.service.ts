/**
 * @spfn/auth - OAuth Service
 *
 * OAuth 인증 비즈니스 로직
 * - Google OAuth Authorization Code Flow
 * - 소셜 계정 연결/생성
 * - publicKey는 state에서 추출하여 등록
 */

import { env } from '@spfn/auth/config';
import { errorLogLevel, isSerializableError, ValidationError } from '@spfn/core/errors';
import { onAfterCommit, runInTransaction } from '@spfn/core/db';
import {
    AccountDisabledError,
    AccountPendingDeletionError,
    OAuthAccountNotFoundError,
    OAuthCookieMissingError,
    OAuthEmailInUseError,
    OAuthProviderAlreadyLinkedError,
    OAuthProviderError,
    OAuthProviderLinkOnlyError,
    OAuthSignInContendedError,
    OAuthStateExpiredError,
    OAuthStateInvalidError,
    SignupDisabledError,
    SignInRefusedError,
    UnverifiedEmailLinkError,
} from '@spfn/auth/errors';

import { usersRepository, socialAccountsRepository, userProfilesRepository, type FoldedEmailMatch } from '../repositories';
import { authLogger } from '../logger';
import { isSafeReturnPath } from '../../lib/return-path';
import { withOAuthErrorReason, type OAuthErrorReason } from '../../lib/oauth-error-reason';
import { timingSafeEqualString } from '../lib/csrf';
import { findStartCookies, legacyStartCookies } from '../lib/oauth/start-cookies';
import { assertSignInProvider, getOAuthEmailMatch, runBeforeRegister } from '../lib/config';
import { resolveAppUrl } from '../lib/app-url';
import { isChannelEnabled } from '../lib/channels-config';
import { uniqueViolationConstraint } from '../lib/unique-violation';
import { type SocialProvider, type KeyAlgorithmType, type SessionBindingType } from '../types';
import type { User } from '../entities/users';
import type { SocialAccountLink } from '../repositories/social-accounts.repository';
import {
    refreshAccessToken,
    createOAuthState,
    verifyOAuthState,
    getOAuthProvider,
    getRegisteredProviders,
    buildAuthorizationUrl,
    exchangeCodeVerifier,
    type OAuthProvider,
    type OAuthCodeExchangeOptions,
    type OAuthState,
    type OAuthTokens,
    type NormalizedIdentity,
    type OAuthLinkState,
    type UnlinkNotification,
} from '../lib/oauth';
import { providerAccountFields } from '../lib/oauth/provider-account';
import { reportAccountRefusal, signInAttempt, type SignInRequest } from './sign-in-guard.service';
import { registerPublicKeyService } from './key.service';
import { updateLastLoginService } from './user.service';
import { accountRefusal, admissionRefusalError } from './admission.service';
import { mfaEnrolledForUser } from './mfa.service';
import { secondFactorEnrolmentFields } from './second-factor-policy.service';
import { authLoginEvent, authRegisterEvent, oauthUnlinkedEvent } from '../events';

export interface OAuthStartParams
{
    provider: SocialProvider;
    returnUrl: string;
    publicKey: string;
    keyId: string;
    fingerprint: string;
    algorithm: KeyAlgorithmType;
    metadata?: Record<string, unknown>;
    /** CSRF nonce bound into the state; the route sets the matching oauth_csrf cookie. */
    nonce?: string;
}

export interface OAuthStartResult
{
    authUrl: string;
}

export interface OAuthCallbackParams
{
    provider: SocialProvider;
    code: string;
    state: string;
    /** Apple only: the raw `user` JSON Apple posts with the first authorization, passed to the code exchange. */
    user?: string;
    /**
     * Value(s) of the oauth_csrf cookie from the callback request. One of them
     * must equal the nonce bound into the (encrypted) state — otherwise the flow
     * wasn't initiated by this browser (login CSRF). The built-in routes pass the
     * one cookie `matchOAuthCallbackCsrf` picked for this state; a custom callback
     * may still pass several candidates. Pass `undefined` or an empty array when
     * absent; verification then fails closed.
     */
    expectedNonce: string | string[] | undefined;
    /** Client address of the callback request, from `deviceProvenance` at the route. */
    ip?: string;
    /** `user-agent` of the callback request, already truncated at the route. */
    userAgent?: string;
    /** Whether proxy-guard recognised the trusted Next.js proxy, from the same helper. */
    webProxy?: boolean;
}

export interface OAuthCallbackResult
{
    redirectUrl: string;
    userId: string;
    keyId: string;
    isNewUser: boolean;
    /**
     * The step-up challenge this callback is carrying, when it is carrying one.
     *
     * Present exactly when the redirect names `mfaChallenge` instead of
     * `userId`/`keyId` (#95). Returned beside the URL so a caller that does not
     * parse the query — a test, or an app mounting its own handler — can tell
     * the two redirects apart.
     */
    mfaChallenge?: string;
}

/**
 * registry에서 provider를 찾아 사용 가능한지 검증 후 반환
 *
 * 미등록과 비활성을 구분해 디버깅 신호를 남긴다.
 * 라우트 레이어에서도 재사용한다(중복 조회/non-null 단언 제거).
 */
export function requireEnabledProvider(provider: SocialProvider): OAuthProvider
{
    const oauthProvider = getOAuthProvider(provider);

    if (!oauthProvider)
    {
        throw new ValidationError({
            message: `Unsupported OAuth provider: ${provider}. No provider is registered for this id.`,
        });
    }

    if (!oauthProvider.isEnabled())
    {
        throw new ValidationError({
            message: `OAuth provider '${provider}' is registered but not configured. Check its required environment variables.`,
        });
    }

    return oauthProvider;
}

/**
 * `requireEnabledProvider`, then refuse a link-only provider (#157).
 *
 * Every sign-in start and the sign-in callback go through this. A link start
 * takes `requireEnabledProvider` alone: linking is what a link-only provider is for.
 *
 * @throws OAuthProviderLinkOnlyError
 */
export function requireSignInProvider(provider: SocialProvider): OAuthProvider
{
    const oauthProvider = requireEnabledProvider(provider);

    assertSignInProvider(provider);

    return oauthProvider;
}

/**
 * provider가 돌려준 만료 초(seconds)를 만료 시각으로 변환 (방어적 검증)
 */
export function tokenExpiryDate(expiresIn: number): Date
{
    if (!Number.isFinite(expiresIn))
    {
        throw new ValidationError({
            message: `Invalid token expiry returned from OAuth provider: ${expiresIn}`,
        });
    }

    return new Date(Date.now() + expiresIn * 1000);
}

/**
 * OAuth 로그인 시작 - Provider 로그인 페이지로 리다이렉트할 URL 생성
 *
 * Next.js에서 키쌍을 생성한 후, publicKey를 state에 포함하여 호출
 */
export async function oauthStartService(
    params: OAuthStartParams,
): Promise<OAuthStartResult>
{
    const { provider, returnUrl, publicKey, keyId, fingerprint, algorithm, metadata, nonce } = params;

    const oauthProvider = requireSignInProvider(provider);

    const state = await createOAuthState({
        provider,
        returnUrl,
        publicKey,
        keyId,
        fingerprint,
        algorithm,
        metadata,
        nonce,
    });

    return { authUrl: await signInAuthorizationUrl(oauthProvider, state) };
}

/**
 * Where a sign-in start sends the browser, for a state sealed here or by the
 * Next.js interceptor: the state is opened for the PKCE verifier it carries, and
 * the provider's URL gets that verifier's challenge (`buildAuthorizationUrl`).
 *
 * @throws OAuthStateInvalidError for a state that does not open, or names another provider
 * @throws OAuthStateExpiredError
 */
export async function signInAuthorizationUrl(oauthProvider: OAuthProvider, sealedState: string): Promise<string>
{
    const stateData = await verifyOAuthState(sealedState);

    if (stateData.provider !== oauthProvider.id)
    {
        throw new OAuthStateInvalidError();
    }

    return buildAuthorizationUrl(oauthProvider, sealedState, stateData.codeVerifier);
}

/**
 * OAuth 콜백 처리 - Code를 Token으로 교환하고 사용자 생성/연결
 *
 * The provider is asked first, outside any transaction: the code exchange and
 * the userinfo call hold no connection while they wait. Everything the sign-in
 * writes then runs in one transaction this service opens, and every refusal is
 * a throw that rolls it back — the route turns the error into the redirect only
 * after that, so a refused sign-in leaves nothing behind (au5-A2). The events
 * are queued with `onAfterCommit` and fire only for a committed sign-in.
 *
 * state에서 publicKey를 추출하여 서버에 등록
 * Next.js는 반환된 userId, keyId로 세션을 구성
 */
export async function oauthCallbackService(
    params: OAuthCallbackParams,
): Promise<OAuthCallbackResult>
{
    const { provider, code, state, expectedNonce } = params;

    // State 검증 및 복호화 (jose enforces the 10m expiry on decrypt)
    const stateData = await verifyOAuthState(state);

    // CSRF: the state's nonce must match an oauth_csrf cookie from THIS browser.
    // A login-CSRF victim (handed the attacker's state) has no matching cookie, so
    // this fails closed before any account is created or any key is registered.
    if (!nonceMatches(stateData.nonce, expectedNonce) || stateData.provider !== provider)
    {
        throw new OAuthStateInvalidError();
    }

    // A link-only provider (#157) is refused before its code is spent: a sign-in
    // state issued before the app turned sign-in off still opens here.
    const oauthProvider = requireSignInProvider(provider);

    const { tokens, identity } = await identifyWithProvider(oauthProvider, code, {
        state,
        user: params.user,
        codeVerifier: exchangeCodeVerifier(oauthProvider, stateData.codeVerifier),
    });

    return await retryContendedSignIn(provider, () => runInTransaction(
        () => persistWebSignIn({ params, stateData, identity, tokens }),
        { context: 'auth:oauth-callback' },
    ));
}

/**
 * The unique constraints a sign-in writes against on the strength of its own
 * earlier reads.
 *
 * `users_email_unique`: a new account takes the identity's verified address
 * (`registerOAuthUser`), and a linked account without one is given it
 * (`fillEmailIfUnheld`), each after a read found no account holding it. The
 * social table's two rules — one account per identity (`provider_user_unique_idx`),
 * one identity per provider per account (`user_social_accounts_user_provider_unique_idx`) —
 * are met by an insert that writes nothing instead of raising, and
 * `signInLinkConflict` names that race `OAuthSignInContendedError`; they are
 * listed so a write that does raise on them is read the same way. A sign-in
 * never writes a phone or a username, and the profile row is insert-if-absent.
 */
const SIGN_IN_PREMISE_CONSTRAINTS = new Set([
    'users_email_unique',
    'provider_user_unique_idx',
    'user_social_accounts_user_provider_unique_idx',
]);

/**
 * Run a sign-in's transaction, and once more if what it read was made stale by
 * a transaction that committed first.
 *
 * A sign-in reads — no link for the identity, no account holding the address —
 * and writes on that premise. A concurrent sign-in or sign-up can commit the
 * same identity or address in between; the write then breaks one of
 * `SIGN_IN_PREMISE_CONSTRAINTS`, or the link insert writes nothing
 * (`OAuthSignInContendedError`), and the transaction rolls back. The premise
 * was stale, not wrong: run again in a new transaction, every read sees what
 * the other one committed — the identity's link, and it is an ordinary sign-in
 * to that account; the address held, and the backfill fills nothing. A link
 * that moved or vanished under the account lock (`StaleAccountLockError`) is
 * the same: the lock taken was the wrong account's, and the next attempt
 * starts with none held. The
 * provider was asked once, before the first attempt; `attempt` only touches the
 * database. A second stale premise is answered `OAuthSignInContendedError`.
 *
 * A refusal, and any other error, is answered as it is, on the first attempt.
 * An attempt that rolls back drops its after-commit events, so they fire once,
 * for the attempt that committed; `beforeRegister` runs in each attempt that
 * makes an account.
 */
export async function retryContendedSignIn<T>(provider: SocialProvider, attempt: () => Promise<T>): Promise<T>
{
    return await attempt().catch((error: unknown) => actedOnStaleRead(error)
        ? attempt().catch((again: unknown) => refuseContendedTwice(provider, again))
        : Promise.reject(error));
}

/** The second attempt's stale premise, as the typed refusal; anything else as it is. */
function refuseContendedTwice(provider: SocialProvider, error: unknown): Promise<never>
{
    return Promise.reject(actedOnStaleRead(error) && !(error instanceof OAuthSignInContendedError)
        ? new OAuthSignInContendedError({ details: { provider } })
        : error);
}

function actedOnStaleRead(error: unknown): boolean
{
    return error instanceof OAuthSignInContendedError
        || error instanceof StaleAccountLockError
        || SIGN_IN_PREMISE_CONSTRAINTS.has(uniqueViolationConstraint(error) ?? '');
}

/**
 * Exchange the code and read who signed in — the provider's two HTTP calls.
 *
 * Called before any transaction opens. A provider whose token response already
 * established the identity (Apple's id_token) is not asked for userinfo.
 */
export async function identifyWithProvider(
    oauthProvider: OAuthProvider,
    code: string,
    options: OAuthCodeExchangeOptions,
): Promise<{ tokens: OAuthTokens; identity: NormalizedIdentity }>
{
    const tokens = await fromProvider(() => oauthProvider.exchangeCodeForTokens(code, options));
    const identity = tokens.identity ?? await fromProvider(() => oauthProvider.getUserInfo(tokens.accessToken));

    return { tokens, identity };
}

interface WebSignIn
{
    params: OAuthCallbackParams;
    stateData: OAuthState;
    identity: NormalizedIdentity;
    tokens: OAuthTokens;
}

/**
 * Everything a web sign-in writes, in the transaction `oauthCallbackService` opened.
 *
 * The account is found or made, its status checked, and the start's key
 * registered; a refusal anywhere throws and nothing stays.
 */
async function persistWebSignIn(signIn: WebSignIn): Promise<OAuthCallbackResult>
{
    const { params, stateData, identity, tokens } = signIn;
    const { userId, isNewUser } = await signInAccount(params.provider, identity, tokens, stateData.metadata);

    // 세션(공개키) 발급 전 계정 상태 검사 — both branches of `signInAccount` meet here.
    await assertActiveForOAuthSession(
        userId,
        () => new OAuthAccountNotFoundError(),
        { channel: 'oauth', request: params, keyId: stateData.keyId },
    );

    // The event payload's row. Whether the key is bound is decided where it is
    // written, under the account lock (`registerPublicKeyService`).
    const user = await usersRepository.findById(userId);

    // No deviceName or platform: the sealed state the start step wrote carries
    // neither, so the event on this channel is the one that names no device.
    const registered = await registerPublicKeyService({
        userId,
        keyId: stateData.keyId,
        publicKey: stateData.publicKey,
        fingerprint: stateData.fingerprint,
        algorithm: stateData.algorithm,
        channel: 'oauth',
        missingAccount: () => new OAuthAccountNotFoundError(),
        ip: params.ip,
        userAgent: params.userAgent,
        webProxy: params.webProxy,
        loginEvent: signInEventFields(params.provider, user, stateData, identity),
    });

    return registered.pending
        ? challengeResult(signIn, userId, isNewUser, registered.challenge.secret)
        : await signedInResult(signIn, { userId, isNewUser, user, registered });
}

/**
 * The account an identity signs in to: the one its social row names, locked
 * (`lockLinkedAccount`) and then given the fresh tokens and handle — or, for an
 * identity no row holds yet, the one `createOrLinkUser` finds or makes.
 */
async function signInAccount(
    provider: SocialProvider,
    identity: NormalizedIdentity,
    tokens: OAuthTokens,
    metadata: Record<string, unknown> | undefined,
): Promise<{ userId: number; isNewUser: boolean }>
{
    const existing = await lockLinkedAccount(provider, identity.providerUserId);

    if (!existing)
    {
        return await createOrLinkUser(provider, identity, tokens, metadata);
    }

    // A provider that sent no new refresh token leaves the stored one as it is.
    await socialAccountsRepository.updateTokens(existing.id, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenExpiresAt: tokenExpiryDate(tokens.expiresIn),
        providerHandle: identity.handle ?? existing.providerHandle,
    });
    await backfillVerifiedEmail(existing.userId, identity);

    return { userId: existing.userId, isNewUser: false };
}

/** What the login and register events say about this sign-in, beside the user id. */
function signInEventFields(
    provider: SocialProvider,
    user: User | null | undefined,
    stateData: OAuthState,
    identity: NormalizedIdentity,
)
{
    return {
        provider,
        email: user?.email || undefined,
        phone: user?.phone || undefined,
        metadata: stateData.metadata,
        ...providerAccountFields(identity),
    };
}

/** The callback page's URL, absolute on the web app origin unless configured absolute. */
function oauthCallbackPageUrl(): string
{
    const callbackPath = env.SPFN_AUTH_OAUTH_SUCCESS_URL || '/auth/callback';

    return callbackPath.startsWith('http') ? callbackPath : `${resolveAppUrl()}${callbackPath}`;
}

/**
 * An enrolled account on a new device is redirected with a challenge (#95): no
 * `userId`, and neither the login event nor `lastLoginAt`. The `keyId` rides
 * along (#126) — not a session, but the name of the start whose pending cookie
 * holds the private key, so the proxy can pick that cookie when it bakes the
 * second-factor one while other starts are in flight. A brand-new social
 * account never reaches this: it has no second factor to ask for.
 */
function challengeResult(signIn: WebSignIn, userId: number, isNewUser: boolean, challenge: string): OAuthCallbackResult
{
    const { stateData } = signIn;

    return {
        redirectUrl: buildRedirectUrl(oauthCallbackPageUrl(), {
            mfaChallenge: challenge,
            keyId: stateData.keyId,
            returnUrl: safeReturnUrl(stateData),
            isNewUser: String(isNewUser),
        }),
        userId: String(userId),
        keyId: stateData.keyId,
        isNewUser,
        mfaChallenge: challenge,
    };
}

/**
 * Defence in depth: the state is sealed, so its returnUrl was already checked
 * where it was sealed. Checking it again keeps a destination that leaves the app
 * out of the callback URL no matter which seam sealed it.
 */
function safeReturnUrl(stateData: OAuthState): string
{
    return isSafeReturnPath(stateData.returnUrl) ? stateData.returnUrl : '/';
}

interface SignedIn
{
    userId: number;
    isNewUser: boolean;
    user: User | null | undefined;
    registered: { binding: SessionBindingType; expiresAt: Date | null };
}

/**
 * A finished sign-in: `lastLoginAt`, the redirect to the callback page (which
 * calls `oauthFinalize` to seal the session), and the event queued for after
 * the commit — register for a new account, login otherwise.
 */
async function signedInResult(signIn: WebSignIn, signedIn: SignedIn): Promise<OAuthCallbackResult>
{
    const { params, stateData, identity } = signIn;
    const { userId, isNewUser } = signedIn;

    await updateLastLoginService(userId);

    // The callback page and `createOAuthCallbackHandler` are the two seams that
    // seal a session out of this redirect, and neither calls a route that could
    // tell them the key is bound. The binding values ride the query for the same
    // reason `userId` and `keyId` do — and, like those, nothing is authorized by
    // them: the key row already expires when it says it does.
    const redirectUrl = buildRedirectUrl(oauthCallbackPageUrl(), {
        userId: String(userId),
        keyId: stateData.keyId,
        returnUrl: safeReturnUrl(stateData),
        isNewUser: String(isNewUser),
        ...bindingRedirectParams(signedIn.registered),
    });

    await queueSignInEvent(userId, isNewUser, signInEventFields(params.provider, signedIn.user, stateData, identity));

    return { redirectUrl, userId: String(userId), keyId: stateData.keyId, isNewUser };
}

/**
 * After the commit, never inline: an inline emit would announce a user another
 * connection cannot read yet, or one a rollback then erased. `mfaEnrolled` is on
 * the login event only — a brand-new account cannot have a second factor. Read
 * before the callback is queued, so the callback stays synchronous.
 */
async function queueSignInEvent(
    userId: number,
    isNewUser: boolean,
    fields: ReturnType<typeof signInEventFields>,
): Promise<void>
{
    const eventPayload = { userId: String(userId), ...fields };
    const mfaEnrolled = isNewUser ? false : await mfaEnrolledForUser(userId);
    const { secondFactorEnrolmentRequired } = await secondFactorEnrolmentFields(userId);

    onAfterCommit(() => (isNewUser
        ? authRegisterEvent.emit(eventPayload)
        : authLoginEvent.emit({
            ...eventPayload,
            mfaEnrolled,
            secondFactorEnrolmentRequired: secondFactorEnrolmentRequired === true,
        })));
}

/**
 * Pick the CSRF cookie a callback's state names, and prove it belongs to this start (#126).
 *
 * The state is verified first: until it decrypts it is attacker-supplied, so no
 * cookie is looked up because of it. Its keyId then names the per-start cookies
 * (any port suffix, any issuedAt) — more than one when a client started twice
 * with one key; a start made before per-start cookies has only the legacy name,
 * which is the fallback. Each value is compared with the state's nonce in
 * constant time — that comparison, not the name, is what keeps a state minted in
 * another browser out, since a cookie can only have been set by this browser's
 * own start.
 *
 * A state that names another provider is refused before any cookie is read.
 * Only past that is a missing cookie told apart (#129): no candidate at all is
 * `OAuthCookieMissingError`, while candidates none of which holds the nonce
 * stay `OAuthStateInvalidError`.
 *
 * Reads, never expires: the route expires the returned name, and only that one.
 *
 * @throws OAuthStateExpiredError, OAuthStateInvalidError, OAuthCookieMissingError
 */
export async function matchOAuthCallbackCsrf(params: {
    provider: SocialProvider;
    state: string;
    cookies: Record<string, string>;
}): Promise<{ name: string; nonce: string }>
{
    const stateData = await verifyOAuthState(params.state);

    if (stateData.provider !== params.provider)
    {
        throw new OAuthStateInvalidError();
    }

    const match = cookieHoldingNonce(presentCsrfCandidates(stateData.keyId, params.cookies), stateData.nonce);

    if (!match)
    {
        throw new OAuthStateInvalidError();
    }

    return { name: match.name, nonce: match.value };
}

/**
 * The link start's CSRF cookie, proven to hold the link state's nonce (#154) — its name, to expire.
 *
 * The double-submit `matchOAuthCallbackCsrf` runs for a sign-in, keyed by the
 * start id the link state carries instead of a keyId. A link start writes only
 * per-start cookies, so the legacy fixed name is never a candidate.
 *
 * @throws OAuthStateInvalidError, OAuthCookieMissingError
 */
export function matchOAuthLinkCsrf(params: {
    provider: SocialProvider;
    link: OAuthLinkState;
    cookies: Record<string, string>;
}): string
{
    if (params.link.provider !== params.provider)
    {
        throw new OAuthStateInvalidError();
    }

    const candidates = findStartCookies('csrf', params.cookies, params.link.startId);

    if (candidates.length === 0)
    {
        throw new OAuthCookieMissingError();
    }

    const match = cookieHoldingNonce(candidates, params.link.nonce);

    if (!match)
    {
        throw new OAuthStateInvalidError();
    }

    return match.name;
}

/** The CSRF candidates for `keyId`, refused with `OAuthCookieMissingError` when there are none. */
function presentCsrfCandidates(keyId: string, cookies: Record<string, string>): { name: string; value: string }[]
{
    const candidates = csrfCandidates(keyId, cookies);

    if (candidates.length === 0)
    {
        throw new OAuthCookieMissingError();
    }

    return candidates;
}

/** The start's own CSRF cookies, else the legacy ones — never both. */
function csrfCandidates(keyId: string, cookies: Record<string, string>): { name: string; value: string }[]
{
    const perStart = findStartCookies('csrf', cookies, keyId);

    return perStart.length > 0 ? perStart : legacyStartCookies('csrf', cookies);
}

/**
 * The candidate whose value is the nonce. Every candidate is compared, in
 * constant time, before one is picked, so how long this takes does not say
 * which position matched.
 */
function cookieHoldingNonce(
    candidates: { name: string; value: string }[],
    nonce: string,
): { name: string; value: string } | undefined
{
    const matches = candidates.map(cookie => timingSafeEqualString(cookie.value, nonce));

    return candidates[matches.indexOf(true)];
}

/** Whether one of the cookie values equals the state's nonce, compared in constant time. */
function nonceMatches(nonce: string, expected: string | string[] | undefined): boolean
{
    const candidates = typeof expected === 'string' ? [expected] : expected ?? [];

    return candidates.some(candidate => timingSafeEqualString(candidate, nonce));
}

/**
 * A provider call whose failure reaches the browser as one fixed sentence.
 *
 * Whatever the provider or its HTTP client threw stays in the log; the redirect
 * carries `OAuthProviderError` and `reason=provider_error` (#126).
 */
export async function fromProvider<T>(call: () => Promise<T>): Promise<T>
{
    return await Promise.resolve()
        .then(call)
        .catch((cause: unknown) =>
        {
            authLogger.service.warn('OAuth provider call failed', { error: cause });

            return Promise.reject(new OAuthProviderError());
        });
}

/**
 * A sign-in locked the account its unlocked read named, and the read taken
 * again under the lock names another — or none: the link moved, or was
 * unlinked, in between. The transaction holds the wrong account's lock, and
 * going on would mean a second lock (the account the link moved to, or the one
 * an attach-by-email names) or an app hook (`beforeRegister`) under it, so it
 * rolls back instead and `retryContendedSignIn` runs the resolution again from
 * nothing held. Internal: a second occurrence is answered
 * `OAuthSignInContendedError`.
 */
export class StaleAccountLockError extends Error
{
    constructor()
    {
        super('The account a sign-in locked is no longer the one its identity names');
        this.name = 'StaleAccountLockError';
    }
}

/**
 * The identity's link, with the account it names locked
 * (`usersRepository.lockAccount`) before anything is written for it, and read
 * again under that lock. A link that moved or vanished in between is a stale
 * premise (`StaleAccountLockError`), never a second lock.
 *
 * The first thing a sign-in's transaction does for an account found by its
 * provider identity, ahead of the token update, the e-mail backfill and the key.
 *
 * @throws StaleAccountLockError
 */
export async function lockLinkedAccount(provider: SocialProvider, providerUserId: string): Promise<SocialAccountLink | null>
{
    const link = await socialAccountsRepository.findByProviderAndProviderId(provider, providerUserId);
    if (!link)
    {
        return null;
    }

    await usersRepository.lockAccount(link.userId);
    const relocked = await socialAccountsRepository.findByProviderAndProviderId(provider, providerUserId);

    if (relocked?.userId !== link.userId)
    {
        throw new StaleAccountLockError();
    }

    return relocked;
}

/**
 * OAuth 세션(공개키 등록) 발급 전 계정 상태 검사
 *
 * web(code 교환)·native(id_token) 두 흐름 모두 "기존 소셜 연결 재로그인" 또는
 * "createOrLinkUser 신규·이메일 연결" 두 분기로 userId를 얻은 뒤, 같은 지점에서
 * registerPublicKeyService를 호출해 세션을 발급한다. 그 직전에 호출해 양쪽 분기를
 * 한 번에 막는다 — 이전에는 이 검사가 아예 없어 정지/탈퇴예정 계정도 OAuth로
 * 로그인 세션을 얻을 수 있었다(기존 버그).
 *
 * `missing` builds the refusal for an account that is gone. The native route keeps
 * the plain ValidationError its contract declares; the web callback passes
 * `OAuthAccountNotFoundError` so its redirect can name `account_unavailable`.
 *
 * status는 replica가 아닌 primary에서 읽는다: 삭제 요청 직후(세션 revoke + status
 * 전이가 막 커밋된 시점) 복제 지연 창에서 OAuth 로그인이 stale 'active' 상태를 보고
 * 새 세션 키를 발급받는 것을 막기 위함.
 *
 * An account refused here is told to the app's `settled` as the sign-in
 * `signIn` names, once the transaction has rolled back (`reportAccountRefusal`);
 * both OAuth flows name theirs.
 *
 * @returns the account as the primary holds it, for the sign-in's answer
 */
export async function assertActiveForOAuthSession(
    userId: number,
    missing: () => Error = () => new ValidationError({ message: 'User not found' }),
    signIn: OAuthSignInAttempt | null = null,
): Promise<User>
{
    const user = await usersRepository.findByIdOnPrimary(userId);

    if (!user)
    {
        throw missing();
    }

    const refusal = await accountRefusal(user);
    if (refusal)
    {
        await reportAccountRefusal(signIn && signInAttempt(user, signIn.channel, signIn.request), refusal, signIn?.keyId);
        throw admissionRefusalError(refusal);
    }

    return user;
}

/** An OAuth sign-in as the app's `signIn` guard is told of it: the channel, the request, the key it presented. */
export interface OAuthSignInAttempt
{
    channel: 'oauth' | 'oauth-native';
    request: SignInRequest;
    keyId: string;
}

/**
 * 기존 소셜 계정 재로그인 시 비어 있는 users.email을 검증된 이메일로 소급 채움
 *
 * 과거 provider가 emailVerified=false를 보고해 email=null로 만들어진 계정(네이버 등)의
 * 구제 경로 — provider 판정이 바뀐 뒤 재로그인하면 이메일이 계정에 실린다.
 * 같은 이메일을 어떤 형태로든 가진 계정이 있으면 채우지 않는다(계정 탈취 방지) — 그 규칙은
 * `fillEmailIfUnheld`의 조건부 UPDATE 한 문장이 표현하고, 채울 것이 없으면 0행일 뿐 오류가
 * 아니다. 같은 주소를 아직 커밋하지 않은 다른 가입은 그 문장이 볼 수 없어, 그것이 커밋되면
 * unique 위반으로 로그인 트랜잭션이 되돌려지고 `retryContendedSignIn`이 한 번 더 돌린다 —
 * 두 번째에는 주소가 이미 있으니 채우지 않는다. 그 밖의 오류는 그대로 올라간다.
 */
export async function backfillVerifiedEmail(
    userId: number,
    identity: NormalizedIdentity,
): Promise<void>
{
    if (identity.email && identity.emailVerified)
    {
        await usersRepository.fillEmailIfUnheld(userId, identity.email);
    }
}

/**
 * 사용자 생성 또는 기존 사용자에 소셜 계정 연결
 *
 * 모든 OAuth provider 공통 경로. provider별 응답은 NormalizedIdentity로 정규화되어 들어온다.
 * tokens는 web(code 교환) 흐름에서만 전달된다. native id_token 흐름은 provider 토큰이
 * 없으므로 생략하며, social account의 토큰 컬럼은 null로 저장된다.
 * metadata는 앱이 OAuth 시작 시 실은 값 — 신규 가입일 때만 beforeRegister 훅에 전달된다.
 * 이메일이 같은 기존 계정이 있으면 `oauthEmailMatch`(#156)가 연결·거절·별도 가입을 정한다.
 * 대소문자만 다른 행도 같은 이메일로 본다 — 소문자 행이 있으면 그 행, 없으면 하나뿐인 행이
 * 그 계정이고, 소문자 행 없이 여럿이면 어느 계정인지 정할 수 없다.
 *
 * @throws OAuthEmailInUseError `oauthEmailMatch: 'reject'`이고 이메일이 같은 계정이 있을 때,
 * 또는 `'attach'`이고 소문자 행 없이 대소문자만 다른 계정이 여럿일 때
 * @throws UnverifiedEmailLinkError `'attach'`(기본)이고 provider가 이메일을 검증하지 않았을 때
 * @throws SignupDisabledError 새 계정을 만들어야 하는데 앱이 `channels.signup`을 끈 경우
 * @throws OAuthProviderAlreadyLinkedError when the matched account already holds
 *   another identity of this provider — one per provider per account (au5-A3)
 * @throws OAuthSignInContendedError when a concurrent first sign-in attached the
 *   identity first; the caller runs its transaction again (`retryContendedSignIn`),
 *   as it does for a unique violation on the address a concurrent sign-up took
 */
export async function createOrLinkUser(
    provider: SocialProvider,
    identity: NormalizedIdentity,
    tokens?: OAuthTokens,
    metadata?: Record<string, unknown>,
): Promise<{ userId: number; isNewUser: boolean }>
{
    // 이메일로 기존 사용자 검색 — 대소문자만 다른 행 포함
    const match: FoldedEmailMatch = identity.email
        ? await usersRepository.findByFoldedEmail(identity.email)
        : { kind: 'none' };
    const emailMatch = match.kind === 'none' ? 'attach' : getOAuthEmailMatch();

    // 'reject' (#156) writes nothing and says nothing about the existing account —
    // thrown before the attach branch would touch it and before the session check
    // would reveal its status. 'attach' to case variants it cannot choose between
    // is refused the same way: attaching to the wrong one would hand a sign-in
    // method to an account that is not the person's
    if (emailMatch === 'reject' || (emailMatch === 'attach' && match.kind === 'ambiguous'))
    {
        throw new OAuthEmailInUseError({ details: { provider } });
    }

    const { userId, isNewUser } = match.kind === 'account' && emailMatch === 'attach'
        ? { userId: await attachByEmail(match.user.id, identity), isNewUser: false }
        : { userId: await registerOAuthUser(provider, identity, metadata, match.kind === 'none'), isNewUser: true };

    // 소셜 계정 생성 (native 흐름은 provider 토큰이 없어 null로 저장)
    const created = await socialAccountsRepository.createIfAbsent({
        userId,
        provider,
        providerUserId: identity.providerUserId,
        providerEmail: identity.email,
        providerHandle: identity.handle ?? null,
        accessToken: tokens?.accessToken ?? null,
        refreshToken: tokens?.refreshToken ?? null,
        tokenExpiresAt: tokens ? tokenExpiryDate(tokens.expiresIn) : null,
    });

    if (!created)
    {
        throw await signInLinkConflict(provider, identity.providerUserId);
    }

    await recordProviderName(userId, identity.name);

    return { userId, isNewUser };
}

/**
 * Which of the table's two rules an insert that wrote nothing met.
 *
 * `linked_elsewhere`: another account holds the identity. `provider_already_linked`:
 * the account holds another identity of the provider. Read after the insert, in
 * the same transaction, so it sees the row that stood in the way.
 */
export async function socialAccountConflict(
    provider: SocialProvider,
    providerUserId: string,
): Promise<'linked_elsewhere' | 'provider_already_linked'>
{
    const owner = await socialAccountsRepository.findByProviderAndProviderId(provider, providerUserId);

    return owner ? 'linked_elsewhere' : 'provider_already_linked';
}

/**
 * The refusal of a sign-in whose identity could not be attached. The account
 * already holding another identity of the provider is the refusal people see;
 * the identity attached by a concurrent first sign-in in the meantime is a race
 * `retryContendedSignIn` resolves.
 */
async function signInLinkConflict(provider: SocialProvider, providerUserId: string): Promise<Error>
{
    return await socialAccountConflict(provider, providerUserId) === 'provider_already_linked'
        ? new OAuthProviderAlreadyLinkedError({ details: { provider } })
        : new OAuthSignInContendedError({ details: { provider } });
}

/**
 * 소셜 계정을 이메일이 같은 기존 계정에 붙인다 (`oauthEmailMatch: 'attach'`)
 *
 * 미검증 이메일로는 연결하지 않는다(계정 탈취 방지). provider가 검증한 이메일이므로
 * 기존 계정의 이메일 인증 상태도 채운다.
 *
 * The account is locked (`usersRepository.lockAccount`) before it is written,
 * and its verification state is read off that lock, not off the match.
 *
 * @throws UnverifiedEmailLinkError
 */
async function attachByEmail(userId: number, identity: NormalizedIdentity): Promise<number>
{
    if (!identity.emailVerified)
    {
        throw new UnverifiedEmailLinkError();
    }

    const existingUser = await usersRepository.lockAccount(userId);

    if (existingUser && !existingUser.emailVerifiedAt)
    {
        await usersRepository.updateById(userId, {
            emailVerifiedAt: new Date(),
        });
    }

    return userId;
}

/**
 * 소셜 신원으로 새 계정을 만든다
 *
 * 앱 주입 사전 검증 훅이 먼저 돈다 — throw 시 가입 거부. email은 provider가 보고한
 * 값 그대로 넘기고, 미검증이면 계정에는 null로 저장되므로 emailVerified를 함께 넘긴다.
 * keepEmail이 false면(`oauthEmailMatch: 'separate'`로 기존 계정과 이메일이 같을 때, #156)
 * 이메일은 다른 계정이 가지므로 검증됐어도 새 계정에 싣지 않는다.
 *
 * 앱이 가입을 끄면(`channels: { signup: false }`) 여기서 거절한다 — web 콜백과 native가
 * 계정을 만드는 유일한 지점이고, 어떤 행도 쓰기 전이다. 서비스 계층이 채널 설정을 읽는
 * 유일한 곳: 첫 소셜 로그인으로 생기는 계정은 다른 문으로 들어온 가입이기 때문이다.
 *
 * @throws SignupDisabledError
 */
async function registerOAuthUser(
    provider: SocialProvider,
    identity: NormalizedIdentity,
    metadata: Record<string, unknown> | undefined,
    keepEmail: boolean,
): Promise<number>
{
    if (!isChannelEnabled('signup'))
    {
        throw new SignupDisabledError({ details: { provider } });
    }

    await runBeforeRegister({
        channel: 'oauth',
        provider,
        email: identity.email ?? undefined,
        emailVerified: identity.emailVerified,
        metadata,
    });

    const { getRoleByName } = await import('./role.service');
    const userRole = await getRoleByName('user');

    if (!userRole)
    {
        throw new Error('Default user role not found. Run initializeAuth() first.');
    }

    const storesEmail = keepEmail && identity.emailVerified;
    const newUser = await usersRepository.create({
        email: storesEmail ? identity.email : null,
        phone: null,
        passwordHash: null,  // OAuth 사용자는 비밀번호 없음
        passwordChangeRequired: false,
        roleId: userRole.id,
        status: 'active',
        emailVerifiedAt: storesEmail ? new Date() : null,
    });

    // The new account's own lock, before its identity row and its key: the
    // hook above ran with no account lock held, and this is the only one.
    await usersRepository.lockAccount(newUser.id);

    return newUser.id;
}

/**
 * provider가 알려 준 이름을 표시 이름으로 남긴다 — 프로필이 아직 없을 때만 (#150)
 *
 * 소셜 계정을 처음 연결할 때만 불린다. Apple은 이름을 첫 인가에만 보내므로 이때가 아니면
 * 받을 기회가 없다. 이미 있는 프로필은 사람이나 앱이 정한 값이라 덮어쓰지 않는다. 이름은
 * 검증되지 않은 표시용 값이고, 공백뿐이면 남기지 않는다.
 */
async function recordProviderName(userId: number, name: string | undefined): Promise<void>
{
    const displayName = name?.trim();

    if (!displayName)
    {
        return;
    }

    await userProfilesRepository.createIfAbsent({ userId, displayName });
}

/**
 * The two binding facts, as query parameters, or nothing.
 *
 * Absent for an unbound key, so the callback URL of every account that did not
 * opt in is the one it has always been.
 */
function bindingRedirectParams(
    registered: { binding: SessionBindingType; expiresAt: Date | null },
): Record<string, string>
{
    if (registered.binding !== 'passkey' || !registered.expiresAt)
    {
        return {};
    }

    return {
        sessionBinding: registered.binding,
        keyExpiresAtMillis: String(registered.expiresAt.getTime()),
    };
}

function buildRedirectUrl(
    baseUrl: string,
    params: Record<string, string>,
): string
{
    const url = new URL(baseUrl, 'http://placeholder');
    for (const [key, value] of Object.entries(params))
    {
        url.searchParams.set(key, value);
    }

    // placeholder를 제거하고 상대/절대 URL 반환
    if (baseUrl.startsWith('http'))
    {
        return url.toString();
    }

    return `${url.pathname}${url.search}`;
}

/**
 * OAuth 에러 리다이렉트 URL 생성
 *
 * `SPFN_AUTH_OAUTH_ERROR_URL` is a template: `{error}` takes the text, `{reason}`
 * the code (#126). A template without `{reason}` gets it as a query parameter.
 */
export function buildOAuthErrorUrl(error: string, reason: OAuthErrorReason = 'failed'): string
{
    const errorUrl = env.SPFN_AUTH_OAUTH_ERROR_URL || '/auth/error?error={error}';

    return withOAuthErrorReason(errorUrl.replace('{error}', encodeURIComponent(error)), reason);
}

/** Error classes the callback names a reason for; anything else is `failed`. */
const REASON_BY_ERROR: [abstract new (...args: never[]) => Error, OAuthErrorReason][] = [
    [OAuthStateExpiredError, 'expired'],
    [OAuthStateInvalidError, 'invalid_state'],
    [OAuthCookieMissingError, 'no_cookie'],
    [OAuthProviderError, 'provider_error'],
    [OAuthProviderLinkOnlyError, 'link_only'],
    [OAuthEmailInUseError, 'email_in_use'],
    [OAuthProviderAlreadyLinkedError, 'provider_already_linked'],
    [OAuthSignInContendedError, 'sign_in_contended'],
    [SignupDisabledError, 'signup_disabled'],
    [SignInRefusedError, 'sign_in_refused'],
    [AccountDisabledError, 'account_unavailable'],
    [AccountPendingDeletionError, 'account_unavailable'],
    [OAuthAccountNotFoundError, 'account_unavailable'],
];

/** The reason code for a failed callback, by the error's type — never its message. */
export function oauthErrorReason(error: unknown): OAuthErrorReason
{
    return REASON_BY_ERROR.find(([type]) => error instanceof type)?.[1] ?? 'failed';
}

/**
 * The error redirect for a caught error: its text and its reason code (#382).
 *
 * A typed error meant for the client — a `SerializableError` not marked
 * `internal`, by core's own `isSerializableError`, the check its error handler
 * makes — keeps its message, as that handler answers it. Any
 * other error's message may carry a failed statement's SQL and bound values,
 * so the redirect carries `fallback` instead. The reason is the error's type
 * either way.
 *
 * The redirect is the answer core's error handler would otherwise have given,
 * so the error is logged as that handler logs it (`logOAuthFailure`): a sign-in
 * that fails on a fault — a missing default role, a database error, a typed
 * 5xx — must still leave the operator a line.
 */
export function oauthFailureUrl(error: unknown, fallback: string): string
{
    const forClient = isSerializableError(error) && (error as { internal?: boolean }).internal !== true;

    logOAuthFailure(error, fallback);

    return buildOAuthErrorUrl(forClient ? error.message : fallback, oauthErrorReason(error));
}

/**
 * Log a caught OAuth failure that is answered without core's error handler, by
 * that handler's rule (`errorLogLevel` from `@spfn/core/errors`): `error` for a
 * fault (5xx, an untyped error), `warn` for a refusal. The message is a fixed
 * sentence; the error goes to the logger, which describes it.
 */
export function logOAuthFailure(error: unknown, message: string): void
{
    authLogger.service[errorLogLevel(error)](message, { error });
}

/**
 * OAuth provider가 등록되어 있고 활성화되어 있는지 확인
 */
export function isOAuthProviderEnabled(provider: SocialProvider): boolean
{
    return getOAuthProvider(provider)?.isEnabled() ?? false;
}

/**
 * 활성화된 모든 OAuth provider 목록 (registry 기반)
 */
export function getEnabledOAuthProviders(): SocialProvider[]
{
    return getRegisteredProviders()
        .filter(p => p.isEnabled())
        .map(p => p.id);
}

// 토큰 만료 판단 시 사용할 버퍼 (5분)
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Google access token 조회 (만료 시 자동 리프레시)
 *
 * 저장된 토큰이 만료 임박(5분 이내) 또는 만료 상태이면
 * refresh token으로 자동 갱신 후 DB 업데이트하여 유효한 토큰 반환.
 * The one place the stored tokens are decrypted (and re-encrypted under the
 * active key when they need it): `readTokens`.
 *
 * @param userId - 사용자 ID
 * @returns 유효한 Google access token
 */
export async function getGoogleAccessToken(userId: number): Promise<string>
{
    const account = await socialAccountsRepository.findByUserIdAndProvider(userId, 'google');
    const tokens = account ? await socialAccountsRepository.readTokens(account.id) : null;

    if (!account || !tokens)
    {
        throw new ValidationError({
            message: 'No Google account linked. User must sign in with Google first.',
        });
    }

    const isExpired = !tokens.tokenExpiresAt
        || tokens.tokenExpiresAt.getTime() < Date.now() + TOKEN_EXPIRY_BUFFER_MS;

    if (!isExpired && tokens.accessToken)
    {
        return tokens.accessToken;
    }

    // 리프레시 토큰이 없으면 갱신 불가
    if (!tokens.refreshToken)
    {
        throw new ValidationError({
            message: 'Google refresh token not available. User must re-authenticate with Google.',
        });
    }

    const refreshed = await refreshAccessToken(tokens.refreshToken);

    await socialAccountsRepository.updateTokens(account.id, {
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token,
        tokenExpiresAt: tokenExpiryDate(refreshed.expires_in),
    });

    return refreshed.access_token;
}

export interface UnlinkNotifyResult
{
    /** provider 규격이 요구하는 성공 응답 status */
    ackStatus: 200 | 204;
    /** 대상 소셜 계정을 찾아 삭제했는지 (미존재·이미 삭제면 false) */
    handled: boolean;
}

/**
 * Provider발 연동 해제 알림(unlink-notify) 처리
 *
 * 검증(verifyUnlinkNotification)을 통과한 요청만 여기 도달한다.
 * 소셜 계정 연결 row를 삭제해 저장 토큰(access/refresh)까지 함께 파기하고,
 * 후속 정책(계정 탈퇴 연계 등)은 auth.oauth.unlinked 이벤트 구독에 맡긴다.
 *
 * 대상 계정이 없어도 성공으로 응답한다 — provider 재전송·이미 해제된 계정에
 * 대한 알림은 정상 시나리오다.
 */
export async function oauthUnlinkNotifyService(
    provider: SocialProvider,
    notification: UnlinkNotification,
): Promise<UnlinkNotifyResult>
{
    const oauthProvider = requireEnabledProvider(provider);
    const ackStatus = oauthProvider.unlinkNotifyAckStatus ?? 200;

    const account = await socialAccountsRepository.findByProviderAndProviderId(
        provider,
        notification.providerUserId,
    );

    if (!account)
    {
        return { ackStatus, handled: false };
    }

    // The identity is a way into the account: removed under its lock
    // (`usersRepository.lockAccount`), in a transaction of its own.
    await runInTransaction(async () =>
    {
        await usersRepository.lockAccount(account.userId);
        await socialAccountsRepository.deleteById(account);
    }, { context: 'auth:oauth-unlink-notify' });

    await oauthUnlinkedEvent.emit({
        userId: String(account.userId),
        provider,
        providerUserId: notification.providerUserId,
        reason: notification.reason,
    });

    return { ackStatus, handled: true };
}
