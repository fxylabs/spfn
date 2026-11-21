/**
 * 소셜 provider id_token JWKS 검증
 *
 * 네이티브/웹 SDK가 받은 id_token을 provider의 공개키(JWKS)로 검증한다.
 * authorization code 교환이 없으므로 client secret을 쓰지 않는다.
 * 서명·issuer·audience·만료·발급 후 경과 시간은 jose가, nonce는 여기서 직접 대조한다.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { InvalidSocialTokenError } from '@spfn/auth/errors';
import { authLogger } from '../../logger';

// id_token 발급자/서버 간 시계 오차 허용치(초). 갓 발급된 토큰의 간헐적 거부를 막는다.
const CLOCK_TOLERANCE_SECONDS = 30;

/**
 * id_token을 받아들이는 최대 나이(초) — iat 기준.
 *
 * 이 엔드포인트는 nonce를 클라이언트가 같은 요청 본문으로 보내므로 재사용을 탐지할 수 없다.
 * exp만 믿으면 유출된 토큰이 provider가 정한 수명 내내(카카오는 12시간) 그대로 통한다.
 * iat 기준 상한을 따로 두어 그 창을 시간 단위에서 분 단위로 줄인다.
 *
 * 10분은 정상 클라이언트에는 여유가 크다 — SDK가 id_token을 받은 직후 POST하는 흐름이고,
 * 느린 단말·앱 백그라운드 전환·Apple/Google의 웹 리다이렉트 왕복을 다 합쳐도 분 단위를
 * 넘기지 않는다. provider별로 봐도 이 값이 병목이 되지 않는다: Apple id_token의 자체 수명이
 * 10분 이하라 exp가 먼저 걸리고, Google(1시간)·카카오(12시간)·네이버는 훨씬 길어 이 상한이
 * 실제 제한선이 된다. iat은 OIDC 필수 claim이라 네 provider 모두 담아 보낸다.
 * CLOCK_TOLERANCE_SECONDS가 여기에도 함께 적용된다.
 */
const MAX_TOKEN_AGE_SECONDS = 600;

// 원격 JWKS는 URI별로 한 번만 만들어 캐싱한다(jose가 키 회전을 자동 처리).
const jwksByUri = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getRemoteJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet>
{
    const cached = jwksByUri.get(jwksUri);
    if (cached)
    {
        return cached;
    }

    const jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksByUri.set(jwksUri, jwks);

    return jwks;
}

export interface VerifyIdTokenParams
{
    idToken: string;
    jwksUri: string;
    issuer: string | string[];
    audiences: string[];
    /** 허용 서명 알고리즘 화이트리스트(alg confusion 방어). Google/Apple은 'RS256'. */
    algorithms: string[];
    /** id_token의 nonce claim과 정확히 일치해야 하는 값(provider별로 raw 또는 SHA-256 해시). */
    expectedNonce: string;
}

/**
 * id_token을 검증하고 claims(payload)를 반환한다.
 *
 * @throws InvalidSocialTokenError 서명/issuer/audience/만료/토큰 나이/알고리즘/nonce/sub 검증 실패 시
 */
export async function verifyIdToken(params: VerifyIdTokenParams): Promise<JWTPayload>
{
    const payload = await verifySignature(params);

    if (payload.nonce !== params.expectedNonce)
    {
        throw new InvalidSocialTokenError({ message: 'id_token nonce mismatch' });
    }

    // sub(provider 신원 식별자)은 OIDC 필수 claim. jose는 sub 존재를 강제하지 않으므로 직접 확인한다.
    if (typeof payload.sub !== 'string' || payload.sub.length === 0)
    {
        throw new InvalidSocialTokenError({ message: 'id_token is missing the subject (sub) claim' });
    }

    return payload;
}

/**
 * jose의 서명/issuer/audience/algorithm/만료 검증을 도메인 에러로 감싼다.
 *
 * 검증 실패의 구체적 사유는 우회 지점을 좁히는 정보가 되므로 클라이언트에 노출하지 않고
 * 로그로만 남긴다. 토큰 원문은 기록하지 않는다.
 */
async function verifySignature(params: VerifyIdTokenParams): Promise<JWTPayload>
{
    try
    {
        const { payload } = await jwtVerify(params.idToken, getRemoteJwks(params.jwksUri), {
            issuer: params.issuer,
            audience: params.audiences,
            algorithms: params.algorithms,
            clockTolerance: CLOCK_TOLERANCE_SECONDS,
            maxTokenAge: MAX_TOKEN_AGE_SECONDS,
        });

        return payload;
    }
    catch (err)
    {
        authLogger.service.warn('id_token signature/claims verification failed', { error: err });
        throw new InvalidSocialTokenError();
    }
}
