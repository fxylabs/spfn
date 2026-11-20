/**
 * Console Transport Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { ConsoleTransport } from '../transports/console';
import { describeError } from '../error-description';
import type { LogMetadata } from '../types';

describe('ConsoleTransport', () =>
{
    let consoleLogSpy: MockInstance;
    let consoleErrorSpy: MockInstance;

    beforeEach(() =>
    {
        consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => 
        {});
        consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => 
        {});
    });

    afterEach(() =>
    {
        consoleLogSpy.mockRestore();
        consoleErrorSpy.mockRestore();
    });

    describe('Basic Logging', () =>
    {
        it('should log to console', async () =>
        {
            const transport = new ConsoleTransport({
                level: 'debug',
                enabled: true,
                colorize: false,
            });

            const metadata: LogMetadata = {
                timestamp: new Date(),
                level: 'info',
                message: 'Test message',
            };

            await transport.log(metadata);

            expect(consoleLogSpy).toHaveBeenCalledOnce();
            expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Test message'));
        });

        it('should not log when disabled', async () =>
        {
            const transport = new ConsoleTransport({
                level: 'debug',
                enabled: false,
                colorize: false,
            });

            const metadata: LogMetadata = {
                timestamp: new Date(),
                level: 'info',
                message: 'Test message',
            };

            await transport.log(metadata);

            expect(consoleLogSpy).not.toHaveBeenCalled();
        });
    });

    describe('Log Level Filtering', () =>
    {
        it('should filter logs below minimum level', async () =>
        {
            const transport = new ConsoleTransport({
                level: 'warn',
                enabled: true,
                colorize: false,
            });

            // Debug and Info should be filtered out
            await transport.log({
                timestamp: new Date(),
                level: 'debug',
                message: 'Debug message',
            });

            await transport.log({
                timestamp: new Date(),
                level: 'info',
                message: 'Info message',
            });

            expect(consoleLogSpy).not.toHaveBeenCalled();
        });

        it('should log at or above minimum level', async () =>
        {
            const transport = new ConsoleTransport({
                level: 'warn',
                enabled: true,
                colorize: false,
            });

            await transport.log({
                timestamp: new Date(),
                level: 'warn',
                message: 'Warn message',
            });

            await transport.log({
                timestamp: new Date(),
                level: 'error',
                message: 'Error message',
            });

            expect(consoleErrorSpy).toHaveBeenCalledTimes(2);
        });
    });

    describe('Stream Separation', () =>
    {
        it('should use stdout for debug and info', async () =>
        {
            const transport = new ConsoleTransport({
                level: 'debug',
                enabled: true,
                colorize: false,
            });

            await transport.log({
                timestamp: new Date(),
                level: 'debug',
                message: 'Debug message',
            });

            await transport.log({
                timestamp: new Date(),
                level: 'info',
                message: 'Info message',
            });

            expect(consoleLogSpy).toHaveBeenCalledTimes(2);
            expect(consoleErrorSpy).not.toHaveBeenCalled();
        });

        it('should use stderr for warn, error, and fatal', async () =>
        {
            const transport = new ConsoleTransport({
                level: 'debug',
                enabled: true,
                colorize: false,
            });

            await transport.log({
                timestamp: new Date(),
                level: 'warn',
                message: 'Warn message',
            });

            await transport.log({
                timestamp: new Date(),
                level: 'error',
                message: 'Error message',
            });

            await transport.log({
                timestamp: new Date(),
                level: 'fatal',
                message: 'Fatal message',
            });

            expect(consoleErrorSpy).toHaveBeenCalledTimes(3);
            expect(consoleLogSpy).not.toHaveBeenCalled();
        });
    });

    describe('Message Formatting', () =>
    {
        it('should include timestamp in output', async () =>
        {
            const transport = new ConsoleTransport({
                level: 'debug',
                enabled: true,
                colorize: false,
            });

            const timestamp = new Date('2024-01-15T10:30:00.000Z');

            await transport.log({
                timestamp,
                level: 'info',
                message: 'Test message',
            });

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('2024-01-15'),
            );
        });

        it('should include log level in output', async () =>
        {
            const transport = new ConsoleTransport({
                level: 'debug',
                enabled: true,
                colorize: false,
            });

            await transport.log({
                timestamp: new Date(),
                level: 'error',
                message: 'Test message',
            });

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('ERROR'),
            );
        });

        it('should include module name when provided', async () =>
        {
            const transport = new ConsoleTransport({
                level: 'debug',
                enabled: true,
                colorize: false,
            });

            await transport.log({
                timestamp: new Date(),
                level: 'info',
                message: 'Test message',
                module: 'database',
            });

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('[module=database]'),
            );
        });

        it('should include context when provided', async () =>
        {
            const transport = new ConsoleTransport({
                level: 'debug',
                enabled: true,
                colorize: false,
            });

            await transport.log({
                timestamp: new Date(),
                level: 'info',
                message: 'Test message',
                context: { userId: 123, action: 'login' },
            });

            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('userId'),
            );
        });

        it('should include error stack trace when provided', async () =>
        {
            const transport = new ConsoleTransport({
                level: 'debug',
                enabled: true,
                colorize: false,
            });

            const error = describeError(new Error('Test error'));

            await transport.log({
                timestamp: new Date(),
                level: 'error',
                message: 'Error occurred',
                error,
            });

            expect(consoleErrorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Test error'),
            );
        });
    });

    describe('Colorization', () =>
    {
        it('should apply colors when colorize is true', async () =>
        {
            const transport = new ConsoleTransport({
                level: 'debug',
                enabled: true,
                colorize: true,
            });

            await transport.log({
                timestamp: new Date(),
                level: 'info',
                message: 'Test message',
            });

            // ANSI color codes should be present
            expect(consoleLogSpy).toHaveBeenCalledWith(
                expect.stringContaining('\x1b['),
            );
        });

        it('should not apply colors when colorize is false', async () =>
        {
            const transport = new ConsoleTransport({
                level: 'debug',
                enabled: true,
                colorize: false,
            });

            await transport.log({
                timestamp: new Date(),
                level: 'info',
                message: 'Test message',
            });

            const call = consoleLogSpy.mock.calls[0][0] as string;

            // ANSI color codes should not be present
            expect(call).not.toContain('\x1b[');
        });
    });

    describe('Properties', () =>
    {
        it('should have correct transport name', () =>
        {
            const transport = new ConsoleTransport({
                level: 'debug',
                enabled: true,
            });

            expect(transport.name).toBe('console');
        });

        it('should store level correctly', () =>
        {
            const transport = new ConsoleTransport({
                level: 'warn',
                enabled: true,
            });

            expect(transport.level).toBe('warn');
        });

        it('should store enabled state correctly', () =>
        {
            const transportEnabled = new ConsoleTransport({
                level: 'debug',
                enabled: true,
            });

            const transportDisabled = new ConsoleTransport({
                level: 'debug',
                enabled: false,
            });

            expect(transportEnabled.enabled).toBe(true);
            expect(transportDisabled.enabled).toBe(false);
        });
    });
});
