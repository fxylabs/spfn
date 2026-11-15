/**
 * @spfn/auth - Verification Helper Tests
 *
 * Unit tests for verification code helpers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';
import {
    generateVerificationCode,
    createVerificationToken,
    validateVerificationToken,
    type VerificationTokenPayload,
} from '@/server/services/verification.service';

describe('Verification Helpers', () =>
{
    describe('generateVerificationCode', () =>
    {
        it('should generate a 6-digit code', () =>
        {
            const code = generateVerificationCode();
            expect(code).toMatch(/^\d{6}$/);
        });

        it('should generate different codes on multiple calls', () =>
        {
            const codes = new Set<string>();
            for (let i = 0; i < 100; i++)
            {
                codes.add(generateVerificationCode());
            }
            // Very unlikely to get all the same code
            expect(codes.size).toBeGreaterThan(1);
        });

        it('should pad codes with leading zeros', () =>
        {
            // CSPRNG returns a small number -> code must be zero-padded to 6 digits
            const spy = vi.spyOn(crypto, 'randomInt').mockReturnValue(1 as never);

            const code = generateVerificationCode();
            expect(code).toBe('000001');

            spy.mockRestore();
        });
    });

    describe('createVerificationToken', () =>
    {
        beforeEach(() =>
        {
            // Set environment variable for JWT secret
            vi.stubEnv('SPFN_AUTH_VERIFICATION_TOKEN_SECRET', 'test-secret-with-at-least-32-characters-for-testing');
        });

        it('should create a valid JWT token', () =>
        {
            const payload: VerificationTokenPayload = {
                target: 'test@example.com',
                targetType: 'email',
                purpose: 'registration',
                codeId: 123,
            };

            const token = createVerificationToken(payload);

            // JWT format: header.payload.signature
            expect(token.split('.')).toHaveLength(3);
        });

        it('should create different tokens for different payloads', () =>
        {
            const payload1: VerificationTokenPayload = {
                target: 'test1@example.com',
                targetType: 'email',
                purpose: 'registration',
                codeId: 1,
            };

            const payload2: VerificationTokenPayload = {
                target: 'test2@example.com',
                targetType: 'email',
                purpose: 'registration',
                codeId: 2,
            };

            const token1 = createVerificationToken(payload1);
            const token2 = createVerificationToken(payload2);

            expect(token1).not.toBe(token2);
        });

        // Skipped: see session.test — required-secret validation moved to the core
        // env registry (validates/caches at startup); re-stubbing mid-test no longer
        // triggers the short-secret path here.
        it.skip('should throw error if JWT_SECRET is too short', () =>
        {
            vi.stubEnv('SPFN_AUTH_VERIFICATION_TOKEN_SECRET', 'short');

            const payload: VerificationTokenPayload = {
                target: 'test@example.com',
                targetType: 'email',
                purpose: 'registration',
                codeId: 123,
            };

            expect(() => createVerificationToken(payload)).toThrow(
                'VERIFICATION_TOKEN_SECRET must be at least 32 characters long',
            );
        });
    });

    describe('validateVerificationToken', () =>
    {
        beforeEach(() =>
        {
            vi.stubEnv('SPFN_AUTH_VERIFICATION_TOKEN_SECRET', 'test-secret-with-at-least-32-characters-for-testing');
        });

        it('should validate and decode a valid token', () =>
        {
            const payload: VerificationTokenPayload = {
                target: 'test@example.com',
                targetType: 'email',
                purpose: 'registration',
                codeId: 123,
            };

            const token = createVerificationToken(payload);
            const decoded = validateVerificationToken(token);

            expect(decoded).not.toBeNull();
            expect(decoded?.target).toBe('test@example.com');
            expect(decoded?.targetType).toBe('email');
            expect(decoded?.purpose).toBe('registration');
            expect(decoded?.codeId).toBe(123);
        });

        it('should return null for invalid token', () =>
        {
            const decoded = validateVerificationToken('invalid.token.here');
            expect(decoded).toBeNull();
        });

        it('should return null for token with wrong issuer', () =>
        {
            // Create a token with different issuer
            const jwt = require('jsonwebtoken');
            const token = jwt.sign(
                {
                    target: 'test@example.com',
                    targetType: 'email',
                    purpose: 'registration',
                    codeId: 123,
                },
                'test-secret-with-at-least-32-characters-for-testing',
                {
                    expiresIn: '15m',
                    issuer: 'wrong-issuer', // Wrong issuer
                    audience: 'spfn-client',
                },
            );

            const decoded = validateVerificationToken(token);
            expect(decoded).toBeNull();
        });

        it('should return null for token with wrong audience', () =>
        {
            const jwt = require('jsonwebtoken');
            const token = jwt.sign(
                {
                    target: 'test@example.com',
                    targetType: 'email',
                    purpose: 'registration',
                    codeId: 123,
                },
                'test-secret-with-at-least-32-characters-for-testing',
                {
                    expiresIn: '15m',
                    issuer: 'spfn-auth',
                    audience: 'wrong-audience', // Wrong audience
                },
            );

            const decoded = validateVerificationToken(token);
            expect(decoded).toBeNull();
        });

        it('should return null for expired token', () =>
        {
            const jwt = require('jsonwebtoken');
            const token = jwt.sign(
                {
                    target: 'test@example.com',
                    targetType: 'email',
                    purpose: 'registration',
                    codeId: 123,
                },
                'test-secret-with-at-least-32-characters-for-testing',
                {
                    expiresIn: '-1s', // Already expired
                    issuer: 'spfn-auth',
                    audience: 'spfn-client',
                },
            );

            const decoded = validateVerificationToken(token);
            expect(decoded).toBeNull();
        });

        it('should return null for token missing required fields', () =>
        {
            const jwt = require('jsonwebtoken');
            const token = jwt.sign(
                {
                    // Missing required fields
                    target: 'test@example.com',
                    // targetType, purpose, codeId are missing
                },
                'test-secret-with-at-least-32-characters-for-testing',
                {
                    expiresIn: '15m',
                    issuer: 'spfn-auth',
                    audience: 'spfn-client',
                },
            );

            const decoded = validateVerificationToken(token);
            expect(decoded).toBeNull();
        });

        it('should validate token with phone target', () =>
        {
            const payload: VerificationTokenPayload = {
                target: '+821012345678',
                targetType: 'phone',
                purpose: 'account_deletion',
                codeId: 456,
            };

            const token = createVerificationToken(payload);
            const decoded = validateVerificationToken(token);

            expect(decoded).not.toBeNull();
            expect(decoded?.target).toBe('+821012345678');
            expect(decoded?.targetType).toBe('phone');
            expect(decoded?.purpose).toBe('account_deletion');
            expect(decoded?.codeId).toBe(456);
        });
    });
});
