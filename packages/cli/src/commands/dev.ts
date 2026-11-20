import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmSync, watch } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { execa, type ExecaChildProcess } from 'execa';
import chokidar from 'chokidar';
import { logger } from '../utils/logger.js';
import { getCliVersion, getCorePeerRange } from '../utils/version.js';
import { syncAgentInstructions } from '../lib/agent-instructions.js';
import { detectPackageManager, getAddCommand, getRunScriptArgs, type PackageManager } from '../utils/package-manager.js';
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
 * app's codegen config, run by an orchestrator in watch mode, which loads them
 * again when the config changes (`loadGenerators`). Started under
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

import { existsSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The @spfn/core installed for the app: the package.json of the
// node_modules/@spfn/core nearest this entry, where its import resolves.
const installedCoreVersion = () =>
{
    let directory = dirname(fileURLToPath(import.meta.url));

    while (dirname(directory) !== directory)
    {
        const file = join(directory, 'node_modules/@spfn/core/package.json');

        if (existsSync(file))
        {
            return JSON.parse(readFileSync(file, 'utf8')).version;
        }

        directory = dirname(directory);
    }

    return undefined;
};

// The error resolving '@spfn/core/codegen' itself, if any.
const codegenResolutionError = () =>
{
    try
    {
        import.meta.resolve('@spfn/core/codegen');
        return undefined;
    }
    catch (error)
    {
        return error;
    }
};

// A core that cannot load the generators itself — no './codegen' to resolve,
// no CodegenOrchestrator, or one without loadsGenerators, which ignores
// loadGenerators and fails on the generator list it never got — stops the
// watcher with one message, naming the core installed and the range this spfn
// requires. Any other failure (no core at all, a core broken in its own code
// or dependencies) is not an old core and surfaces as its own error.
const resolutionError = codegenResolutionError();
const unresolvableCore = ['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_MODULE_NOT_FOUND'].includes(resolutionError?.code)
    && installedCoreVersion() !== undefined;

if (resolutionError !== undefined && !unresolvableCore)
{
    throw resolutionError;
}

const codegen = unresolvableCore ? {} : await import('@spfn/core/codegen');

if (codegen.CodegenOrchestrator?.loadsGenerators !== true)
{
    console.error(\`[SPFN] Codegen watcher not started: @spfn/core \${installedCoreVersion() ?? 'of unknown version'} is installed; spfn ${getCliVersion()} requires @spfn/core ${getCorePeerRange()} and a core that reloads generators. Update @spfn/core.\`);
    process.exit(1);
}

const { CodegenOrchestrator, loadCodegenConfig, createGeneratorsFromConfig, markCodegenProcess } = codegen;

// Started by the spfn CLI to generate code: a second copy of @spfn/core after a
// router load is refused, not only warned about. In-process, so nothing
// inherits it.
markCodegenProcess();

const cwd = process.cwd();

// The orchestrator loads the generators itself, and again whenever the config,
// a custom generator or a project file they import changes. A config that
// fails to load, at start or later, pauses regeneration and says so; the
// watcher stays up and loads it again on the next save.
const orchestrator = new CodegenOrchestrator({
    loadGenerators: async () => createGeneratorsFromConfig(loadCodegenConfig(cwd), cwd),
    cwd,
    debug: true
});

// The first signal: close() starts no new generation and resolves once the one
// running has finished every generator, so the files of one cycle (route map,
// contract) are never left from two different generations, or once the config
// load running has finished; then exit. Neither a generation nor a config load
// (a module evaluation) can be cancelled, so a second signal exits at once: it
// is the only way to stop one that never settles.
let stopping = false;

const stop = async (signal) =>
{
    if (stopping)
    {
        process.exit(128 + constants.signals[signal]);
    }

    stopping = true;
    console.log('[SPFN] Codegen watcher stopping once the running generation or codegen config load finishes (signal again to exit now)');
    await orchestrator.close();
    process.exit(0);
};

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

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
 * The command that runs the server entry under the app's tsx, through the
 * package manager, with the dev module hook registered first.
 */
function tsxCommand(pm: string, cwd: string, entry: string): { command: string; args: string[] }
{
    const tsxArgs = ['tsx', '--import', devLoader(cwd), entry];

    return pm === 'npm'
        ? { command: 'npx', args: tsxArgs }
        : { command: pm, args: ['exec', ...tsxArgs] };
}

/**
 * Start the codegen watcher entry: a tsx CLI run by this Node, never through
 * the package manager. `spfn dev` forwards its signals to the watcher and waits
 * for it to exit (`DevChildren`), and neither wrapper lets it: `pnpm exec`
 * forwards SIGTERM and exits at once, `npx` exits without forwarding it, and
 * the watcher is orphaned. tsx relays each signal to the entry and exits when
 * it does. With no tsx to run (`resolveTsxCli`), the watcher is not started:
 * the session goes on without it, as when the watcher exits with an error.
 * Returns the watcher process, or null when none was started.
 */
function startCodegenWatcher(pm: PackageManager, cwd: string, entry: string, env: NodeJS.ProcessEnv, stopping: () => boolean): ExecaChildProcess | null
{
    const tsxCli = resolveTsxCli(cwd);

    if (tsxCli === undefined)
    {
        logger.error(`[SPFN] Codegen watcher not started: no tsx is installed for the app or for the spfn CLI. Install it in the app: ${getAddCommand(pm, ['tsx'], { dev: true })}`);
        warnCodegenWatchDisabled();

        return null;
    }

    const watcher = execa(process.execPath, [tsxCli, '--import', devLoader(cwd), entry], { cwd, stdio: 'inherit', reject: false, env });

    watcher.then((result) =>
    {
        if (!stopping() && result.exitCode !== 0 && result.exitCode !== 130)
        {
            logger.error(`Codegen watcher exited with code ${result.exitCode}`);
            warnCodegenWatchDisabled();
        }
    });

    return watcher;
}

function warnCodegenWatchDisabled(): void
{
    logger.warn('[SPFN] Codegen watch is disabled for this session — the server keeps running. Run codegen manually after route changes.');
}

/**
 * The tsx CLI the watcher runs under: the app's, else the one installed for
 * the spfn CLI itself (the tsx `bin/spfn.js` re-spawns under), else undefined.
 */
function resolveTsxCli(cwd: string): string | undefined
{
    return tsxCliFrom(cwd) ?? tsxCliFrom(dirname(fileURLToPath(import.meta.url)));
}

/**
 * The bin of the tsx in the nearest `node_modules` on the way up from `from`:
 * Node's lookup of a package without `NODE_PATH`. Package-manager shims (a
 * pnpm bin script, npx) point `NODE_PATH` at their store, which would hand the
 * watcher a tsx nothing on that path declares.
 */
function tsxCliFrom(from: string): string | undefined
{
    let directory = from;

    while (!existsSync(join(directory, 'node_modules/tsx/package.json')))
    {
        if (dirname(directory) === directory)
        {
            return undefined;
        }

        directory = dirname(directory);
    }

    const tsxDir = join(directory, 'node_modules/tsx');
    const { bin } = JSON.parse(readFileSync(join(tsxDir, 'package.json'), 'utf-8'));

    return join(tsxDir, typeof bin === 'string' ? bin : bin.tsx);
}

type DevChildName = 'server' | 'Next.js' | 'codegen watcher';

/**
 * The children `spfn dev` runs, stopped together on SIGINT and SIGTERM. The
 * codegen watcher is sent every signal this process receives, and this process
 * exits only once the watcher has: on the first signal the watcher finishes the
 * generation running, on a second it exits at once (`watcherEntrySource`).
 * Exiting before it would leave a watcher writing into the project after
 * `spfn dev` was stopped. The server and Next.js are sent SIGTERM once and not
 * waited for: the server's shutdown deadline is core's (`SHUTDOWN_TIMEOUT`),
 * and it ignores a second signal. No child gets execa's default SIGKILL 5 s
 * after a SIGTERM: for the watcher it would kill tsx mid-generation and orphan
 * the entry tsx runs, which a SIGKILL is not relayed to. Nothing forwards a
 * SIGKILL this process gets.
 */
class DevChildren
{
    private readonly children = new Map<DevChildName, ExecaChildProcess>();
    private stopping = false;

    constructor()
    {
        process.on('SIGINT', signal => this.stop(signal));
        process.on('SIGTERM', signal => this.stop(signal));
    }

    /**
     * The only way `spfn dev` starts a child: `launch` runs and its child is
     * registered under `name`, replacing the one before (a restarted server).
     * Once a stop has begun it says so, starts nothing, and returns null: a
     * child started after the stop signalled the others would never be signalled.
     */
    start(name: DevChildName, launch: () => ExecaChildProcess | null): ExecaChildProcess | null
    {
        if (this.stopping)
        {
            logger.info(`[SPFN] ${name} not started: spfn dev is stopping`);

            return null;
        }

        const child = launch();

        if (child)
        {
            this.children.set(name, child);
        }

        return child;
    }

    /** Whether a stop has begun. */
    readonly isStopping = (): boolean => this.stopping;

    private async stop(signal: NodeJS.Signals): Promise<void>
    {
        const watcher = this.children.get('codegen watcher');

        watcher?.kill(signal, { forceKillAfterTimeout: false });

        if (this.stopping)
        {
            return;
        }

        this.stopping = true;
        this.children.forEach((child, name) => name !== 'codegen watcher' && child.kill('SIGTERM', { forceKillAfterTimeout: false }));
        await watcher;
        process.exit(0);
    }
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
            let isRestarting = false;
            const children = new DevChildren();
            const stopping = children.isStopping;

            // Start codegen watcher
            const startWatcher = () =>
            {
                children.start('codegen watcher', () => startCodegenWatcher(pm, cwd, watcherEntry, watcherEnv, stopping));
            };

            // Start server process
            const startServer = () =>
            {
                const server = tsxCommand(pm, cwd, serverEntry);

                serverProcess = children.start('server', () => execa(server.command, server.args, {
                    cwd,
                    stdio: 'inherit',
                    reject: false,
                    env: serverEnv,
                }));

                // Don't await or catch - let it run independently
            };

            // Restart server
            const restartServer = async () =>
            {
                if (isRestarting || stopping()) return;
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
        let isRestarting = false;
        const children = new DevChildren();
        const stopping = children.isStopping;

        // Start codegen watcher
        const startWatcher = () =>
        {
            children.start('codegen watcher', () => startCodegenWatcher(pm, cwd, watcherEntry, watcherEnv, stopping));
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

            children.start('Next.js', () => execa(nextCmd, nextArgs, {
                cwd,
                stdio: 'inherit',
                reject: false,
            }))?.then((result) =>
            {
                if (!stopping() && result.exitCode !== 0 && result.exitCode !== 130)
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

            serverProcess = children.start('server', () => execa(server.command, server.args, {
                cwd,
                stdio: 'inherit',
                reject: false,
                env: serverEnv,
            }));

            // Don't await or catch - let it run independently
        };

        // Restart server
        const restartServer = async () =>
        {
            if (isRestarting || stopping()) return;
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
