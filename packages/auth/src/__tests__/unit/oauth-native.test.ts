/**
 * @spfn/auth - Native Social Login (id_token verification) Unit Tests
 *
 * 실제 ES256 키페어로 id_token을 서명하고, jose의 원격 JWKS 조회만 mock하여
 * 로컬 공개키로 검증한다. 따라서 서명·issuer·audience·만료·nonce는 실제로 검사된다.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { generateKeyPair, SignJWT, createRemoteJWKSet } from 'jose';

// 원격 JWKS 조회만 교체. jwtVerify/SignJWT 등은 실제 구현을 쓴다.
vi.mock('jose', async (importOriginal) =>
{
    const actual = await importOriginal<typeof import('jose')>();

    return { ...actual, createRemoteJWKSet: vi.fn() };
});

import { getOAuthProvider } from '../../server/lib/oauth';

const GOOGLE_ISS = 'https://accounts.google.com';
const APPLE_ISS = 'https://appleid.apple.com';
const KAKAO_ISS = 'https://kauth.kakao.com';
const NAVER_ISS = 'https://nid.naver.com';

// 카카오는 앱 하나가 키를 여러 벌 쓴다 — 네이티브 앱 키(앱 SDK)와 REST API 키(웹).
const KAKAO_NATIVE_KEY = 'kakao-native-app-key';
const KAKAO_REST_KEY = 'kakao-rest-api-key';

// 네이버는 애플리케이션 하나에 client id가 하나다.
const NAVER_CLIENT_ID = 'naver-client-id';

let privateKey: CryptoKey;
let publicKey: CryptoKey;

beforeEach(async () =>
{
    // Google/Apple id_token은 RS256으로 서명된다.
    const kp = await generateKeyPair('RS256');
    privateKey = kp.privateKey;
    publicKey = kp.publicKey;

    // 캐시된 resolver도 항상 현재 테스트의 공개키를 반환하도록 클로저로 참조한다.
    vi.mocked(createRemoteJWKSet).mockReturnValue((async () => publicKey) as never);

    vi.stubEnv('SPFN_AUTH_GOOGLE_NATIVE_CLIENT_IDS', 'ios.example.com,android.example.com');
    vi.stubEnv('SPFN_AUTH_APPLE_CLIENT_IDS', 'com.example.app');
    vi.stubEnv('SPFN_AUTH_KAKAO_NATIVE_CLIENT_IDS', KAKAO_NATIVE_KEY);
    vi.stubEnv('SPFN_AUTH_KAKAO_CLIENT_ID', KAKAO_REST_KEY);
    vi.stubEnv('SPFN_AUTH_NAVER_CLIENT_ID', NAVER_CLIENT_ID);
});

afterEach(() =>
{
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

interface TokenOptions
{
    iss: string;
    aud: string;
    sub: string;
    expSeconds?: number;
    /** iat claim (Unix seconds). 생략하면 현재 시각. 토큰 나이 상한 검사에 쓴다. */
    iatSeconds?: number;
    /** true면 iat claim을 아예 넣지 않는다. */
    omitIat?: boolean;
}

async function signToken(claims: Record<string, unknown>, opts: TokenOptions): Promise<string>
{
    const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256' })
        .setIssuer(opts.iss)
        .setAudience(opts.aud)
        .setSubject(opts.sub);

    if (!opts.omitIat)
    {
        jwt.setIssuedAt(opts.iatSeconds);
    }

    if (opts.expSeconds !== undefined)
    {
        jwt.setExpirationTime(opts.expSeconds);
    }
    else
    {
        jwt.setExpirationTime('1h');
    }

    return jwt.sign(privateKey);
}

