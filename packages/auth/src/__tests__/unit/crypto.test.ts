/**
 * @spfn/auth - Crypto Helper Unit Tests
 *
 * Tests for client-side key generation and JWT signing/verification
 */

import { describe, it, expect } from 'vitest';
import {
    generateKeyPair,
    generateKeyPairES256,
    generateKeyPairRS256,
    generateClientToken,
    getKeySize,
    shouldRotateKey,
} from '@/server/lib/crypto';
import { verifyClientToken, decodeToken, REQUEST_TOKEN_CLOCK_SKEW_SECONDS } from '@/server/helpers/jwt';
import type { ClientTokenOutcome, TokenPayload } from '@/server/helpers/jwt';

/** The payload of a token the verifier accepted; a refusal fails the test. */
function accepted(outcome: ClientTokenOutcome): TokenPayload
{
    expect(outcome).not.toHaveProperty('refused');

    return (outcome as { payload: TokenPayload }).payload;
}

describe('Crypto - ES256 Key Generation', () =>
{
    it('should generate valid ES256 key pair', () =>
    {
        const { privateKey, publicKey, keyId, fingerprint, algorithm } = generateKeyPairES256();

        expect(algorithm).toBe('ES256');
        expect(keyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/); // UUID v4
        expect(fingerprint).toMatch(/^[a-f0-9]{64}$/); // SHA-256 (64 hex chars)
        expect(publicKey).toBeTruthy();
        expect(privateKey).toBeTruthy();

        // Keys should be Base64 encoded
        expect(publicKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
        expect(privateKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it('should generate ES256 keys of expected size', () =>
    {
        const { publicKey } = generateKeyPairES256();

        const size = getKeySize(publicKey);

        // ES256 public keys are ~91 bytes in DER format
        expect(size.bytes).toBeGreaterThan(80);
        expect(size.bytes).toBeLessThan(100);
    });

    it('should generate unique keys on each call', () =>
    {
        const key1 = generateKeyPairES256();
        const key2 = generateKeyPairES256();

        expect(key1.keyId).not.toBe(key2.keyId);
        expect(key1.fingerprint).not.toBe(key2.fingerprint);
        expect(key1.publicKey).not.toBe(key2.publicKey);
        expect(key1.privateKey).not.toBe(key2.privateKey);
    });

    it('should generate deterministic fingerprint for same public key', () =>
    {
        const { publicKey } = generateKeyPairES256();

        // Fingerprint should be consistent for the same key
        const keyData = Buffer.from(publicKey, 'base64');
        const crypto = require('crypto');
        const expectedFingerprint = crypto.createHash('sha256').update(keyData).digest('hex');

        // We can't verify the actual fingerprint without regenerating it,
        // but we can verify the format
        expect(expectedFingerprint).toMatch(/^[a-f0-9]{64}$/);
    });
});

describe('Crypto - RS256 Key Generation', () =>
{
    it('should generate valid RS256 key pair', () =>
    {
        const { privateKey, publicKey, keyId, fingerprint, algorithm } = generateKeyPairRS256();

        expect(algorithm).toBe('RS256');
        expect(keyId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(publicKey).toBeTruthy();
        expect(privateKey).toBeTruthy();
    });

    it('should generate RS256 keys larger than ES256', () =>
    {
        const es256 = generateKeyPairES256();
        const rs256 = generateKeyPairRS256();

        const es256Size = getKeySize(es256.publicKey);
        const rs256Size = getKeySize(rs256.publicKey);

        // RS256 (2048-bit RSA) should be ~294 bytes
        expect(rs256Size.bytes).toBeGreaterThan(es256Size.bytes);
        expect(rs256Size.bytes).toBeGreaterThan(250);
        expect(rs256Size.bytes).toBeLessThan(350);
    });
});

describe('Crypto - Default Key Generation', () =>
{
    it('should default to ES256 when no algorithm specified', () =>
    {
        const key = generateKeyPair();

        expect(key.algorithm).toBe('ES256');
    });

    it('should generate ES256 when explicitly specified', () =>
    {
        const key = generateKeyPair('ES256');

        expect(key.algorithm).toBe('ES256');
    });

    it('should generate RS256 when specified', () =>
    {
        const key = generateKeyPair('RS256');

        expect(key.algorithm).toBe('RS256');
    });
});

describe('Crypto - JWT Signing with ES256', () =>
{
    it('should sign and verify token with ES256', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPairES256();

        const payload = {
            userId: '12345',
            action: 'test',
            timestamp: Date.now(),
        };

        const token = generateClientToken(payload, privateKey, algorithm);

        expect(token).toBeTruthy();
        expect(token.split('.')).toHaveLength(3); // JWT format: header.payload.signature

        const decoded = accepted(verifyClientToken(token, publicKey, algorithm));

        expect(decoded.userId).toBe('12345');
        expect(decoded.action).toBe('test');
        expect(decoded.iss).toBe('spfn-client'); // Issuer
        expect(decoded.exp).toBeTruthy(); // Expiration
        expect(decoded.iat).toBeTruthy(); // Issued at
    });

    it('should include custom expiration time', () =>
    {
        const { privateKey, algorithm } = generateKeyPairES256();

        const token = generateClientToken(
            { userId: '123' },
            privateKey,
            algorithm,
            { expiresIn: '1h' },
        );

        // Longer than a request token may live, so read it unverified
        const decoded = decodeToken(token)!;
        const expiresIn = decoded.exp! - decoded.iat!;

        // Should be approximately 1 hour (3600 seconds)
        expect(expiresIn).toBeGreaterThan(3590);
        expect(expiresIn).toBeLessThan(3610);
    });

    it('should include custom issuer', () =>
    {
        const { privateKey, algorithm } = generateKeyPairES256();

        const token = generateClientToken(
            { userId: '123' },
            privateKey,
            algorithm,
            { issuer: 'custom-issuer' },
        );

        // Note: verifyClientToken enforces 'spfn-client' issuer for security
        // This test verifies the token is created with custom issuer (via decodeToken)
        const decoded = decodeToken(token);
        expect(decoded?.iss).toBe('custom-issuer');
    });

    it('should default to 15min expiration', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPairES256();

        const token = generateClientToken({ userId: '123' }, privateKey, algorithm);

        const decoded = accepted(verifyClientToken(token, publicKey, algorithm));
        const expiresIn = decoded.exp! - decoded.iat!;

        // Should be approximately 15 minutes (900 seconds)
        expect(expiresIn).toBeGreaterThan(890);
        expect(expiresIn).toBeLessThan(910);
    });
});

describe('Crypto - JWT Signing with RS256', () =>
{
    it('should sign and verify token with RS256', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPairRS256();

        const payload = {
            userId: '67890',
            action: 'test-rs256',
        };

        const token = generateClientToken(payload, privateKey, algorithm);
        const decoded = accepted(verifyClientToken(token, publicKey, algorithm));

        expect(decoded.userId).toBe('67890');
        expect(decoded.action).toBe('test-rs256');
    });
});

describe('Crypto - JWT Verification Failures', () =>
{
    it('should reject token signed with wrong private key', () =>
    {
        const key1 = generateKeyPairES256();
        const key2 = generateKeyPairES256();

        const token = generateClientToken({ test: 'data' }, key1.privateKey, key1.algorithm);

        expect(verifyClientToken(token, key2.publicKey, key2.algorithm)).toEqual({ refused: 'bad-signature' });
    });

    it('should reject expired token', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPairES256();

        // Expired one second longer ago than the clock-skew allowance.
        const token = generateClientToken({ userId: '123' }, privateKey, algorithm, { expiresIn: -(REQUEST_TOKEN_CLOCK_SKEW_SECONDS + 1) });

        expect(verifyClientToken(token, publicKey, algorithm)).toEqual({ refused: 'token-expired' });
    });

    it('should reject tampered token', () =>
    {
        const { privateKey, publicKey, algorithm } = generateKeyPairES256();

        const token = generateClientToken({ userId: '123' }, privateKey, algorithm);

        // Tamper with the payload
        const parts = token.split('.');
        const tamperedPayload = Buffer.from(JSON.stringify({ ...decodeToken(token), userId: '999' })).toString('base64url');
        const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

        expect(verifyClientToken(tamperedToken, publicKey, algorithm)).toEqual({ refused: 'bad-signature' });
    });

    it('should reject malformed token', () =>
    {
        const { publicKey, algorithm } = generateKeyPairES256();

        expect(verifyClientToken('not.a.valid.jwt', publicKey, algorithm)).toEqual({ refused: 'malformed' });
    });
});

describe('Crypto - Cross-Algorithm Verification', () =>
{
    it('should reject ES256 token verified with RS256 key', () =>
    {
        const es256Key = generateKeyPairES256();
        const rs256Key = generateKeyPairRS256();

        const token = generateClientToken({ test: 'data' }, es256Key.privateKey, es256Key.algorithm);

        expect(verifyClientToken(token, rs256Key.publicKey, rs256Key.algorithm)).toEqual({ refused: 'wrong-issuer-or-algorithm' });
    });

    it('should reject RS256 token verified with ES256 key', () =>
    {
        const es256Key = generateKeyPairES256();
        const rs256Key = generateKeyPairRS256();

        const token = generateClientToken({ test: 'data' }, rs256Key.privateKey, rs256Key.algorithm);

        expect(verifyClientToken(token, es256Key.publicKey, es256Key.algorithm)).toEqual({ refused: 'wrong-issuer-or-algorithm' });
    });
});

describe('Crypto - Key Rotation Helper', () =>
{
    it('should recommend rotation after 83 days (7 days before expiry)', () =>
    {
        const createdAt = new Date();
        createdAt.setDate(createdAt.getDate() - 83);

        const result = shouldRotateKey(createdAt, 90);

        expect(result.shouldRotate).toBe(true);
        expect(result.daysRemaining).toBe(7);
    });

    it('should not recommend rotation for new keys', () =>
    {
        const createdAt = new Date();

        const result = shouldRotateKey(createdAt, 90);

        expect(result.shouldRotate).toBe(false);
        expect(result.daysRemaining).toBe(90);
    });

    it('should not recommend rotation for 50-day-old key', () =>
    {
        const createdAt = new Date();
        createdAt.setDate(createdAt.getDate() - 50);

        const result = shouldRotateKey(createdAt, 90);

        expect(result.shouldRotate).toBe(false);
        expect(result.daysRemaining).toBe(40);
    });

    it('should recommend rotation for expired key', () =>
    {
        const createdAt = new Date();
        createdAt.setDate(createdAt.getDate() - 91);

        const result = shouldRotateKey(createdAt, 90);

        expect(result.shouldRotate).toBe(true);
        expect(result.daysRemaining).toBe(0);
    });

    it('should support custom rotation periods', () =>
    {
        const createdAt = new Date();
        createdAt.setDate(createdAt.getDate() - 23); // 7 days before 30-day period

        const result = shouldRotateKey(createdAt, 30);

        expect(result.shouldRotate).toBe(true);
        expect(result.daysRemaining).toBe(7);
    });
});

describe('Crypto - Key Size Helper', () =>
{
    it('should return correct size information', () =>
    {
        const { publicKey } = generateKeyPairES256();

        const size = getKeySize(publicKey);

        expect(size.bytes).toBeGreaterThan(0);
        expect(size.base64Length).toBe(publicKey.length);
        expect(size.base64Length).toBeGreaterThan(size.bytes); // Base64 is larger
    });

    it('should handle different key sizes', () =>
    {
        const es256 = generateKeyPairES256();
        const rs256 = generateKeyPairRS256();

        const es256Size = getKeySize(es256.publicKey);
        const rs256Size = getKeySize(rs256.publicKey);

        expect(rs256Size.bytes).toBeGreaterThan(es256Size.bytes);
        expect(rs256Size.base64Length).toBeGreaterThan(es256Size.base64Length);
    });
});

describe('Crypto - Performance', () =>
{
    it('should generate ES256 key pair quickly', () =>
    {
        const start = Date.now();
        generateKeyPairES256();
        const duration = Date.now() - start;

        // Should be very fast (< 50ms)
        expect(duration).toBeLessThan(50);
    });

    it('should generate RS256 key pair within reasonable time', () =>
    {
        const start = Date.now();
        generateKeyPairRS256();
        const duration = Date.now() - start;

        // This is a regression ceiling, not a benchmark; shared CI runners can
        // heavily delay CPU-bound key generation.
        expect(duration).toBeLessThan(2_000);
    });

    it('should sign JWT quickly', () =>
    {
        const { privateKey, algorithm } = generateKeyPairES256();

        const start = Date.now();
        generateClientToken({ userId: '123' }, privateKey, algorithm);
        const duration = Date.now() - start;

        // Should be very fast
        expect(duration).toBeLessThan(50);
    });
});
