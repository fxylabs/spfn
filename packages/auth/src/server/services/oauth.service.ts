/**
 * @spfn/auth - OAuth Service
 *
 * OAuth 인증 비즈니스 로직
 * - Google OAuth Authorization Code Flow
 * - 소셜 계정 연결/생성
 * - publicKey는 state에서 추출하여 등록
 */

import { env } from '@spfn/auth/config';
import { ValidationError } from '@spfn/core/errors';
import {
    AccountDisabledError,
    AccountPendingDeletionError,
    UnverifiedEmailLinkError,
} from '@spfn/auth/errors';

import { usersRepository, socialAccountsRepository } from '../repositories';
import { authLogger } from '../logger';
import { isSafeReturnPath } from '../../lib/return-path';
import { runBeforeRegister } from '../lib/config';
import { type SocialProvider, type KeyAlgorithmType, type SessionBindingType } from '../types';
import {
    refreshAccessToken,
    createOAuthState,
    verifyOAuthState,
    getOAuthProvider,
    getRegisteredProviders,
    type OAuthProvider,
    type OAuthTokens,
    type NormalizedIdentity,
    type UnlinkNotification,
} from '../lib/oauth';
import { registerPublicKeyService } from './key.service';
import { decideKeyBinding } from '../lib/key-policy';
import { updateLastLoginService } from './user.service';
import { getPendingDeletionInfo } from './account-deletion.service';
import { mfaEnrolledForUser } from './mfa.service';
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
    /**
     * Value(s) of the oauth_csrf cookie from the callback request. One of them
     * must equal the nonce bound into the (encrypted) state — otherwise the flow
     * wasn't initiated by this browser (login CSRF). An array arises because the
     * cookie name carries the PORT suffix of the process that set it (the Next.js
     * web process), which differs from the API process in a split deployment, so
     * the callback collects every spfn_oauth_csrf* candidate. Pass `undefined` or
     * an empty array when absent; verification then fails closed.
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
 * provider가 돌려준 만료 초(seconds)를 만료 시각으로 변환 (방어적 검증)
 */
function tokenExpiryDate(expiresIn: number): Date
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

    const oauthProvider = requireEnabledProvider(provider);

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

    return { authUrl: oauthProvider.getAuthUrl(state) };
}