describe('Native id_token - Google', () =>
{
    it('verifies a valid id_token and normalizes the identity', async () =>
    {
        const google = getOAuthProvider('google')!;

        const token = await signToken(
            { email: 'user@example.com', email_verified: true, name: 'User', picture: 'https://pic', nonce: 'raw-nonce' },
            { iss: GOOGLE_ISS, aud: 'ios.example.com', sub: 'google-123' },
        );

        const identity = await google.verifyNativeIdToken!(token, { nonce: 'raw-nonce' });

        expect(identity.providerUserId).toBe('google-123');
        expect(identity.email).toBe('user@example.com');
        expect(identity.emailVerified).toBe(true);
        expect(identity.name).toBe('User');
        expect(identity.avatar).toBe('https://pic');
    });

    it('rejects a mismatched nonce', async () =>
    {
        const google = getOAuthProvider('google')!;

        const token = await signToken(
            { nonce: 'real-nonce' },
            { iss: GOOGLE_ISS, aud: 'ios.example.com', sub: 'g' },
        );

        await expect(google.verifyNativeIdToken!(token, { nonce: 'attacker-nonce' }))
            .rejects.toThrow(/nonce/i);
    });

    it('rejects a token whose audience is not an allowed client id', async () =>
    {
        const google = getOAuthProvider('google')!;

        const token = await signToken(
            { nonce: 'n' },
            { iss: GOOGLE_ISS, aud: 'attacker.example.com', sub: 'g' },
        );

        await expect(google.verifyNativeIdToken!(token, { nonce: 'n' })).rejects.toThrow();
    });

    it('rejects an expired token', async () =>
    {
        const google = getOAuthProvider('google')!;

        const token = await signToken(
            { nonce: 'n' },
            { iss: GOOGLE_ISS, aud: 'ios.example.com', sub: 'g', expSeconds: Math.floor(Date.now() / 1000) - 60 },
        );

        await expect(google.verifyNativeIdToken!(token, { nonce: 'n' })).rejects.toThrow();
    });

    it('also accepts the web client id (SPFN_AUTH_GOOGLE_CLIENT_ID) as audience', async () =>
    {
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', 'web.example.com');
        const google = getOAuthProvider('google')!;

        const token = await signToken(
            { nonce: 'n' },
            { iss: GOOGLE_ISS, aud: 'web.example.com', sub: 'g' },
        );

        const identity = await google.verifyNativeIdToken!(token, { nonce: 'n' });
        expect(identity.providerUserId).toBe('g');
    });

    it('throws when native client ids are not configured', async () =>
    {
        vi.stubEnv('SPFN_AUTH_GOOGLE_NATIVE_CLIENT_IDS', '');
        vi.stubEnv('SPFN_AUTH_GOOGLE_CLIENT_ID', '');
        const google = getOAuthProvider('google')!;

        const token = await signToken({ nonce: 'n' }, { iss: GOOGLE_ISS, aud: 'ios.example.com', sub: 'g' });

        await expect(google.verifyNativeIdToken!(token, { nonce: 'n' })).rejects.toThrow(/not configured/i);
    });

    it('rejects a token missing the sub claim', async () =>
    {
        const google = getOAuthProvider('google')!;

        // setSubject 없이 서명 → sub claim 부재
        const token = await new SignJWT({ nonce: 'n' })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer(GOOGLE_ISS)
            .setAudience('ios.example.com')
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(privateKey);

        await expect(google.verifyNativeIdToken!(token, { nonce: 'n' })).rejects.toThrow(/sub/i);
    });

    it('rejects a token signed with a non-whitelisted algorithm (ES256)', async () =>
    {
        const google = getOAuthProvider('google')!;

        const es = await generateKeyPair('ES256');
        // mock JWKS resolver가 이 ES256 공개키를 돌려주도록 교체
        vi.mocked(createRemoteJWKSet).mockReturnValue((async () => es.publicKey) as never);

        const token = await new SignJWT({ nonce: 'n' })
            .setProtectedHeader({ alg: 'ES256' })
            .setIssuer(GOOGLE_ISS)
            .setAudience('ios.example.com')
            .setSubject('g')
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(es.privateKey);

        // verifyIdToken은 algorithms: ['RS256']만 허용하므로 ES256은 거부돼야 한다.
        await expect(google.verifyNativeIdToken!(token, { nonce: 'n' })).rejects.toThrow();
    });
});

