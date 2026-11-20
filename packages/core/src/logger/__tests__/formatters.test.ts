/**
 * Formatters Tests
 */

import { describe, it, expect } from 'vitest';
import {
    colorizeLevel,
    formatTimestamp,
    formatTimestampHuman,
    formatError,
    formatContext,
    formatConsole,
    formatJSON,
    maskSensitiveData,
} from '../formatters';
import { describeError } from '../error-description';
import type { LogMetadata } from '../types';

describe('Formatters', () =>
{
    describe('colorizeLevel', () =>
    {
        it('should colorize debug level', () =>
        {
            const result = colorizeLevel('debug');
            expect(result).toContain('DEBUG');
            expect(result).toContain('\x1b['); // ANSI color code
        });

        it('should colorize all log levels', () =>
        {
            const levels = ['debug', 'info', 'warn', 'error', 'fatal'] as const;

            levels.forEach(level =>
            {
                const result = colorizeLevel(level);
                expect(result).toContain(level.toUpperCase());
                expect(result).toContain('\x1b[');
            });
        });

        it('should pad level names to 5 characters', () =>
        {
            const result = colorizeLevel('info');
            // Remove ANSI codes and check length
            const stripped = result.replace(/\x1b\[\d+m/g, '');
            expect(stripped.length).toBe(5);
        });
    });

    describe('formatTimestamp', () =>
    {
        it('should format timestamp in ISO 8601 format', () =>
        {
            const date = new Date('2024-01-15T10:30:00.000Z');
            const result = formatTimestamp(date);

            expect(result).toBe('2024-01-15T10:30:00.000Z');
        });

        it('should handle different dates', () =>
        {
            const date1 = new Date('2023-12-25T12:00:00.000Z');
            const date2 = new Date('2025-06-15T18:45:30.123Z');

            expect(formatTimestamp(date1)).toBe('2023-12-25T12:00:00.000Z');
            expect(formatTimestamp(date2)).toBe('2025-06-15T18:45:30.123Z');
        });
    });

    describe('formatTimestampHuman', () =>
    {
        it('should format timestamp in human-readable format', () =>
        {
            const date = new Date('2024-01-15T10:30:45.123Z');
            const result = formatTimestampHuman(date);

            expect(result).toContain('2024-01-15');
            expect(result).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3}/);
        });

        it('should pad single digits', () =>
        {
            const date = new Date('2024-01-05T09:05:03.001Z');
            const result = formatTimestampHuman(date);

            expect(result).toContain('2024-01-05');
            expect(result).toContain('001'); // milliseconds padded
        });
    });

    describe('formatError', () =>
    {
        it('should format error with name and message', () =>
        {
            const error = new Error('Test error message');
            const result = formatError(describeError(error));

            expect(result).toContain('Error: Test error message');
        });

        it('should include stack trace', () =>
        {
            const error = new Error('Test error');
            const result = formatError(describeError(error));

            expect(result).toContain('at ');
        });

        it('should handle custom error types', () =>
        {
            class CustomError extends Error
            {
                constructor(message: string)
                {
                    super(message);
                    this.name = 'CustomError';
                }
            }

            const error = new CustomError('Custom error message');
            const result = formatError(describeError(error));

            expect(result).toContain('CustomError: Custom error message');
        });
    });

    describe('formatContext', () =>
    {
        it('should format context as JSON', () =>
        {
            const context = { userId: 123, action: 'login' };
            const result = formatContext(context);

            const parsed = JSON.parse(result);
            expect(parsed).toEqual(context);
        });

        it('should pretty print with 2-space indentation', () =>
        {
            const context = { userId: 123, nested: { key: 'value' } };
            const result = formatContext(context);

            expect(result).toContain('  '); // 2-space indent
            expect(result).toContain('{\n');
        });

        it('should handle serialization errors gracefully', () =>
        {
            const circular: any = {};
            circular.self = circular;

            const result = formatContext(circular);

            expect(result).toBe('[Context serialization failed]');
        });
    });

    describe('formatConsole', () =>
    {
        it('should format complete log message', () =>
        {
            const metadata: LogMetadata = {
                timestamp: new Date('2024-01-15T10:30:00.000Z'),
                level: 'info',
                message: 'Test message',
            };

            const result = formatConsole(metadata, false);

            expect(result).toContain('INFO');
            expect(result).toContain('Test message');
            expect(result).toContain('2024-01-15');
        });

        it('should include module name', () =>
        {
            const metadata: LogMetadata = {
                timestamp: new Date(),
                level: 'info',
                message: 'Test message',
                module: 'database',
            };

            const result = formatConsole(metadata, false);

            expect(result).toContain('[module=database]');
        });

        it('should include context', () =>
        {
            const metadata: LogMetadata = {
                timestamp: new Date(),
                level: 'info',
                message: 'Test message',
                context: { userId: 123 },
            };

            const result = formatConsole(metadata, false);

            expect(result).toContain('userId');
            expect(result).toContain('123');
        });

        it('should include error stack trace', () =>
        {
            const metadata: LogMetadata = {
                timestamp: new Date(),
                level: 'error',
                message: 'Error occurred',
                error: describeError(new Error('Test error')),
            };

            const result = formatConsole(metadata, false);

            expect(result).toContain('Test error');
            expect(result).toContain('at ');
        });

        it('should apply colors when colorize is true', () =>
        {
            const metadata: LogMetadata = {
                timestamp: new Date(),
                level: 'info',
                message: 'Test message',
            };

            const result = formatConsole(metadata, true);

            expect(result).toContain('\x1b[');
        });

        it('should not apply colors when colorize is false', () =>
        {
            const metadata: LogMetadata = {
                timestamp: new Date(),
                level: 'info',
                message: 'Test message',
            };

            const result = formatConsole(metadata, false);

            expect(result).not.toContain('\x1b[');
        });
    });

    describe('formatJSON', () =>
    {
        it('should format as valid JSON', () =>
        {
            const metadata: LogMetadata = {
                timestamp: new Date('2024-01-15T10:30:00.000Z'),
                level: 'info',
                message: 'Test message',
            };

            const result = formatJSON(metadata);
            const parsed = JSON.parse(result);

            expect(parsed.timestamp).toBe('2024-01-15T10:30:00.000Z');
            expect(parsed.level).toBe('info');
            expect(parsed.message).toBe('Test message');
        });

        it('should include module if provided', () =>
        {
            const metadata: LogMetadata = {
                timestamp: new Date(),
                level: 'info',
                message: 'Test message',
                module: 'database',
            };

            const result = formatJSON(metadata);
            const parsed = JSON.parse(result);

            expect(parsed.module).toBe('database');
        });

        it('should include context if provided', () =>
        {
            const metadata: LogMetadata = {
                timestamp: new Date(),
                level: 'info',
                message: 'Test message',
                context: { userId: 123, action: 'login' },
            };

            const result = formatJSON(metadata);
            const parsed = JSON.parse(result);

            expect(parsed.context).toEqual({ userId: 123, action: 'login' });
        });

        it('should include error details if provided', () =>
        {
            const error = describeError(new Error('Test error'));
            const metadata: LogMetadata = {
                timestamp: new Date(),
                level: 'error',
                message: 'Error occurred',
                error,
            };

            const result = formatJSON(metadata);
            const parsed = JSON.parse(result);

            expect(parsed.error).toBeDefined();
            expect(parsed.error.name).toBe('Error');
            expect(parsed.error.message).toBe('Test error');
            expect(parsed.error.stack).toBeDefined();
        });
    });

    describe('maskSensitiveData', () =>
    {
        it('should mask password field', () =>
        {
            const data = { username: 'john', password: 'secret123' };
            const result = maskSensitiveData(data);

            expect(result).toEqual({
                username: 'john',
                password: '***MASKED***',
            });
        });

        it('should mask various sensitive keys', () =>
        {
            const data = {
                username: 'john',
                password: 'secret123',
                token: 'abc123',
                apiKey: 'xyz789',
                secret: 'hidden',
                authorization: 'Bearer token',
            };
            const result = maskSensitiveData(data) as Record<string, unknown>;

            expect(result.username).toBe('john');
            expect(result.password).toBe('***MASKED***');
            expect(result.token).toBe('***MASKED***');
            expect(result.apiKey).toBe('***MASKED***');
            expect(result.secret).toBe('***MASKED***');
            expect(result.authorization).toBe('***MASKED***');
        });

        it('should handle nested objects', () =>
        {
            const data = {
                user: {
                    id: 123,
                    name: 'John',
                    credentials: {
                        password: 'secret',
                        apiKey: 'key123',
                    },
                },
            };
            const result = maskSensitiveData(data) as any;

            expect(result.user.id).toBe(123);
            expect(result.user.name).toBe('John');
            expect(result.user.credentials.password).toBe('***MASKED***');
            expect(result.user.credentials.apiKey).toBe('***MASKED***');
        });

        it('should handle arrays', () =>
        {
            const data = [
                { name: 'user1', password: 'pass1' },
                { name: 'user2', token: 'token2' },
            ];
            const result = maskSensitiveData(data) as any[];

            expect(result[0].name).toBe('user1');
            expect(result[0].password).toBe('***MASKED***');
            expect(result[1].name).toBe('user2');
            expect(result[1].token).toBe('***MASKED***');
        });

        it('should preserve null and undefined values', () =>
        {
            expect(maskSensitiveData(null)).toBe(null);
            expect(maskSensitiveData(undefined)).toBe(undefined);
        });

        it('should preserve primitive types', () =>
        {
            expect(maskSensitiveData('string')).toBe('string');
            expect(maskSensitiveData(123)).toBe(123);
            expect(maskSensitiveData(true)).toBe(true);
        });

        it('should be case-insensitive', () =>
        {
            const data = {
                PASSWORD: 'secret',
                Token: 'abc',
                API_KEY: 'xyz',
            };
            const result = maskSensitiveData(data) as Record<string, unknown>;

            expect(result.PASSWORD).toBe('***MASKED***');
            expect(result.Token).toBe('***MASKED***');
            expect(result.API_KEY).toBe('***MASKED***');
        });

        it('should handle partial key matches', () =>
        {
            const data = {
                userPassword: 'secret',
                accessToken: 'token123',
                myApiKey: 'key789',
            };
            const result = maskSensitiveData(data) as Record<string, unknown>;

            expect(result.userPassword).toBe('***MASKED***');
            expect(result.accessToken).toBe('***MASKED***');
            expect(result.myApiKey).toBe('***MASKED***');
        });

        it('should not mask non-sensitive fields', () =>
        {
            const data = {
                userId: 123,
                email: 'user@example.com',
                status: 'active',
                metadata: {
                    created: '2024-01-01',
                    updated: '2024-01-15',
                },
            };
            const result = maskSensitiveData(data);

            expect(result).toEqual(data);
        });

        it('should handle credit card related fields', () =>
        {
            const data = {
                creditCard: '4111-1111-1111-1111',
                cardNumber: '1234567890123456',
                cvv: '123',
            };
            const result = maskSensitiveData(data) as Record<string, unknown>;

            expect(result.creditCard).toBe('***MASKED***');
            expect(result.cardNumber).toBe('***MASKED***');
            expect(result.cvv).toBe('***MASKED***');
        });

        it('should handle session and auth fields', () =>
        {
            const data = {
                sessionId: 'sess_123',
                session: { id: 'sess_123', data: 'data' },
                cookie: 'session=abc',
                auth: 'Bearer token',
            };
            const result = maskSensitiveData(data) as Record<string, unknown>;

            expect(result.sessionId).toBe('***MASKED***');
            expect(result.session).toBe('***MASKED***');
            expect(result.cookie).toBe('***MASKED***');
            expect(result.auth).toBe('***MASKED***');
        });

        it('should handle deeply nested structures', () =>
        {
            const data = {
                level1: {
                    level2: {
                        level3: {
                            password: 'deep-secret',
                            normalField: 'normal-value',
                        },
                    },
                },
            };
            const result = maskSensitiveData(data) as any;

            expect(result.level1.level2.level3.password).toBe('***MASKED***');
            expect(result.level1.level2.level3.normalField).toBe('normal-value');
        });

        it('should handle circular references', () =>
        {
            const data: any = {
                name: 'parent',
                password: 'secret',
            };
            data.self = data; // Circular reference

            const result = maskSensitiveData(data) as any;

            expect(result.name).toBe('parent');
            expect(result.password).toBe('***MASKED***');
            expect(result.self).toBe('[Circular]');
        });

        it('should handle nested circular references', () =>
        {
            const parent: any = { name: 'parent', password: 'secret1' };
            const child: any = { name: 'child', token: 'token123' };
            parent.child = child;
            child.parent = parent;

            const result = maskSensitiveData(parent) as any;

            expect(result.name).toBe('parent');
            expect(result.password).toBe('***MASKED***');
            expect(result.child.name).toBe('child');
            expect(result.child.token).toBe('***MASKED***');
            expect(result.child.parent).toBe('[Circular]');
        });

        it('should handle arrays with circular references', () =>
        {
            const item: any = { id: 1, password: 'secret' };
            const data: any = {
                items: [item],
            };
            item.container = data;

            const result = maskSensitiveData(data) as any;

            expect(result.items[0].id).toBe(1);
            expect(result.items[0].password).toBe('***MASKED***');
            expect(result.items[0].container).toBe('[Circular]');
        });
    });
});