/**
 * OAuth 콜백 처리 - Code를 Token으로 교환하고 사용자 생성/연결
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
    const nonceCandidates = typeof expectedNonce === 'string' ? [expectedNonce] : expectedNonce ?? [];
    if (!stateData.nonce || !nonceCandidates.includes(stateData.nonce))
    {
        throw new ValidationError({
            message: 'OAuth state validation failed',
        });
    }

    if (stateData.provider !== provider)
    {
        throw new ValidationError({
            message: 'OAuth state provider mismatch',
        });
    }

    const oauthProvider = requireEnabledProvider(provider);

    // 1. Code를 Token으로 교환
    const tokens = await oauthProvider.exchangeCodeForTokens(code, { state });

    // 2. 사용자 정보 조회 (provider별 응답을 공통 형태로 정규화)
    const identity = await oauthProvider.getUserInfo(tokens.accessToken);

    // 3. 기존 소셜 계정 확인
    const existingSocialAccount = await socialAccountsRepository.findByProviderAndProviderId(
        provider,
        identity.providerUserId,
    );

    let userId: number;
    let isNewUser = false;

    if (existingSocialAccount)
    {
        // 기존 사용자 - 토큰 업데이트
        userId = existingSocialAccount.userId;

        await socialAccountsRepository.updateTokens(existingSocialAccount.id, {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? existingSocialAccount.refreshToken,
            tokenExpiresAt: tokenExpiryDate(tokens.expiresIn),
        });

        await backfillVerifiedEmail(userId, identity);
    }
    else
    {
        // 신규 사용자 또는 이메일로 기존 사용자 연결
        const result = await createOrLinkUser(provider, identity, tokens, stateData.metadata);
        userId = result.userId;
        isNewUser = result.isNewUser;
    }

    // 3.5. 세션(공개키) 발급 전 계정 상태 검사 — 기존에는 검사 없이 세션이 발급됐다
    // (기존 버그: 정지/탈퇴예정 계정도 OAuth로 로그인 가능했음). 두 분기(기존 소셜
    // 연결 재로그인 / createOrLinkUser 신규·연결) 모두 여기서 합류하므로 한 번의
    // 검사로 양쪽을 다 막는다.
    await assertActiveForOAuthSession(userId);

    // Read once, here rather than at step 7 where it used to be: registering the
    // key needs the account's session_binding setting, and the event payload
    // below needs the same row. One query serves both.
    const user = await usersRepository.findById(userId);

    // 4. state에서 추출한 publicKey 등록
    // No deviceName or platform: the sealed state the start step wrote carries
    // neither, so the event on this channel is the one that names no device.
    const registered = await registerPublicKeyService({
        userId,
        keyId: stateData.keyId,
        publicKey: stateData.publicKey,
        fingerprint: stateData.fingerprint,
        algorithm: stateData.algorithm,
        channel: 'oauth',
        ip: params.ip,
        userAgent: params.userAgent,
        binding: decideKeyBinding(user?.sessionBinding ?? 'none', params.webProxy),
        loginEvent: {
            provider,
            email: user?.email || undefined,
            phone: user?.phone || undefined,
            metadata: stateData.metadata,
        },
    });

    const appUrl = env.NEXT_PUBLIC_SPFN_APP_URL || env.SPFN_APP_URL;
    const callbackPath = env.SPFN_AUTH_OAUTH_SUCCESS_URL || '/auth/callback';
    const callbackUrl = callbackPath.startsWith('http') ? callbackPath : `${appUrl}${callbackPath}`;
    const returnUrl = isSafeReturnPath(stateData.returnUrl) ? stateData.returnUrl : '/';

    // An enrolled account on a new device is redirected with a challenge and
    // nothing else (#95): no `userId`, no `keyId`, and neither the login event
    // nor `lastLoginAt` below. A brand-new social account never reaches this —
    // `createOrLinkUser` has just written the user row, so there is no second
    // factor to ask for and `isNewUser` is answered exactly as it always was.
    if (registered.pending)
    {
        return {
            redirectUrl: buildRedirectUrl(callbackUrl, {
                mfaChallenge: registered.challenge.secret,
                returnUrl,
                isNewUser: String(isNewUser),
            }),
            userId: String(userId),
            keyId: stateData.keyId,
            isNewUser,
            mfaChallenge: registered.challenge.secret,
        };
    }

    // 5. 마지막 로그인 시간 업데이트
    await updateLastLoginService(userId);

    // 6. 리다이렉트 URL 생성 (OAuth 콜백 페이지로)
    // 콜백 페이지에서 oauthFinalize API를 호출하여 세션 저장
    const redirectUrl = buildRedirectUrl(callbackUrl, {
        userId: String(userId),
        keyId: stateData.keyId,
        // Defence in depth: the state is sealed, so this value was already checked
        // where it was sealed. Checking it again costs one comparison and keeps a
        // destination that leaves the app out of the callback URL no matter which
        // seam sealed it.
        returnUrl,
        isNewUser: String(isNewUser),
        // The callback page and `createOAuthCallbackHandler` are the two seams
        // that seal a session out of this redirect, and neither calls a route
        // that could tell them the key is bound. The two values ride the query
        // for the same reason `userId` and `keyId` do — and, like those, nothing
        // is authorized by them: the key row already expires when it says it
        // does, whatever a tampered query claims the cookie should believe.
        ...bindingRedirectParams(registered),
    });

    // 7. 이벤트 발행: 신규 사용자는 register, 기존 사용자는 login
    const eventPayload = {
        userId: String(userId),
        provider,
        email: user?.email || undefined,
        phone: user?.phone || undefined,
        metadata: stateData.metadata,
    };

    if (isNewUser)
    {
        await authRegisterEvent.emit(eventPayload);
    }
    else
    {
        // `mfaEnrolled` is on the login event only: a brand-new account cannot
        // have a second factor, and the register event is where an app decides
        // what to offer a user it has just met.
        await authLoginEvent.emit({ ...eventPayload, mfaEnrolled: await mfaEnrolledForUser(userId) });
    }

    return {
        redirectUrl,
        userId: String(userId),
        keyId: stateData.keyId,
        isNewUser,
    };
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
 * status는 replica가 아닌 primary에서 읽는다: 삭제 요청 직후(세션 revoke + status
 * 전이가 막 커밋된 시점) 복제 지연 창에서 OAuth 로그인이 stale 'active' 상태를 보고
 * 새 세션 키를 발급받는 것을 막기 위함.
 */