describe('Native id_token - Apple', () =>
{
    it('verifies a token with SHA-256 hashed nonce and string email_verified', async () =>
    {
        const apple = getOAuthProvider('apple')!;
        const rawNonce = 'raw-apple-nonce';
        const hashedNonce = createHash('sha256').update(rawNonce).digest('hex');

        const token = await signToken(
            { email: 'abc@privaterelay.appleid.com', email_verified: 'true', is_private_email: 'true', nonce: hashedNonce },
            { iss: APPLE_ISS, aud: 'com.example.app', sub: 'apple-xyz' },
        );

        const identity = await apple.verifyNativeIdToken!(token, { nonce: rawNonce });

        expect(identity.providerUserId).toBe('apple-xyz');
        expect(identity.email).toBe('abc@privaterelay.appleid.com');
        // string "true" → boolean true 정규화
        expect(identity.emailVerified).toBe(true);
    });

    it('rejects when the nonce was not SHA-256 hashed', async () =>
    {
        const apple = getOAuthProvider('apple')!;
        const rawNonce = 'raw-nonce';

        // 토큰에 raw nonce를 담았지만 apple provider는 sha256(rawNonce)를 기대한다.
        const token = await signToken(
            { email_verified: 'true', nonce: rawNonce },
            { iss: APPLE_ISS, aud: 'com.example.app', sub: 'a' },
        );

        await expect(apple.verifyNativeIdToken!(token, { nonce: rawNonce })).rejects.toThrow(/nonce/i);
    });

    it('rejects a token from the wrong issuer', async () =>
    {
        const apple = getOAuthProvider('apple')!;
        const rawNonce = 'n';
        const hashedNonce = createHash('sha256').update(rawNonce).digest('hex');

        const token = await signToken(
            { nonce: hashedNonce },
            { iss: 'https://evil.example.com', aud: 'com.example.app', sub: 'a' },
        );

        await expect(apple.verifyNativeIdToken!(token, { nonce: rawNonce })).rejects.toThrow();
    });

    it('throws when apple client ids are not configured', async () =>
    {
        vi.stubEnv('SPFN_AUTH_APPLE_CLIENT_IDS', '');
        const apple = getOAuthProvider('apple')!;

        await expect(apple.verifyNativeIdToken!('any.token.here', { nonce: 'n' }))
            .rejects.toThrow(/not configured/i);
    });

    // Native audiences alone do not enable the web flow (#142): it needs the Services ID, Team ID,
    // Key ID and private key, and says so instead of building a URL Apple would refuse.
    it('refuses the web flow when only native audiences are configured', () =>
    {
        const apple = getOAuthProvider('apple')!;
        expect(apple.isEnabled()).toBe(false);
        expect(() => apple.getAuthUrl('state')).toThrow(/SPFN_AUTH_APPLE_SERVICES_ID/);
    });
});

/**
 * 카카오 user-info(/v2/user/me) 응답을 흉내낸다.
 *
 * `id`는 카카오 회원번호로, id_token의 sub와 같은 값이어야 정상 경로다.
 */
function mockKakaoUserInfo(body: Record<string, unknown>): void
{
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => body,
    })));
}

/**
 * AbortSignal.timeout이 만료 시 던지는 것과 같은 모양의 에러
 *
 * DOMException은 Error를 상속하므로 provider의 `.catch`가 `err instanceof Error`로 걸러
 * `reason`에 사람이 읽을 수 있는 문자열을 남긴다 — 정체불명의 shape가 아니다.
 */
function timeoutError(): Error
{
    return new DOMException('The operation was aborted due to timeout', 'TimeoutError');
}

function kakaoAccount(email: string | null, valid: boolean, verified: boolean): Record<string, unknown>
{
    return {
        email,
        is_email_valid: valid,
        is_email_verified: verified,
        profile: { nickname: '카카오사용자', profile_image_url: 'https://kakao/pic' },
    };
}

