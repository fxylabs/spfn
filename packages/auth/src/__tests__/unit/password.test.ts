/**
 * @spfn/auth - Password Helper Unit Tests
 *
 * Tests for bcrypt password hashing, verification, and strength validation
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
    hashPassword,
    verifyPassword,
    validatePasswordStrength,
} from '@/server/helpers/password';
import { authEnvSchema } from '@/config/schema';

// vitest.config.ts lowers the cost for the suite; this file is about the
// production cost itself, so it hashes at the schema's default.
beforeAll(() =>
{
    vi.stubEnv('SPFN_AUTH_BCRYPT_SALT_ROUNDS', undefined);
});

afterAll(() =>
{
    vi.unstubAllEnvs();
});

describe('Password - Hashing', () =>
{
    it('should hash password successfully', async () =>
    {
        const password = 'MySecurePassword123!';
        const hash = await hashPassword(password);

        expect(hash).toBeTruthy();
        expect(hash).toMatch(/^\$2[aby]\$\d+\$/); // bcrypt format ($2a/$2b/$2y)
        expect(hash.length).toBe(60); // bcrypt always produces 60-char hashes
    });

    it('should generate different hashes for same password', async () =>
    {
        const password = 'SamePassword123!';
        const hash1 = await hashPassword(password);
        const hash2 = await hashPassword(password);

        // Different salts should produce different hashes
        expect(hash1).not.toBe(hash2);
    });

    it('should throw error for empty password', async () =>
    {
        await expect(hashPassword('')).rejects.toThrow('Password cannot be empty');
    });

    it('should use default 12 salt rounds', async () =>
    {
        expect(authEnvSchema.SPFN_AUTH_BCRYPT_SALT_ROUNDS.default).toBe(12);

        const hash = await hashPassword('test123');
        expect(hash).toMatch(/^\$2[aby]\$12\$/); // Default: 12 rounds
    });
});

describe('Password - Verification', () =>
{
    it('should verify correct password', async () =>
    {
        const password = 'CorrectPassword123!';
        const hash = await hashPassword(password);

        const isValid = await verifyPassword(password, hash);
        expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () =>
    {
        const hash = await hashPassword('CorrectPassword123!');

        const isValid = await verifyPassword('WrongPassword123!', hash);
        expect(isValid).toBe(false);
    });

    it('should reject similar but not identical password', async () =>
    {
        const hash = await hashPassword('Password123!');

        // Case-sensitive check
        const isValid = await verifyPassword('password123!', hash);
        expect(isValid).toBe(false);
    });

    it('should throw error for empty password', async () =>
    {
        const hash = await hashPassword('test123');

        await expect(verifyPassword('', hash)).rejects.toThrow('Password cannot be empty');
    });

    it('should throw error for empty hash', async () =>
    {
        await expect(verifyPassword('test123', '')).rejects.toThrow('Hash cannot be empty');
    });

    it('should handle special characters in password', async () =>
    {
        const password = 'P@$$w0rd!#%&*()_+-=[]{}|;:,.<>?/~`';
        const hash = await hashPassword(password);

        const isValid = await verifyPassword(password, hash);
        expect(isValid).toBe(true);
    });

    it('should handle unicode characters in password', async () =>
    {
        const password = '비밀번호123!こんにちは';
        const hash = await hashPassword(password);

        const isValid = await verifyPassword(password, hash);
        expect(isValid).toBe(true);
    });
});

describe('Password - Strength Validation', () =>
{
    describe('Valid passwords', () =>
    {
        it('should accept strong password with all requirements', () =>
        {
            const result = validatePasswordStrength('SecurePass123!@#');

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it('should accept minimum valid password', () =>
        {
            const result = validatePasswordStrength('Abc123!@');

            expect(result.valid).toBe(true);
            expect(result.errors).toHaveLength(0);
        });

        it('should accept password with various special characters', () =>
        {
            const passwords = [
                'Pass123!word',
                'Pass123@word',
                'Pass123#word',
                'Pass123$word',
                'Pass123%word',
            ];

            passwords.forEach(password =>
            {
                const result = validatePasswordStrength(password);
                expect(result.valid).toBe(true);
            });
        });
    });

    describe('Invalid passwords - Length', () =>
    {
        it('should reject short password', () =>
        {
            const result = validatePasswordStrength('Short1!');

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Password must be at least 8 characters');
        });

        it('should reject 7-character password', () =>
        {
            const result = validatePasswordStrength('Pass1!@');

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Password must be at least 8 characters');
        });
    });

    describe('Invalid passwords - Missing character types', () =>
    {
        it('should reject password without uppercase', () =>
        {
            const result = validatePasswordStrength('lowercase123!');

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Password must contain at least one uppercase letter');
        });

        it('should reject password without lowercase', () =>
        {
            const result = validatePasswordStrength('UPPERCASE123!');

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Password must contain at least one lowercase letter');
        });

        it('should reject password without number', () =>
        {
            const result = validatePasswordStrength('NoNumbers!@#');

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Password must contain at least one number');
        });

        it('should reject password without special character', () =>
        {
            const result = validatePasswordStrength('NoSpecial123');

            expect(result.valid).toBe(false);
            expect(result.errors).toContain('Password must contain at least one special character');
        });
    });

    describe('Invalid passwords - Multiple violations', () =>
    {
        it('should return all validation errors for very weak password', () =>
        {
            const result = validatePasswordStrength('WEAK');

            expect(result.valid).toBe(false);
            expect(result.errors).toHaveLength(4); // 4 rules failed (has uppercase)
            expect(result.errors).toContain('Password must be at least 8 characters');
            expect(result.errors).toContain('Password must contain at least one lowercase letter');
            expect(result.errors).toContain('Password must contain at least one number');
            expect(result.errors).toContain('Password must contain at least one special character');
        });

        it('should return multiple errors for partially weak password', () =>
        {
            const result = validatePasswordStrength('password'); // No uppercase, number, special

            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(1);
        });
    });

    describe('Edge cases', () =>
    {
        it('should handle empty string', () =>
        {
            const result = validatePasswordStrength('');

            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        });

        it('should handle whitespace-only password', () =>
        {
            const result = validatePasswordStrength('        ');

            expect(result.valid).toBe(false);
        });

        it('should accept password with spaces if it meets other requirements', () =>
        {
            const result = validatePasswordStrength('Pass 123 Word!');

            expect(result.valid).toBe(true);
        });
    });
});

describe('Password - Performance', () =>
{
    // Cost-12 bcrypt is intentionally CPU-intensive. This is a regression
    // ceiling, not a benchmark; shared CI runners can heavily delay worker-pool work.
    const operationBudgetMs = 2_000;

    it('should hash password within reasonable time', async () =>
    {
        const start = Date.now();
        await hashPassword('TestPassword123!');
        const duration = Date.now() - start;

        expect(duration).toBeLessThan(operationBudgetMs);
    });

    it('should verify password within reasonable time', async () =>
    {
        const hash = await hashPassword('TestPassword123!');

        const start = Date.now();
        await verifyPassword('TestPassword123!', hash);
        const duration = Date.now() - start;

        expect(duration).toBeLessThan(operationBudgetMs);
    });

    it('should validate password strength instantly', () =>
    {
        const start = Date.now();
        validatePasswordStrength('TestPassword123!');
        const duration = Date.now() - start;

        // Validation should be nearly instant
        expect(duration).toBeLessThan(10);
    });
});
