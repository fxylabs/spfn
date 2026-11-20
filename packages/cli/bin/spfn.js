#!/usr/bin/env node

/**
 * SPFN CLI Entry Point
 *
 * Every command runs in a process that has the CLI's module hook
 * (dist/dev-loader-import.js) registered for the app in the current directory,
 * on top of tsx, so every command that loads the app's source — db, provision,
 * env, codegen — runs its .ts as ESM, as `spfn dev` and `spfn build` do.
 *
 * The one question is whether this process already has that hook for this
 * root; the hook's register.js leaves the root it was registered for on
 * globalThis. When it has not, the bin re-spawns itself with tsx and the hook
 * — whatever put tsx there already (`node --import tsx`, `npx tsx`,
 * NODE_OPTIONS): the hook has to be in place before the first import of app
 * source, and a re-spawn gives every launcher the same process — the CLI's own
 * tsx, then the hook — instead of one built on whichever tsx entry (or none
 * for ESM) the launcher registered. Re-spawning (rather than tsx.register())
 * also avoids ERR_REQUIRE_CYCLE_MODULE on Node.js 22+.
 *
 * Without tsx (it is the app's dependency, not the CLI's) the command runs in
 * this process, without the hook, and nothing loads the app's source as
 * CommonJS behind its back: `spfn env`, `spfn db` and `spfn provision` stop
 * before their first TypeScript import with one message naming tsx and the
 * app's command to add it (src/utils/tsx-required.ts).
 */

const TSX_FLAG = '--import';
const TSX_MODULE = 'tsx';

// Set for the re-spawned process only, so a process whose hook did not
// register stops instead of re-spawning itself again; a spfn it starts in turn
// does not inherit it.
const RELAUNCHED = 'SPFN_CLI_RELAUNCHED_IN';
const relaunched = process.env[RELAUNCHED] === process.cwd();

delete process.env[RELAUNCHED];

import('../dist/dev-loader-import.js').then(({ hasDevLoader }) =>
{
    if (hasDevLoader(process.cwd()))
    {
        return runCli();
    }

    if (relaunched)
    {
        throw new Error('the CLI\'s module hook (dist/dev-loader/register.js) did not register in the process spfn re-spawned');
    }

    // Try to re-spawn with tsx and the hook; without tsx, run without them
    return tryRelaunchWithTsx().catch(runCli);
}).catch(abort);

function runCli()
{
    return import('../dist/index.js').then(({ run }) => run());
}

async function tryRelaunchWithTsx()
{
    // Resolve tsx to an absolute URL from THIS package's location. A bare
    // '--import tsx' is resolved by Node against the child's CWD, so running
    // outside a project (no node_modules/tsx up the tree) crashes the child
    // with ERR_MODULE_NOT_FOUND even though the guard import above succeeds
    // (it resolves package-relative). Resolving here also doubles as the
    // availability check — a throw falls back to running without tsx.
    const { createRequire } = await import('module');
    const { pathToFileURL } = await import('url');
    const tsxUrl = pathToFileURL(createRequire(import.meta.url).resolve(TSX_MODULE)).href;

    const { devLoaderImport } = await import('../dist/dev-loader-import.js');

    const args = [TSX_FLAG, tsxUrl, TSX_FLAG, devLoaderImport(process.cwd()), ...process.execArgv, process.argv[1], ...process.argv.slice(2)];
    const env = { ...process.env, [RELAUNCHED]: process.cwd() };

    if (process.platform !== 'win32' && typeof process.execve === 'function')
    {
        process.execve(process.execPath, [process.execPath, ...args], env);
    }

    const { spawn } = await import('child_process');
    const child = spawn(process.execPath, args, { stdio: 'inherit', env });

    child.on('close', (code) => process.exit(code ?? 0));
    child.on('error', () =>
    {
        runCli().catch(abort);
    });
}

function abort(error)
{
    console.error('Error:', error);
    process.exit(1);
}