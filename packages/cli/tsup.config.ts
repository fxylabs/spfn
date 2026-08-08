import { defineConfig } from 'tsup';
import { readFileSync } from 'fs';

const packageJson = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
    entry: {
        index: 'src/index.ts',
    },
    format: ['esm'],
    dts: true,
    clean: true,
    sourcemap: false,
    splitting: false,
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
    },
});
