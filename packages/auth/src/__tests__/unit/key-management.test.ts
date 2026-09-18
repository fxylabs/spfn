/**
 * 공개키(기기) 관리 서비스 (issue #64)
 *
 * 키는 기기마다 따로 있어야 하므로 로그인마다 이전 키를 죽이지 않는다. 그래서 정상적으로
 * 쌓이고, 쌓인 것을 사용자가 보고 고를 수 있어야 한다. 여기서 고정하는 것은 목록이 무엇을
 * 내보내지 않는지, 폐기가 남의 키에 닿지 않는지, 전체 폐기가 요청한 기기를 언제 살려 두는지다.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';

const { keysRepository, deviceAuthorizationsRepository, revokeAllOAuth2GrantsForUser } = vi.hoisted(() => ({
    keysRepository: {
        listForUser: vi.fn(),
        revokeByKeyIdAndUserId: vi.fn(),
        revokeAllActiveByUserId: vi.fn(),
        revokeAllActiveByUserIdExcept: vi.fn(),
        findByKeyIdAndUserId: vi.fn(),
        findByKeyId: vi.fn(),
        create: vi.fn(),
    },
    deviceAuthorizationsRepository: {
        denyAllActiveByUserId: vi.fn(async () => []),
    },
    revokeAllOAuth2GrantsForUser: vi.fn(async () => undefined),
}));

vi.mock('../../server/repositories', () => ({ keysRepository, deviceAuthorizationsRepository }));
vi.mock('../../server/services/oauth2-grant.service', () => ({ revokeAllOAuth2GrantsForUser }));
// `key.service` now asks the second-factor service two questions — whether the
// caller must step up, and whether a rotation carries a verification across.
// Both have their own suites; here they only have to be reachable.
vi.mock('../../server/services/mfa.service', () => ({
    assertStepUp: vi.fn(async () => undefined),
    carryStepUpVerification: vi.fn(async () => undefined),
    mfaEnrolledForUser: vi.fn(async () => false),
}));

import {
    listKeysService,
    revokeKeyService,
    revokeAllKeysService,
    rotateKeyService,
} from '../../server/services/key.service';

const FINGERPRINT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function row(overrides: Record<string, unknown> = {})
{
    return {
        keyId: 'key-1',
        deviceName: 'Ray의 iPhone',
        platform: 'ios',
        algorithm: 'ES256',
        fingerprint: FINGERPRINT,
        isActive: true,
        revokedAt: null,
        createdAt: new Date('2026-07-01T00:00:00Z'),
        lastUsedAt: new Date('2026-08-01T00:00:00Z'),
        expiresAt: new Date('2026-09-29T00:00:00Z'),
        ...overrides,
    };
}

beforeEach(() =>
{
    vi.clearAllMocks();
});

describe('the key list', () =>
{
    it('returns one entry per active key, newest first as the repository ordered it', async () =>
    {
        keysRepository.listForUser.mockResolvedValue([row(), row({ keyId: 'key-2' })]);

        const keys = await listKeysService({ userId: 1 });

        expect(keys.map(key => key.keyId)).toEqual(['key-1', 'key-2']);
        expect(keysRepository.listForUser).toHaveBeenCalledWith(1, undefined);
    });

    it('never carries the public key material', async () =>
    {
        keysRepository.listForUser.mockResolvedValue([row()]);

        const [entry] = await listKeysService({ userId: 1 });

        expect(entry).not.toHaveProperty('publicKey');
        expect(JSON.stringify(entry)).not.toContain('publicKey');
    });

    it('truncates the fingerprint — the full value is a native sign-in nonce, not a label', async () =>
    {
        keysRepository.listForUser.mockResolvedValue([row()]);

        const [entry] = await listKeysService({ userId: 1 });

        expect(entry.fingerprintPrefix).toBe('a1b2c3d4');
        expect(JSON.stringify(entry)).not.toContain(FINGERPRINT);
    });

    it('carries the device label so an entry can be recognised', async () =>
    {
        keysRepository.listForUser.mockResolvedValue([row()]);

        const [entry] = await listKeysService({ userId: 1 });

        expect(entry.deviceName).toBe('Ray의 iPhone');
        expect(entry.platform).toBe('ios');
    });

    it('leaves the label undefined for keys registered before the column existed', async () =>
    {
        keysRepository.listForUser.mockResolvedValue([row({ deviceName: null, platform: null })]);

        const [entry] = await listKeysService({ userId: 1 });

        expect(entry.deviceName).toBeUndefined();
        expect(entry.platform).toBeUndefined();
    });

    it('returns every moment as epoch milliseconds, never an ISO string', async () =>
    {
        // Contract 0.5.0 moved these four off ISO strings. A single representation
        // is what keeps a generated Swift client from needing a date formatter —
        // ISO8601DateFormatter rejects fractional seconds unless asked not to.
        keysRepository.listForUser.mockResolvedValue([
            row({ keyId: 'gone', isActive: false, revokedAt: new Date('2026-08-02T00:00:00Z') }),
        ]);

        const [entry] = await listKeysService({ userId: 1, includeRevoked: true });

        expect(entry.createdAtMillis).toBe(Date.parse('2026-07-01T00:00:00Z'));
        expect(entry.lastUsedAtMillis).toBe(Date.parse('2026-08-01T00:00:00Z'));
        expect(entry.revokedAtMillis).toBe(Date.parse('2026-08-02T00:00:00Z'));

        for (const value of [entry.createdAtMillis, entry.lastUsedAtMillis, entry.revokedAtMillis])
        {
            expect(typeof value).toBe('number');
        }
    });

    it('marks an expired key — it still reads as active, but authenticate refuses it', async () =>
    {
        keysRepository.listForUser.mockResolvedValue([
            row({ keyId: 'live', expiresAt: new Date(Date.now() + 86_400_000) }),
            row({ keyId: 'stale', expiresAt: new Date(Date.now() - 86_400_000) }),
        ]);

        const keys = await listKeysService({ userId: 1 });

        expect(keys.find(key => key.keyId === 'live')?.isExpired).toBe(false);
        expect(keys.find(key => key.keyId === 'stale')?.isExpired).toBe(true);
    });

    it('returns only signable keys by default', async () =>
    {
        keysRepository.listForUser.mockResolvedValue([row()]);

        await listKeysService({ userId: 1 });

        expect(keysRepository.listForUser).toHaveBeenCalledWith(1, undefined);
    });

    it('includes revoked keys when asked, with when they were cut off', async () =>
    {
        keysRepository.listForUser.mockResolvedValue([
            row({ keyId: 'gone', isActive: false, revokedAt: new Date('2026-08-01T00:00:00Z') }),
        ]);

        const [entry] = await listKeysService({ userId: 1, includeRevoked: true });

        expect(keysRepository.listForUser).toHaveBeenCalledWith(1, true);
        expect(entry.isActive).toBe(false);
        expect(entry.revokedAtMillis).toBe(Date.parse('2026-08-01T00:00:00Z'));
    });

    it('leaves revokedAtMillis undefined for a key still in use', async () =>
    {
        keysRepository.listForUser.mockResolvedValue([row()]);

        const [entry] = await listKeysService({ userId: 1 });

        expect(entry.isActive).toBe(true);
        expect(entry.revokedAtMillis).toBeUndefined();
    });

    it('treats a key with no expiry as not expired', async () =>
    {
        keysRepository.listForUser.mockResolvedValue([row({ expiresAt: null })]);

        const [entry] = await listKeysService({ userId: 1 });

        expect(entry.isExpired).toBe(false);
        expect(entry.expiresAtMillis).toBeUndefined();
    });
});

describe('revoking one key', () =>
{
    it('reports success when the key belonged to the caller', async () =>
    {
        keysRepository.revokeByKeyIdAndUserId.mockResolvedValue(row());

        const revoked = await revokeKeyService({ userId: 1, keyId: 'key-1', reason: 'Revoked by user' });

        expect(revoked).toBe(true);
        expect(keysRepository.revokeByKeyIdAndUserId).toHaveBeenCalledWith('key-1', 1, 'Revoked by user');
    });

    it('reports failure for a key id the caller does not own', async () =>
    {
        // 리포지토리가 userId로 범위를 좁히므로 남의 키는 애초에 갱신되지 않고 null이 온다.
        keysRepository.revokeByKeyIdAndUserId.mockResolvedValue(null);

        const revoked = await revokeKeyService({ userId: 1, keyId: 'someone-elses', reason: 'Revoked by user' });

        expect(revoked).toBe(false);
    });

    it('scopes the update by the caller, never by key id alone', async () =>
    {
        keysRepository.revokeByKeyIdAndUserId.mockResolvedValue(null);

        await revokeKeyService({ userId: 7, keyId: 'key-1', reason: 'Revoked by user' });

        const [, userId] = keysRepository.revokeByKeyIdAndUserId.mock.calls[0];
        expect(userId).toBe(7);
    });
});

describe('revoking every key', () =>
{
    it('spares the calling device by default — "sign out my other devices"', async () =>
    {
        keysRepository.revokeAllActiveByUserIdExcept.mockResolvedValue([row(), row({ keyId: 'key-2' })]);

        const result = await revokeAllKeysService({
            userId: 1,
            currentKeyId: 'current',
            reason: 'Revoked by user',
        });

        expect(result).toEqual({ revokedCount: 2, currentKeyRevoked: false });
        expect(keysRepository.revokeAllActiveByUserIdExcept)
            .toHaveBeenCalledWith(1, 'current', 'Revoked by user');
        expect(keysRepository.revokeAllActiveByUserId).not.toHaveBeenCalled();
    });

    it('includes the calling device when asked — the full sign-out', async () =>
    {
        keysRepository.revokeAllActiveByUserId.mockResolvedValue([row(), row(), row()]);

        const result = await revokeAllKeysService({
            userId: 1,
            currentKeyId: 'current',
            includeCurrent: true,
            reason: 'Revoked by user',
        });

        expect(result).toEqual({ revokedCount: 3, currentKeyRevoked: true });
        expect(keysRepository.revokeAllActiveByUserIdExcept).not.toHaveBeenCalled();
    });

    it('counts zero without failing when nothing was active', async () =>
    {
        keysRepository.revokeAllActiveByUserIdExcept.mockResolvedValue([]);

        const result = await revokeAllKeysService({
            userId: 1,
            currentKeyId: 'current',
            reason: 'Revoked by user',
        });

        expect(result.revokedCount).toBe(0);
    });

    it('refuses live device authorizations too, in both modes', async () =>
    {
        // An approved-but-uncollected device code is a key that has not been
        // handed out yet. Leaving it live means the next poll registers a fresh
        // active key and undoes the sign-out the user just asked for — and the
        // waiting device is never the "current" one being spared, since it has no
        // key at all.
        keysRepository.revokeAllActiveByUserIdExcept.mockResolvedValue([]);
        keysRepository.revokeAllActiveByUserId.mockResolvedValue([]);

        await revokeAllKeysService({ userId: 1, currentKeyId: 'current', reason: 'Revoked by user' });
        await revokeAllKeysService({
            userId: 1,
            currentKeyId: 'current',
            includeCurrent: true,
            reason: 'Revoked by user',
        });

        expect(deviceAuthorizationsRepository.denyAllActiveByUserId).toHaveBeenCalledTimes(2);
        expect(deviceAuthorizationsRepository.denyAllActiveByUserId).toHaveBeenCalledWith(1);

        // And the OAuth grants, one step further out: a grant carries a refresh
        // token, so a CLI holding one would sign itself back in within the hour.
        expect(revokeAllOAuth2GrantsForUser).toHaveBeenCalledTimes(2);
        expect(revokeAllOAuth2GrantsForUser).toHaveBeenCalledWith(1);
    });

    it('counts keys, not device codes — a code nobody collected was never a session', async () =>
    {
        keysRepository.revokeAllActiveByUserIdExcept.mockResolvedValue([row()]);
        deviceAuthorizationsRepository.denyAllActiveByUserId.mockResolvedValueOnce([{}, {}] as never);

        const result = await revokeAllKeysService({
            userId: 1,
            currentKeyId: 'current',
            reason: 'Revoked by user',
        });

        expect(result.revokedCount).toBe(1);
    });
});

describe('rotation keeps the device recognisable', () =>
{
    // 실제 키 한 벌 — rotateKeyService가 fingerprint를 검증한다.
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const der = publicKey.export({ type: 'spki', format: 'der' });
    const newKey = { publicKey: der.toString('base64'), fingerprint: createHash('sha256').update(der).digest('hex') };

    it('carries the replaced key\'s label over when the client sends none', async () =>
    {
        keysRepository.findByKeyIdAndUserId.mockResolvedValue(row());
        keysRepository.revokeByKeyIdAndUserId.mockResolvedValue(row());

        await rotateKeyService({
            userId: 1,
            oldKeyId: 'key-1',
            newKeyId: 'key-2',
            newPublicKey: newKey.publicKey,
            fingerprint: newKey.fingerprint,
        });

        expect(keysRepository.create).toHaveBeenCalledWith(
            expect.objectContaining({ deviceName: 'Ray의 iPhone', platform: 'ios' }),
        );
    });

    it('lets the client rename the device during rotation', async () =>
    {
        keysRepository.findByKeyIdAndUserId.mockResolvedValue(row());
        keysRepository.revokeByKeyIdAndUserId.mockResolvedValue(row());

        await rotateKeyService({
            userId: 1,
            oldKeyId: 'key-1',
            newKeyId: 'key-2',
            newPublicKey: newKey.publicKey,
            fingerprint: newKey.fingerprint,
            deviceName: 'Ray의 새 iPhone',
        });

        expect(keysRepository.create).toHaveBeenCalledWith(
            expect.objectContaining({ deviceName: 'Ray의 새 iPhone', platform: 'ios' }),
        );
    });

    it('leaves the label undefined when neither side has one', async () =>
    {
        keysRepository.findByKeyIdAndUserId.mockResolvedValue(row({ deviceName: null, platform: null }));
        keysRepository.revokeByKeyIdAndUserId.mockResolvedValue(row());

        await rotateKeyService({
            userId: 1,
            oldKeyId: 'key-1',
            newKeyId: 'key-2',
            newPublicKey: newKey.publicKey,
            fingerprint: newKey.fingerprint,
        });

        expect(keysRepository.create).toHaveBeenCalledWith(
            expect.objectContaining({ deviceName: undefined, platform: undefined }),
        );
    });
});