describe('Native id_token - Kakao', () =>
{
    it('verifies a valid id_token and normalizes the identity', async () =>
    {
        const kakao = getOAuthProvider('kakao')!;

        const token = await signToken(
            { email: 'user@example.com', nickname: '카카오사용자', picture: 'https://kakao/pic', nonce: 'raw-nonce' },
            { iss: KAKAO_ISS, aud: KAKAO_NATIVE_KEY, sub: '1234567890' },
        );

        const identity = await kakao.verifyNativeIdToken!(token, { nonce: 'raw-nonce' });

        expect(identity.providerUserId).toBe('1234567890');
        expect(identity.email).toBe('user@example.com');
        expect(identity.name).toBe('카카오사용자');
        expect(identity.avatar).toBe('https://kakao/pic');
    });

    it('leaves email unverified without an access token (id_token carries no email_verified)', async () =>
    {
        const kakao = getOAuthProvider('kakao')!;

        const token = await signToken(
            { email: 'user@example.com', nonce: 'n' },
            { iss: KAKAO_ISS, aud: KAKAO_NATIVE_KEY, sub: 'k-1' },
        );

        const identity = await kakao.verifyNativeIdToken!(token, { nonce: 'n' });

        expect(identity.email).toBe('user@example.com');
        expect(identity.emailVerified).toBe(false);
    });

    it('accepts the web REST API key as audience (web and app share one sub)', async () =>
    {
        const kakao = getOAuthProvider('kakao')!;

        const token = await signToken(
            { nonce: 'n' },
            { iss: KAKAO_ISS, aud: KAKAO_REST_KEY, sub: 'k-1' },
        );

        const identity = await kakao.verifyNativeIdToken!(token, { nonce: 'n' });

        expect(identity.providerUserId).toBe('k-1');
    });

    it('rejects a mismatched nonce (kakao sends the raw nonce, unhashed)', async () =>
    {
        const kakao = getOAuthProvider('kakao')!;

        const token = await signToken(
            { nonce: 'real-nonce' },
            { iss: KAKAO_ISS, aud: KAKAO_NATIVE_KEY, sub: 'k-1' },
        );

        await expect(kakao.verifyNativeIdToken!(token, { nonce: 'attacker-nonce' }))
            .rejects.toThrow(/nonce/i);
    });

    it('rejects an expired token', async () =>
    {
        const kakao = getOAuthProvider('kakao')!;

        const token = await signToken(
            { nonce: 'n' },
            { iss: KAKAO_ISS, aud: KAKAO_NATIVE_KEY, sub: 'k-1', expSeconds: 1 },
        );

        await expect(kakao.verifyNativeIdToken!(token, { nonce: 'n' })).rejects.toThrow();
    });

    it('rejects a token from the wrong issuer', async () =>
    {
        const kakao = getOAuthProvider('kakao')!;

        const token = await signToken(
            { nonce: 'n' },
            { iss: 'https://evil.example.com', aud: KAKAO_NATIVE_KEY, sub: 'k-1' },
        );

        await expect(kakao.verifyNativeIdToken!(token, { nonce: 'n' })).rejects.toThrow();
    });

    it('rejects a token whose audience is not an allowed app key', async () =>
    {
        const kakao = getOAuthProvider('kakao')!;

        const token = await signToken(
            { nonce: 'n' },
            { iss: KAKAO_ISS, aud: 'someone-elses-app-key', sub: 'k-1' },
        );

        await expect(kakao.verifyNativeIdToken!(token, { nonce: 'n' })).rejects.toThrow();
    });

    it('rejects a token without a sub claim', async () =>
    {
        const kakao = getOAuthProvider('kakao')!;

        const token = await new SignJWT({ nonce: 'n' })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer(KAKAO_ISS)
            .setAudience(KAKAO_NATIVE_KEY)
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(privateKey);

        await expect(kakao.verifyNativeIdToken!(token, { nonce: 'n' })).rejects.toThrow(/sub/i);
    });

    it('signs in with only the native app key configured (web flow stays disabled)', async () =>
    {
        // 모바일 전용 서비스: 웹 REST API 키가 없어도 네이티브 로그인은 되어야 한다.
        vi.stubEnv('SPFN_AUTH_KAKAO_CLIENT_ID', '');
        const kakao = getOAuthProvider('kakao')!;

        const token = await signToken(
            { nonce: 'n' },
            { iss: KAKAO_ISS, aud: KAKAO_NATIVE_KEY, sub: 'k-1' },
        );

        const identity = await kakao.verifyNativeIdToken!(token, { nonce: 'n' });

        expect(identity.providerUserId).toBe('k-1');
        // 웹 흐름 판정은 REST API 키에 그대로 묶여 있다.
        expect(kakao.isEnabled()).toBe(false);
    });

    it('throws when no kakao app key is configured', async () =>
    {
        vi.stubEnv('SPFN_AUTH_KAKAO_NATIVE_CLIENT_IDS', '');
        vi.stubEnv('SPFN_AUTH_KAKAO_CLIENT_ID', '');
        const kakao = getOAuthProvider('kakao')!;

        await expect(kakao.verifyNativeIdToken!('any.token.here', { nonce: 'n' }))
            .rejects.toThrow(/not configured/i);
    });

    describe('email verification via access token', () =>
    {
        async function signKakaoToken(sub: string): Promise<string>
        {
            return signToken(
                { email: 'from-token@example.com', nonce: 'n' },
                { iss: KAKAO_ISS, aud: KAKAO_NATIVE_KEY, sub },
            );
        }

        it('verifies the email when user-info confirms it and the subject matches', async () =>
        {
            const kakao = getOAuthProvider('kakao')!;
            mockKakaoUserInfo({ id: 'k-1', kakao_account: kakaoAccount('user@example.com', true, true) });

            const identity = await kakao.verifyNativeIdToken!(await signKakaoToken('k-1'), {
                nonce: 'n',
                accessToken: 'kakao-access-token',
            });

            expect(identity.email).toBe('user@example.com');
            expect(identity.emailVerified).toBe(true);
        });

        it('keeps id_token profile values that user-info does not return', async () =>
        {
            const kakao = getOAuthProvider('kakao')!;
            const token = await signToken(
                { email: 'from-token@example.com', nickname: '토큰닉네임', picture: 'https://token/pic', nonce: 'n' },
                { iss: KAKAO_ISS, aud: KAKAO_NATIVE_KEY, sub: 'k-1' },
            );

            // 이메일만 동의하고 프로필은 동의하지 않은 응답.
            mockKakaoUserInfo({ id: 'k-1', kakao_account: { email: 'user@example.com', is_email_valid: true, is_email_verified: true } });

            const identity = await kakao.verifyNativeIdToken!(token, {
                nonce: 'n',
                accessToken: 'kakao-access-token',
            });

            expect(identity.emailVerified).toBe(true);
            expect(identity.name).toBe('토큰닉네임');
            expect(identity.avatar).toBe('https://token/pic');
        });

        it('keeps the id_token email when user-info returns none', async () =>
        {
            const kakao = getOAuthProvider('kakao')!;

            // 프로필만 동의하고 이메일은 동의하지 않은 응답 — access token의 동의 범위가 id_token보다 좁다.
            mockKakaoUserInfo({
                id: 'k-1',
                kakao_account: { profile: { nickname: '카카오사용자', profile_image_url: 'https://kakao/pic' } },
            });

            const identity = await kakao.verifyNativeIdToken!(await signKakaoToken('k-1'), {
                nonce: 'n',
                accessToken: 'kakao-access-token',
            });

            expect(identity.email).toBe('from-token@example.com');
            expect(identity.emailVerified).toBe(false);
        });

        it('keeps the email unverified when kakao reports it as not verified', async () =>
        {
            const kakao = getOAuthProvider('kakao')!;
            mockKakaoUserInfo({ id: 'k-1', kakao_account: kakaoAccount('user@example.com', true, false) });

            const identity = await kakao.verifyNativeIdToken!(await signKakaoToken('k-1'), {
                nonce: 'n',
                accessToken: 'kakao-access-token',
            });

            // user-info가 이메일을 주면 id_token 이메일로 대체하지 않는다.
            expect(identity.email).toBe('user@example.com');
            expect(identity.emailVerified).toBe(false);
        });

        it('ignores an access token that belongs to another user', async () =>
        {
            const kakao = getOAuthProvider('kakao')!;

            // 공격자가 자신의 access token을 남의 id_token과 함께 보낸 상황.
            mockKakaoUserInfo({ id: 'attacker-999', kakao_account: kakaoAccount('victim@example.com', true, true) });

            const identity = await kakao.verifyNativeIdToken!(await signKakaoToken('k-1'), {
                nonce: 'n',
                accessToken: 'attacker-access-token',
            });

            expect(identity.providerUserId).toBe('k-1');
            expect(identity.email).toBe('from-token@example.com');
            expect(identity.emailVerified).toBe(false);
        });

        it('continues the sign-in when the user-info lookup fails', async () =>
        {
            const kakao = getOAuthProvider('kakao')!;
            vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

            const identity = await kakao.verifyNativeIdToken!(await signKakaoToken('k-1'), {
                nonce: 'n',
                accessToken: 'kakao-access-token',
            });

            expect(identity.providerUserId).toBe('k-1');
            expect(identity.emailVerified).toBe(false);
        });

        it('bounds the user-info request with an abort signal', async () =>
        {
            const kakao = getOAuthProvider('kakao')!;
            const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
                ok: true,
                status: 200,
                json: async () => ({ id: 'k-1', kakao_account: kakaoAccount('user@example.com', true, true) }),
            }));
            vi.stubGlobal('fetch', fetchMock);

            await kakao.verifyNativeIdToken!(await signKakaoToken('k-1'), {
                nonce: 'n',
                accessToken: 'kakao-access-token',
            });

            const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
            expect(init?.signal).toBeInstanceOf(AbortSignal);
        });

        it('continues the sign-in when the user-info request times out', async () =>
        {
            const kakao = getOAuthProvider('kakao')!;
            // AbortSignal.timeout이 던지는 것과 같은 모양(name: 'TimeoutError', Error 상속).
            vi.stubGlobal('fetch', vi.fn(async () =>
            {
                throw timeoutError();
            }));

            const identity = await kakao.verifyNativeIdToken!(await signKakaoToken('k-1'), {
                nonce: 'n',
                accessToken: 'kakao-access-token',
            });

            expect(identity.providerUserId).toBe('k-1');
            expect(identity.email).toBe('from-token@example.com');
            expect(identity.emailVerified).toBe(false);
        });
    });
});

