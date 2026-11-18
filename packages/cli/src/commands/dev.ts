import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmSync, watch } from 'fs';
import { join, relative, sep } from 'path';
import { execa, type ExecaChildProcess } from 'execa';
import chokidar from 'chokidar';
import { logger } from '../utils/logger.js';
import { syncAgentInstructions } from '../lib/agent-instructions.js';
import { detectPackageManager, getRunScriptArgs } from '../utils/package-manager.js';
import { resolveKeychainEnv } from '../utils/secret-store/index.js';
import { loadAppConfig, resolvePorts, resolveHost } from '@spfn/core/app-config';

/**
 * Chokidar `ignored` that skips dotfiles by path segments relative to the watch
 * root — matching the absolute path would ignore everything when the checkout
 * itself lives under a dot directory (e.g. .claude/worktrees/<name>)
 */
function ignoreDotfilesUnder(root: string)
{
    return (watchedPath: string) => relative(root, watchedPath)
        .split(sep)
        .some(segment => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

/**
 * Refresh the generated instruction block coding agents read.
 *
 * Best effort by construction: a read-only checkout or an odd filesystem costs
 * one warning, never the dev session.
 */
function writeAgentInstructions(cwd: string, agentFiles: boolean): void
{
    try
    {
        const { action, warning } = syncAgentInstructions(cwd, { agentFiles });

        if (warning)
        {
            logger.warn(`[SPFN] ${warning}`);
        }
        else if (action !== 'unchanged' && action !== 'skipped')
        {
            logger.info(`[SPFN] Agent instructions ${action} in AGENTS.md`);
        }
    }
    catch (error)
    {
        // The sync writes AGENTS.md and, when absent, CLAUDE.md — either write
        // can be the one that failed, so the message names both.
        logger.warn(`[SPFN] Could not write the agent instruction files (AGENTS.md, CLAUDE.md): ${error instanceof Error ? error.message : String(error)}`);
    }
}

/**
 * The codegen watcher's entry, `.spfn/watcher.mjs`: the generators of the
 * app's codegen config, run by an orchestrator in watch mode. Started under
 * tsx with the `spfn dev` hook (`devLoader`), as the server is.
 */
export function watcherEntrySource(): string
{
    return `
// Load environment variables
// const { loadEnvFiles } = await import('@spfn/core/server');
// loadEnvFiles();
// await import('@spfn/core/config');
//
// // Initialize database for generators that need it
// const { initDatabase, closeDatabase } = await import('@spfn/core/db');
// await initDatabase({
//     pool: { max: 3 }  // Watcher needs fewer connections than server
// });

import { CodegenOrchestrator, loadCodegenConfig, createGeneratorsFromConfig, markCodegenProcess } from '@spfn/core/codegen';

// Started by the spfn CLI to generate code: a second copy of @spfn/core after a
// router load is refused, not only warned about. In-process, so nothing
// inherits it.
markCodegenProcess();

const cwd = process.cwd();

// A config or generator that fails to load is reported, not read as "no
// generators"; the dev server keeps running without the watcher, and the
// watcher does not read the config again, so the message says to restart.
const generators = await Promise.resolve()
    .then(() => createGeneratorsFromConfig(loadCodegenConfig(cwd), cwd))
    .catch((error) =>
    {
        console.error('[SPFN] Codegen watcher could not load the codegen config:', error instanceof Error ? error.message : error);
        console.error('[SPFN] Route maps are not regenerated meanwhile: fix the config and restart spfn dev.');
        process.exit(1);
    });

const orchestrator = new CodegenOrchestrator({
    generators,
    cwd,
    debug: true
});

// Setup graceful shutdown
const cleanup = async () =>
{
    await orchestrator.close();
};

process.on('SIGTERM', async () =>
{
    await cleanup();
    process.exit(0);
});
process.on('SIGINT', async () =>
{
    await cleanup();
    process.exit(0);
});

// Start watching - this will run indefinitely until the watcher is closed
try
{
    await orchestrator.watch();
}
catch (error)
{
    console.error('[SPFN] Codegen watcher error:', error);
    process.exit(1);
}
`;
}

/**
 * Registers the module hook that runs the app's own source in the format
 * `spfn build` gives it (see `dev-loader/hooks.ts`), for the application rooted
 * at `cwd`. Built next to this file, so it is resolved from the CLI's location,
 * never from the app's cwd.
 */
function devLoader(cwd: string): string
{
    const loader = new URL('./dev-loader/register.js', import.meta.url);

    loader.searchParams.set('root', cwd);

    return loader.href;
}

/**
 * The command that runs a generated entry under the app's tsx, with the dev
 * module hook registered first.
 */
function tsxCommand(pm: string, cwd: string, entry: string): { command: string; args: string[] }
{
    const tsxArgs = ['tsx', '--import', devLoader(cwd), entry];

    return pm === 'npm'
        ? { command: 'npx', args: tsxArgs }
        : { command: pm, args: ['exec', ...tsxArgs] };
}

/**
 * Wait for a file to be created (server writes ready signal to it)
 */
function waitForReadyFile(filePath: string, timeoutMs = 30000): Promise<string>
{
    return new Promise((resolve, reject) =>
    {
        // Already exists (from a previous run) — delete it first
        if (existsSync(filePath))
        {
            unlinkSync(filePath);
        }

        const timer = setTimeout(() =>
        {
            watcher.close();
            reject(new Error(`Server did not become ready within ${timeoutMs / 1000}s`));
        }, timeoutMs);

        const dir = join(filePath, '..');
        const fileName = filePath.split('/').pop()!;

        const watcher = watch(dir, (_event, name) =>
        {
            if (name === fileName && existsSync(filePath))
            {
                watcher.close();
                clearTimeout(timer);
                resolve(readFileSync(filePath, 'utf-8').trim());
            }
        });
    });
}

export const devCommand = new Command('dev')
    .description('Start SPFN development server (detects and runs Next.js + Hono)')
    .option('-p, --port <port>', 'Server port')
    .option('-H, --host <host>', 'Server host')
    .option('--server-only', 'Run only Hono server (skip Next.js)')
    .option('--watch', 'Enable hot reload (watch mode)')
    .option('--allow-pending-migrations', 'Start even when migrations are pending (they are listed as a warning)')
    .option('--no-agent-files', 'Do not write the SPFN instruction block into AGENTS.md (same as SPFN_AGENT_FILES=0)')
    .action(async (options) =>
    {
        // Increase max listeners to prevent warning in dev mode
        // Dev mode runs multiple concurrent processes (SPFN server, contract watcher, Next.js)
        // Each process adds event listeners (SIGTERM, SIGINT, exit, etc.)
        process.setMaxListeners(20);

        // Set NODE_ENV to development (Next.js style)
        if (!process.env.NODE_ENV) 
        {
            process.env.NODE_ENV = 'development';
        }

        const cwd = process.cwd();
        const serverDir = join(cwd, 'src', 'server');

        // One resolution for both processes: SPFN_PORT / NEXT_PORT, then
        // spfn.config.js, then the default. A flag on this command sits above
        // all of it by writing the environment variable the chain reads first.
        if (options.port)
        {
            process.env.SPFN_PORT = String(options.port);
        }

        if (options.host)
        {
            process.env.SPFN_HOST = String(options.host);
        }

        const appConfig = await loadAppConfig(cwd);
        const { next: nextPort, server: serverPort } = resolvePorts(appConfig);
        const serverHost = resolveHost(appConfig);

        // Check if src/server exists
        if (!existsSync(serverDir))
        {
            logger.error('src/server directory not found.');
            logger.info('Run "spfn init" first to initialize SPFN in your project.');
            process.exit(1);
        }

        // Once, before anything long-running starts. `--no-agent-files` makes
        // commander set `agentFiles` to false.
        writeAgentInstructions(cwd, options.agentFiles !== false);

        // Resolve any secret:keychain: references in .env.server and inject the real
        // values into the server child process — mirrors GitOps env injection in prod,
        // so the app always reads plain process.env.
        const { env: keychainEnv, missing: keychainMissing } = await resolveKeychainEnv(cwd);
        const injectedCount = Object.keys(keychainEnv).length;

        if (injectedCount > 0)
        {
            logger.info(`[SPFN] Injecting ${injectedCount} secret(s) from the keychain`);
        }

        if (keychainMissing.length > 0)
        {
            logger.warn(`[SPFN] Could not resolve keychain secret(s): ${keychainMissing.join(', ')} — run \`spfn secret set <KEY>\``);
        }

        const serverEnv: NodeJS.ProcessEnv = { ...process.env, ...keychainEnv };

        // The codegen watcher generates the files production ships, so it runs
        // under production from its first line: the watcher entry's imports,
        // `.spfnrc.ts` and every generator load under the one value on every
        // run. The dev server keeps `development`.
        const watcherEnv: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production' };

        // A package bumped without `spfn db migrate` boots fine and then 500s on the
        // first request touching a missing column. Refuse here instead; the server
        // refuses the same boot by itself, this only makes the message immediate.
        const { checkPendingMigrationsBeforeStart } = await import('../utils/migration-status.js');
        const migrationCheck = await checkPendingMigrationsBeforeStart(
            cwd,
            serverEnv.DATABASE_URL,
            options.allowPendingMigrations === true,
        );

        if (migrationCheck.block)
        {
            process.exit(1);
        }

        if (migrationCheck.allowPending)
        {
            serverEnv.SPFN_ALLOW_PENDING_MIGRATIONS = 'true';
        }

        // Check if Next.js project
        const packageJsonPath = join(cwd, 'package.json');
        let hasNext = false;

        if (existsSync(packageJsonPath))
        {
            const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
            hasNext = !!(packageJson.dependencies?.next || packageJson.devDependencies?.next);
        }

        // Create temporary entry files
        const tempDir = join(cwd, '.spfn');
        const serverEntry = join(tempDir, 'server.mjs');
        const watcherEntry = join(tempDir, 'watcher.mjs');

        mkdirSync(tempDir, { recursive: true });

        // Clean stale build cache from previous builds
        const serverBuildDir = join(tempDir, 'server');
        if (existsSync(serverBuildDir))
        {
            rmSync(serverBuildDir, { recursive: true, force: true });
            logger.info('[SPFN] Cleaned stale build cache (.spfn/server)');
        }

        // Clean stale ready signal
        const readySignal = join(tempDir, 'server-ready');
        if (existsSync(readySignal))
        {
            unlinkSync(readySignal);
        }

        // Server entry. No address here: the flags were already written into
        // SPFN_PORT / SPFN_HOST above, and startServer resolves the chain
        // itself. An address baked in here would be a layer above all of it.
        const configParts: string[] = ['debug: true'];

        const readyFile = join(tempDir, 'server-ready');
        writeFileSync(serverEntry, `
import { writeFileSync } from 'fs';

// Load environment variables FIRST (before any imports that depend on them)
await import('@spfn/core/config');

// Import and start server
const { startServer } = await import('@spfn/core/server');

const instance = await startServer({
    ${configParts.join(',\n    ')}
});

// Signal ready with actual port
writeFileSync(${JSON.stringify(readyFile)}, String(instance.config.port));
`);

        writeFileSync(watcherEntry, watcherEntrySource());

        const pm = detectPackageManager(cwd);

        // Run server only mode
        if (options.serverOnly || !hasNext)
        {
            const watchMode = options.watch === true;
            logger.info(`Starting SPFN Server on http://${serverHost}:${serverPort}${watchMode ? ' (watch mode)' : ''}\n`);

            let serverProcess: ExecaChildProcess | null = null;
            let watcherProcess: ExecaChildProcess | null = null;
            let isRestarting = false;

            // Start codegen watcher
            const startWatcher = () =>
            {
                const watcher = tsxCommand(pm, cwd, watcherEntry);

                watcherProcess = execa(watcher.command, watcher.args, {
                    cwd,
                    stdio: 'inherit',
                    reject: false,
                    env: watcherEnv,
                });

                watcherProcess.then((result) =>
                {
                    if (result.exitCode !== 0 && result.exitCode !== 130)
                    {
                        logger.error(`Codegen watcher exited with code ${result.exitCode}`);
                        logger.warn('[SPFN] Codegen watch is disabled for this session — the server keeps running. Run codegen manually after route changes.');
                    }
                });
            };

            // Start server process
            const startServer = () =>
            {
                const server = tsxCommand(pm, cwd, serverEntry);

                serverProcess = execa(server.command, server.args, {
                    cwd,
                    stdio: 'inherit',
                    reject: false,
                    env: serverEnv,
                });

                // Don't await or catch - let it run independently
            };

            // Restart server
            const restartServer = async () =>
            {
                if (isRestarting) return;
                isRestarting = true;

                logger.info('[SPFN] File changed, restarting server...');

                if (serverProcess)
                {
                    try
                    {
                        serverProcess.kill('SIGTERM');
                        await serverProcess.catch(() => 
                        {});
                        // Wait for port to be released
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                    catch (error)
                    {
                        // Ignore errors during kill
                    }
                }

                startServer();
                isRestarting = false;
            };

            // Setup file watcher for server files
            if (watchMode)
            {
                const watcher = chokidar.watch(serverDir, {
                    ignored: ignoreDotfilesUnder(serverDir),
                    persistent: true,
                    ignoreInitial: true,
                    awaitWriteFinish: {
                        stabilityThreshold: 100,
                        pollInterval: 50,
                    },
                });

                watcher.on('change', (path) =>
                {
                    logger.info(`[SPFN] Changed: ${path.replace(cwd + '/', '')}`);
                    restartServer();
                });

                watcher.on('add', (path) =>
                {
                    logger.info(`[SPFN] Added: ${path.replace(cwd + '/', '')}`);
                    restartServer();
                });

                watcher.on('unlink', (path) =>
                {
                    logger.info(`[SPFN] Removed: ${path.replace(cwd + '/', '')}`);
                    restartServer();
                });
            }

            // Cleanup on exit
            const cleanup = async () =>
            {
                if (serverProcess)
                {
                    serverProcess.kill('SIGTERM');
                }
                if (watcherProcess)
                {
                    watcherProcess.kill('SIGTERM');
                }
                process.exit(0);
            };

            process.on('SIGINT', cleanup);
            process.on('SIGTERM', cleanup);

            // Start both processes
            startWatcher();
            startServer();

            // Keep process alive - let cleanup handlers manage exit
            // Use setInterval to keep the event loop active without unsettled promises
            await new Promise<void>((resolve) =>
            {
                const keepAlive = setInterval(() => 
                {}, 1000000);
                // Cleanup will handle exit, but just in case:
                process.once('beforeExit', () => 
                {
                    clearInterval(keepAlive);
                    resolve();
                });
            });

            return;
        }

        // Run both Next.js (via spfn:next script) + Hono server + Contract watcher
        const watchMode = options.watch === true;
        logger.info(`Starting SPFN server + Next.js (Turbopack)${watchMode ? ' (watch mode)' : ''}...\n`);

        let serverProcess: ExecaChildProcess | null = null;
        let watcherProcess: ExecaChildProcess | null = null;
        let nextProcess: ExecaChildProcess | null = null;
        let isRestarting = false;

        // Start codegen watcher
        const startWatcher = () =>
        {
            const watcher = tsxCommand(pm, cwd, watcherEntry);

            watcherProcess = execa(watcher.command, watcher.args, {
                cwd,
                stdio: 'inherit',
                reject: false,
                env: watcherEnv,
            });

            watcherProcess.then((result) =>
            {
                if (result.exitCode !== 0 && result.exitCode !== 130)
                {
                    logger.error(`Codegen watcher exited with code ${result.exitCode}`);
                    logger.warn('[SPFN] Codegen watch is disabled for this session — the server keeps running. Run codegen manually after route changes.');
                }
            });
        };

        // Start Next.js
        const startNext = () =>
        {
            const nextCmd = pm === 'npm' ? 'npm' : pm;

            // The port is passed through rather than baked into the script, so
            // spfn.config.js is the only place the number appears. Only npm needs a
            // `--` to stop reading the flag as its own config; pnpm, yarn and bun
            // forward the separator to next, which then reads `--port` as a directory.
            const nextArgs = getRunScriptArgs(pm, 'spfn:next', ['--port', String(nextPort)]);

            nextProcess = execa(nextCmd, nextArgs, {
                cwd,
                stdio: 'inherit',
                reject: false,
            });

            nextProcess.then((result) =>
            {
                if (result.exitCode !== 0 && result.exitCode !== 130)
                {
                    logger.error(`Next.js exited with code ${result.exitCode}`);
                    process.exit(1);
                }
            });
        };

        // Start server process
        const startServer = () =>
        {
            const server = tsxCommand(pm, cwd, serverEntry);

            serverProcess = execa(server.command, server.args, {
                cwd,
                stdio: 'inherit',
                reject: false,
                env: serverEnv,
            });

            // Don't await or catch - let it run independently
        };

        // Restart server
        const restartServer = async () =>
        {
            if (isRestarting) return;
            isRestarting = true;

            logger.info('[SPFN] File changed, restarting server...');

            if (serverProcess)
            {
                try
                {
                    serverProcess.kill('SIGTERM');
                    await serverProcess.catch(() => 
                    {});
                    // Wait for port to be released
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                catch (error)
                {
                    // Ignore errors during kill
                }
            }

            startServer();
            isRestarting = false;
        };

        // Setup file watcher for server files
        if (watchMode)
        {
            const watcher = chokidar.watch(serverDir, {
                ignored: ignoreDotfilesUnder(serverDir),
                persistent: true,
                ignoreInitial: true,
                awaitWriteFinish: {
                    stabilityThreshold: 100,
                    pollInterval: 50,
                },
            });

            watcher.on('change', (path) =>
            {
                logger.info(`[SPFN] Changed: ${path.replace(cwd + '/', '')}`);
                restartServer();
            });

            watcher.on('add', (path) =>
            {
                logger.info(`[SPFN] Added: ${path.replace(cwd + '/', '')}`);
                restartServer();
            });

            watcher.on('unlink', (path) =>
            {
                logger.info(`[SPFN] Removed: ${path.replace(cwd + '/', '')}`);
                restartServer();
            });
        }

        // Cleanup on exit
        const cleanup = async () =>
        {
            if (serverProcess)
            {
                serverProcess.kill('SIGTERM');
            }
            if (watcherProcess)
            {
                watcherProcess.kill('SIGTERM');
            }
            if (nextProcess)
            {
                nextProcess.kill('SIGTERM');
            }
            process.exit(0);
        };

        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        // Start all processes — server must be ready before Next.js
        startWatcher();
        startServer();

        try
        {
            const port = await waitForReadyFile(readyFile);
            logger.info(`[SPFN] Server ready on port ${port}, starting Next.js...\n`);
        }
        catch (error)
        {
            logger.warn(`[SPFN] Server readiness check timed out, starting Next.js anyway...`);
        }

        startNext();

        // Keep process alive - let cleanup handlers manage exit
        // Use setInterval to keep the event loop active without unsettled promises
        await new Promise<void>((resolve) =>
        {
            const keepAlive = setInterval(() => 
            {}, 1000000);
            // Cleanup will handle exit, but just in case:
            process.once('beforeExit', () => 
            {
                clearInterval(keepAlive);
                resolve();
            });
        });
    });
