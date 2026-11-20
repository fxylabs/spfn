import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'index': 'src/index.ts',
        'server': 'src/server.ts',
        'routing': 'src/routing.ts',
        'next': 'src/next.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    // Entries share chunks, so each module is emitted once (scripts/check-bundle-identity.mjs, #398)
    splitting: true,
    external: [
        'next',
        /^next\//,
    ],
});
