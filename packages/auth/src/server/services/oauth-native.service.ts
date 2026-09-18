/**
 * @spfn/auth - Native Social Login Service
 *
 * 네이티브/웹 SDK가 받은 id_token을 JWKS로 검증하고, 검증된 신원에 클라이언트가 만든
 * 공개키를 등록한다. 토큰은 발급하지 않는다 — 클라이언트가 등록한 키로 client token을
 * 직접 서명해 Bearer로 사용한다(client-signs / server-verifies 모델).
 *
 * 흐름은 두 단계로 분리한다:
 *   1) id_token 검증 — 외부 JWKS 네트워크 조회. DB 트랜잭션 밖에서 수행한다.
 *   2) persist — 사용자 link/create + 공개키 등록을 한 트랜잭션으로. 이벤트는 커밋 후 발행.
 */

import { runInTransaction, onAfterCommit } from '@spfn/core/db';

import {
    InvalidKeyFingerprintError,
    NativeSignInUnsupportedError,
    NonceKeyBindingError,
} from '@spfn/auth/errors';
import { verifyKeyFingerprint } from '../helpers/jwt';
import { socialAccountsRepository } from '../repositories';
import { type SocialProvider, type KeyAlgorithmType, type KeyPlatformType } from '../types';
import { getOAuthProvider, type NormalizedIdentity } from '../lib/oauth';
import { createOrLinkUser, assertActiveForOAuthSession, backfillVerifiedEmail } from './oauth.service';
import { registerPublicKeyService } from './key.service';
import { updateLastLoginService } from './user.service';
import { mfaEnrolledForUser } from './mfa.service';
import { authLoginEvent, authRegisterEvent } from '../events';

export interface OAuthNativeParams
{
    provider: SocialProvider;
    idToken: string;
    nonce: string;
    publicKey: string;
    keyId: string;
    fingerprint: string;
    algorithm: KeyAlgorithmType;
    /** 키 목록에 보일 기기 라벨 (선택). 표시용이라 권한 판정에 쓰이지 않는다. */
    deviceName?: string;
    platform?: KeyPlatformType;
    /**
     * SDK가 id_token과 함께 받은 provider access token (선택).
     *
     * provider가 id_token만으로 확인할 수 없는 claim을 보강할 때만 쓴다. 없으면 provider는
     * id_token이 담은 정보만으로 신원을 정규화한다.
     */
    accessToken?: string;
    /** Client address of the request, from `deviceProvenance` at the route. */
    ip?: string;
    /** `user-agent` of the request, already truncated at the route. */
    userAgent?: string;
    /**
     * Whether proxy-guard recognised the trusted Next.js proxy, from the same
     * helper. Accepted because every registering route spreads the whole
     * provenance, and read by nothing: a native sign-in never produces a bound
     * key — see the note at the registration below.
     */
    webProxy?: boolean;

    /** Apple은 첫 로그인에만 이름을 별도로 주므로 클라이언트가 전달할 수 있다. */
    profile?: { name?: string };
    metadata?: Record<string, unknown>;
}

export interface OAuthNativeResult
{
    userId: string;
    keyId: string;
    isNewUser: boolean;
}

/**
 * native id_token 로그인 처리
 *
 * @throws NativeSignInUnsupportedError provider가 native sign-in을 지원하지 않을 때
 * @throws InvalidSocialTokenError id_token 검증 실패 시
 */
export async function oauthNativeService(params: OAuthNativeParams): Promise<OAuthNativeResult>
{
    const oauthProvider = getOAuthProvider(params.provider);

    if (!oauthProvider?.verifyNativeIdToken)
    {
        throw new NativeSignInUnsupportedError({
            message: `Provider '${params.provider}' does not support native id_token sign-in.`,
        });
    }

    // 1. nonce ↔ publicKey 결속 (id_token 검증 전 — 네트워크 없이 끝나는 검사부터)
    assertNonceBindsPublicKey(params);

    // 2. id_token 검증 (외부 JWKS 조회 — 트랜잭션 밖)
    const identity = await oauthProvider.verifyNativeIdToken(params.idToken, {
        nonce: params.nonce,
        accessToken: params.accessToken,
    });

    // Apple 첫 로그인 등 id_token에 이름이 없을 때 클라이언트 profile로 보강
    if (params.profile?.name && !identity.name)
    {
        identity.name = params.profile.name;
    }

    // 3. persist (트랜잭션)
    return persistNativeLogin(identity, params);
}

