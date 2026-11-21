import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, rmSync, watch } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import chokidar from 'chokidar';
import { logger } from '../utils/logger.js';
import { getCliVersion, getCorePeerRange } from '../utils/version.js';
import { devLoaderImport } from '../utils/dev-loader.js';
import { DevSupervisor, outliveOutputReader, type DevChild } from '../utils/dev-supervisor.js';
import { syncAgentInstructions } from '../lib/agent-instructions.js';
import { detectPackageManager, getRunScriptArgs, type PackageManager } from '../utils/package-manager.js';
import { missingTsxMessage } from '../utils/tsx-required.js';
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
 * tsx with the `spfn dev` hook (`devLoaderImport`), as the server is.
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

// The watcher's stop outlives what reads its output, as spfn dev's does
// (outliveOutputReader): the Ctrl-C that kills \`tee\` in \`spfn dev | tee log\`
// fails the stopping line (EPIPE), and that ends nothing. Any other error on
// stdout or stderr is thrown, as unhandled.
for (const stream of [process.stdout, process.stderr])
{
    stream.on('error', (error) =>
    {
        if (error.code !== 'EPIPE')
        {
            throw error;
        }
    });
}

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

const { CodegenOrchestrator, loadCodegenConfig, createGeneratorsFromConfig, markAppSourceProcess } = codegen;

// Started by the spfn CLI to load the app's source: a second copy of @spfn/core
// is refused, where it is recorded and after each router load, not only warned
// about. In-process, so nothing inherits it.
markAppSourceProcess();

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
// is the only way to stop one that never settles. Under spfn dev the watcher
// gets one SIGTERM whatever stopped spfn dev, and a second Ctrl-C makes spfn
// dev SIGKILL it; spfn dev says whether one can still reach it.
let stopping = false;

const stop = async (signal) =>
{
    if (stopping)
    {
        process.exit(128 + constants.signals[signal]);
    }

    stopping = true;
    console.log('[SPFN] Codegen watcher stopping once the running generation or codegen config load finishes');
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
 * The arguments that run `entry` in a Node process of its own under the app's
 * tsx (`--import`, as `bin/spfn.js` runs the CLI) and the `spfn dev` hook — the
 * server and the codegen watcher. Never through a wrapper: `pnpm exec` and `npx`
 * exit before what they run, and the tsx CLI relays a signal its child already
 * got unless the child reports it within 30 ms, so a child busy when it arrives
 * gets it twice. The process `spfn dev` starts is the one that runs `entry`.
 */
function tsxNodeArgs(tsxLoader: string, cwd: string, entry: string): string[]
{
    return ['--import', tsxLoader, '--import', devLoaderImport(cwd), entry];
}

function warnCodegenWatchDisabled(): void
{
    logger.warn('[SPFN] Codegen watch is disabled for this session — the server keeps running. Run codegen manually after route changes.');
}

/**
 * The `--import` URL of the tsx the server and the watcher run under: the
 * app's, else the one installed for the spfn CLI itself (the tsx `bin/spfn.js`
 * re-spawns under), else undefined.
 */
function resolveTsxLoader(cwd: string): string | undefined
{
    const tsxDir = tsxPackageFrom(cwd) ?? tsxPackageFrom(dirname(fileURLToPath(import.meta.url)));

    return tsxDir && pathToFileURL(createRequire(join(tsxDir, 'package.json')).resolve('tsx')).href;
}

/**
 * The tsx package in the nearest `node_modules` on the way up from `from`:
 * Node's lookup of a package without `NODE_PATH`. Package-manager shims (a
 * pnpm bin script, npx) point `NODE_PATH` at their store, which would hand the
 * children a tsx nothing on that path declares.
 */
function tsxPackageFrom(from: string): string | undefined
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

    return join(directory, 'node_modules/tsx');
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
        outliveOutputReader();

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
        const tsxLoader = resolveTsxLoader(cwd);

        if (tsxLoader === undefined)
        {
            logger.error(`[SPFN] ${missingTsxMessage(cwd)}`);
            process.exit(1);
        }

        const withNext = hasNext && !options.serverOnly;
        const watchMode = options.watch === true;

        logger.info(withNext
            ? `Starting SPFN server + Next.js (Turbopack)${watchMode ? ' (watch mode)' : ''}...\n`
            : `Starting SPFN Server on http://${serverHost}:${serverPort}${watchMode ? ' (watch mode)' : ''}\n`);

        const children = new DevSupervisor();

        startCodegenWatcher(children, tsxLoader, cwd, watcherEntry, watcherEnv);

        const server = serverRunner(children, tsxLoader, cwd, serverEntry, serverEnv);

        server.start();

        if (watchMode)
        {
            restartOnServerChanges(serverDir, cwd, server.restart);
        }

        if (withNext)
        {
            // The server must be ready before Next.js starts
            await waitForServer(readyFile);
            startNext(children, pm, cwd, nextPort);
        }

        // The supervisor exits once the children have; until then, keep the event loop alive
        setInterval(() => undefined, 1_000_000);
    });

