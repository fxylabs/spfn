/**
 * Sign in with Apple client secret
 *
 * Apple의 token endpoint는 고정 client secret 대신, 개발자가 Sign in with Apple 키(.p8)로
 * 서명한 ES256 JWT를 client_secret으로 받는다(iss=Team ID, sub=Services ID,
 * aud=https://appleid.apple.com, 최대 6개월). 여기서는 1시간짜리를 발급해 캐싱한다.
 *
 * 키 원문(PEM)과 서명 키는 로그·에러 메시지·throw되는 에러 어디에도 담지 않는다 —
 * fromProvider가 원인 메시지를 warn 로그로 남기므로, import 실패는 변수 이름만 밝힌다.
 */

import { readFileSync } from 'node:fs';
import { importPKCS8, SignJWT, type CryptoKey } from 'jose';

import { env } from '@spfn/auth/config';

const APPLE_AUDIENCE = 'https://appleid.apple.com';

/** 발급한 client secret의 수명(초) */
const CLIENT_SECRET_TTL_SECONDS = 3600;

/** 만료까지 이보다 적게 남은 캐시는 쓰지 않고 새로 발급한다(초). 요청 도중 만료를 피한다. */
const CLIENT_SECRET_REUSE_MARGIN_SECONDS = 60;

export interface AppleSigningIdentity
{
    teamId: string;
    keyId: string;
    servicesId: string;
}

/** 키를 담은 env 변수 이름과 그 PEM — 에러는 이름만, 서명은 PEM만 쓴다. */
export interface AppleKeySource
{
    variable: 'SPFN_AUTH_APPLE_PRIVATE_KEY' | 'SPFN_AUTH_APPLE_PRIVATE_KEY_FILE';
    pem: string;
}

interface CachedSecret
{
    value: string;
    expiresAt: number;
}

const secretCache = new Map<string, CachedSecret>();

/**
 * 설정된 키 변수에서 PEM을 읽는다. PEM 변수가 우선이고, 없으면 파일 변수의 경로를 읽는다.
 *
 * 둘 다 설정된 구성은 부팅 검사(assertAppleWebConfig)가 거부하고, isEnabled도 false라
 * 웹 흐름이 여기까지 오지 않는다.
 */
export function readAppleKeySource(): AppleKeySource
{
    if (env.SPFN_AUTH_APPLE_PRIVATE_KEY)
    {
        return { variable: 'SPFN_AUTH_APPLE_PRIVATE_KEY', pem: env.SPFN_AUTH_APPLE_PRIVATE_KEY };
    }

    return {
        variable: 'SPFN_AUTH_APPLE_PRIVATE_KEY_FILE',
        pem: readFileSync(env.SPFN_AUTH_APPLE_PRIVATE_KEY_FILE ?? '', 'utf8'),
    };
}

/**
 * PEM을 ES256 서명 키로 가져온다.
 *
 * env 한 줄에 담기 위해 개행을 두 글자 `\n`으로 적은 값도 받는다.
 * 실패 원인(jose의 메시지)은 버린다 — 키 내용이 섞일 수 있는 문자열을 밖으로 내보내지 않는다.
 */
export async function importAppleSigningKey(source: AppleKeySource): Promise<CryptoKey>
{
    return await importPKCS8(source.pem.replaceAll('\\n', '\n'), 'ES256')
        .catch(() => Promise.reject(
            new Error(`${source.variable} is not a PKCS#8 EC P-256 private key`),
        ));
}

/**
 * token 요청에 쓸 client secret JWT. 같은 (Team ID, Key ID, Services ID)에는 만료 60초 전까지
 * 한 번 발급한 값을 재사용한다.
 */
export async function getAppleClientSecret(identity: AppleSigningIdentity): Promise<string>
{
    const cacheKey = `${identity.teamId}:${identity.keyId}:${identity.servicesId}`;
    const now = Math.floor(Date.now() / 1000);
    const cached = secretCache.get(cacheKey);

    if (cached && cached.expiresAt - now > CLIENT_SECRET_REUSE_MARGIN_SECONDS)
    {
        return cached.value;
    }

    const expiresAt = now + CLIENT_SECRET_TTL_SECONDS;
    const value = await new SignJWT({})
        .setProtectedHeader({ alg: 'ES256', kid: identity.keyId })
        .setIssuer(identity.teamId)
        .setSubject(identity.servicesId)
        .setAudience(APPLE_AUDIENCE)
        .setIssuedAt(now)
        .setExpirationTime(expiresAt)
        .sign(await importAppleSigningKey(readAppleKeySource()));

    secretCache.set(cacheKey, { value, expiresAt });

    return value;
}

/** 테스트 전용: 발급해 둔 client secret을 모두 버린다. */
export function resetAppleClientSecretCache(): void
{
    secretCache.clear();
}