/**
 * 네이버 user-info(/v1/nid/me) 응답을 흉내낸다.
 *
 * `response.id`는 pairwise 식별자로, id_token의 sub와 같은 값이어야 정상 경로다.
 */
function mockNaverUserInfo(response: Record<string, unknown>, resultcode = '00'): void
{
    vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ resultcode, message: 'success', response }),
    })));
}

describe('Native id_token - Naver', () =>
{
    async function signNaverToken(sub: string, nonce = 'n'): Promise<string>
    {
        // 네이버 id_token은 프로필 claim을 담지 않는다 — iss·aud·sub·nonce 등이 전부다.
        return signToken({ nonce, azp: NAVER_CLIENT_ID }, { iss: NAVER_ISS, aud: NAVER_CLIENT_ID, sub });
    }

    it('verifies a valid id_token and returns an identity without profile claims', async () =>
    {
        const naver = getOAuthProvider('naver')!;

        const identity = await naver.verifyNativeIdToken!(await signNaverToken('naver-sub-43'), { nonce: 'n' });

        expect(identity.providerUserId).toBe('naver-sub-43');
        expect(identity.email).toBeNull();
        expect(identity.emailVerified).toBe(false);
        expect(identity.name).toBeUndefined();
        expect(identity.avatar).toBeUndefined();
    });

    it('rejects a mismatched nonce (naver sends the raw nonce, unhashed)', async () =>
    {
        const naver = getOAuthProvider('naver')!;

        await expect(naver.verifyNativeIdToken!(await signNaverToken('s', 'real-nonce'), { nonce: 'attacker-nonce' }))
            .rejects.toThrow(/nonce/i);
    });

    it('rejects a nonce whose trailing character naver dropped', async () =>
    {
        const naver = getOAuthProvider('naver')!;

        // 네이버는 nonce의 끝 A를 떨어뜨린다. 엄격 비교라 거절되어야 한다 — 처방은 서버의
        // 관대한 비교가 아니라 클라이언트가 소문자 hex nonce를 쓰는 것이다(A가 안 나온다).
        const sent = 'hlvx137s33MX1kT-3bUhgA';
        const returned = 'hlvx137s33MX1kT-3bUhg';

        await expect(naver.verifyNativeIdToken!(await signNaverToken('s', returned), { nonce: sent }))
            .rejects.toThrow(/nonce/i);
    });

    it('rejects an expired token', async () =>
    {
        const naver = getOAuthProvider('naver')!;
        const token = await signToken({ nonce: 'n' }, { iss: NAVER_ISS, aud: NAVER_CLIENT_ID, sub: 's', expSeconds: 1 });

        await expect(naver.verifyNativeIdToken!(token, { nonce: 'n' })).rejects.toThrow();
    });

    it('rejects a token from the wrong issuer', async () =>
    {
        const naver = getOAuthProvider('naver')!;
        const token = await signToken({ nonce: 'n' }, { iss: 'https://evil.example.com', aud: NAVER_CLIENT_ID, sub: 's' });

        await expect(naver.verifyNativeIdToken!(token, { nonce: 'n' })).rejects.toThrow();
    });

    it('rejects a token whose audience is not an allowed client id', async () =>
    {
        const naver = getOAuthProvider('naver')!;
        const token = await signToken({ nonce: 'n' }, { iss: NAVER_ISS, aud: 'someone-elses-client-id', sub: 's' });

        await expect(naver.verifyNativeIdToken!(token, { nonce: 'n' })).rejects.toThrow();
    });

    it('rejects a token without a sub claim', async () =>
    {
        const naver = getOAuthProvider('naver')!;
        const token = await new SignJWT({ nonce: 'n' })
            .setProtectedHeader({ alg: 'RS256' })
            .setIssuer(NAVER_ISS)
            .setAudience(NAVER_CLIENT_ID)
            .setIssuedAt()
            .setExpirationTime('1h')
            .sign(privateKey);

        await expect(naver.verifyNativeIdToken!(token, { nonce: 'n' })).rejects.toThrow(/sub/i);
    });

    it('throws when no naver client id is configured', async () =>
    {
        vi.stubEnv('SPFN_AUTH_NAVER_CLIENT_ID', '');
        vi.stubEnv('SPFN_AUTH_NAVER_NATIVE_CLIENT_IDS', '');
        const naver = getOAuthProvider('naver')!;

        await expect(naver.verifyNativeIdToken!('any.token.here', { nonce: 'n' }))
            .rejects.toThrow(/not configured/i);
    });

    describe('email via access token', () =>
    {
        it('fills the verified email when user-info confirms the same subject', async () =>
        {
            const naver = getOAuthProvider('naver')!;
            mockNaverUserInfo({ id: 'naver-sub-43', email: 'user@example.com' });

            const identity = await naver.verifyNativeIdToken!(await signNaverToken('naver-sub-43'), {
                nonce: 'n',
                accessToken: 'naver-access-token',
            });

            expect(identity.email).toBe('user@example.com');
            // 네이버 프로필 이메일은 존재 자체가 검증을 뜻한다(웹 흐름과 같은 판정).
            expect(identity.emailVerified).toBe(true);
        });

        it('ignores an access token that belongs to another user', async () =>
        {
            const naver = getOAuthProvider('naver')!;

            // pairwise라 다른 애플리케이션에서 발급된 토큰은 sub가 다르다.
            mockNaverUserInfo({ id: 'attacker-sub', email: 'victim@example.com' });

            const identity = await naver.verifyNativeIdToken!(await signNaverToken('naver-sub-43'), {
                nonce: 'n',
                accessToken: 'attacker-access-token',
            });

            expect(identity.providerUserId).toBe('naver-sub-43');
            expect(identity.email).toBeNull();
            expect(identity.emailVerified).toBe(false);
        });

        it('continues the sign-in when the user-info lookup fails', async () =>
        {
            const naver = getOAuthProvider('naver')!;
            vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

            const identity = await naver.verifyNativeIdToken!(await signNaverToken('naver-sub-43'), {
                nonce: 'n',
                accessToken: 'naver-access-token',
            });

            expect(identity.providerUserId).toBe('naver-sub-43');
            expect(identity.email).toBeNull();
        });

        it('bounds the user-info request with an abort signal', async () =>
        {
            const naver = getOAuthProvider('naver')!;
            const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
                ok: true,
                status: 200,
                json: async () => ({ resultcode: '00', message: 'success', response: { id: 'naver-sub-43' } }),
            }));
            vi.stubGlobal('fetch', fetchMock);

            await naver.verifyNativeIdToken!(await signNaverToken('naver-sub-43'), {
                nonce: 'n',
                accessToken: 'naver-access-token',
            });

            const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
            expect(init?.signal).toBeInstanceOf(AbortSignal);
        });

        it('continues the sign-in when the user-info request times out', async () =>
        {
            const naver = getOAuthProvider('naver')!;
            vi.stubGlobal('fetch', vi.fn(async () =>
            {
                throw timeoutError();
            }));

            const identity = await naver.verifyNativeIdToken!(await signNaverToken('naver-sub-43'), {
                nonce: 'n',
                accessToken: 'naver-access-token',
            });

            expect(identity.providerUserId).toBe('naver-sub-43');
            expect(identity.email).toBeNull();
        });

        it('continues the sign-in when user-info reports a non-success resultcode', async () =>
        {
            const naver = getOAuthProvider('naver')!;
            mockNaverUserInfo({ id: 'naver-sub-43', email: 'user@example.com' }, '024');

            const identity = await naver.verifyNativeIdToken!(await signNaverToken('naver-sub-43'), {
                nonce: 'n',
                accessToken: 'naver-access-token',
            });

            expect(identity.email).toBeNull();
        });
    });
});