/**
 * nonce가 이 요청의 publicKey에서 유도된 값인지 확인한다.
 *
 * id_token은 소지만 하면 되는 자격증명이라 복사해서 다른 곳에서 제출해도 통한다. 그것만
 * 검사하면 유효한 id_token 하나를 쥔 쪽이 남의 계정에 자기 공개키를 올릴 수 있다. nonce는
 * 클라이언트가 provider에 넘겨 id_token에 실려 돌아오는 값이므로, 그것을 키의 fingerprint로
 * 못박으면 훔친 id_token은 피해자 키의 fingerprint를 담고 있어 공격자 키로 바꿔 낼 수 없다.
 *
 * 두 검사가 모두 있어야 결속이 성립한다. fingerprint 검증만 있으면 nonce는 아무 값이나 될 수
 * 있고, 동등 검사만 있으면 fingerprint가 실제 키의 해시가 아니어도 통과한다.
 *
 * registerPublicKeyService에 기대지 않는 이유: 그쪽은 같은 사용자의 활성 키 재등록을 early
 * return으로 흘려보내 fingerprint를 검증하지 않는다. 결속은 여기서 끝나야 구멍이 없다.
 *
 * @throws NonceKeyBindingError nonce가 fingerprint와 다를 때
 * @throws InvalidKeyFingerprintError fingerprint가 publicKey의 해시가 아닐 때
 */
function assertNonceBindsPublicKey(params: OAuthNativeParams): void
{
    if (params.nonce !== params.fingerprint)
    {
        throw new NonceKeyBindingError();
    }

    if (!verifyKeyFingerprint(params.publicKey, params.fingerprint))
    {
        throw new InvalidKeyFingerprintError();
    }
}

/**
 * 검증된 신원에 사용자 연결/생성 + 공개키 등록을 한 트랜잭션으로 처리한다.
 * 이벤트는 커밋 성공 후에만 발행한다(롤백 시 유령 이벤트 방지).
 */
async function persistNativeLogin(
    identity: NormalizedIdentity,
    params: OAuthNativeParams,
): Promise<OAuthNativeResult>
{
    return runInTransaction(async () =>
    {
        // providerUserId 우선 매칭 → 없으면 신규 생성/이메일 연결
        const existing = await socialAccountsRepository.findByProviderAndProviderId(
            params.provider,
            identity.providerUserId,
        );

        let userId: number;
        let isNewUser = false;

        if (existing)
        {
            userId = existing.userId;
            await backfillVerifiedEmail(userId, identity);
        }
        else
        {
            const result = await createOrLinkUser(params.provider, identity, undefined, params.metadata);
            userId = result.userId;
            isNewUser = result.isNewUser;
        }

        // 세션(공개키) 발급 전 계정 상태 검사 — oauth.service.ts의 web 흐름과 동일한 지점
        await assertActiveForOAuthSession(userId);

        // 공개키 등록 (같은 사용자의 활성 키 재등록만 무시 — 그 밖의 keyId 충돌은 409)
        //
        // No `binding`, so the key is an ordinary 90-day one even on an account
        // that turned session binding on. This route exists for a native SDK
        // holding a provider id_token: there is no session cookie for a copy to
        // be made of and no browser to run the renewal ceremony in, and
        // `clientType` on a request that reached the backend directly is never
        // the web proxy the decision reads. The `platform` the client declares is
        // not consulted, here or anywhere — see `decideKeyBinding`.
        await registerPublicKeyService({
            userId,
            keyId: params.keyId,
            publicKey: params.publicKey,
            fingerprint: params.fingerprint,
            algorithm: params.algorithm,
            deviceName: params.deviceName,
            platform: params.platform,
            channel: 'oauth-native',
            ip: params.ip,
            userAgent: params.userAgent,
        });

        await updateLastLoginService(userId);

        const eventPayload = {
            userId: String(userId),
            provider: params.provider,
            email: identity.email || undefined,
            metadata: params.metadata,
        };
        // `mfaEnrolled` is on the login event only — a brand-new account cannot
        // have a second factor. Read before the callback is queued, so the
        // callback stays synchronous and lands when consumers expect it to.
        const mfaEnrolled = isNewUser ? false : await mfaEnrolledForUser(userId);

        onAfterCommit(() => (isNewUser
            ? authRegisterEvent.emit(eventPayload)
            : authLoginEvent.emit({ ...eventPayload, mfaEnrolled })));

        return { userId: String(userId), keyId: params.keyId, isNewUser };
    }, { context: 'auth:oauth-native' });
}
