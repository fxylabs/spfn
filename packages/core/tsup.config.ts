import { readFileSync } from 'fs';
import { basename, dirname, relative, resolve } from 'path';
import { defineConfig, type Options } from 'tsup';
import { recordMetafile } from '../../scripts/lib/bundle-identity.mjs';

type Plugin = NonNullable<Options['esbuildPlugins']>[number];

// Declarations build as one TypeScript program for all entries, wherever their sources
// sit, because of the tsup patch in /patches (#352).
const entry = {
    'nextjs/index': 'src/nextjs/index.ts',
    'nextjs/server': 'src/nextjs/server.ts',
    'nextjs/server-call': 'src/nextjs/server-call.ts',
    'nextjs/server-call.browser': 'src/nextjs/server-call.browser.ts',
    'route/index': 'src/route/index.ts',
    'route/types': 'src/route/types.ts',
    'db/index': 'src/db/index.ts',
    'server/index': 'src/server/index.ts',
    'errors/index': 'src/errors/index.ts',
    'middleware/index': 'src/middleware/index.ts',
    'security/index': 'src/security/index.ts',
    'authz/index': 'src/authz/index.ts',
    'cache/index': 'src/cache/index.ts',
    'codegen/index': 'src/codegen/index.ts',
    'codegen/loader/index': 'src/codegen/loader/index.ts',
    'contract/index': 'src/contract/index.ts',
    'ops/index': 'src/ops/index.ts',
    'surface/index': 'src/surface/index.ts',
    'env/index': 'src/env/index.ts',
    'env/loader': 'src/env/loader.ts',
    'logger/index': 'src/logger/index.ts',
    'config/index': 'src/config/index.ts',
    'app-config/index': 'src/app-config/index.ts',
    'options/index': 'src/options/index.ts',
    'job/index': 'src/job/index.ts',
    'event/index': 'src/event/index.ts',
    'event/sse/index': 'src/event/sse/index.ts',
    'event/sse/client': 'src/event/sse/client.ts',
    'event/ws/index': 'src/event/ws/index.ts',
    'event/ws/client': 'src/event/ws/client.ts',
    'state/index': 'src/state/index.ts',
    'state/client': 'src/state/client.ts',
    'state/react': 'src/state/react.tsx',
};

const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8'));

/** `@spfn/core/server` for `server/index`: the subpath whose import target is this entry's output. */
function subpathName(entryKey: string): string
{
    const subpath = Object.entries<{ import?: string }>(packageJson.exports)
        .find(([, conditions]) => conditions.import === `./dist/${entryKey}.js`)?.[0];

    return subpath === undefined ? `@spfn/core (dist/${entryKey}.js)` : `@spfn/core${subpath.slice(1)}`;
}

/**
 * Every entry records where it was loaded from — its own `import.meta.url` —
 * what evaluated it, and the version it was built as, inlined from
 * `package.json` (see `src/module-evaluation.ts`). Each entry point is built
 * from a module this plugin writes from the entry map itself — the entry's
 * source re-exported, then the call — so no entry can be built without it.
 *
 * Only the entry point of each output records: an entry whose source another
 * entry imports (`server` imports `route`) does not record from inside that
 * other file. The source stays one module, which the code splitting puts in a
 * shared chunk when two entries reach it; only the module written here is the
 * entry's own. It lives in a namespace of its own, so the build's record names
 * it apart from the source (`scripts/lib/bundle-identity.mjs`).
 */
function recordEvaluationPlugin(): Plugin
{
    const names = new Map(Object.entries(entry).map(([key, file]) => [resolve(file), subpathName(key)]));
    const recorder = resolve('src/module-evaluation.ts');

    return {
        name: 'spfn-record-evaluation',
        setup(build)
        {
            build.onResolve({ filter: /.*/ }, (args) =>
            {
                const path = resolve(args.resolveDir, args.path);

                return args.kind === 'entry-point' && names.has(path)
                    ? { path: relative(process.cwd(), path), namespace: 'spfn-entry-point' }
                    : undefined;
            });

            build.onLoad({ filter: /.*/, namespace: 'spfn-entry-point' }, (args) =>
            {
                const source = resolve(args.path);

                return {
                    contents: `export * from './${basename(source)}';\n`
                        + `import { recordEvaluation as __recordEvaluation } from './${relative(dirname(source), recorder)}';\n`
                        + `__recordEvaluation(${JSON.stringify(names.get(source))}, import.meta.url, `
                        + `${JSON.stringify(packageJson.version)});\n`,
                    loader: 'ts',
                    resolveDir: dirname(source),
                };
            });
        },
    };
}

export default defineConfig({
    entry,
    esbuildPlugins: [recordEvaluationPlugin(), recordMetafile('main')],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    // Entries share chunks, so each module is emitted once (scripts/check-bundle-identity.mjs, #398)
    splitting: true,
    external: [
        // Internal entrypoints (prevent bundling into each other)
        /^@spfn\//,
        // '@spfn/core/client',
        // '@spfn/core/nextjs',
        // '@spfn/core/nextjs/server',
        // '@spfn/core/route',
        // '@spfn/core/route/types',
        // '@spfn/core/db',
        // '@spfn/core/server',
        // '@spfn/core/errors',
        // '@spfn/core/middleware',
        // '@spfn/core/cache',
        // '@spfn/core/codegen',
        // '@spfn/core/env',
        // '@spfn/core/logger',
        // '@spfn/core/events',
        // '@spfn/core/config',
        // External dependencies
        'drizzle-orm',
        'hono',
        '@hono/node-server',
        'postgres',
        'ioredis',
        'ws',
        'pg-boss',
        'pino',
        'chalk',
        'chokidar',
        'dotenv',
        '@sinclair/typebox',
        'next',
        /^next\//,
        'react',
        'react-dom',
    ],
});
