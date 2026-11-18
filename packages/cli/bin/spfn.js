#!/usr/bin/env node

/**
 * SPFN CLI Entry Point
 *
 * Re-spawns with --import tsx when .ts schema loading is needed.
 * This avoids ERR_REQUIRE_CYCLE_MODULE on Node.js 22+ where
 * tsx.register() causes CJS/ESM interop cycles.
 */

const TSX_FLAG = '--import';
const TSX_MODULE = 'tsx';

// Marks every process this CLI runs, and what it spawns, as started by the spfn
// CLI: codegen (`loadCodegenConfig`) then refuses a second copy of @spfn/core
// instead of only warning about it, as it does for a programmatic caller.
process.env.SPFN_CODEGEN_PROCESS = '1';

// Already running with tsx loader — just run
if (process.execArgv.some(arg => arg.includes(TSX_MODULE)))
{
    import('../dist/index.js').then(({ run }) => run()).catch(abort);
}
else
{
    // Try to re-spawn with --import tsx for .ts schema support
    tryRelaunchWithTsx().catch(() =>
    {
        // tsx not available — run without it
        import('../dist/index.js').then(({ run }) => run()).catch(abort);
    });
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

    const { spawn } = await import('child_process');
    const child = spawn(
        process.execPath,
        [TSX_FLAG, tsxUrl, ...process.execArgv, process.argv[1], ...process.argv.slice(2)],
        { stdio: 'inherit' },
    );

    child.on('close', (code) => process.exit(code ?? 0));
    child.on('error', () =>
    {
        import('../dist/index.js').then(({ run }) => run()).catch(abort);
    });
}

function abort(error)
{
    console.error('Error:', error);
    process.exit(1);
}