/**
 * native 로그인은 id_token과 등록될 공개키를 nonce로 묶는다 (issue #63)
 *
 * id_token은 소지만 하면 되는 자격증명이라, 그것만 검증하면 유효한 토큰 하나를 쥔 쪽이 남의
 * 계정에 자기 공개키를 올릴 수 있다. nonce를 키의 fingerprint로 못박으면 훔친 토큰은 피해자
 * 키의 fingerprint를 담고 있어 공격자 키와 짝지을 수 없다.
 *
 * 결속은 provider 검증(외부 JWKS 조회)보다 먼저 끝나야 한다 — 그래서 거절된 요청이 provider를
 * 호출하지 않는 것까지 여기서 고정한다.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';

const {
    createOrLinkUser,
    socialAccountsRepository,
    registerPublicKeyService,
} = vi.hoisted(() => ({
    createOrLinkUser: vi.fn(async () => ({ userId: 1, isNewUser: true })),
    socialAccountsRepository: {
        findByProviderAndProviderId: vi.fn(async () => null),
    },
    // `{ pending: false }` is the answer a registration that was not stopped for
    // a second factor gives (#95). This suite is about the nonce binding, which
    // is checked before registration is reached at all.
    registerPublicKeyService: vi.fn(async () => ({ pending: false, binding: 'none', expiresAt: null })),
}));

vi.mock('@spfn/core/db', () => ({
    runInTransaction: (fn: () => unknown) => fn(),
    onAfterCommit: (fn: () => void) => fn(),
}));

vi.mock('../../server/repositories', () => ({ socialAccountsRepository }));

vi.mock('../../server/services/oauth.service', () => ({
    createOrLinkUser,
    assertActiveForOAuthSession: vi.fn(async () => undefined),
    backfillVerifiedEmail: vi.fn(async () => undefined),
}));

vi.mock('../../server/services/key.service', () => ({ registerPublicKeyService }));
// The login event carries `mfaEnrolled` (#95); this suite is about the route's
// own behaviour, so the lookup behind it is stubbed like every other service
// this route reaches.
vi.mock('../../server/services/mfa.service', () => ({ mfaEnrolledForUser: vi.fn(async () => false) }));
vi.mock('../../server/services/user.service', () => ({ updateLastLoginService: vi.fn(async () => undefined) }));

vi.mock('../../server/events', () => ({
    authLoginEvent: { emit: vi.fn() },
    authRegisterEvent: { emit: vi.fn() },
}));

const verifyNativeIdToken = vi.fn(async () => ({
    providerUserId: 'provider-user-1',
    email: 'user@example.com',
    emailVerified: true,
}));

vi.mock('../../server/lib/oauth', () => ({
    getOAuthProvider: () => ({ id: 'kakao', verifyNativeIdToken }),
}));

import { oauthNativeService } from '../../server/services/oauth-native.service';
// 서비스가 던지는 것과 같은 모듈에서 가져온다 — 상대경로로 받으면 별칭 해석이 갈려 다른
// 클래스 객체가 로드되고 instanceof가 어긋난다.
import { InvalidKeyFingerprintError, NonceKeyBindingError } from '@spfn/auth/errors';

/** 클라이언트가 만드는 것과 같은 모양의 키 한 벌 — Base64 DER(SPKI)과 그 SHA-256 hex. */
function generateClientKey(): { publicKey: string; fingerprint: string }
{
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = publicKey.export({ type: 'spki', format: 'der' });

    return {
        publicKey: der.toString('base64'),
        fingerprint: createHash('sha256').update(der).digest('hex'),
    };
}

function paramsFor(key: { publicKey: string; fingerprint: string }, nonce?: string)
{
    return {
        provider: 'kakao' as const,
        idToken: 'id.token.value',
        nonce: nonce ?? key.fingerprint,
        publicKey: key.publicKey,
        keyId: 'key-id-1',
        fingerprint: key.fingerprint,
        algorithm: 'ES256' as const,
    };
}

describe('native sign-in binds the id_token to the key being enrolled', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
    });

    it('accepts a request whose nonce is the fingerprint of its public key', async () =>
    {
        const key = generateClientKey();

        const result = await oauthNativeService(paramsFor(key));

        expect(result).toEqual({ mfaRequired: false, userId: '1', keyId: 'key-id-1', isNewUser: true });
        expect(verifyNativeIdToken).toHaveBeenCalledOnce();
        expect(registerPublicKeyService).toHaveBeenCalledOnce();
    });

    it('passes the raw fingerprint to the provider as the expected nonce', async () =>
    {
        const key = generateClientKey();

        await oauthNativeService(paramsFor(key));

        expect(verifyNativeIdToken).toHaveBeenCalledWith(
            'id.token.value',
            expect.objectContaining({ nonce: key.fingerprint }),
        );
    });

    it('refuses a nonce that is not the fingerprint', async () =>
    {
        const key = generateClientKey();
        const params = paramsFor(key, 'f'.repeat(64));

        await expect(oauthNativeService(params)).rejects.toThrow(NonceKeyBindingError);
    });

    it('refuses before reaching the provider, so a bad binding costs no JWKS lookup', async () =>
    {
        const key = generateClientKey();

        await expect(oauthNativeService(paramsFor(key, 'random-nonce'))).rejects.toThrow(NonceKeyBindingError);

        expect(verifyNativeIdToken).not.toHaveBeenCalled();
        expect(registerPublicKeyService).not.toHaveBeenCalled();
    });

    it('refuses a fingerprint that is not the hash of the submitted key', async () =>
    {
        const victim = generateClientKey();
        const attacker = generateClientKey();

        // nonce와 fingerprint는 서로 같지만, 그 fingerprint는 제출된 키의 해시가 아니다.
        const params = {
            ...paramsFor(attacker),
            nonce: victim.fingerprint,
            fingerprint: victim.fingerprint,
        };

        await expect(oauthNativeService(params)).rejects.toThrow(InvalidKeyFingerprintError);
        expect(verifyNativeIdToken).not.toHaveBeenCalled();
    });

    it('refuses the stolen-id_token attack: victim nonce with the attacker key', async () =>
    {
        const victim = generateClientKey();
        const attacker = generateClientKey();

        // 훔친 id_token의 nonce는 피해자 키의 fingerprint다. 공격자가 자기 키를 올리려면 nonce를
        // 그대로 둔 채 publicKey·fingerprint만 자기 것으로 바꿔야 하는데, 두 조합 모두 막힌다.
        const keepsOwnFingerprint = { ...paramsFor(attacker), nonce: victim.fingerprint };
        await expect(oauthNativeService(keepsOwnFingerprint)).rejects.toThrow(NonceKeyBindingError);

        const copiesVictimFingerprint = {
            ...paramsFor(attacker),
            nonce: victim.fingerprint,
            fingerprint: victim.fingerprint,
        };
        await expect(oauthNativeService(copiesVictimFingerprint)).rejects.toThrow(InvalidKeyFingerprintError);

        expect(registerPublicKeyService).not.toHaveBeenCalled();
    });
});
