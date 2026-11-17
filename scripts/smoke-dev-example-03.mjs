#!/usr/bin/env node
/**
 * Boot examples/03-auth under `spfn dev` and check it serves.
 *
 * Why this exists: issue #329. `spfn dev` ran an app without `"type": "module"`
 * as CommonJS beside a server running as ESM, so the process held two copies of
 * @spfn/core and hono — and an app's rate-limit policies, its trusted proxy
 * hops and the second-factor enrolment routes all stopped working, in dev only.
 * `spfn build` bundles the app as ESM, and CI only ever ran the build: the split
 * lived for thirteen months without a red pipeline.
 *
 * The server now refuses to boot with two copies of @spfn/core, and `spfn dev`
 * loads the app's source as ESM so that it has one. This script is the run that
 * notices when the second stops being true: 03-auth declares no `"type"`, so a
 * dev runner that splits the formats again makes its boot fail here, where
 * before only a developer's machine would have seen it.
 *
 * It asserts:
 *   1. `spfn dev --server-only` signals ready, and no boot refusal is printed
 *   2. GET /_core/health answers 200
 *   3. GET /_auth/session without credentials answers @spfn/auth's 401 — a
 *      route of the package, behind its middleware, served by core's router
 *   4. the codegen watcher generated the route map, and left it byte-identical
 *      to the committed one (`git show HEAD:…`, not the working tree)
 *
 * The fourth is issue #334. `--server-only` still starts the codegen watcher,
 * which writes the example's route map on its first run, and `spfn dev` sets
 * `development` where `pnpm codegen` runs under `production`. The watcher now
 * runs under `production` from its first line, so it writes the bytes
 * `pnpm codegen` committed; a watcher that writes anything else is two
 * generators drifting apart again, and the changed file is left in place for
 * the diff to show. The script waits for that write to finish before it stops
 * `spfn dev`, so a stop in the middle of it cannot pass for a change, and a
 * watcher that exits without writing fails rather than leaving the file
 * untouched for the comparison to pass on.
 *
 * It needs PostgreSQL: SMOKE_DATABASE_URL names an empty database the script
 * may migrate. The secrets it sets are generated per run.
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const EXAMPLE_DIR = join(process.cwd(), 'examples', '03-auth');
const READY_FILE = join(EXAMPLE_DIR, '.spfn', 'server-ready');
const ROUTE_MAP_PATH = 'examples/03-auth/src/generated/route-map.ts';
const ROUTE_MAP = join(process.cwd(), ROUTE_MAP_PATH);
const PORT = process.env.SMOKE_PORT ?? '8896';
const BASE = `http://127.0.0.1:${PORT}`;
const BOOT_TIMEOUT_MS = 90_000;
const CODEGEN_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 500;
const OUTPUT_TAIL_LINES = 40;

const failures = [];
let serverOutput = '';
let server = null;

function log(message)
{
    console.log(`[smoke-dev] ${message}`);
}

function check(name, ok, detail)
{
    if (ok)
    {
        log(`ok   — ${name}`);

        return;
    }

    log(`FAIL — ${name}${detail ? `: ${detail}` : ''}`);
    failures.push(name);
}

/**
 * The example's environment. Every secret is generated here: the committed
 * templates carry placeholders, and a value set in the process wins over the
 * env files.
 */
function exampleEnv()
{
    const databaseUrl = process.env.SMOKE_DATABASE_URL;

    if (!databaseUrl)
    {
        throw new Error('SMOKE_DATABASE_URL is not set — it names an empty PostgreSQL database for the example');
    }

    return {
        ...process.env,
        NODE_ENV: 'development',
        DATABASE_URL: databaseUrl,
        CACHE_URL: '',
        SPFN_PORT: PORT,
        SPFN_HOST: '127.0.0.1',
        SPFN_API_URL: BASE,
        SPFN_AUTH_SESSION_SECRET: randomBytes(48).toString('base64'),
        SPFN_AUTH_VERIFICATION_TOKEN_SECRET: randomBytes(48).toString('base64'),
        SPFN_AUTH_TOKEN_ENCRYPTION_KEYS: `smoke:${randomBytes(32).toString('base64')}`,
        SPFN_AUTH_ADMIN_EMAIL: '',
        SPFN_AUTH_ADMIN_PASSWORD: '',
    };
}

function run(command, args, env)
{
    return new Promise((resolve, reject) =>
    {
        const child = spawn(command, args, { cwd: EXAMPLE_DIR, env, stdio: 'inherit' });

        child.on('error', reject);
        child.on('exit', code => code === 0
            ? resolve()
            : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)));
    });
}

/** See scripts/smoke-example-01.mjs: a stale listener would answer for the example. */
function assertPortIsFree()
{
    return new Promise((resolve, reject) =>
    {
        const probe = createServer();

        probe.once('error', error => error.code === 'EADDRINUSE'
            ? reject(new Error(`port ${PORT} is already in use — stop that process or set SMOKE_PORT`))
            : reject(error));

        probe.once('listening', () => probe.close(resolve));
        probe.listen(Number(PORT), '127.0.0.1');
    });
}

/**
 * `spfn dev` is the thing under test, so it is started as a user starts it.
 * It spawns the server and the codegen watcher as children of its own; in a
 * process group of its own, all of them stop together.
 */
