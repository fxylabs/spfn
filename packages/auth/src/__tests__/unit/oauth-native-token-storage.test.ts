/**
 * native 로그인은 provider access token을 저장하지 않는다 (issue #56, #57)
 *
 * 클라이언트가 보내는 accessToken은 id_token이 담지 못한 이메일을 provider API로 확인하는
 * 용도로만 쓰이고, 검증이 끝나면 버려진다. 소비자(spfn-mobile)가 이 필드를 받아들인 조건이
 * 바로 그 성질이라, 저장 경로가 생기면 이 테스트가 깨져야 한다.
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
    registerPublicKeyService: vi.fn(async () => undefined),
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
    providerUserId: 'kakao-1',
    email: 'user@example.com',
    emailVerified: true,
}));

vi.mock('../../server/lib/oauth', () => ({
    getOAuthProvider: () => ({ id: 'kakao', verifyNativeIdToken }),
}));

import { oauthNativeService } from '../../server/services/oauth-native.service';

// nonce는 publicKey의 fingerprint여야 통과한다 (issue #63) — 실제 키 한 벌로 값을 만든다.
const { publicKey: clientPublicKeyPem } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const clientKeyDer = clientPublicKeyPem.export({ type: 'spki', format: 'der' });
const fingerprint = createHash('sha256').update(clientKeyDer).digest('hex');

const params = {
    provider: 'kakao' as const,
    idToken: 'id.token.value',
    nonce: fingerprint,
    accessToken: 'provider-access-token',
    publicKey: clientKeyDer.toString('base64'),
    keyId: 'kid',
    fingerprint,
    algorithm: 'ES256' as const,
};

describe('native sign-in does not persist the provider access token', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
    });

    it('passes the access token to the provider for verification only', async () =>
    {
        await oauthNativeService(params);

        expect(verifyNativeIdToken).toHaveBeenCalledWith('id.token.value', {
            nonce: fingerprint,
            accessToken: 'provider-access-token',
        });
    });

    it('creates the account without provider tokens', async () =>
    {
        await oauthNativeService(params);

        // createOrLinkUser(provider, identity, tokens, metadata) — tokens 자리가 비어 있어야
        // social_accounts에 accessToken/refreshToken이 저장되지 않는다.
        const [, , tokens] = createOrLinkUser.mock.calls[0] as unknown[];
        expect(tokens).toBeUndefined();
    });
});
