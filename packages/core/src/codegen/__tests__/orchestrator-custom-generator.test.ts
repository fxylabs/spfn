/**
 * Orchestrator Tests - Custom Generator Scenarios
 *
 * Tests for reproducing futureplay project setup with custom generators
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { watch as chokidarWatch } from 'chokidar';
import type { GeneratorOptions, Generator } from '../core/generator';
import { CodegenOrchestrator } from '../core/orchestrator';

const TEST_DIR = resolve(process.cwd(), '.test-tmp-orchestrator-custom');

// Mock chokidar
vi.mock('chokidar', () => ({
    watch: vi.fn(() => ({
        on: vi.fn((_event, _handler) => ({
            on: vi.fn((_event2, _handler2) => ({
                on: vi.fn(),
            })),
        })),
        close: vi.fn(),
    })),
}));

const mockedChokidarWatch = chokidarWatch as Mock;

describe('Orchestrator - Custom Generator (futureplay scenario)', () =>
{
    beforeEach(() =>
    {
        mkdirSync(TEST_DIR, { recursive: true });
        vi.clearAllMocks();
    });

    afterEach(() =>
    {
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    describe('Generator without onFileChange', () =>
    {
        it('should call generate() on file change when onFileChange is not provided', async () =>
        {
            const generateCalls: Array<{ cwd: string; debug?: boolean }> = [];

            // Simulate admin-nav-generator WITHOUT onFileChange
            const adminNavGen: Generator = {
                name: 'admin-nav',
                watchPatterns: ['src/app/admin/**/nav.config.tsx'],
                async generate(options: GeneratorOptions)
                {
                    console.log('[TEST] generate() called with:', options);
                    generateCalls.push({ cwd: options.cwd, debug: options.debug });
                },
                // NO onFileChange - orchestrator should call generate()
            };

            let addHandler: ((path: string) => void) | null = null;
            let changeHandler: ((path: string) => void) | null = null;
            let unlinkHandler: ((path: string) => void) | null = null;

            const mockWatcher = {
                on: vi.fn((event: string, handler: (path: string) => void) => 
                {
                    console.log('[TEST] Watcher.on() called with event:', event);
                    if (event === 'add') addHandler = handler;
                    if (event === 'change') changeHandler = handler;
                    if (event === 'unlink') unlinkHandler = handler;

                    // Watch mode runs its initial generation on chokidar's `ready`.
                    if (event === 'ready')
                    {
                        queueMicrotask(() => handler(''));
                    }

                    return mockWatcher;
                }),
                close: vi.fn(),
            };

            mockedChokidarWatch.mockReturnValue(mockWatcher as any);

            const orchestrator = new CodegenOrchestrator({
                generators: [adminNavGen],
                cwd: TEST_DIR,
                debug: true,
            });

            console.log('[TEST] Starting watch...');
            const watchPromise = orchestrator.watch();
            console.log(watchPromise);
            await new Promise(resolve => setTimeout(resolve, 50));

            console.log('[TEST] Initial generateCalls:', generateCalls.length);
            console.log('[TEST] Handlers captured:', {
                add: !!addHandler,
                change: !!changeHandler,
                unlink: !!unlinkHandler,
            });

            // Initial generate should have been called
            expect(generateCalls.length).toBe(1);
            expect(generateCalls[0].cwd).toBe(TEST_DIR);

            // Clear initial generate call
            generateCalls.length = 0;

            // Simulate file change
            const testFilePath = join(TEST_DIR, 'src/app/admin/users/nav.config.tsx');
            console.log('[TEST] Simulating file change:', testFilePath);

            if (changeHandler)
            {
                console.log('[TEST] Calling changeHandler...');
                await (changeHandler as (path: string) => void)(testFilePath);
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            else
            {
                console.log('[TEST] ❌ changeHandler is null!');
            }

            console.log('[TEST] After file change, generateCalls:', generateCalls.length);

            // Should have called generate() because onFileChange is not provided
            expect(generateCalls.length).toBeGreaterThan(0);
            expect(generateCalls[0].cwd).toBe(TEST_DIR);
            expect(generateCalls[0].debug).toBe(true);
        });
    });

    describe('Incremental update with trigger information', () =>
    {
        it('should pass trigger information for smart regeneration', async () =>
        {
            const generateCalls: Array<{ trigger?: any }> = [];

            // Simulate smart generator that checks trigger info
            const smartGen: Generator = {
                name: 'smart-gen',
                watchPatterns: ['src/**/*.contract.ts'],
                async generate(options: GeneratorOptions)
                {
                    generateCalls.push({ trigger: options.trigger });

                    // Example: smart regen logic
                    if (options.trigger?.changedFile)
                    {
                        console.log('[TEST] Smart regen: only changed file', options.trigger.changedFile.path);
                    }
                    else
                    {
                        console.log('[TEST] Full regeneration');
                    }
                },
            };

            let changeHandler: ((path: string) => void) | null = null;
            const mockWatcher = {
                on: vi.fn((event: string, handler: (path: string) => void) => 
                {
                    if (event === 'change')
                    {
                        changeHandler = handler;
                    }

                    // Watch mode runs its initial generation on chokidar's `ready`.
                    if (event === 'ready')
                    {
                        queueMicrotask(() => handler(''));
                    }

                    return mockWatcher;
                }),
                close: vi.fn(),
            };

            mockedChokidarWatch.mockReturnValue(mockWatcher as any);

            const orchestrator = new CodegenOrchestrator({
                generators: [smartGen],
                cwd: TEST_DIR,
                debug: true,
            });

            const watchPromise = orchestrator.watch();
            console.log(watchPromise);
            await new Promise(resolve => setTimeout(resolve, 50));

            // Clear initial call
            generateCalls.length = 0;

            // Simulate file change
            const testFile = join(TEST_DIR, 'src/api/users.contract.ts');
            if (changeHandler)
            {
                await (changeHandler as (path: string) => void)(testFile);
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            // Should have received trigger with changedFile info
            expect(generateCalls.length).toBeGreaterThan(0);
            expect(generateCalls[0].trigger).toMatchObject({
                type: 'watch',
                changedFile: {
                    path: 'src/api/users.contract.ts',
                    event: 'change',
                },
            });
        });
    });
});
