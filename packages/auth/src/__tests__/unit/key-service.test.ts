/**
 * @spfn/auth - Key Service Unit Tests
 *
 * keyId는 모든 사용자에 걸쳐 UNIQUE다. 등록 전 조회가 활성 키만 보면 폐기된 행을 놓치고,
 * insert가 unique index에 걸려 로그인 트랜잭션이 통째로 500으로 굴러떨어진다.
 * 여기서 고정하는 것은 그 충돌이 도메인 에러로 드러난다는 것과, 한 기기의 반복 로그인
 * (같은 사용자 · 같은 활성 키)이 여전히 no-op 성공이라는 것이다.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { keysRepository } = vi.hoisted(() => ({
    keysRepository: {
        findByKeyId: vi.fn(),
        findActiveByKeyId: vi.fn(),
        create: vi.fn(async () => undefined),
        extendExpiry: vi.fn(async () => null),
        revokeByKeyIdAndUserId: vi.fn(async () => null),
        findByKeyIdAndUserId: vi.fn(async () => null),
    },
}));

vi.mock('../../server/repositories', () => ({ keysRepository }));
// `key.service` now asks the second-factor service two questions — whether the
// caller must step up, and whether a rotation carries a verification across.
// Both have their own suites; here they only have to be reachable.
vi.mock('../../server/services/mfa.service', () => ({
    assertStepUp: vi.fn(async () => undefined),
    carryStepUpVerification: vi.fn(async () => undefined),
    mfaEnrolledForUser: vi.fn(async () => false),
}));

// fingerprint 검증은 이 테스트의 관심사가 아니다 — 충돌 판정만 본다. 알고리즘 검사는
// 통과시킨다: 실제 키 자료를 쓰므로 진짜 구현이 그대로 돌아야 한다.
vi.mock('../../server/helpers/jwt', async (importActual) => ({
    ...(await importActual<typeof import('../../server/helpers/jwt')>()),
    verifyKeyFingerprint: () => true,
}));

import { generateKeyPair } from '../../server/lib/crypto';
import { registerPublicKeyService, rotateKeyService } from '../../server/services/key.service';
import { KeyAlgorithmMismatchError, KeyIdAlreadyRegisteredError } from '@spfn/auth/errors';

const OWNER_ID = 1;
const OTHER_ID = 2;
const KEY_ID = 'key-abc';

// 충돌 판정에도 진짜 P-256 SPKI를 쓴다 — 등록 경로가 키 자료를 파싱하기 때문이다.
const EC_KEY = generateKeyPair('ES256');
const RSA_KEY = generateKeyPair('RS256');

function params(userId = OWNER_ID)
{
    return {
        userId,
        keyId: KEY_ID,
        publicKey: EC_KEY.publicKey,
        fingerprint: 'a'.repeat(64),
        algorithm: 'ES256' as const,
        // Required since the device-registered event: a registration names the
        // door it came through. These rows are about keyId collisions, so any
        // channel does — 'password' is the one they stand in for.
        channel: 'password' as const,
    };
}

function keyRow(overrides: Record<string, unknown> = {})
{
    return {
        id: 10,
        userId: OWNER_ID,
        keyId: KEY_ID,
        publicKey: EC_KEY.publicKey,
        algorithm: 'ES256',
        fingerprint: 'a'.repeat(64),
        isActive: true,
        createdAt: new Date(),
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        revokedReason: null,
        ...overrides,
    };
}

describe('registerPublicKeyService - keyId collisions', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        keysRepository.create.mockResolvedValue(keyRow() as never);
    });

    it('registers the key when the keyId is unused', async () =>
    {
        keysRepository.findByKeyId.mockResolvedValue(null);

        await registerPublicKeyService(params());

        expect(keysRepository.create).toHaveBeenCalledTimes(1);
    });

    it('is a no-op success when the same user re-registers their own active key', async () =>
    {
        // 한 기기에서 반복 로그인하는 정상 경로. 네이티브·웹 양쪽이 여기에 기댄다.
        keysRepository.findByKeyId.mockResolvedValue(keyRow());

        await expect(registerPublicKeyService(params())).resolves.toBeUndefined();

        expect(keysRepository.create).not.toHaveBeenCalled();
    });

    it('refuses reuse of the same user\'s revoked keyId instead of failing on the unique index', async () =>
    {
        keysRepository.findByKeyId.mockResolvedValue(keyRow({
            isActive: false,
            revokedAt: new Date(),
            revokedReason: 'Replaced by new key on login',
        }));

        await expect(registerPublicKeyService(params())).rejects.toBeInstanceOf(KeyIdAlreadyRegisteredError);

        // 폐기는 되돌리지 않는다 — 재활성화도, insert도 없다.
        expect(keysRepository.create).not.toHaveBeenCalled();
    });

    it('refuses another user\'s active keyId with the same error (no existence oracle)', async () =>
    {
        keysRepository.findByKeyId.mockResolvedValue(keyRow());

        const revoked = registerPublicKeyService(params(OTHER_ID));

        await expect(revoked).rejects.toBeInstanceOf(KeyIdAlreadyRegisteredError);
        expect(keysRepository.create).not.toHaveBeenCalled();
    });

    it('answers identically for a revoked own key and another user\'s active key', async () =>
    {
        keysRepository.findByKeyId.mockResolvedValue(keyRow({ isActive: false, revokedAt: new Date() }));
        const ownRevoked = await registerPublicKeyService(params()).catch((e: Error) => e);

        keysRepository.findByKeyId.mockResolvedValue(keyRow());
        const otherActive = await registerPublicKeyService(params(OTHER_ID)).catch((e: Error) => e);

        expect((ownRevoked as Error).name).toBe((otherActive as Error).name);
        expect((ownRevoked as Error).message).toBe((otherActive as Error).message);
    });

    it('extends the expiry when the same user re-registers an expired-but-active key', async () =>
    {
        // 만료는 isActive를 뒤집지 않는다. 그냥 무시하고 반환하면 로그인은 200인데
        // authenticate가 KeyExpiredError로 모든 요청을 막아, 회복할 방법이 없어진다.
        keysRepository.findByKeyId.mockResolvedValue(keyRow({
            expiresAt: new Date(Date.now() - 86_400_000),
        }));

        await expect(registerPublicKeyService(params())).resolves.toBeUndefined();

        expect(keysRepository.extendExpiry).toHaveBeenCalledTimes(1);
        const [keyId, userId, expiresAt] = keysRepository.extendExpiry.mock.calls[0] as unknown as [string, number, Date];
        expect(keyId).toBe(KEY_ID);
        expect(userId).toBe(OWNER_ID);
        expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
        expect(keysRepository.create).not.toHaveBeenCalled();
    });

    it('does not touch the expiry of a key that has not expired', async () =>
    {
        keysRepository.findByKeyId.mockResolvedValue(keyRow({
            expiresAt: new Date(Date.now() + 86_400_000),
        }));

        await registerPublicKeyService(params());

        expect(keysRepository.extendExpiry).not.toHaveBeenCalled();
    });

    it('does not resurrect an expired key that was also revoked', async () =>
    {
        keysRepository.findByKeyId.mockResolvedValue(keyRow({
            isActive: false,
            revokedAt: new Date(),
            expiresAt: new Date(Date.now() - 86_400_000),
        }));

        await expect(registerPublicKeyService(params())).rejects.toBeInstanceOf(KeyIdAlreadyRegisteredError);

        expect(keysRepository.extendExpiry).not.toHaveBeenCalled();
        expect(keysRepository.create).not.toHaveBeenCalled();
    });

    it('looks the keyId up without an isActive filter', async () =>
    {
        keysRepository.findByKeyId.mockResolvedValue(null);

        await registerPublicKeyService(params());

        // 활성 필터가 걸린 조회로 되돌아가면 폐기 행을 다시 놓친다.
        expect(keysRepository.findByKeyId).toHaveBeenCalledWith(KEY_ID);
        expect(keysRepository.findActiveByKeyId).not.toHaveBeenCalled();
    });
});

/**
 * algorithm 컬럼은 저장될 뿐 키 자료에서 다시 유도되지 않는다. 선언한 알고리즘으로
 * 서명할 수 없는 키가 등록되면 그 불일치는 등록이 아니라 proof 검증에서, 기기가 이미
 * 등록됐다고 믿은 뒤에 드러난다. 그래서 저장 직전에 거절한다.
 */
