/**
 * @spfn/auth - Server JWT Verification Unit Tests
 *
 * Tests for server-side JWT verification, fingerprint validation, and token decoding
 */

import { describe, it, expect, vi } from 'vitest';
import crypto from 'crypto';
import {
    assertKeyMatchesAlgorithm,
    verifyClientToken,
    verifyKeyFingerprint,
    decodeToken,
    generateToken,
    verifyToken,
    REQUEST_TOKEN_CLOCK_SKEW_SECONDS,
} from '@/server/helpers/jwt';
import type { ClientTokenOutcome, TokenPayload } from '@/server/helpers/jwt';
import { generateKeyPair, generateClientToken } from '@/server/lib/crypto';
import { KeyAlgorithmMismatchError } from '@spfn/auth/errors';

/** The payload of a token the verifier accepted; a refusal fails the test. */
function accepted(outcome: ClientTokenOutcome): TokenPayload
{
    expect(outcome).not.toHaveProperty('refused');

    return (outcome as { payload: TokenPayload }).payload;
}

describe('JWT - Server-side Verification with ES256', () =>
{
    it('should verify valid token signed with ES256', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPair('ES256');

        const payload = {
            userId: '12345',
            action: 'test',
            timestamp: Date.now(),
        };

        const token = generateClientToken(payload, privateKey, algorithm);

        const decoded = accepted(verifyClientToken(token, publicKey, algorithm));

        expect(decoded.userId).toBe('12345');
        expect(decoded.action).toBe('test');
        expect(decoded.iss).toBe('spfn-client');
    });

    it('should enforce issuer validation', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPair('ES256');

        // Create token with wrong issuer
        const jwt = require('jsonwebtoken');
        const crypto = require('crypto');
        const privateKeyObject = crypto.createPrivateKey({
            key: Buffer.from(privateKey, 'base64'),
            format: 'der',
            type: 'pkcs8',
        });

        const token = jwt.sign({ userId: '123' }, privateKeyObject, {
            algorithm,
            issuer: 'wrong-issuer', // Should be 'spfn-client'
        });

        expect(verifyClientToken(token, publicKey, algorithm)).toEqual({ refused: 'wrong-issuer-or-algorithm' });
    });

    it('should validate algorithm', () =>
    {
        const { privateKey, publicKey } = generateKeyPair('ES256');

        const payload = { userId: '123' };
        const token = generateClientToken(payload, privateKey, 'ES256');

        // Try to verify with wrong algorithm
        expect(verifyClientToken(token, publicKey, 'RS256')).toEqual({ refused: 'wrong-issuer-or-algorithm' });
    });
});

describe('JWT - Server-side Verification with RS256', () =>
{
    it('should verify valid token signed with RS256', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPair('RS256');

        const payload = {
            userId: '67890',
            keyId: 'key-uuid',
        };

        const token = generateClientToken(payload, privateKey, algorithm);

        const decoded = accepted(verifyClientToken(token, publicKey, algorithm));

        expect(decoded.userId).toBe('67890');
        expect(decoded.keyId).toBe('key-uuid');
    });
});

describe('JWT - Verification Failures', () =>
{
    it('should reject token with invalid signature', () =>
    {
        const key1 = generateKeyPair('ES256');
        const key2 = generateKeyPair('ES256');

        const token = generateClientToken({ userId: '123' }, key1.privateKey, key1.algorithm);

        // Try to verify with different public key
        expect(verifyClientToken(token, key2.publicKey, key2.algorithm)).toEqual({ refused: 'bad-signature' });
    });

    it('should reject expired token', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPair('ES256');

        // Expired one second longer ago than the clock-skew allowance.
        const token = generateClientToken({ userId: '123' }, privateKey, algorithm, { expiresIn: -(REQUEST_TOKEN_CLOCK_SKEW_SECONDS + 1) });

        expect(verifyClientToken(token, publicKey, algorithm)).toEqual({ refused: 'token-expired' });
    });

    it('should reject malformed token', () =>
    {
        const { publicKey, algorithm } = generateKeyPair('ES256');

        expect(verifyClientToken('not.a.valid.jwt', publicKey, algorithm)).toEqual({ refused: 'malformed' });
    });

    it('should reject token with tampered payload', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPair('ES256');

        const token = generateClientToken({ userId: '123' }, privateKey, algorithm);

        // Tamper with payload
        const parts = token.split('.');
        const tamperedPayload = Buffer.from(JSON.stringify({ ...decodeToken(token), userId: '999' })).toString('base64url');
        const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

        expect(verifyClientToken(tamperedToken, publicKey, algorithm)).toEqual({ refused: 'bad-signature' });
    });

    it('should reject token with invalid Base64 encoding', () =>
    {
        const { publicKey, algorithm } = generateKeyPair('ES256');

        expect(verifyClientToken('invalid!!!.base64!!!.token!!!', publicKey, algorithm)).toEqual({ refused: 'malformed' });
    });
});