/**
 * Start the codegen watcher entry (`watcherEntrySource`). An exit with an error
 * outside a stop leaves the session running without it, and says so.
 */
function startCodegenWatcher(children: DevSupervisor, tsxLoader: string, cwd: string, entry: string, env: NodeJS.ProcessEnv): void
{
    children.start('codegen watcher', process.execPath, tsxNodeArgs(tsxLoader, cwd, entry), { cwd, env })?.process.then((result) =>
    {
        if (!children.isStopping() && result.exitCode !== 0 && result.exitCode !== 130)
        {
            logger.error(`Codegen watcher exited with code ${result.exitCode}`);
            warnCodegenWatchDisabled();
        }
    });
}

/**
 * The server, started and restarted (`--watch`). A restart stops the running
 * server and waits until nothing is left in its process group — the port is
 * free then — before starting the next one; changes during a restart are
 * covered by it.
 */
function serverRunner(children: DevSupervisor, tsxLoader: string, cwd: string, entry: string, env: NodeJS.ProcessEnv)
{
    let current: DevChild | null = null;
    let restarting = false;

    const start = (): void =>
    {
        current = children.start('server', process.execPath, tsxNodeArgs(tsxLoader, cwd, entry), { cwd, env });
    };

    const restart = async (): Promise<void> =>
    {
        if (restarting || children.isStopping())
        {
            return;
        }

        restarting = true;
        logger.info('[SPFN] File changed, restarting server...');

        if (current)
        {
            await children.stopChild(current);
        }

        start();
        restarting = false;
    };

    return { start, restart };
}

/** Restart the server on every change under `src/server` (`--watch`). */
function restartOnServerChanges(serverDir: string, cwd: string, restart: () => Promise<void>): void
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
    const onChange = (label: string) => (path: string) =>
    {
        logger.info(`[SPFN] ${label}: ${path.replace(cwd + '/', '')}`);
        void restart();
    };

    watcher.on('change', onChange('Changed'));
    watcher.on('add', onChange('Added'));
    watcher.on('unlink', onChange('Removed'));
}

/** Wait for the server's ready file; past the timeout, go on anyway. */
async function waitForServer(readyFile: string): Promise<void>
{
    try
    {
        const port = await waitForReadyFile(readyFile);
        logger.info(`[SPFN] Server ready on port ${port}, starting Next.js...\n`);
    }
    catch
    {
        logger.warn(`[SPFN] Server readiness check timed out, starting Next.js anyway...`);
    }
}

/**
 * Start Next.js through the app's `spfn:next` script. An exit with an error
 * outside a stop stops the session: the server and the watcher, then
 * `spfn dev` with exit code 1.
 */
function startNext(children: DevSupervisor, pm: PackageManager, cwd: string, nextPort: number): void
{
    // The port is passed through rather than baked into the script, so
    // spfn.config.js is the only place the number appears. Only npm needs a
    // `--` to stop reading the flag as its own config; pnpm, yarn and bun
    // forward the separator to next, which then reads `--port` as a directory.
    const nextArgs = getRunScriptArgs(pm, 'spfn:next', ['--port', String(nextPort)]);

    children.start('Next.js', pm, nextArgs, { cwd })?.process.then((result) =>
    {
        if (!children.isStopping() && result.exitCode !== 0 && result.exitCode !== 130)
        {
            logger.error(`Next.js exited with code ${result.exitCode}`);
            void children.stop(1);
        }
    });
}
