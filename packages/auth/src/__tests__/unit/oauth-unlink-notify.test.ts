/**
 * Provider발 연동 해제(unlink-notify) 검증·처리 테스트
 *
 * - kakao: 어드민 키 헤더 검증
 * - naver: HMAC 서명 검증 + encryptUniqueId AES 복호화 (네이버 규격을 테스트에서
 *   독립 구현해 상호 검증)
 * - service: 소셜 연결 삭제 + auth.oauth.unlinked 이벤트 발행
 */

import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { socialAccountsRepository, usersRepository, oauthUnlinkedEvent } = vi.hoisted(() => ({
    socialAccountsRepository: {
        findByProviderAndProviderId: vi.fn(),
        deleteById: vi.fn(),
    },
    usersRepository: { lockAccount: vi.fn(async () => ({ id: 7 })) },
    oauthUnlinkedEvent: { emit: vi.fn() },
}));

vi.mock('../../server/repositories', () => ({ usersRepository, socialAccountsRepository }));
vi.mock('@spfn/core/db', async (importOriginal) => ({
    ...await importOriginal<typeof import('@spfn/core/db')>(),
    runInTransaction: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../../server/events', async (importOriginal) =>
{
    const original = await importOriginal<typeof import('../../server/events')>();

    return { ...original, oauthUnlinkedEvent };
});

import { kakaoProvider } from '@/server/lib/oauth/kakao-provider';
import { naverProvider } from '@/server/lib/oauth/naver-provider';
import { UnlinkNotifyRejection } from '@/server/lib/oauth/provider';
import { oauthUnlinkNotifyService } from '@/server/services/oauth.service';

describe('Kakao unlink webhook verification', () =>
{
    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_KAKAO_CLIENT_ID', 'kakao-client-id');
        vi.stubEnv('SPFN_AUTH_KAKAO_ADMIN_KEY', 'kakao-admin-key');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('accepts a request carrying the admin key and extracts the user', async () =>
    {
        await expect(kakaoProvider.verifyUnlinkNotification!({
            authorization: 'KakaoAK kakao-admin-key',
            fields: { app_id: '1234', user_id: '987654', referrer_type: 'UNLINK_FROM_APPS' },
        })).resolves.toEqual({
            providerUserId: '987654',
            reason: 'UNLINK_FROM_APPS',
        });
    });

    it('rejects with 401 when the admin key does not match', async () =>
    {
        await expect(kakaoProvider.verifyUnlinkNotification!({
            authorization: 'KakaoAK wrong-key',
            fields: { user_id: '987654' },
        })).rejects.toMatchObject({ status: 401 });
    });

    it('rejects with 401 when the admin key env is not configured', async () =>
    {
        vi.stubEnv('SPFN_AUTH_KAKAO_ADMIN_KEY', '');

        await expect(kakaoProvider.verifyUnlinkNotification!({
            authorization: 'KakaoAK kakao-admin-key',
            fields: { user_id: '987654' },
        })).rejects.toBeInstanceOf(UnlinkNotifyRejection);
    });

    it('rejects with 400 when user_id is missing', async () =>
    {
        await expect(kakaoProvider.verifyUnlinkNotification!({
            authorization: 'KakaoAK kakao-admin-key',
            fields: { app_id: '1234' },
        })).rejects.toMatchObject({ status: 400 });
    });
});

describe('Naver unlink notification verification', () =>
{
    const clientId = 'naver-client-id';
    const clientSecret = 'naver-client-secret';

    /** 네이버 규격의 독립 구현: key = md5(secret)[0..16] */
    function deriveKey(): Buffer
    {
        return createHash('md5').update(clientSecret).digest().subarray(0, 16);
    }

    /** encryptUniqueId = base64url( iv + AES-128-CBC(uniqueId) ) */
    function encryptUniqueId(uniqueId: string): string
    {
        const iv = randomBytes(16);
        const cipher = createCipheriv('aes-128-cbc', deriveKey(), iv);
        const encrypted = Buffer.concat([cipher.update(uniqueId, 'utf8'), cipher.final()]);

        return Buffer.concat([iv, encrypted]).toString('base64url');
    }

    function sign(encrypted: string, timestamp: string): string
    {
        return createHmac('sha256', deriveKey())
            .update(`clientId=${clientId}&encryptUniqueId=${encrypted}&timestamp=${timestamp}`)
            .digest('base64url');
    }

    beforeEach(() =>
    {
        vi.stubEnv('SPFN_AUTH_NAVER_CLIENT_ID', clientId);
        vi.stubEnv('SPFN_AUTH_NAVER_CLIENT_SECRET', clientSecret);
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('refuses a validly signed notification whose timestamp is from 2023 (a replay)', async () =>
    {
        const encrypted = encryptUniqueId('NAVER_UNIQUE_ID_001');
        const timestamp = '1693877406';

        await expect(naverProvider.verifyUnlinkNotification!({
            authorization: null,
            fields: {
                clientId,
                encryptUniqueId: encrypted,
                timestamp,
                signature: sign(encrypted, timestamp),
            },
        })).rejects.toMatchObject({ status: 400 });
    });

    it('answers success with 204 No Content per the Naver spec', () =>
    {
        expect(naverProvider.unlinkNotifyAckStatus).toBe(204);
    });

    it('rejects with 403 when clientId does not match', async () =>
    {
        const encrypted = encryptUniqueId('NAVER_UNIQUE_ID_001');

        await expect(naverProvider.verifyUnlinkNotification!({
            authorization: null,
            fields: {
                clientId: 'other-client',
                encryptUniqueId: encrypted,
                timestamp: '1',
                signature: sign(encrypted, '1'),
            },
        })).rejects.toMatchObject({ status: 403 });
    });

    it('rejects with 403 when the signature is forged', async () =>
    {
        const encrypted = encryptUniqueId('NAVER_UNIQUE_ID_001');

        await expect(naverProvider.verifyUnlinkNotification!({
            authorization: null,
            fields: {
                clientId,
                encryptUniqueId: encrypted,
                timestamp: '1693877406',
                signature: sign(encrypted, '9999999999'),
            },
        })).rejects.toMatchObject({ status: 403 });
    });

    it('rejects with 400 when encryptUniqueId is validly signed but not decryptable', async () =>
    {
        const garbage = Buffer.concat([randomBytes(16), randomBytes(8)]).toString('base64url');
        const timestamp = String(Math.floor(Date.now() / 1000));

        await expect(naverProvider.verifyUnlinkNotification!({
            authorization: null,
            fields: {
                clientId,
                encryptUniqueId: garbage,
                timestamp,
                signature: sign(garbage, timestamp),
            },
        })).rejects.toMatchObject({ status: 400 });
    });

    it('rejects with 400 when required parameters are missing', async () =>
    {
        await expect(naverProvider.verifyUnlinkNotification!({
            authorization: null,
            fields: { clientId },
        })).rejects.toMatchObject({ status: 400 });
    });
});

describe('oauthUnlinkNotifyService', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        vi.stubEnv('SPFN_AUTH_KAKAO_CLIENT_ID', 'kakao-client-id');
        vi.stubEnv('SPFN_AUTH_NAVER_CLIENT_ID', 'naver-client-id');
        vi.stubEnv('SPFN_AUTH_NAVER_CLIENT_SECRET', 'naver-client-secret');
    });

    afterEach(() =>
    {
        vi.unstubAllEnvs();
    });

    it('deletes the linked social account and emits auth.oauth.unlinked', async () =>
    {
        socialAccountsRepository.findByProviderAndProviderId.mockResolvedValue({
            id: 42,
            userId: 7,
        });
        socialAccountsRepository.deleteById.mockResolvedValue({ id: 42 });

        await expect(oauthUnlinkNotifyService('kakao', {
            providerUserId: '987654',
            reason: 'UNLINK_FROM_APPS',
        })).resolves.toEqual({ ackStatus: 200, handled: true });

        // Under the account's lock: the identity is a way into it.
        expect(usersRepository.lockAccount).toHaveBeenCalledWith(7);
        expect(socialAccountsRepository.deleteById).toHaveBeenCalledWith({ id: 42, userId: 7 });
        expect(oauthUnlinkedEvent.emit).toHaveBeenCalledWith({
            userId: '7',
            provider: 'kakao',
            providerUserId: '987654',
            reason: 'UNLINK_FROM_APPS',
        });
    });

    it('acks without emitting when no linked account exists', async () =>
    {
        socialAccountsRepository.findByProviderAndProviderId.mockResolvedValue(null);

        await expect(oauthUnlinkNotifyService('kakao', { providerUserId: 'unknown' }))
            .resolves.toEqual({ ackStatus: 200, handled: false });

        expect(socialAccountsRepository.deleteById).not.toHaveBeenCalled();
        expect(oauthUnlinkedEvent.emit).not.toHaveBeenCalled();
    });

    it('uses the provider ack status (Naver 204)', async () =>
    {
        socialAccountsRepository.findByProviderAndProviderId.mockResolvedValue(null);

        await expect(oauthUnlinkNotifyService('naver', { providerUserId: 'unknown' }))
            .resolves.toEqual({ ackStatus: 204, handled: false });
    });
});