describe('JWT - Fingerprint Verification', () =>
{
    it('should verify valid fingerprint', () =>
    {
        const { publicKey, fingerprint } = generateKeyPair('ES256');

        const isValid = verifyKeyFingerprint(publicKey, fingerprint);

        expect(isValid).toBe(true);
    });

    it('should reject invalid fingerprint', () =>
    {
        const { publicKey } = generateKeyPair('ES256');
        const wrongFingerprint = 'a'.repeat(64); // Wrong fingerprint

        const isValid = verifyKeyFingerprint(publicKey, wrongFingerprint);

        expect(isValid).toBe(false);
    });

    it('should reject fingerprint with wrong length', () =>
    {
        const { publicKey } = generateKeyPair('ES256');

        const isValid = verifyKeyFingerprint(publicKey, 'tooshort');

        expect(isValid).toBe(false);
    });

    it('should return false for tampered public key', () =>
    {
        const { publicKey, fingerprint } = generateKeyPair('ES256');

        // Tamper with public key
        const tamperedKey = publicKey.slice(0, -5) + 'XXXXX';

        const isValid = verifyKeyFingerprint(tamperedKey, fingerprint);

        expect(isValid).toBe(false);
    });

    it('should handle invalid Base64 in public key gracefully', () =>
    {
        const isValid = verifyKeyFingerprint('not!!!base64!!!', 'a'.repeat(64));

        expect(isValid).toBe(false); // Should not throw
    });

    it('should generate consistent fingerprint for same key', () =>
    {
        const { publicKey } = generateKeyPair('ES256');

        const fingerprint1 = require('crypto')
            .createHash('sha256')
            .update(Buffer.from(publicKey, 'base64'))
            .digest('hex');

        const fingerprint2 = require('crypto')
            .createHash('sha256')
            .update(Buffer.from(publicKey, 'base64'))
            .digest('hex');

        expect(fingerprint1).toBe(fingerprint2);
        expect(verifyKeyFingerprint(publicKey, fingerprint1)).toBe(true);
    });
});

describe('JWT - Token Decoding (without verification)', () =>
{
    it('should decode valid token without verification', () =>
    {
        const { privateKey, algorithm } = generateKeyPair('ES256');

        const payload = {
            userId: '123',
            keyId: 'key-uuid',
            action: 'test',
        };

        const token = generateClientToken(payload, privateKey, algorithm);

        const decoded = decodeToken(token);

        expect(decoded).toBeTruthy();
        expect(decoded?.userId).toBe('123');
        expect(decoded?.keyId).toBe('key-uuid');
        expect(decoded?.action).toBe('test');
        expect(decoded?.iss).toBe('spfn-client');
    });

    it('should decode expired token (no verification)', () =>
    {
        const { privateKey, algorithm } = generateKeyPair('ES256');

        const token = generateClientToken(
            { userId: '123' },
            privateKey,
            algorithm,
            { expiresIn: '-1s' }, // Already expired
        );

        const decoded = decodeToken(token);

        // Should still decode (no verification)
        expect(decoded).toBeTruthy();
        expect(decoded?.userId).toBe('123');
    });

    it('should return null for invalid token', () =>
    {
        const decoded = decodeToken('not.a.valid.jwt');

        expect(decoded).toBeNull();
    });

    it('should return null for malformed token', () =>
    {
        const decoded = decodeToken('invalid');

        expect(decoded).toBeNull();
    });

    it('should decode token with custom claims', () =>
    {
        const { privateKey, algorithm } = generateKeyPair('ES256');

        const payload = {
            userId: '123',
            customClaim: 'custom-value',
            nested: {
                field: 'value',
            },
        };

        const token = generateClientToken(payload, privateKey, algorithm);

        const decoded = decodeToken(token);

        expect(decoded?.customClaim).toBe('custom-value');
        expect(decoded?.nested).toEqual({ field: 'value' });
    });
});

