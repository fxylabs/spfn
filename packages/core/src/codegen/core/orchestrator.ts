/**
 * Codegen Orchestrator
 *
 * Manages multiple code generators and coordinates their execution
 */

import { watch as chokidarWatch } from 'chokidar';
import { join, relative, sep } from 'path';
import mm from 'micromatch';
import type { Generator, GeneratorOptions, GeneratorTrigger } from './generator';
import { pinNodeEnv } from './node-env';
import { logger } from '@spfn/core/logger';

const orchestratorLogger = logger.child('@spfn/core:orchestrator');

export interface OrchestratorOptions
{
    /** List of generators to orchestrate */
    generators: Generator[];

    /** Project root directory */
    cwd?: string;

    /** Enable debug logging */
    debug?: boolean;

    /**
     * Rethrow a generator failure instead of only logging it
     *
     * Off by default, which keeps watch mode alive through a half-edited file.
     * A build turns it on: a generator that refuses — a broken contract, a
     * router that will not load — has to reach the exit code, or the refusal
     * scrolls past and the build ships anyway.
     */
    throwOnError?: boolean;
}

export class CodegenOrchestrator
{
    private readonly generators: Generator[];
    private readonly cwd: string;
    private readonly debug: boolean;
    private readonly throwOnError: boolean;
    private isGenerating = false;
    private pendingRegenerations = new Set<string>();
    private watcher?: ReturnType<typeof chokidarWatch>;
    private watcherClosePromise?: { resolve: () => void; reject: (error: Error) => void };

    /**
     * Pins `NODE_ENV` to `production` (`pinNodeEnv`), for a caller that builds
     * its generators by hand rather than through `loadCodegenConfig`: every
     * generator of every run then sees the one value.
     */
    constructor(options: OrchestratorOptions)
    {
        pinNodeEnv();
        this.generators = options.generators;
        this.cwd = options.cwd ?? process.cwd();
        this.debug = options.debug ?? false;
        this.throwOnError = options.throwOnError ?? false;
    }

    /**
     * Close watcher and cleanup resources
     */
    async close(): Promise<void>
    {
        if (this.watcher)
        {
            if (this.debug)
            {
                orchestratorLogger.info('Closing watcher');
            }
            await this.watcher.close();
            this.watcher = undefined;
        }

        // Resolve the watch promise if it exists
        if (this.watcherClosePromise)
        {
            this.watcherClosePromise.resolve();
            this.watcherClosePromise = undefined;
        }
    }

    /**
     * Check if generator should run for given trigger
     */
    private shouldRun(generator: Generator, trigger: GeneratorTrigger): boolean
    {
        const runOn = generator.runOn ?? ['watch', 'manual', 'build'];

        return runOn.includes(trigger);
    }

    /**
     * Run all generators once
     *
     * @param trigger - How the generators are being triggered
     */
    async generateAll(trigger: GeneratorTrigger = 'manual'): Promise<void>
    {
        // Always log generation start
        const activeGenerators = this.generators.filter(g => this.shouldRun(g, trigger));

        if (activeGenerators.length === 0)
        {
            orchestratorLogger.info('No generators to run for this trigger', { trigger });

            return;
        }

        orchestratorLogger.info(`Running ${activeGenerators.length} generator(s)`, {
            generators: activeGenerators.map(g => g.name).join(', '),
            trigger,
        });

        for (const generator of this.generators)
        {
            // Check if generator should run for this trigger
            if (!this.shouldRun(generator, trigger))
            {
                if (this.debug)
                {
                    orchestratorLogger.info(`[${generator.name}] Skipped (runOn: ${generator.runOn?.join(', ') ?? 'default'})`);
                }

                continue;
            }

            try
            {
                const startTime = Date.now();

                const genOptions: GeneratorOptions = {
                    cwd: this.cwd,
                    debug: this.debug,
                    trigger: {
                        type: trigger,
                    },
                };

                await generator.generate(genOptions);

                const duration = Date.now() - startTime;
                orchestratorLogger.info(`[${generator.name}] ✓ Generated successfully (${duration}ms)`);
            }
            catch (error)
            {
                const err = error instanceof Error ? error : new Error(String(error));
                orchestratorLogger.error(`[${generator.name}] ✗ Generation failed`, err);

                if (this.throwOnError)
                {
                    throw err;
                }
            }
        }
    }

