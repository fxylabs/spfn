/**
 * The environment code generation runs under
 *
 * A generated file is committed once and shipped: the route map the RPC proxy
 * resolves names in, the contract, the state manifest. So it describes what
 * ships, and what ships runs under `production`. A route module that reads the
 * environment at import — a schema built from a flag, a config module with a
 * `development` branch, a package that registers a debug route outside
 * production — would otherwise make the file depend on which command wrote it:
 * `spfn dev`'s watcher started under `development`, `spfn codegen run` and
 * `spfn build` under whatever the shell left.
 *
 * The fact is about the generating process, not about any one generator, so it
 * is set where a generation begins and before any project code is evaluated:
 * `.spfnrc.ts` and what it imports, a custom generator's module, the router.
 * A module evaluated earlier is cached under whatever it saw, and a generator
 * that pinned for itself took effect at whatever moment it happened to run — a
 * custom generator listed before the route map saw `development` on the first
 * watcher run and `production` on every later one.
 *
 * Where it is called:
 * - `spfn dev` starts its watcher process with `NODE_ENV=production` in its
 *   environment, so even the watcher entry's own imports load under it;
 * - `loadCodegenConfig`, the first step of `spfn codegen run`, `spfn contract`
 *   and `spfn build`'s codegen step, pins before it reads `.spfnrc.ts`;
 * - `createGeneratorsFromConfig` and `CodegenOrchestrator`'s constructor pin,
 *   for a programmatic caller that builds its config or its generators by hand.
 *
 * For a programmatic caller this means the process's `NODE_ENV` is
 * `production` from its first codegen call on. Modules it loaded before that
 * call are its own, and keep whatever they read.
 */

import { logger } from '@spfn/core/logger';

const envLogger = logger.child('@spfn/core:codegen');

/**
 * Pin NODE_ENV to `production` for code generation, whatever it was.
 *
 * Process-wide and idempotent: the first call replaces the value and says so,
 * the rest find `production` already there. The route map's environment probe
 * still varies NODE_ENV — it sets each varied value itself around a load of its
 * own — so a router whose content depends on it is still refused.
 */
export function pinNodeEnv(): void
{
    const shellValue = process.env.NODE_ENV;

    if (shellValue === 'production')
    {
        return;
    }

    process.env.NODE_ENV = 'production';
    envLogger.info(
        `NODE_ENV was ${shellValue === undefined ? 'unset' : `"${shellValue}"`}; pinned to "production" for code `
        + 'generation, so the generated files describe what ships whichever command wrote them',
    );
}