export async function assertActiveForOAuthSession(userId: number): Promise<void>
{
    const user = await usersRepository.findByIdOnPrimary(userId);

    if (!user)
    {
        throw new ValidationError({ message: 'User not found' });
    }

    if (user.status === 'active')
    {
        return;
    }

    if (user.status === 'pending_deletion')
    {
        const pending = await getPendingDeletionInfo(user.id);
        throw new AccountPendingDeletionError({ purgeScheduledAt: pending?.purgeScheduledAt.toISOString() });
    }

    throw new AccountDisabledError({ status: user.status });
}

/**
 * 기존 소셜 계정 재로그인 시 비어 있는 users.email을 검증된 이메일로 소급 채움
 *
 * 과거 provider가 emailVerified=false를 보고해 email=null로 만들어진 계정(네이버 등)의
 * 구제 경로 — provider 판정이 바뀐 뒤 재로그인하면 이메일이 계정에 실린다.
 * 같은 이메일을 가진 다른 계정이 이미 있으면 건너뛴다(unique 충돌·계정 탈취 방지).
 */
export async function backfillVerifiedEmail(
    userId: number,
    identity: NormalizedIdentity,
): Promise<void>
{
    if (!identity.email || !identity.emailVerified)
    {
        return;
    }

    const user = await usersRepository.findById(userId);
    if (!user || user.email)
    {
        return;
    }

    const emailOwner = await usersRepository.findByEmail(identity.email);
    if (emailOwner && emailOwner.id !== userId)
    {
        return;
    }

    try
    {
        await usersRepository.updateById(userId, {
            email: identity.email,
            emailVerifiedAt: new Date(),
        });
    }
    catch (error)
    {
        // best-effort — 동시 가입으로 unique 충돌이 나도 로그인은 계속돼야 한다
        authLogger.service.warn('Verified-email backfill failed; continuing login', {
            userId: String(userId),
            error: error instanceof Error ? error.message : String(error),
        });
    }
}

/**
 * 사용자 생성 또는 기존 사용자에 소셜 계정 연결
 *
 * 모든 OAuth provider 공통 경로. provider별 응답은 NormalizedIdentity로 정규화되어 들어온다.
 * tokens는 web(code 교환) 흐름에서만 전달된다. native id_token 흐름은 provider 토큰이
 * 없으므로 생략하며, social account의 토큰 컬럼은 null로 저장된다.
 * metadata는 앱이 OAuth 시작 시 실은 값 — 신규 가입일 때만 beforeRegister 훅에 전달된다.
 */