    /**
     * Start watch mode
     */
    async watch(): Promise<void>
    {
        // Initial generation with 'watch' trigger
        await this.generateAll('watch');

        // Collect all watch patterns from generators
        const allPatterns = this.generators.flatMap(g => g.watchPatterns);

        if (allPatterns.length === 0)
        {
            orchestratorLogger.warn('No watch patterns defined, exiting watch mode');

            return;
        }

        // Extract directories to watch from patterns
        // For pattern like "watched/**/*.ts", watch "watched" directory
        const dirsToWatch = new Set<string>();
        for (const pattern of allPatterns)
        {
            // Extract base directory from glob pattern (e.g., "src/**/*.ts" -> "src")
            const baseDir = pattern.split('**')[0].replace(/\/$/, '') || '.';
            dirsToWatch.add(join(this.cwd, baseDir));
        }

        const watchDirs = Array.from(dirsToWatch);

        // Always log watch mode start
        orchestratorLogger.info('Watch mode started', {
            watching: watchDirs.length === 1 ? watchDirs[0] : `${watchDirs.length} directories`,
            generators: this.generators.filter(g => this.shouldRun(g, 'watch')).map(g => g.name).join(', '),
        });

        if (this.debug)
        {
            orchestratorLogger.info('Watch mode details', {
                patterns: allPatterns,
                watchDirs,
                cwd: this.cwd,
            });
        }

        this.watcher = chokidarWatch(watchDirs, {
            // Ignore dotfiles by path segments relative to cwd — matching the absolute
            // path would ignore everything when the checkout itself lives under a dot
            // directory (e.g. .claude/worktrees/<name>), leaving zero watched files
            ignored: (watchedPath: string) => relative(this.cwd, watchedPath)
                .split(sep)
                .some(segment => segment.startsWith('.') && segment !== '.' && segment !== '..'),
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 100,
                pollInterval: 50,
            },
        });

        const handleChange = async (absolutePath: string, event: 'add' | 'change' | 'unlink') =>
        {
            // Convert absolute path to relative path for pattern matching
            const filePath = relative(this.cwd, absolutePath);

            if (this.isGenerating)
            {
                this.pendingRegenerations.add(absolutePath);

                return;
            }

            this.isGenerating = true;
            this.pendingRegenerations.clear();

            // Always log file changes
            const eventIcon = event === 'add' ? '+' : event === 'unlink' ? '-' : '~';
            orchestratorLogger.info(`File ${eventIcon} ${filePath}`);

            // Find matching generators
            let regeneratedCount = 0;
            for (const generator of this.generators)
            {
                // Check if generator should run for 'watch' trigger
                if (!this.shouldRun(generator, 'watch'))
                {
                    continue;
                }

                const matches = generator.watchPatterns.some(pattern =>
                    mm.isMatch(filePath, pattern),
                );

                if (matches)
                {
                    try
                    {
                        const startTime = Date.now();

                        // Call generate() with trigger information
                        const genOptions: GeneratorOptions = {
                            cwd: this.cwd,
                            debug: this.debug,
                            trigger: {
                                type: 'watch',
                                changedFile: {
                                    path: filePath,
                                    event,
                                },
                            },
                        };

                        await generator.generate(genOptions);

                        const duration = Date.now() - startTime;
                        orchestratorLogger.info(`[${generator.name}] ✓ Regenerated (${duration}ms)`);
                        regeneratedCount++;
                    }
                    catch (error)
                    {
                        const err = error instanceof Error ? error : new Error(String(error));
                        orchestratorLogger.error(`[${generator.name}] ✗ Regeneration failed`, err);
                    }
                }
            }

            if (regeneratedCount === 0 && this.debug)
            {
                orchestratorLogger.info('No generators matched this file');
            }

            this.isGenerating = false;

            // Process pending regenerations
            if (this.pendingRegenerations.size > 0)
            {
                const next = Array.from(this.pendingRegenerations)[0];
                await handleChange(next, 'change');
            }
        };

        this.watcher
            .on('add', (path) => handleChange(path, 'add'))
            .on('change', (path) => handleChange(path, 'change'))
            .on('unlink', (path) => handleChange(path, 'unlink'));

        // Return a promise that resolves when the watcher is closed
        // This allows the caller to await the watch() method and keep the process alive
        return new Promise<void>((resolve, reject) =>
        {
            this.watcherClosePromise = { resolve, reject };
        });
    }
}