describe('JWT - Algorithm Enforcement', () =>
{
    it('should prevent algorithm confusion attacks', () =>
    {
        const es256Key = generateKeyPair('ES256');
        const rs256Key = generateKeyPair('RS256');

        const token = generateClientToken({ userId: '123' }, es256Key.privateKey, 'ES256');

        // Try to verify ES256 token with RS256 algorithm
        expect(verifyClientToken(token, rs256Key.publicKey, 'RS256')).toEqual({ refused: 'wrong-issuer-or-algorithm' });
    });

    it('should enforce algorithm in token header matches expected', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPair('ES256');

        const token = generateClientToken({ userId: '123' }, privateKey, algorithm);

        // Token header specifies ES256, but we try to verify with RS256
        expect(verifyClientToken(token, publicKey, 'RS256')).toEqual({ refused: 'wrong-issuer-or-algorithm' });
    });

    it('legacy verifyToken round-trips an HS256 server-signed token', () =>
    {
        const token = generateToken({ userId: '777' });

        expect(verifyToken(token).userId).toBe('777');
    });

    it('legacy verifyToken rejects an alg:none (unsigned) token', () =>
    {
        const jwt = require('jsonwebtoken');
        // Classic algorithm-confusion: an unsigned token. The HS256 allow-list must reject it.
        const token = jwt.sign({ userId: '777' }, '', { algorithm: 'none' });

        expect(() => verifyToken(token)).toThrow();
    });
});

describe('JWT - Edge Cases', () =>
{
    it('should handle token with large payload', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPair('ES256');

        const largePayload = {
            userId: '123',
            data: 'x'.repeat(10000), // 10KB of data
        };

        const token = generateClientToken(largePayload, privateKey, algorithm);
        const decoded = accepted(verifyClientToken(token, publicKey, algorithm));

        expect(decoded.data).toBe('x'.repeat(10000));
    });

    it('should handle token with unicode characters', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPair('ES256');

        const payload = {
            userId: '123',
            message: '안녕하세요 🚀 こんにちは',
        };

        const token = generateClientToken(payload, privateKey, algorithm);
        const decoded = accepted(verifyClientToken(token, publicKey, algorithm));

        expect(decoded.message).toBe('안녕하세요 🚀 こんにちは');
    });

    it('should handle token with null values', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPair('ES256');

        const payload = {
            userId: '123',
            optional: null,
        };

        const token = generateClientToken(payload, privateKey, algorithm);
        const decoded = accepted(verifyClientToken(token, publicKey, algorithm));

        expect(decoded.optional).toBeNull();
    });

    it('should handle token with numeric string userId', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPair('ES256');

        const token = generateClientToken({ userId: '999' }, privateKey, algorithm);
        const decoded = accepted(verifyClientToken(token, publicKey, algorithm));

        expect(decoded.userId).toBe('999');
        expect(typeof decoded.userId).toBe('string');
    });
});

describe('JWT - Performance', () =>
{
    it('should verify token quickly', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPair('ES256');
        const token = generateClientToken({ userId: '123' }, privateKey, algorithm);

        const start = Date.now();
        verifyClientToken(token, publicKey, algorithm);
        const duration = Date.now() - start;

        expect(duration).toBeLessThan(50); // Should be fast
    });

    it('should verify fingerprint quickly', () =>
    {
        const { publicKey, fingerprint } = generateKeyPair('ES256');

        const start = Date.now();
        verifyKeyFingerprint(publicKey, fingerprint);
        const duration = Date.now() - start;

        expect(duration).toBeLessThan(10); // Should be very fast
    });

    it('should decode token instantly', () =>
    {
        const { privateKey, algorithm } = generateKeyPair('ES256');
        const token = generateClientToken({ userId: '123' }, privateKey, algorithm);

        const start = Date.now();
        decodeToken(token);
        const duration = Date.now() - start;

        expect(duration).toBeLessThan(5); // Should be nearly instant
    });
});