export async function createOrLinkUser(
    provider: SocialProvider,
    identity: NormalizedIdentity,
    tokens?: OAuthTokens,
    metadata?: Record<string, unknown>,
): Promise<{ userId: number; isNewUser: boolean }>
{
    // 이메일로 기존 사용자 검색
    const existingUser = identity.email
        ? await usersRepository.findByEmail(identity.email)
        : null;

    let userId: number;
    let isNewUser = false;

    if (existingUser)
    {
        // 미검증 이메일로는 기존 계정 연결 차단 (계정 탈취 방지)
        if (!identity.emailVerified)
        {
            throw new UnverifiedEmailLinkError();
        }

        // 기존 사용자에 소셜 계정 연결
        userId = existingUser.id;

        // 이메일 인증 상태 업데이트 (provider의 검증된 이메일 기준)
        if (!existingUser.emailVerifiedAt)
        {
            await usersRepository.updateById(existingUser.id, {
                emailVerifiedAt: new Date(),
            });
        }
    }
    else
    {
        // 앱 주입 사전 검증 훅 — throw 시 가입 거부 (기존 계정 연결에는 적용 안 함)
        // email은 provider가 보고한 값 그대로 — 미검증이면 계정에는 null로 저장되므로
        // 이메일 기반 정책이 판별할 수 있게 emailVerified를 함께 넘긴다
        await runBeforeRegister({
            channel: 'oauth',
            provider,
            email: identity.email ?? undefined,
            emailVerified: identity.emailVerified,
            metadata,
        });

        // 신규 사용자 생성
        const { getRoleByName } = await import('./role.service');
        const userRole = await getRoleByName('user');

        if (!userRole)
        {
            throw new Error('Default user role not found. Run initializeAuth() first.');
        }

        const newUser = await usersRepository.create({
            email: identity.emailVerified ? identity.email : null,
            phone: null,
            passwordHash: null,  // OAuth 사용자는 비밀번호 없음
            passwordChangeRequired: false,
            roleId: userRole.id,
            status: 'active',
            emailVerifiedAt: identity.emailVerified ? new Date() : null,
        });

        userId = newUser.id;
        isNewUser = true;
    }

    // 소셜 계정 생성 (native 흐름은 provider 토큰이 없어 null로 저장)
    await socialAccountsRepository.create({
        userId,
        provider,
        providerUserId: identity.providerUserId,
        providerEmail: identity.email,
        accessToken: tokens?.accessToken ?? null,
        refreshToken: tokens?.refreshToken ?? null,
        tokenExpiresAt: tokens ? tokenExpiryDate(tokens.expiresIn) : null,
    });

    return { userId, isNewUser };
}

/**
 * 리다이렉트 URL 생성
 */
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
 */
export function buildOAuthErrorUrl(error: string): string
{
    const errorUrl = env.SPFN_AUTH_OAUTH_ERROR_URL || '/auth/error?error={error}';

    return errorUrl.replace('{error}', encodeURIComponent(error));
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
 *
 * @param userId - 사용자 ID
 * @returns 유효한 Google access token
 */
export async function getGoogleAccessToken(userId: number): Promise<string>
{
    const account = await socialAccountsRepository.findByUserIdAndProvider(userId, 'google');

    if (!account)
    {
        throw new ValidationError({
            message: 'No Google account linked. User must sign in with Google first.',
        });
    }

    const isExpired = !account.tokenExpiresAt
        || account.tokenExpiresAt.getTime() < Date.now() + TOKEN_EXPIRY_BUFFER_MS;

    if (!isExpired && account.accessToken)
    {
        return account.accessToken;
    }

    // 리프레시 토큰이 없으면 갱신 불가
    if (!account.refreshToken)
    {
        throw new ValidationError({
            message: 'Google refresh token not available. User must re-authenticate with Google.',
        });
    }

    const tokens = await refreshAccessToken(account.refreshToken);

    await socialAccountsRepository.updateTokens(account.id, {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? account.refreshToken,
        tokenExpiresAt: tokenExpiryDate(tokens.expires_in),
    });

    return tokens.access_token;
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

    await socialAccountsRepository.deleteById(account.id);

    await oauthUnlinkedEvent.emit({
        userId: String(account.userId),
        provider,
        providerUserId: notification.providerUserId,
        reason: notification.reason,
    });

    return { ackStatus, handled: true };
}
