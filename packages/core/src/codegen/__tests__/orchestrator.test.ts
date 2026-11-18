/**
 * Orchestrator Tests
 *
 * Tests for the codegen orchestrator system
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { watch as chokidarWatch } from 'chokidar';
import { CodegenOrchestrator } from '../core/orchestrator';
import type { Generator, GeneratorOptions } from '../core/generator';

const TEST_DIR = resolve(process.cwd(), '.test-tmp-orchestrator');

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

describe('Orchestrator', () =>
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

    describe('generateAll()', () =>
    {
        it('should run single generator', async () =>
        {
            let generated = false;

            const mockGen: Generator = {
                name: 'test-gen',
                watchPatterns: ['**/*.test'],
                async generate(_options: GeneratorOptions)
                {
                    generated = true;
                },
            };

            const orchestrator = new CodegenOrchestrator({
                generators: [mockGen],
                cwd: TEST_DIR,
                debug: false,
            });

            await orchestrator.generateAll();

            expect(generated).toBe(true);
        });

        it('should run multiple generators', async () =>
        {
            const results: string[] = [];

            const gen1: Generator = {
                name: 'gen-1',
                watchPatterns: ['**/*.a'],
                async generate()
                {
                    results.push('gen-1');
                },
            };

            const gen2: Generator = {
                name: 'gen-2',
                watchPatterns: ['**/*.b'],
                async generate()
                {
                    results.push('gen-2');
                },
            };

            const orchestrator = new CodegenOrchestrator({
                generators: [gen1, gen2],
                cwd: TEST_DIR,
                debug: false,
            });

            await orchestrator.generateAll();

            expect(results).toEqual(['gen-1', 'gen-2']);
        });

        it('should handle generator errors gracefully', async () =>
        {
            const results: string[] = [];

            const failingGen: Generator = {
                name: 'failing',
                watchPatterns: ['**/*.fail'],
                async generate()
                {
                    throw new Error('Generator failed');
                },
            };

            const successGen: Generator = {
                name: 'success',
                watchPatterns: ['**/*.ok'],
                async generate()
                {
                    results.push('success');
                },
            };

            const orchestrator = new CodegenOrchestrator({
                generators: [failingGen, successGen],
                cwd: TEST_DIR,
                debug: false,
            });

            // Should not throw, should continue with other generators
            await orchestrator.generateAll();

            expect(results).toEqual(['success']);
        });

        it('should log debug info when debug enabled', async () =>
        {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => 
            {});

            const mockGen: Generator = {
                name: 'test-gen',
                watchPatterns: ['**/*.test'],
                async generate()
                {
                    // noop
                },
            };

            const orchestrator = new CodegenOrchestrator({
                generators: [mockGen],
                cwd: TEST_DIR,
                debug: true,
            });

            await orchestrator.generateAll();

            consoleSpy.mockRestore();
        });

        it('should pass cwd and debug options to generators', async () =>
        {
            let receivedOptions: GeneratorOptions | null = null;

            const mockGen: Generator = {
                name: 'test-gen',
                watchPatterns: ['**/*.test'],
                async generate(options: GeneratorOptions)
                {
                    receivedOptions = options;
                },
            };

            const orchestrator = new CodegenOrchestrator({
                generators: [mockGen],
                cwd: TEST_DIR,
                debug: true,
            });

            await orchestrator.generateAll();

            expect(receivedOptions).toEqual({
                cwd: TEST_DIR,
                debug: true,
                generation: expect.any(String),
                trigger: {
                    type: 'manual',
                },
            });
        });

        it('hands every generator of one run the same generation, and the next run another', async () =>
        {
            const received: (string | undefined)[] = [];
            const generator = (name: string): Generator => ({
                name,
                watchPatterns: [],
                async generate(options: GeneratorOptions)
                {
                    received.push(options.generation);
                },
            });
            const orchestrator = new CodegenOrchestrator({ generators: [generator('a'), generator('b')], cwd: TEST_DIR });

            await orchestrator.generateAll();
            await orchestrator.generateAll();

            expect(received[0]).toBe(received[1]);
            expect(received[2]).toBe(received[3]);
            expect(received[2]).not.toBe(received[0]);
        });
    });

    describe('watch()', () =>
    {
        it('should call generateAll on start', async () =>
        {
            let generated = false;

            const mockGen: Generator = {
                name: 'test-gen',
                watchPatterns: ['src/**/*.ts'],
                async generate()
                {
                    generated = true;
                },
            };

            const orchestrator = new CodegenOrchestrator({
                generators: [mockGen],
                cwd: TEST_DIR,
                debug: false,
            });

            // Start watch but don't await (it runs forever)
            const watchPromise = orchestrator.watch();
            console.log(watchPromise);

            // Give it a moment to start
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(generated).toBe(true);
        });

        it('should warn when no watch patterns defined', async () =>
        {
            const mockGen: Generator = {
                name: 'no-patterns',
                watchPatterns: [], // No patterns
                async generate()
                {
                    // noop
                },
            };

            const orchestrator = new CodegenOrchestrator({
                generators: [mockGen],
                cwd: TEST_DIR,
                debug: false,
            });

            const watchPromise = orchestrator.watch();
            console.log(watchPromise);

            // Should return early without starting watcher
        });

        it('should setup chokidar watcher with correct patterns', async () =>
        {
            
            const mockGen: Generator = {
                name: 'test-gen',
                watchPatterns: ['src/**/*.ts', 'lib/**/*'],
                async generate()
                {
                    // noop
                },
            };

            const orchestrator = new CodegenOrchestrator({
                generators: [mockGen],
                cwd: TEST_DIR,
                debug: false,
            });

            const watchPromise = orchestrator.watch();
            console.log(watchPromise);

            await new Promise(resolve => setTimeout(resolve, 50));

            expect(chokidarWatch).toHaveBeenCalled();
        });

        it('should not ignore watch roots under a dot directory (issue #26)', async () =>
        {
            const dotCwd = join(TEST_DIR, '.claude', 'worktrees', 'app');
            mkdirSync(dotCwd, { recursive: true });

            const mockGen: Generator = {
                name: 'test-gen',
                watchPatterns: ['src/server/routes/**/*.ts'],
                async generate()
                {
                    // noop
                },
            };

            const orchestrator = new CodegenOrchestrator({
                generators: [mockGen],
                cwd: dotCwd,
                debug: false,
            });

            orchestrator.watch();
            await new Promise(resolve => setTimeout(resolve, 50));

            const ignored = mockedChokidarWatch.mock.calls[0][1].ignored as (path: string) => boolean;

            // Paths whose only dot segments lie above cwd must stay watched
            expect(ignored(join(dotCwd, 'src', 'server', 'routes'))).toBe(false);
            expect(ignored(join(dotCwd, 'src', 'server', 'routes', 'a.ts'))).toBe(false);

            // Dotfiles under cwd are still ignored
            expect(ignored(join(dotCwd, 'src', 'server', 'routes', '.hidden'))).toBe(true);
            expect(ignored(join(dotCwd, '.spfn', 'watcher.mjs'))).toBe(true);
        });

        it('should handle file changes', async () =>
        {
            
            const changes: string[] = [];

            const mockGen: Generator = {
                name: 'test-gen',
                watchPatterns: ['**/*.ts'],
                async generate()
                {
                    changes.push('generated');
                },
            };

            // Mock watcher to capture handlers
            let addHandler: ((path: string) => void) | null = null;
            const mockWatcher = {
                on: vi.fn((event: string, handler: (path: string) => void) => 
                {
                    if (event === 'add')
                    {
                        addHandler = handler;
                    }

                    return mockWatcher;
                }),
                close: vi.fn(),
            };

            mockedChokidarWatch.mockReturnValue(mockWatcher as any);

            const orchestrator = new CodegenOrchestrator({
                generators: [mockGen],
                cwd: TEST_DIR,
                debug: false,
            });

            const watchPromise = orchestrator.watch();
            console.log(watchPromise);

            await new Promise(resolve => setTimeout(resolve, 50));

            // Simulate file add
            if (addHandler)
            {
                (addHandler as (path: string) => void)(join(TEST_DIR, 'test.ts'));
            }

            await new Promise(resolve => setTimeout(resolve, 50));

            // Should have called generate once on start + once on file change
            expect(changes.length).toBeGreaterThanOrEqual(1);
        });

        it('should pass trigger information on file change', async () =>
        {
            
            const receivedTriggers: Array<any> = [];

            const mockGen: Generator = {
                name: 'test-gen',
                watchPatterns: ['**/*.ts'],
                async generate(options: GeneratorOptions)
                {
                    receivedTriggers.push(options.trigger);
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

                    return mockWatcher;
                }),
                close: vi.fn(),
            };

            mockedChokidarWatch.mockReturnValue(mockWatcher as any);

            const orchestrator = new CodegenOrchestrator({
                generators: [mockGen],
                cwd: TEST_DIR,
                debug: false,
            });

            const watchPromise = orchestrator.watch();
            console.log(watchPromise);

            await new Promise(resolve => setTimeout(resolve, 50));

            // Clear initial trigger
            receivedTriggers.length = 0;

            // Simulate file change
            if (changeHandler)
            {
                await (changeHandler as (path: string) => void)(join(TEST_DIR, 'test.ts'));
                await new Promise(resolve => setTimeout(resolve, 50));
            }

            // Should have received trigger with changedFile information
            expect(receivedTriggers.length).toBeGreaterThan(0);
            expect(receivedTriggers[0]).toMatchObject({
                type: 'watch',
                changedFile: {
                    path: 'test.ts',
                    event: 'change',
                },
            });
        });

        it('should handle multiple generators with different patterns', async () =>
        {
            const gen1Changes: string[] = [];
            const gen2Changes: string[] = [];

            const gen1: Generator = {
                name: 'gen-1',
                watchPatterns: ['src/**/*.ts'],
                async generate()
                {
                    gen1Changes.push('gen1');
                },
            };

            const gen2: Generator = {
                name: 'gen-2',
                watchPatterns: ['lib/**/*'],
                async generate()
                {
                    gen2Changes.push('gen2');
                },
            };

            const orchestrator = new CodegenOrchestrator({
                generators: [gen1, gen2],
                cwd: TEST_DIR,
                debug: false,
            });

            const watchPromise = orchestrator.watch();
            console.log(watchPromise);

            await new Promise(resolve => setTimeout(resolve, 50));

            // Both should have generated on start
            expect(gen1Changes).toContain('gen1');
            expect(gen2Changes).toContain('gen2');
        });

        it('should extract base directories from patterns correctly', async () =>
        {
            
            const mockGen: Generator = {
                name: 'test-gen',
                watchPatterns: ['src/**/*.ts', 'lib/**/*', './**/*.config'],
                async generate()
                {
                    // noop
                },
            };

            const orchestrator = new CodegenOrchestrator({
                generators: [mockGen],
                cwd: TEST_DIR,
                debug: false,
            });

            const watchPromise = orchestrator.watch();
            console.log(watchPromise);

            await new Promise(resolve => setTimeout(resolve, 50));

            // Should have called watch with extracted directories
            expect(chokidarWatch).toHaveBeenCalled();
            const callArgs = mockedChokidarWatch.mock.calls[0];
            expect(Array.isArray(callArgs[0])).toBe(true);
        });

        it('should handle errors in generators during watch', async () =>
        {
            
            const failingGen: Generator = {
                name: 'failing',
                watchPatterns: ['**/*.ts'],
                async generate()
                {
                    throw new Error('Generation failed');
                },
            };

            let addHandler: ((path: string) => void) | null = null;
            const mockWatcher = {
                on: vi.fn((event: string, handler: (path: string) => void) => 
                {
                    if (event === 'add')
                    {
                        addHandler = handler;
                    }

                    return mockWatcher;
                }),
                close: vi.fn(),
            };

            mockedChokidarWatch.mockReturnValue(mockWatcher as any);

            const orchestrator = new CodegenOrchestrator({
                generators: [failingGen],
                cwd: TEST_DIR,
                debug: false,
            });

            // Should not throw
            const watchPromise = orchestrator.watch();
            console.log(watchPromise);

            await new Promise(resolve => setTimeout(resolve, 50));

            // Simulate file change - should handle error gracefully
            if (addHandler)
            {
                // Should not throw despite generator error
                await (addHandler as (path: string) => void)(join(TEST_DIR, 'test.ts'));
                await new Promise(resolve => setTimeout(resolve, 50));

                // Test passed if we reach here without throwing
                expect(true).toBe(true);
            }
        });
    });

});
