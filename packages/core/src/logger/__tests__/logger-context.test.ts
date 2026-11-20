/**
 * Logger Context Detection Test
 *
 * Tests for the isContext method to ensure proper differentiation
 * between context objects and error objects
 */

import { describe, it, expect, vi } from 'vitest';
import { Logger } from '../logger';
import type { Transport } from '../types';

describe('Logger Context Detection', () => 
{
    it('should treat {name, method, path} as context, not error', () => 
    {
        const mockTransport: Transport = {
            name: 'mock',
            level: 'debug',
            enabled: true,
            log: vi.fn().mockResolvedValue(undefined),
        };

        const testLogger = new Logger({
            level: 'debug',
            transports: [mockTransport],
        });

        // This is the actual case from contract-scanner
        testLogger.debug('Processing contract', {
            name: 'deleteTeamContract',
            method: 'DELETE',
            path: '/teams/:id',
        });

        return new Promise<void>(resolve => 
        {
            setTimeout(() => 
            {
                expect(mockTransport.log).toHaveBeenCalledTimes(1);
                expect(mockTransport.log).toHaveBeenCalledWith(
                    expect.objectContaining({
                        level: 'debug',
                        message: 'Processing contract',
                        context: {
                            name: 'deleteTeamContract',
                            method: 'DELETE',
                            path: '/teams/:id',
                        },
                        error: undefined, // Should NOT be treated as error
                    }),
                );
                resolve();
            }, 50);
        });
    });

    it('should treat {id, name} as context, not error', () => 
    {
        const mockTransport: Transport = {
            name: 'mock',
            level: 'debug',
            enabled: true,
            log: vi.fn().mockResolvedValue(undefined),
        };

        const testLogger = new Logger({
            level: 'debug',
            transports: [mockTransport],
        });

        testLogger.info('User data', {
            id: 1,
            name: 'John',
        });

        return new Promise<void>(resolve => 
        {
            setTimeout(() => 
            {
                expect(mockTransport.log).toHaveBeenCalledWith(
                    expect.objectContaining({
                        context: { id: 1, name: 'John' },
                        error: undefined,
                    }),
                );
                resolve();
            }, 50);
        });
    });

    it('should treat {message} as context, not error', () => 
    {
        const mockTransport: Transport = {
            name: 'mock',
            level: 'debug',
            enabled: true,
            log: vi.fn().mockResolvedValue(undefined),
        };

        const testLogger = new Logger({
            level: 'debug',
            transports: [mockTransport],
        });

        testLogger.info('Processing', {
            message: 'Processing started',
            status: 'pending',
        });

        return new Promise<void>(resolve => 
        {
            setTimeout(() => 
            {
                expect(mockTransport.log).toHaveBeenCalledWith(
                    expect.objectContaining({
                        context: { message: 'Processing started', status: 'pending' },
                        error: undefined,
                    }),
                );
                resolve();
            }, 50);
        });
    });

    it('should treat Error with stack as error', () => 
    {
        const mockTransport: Transport = {
            name: 'mock',
            level: 'debug',
            enabled: true,
            log: vi.fn().mockResolvedValue(undefined),
        };

        const testLogger = new Logger({
            level: 'error',
            transports: [mockTransport],
        });

        const error = new Error('Test error');
        testLogger.error('Error occurred', error);

        return new Promise<void>(resolve => 
        {
            setTimeout(() => 
            {
                expect(mockTransport.log).toHaveBeenCalledWith(
                    expect.objectContaining({
                        message: 'Error occurred',
                        error: expect.objectContaining({
                            kind: 'error',
                            message: 'Test error',
                            stack: expect.stringContaining('at '),
                        }),
                    }),
                );
                resolve();
            }, 50);
        });
    });

    it('treats an object with a stack, but not an Error, as context', () => 
    {
        const mockTransport: Transport = {
            name: 'mock',
            level: 'debug',
            enabled: true,
            log: vi.fn().mockResolvedValue(undefined),
        };

        const testLogger = new Logger({
            level: 'error',
            transports: [mockTransport],
        });

        // Error-like object with stack
        const errorLike = {
            message: 'Custom error',
            stack: 'Error: Custom error\n    at somewhere',
            name: 'CustomError',
        };

        testLogger.error('Error occurred', errorLike);

        return new Promise<void>(resolve => 
        {
            setTimeout(() => 
            {
                const call = (mockTransport.log as any).mock.calls[0][0];
                expect(call.error).toBeUndefined();
                expect(call.context).toEqual(errorLike);
                resolve();
            }, 50);
        });
    });

    it('should not treat object with non-string stack as error', () => 
    {
        const mockTransport: Transport = {
            name: 'mock',
            level: 'debug',
            enabled: true,
            log: vi.fn().mockResolvedValue(undefined),
        };

        const testLogger = new Logger({
            level: 'debug',
            transports: [mockTransport],
        });

        // Object with 'stack' property but not a string
        testLogger.info('Data with stack array', {
            stack: ['item1', 'item2'],
            result: 'ok',
        });

        return new Promise<void>(resolve => 
        {
            setTimeout(() => 
            {
                expect(mockTransport.log).toHaveBeenCalledWith(
                    expect.objectContaining({
                        context: { stack: ['item1', 'item2'], result: 'ok' },
                        error: undefined,
                    }),
                );
                resolve();
            }, 50);
        });
    });
});