describe('JWT - Public key cache', () =>
{
    it('parses each public key only once across verifications', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPair('ES256');
        const token = generateClientToken({ userId: 'cache-test' }, privateKey, algorithm);

        const spy = vi.spyOn(crypto, 'createPublicKey');

        const first = accepted(verifyClientToken(token, publicKey, algorithm));
        const second = accepted(verifyClientToken(token, publicKey, algorithm));

        expect(first.userId).toBe('cache-test');
        expect(second.userId).toBe('cache-test');
        // First call parses the DER; the second reuses the cached KeyObject
        expect(spy).toHaveBeenCalledTimes(1);

        spy.mockRestore();
    });
});

/**
 * `algorithm` 컬럼은 키 자료 옆에 저장될 뿐 거기서 다시 유도되지 않는다. 선언한
 * 알고리즘으로 서명할 수 없는 키가 등록되면 불일치는 등록이 아니라 proof 검증에서
 * 드러난다 — 기기가 이미 등록됐다고 믿은 뒤에, 그 뒤 모든 요청에서. 그래서 저장 전에
 * 키의 SPKI 타입을 직접 본다. 여기서 고정하는 것은 그 판정의 양쪽 방향이다.
 */
const EC_P256_PUBLIC_KEY = generateKeyPair('ES256').publicKey;
const RSA_PUBLIC_KEY = generateKeyPair('RS256').publicKey;

/** P-256이 아닌 곡선. EC라는 것만으로는 ES256이 될 수 없다는 것을 보이기 위한 키다. */
function generateP384PublicKey(): string
{
    const { publicKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'secp384r1',
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });

    return publicKey.toString('base64');
}

describe('assertKeyMatchesAlgorithm', () =>
{
    it('accepts a P-256 EC key declared ES256', () =>
    {
        expect(() => assertKeyMatchesAlgorithm(EC_P256_PUBLIC_KEY, 'ES256')).not.toThrow();
    });

    it('accepts an RSA key declared RS256', () =>
    {
        expect(() => assertKeyMatchesAlgorithm(RSA_PUBLIC_KEY, 'RS256')).not.toThrow();
    });

    it('refuses a P-256 EC key declared RS256', () =>
    {
        expect(() => assertKeyMatchesAlgorithm(EC_P256_PUBLIC_KEY, 'RS256')).toThrow(KeyAlgorithmMismatchError);
    });

    it('refuses an RSA key declared ES256', () =>
    {
        expect(() => assertKeyMatchesAlgorithm(RSA_PUBLIC_KEY, 'ES256')).toThrow(KeyAlgorithmMismatchError);
    });

    it('refuses an EC key on a curve other than P-256 declared ES256', () =>
    {
        // ES256은 곡선까지 포함해 P-256을 뜻한다. asymmetricKeyType만 보면 통과한다.
        expect(() => assertKeyMatchesAlgorithm(generateP384PublicKey(), 'ES256'))
            .toThrow(KeyAlgorithmMismatchError);
    });

    it('refuses bytes that are not an SPKI public key, rather than throwing out of the parser', () =>
    {
        // createPublicKey는 malformed 입력에 그대로 throw한다. 잡아두지 않으면 400이어야 할
        // 거절이 500이 된다.
        expect(() => assertKeyMatchesAlgorithm('bm90LWEta2V5', 'ES256'))
            .toThrow(KeyAlgorithmMismatchError);
        expect(() => assertKeyMatchesAlgorithm('', 'RS256'))
            .toThrow(KeyAlgorithmMismatchError);
    });

    it('names both the key it read and the algorithm that was declared', () =>
    {
        // 거절 메시지가 한쪽만 말하면 클라이언트는 어느 쪽을 고쳐야 하는지 알 수 없다.
        const refusal = (() =>
        {
            try
            {
                assertKeyMatchesAlgorithm(EC_P256_PUBLIC_KEY, 'RS256');
            }
            catch (error)
            {
                return error as Error;
            }

            return null;
        })();

        expect(refusal?.message).toContain('prime256v1');
        expect(refusal?.message).toContain('RS256');
    });

    it('answers 400, not 500 — a caller sent a bad key, the server is not broken', () =>
    {
        const error = new KeyAlgorithmMismatchError();

        expect(error.name).toBe('KeyAlgorithmMismatchError');
        expect((error as unknown as { statusCode: number }).statusCode).toBe(400);
    });
});