function startDev(env)
{
    const child = spawn('pnpm', ['exec', 'spfn', 'dev', '--server-only', '--no-agent-files'], {
        cwd: EXAMPLE_DIR,
        env,
        detached: true,
    });

    const capture = (chunk) =>
    {
        const text = chunk.toString();

        serverOutput += text;
        process.stdout.write(text);
    };

    child.stdout.on('data', capture);
    child.stderr.on('data', capture);

    return child;
}

async function waitForReady()
{
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let exitCode = null;

    server.once('exit', (code) =>
    {
        exitCode = code ?? -1;
    });

    while (Date.now() < deadline)
    {
        if (existsSync(READY_FILE))
        {
            return readFileSync(READY_FILE, 'utf-8').trim();
        }

        if (exitCode !== null)
        {
            throw new Error(`spfn dev exited with code ${exitCode} before the server was ready — see its output above`);
        }

        // The server process ends on a refused boot; `spfn dev` around it does not.
        if (/Refusing to start|Refusing a second copy/.test(serverOutput))
        {
            throw new Error('the server refused to boot — see its output above');
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`the server did not signal ready within ${BOOT_TIMEOUT_MS / 1000}s — see its output above`);
}

async function assertServes()
{
    const health = await fetch(`${BASE}/_core/health`);

    check('GET /_core/health answers 200', health.ok, `got ${health.status}`);

    const session = await fetch(`${BASE}/_auth/session`);
    const body = await session.json().catch(() => null);

    check('GET /_auth/session without credentials answers 401', session.status === 401, `got ${session.status}`);
    check(
        'the 401 is @spfn/auth\'s',
        typeof body?.error?.code === 'string' && body.error.code !== '',
        `body was ${JSON.stringify(body)}`,
    );
}

/** The last lines `spfn dev` and its children printed, for a failure that has to show them. */
function outputTail()
{
    return serverOutput.trimEnd().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');
}

/**
 * Whether the codegen watcher's first run wrote the route map: the generator
 * logs the line below after its write returns. A watcher that exits first is
 * reported by `spfn dev`, and is a failure here — it wrote nothing, so the
 * file being unchanged afterwards would prove nothing.
 */
async function waitForCodegen()
{
    const deadline = Date.now() + CODEGEN_TIMEOUT_MS;

    while (Date.now() < deadline)
    {
        if (serverOutput.includes('Generated route map:'))
        {
            return true;
        }

        if (serverOutput.includes('Codegen watcher exited'))
        {
            check('the codegen watcher generated the route map', false, `it exited first:\n${outputTail()}`);

            return false;
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`the codegen watcher did not finish its first run within ${CODEGEN_TIMEOUT_MS / 1000}s`);
}

/**
 * The route map as committed. Read from git rather than the working tree, so
 * a local re-run over a file an earlier run (or an edit) already changed
 * compares against what `pnpm codegen` committed, not against the drift.
 */
function committedRouteMap()
{
    return execFileSync('git', ['show', `HEAD:${ROUTE_MAP_PATH}`], { encoding: 'utf-8' });
}

/** The watcher wrote exactly the route map `pnpm codegen` committed. */
function assertRouteMapUnchanged(committed)
{
    check(
        'the codegen watcher left the committed route map byte-identical',
        readFileSync(ROUTE_MAP, 'utf-8') === committed,
        `${ROUTE_MAP_PATH} differs from HEAD — see git diff`,
    );
}

/**
 * SIGTERM to the whole group, SIGKILL to what is left after the budget. Once
 * stopped it returns at once: a child killed by a signal keeps `exitCode` null,
 * and waiting again for an `exit` that has already happened is what ran the
 * SIGKILL fallback after a refused boot.
 */
async function stopDev()
{
    if (server === null || server.exitCode !== null || server.signalCode !== null)
    {
        return;
    }

    const exited = new Promise(resolve => server.once('exit', resolve));

    process.kill(-server.pid, 'SIGTERM');

    const stopped = await Promise.race([
        exited.then(() => true),
        new Promise(resolve => setTimeout(() => resolve(false), STOP_TIMEOUT_MS)),
    ]);

    if (!stopped)
    {
        log('spfn dev did not stop on SIGTERM — killing its process group');
        process.kill(-server.pid, 'SIGKILL');
    }
}

async function main()
{
    const startedAt = Date.now();
    const env = exampleEnv();

    await assertPortIsFree();

    log('migrating the example database');
    await run('pnpm', ['exec', 'spfn', 'db', 'migrate'], env);

    // A signal left by an earlier run would read as this one's.
    rmSync(READY_FILE, { force: true });

    const routeMap = committedRouteMap();

    log(`starting spfn dev on ${BASE}`);
    server = startDev(env);

    let generated = false;

    try
    {
        const port = await waitForReady();
        log(`server ready on port ${port} — checking it serves`);
        await assertServes();
        generated = await waitForCodegen();
    }
    finally
    {
        await stopDev();
    }

    if (generated)
    {
        assertRouteMapUnchanged(routeMap);
    }

    if (failures.length > 0)
    {
        log(`${failures.length} check(s) failed`);
        process.exit(1);
    }

    log(`all checks passed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch(async (error) =>
{
    log(`error: ${error.message}`);
    await stopDev().catch(() => undefined);
    process.exit(1);
});
