import { defineConfig } from 'tsup';

export default defineConfig({
    entry: {
        'shared/index': 'src/shared/index.ts',
        'server/index': 'src/server/index.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    // Entries share chunks, so each module is emitted once (scripts/check-bundle-identity.mjs, #398)
    splitting: true,
});
