import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';

const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        surface: 'src/surface/index.ts',
        'dev-loader/register': 'src/dev-loader/register.ts',
        // bin/spfn.js builds the hook's --import with it; the helper is one chunk
        // at the root of dist/, shared with index.js and dev-loader/register.js
        'dev-loader-import': 'src/utils/dev-loader.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: false,
    // Entries share chunks, so each module is emitted once (scripts/check-bundle-identity.mjs, #398)
    splitting: true,
    target: 'es2022',
    outDir: 'dist',
    // `@spfn/auth` is an optional peer, loaded at run time by `spfn ops token`.
    // Bundling it would defeat that — the CLI must resolve whatever the app has,
    // or fail with the message the loader raises when the app has none.
    external: [
        'tsup', 'tsx', 'drizzle-kit', 'drizzle-orm', 'postgres', 'dotenv',
        '@spfn/core', '@spfn/auth', '@napi-rs/keyring',
    ],
    noExternal: [],
    define: {
        '__CLI_VERSION__': JSON.stringify(packageJson.version),
        '__CLI_CORE_PEER_RANGE__': JSON.stringify(packageJson.peerDependencies['@spfn/core']),
    },
});