/**
 * 토큰 나이 상한 (jwks-verify의 MAX_TOKEN_AGE_SECONDS = 600초)
 *
 * nonce가 요청 본문으로 함께 오는 구조라 재사용 자체는 탐지할 수 없다. exp만으로는 유출된
 * 토큰이 provider 수명 내내 통하므로(카카오 12시간), iat 기준 상한이 그 창을 좁힌다.
 * exp는 항상 미래로 두어 이 검사만 단독으로 확인한다.
 */
describe('Native id_token - token age', () =>
{
    const nowSeconds = (): number => Math.floor(Date.now() / 1000);

    interface AgeCase
    {
        provider: 'google' | 'apple' | 'kakao' | 'naver';
        iss: string;
        aud: string;
        /** id_token의 nonce claim (Apple만 SHA-256 해시). */
        tokenNonce: string;
        /** 클라이언트가 보내는 raw nonce. */
        rawNonce: string;
    }

    const cases: AgeCase[] = [
        { provider: 'google', iss: GOOGLE_ISS, aud: 'ios.example.com', tokenNonce: 'n', rawNonce: 'n' },
        {
            provider: 'apple',
            iss: APPLE_ISS,
            aud: 'com.example.app',
            tokenNonce: createHash('sha256').update('n').digest('hex'),
            rawNonce: 'n',
        },
        { provider: 'kakao', iss: KAKAO_ISS, aud: KAKAO_NATIVE_KEY, tokenNonce: 'n', rawNonce: 'n' },
        { provider: 'naver', iss: NAVER_ISS, aud: NAVER_CLIENT_ID, tokenNonce: 'n', rawNonce: 'n' },
    ];

    for (const c of cases)
    {
        // 상한(600초)을 시계 오차 허용치(30초)와 함께 넘긴 값 — 경계 근처가 아니라 확실히 밖.
        it(`rejects a ${c.provider} token issued outside the age window`, async () =>
        {
            const provider = getOAuthProvider(c.provider)!;
            const token = await signToken(
                { nonce: c.tokenNonce },
                { iss: c.iss, aud: c.aud, sub: `${c.provider}-old`, iatSeconds: nowSeconds() - 1800 },
            );

            await expect(provider.verifyNativeIdToken!(token, { nonce: c.rawNonce })).rejects.toThrow();
        });

        // 정상 클라이언트가 겪을 수 있는 지연(수 분)은 그대로 통과해야 한다.
        it(`accepts a ${c.provider} token issued inside the age window`, async () =>
        {
            const provider = getOAuthProvider(c.provider)!;
            const token = await signToken(
                { nonce: c.tokenNonce },
                { iss: c.iss, aud: c.aud, sub: `${c.provider}-fresh`, iatSeconds: nowSeconds() - 300 },
            );

            const identity = await provider.verifyNativeIdToken!(token, { nonce: c.rawNonce });

            expect(identity.providerUserId).toBe(`${c.provider}-fresh`);
        });

        // iat은 OIDC 필수 claim이다. 없으면 나이를 판정할 수 없으므로 거부한다.
        it(`rejects a ${c.provider} token without an iat claim`, async () =>
        {
            const provider = getOAuthProvider(c.provider)!;
            const token = await signToken(
                { nonce: c.tokenNonce },
                { iss: c.iss, aud: c.aud, sub: `${c.provider}-no-iat`, omitIat: true },
            );

            await expect(provider.verifyNativeIdToken!(token, { nonce: c.rawNonce })).rejects.toThrow();
        });
    }
});

describe('Native id_token - provider registry', () =>
{
    it('auto-registers google, apple, kakao and naver providers on module load', () =>
    {
        expect(getOAuthProvider('google')?.verifyNativeIdToken).toBeTypeOf('function');
        expect(getOAuthProvider('apple')?.verifyNativeIdToken).toBeTypeOf('function');
        expect(getOAuthProvider('kakao')?.verifyNativeIdToken).toBeTypeOf('function');
        expect(getOAuthProvider('naver')?.verifyNativeIdToken).toBeTypeOf('function');
    });
});
