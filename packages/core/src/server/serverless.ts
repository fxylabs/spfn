/**
 * Serverless target for SPFN.
 *
 * Produces a listen-free, initialized Hono app for serverless platforms (Vercel,
 * AWS Lambda, Cloudflare) — wrap the result with a hono platform adapter, e.g.
 * `handle(app)` from `hono/vercel`.
 *
 * Unlike {@link startServer} (which serve()s a long-lived process and is the
 * always-on / container path), this:
 *   - initializes the database in-handler (startServer welds DB init to serve()),
 *   - runs at most once per warm container (memoized),
 *   - disables the periodic DB health-check (pointless — and a timer leak — on
 *     frozen invocations),
 *   - does NOT start the in-process pg-boss worker (it cannot run on a serverless
 *     platform); enqueue still works, but nothing drains the queue here,
 *   - does NOT run seed/RBAC provisioning per cold start — that moves to a
 *     deploy-time step, see {@link provisionInfrastructure}.
 *
 * Like {@link startServer}, it runs the environment boot check before building
 * the app; a failure rejects the returned promise instead of exiting.
 *
 * `startServer()` / `spfn start` (the always-on path) is unchanged by this module.
 */

import type { Hono } from 'hono';

import { initCache } from '@spfn/core/cache';
import { initDatabase } from '@spfn/core/db';

import { loadEnv } from '../env/loader';
import { createServer } from './create-server';
import { runEnvBootCheck } from './env-boot-check';
import { serverLogger } from './logger';
import type { ServerConfig } from './types';

function getInfrastructure(config?: ServerConfig): { database: boolean; redis: boolean }
{
    return {
        database: config?.infrastructure?.database !== false,
        redis: config?.infrastructure?.redis !== false,
    };
}

/**
 * Serverless has no long-lived process, so the periodic DB health-check only leaks
 * timers across frozen invocations. Default it off unless the app set it explicitly.
 */
function withServerlessDefaults(config?: ServerConfig): ServerConfig | undefined
{
    if (!config)
    {
        return config;
    }

    return {
        ...config,
        database: {
            ...config.database,
            healthCheck: { enabled: false, ...config.database?.healthCheck },
        },
    };
}

function warnIfJobsConfigured(config?: ServerConfig): void
{
    if (config?.jobs)
    {
        serverLogger.warn(
            'Jobs are configured but this is a serverless target: the in-process pg-boss '
            + 'worker is NOT started here, so enqueued jobs will not be processed on this '
            + 'deployment. Drain the queue from a scheduled endpoint (e.g. Vercel Cron → a '
            + 'route that processes a batch) or run jobs on an always-on target.',
        );
    }
}

async function initInfrastructure(config?: ServerConfig): Promise<void>
{
    const infra = getInfrastructure(config);

    if (infra.database)
    {
        await initDatabase(config?.database);
    }

    // initCache is a no-op (logs "cache disabled") when no cache is configured, so a
    // missing CACHE_URL on serverless is fine.
    if (infra.redis)
    {
        await initCache();
    }
}

let appPromise: Promise<Hono> | undefined;

/**
 * Build — once per warm container — the initialized, listen-free Hono app for a
 * serverless platform. Wrap the result with the platform adapter:
 *
 * ```ts
 * import { handle } from 'hono/vercel';
 * import { createServerlessApp } from '@spfn/core/server';
 * import serverConfig from '@/server/server.config';
 *
 * const handler = async (req: Request) => handle(await createServerlessApp(serverConfig))(req);
 * export const GET = handler;
 * export const POST = handler;
 * ```
 */
export function createServerlessApp(config?: ServerConfig): Promise<Hono>
{
    if (!appPromise)
    {
        appPromise = buildServerlessApp(config);
    }

    return appPromise;
}

async function buildServerlessApp(rawConfig?: ServerConfig): Promise<Hono>
{
    loadEnv();

    // The same gate as startServer, but thrown rather than exited: a serverless
    // runtime owns the process, so the failure belongs to the invocation.
    if (!runEnvBootCheck(rawConfig ?? {}).valid)
    {
        throw new Error('Environment validation failed — the missing or invalid keys are logged above.');
    }

    const config = withServerlessDefaults(rawConfig);

    warnIfJobsConfigured(config);
    await initInfrastructure(config);

    return createServer(config);
}

/**
 * Reset the memoized serverless app. Tests only.
 */
export function resetServerlessApp(): void
{
    appPromise = undefined;
}

/**
 * Deploy-time provisioning — run ONCE per deploy, not per request.
 *
 * Initializes the database and runs the config's provisioning lifecycle hooks
 * (`beforeInfrastructure` / `afterInfrastructure`, e.g. admin seeding + RBAC init).
 * Intended for a build/deploy step (`spfn provision`), keeping per-cold-start work
 * out of the serverless handler. On always-on targets this is equally useful: it
 * avoids re-seeding on every pod restart / replica.
 *
 * Does NOT start the HTTP server, jobs worker, or health-check.
 */
export async function provisionInfrastructure(config?: ServerConfig): Promise<void>
{
    loadEnv();

    if (config?.lifecycle?.beforeInfrastructure)
    {
        await config.lifecycle.beforeInfrastructure(config);
    }

    await initInfrastructure(config);

    if (config?.lifecycle?.afterInfrastructure)
    {
        await config.lifecycle.afterInfrastructure();
    }

    serverLogger.info('Provisioning complete');
}