describe('key type must match the declared algorithm', () =>
{
    beforeEach(() =>
    {
        vi.clearAllMocks();
        keysRepository.findByKeyId.mockResolvedValue(null);
        keysRepository.create.mockResolvedValue(keyRow() as never);
    });

    it('refuses to register an RSA key declared ES256', async () =>
    {
        const register = registerPublicKeyService({
            userId: OWNER_ID,
            keyId: KEY_ID,
            publicKey: RSA_KEY.publicKey,
            fingerprint: 'a'.repeat(64),
            algorithm: 'ES256',
            channel: 'password',
        });

        await expect(register).rejects.toBeInstanceOf(KeyAlgorithmMismatchError);
        expect(keysRepository.create).not.toHaveBeenCalled();
    });

    it('registers a P-256 key declared ES256', async () =>
    {
        await registerPublicKeyService(params());

        expect(keysRepository.create).toHaveBeenCalledTimes(1);
    });

    it('registers an RSA key declared RS256', async () =>
    {
        await registerPublicKeyService({
            userId: OWNER_ID,
            keyId: KEY_ID,
            publicKey: RSA_KEY.publicKey,
            fingerprint: 'a'.repeat(64),
            algorithm: 'RS256',
            channel: 'password',
        });

        expect(keysRepository.create).toHaveBeenCalledTimes(1);
    });

    it('refuses to rotate onto an EC key declared RS256, and revokes nothing', async () =>
    {
        const rotate = rotateKeyService({
            userId: OWNER_ID,
            oldKeyId: KEY_ID,
            newKeyId: 'key-new',
            newPublicKey: EC_KEY.publicKey,
            fingerprint: 'a'.repeat(64),
            algorithm: 'RS256',
        });

        await expect(rotate).rejects.toBeInstanceOf(KeyAlgorithmMismatchError);

        // 거절이 회전을 시작시키면 안 된다 — 옛 키가 폐기된 채 새 키가 없는 상태가 된다.
        expect(keysRepository.revokeByKeyIdAndUserId).not.toHaveBeenCalled();
        expect(keysRepository.create).not.toHaveBeenCalled();
    });

    it('rotates onto an RSA key declared RS256', async () =>
    {
        await rotateKeyService({
            userId: OWNER_ID,
            oldKeyId: KEY_ID,
            newKeyId: 'key-new',
            newPublicKey: RSA_KEY.publicKey,
            fingerprint: 'a'.repeat(64),
            algorithm: 'RS256',
        });

        expect(keysRepository.create).toHaveBeenCalledTimes(1);
    });
});
